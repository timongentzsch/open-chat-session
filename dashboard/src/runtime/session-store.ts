// Folds gateway events into assistant-ui messages plus UI side channels.

import type {
  ApprovalDecision,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AttachmentRef,
  ClarifyId,
  ClarifyRequestPayload,
  ClarifyResolvedPayload,
  EventEnvelope,
  GatewayEvent,
  MessageEditPayload,
  MessageCancelPayload,
  MessageInPayload,
  MessageOutPayload,
  ResyncPayload,
  StreamId,
  TypingPayload,
  ToolCallId,
} from "../types";

export interface OurMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  finalized: boolean;
  replyTo?: string;
}

export interface ApprovalView {
  tool_call_id: ToolCallId;
  tool_name: string;
  prompt: string;
  command?: string;
  args?: Record<string, unknown>;
  choices: ApprovalDecision[];
  expires_at: number;
  stream_id?: StreamId;
  requested_at: number;
  status: "pending" | "resolved";
  resolution?: { decision: ApprovalDecision; resolved_by: string; resolved_at: number };
}

export interface ClarifyView {
  clarify_id: ClarifyId;
  question: string;
  choices: string[];
  requested_at: number;
  stream_id?: StreamId;
}

export interface SessionState {
  messages: OurMessage[];
  attachments: Record<string, AttachmentRef[]>;
  approvals: Record<ToolCallId, ApprovalView>;
  clarifies: Record<ClarifyId, ClarifyView>;
  currentStreamId: StreamId | null;
  typingTs: number;
  archived: boolean;
  errorBanner: string | null;
  lastSeq: number;
  lastHash: string | null;
  // Lowest loaded event seq/hash — the cursor for backward (scroll-up) paging.
  firstSeq: number;
  firstHash: string | null;
  resyncing: boolean;
}

function initialSessionState(): SessionState {
  return {
    messages: [],
    attachments: {},
    approvals: {},
    clarifies: {},
    currentStreamId: null,
    typingTs: 0,
    archived: false,
    errorBanner: null,
    lastSeq: 0,
    lastHash: null,
    firstSeq: 0,
    firstHash: null,
    resyncing: false,
  };
}

const STREAM_CURSOR_CHAR = "▉";
const STALE_MS = 30_000;
const APPROVAL_DEFAULT_TTL_MS = 5 * 60_000;
const APPROVAL_DEFAULT_CHOICES: ApprovalDecision[] = ["once", "session", "always", "deny"];
const OBJECT_PAYLOAD_EVENTS = new Set<string>([
  "gateway.message.in",
  "gateway.message.out",
  "gateway.message.edit",
  "gateway.message.cancel.requested",
  "gateway.typing",
  "gateway.image",
  "gateway.video",
  "gateway.animation",
  "gateway.document",
  "gateway.voice",
  "gateway.clarify.request",
  "gateway.clarify.resolved",
  "gateway.error",
]);

function isMidStream(content: string | undefined, ts: number): boolean {
  if (!content || !content.endsWith(STREAM_CURSOR_CHAR)) return false;
  return Date.now() - ts < STALE_MS;
}

export class SessionStore {
  private state: SessionState = initialSessionState();
  private listeners = new Set<() => void>();
  private blockedStreams = new Set<StreamId>();
  private closedStreams = new Set<StreamId>();
  private approvalStreams = new Map<ToolCallId, StreamId>();
  private clarifyStreams = new Map<ClarifyId, StreamId>();
  getSnapshot = (): SessionState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private resetState(initialArchived = false): void {
    this.state = { ...initialSessionState(), archived: initialArchived };
    this.blockedStreams.clear();
    this.closedStreams.clear();
    this.approvalStreams.clear();
    this.clarifyStreams.clear();
  }

  reset(initialArchived = false): void {
    this.resetState(initialArchived);
    this.emit();
  }

  setArchived(archived: boolean): void {
    if (this.state.archived === archived) return;
    this.set({ archived });
    this.emit();
  }

  setError(message: string | null): void {
    if (this.state.errorBanner === message) return;
    this.set({ errorBanner: message });
    this.emit();
  }

  applyEvent(env: EventEnvelope): void {
    if (this.applyInternal(env)) this.emit();
  }

  /** Prepend an older page (events with seq < firstSeq, ascending). Folds only
   *  message/media events into the transcript — past live side-channels
   *  (typing, approvals, clarifies) are not revived. */
  prependHistory(events: EventEnvelope[]): void {
    if (events.length === 0) return;
    const older: OurMessage[] = [];
    const byId = new Map<string, number>();
    const attach: Record<string, AttachmentRef[]> = {};
    const push = (m: OurMessage) => {
      const i = byId.get(m.id);
      if (i === undefined) { byId.set(m.id, older.length); older.push(m); }
      else { older[i] = { ...older[i], content: m.content }; }
    };
    for (const env of events) {
      const p = (env.payload ?? {}) as Record<string, unknown>;
      if (env.kind === "gateway.message.in") {
        const id = (p.message_id as string) ?? `synthetic:${env.hash}`;
        push({ id, role: "user", content: (p.text as string) ?? "", ts: env.ts, finalized: true, replyTo: p.reply_to as string | undefined });
        const refs = normalizeAttachmentRefs(p.attachments);
        if (refs.length) attach[id] = refs;
      } else if (env.kind === "gateway.message.out" || env.kind === "gateway.message.edit") {
        const id = p.message_id as string;
        if (id) push({ id, role: "assistant", content: stripStreamCursor((p.content as string) ?? ""), ts: env.ts, finalized: true });
      } else if (
        env.kind === "gateway.image" || env.kind === "gateway.video" ||
        env.kind === "gateway.animation" || env.kind === "gateway.document" || env.kind === "gateway.voice"
      ) {
        const id = (p.message_id as string) ?? `synthetic:${env.hash}`;
        if (!byId.has(id)) push({ id, role: "assistant", content: (p.caption as string) ?? "", ts: env.ts, finalized: true });
        const refs = normalizeAttachmentRefs(p.attachments);
        if (refs.length) attach[id] = [...(attach[id] ?? []), ...refs];
      }
    }
    const existingIds = new Set(this.state.messages.map((m) => m.id));
    const toPrepend = older.filter((m) => !existingIds.has(m.id));
    // Merge older attachments even for an already-loaded message id (e.g. a
    // message whose out/edit straddles a page boundary) rather than dropping them.
    const attachments = { ...this.state.attachments };
    for (const [id, refs] of Object.entries(attach)) {
      const cur = attachments[id] ?? [];
      const seen = new Set(cur.map((r) => r.attachment_id || r.url));
      attachments[id] = [...cur, ...refs.filter((r) => !seen.has(r.attachment_id || r.url))];
    }
    this.set({
      messages: [...toPrepend, ...this.state.messages],
      attachments,
      firstSeq: events[0].seq,
      firstHash: events[0].hash,
    });
    this.emit();
  }

  cancelActive(streamId = ""): void {
    this.applyCancel(streamId);
    this.emit();
  }

  private applyInternal(env: EventEnvelope): boolean {
    if (env.seq <= this.state.lastSeq && this.state.lastSeq !== 0) return false;
    this.set({ lastSeq: env.seq, lastHash: env.hash });
    if (this.state.firstSeq === 0) this.set({ firstSeq: env.seq, firstHash: env.hash });

    if (
      (!env.payload || typeof env.payload !== "object" || Array.isArray(env.payload)) &&
      OBJECT_PAYLOAD_EVENTS.has(env.kind)
    ) {
      return false;
    }

    // EventEnvelope uses a generic payload (unknown by default), so TypeScript cannot narrow
    // payload type through the switch without explicit casts.
    switch (env.kind) {
      case "gateway.message.in": {
        const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.message.in" };
        const p: MessageInPayload = ge.payload;
        const id = p.message_id ?? `synthetic:${env.hash}`;
        this.upsertMessage({
          id, role: "user", content: p.text ?? "", ts: env.ts, finalized: true,
          replyTo: p.reply_to,
        });
        this.mergeAttachments(id, normalizeAttachmentRefs(p.attachments));
        this.set({ currentStreamId: env.stream_id ?? this.state.currentStreamId });
        return true;
      }
      case "gateway.message.out": {
        const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.message.out" };
        const p: MessageOutPayload = ge.payload;
        const id = p.message_id;
        const content = p.content ?? "";
        const finalized = !isMidStream(content, env.ts);
        if (env.stream_id) this.closedStreams.delete(env.stream_id);
        this.upsertMessage({
          id, role: "assistant", content,
          ts: env.ts, finalized,
          replyTo: p.reply_to,
        });
        this.set({
          currentStreamId: finalized ? null : (env.stream_id ?? this.state.currentStreamId),
          typingTs: finalized ? 0 : env.ts,
        });
        return true;
      }
      case "gateway.message.edit": {
        const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.message.edit" };
        const p: MessageEditPayload = ge.payload;
        const id = p.message_id;
        const content = p.content ?? "";
        const finalized = p.finalize === true
          || (p.finalize !== false && !isMidStream(content, env.ts));
        if (env.stream_id) this.closedStreams.delete(env.stream_id);
        const existing = this.findMessage(id);
        this.upsertMessage(existing
          ? { ...existing, content, finalized }
          : {
              id, role: "assistant", content,
              ts: env.ts, finalized,
            },
        );
        this.set({
          typingTs: finalized ? 0 : env.ts,
          currentStreamId: finalized ? null : (env.stream_id ?? this.state.currentStreamId),
        });
        if (finalized && env.stream_id) this.closedStreams.add(env.stream_id);
        return true;
      }
      case "gateway.message.cancel.requested": {
        const ge = env as EventEnvelope & GatewayEvent & {
          kind: "gateway.message.cancel.requested";
          payload: MessageCancelPayload;
        };
        this.applyCancel(ge.payload.stream_id || env.stream_id || "");
        return true;
      }
      case "gateway.typing": {
        const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.typing" };
        const p: TypingPayload = ge.payload;
        const streamId = env.stream_id ?? this.state.currentStreamId;
        if (streamId && (this.blockedStreams.has(streamId) || this.closedStreams.has(streamId))) {
          if (p.active === false && this.state.currentStreamId === streamId) {
            this.set({ currentStreamId: null, typingTs: 0 });
          }
          return true;
        }
        // Capture stream_id during "typing..." before the first message chunk
        // arrives so assistant-ui's cancel hook can interrupt the active run.
        this.set({
          typingTs: p.active === false ? 0 : env.ts,
          currentStreamId: streamId,
        });
        return true;
      }
      case "gateway.image":
      case "gateway.video":
      case "gateway.animation":
      case "gateway.document":
      case "gateway.voice": {
        const p = env.payload as {
          message_id?: string;
          attachments?: unknown;
          caption?: string;
        };
        const refs = normalizeAttachmentRefs(p.attachments);
        const id = p.message_id ?? `synthetic:${env.hash}`;
        const existing = this.findMessage(id);
        if (!existing) {
          this.upsertMessage({
            id, role: "assistant", content: p.caption ?? "",
            ts: env.ts, finalized: true,
          });
        } else if (p.caption && !existing.content) {
          this.upsertMessage({ ...existing, content: p.caption });
        }
        this.mergeAttachments(id, refs);
        return true;
      }
      case "gateway.approval.request":
        this.applyApprovalRequest(env);
        return true;
      case "gateway.approval.resolved":
        this.applyApprovalResolved(env);
        return true;
      case "gateway.clarify.request":
        this.applyClarifyRequest(env);
        return true;
      case "gateway.clarify.resolved":
        this.applyClarifyResolved(env);
        return true;
      case "gateway.resync": {
        const p = env.payload as ResyncPayload;
        const archived = this.state.archived;
        this.resetState(archived);
        this.set({ resyncing: true, lastSeq: p.tip_seq ?? 0, lastHash: p.tip_hash ?? null });
        return true;
      }
      case "gateway.error": {
        const p = env.payload as { message?: string; code?: string };
        this.set({
          errorBanner: p.message || p.code || "stream error",
          currentStreamId: null,
          typingTs: 0,
        });
        return true;
      }
    }
    return false;
  }

  private upsertMessage(m: OurMessage): void {
    const exists = this.state.messages.some((x) => x.id === m.id);
    this.set({
      messages: exists
        ? this.state.messages.map((x) => (x.id === m.id ? m : x))
        : [...this.state.messages, m],
    });
  }

  private findMessage(id: string): OurMessage | undefined {
    return this.state.messages.find((m) => m.id === id);
  }

  private mergeAttachments(messageId: string, refs: AttachmentRef[]): void {
    if (refs.length === 0) return;
    const cur = this.state.attachments[messageId] ?? [];
    const seen = new Set(cur.map((r) => r.attachment_id || r.url));
    const merged = [...cur];
    for (const r of refs) {
      const key = r.attachment_id || r.url;
      if (!seen.has(key)) {
        merged.push(r);
        seen.add(key);
      }
    }
    this.set({ attachments: { ...this.state.attachments, [messageId]: merged } });
  }

  private applyCancel(streamId: string): void {
    if (streamId) {
      this.blockedStreams.delete(streamId);
      this.closedStreams.add(streamId);
    }
    this.set({
      currentStreamId: streamId && this.state.currentStreamId !== streamId
        ? this.state.currentStreamId
        : null,
      typingTs: 0,
      messages: this.state.messages.map(finishAssistantMessage),
      approvals: Object.fromEntries(
        Object.entries(this.state.approvals).map(([id, approval]) => [
          id,
          streamId && approval.stream_id === streamId
            ? {
                ...approval,
                status: "resolved" as const,
                resolution: {
                  decision: "deny" as ApprovalDecision,
                  resolved_by: "system:cancel",
                  resolved_at: Date.now(),
                },
              }
            : approval,
        ]),
      ),
      clarifies: Object.fromEntries(
        Object.entries(this.state.clarifies).filter(([, clarify]) => clarify.stream_id !== streamId),
      ),
    });
  }

  private applyApprovalRequest(env: EventEnvelope): void {
    const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.approval.request" };
    const p: ApprovalRequestPayload = ge.payload;
    const view: ApprovalView = {
      tool_call_id: p.tool_call_id,
      tool_name: p.tool_name ?? "exec",
      prompt: p.prompt ?? "",
      command: p.command,
      args: p.args as Record<string, unknown> | undefined,
      choices: p.choices ?? APPROVAL_DEFAULT_CHOICES,
      expires_at: p.expires_at ?? env.ts + APPROVAL_DEFAULT_TTL_MS,
      stream_id: env.stream_id,
      requested_at: env.ts,
      status: "pending",
    };
    if (env.stream_id) {
      this.blockedStreams.add(env.stream_id);
      this.approvalStreams.set(p.tool_call_id, env.stream_id);
    }
    this.set({
      approvals: { ...this.state.approvals, [p.tool_call_id]: view },
      currentStreamId: env.stream_id ?? this.state.currentStreamId,
      typingTs: 0,
    });
  }

  private applyApprovalResolved(env: EventEnvelope): void {
    const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.approval.resolved" };
    const p: ApprovalResolvedPayload = ge.payload;
    const existing = this.state.approvals[p.tool_call_id];
    if (!existing) return;
    const streamId = this.approvalStreams.get(p.tool_call_id);
    if (streamId) this.blockedStreams.delete(streamId);
    this.approvalStreams.delete(p.tool_call_id);
    this.set({
      approvals: {
        ...this.state.approvals,
        [p.tool_call_id]: {
          ...existing,
          status: "resolved",
          resolution: {
            decision: p.decision,
            resolved_by: p.resolved_by ?? "",
            resolved_at: p.resolved_at ?? env.ts,
          },
        },
      },
    });
  }

  private applyClarifyRequest(env: EventEnvelope): void {
    const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.clarify.request" };
    const p: ClarifyRequestPayload = ge.payload;
    if (!p.clarify_id) return;
    const view: ClarifyView = {
      clarify_id: p.clarify_id,
      question: p.question ?? "",
      choices: Array.isArray(p.choices) ? p.choices : [],
      requested_at: p.requested_at ?? env.ts,
      stream_id: env.stream_id,
    };
    if (env.stream_id) {
      this.blockedStreams.add(env.stream_id);
      this.clarifyStreams.set(p.clarify_id, env.stream_id);
    }
    this.set({
      clarifies: { ...this.state.clarifies, [p.clarify_id]: view },
      currentStreamId: env.stream_id ?? this.state.currentStreamId,
      typingTs: 0,
    });
  }

  private applyClarifyResolved(env: EventEnvelope): void {
    const ge = env as EventEnvelope & GatewayEvent & { kind: "gateway.clarify.resolved" };
    const p: ClarifyResolvedPayload = ge.payload;
    if (!p.clarify_id || !this.state.clarifies[p.clarify_id]) return;
    const streamId = this.clarifyStreams.get(p.clarify_id);
    if (streamId) this.blockedStreams.delete(streamId);
    this.clarifyStreams.delete(p.clarify_id);
    const next = { ...this.state.clarifies };
    delete next[p.clarify_id];
    this.set({ clarifies: next });
  }
}

function finishAssistantMessage(m: OurMessage): OurMessage {
  if (m.role !== "assistant" || m.finalized) return m;
  return { ...m, content: stripStreamCursor(m.content), finalized: true };
}

function stripStreamCursor(content: string): string {
  return content.endsWith(STREAM_CURSOR_CHAR) ? content.slice(0, -1) : content;
}

function normalizeAttachmentRefs(refs: unknown): AttachmentRef[] {
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((r): AttachmentRef[] => {
    if (r && typeof r === "object") {
      const o = r as Partial<AttachmentRef>;
      return [{
        attachment_id: o.attachment_id ?? "",
        url: o.url ?? "",
        mime: o.mime ?? "",
        size: o.size ?? 0,
        sha256: o.sha256 ?? "",
        filename: o.filename,
        caption: o.caption,
      }];
    }
    return [];
  });
}

export function pendingApprovals(s: SessionState): ApprovalView[] {
  return Object.values(s.approvals)
    .filter((a) => a.status === "pending")
    .sort((a, b) => a.requested_at - b.requested_at);
}
