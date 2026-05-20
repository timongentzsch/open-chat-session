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
  private streamMessages = new Map<StreamId, string>();
  private messageChunks = new Map<string, Map<string, string>>();
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
    this.streamMessages.clear();
    this.messageChunks.clear();
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

  loadHistory(events: EventEnvelope[], archived = this.state.archived): void {
    this.resetState(archived);
    for (const env of events) this.applyInternal(env);
    this.emit();
  }

  applyEvent(env: EventEnvelope): void {
    if (this.applyInternal(env)) this.emit();
  }

  cancelActive(streamId = ""): void {
    this.applyCancel(streamId);
    this.emit();
  }

  private applyInternal(env: EventEnvelope): boolean {
    if (env.seq <= this.state.lastSeq && this.state.lastSeq !== 0) return false;
    this.set({ lastSeq: env.seq, lastHash: env.hash });

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
        const id = this.messageIdForStream(env, p.message_id);
        const content = this.mergeMessageChunk(id, p.message_id, p.content ?? "");
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
        const id = this.messageIdForStream(env, p.message_id);
        const content = this.mergeMessageChunk(id, p.message_id, p.content ?? "");
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

  private messageIdForStream(env: EventEnvelope, fallback: string): string {
    if (!env.stream_id) return fallback;
    const existing = this.streamMessages.get(env.stream_id);
    if (existing) return existing;
    this.streamMessages.set(env.stream_id, fallback);
    return fallback;
  }

  private mergeMessageChunk(messageId: string, chunkId: string, content: string): string {
    let chunks = this.messageChunks.get(messageId);
    if (!chunks) {
      chunks = new Map();
      this.messageChunks.set(messageId, chunks);
    }
    chunks.set(chunkId, content);
    return [...chunks.values()].reduce((merged, part, index, values) => {
      const clean = index === values.length - 1 ? part : stripStreamCursor(part);
      return merged + chunkBoundary(merged, clean) + clean;
    }, "");
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
    if (streamId) this.streamMessages.delete(streamId);
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

function chunkBoundary(before: string, after: string): string {
  if (!before || before.endsWith("\n") || after.startsWith("\n")) return "";
  const openFenceCount = before.match(/```/g)?.length ?? 0;
  return openFenceCount % 2 === 1 && /^\s+/.test(after) ? "\n" : "";
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

export function hasRunningAssistant(s: SessionState): boolean {
  return !!s.currentStreamId || s.messages.some((m) => m.role === "assistant" && !m.finalized);
}
