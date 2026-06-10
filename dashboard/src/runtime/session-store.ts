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
  MessageLifecycle,
  MessageOutPayload,
  StreamId,
  TypingPayload,
  ToolCallId,
} from "../types";
import type { CachedHistory, HistorySnapshot } from "../lib/history-cache";

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
  // Client-clock time of the last live typing/streaming signal; drives the
  // typing TTL. Not tied to per-message finalize (a finalized message != run end).
  typingRecvTs: number;
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
    typingRecvTs: 0,
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
// Ignore replayed rows when lighting the indicator; only genuinely recent events
// mean the agent is working now. Wide enough to absorb clock skew.
const TYPING_FRESH_MS = 15_000;
const APPROVAL_DEFAULT_TTL_MS = 5 * 60_000;
const APPROVAL_DEFAULT_CHOICES: ApprovalDecision[] = ["once", "session", "always", "deny"];
const OBJECT_PAYLOAD_EVENTS = new Set<string>([
  "gateway.message.in",
  "gateway.message.out",
  "gateway.message.edit",
  "gateway.message.cancel.requested",
  "gateway.image",
  "gateway.video",
  "gateway.animation",
  "gateway.document",
  "gateway.voice",
  "gateway.approval.request",
  "gateway.approval.resolved",
  "gateway.clarify.request",
  "gateway.clarify.resolved",
  "gateway.error",
]);

// Events that contribute to the rendered transcript (everything else — typing,
// approvals, clarifies, resync, errors — is live-only side-channel state).
const TRANSCRIPT_KINDS = new Set<string>([
  "gateway.message.in", "gateway.message.out", "gateway.message.edit",
  "gateway.image", "gateway.video", "gateway.animation",
  "gateway.document", "gateway.voice",
]);

function isMidStream(content: string | undefined, ts: number): boolean {
  if (!content || !content.endsWith(STREAM_CURSOR_CHAR)) return false;
  return Date.now() - ts < STALE_MS;
}

// Explicit lifecycle wins; null = row predates lifecycle, use glyph fallback.
// A stale "streaming" row renders settled, mirroring the glyph freshness gate.
function lifecycleFinalized(lc: MessageLifecycle | undefined, ts: number): boolean | null {
  if (!lc) return null;
  if (lc.phase === "final") return true;
  return Date.now() - ts >= STALE_MS;
}

export class SessionStore {
  private state: SessionState = initialSessionState();
  private listeners = new Set<() => void>();
  // Paused for approval/clarify — typing suppressed.
  private blockedStreams = new Set<StreamId>();
  // Run truly ended (cancel/error) — suppress late heartbeats. Per-message
  // finalize must NOT add here; that was the typing-dropout bug.
  private endedStreams = new Set<StreamId>();
  private approvalStreams = new Map<ToolCallId, StreamId>();
  private clarifyStreams = new Map<ClarifyId, StreamId>();
  // Raw transcript events (message/media) keyed by seq. Rendered messages are a
  // pure fold of these in seq order (foldTranscript), so the live and history
  // paths agree and a mid-run steer always splits the assistant bubble correctly.
  private msgEvents = new Map<number, EventEnvelope>();
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
    this.endedStreams.clear();
    this.msgEvents.clear();
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

  /** Merge an older page (events with seq < firstSeq, ascending) into the event
   *  log and re-fold. firstSeq/firstHash track the oldest raw event (any kind)
   *  so the next `before=` page continues correctly through typing-only ranges. */
  prependHistory(events: EventEnvelope[]): void {
    if (events.length === 0) return;
    for (const env of events) {
      if (TRANSCRIPT_KINDS.has(env.kind)) this.msgEvents.set(env.seq, env);
    }
    this.set({ firstSeq: events[0].seq, firstHash: events[0].hash });
    this.rebuildTranscript();
    this.emit();
  }

  private rebuildTranscript(): void {
    const { messages, attachments } = foldTranscript([...this.msgEvents.values()]);
    // Reuse the previous object for unchanged messages so assistant-ui/streamdown
    // only re-render (and re-highlight) the bubble that actually changed — folding
    // from scratch each edit would otherwise reflow the whole transcript (scroll
    // jitter) on every streamed token.
    this.set({ messages: reuseUnchanged(this.state.messages, messages), attachments });
  }

  /** Snapshot the transcript events + tip for the localStorage cache; the cache
   *  derives the first-cursors from the retained events. */
  exportRaw(): HistorySnapshot {
    return {
      lastSeq: this.state.lastSeq,
      lastHash: this.state.lastHash,
      events: [...this.msgEvents.values()],
    };
  }

  /** Seed from a cached snapshot so a reopened session renders instantly; the
   *  connect then resumes from `lastHash` and the server replays only the delta
   *  (or sends gateway.resync if the cached tip is unknown). */
  importHistory(c: CachedHistory): void {
    this.msgEvents.clear();
    for (const env of c.events) {
      if (TRANSCRIPT_KINDS.has(env.kind)) this.msgEvents.set(env.seq, env);
    }
    this.set({ lastSeq: c.lastSeq, lastHash: c.lastHash, firstSeq: c.firstSeq, firstHash: c.firstHash });
    this.rebuildTranscript();
    this.emit();
  }

  cancelActive(streamId = ""): void {
    this.applyCancel(streamId);
    this.emit();
  }

  private applyInternal(env: EventEnvelope): boolean {
    // Ephemeral presence (typing) carries no seq/hash and is never part of the
    // log/replay — handle it without touching the resume cursor or seq-dedupe.
    // (Legacy persisted typing rows from older sessions land here too and are
    // correctly ignored by the freshness gate.)
    if (env.kind === "gateway.typing") {
      const p = env.payload as TypingPayload;
      if (p?.active === false) { this.set({ typingRecvTs: 0 }); return true; }
      const streamId = env.stream_id ?? this.state.currentStreamId;
      if (streamId && !this.state.currentStreamId && !this.endedStreams.has(streamId)) {
        this.set({ currentStreamId: streamId });
      }
      this.markTyping(env);
      return true;
    }
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
        this.msgEvents.set(env.seq, env);
        this.set({ currentStreamId: env.stream_id ?? this.state.currentStreamId });
        this.rebuildTranscript();
        return true;
      }
      case "gateway.message.out": {
        const p = env.payload as MessageOutPayload;
        const finalized = lifecycleFinalized(p.lifecycle, env.ts) ?? !isMidStream(p.content ?? "", env.ts);
        this.msgEvents.set(env.seq, env);
        this.set({
          currentStreamId: finalized ? null : (env.stream_id ?? this.state.currentStreamId),
        });
        if (!finalized) this.markTyping(env);
        this.rebuildTranscript();
        return true;
      }
      case "gateway.message.edit": {
        const p = env.payload as MessageEditPayload;
        const finalized = lifecycleFinalized(p.lifecycle, env.ts)
          ?? (p.finalize === true
            || (p.finalize !== false && !isMidStream(p.content ?? "", env.ts)));
        this.msgEvents.set(env.seq, env);
        this.set({
          currentStreamId: finalized ? null : (env.stream_id ?? this.state.currentStreamId),
        });
        // finalize ends this message, not the run — never clear typing here.
        if (!finalized) this.markTyping(env);
        this.rebuildTranscript();
        return true;
      }
      case "gateway.message.cancel.requested": {
        const p = env.payload as MessageCancelPayload;
        this.applyCancel(p.stream_id || env.stream_id || "");
        return true;
      }
      case "gateway.image":
      case "gateway.video":
      case "gateway.animation":
      case "gateway.document":
      case "gateway.voice": {
        this.msgEvents.set(env.seq, env);
        this.rebuildTranscript();
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
        const archived = this.state.archived;
        this.resetState(archived);
        // lastSeq stays 0: the reconnect replays from the start, and the seq-dedupe
        // would otherwise drop that replay. tip_seq/tip_hash are not resume cursors.
        this.set({ resyncing: true });
        return true;
      }
      case "gateway.error": {
        const p = env.payload as { message?: string; code?: string };
        if (env.stream_id) this.endedStreams.add(env.stream_id);
        this.set({
          errorBanner: p.message || p.code || "stream error",
          currentStreamId: null,
          typingRecvTs: 0,
        });
        return true;
      }
    }
    return false;
  }

  // Light the typing indicator from a live working signal (heartbeat / streaming
  // edit). Skips blocked/ended streams and stale replayed rows.
  private markTyping(env: EventEnvelope): void {
    const streamId = env.stream_id ?? this.state.currentStreamId;
    if (streamId && (this.blockedStreams.has(streamId) || this.endedStreams.has(streamId))) return;
    if (Date.now() - env.ts >= TYPING_FRESH_MS) return;
    this.set({ typingRecvTs: Date.now() });
  }

  // Optimistic finalize of in-flight assistant messages on cancel. This mutates
  // the rendered messages directly (outside the fold) for instant feedback; a
  // subsequent authoritative edit re-folds from msgEvents, and the run is over so
  // no further non-final edits arrive to revert it.
  private applyCancel(streamId: string): void {
    if (streamId) {
      this.blockedStreams.delete(streamId);
      this.endedStreams.add(streamId);
    }
    this.set({
      currentStreamId: streamId && this.state.currentStreamId !== streamId
        ? this.state.currentStreamId
        : null,
      typingRecvTs: 0,
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
      typingRecvTs: 0,
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
      typingRecvTs: 0,
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

// Return `next` with each unchanged message replaced by its previous object so
// references stay stable across rebuilds (keeps React/streamdown from re-rendering
// untouched bubbles). Returns the previous array unchanged if nothing differs.
function reuseUnchanged(prev: OurMessage[], next: OurMessage[]): OurMessage[] {
  if (prev.length === 0) return next;
  const byId = new Map(prev.map((m) => [m.id, m]));
  let changed = next.length !== prev.length;
  const out = next.map((m, i) => {
    const old = byId.get(m.id);
    if (old && old.content === m.content && old.finalized === m.finalized
      && old.role === m.role && old.ts === m.ts && old.replyTo === m.replyTo) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return m;
  });
  return changed ? out : prev;
}

function finishAssistantMessage(m: OurMessage): OurMessage {
  if (m.role !== "assistant" || m.finalized) return m;
  return { ...m, content: stripStreamCursor(m.content), finalized: true };
}

function stripStreamCursor(content: string): string {
  return content.endsWith(STREAM_CURSOR_CHAR) ? content.slice(0, -1) : content;
}

// Slice cumulative content to a split segment, keeping the streaming cursor on the tail.
function segmentContent(rawFull: string, base: number): string {
  if (base <= 0) return rawFull;
  const body = stripStreamCursor(rawFull).slice(base);
  return rawFull.endsWith(STREAM_CURSOR_CHAR) ? body + STREAM_CURSOR_CHAR : body;
}

/** Fold the seq-ordered transcript events into rendered messages + attachments.
 *  Pure, so the live stream and history paging produce identical output. An
 *  assistant message reused across a user steer is split into ordered segments. */
function foldTranscript(events: EventEnvelope[]): {
  messages: OurMessage[];
  attachments: Record<string, AttachmentRef[]>;
} {
  const messages: OurMessage[] = [];
  const idx = new Map<string, number>();        // ourId -> messages index
  const segOf = new Map<string, string>();      // realId -> current segment id
  const segBase = new Map<string, number>();    // segment id -> stripped chars before it
  const lastEdit = new Map<string, number>();   // realId -> seq of its last content change
  const lastFull = new Map<string, string>();   // realId -> last cumulative content
  const attachments: Record<string, AttachmentRef[]> = {};
  let lastInbound = 0;

  const put = (m: OurMessage) => {
    const i = idx.get(m.id);
    if (i === undefined) { idx.set(m.id, messages.length); messages.push(m); }
    else messages[i] = m;
  };
  const get = (id: string): OurMessage | undefined => {
    const i = idx.get(id);
    return i === undefined ? undefined : messages[i];
  };
  const addAttach = (id: string, refs: AttachmentRef[]) => {
    if (!refs.length) return;
    const cur = attachments[id] ?? [];
    const seen = new Set(cur.map((r) => r.attachment_id || r.url));
    attachments[id] = [...cur, ...refs.filter((r) => !seen.has(r.attachment_id || r.url))];
  };

  for (const env of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = (env.payload ?? {}) as Record<string, unknown>;
    switch (env.kind) {
      case "gateway.message.in": {
        const id = (p.message_id as string) ?? `synthetic:${env.hash}`;
        put({ id, role: "user", content: (p.text as string) ?? "", ts: env.ts, finalized: true, replyTo: p.reply_to as string | undefined });
        addAttach(id, normalizeAttachmentRefs(p.attachments));
        lastInbound = env.seq;
        break;
      }
      case "gateway.message.out": {
        const id = p.message_id as string;
        const content = (p.content as string) ?? "";
        const finalized = lifecycleFinalized(p.lifecycle as MessageLifecycle | undefined, env.ts)
          ?? !isMidStream(content, env.ts);
        if (!segOf.has(id)) { segOf.set(id, id); segBase.set(id, 0); }
        lastEdit.set(id, env.seq);
        lastFull.set(id, content);
        put({ id, role: "assistant", content: finalized ? stripStreamCursor(content) : content, ts: env.ts, finalized, replyTo: p.reply_to as string | undefined });
        break;
      }
      case "gateway.message.edit": {
        const id = p.message_id as string;
        const content = (p.content as string) ?? "";
        const finalized = lifecycleFinalized(p.lifecycle as MessageLifecycle | undefined, env.ts)
          ?? (p.finalize === true || (p.finalize !== false && !isMidStream(content, env.ts)));
        const known = segOf.has(id);
        const changed = content !== lastFull.get(id);
        if (!known) { segOf.set(id, id); segBase.set(id, 0); }
        // A steer landed since this message's last content change → split here so
        // the steer renders between the before/after content (strict seq order).
        else if (changed && lastInbound > (lastEdit.get(id) ?? 0)) {
          const oldId = segOf.get(id) ?? id;
          const oldMsg = get(oldId);
          const frozen = oldMsg ? stripStreamCursor(oldMsg.content) : "";
          if (oldMsg) put({ ...oldMsg, content: frozen, finalized: true });
          const newId = `${id}#${env.seq}`;
          segBase.set(newId, (segBase.get(oldId) ?? 0) + frozen.length);
          segOf.set(id, newId);
        }
        if (changed) lastEdit.set(id, env.seq);
        lastFull.set(id, content);
        const segId = segOf.get(id) ?? id;
        const disp0 = segmentContent(content, segBase.get(segId) ?? 0);
        const disp = finalized ? stripStreamCursor(disp0) : disp0;
        const existing = get(segId);
        put(existing ? { ...existing, content: disp, finalized } : { id: segId, role: "assistant", content: disp, ts: env.ts, finalized });
        break;
      }
      case "gateway.image":
      case "gateway.video":
      case "gateway.animation":
      case "gateway.document":
      case "gateway.voice": {
        const id = (p.message_id as string) ?? `synthetic:${env.hash}`;
        const existing = get(id);
        if (!existing) put({ id, role: "assistant", content: (p.caption as string) ?? "", ts: env.ts, finalized: true });
        else if (p.caption && !existing.content) put({ ...existing, content: p.caption as string });
        addAttach(id, normalizeAttachmentRefs(p.attachments));
        break;
      }
    }
  }
  return { messages, attachments };
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
