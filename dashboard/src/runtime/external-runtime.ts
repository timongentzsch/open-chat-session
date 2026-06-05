// Bridges the gateway event store into assistant-ui's ExternalStoreRuntime.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "@/sdk";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { GatewayClient } from "@/gateway-client";
import { GatewayError } from "@/errors";
import {
  SessionStore,
  type OurMessage,
  type SessionState,
} from "@/runtime/session-store";
import { createAttachmentAdapter } from "@/runtime/attachment-adapter";
import { ERR_ID_PREFIX } from "@/constants";
import { previewText } from "@/lib/preview";
import { loadHistory, saveHistory, clearHistory } from "@/lib/history-cache";

export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; nextDelayMs: number; lastError: string }
  | { kind: "unauthorized"; lastError: string };

export interface UseSessionRuntimeResult {
  state: SessionState;
  store: SessionStore;
  runtime: ReturnType<typeof useExternalStoreRuntime>;
  conn: ConnState;
  isTyping: boolean;
  /** True when older history exists above the loaded window (scroll-up paging). */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Fetch + prepend the previous page. `beforePrepend` fires synchronously
   *  right before the prepend so the caller can snapshot scroll position. */
  loadOlder: (beforePrepend?: () => void) => Promise<void>;
}

const TYPING_MS = 5000;

// Cache the converted message by source identity. The store reuses OurMessage
// objects for unchanged bubbles, so cache hits keep the same ThreadMessageLike
// reference and assistant-ui/streamdown skip re-rendering untouched bubbles.
const convertCache = new WeakMap<OurMessage, ThreadMessageLike>();
function convertMessage(m: OurMessage): ThreadMessageLike {
  const hit = convertCache.get(m);
  if (hit) return hit;
  const base: ThreadMessageLike = {
    id: m.id,
    role: m.role,
    content: [{ type: "text", text: m.content }],
    createdAt: new Date(m.ts),
  };
  const out = m.role === "assistant"
    ? { ...base, status: (m.finalized ? { type: "complete", reason: "stop" } : { type: "running" }) as ThreadMessageLike["status"] }
    : base;
  convertCache.set(m, out);
  return out;
}

export function useSessionRuntime(
  client: GatewayClient,
  sessionId: string | null,
  archived: boolean,
  replyTo: string | null = null,
  onReplySent?: () => void,
): UseSessionRuntimeResult {
  const storeRef = useRef<SessionStore | null>(null);
  if (!storeRef.current) storeRef.current = new SessionStore();
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [conn, setConn] = useState<ConnState>({ kind: "idle" });

  // On gateway.resync, bump an epoch so the connect effect re-runs (refetch +
  // reopen) instead of leaving an empty thread with a stuck banner. Bumps once
  // per resync — the connect effect's store.reset clears resyncing.
  const [resyncEpoch, setResyncEpoch] = useState(0);
  useEffect(() => {
    if (!state.resyncing) return;
    // The cached chain is now invalid — drop it so the reconnect fetches fresh.
    if (sessionId) clearHistory(sessionId);
    setResyncEpoch((n) => n + 1);
  }, [state.resyncing, sessionId]);

  useEffect(() => {
    store.setArchived(archived);
  }, [archived, store]);

  useEffect(() => {
    if (!sessionId) {
      store.reset();
      setConn({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    let attempt = 0;
    store.reset(archived);
    // Hydrate from the local cache for an instant render; the connect below then
    // resumes from the cached tip hash (server replays only the delta, or sends
    // gateway.resync if the tip is unknown — which clears the cache and refetches).
    const cached = loadHistory(sessionId);
    if (cached) store.importHistory(cached);

    async function run() {
      while (!cancelled) {
        setConn(
          attempt === 0
            ? { kind: "connecting" }
            : { kind: "reconnecting", nextDelayMs: backoff(attempt), lastError: "reconnecting" },
        );
        try {
          // Fresh load → tail (latest N) so a long conversation opens at its
          // newest messages; a reconnect resumes from the in-memory tip.
          const tip = store.getSnapshot().lastHash;
          const cursor = tip
            ? { lastEventId: tip }
            : { cursor: "latest" as const, latestN: 200 };
          const gen = client.streamEvents(sessionId!, cursor, ac.signal);
          setConn({ kind: "connected" });
          attempt = 0;
          for await (const env of gen) {
            if (cancelled) break;
            store.applyEvent(env);
          }
          if (cancelled) break;
        } catch (exc) {
          if (cancelled || (exc instanceof DOMException && exc.name === "AbortError")) break;
          // Auth failures won't recover by retrying — surface and stop.
          if (exc instanceof GatewayError && (exc.status === 401 || exc.status === 403)) {
            const msg = exc.status === 401
              ? "Session expired — reload to re-authenticate."
              : "Access denied for this device.";
            store.setError(msg);
            setConn({ kind: "unauthorized", lastError: msg });
            break;
          }
          attempt += 1;
          const delay = backoff(attempt);
          setConn({
            kind: "reconnecting",
            nextDelayMs: delay,
            lastError: exc instanceof Error ? exc.message : String(exc),
          });
          await sleep(delay);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [client, sessionId, archived, store, resyncEpoch]);

  // Cache the transcript when the tip advances (debounced to batch streaming),
  // so reopening renders instantly and only the delta is fetched.
  useEffect(() => {
    if (!sessionId || state.resyncing || !state.lastHash) return;
    const sid = sessionId;
    const tip = state.lastHash;
    const id = window.setTimeout(() => {
      // Re-check at flush: a resync may have landed (which would have changed the
      // tip / cleared the cache), and the effect cleanup cancels on session switch
      // — so only persist if we're still on the same session at the same tip.
      const snap = store.getSnapshot();
      if (snap.resyncing || snap.lastHash !== tip) return;
      saveHistory(sid, store.exportRaw());
    }, 800);
    return () => window.clearTimeout(id);
  }, [sessionId, state.lastHash, state.resyncing, store]);

  // One expiry timeout per heartbeat (rescheduled on each), instead of a polling
  // interval — no idle re-renders, and the deadline is absolute so it can't go
  // stale. typingRecvTs is client-clock, so the TTL is immune to server skew.
  const [typingExpired, setTypingExpired] = useState(true);
  useEffect(() => {
    if (!state.typingRecvTs) { setTypingExpired(true); return; }
    setTypingExpired(false);
    const remaining = state.typingRecvTs + TYPING_MS - Date.now();
    if (remaining <= 0) { setTypingExpired(true); return; }
    const id = window.setTimeout(() => setTypingExpired(true), remaining);
    return () => window.clearTimeout(id);
  }, [state.typingRecvTs]);
  const isTyping = state.typingRecvTs > 0 && !typingExpired;

  const cancelRun = async () => {
    if (!sessionId) return;
    const streamId = store.getSnapshot().currentStreamId ?? "";
    store.cancelActive(streamId);
    await client.cancelStream(sessionId, streamId);
  };

  const hasOlder = state.firstSeq > 1;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async (beforePrepend?: () => void) => {
    if (loadingOlderRef.current || !sessionId) return;
    const start = store.getSnapshot();
    if (!start.firstHash || start.firstSeq <= 1) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    beforePrepend?.();
    // Persisted typing heartbeats bloat the log, so one raw page can be almost
    // all typing. Keep paging until we reveal enough real messages (or hit
    // genesis), so a click never appears to "do nothing".
    const TARGET_NEW = 12;
    const MAX_PAGES = 8;
    const baseCount = start.messages.length;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const snap = store.getSnapshot();
        if (!snap.firstHash || snap.firstSeq <= 1) break;
        const h = await client.history(sessionId, { before: snap.firstHash, limit: 200 });
        if (h.events.length === 0) break;
        store.prependHistory([...h.events].sort((a, b) => a.seq - b.seq));
        if (store.getSnapshot().messages.length - baseCount >= TARGET_NEW) break;
      }
    } catch { /* tolerated — user can retry */ }
    finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [client, sessionId, store]);

  // Adapter stays stable across re-renders; sessionId read via ref.
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;
  const attachmentAdapter = useMemo(
    () => createAttachmentAdapter(client, () => sidRef.current),
    [client],
  );

  const runtime = useExternalStoreRuntime<OurMessage>({
    messages: state.messages,
    convertMessage,
    // Always report not-running so ComposerPrimitive.Send stays enabled even
    // while the agent is mid-stream. The actual "is the agent active right
    // now?" check happens inline in onNew below, where we implicitly /stop
    // the active run before sending a plain message.
    isRunning: false,
    isDisabled: archived || !sessionId,
    isSendDisabled: conn.kind !== "connected",
    adapters: { attachments: attachmentAdapter },
    onNew: async (msg: AppendMessage) => {
      if (!sessionId) return;
      const text = msg.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      const attachments = (msg.attachments ?? [])
        .map((a) => a.id)
        .filter((id): id is string => typeof id === "string" && !id.startsWith(ERR_ID_PREFIX));
      if (!text.trim() && attachments.length === 0) return;

      // If the agent is still active and the user typed a plain message
      // (no leading "/command"), implicitly cancel the active run first.
      // A "/foo" command is forwarded as-is so the gateway can route it
      // (e.g. /undo, /usage) without us short-circuiting the stream.
      const isSlashCommand = text.trim().startsWith("/");
      const activeStreamId = store.getSnapshot().currentStreamId;
      if (activeStreamId && !isSlashCommand) {
        await cancelRun();
      }

      // Reply context is sent as a plain text prefix so the agent sees it as
      // part of the user's prompt; the structured `reply_to` field is left
      // unused on purpose so the agent can't bind back to an earlier turn.
      let outboundText = text;
      if (replyTo) {
        const replied = store.getSnapshot().messages.find((m) => m.id === replyTo);
        if (replied?.content) {
          outboundText = `REPLY TO: ${previewText(replied.content)}\n\n${text}`;
        }
      }

      onReplySent?.();
      const gen = client.sendMessage(sessionId, {
        text: outboundText,
        attachments,
      });
      for await (const env of gen) {
        // Session switched mid-stream: stop draining into the now-reset store
        // (seq dedupe can't help once lastSeq was reset).
        if (sidRef.current !== sessionId) break;
        store.applyEvent(env);
      }
    },
    onCancel: async () => {
      await cancelRun();
    },
  });

  return { state, store, runtime, conn, isTyping, hasOlder, loadingOlder, loadOlder };
}

export { AssistantRuntimeProvider };

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
