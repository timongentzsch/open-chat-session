// Folds gateway events into assistant-ui messages plus UI side channels.

import type {
  ApprovalDecision,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AttachmentRef,
  EventEnvelope,
  MessageEditPayload,
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

export interface SessionState {
  messages: OurMessage[];
  attachments: Record<string, AttachmentRef[]>;
  approvals: Record<ToolCallId, ApprovalView>;
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
const APPROVAL_RESOLVED_WINDOW_MS = 6_000;
const APPROVAL_DEFAULT_CHOICES: ApprovalDecision[] = ["once", "session", "always", "deny"];

function isMidStream(content: string | undefined, ts: number): boolean {
  if (!content || !content.endsWith(STREAM_CURSOR_CHAR)) return false;
  return Date.now() - ts < STALE_MS;
}

export class SessionStore {
  private state: SessionState = initialSessionState();
  private listeners = new Set<() => void>();

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

  reset(initialArchived = false): void {
    this.state = { ...initialSessionState(), archived: initialArchived };
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
    this.state = { ...initialSessionState(), archived };
    for (const env of events) this.applyInternal(env);
    this.emit();
  }

  applyEvent(env: EventEnvelope): void {
    if (this.applyInternal(env)) this.emit();
  }

  private applyInternal(env: EventEnvelope): boolean {
    if (env.seq <= this.state.lastSeq && this.state.lastSeq !== 0) return false;
    this.set({ lastSeq: env.seq, lastHash: env.hash });

    switch (env.kind) {
      case "gateway.message.in": {
        if (!env.payload || typeof env.payload !== "object") return false;
        const p = env.payload as MessageInPayload;
        const id = p.message_id ?? `synthetic:${env.hash}`;
        this.upsertMessage({
          id, role: "user", content: p.text ?? "", ts: env.ts, finalized: true,
        });
        this.mergeAttachments(id, normalizeAttachmentRefs(p.attachments));
        this.set({ currentStreamId: env.stream_id ?? this.state.currentStreamId });
        return true;
      }
      case "gateway.message.out": {
        if (!env.payload || typeof env.payload !== "object") return false;
        const p = env.payload as MessageOutPayload;
        const finalized = !isMidStream(p.content, env.ts);
        this.upsertMessage({
          id: p.message_id, role: "assistant", content: p.content ?? "",
          ts: env.ts, finalized,
        });
        this.set({
          currentStreamId: env.stream_id ?? null,
          typingTs: finalized ? 0 : env.ts,
        });
        return true;
      }
      case "gateway.message.edit": {
        if (!env.payload || typeof env.payload !== "object") return false;
        const p = env.payload as MessageEditPayload;
        const finalized = !!p.finalize || !isMidStream(p.content, env.ts);
        const existing = this.findMessage(p.message_id);
        this.upsertMessage(existing
          ? { ...existing, content: p.content, finalized }
          : {
              id: p.message_id, role: "assistant", content: p.content,
              ts: env.ts, finalized,
            },
        );
        this.set({
          typingTs: finalized ? 0 : env.ts,
          currentStreamId: finalized ? null : (env.stream_id ?? this.state.currentStreamId),
        });
        return true;
      }
      case "gateway.typing": {
        if (!env.payload || typeof env.payload !== "object") return false;
        const p = env.payload as TypingPayload;
        this.set({ typingTs: p.active === false ? 0 : env.ts });
        return true;
      }
      case "gateway.image":
      case "gateway.video":
      case "gateway.animation":
      case "gateway.document":
      case "gateway.voice": {
        if (!env.payload || typeof env.payload !== "object") return false;
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
      case "gateway.resync": {
        const p = env.payload as ResyncPayload;
        this.state = {
          ...initialSessionState(),
          resyncing: true,
          archived: this.state.archived,
          lastSeq: p.tip_seq ?? 0,
          lastHash: p.tip_hash ?? null,
        };
        return true;
      }
      case "gateway.error": {
        if (!env.payload || typeof env.payload !== "object") return false;
        const p = env.payload as { message?: string; code?: string };
        this.set({
          errorBanner: p.message || p.code || "stream error",
          currentStreamId: null,
          typingTs: 0,
        });
        return true;
      }
    }
    return true;
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

  private applyApprovalRequest(env: EventEnvelope): void {
    const p = env.payload as ApprovalRequestPayload;
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
    this.set({ approvals: { ...this.state.approvals, [p.tool_call_id]: view } });
  }

  private applyApprovalResolved(env: EventEnvelope): void {
    const p = env.payload as ApprovalResolvedPayload;
    const existing = this.state.approvals[p.tool_call_id];
    if (!existing) return;
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

export function recentlyResolved(s: SessionState, ms = APPROVAL_RESOLVED_WINDOW_MS): ApprovalView[] {
  const cutoff = Date.now() - ms;
  return Object.values(s.approvals)
    .filter((a) => a.status === "resolved" && (a.resolution?.resolved_at ?? 0) >= cutoff)
    .sort((a, b) => (a.resolution?.resolved_at ?? 0) - (b.resolution?.resolved_at ?? 0));
}

export function hasRunningAssistant(s: SessionState): boolean {
  return !!s.currentStreamId || s.messages.some((m) => m.role === "assistant" && !m.finalized);
}
