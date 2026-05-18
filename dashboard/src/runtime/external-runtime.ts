// Bridges the gateway event store into assistant-ui's ExternalStoreRuntime.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "@/sdk";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { GatewayClient } from "@/gateway-client";
import {
  hasRunningAssistant,
  SessionStore,
  type OurMessage,
  type SessionState,
} from "@/runtime/session-store";
import { getLastHash, setLastHash } from "@/runtime/resume";
import { createAttachmentAdapter } from "@/runtime/attachment-adapter";

export type ConnState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; nextDelayMs: number; lastError: string };

export interface UseSessionRuntimeResult {
  state: SessionState;
  store: SessionStore;
  runtime: ReturnType<typeof useExternalStoreRuntime>;
  conn: ConnState;
}

const TYPING_MS = 5000;

function convertMessage(m: OurMessage): ThreadMessageLike {
  const base: ThreadMessageLike = {
    id: m.id,
    role: m.role,
    content: [{ type: "text", text: m.content }],
    createdAt: new Date(m.ts),
  };
  return m.role === "assistant"
    ? {
        ...base,
        status: m.finalized ? { type: "complete", reason: "stop" } : { type: "running" },
      }
    : base;
}

export function useSessionRuntime(
  client: GatewayClient,
  sessionId: string | null,
  archived: boolean,
): UseSessionRuntimeResult {
  const storeRef = useRef<SessionStore | null>(null);
  if (!storeRef.current) storeRef.current = new SessionStore();
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [conn, setConn] = useState<ConnState>({ kind: "idle" });

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
    let hydrated = false;
    store.reset(archived);

    async function run() {
      while (!cancelled) {
        setConn(
          attempt === 0
            ? { kind: "connecting" }
            : { kind: "reconnecting", nextDelayMs: backoff(attempt), lastError: "reconnecting" },
        );
        try {
          if (!hydrated) {
            // History may 404 on first connect; live cursor=latest backfills.
            try {
              const h = await client.history(sessionId!, { limit: 200 });
              store.loadHistory([...h.events].sort((a, b) => a.seq - b.seq), archived);
            } catch { /* tolerated */ }
            hydrated = true;
          }
          const tipHash = store.getSnapshot().lastHash || getLastHash(sessionId!);
          const cursor = tipHash
            ? { lastEventId: tipHash }
            : { cursor: "latest" as const, latestN: 200 };
          const gen = client.streamEvents(sessionId!, cursor, ac.signal);
          setConn({ kind: "connected" });
          attempt = 0;
          for await (const env of gen) {
            if (cancelled) break;
            store.applyEvent(env);
            if (env.hash) setLastHash(sessionId!, env.hash);
          }
          if (cancelled) break;
        } catch (exc) {
          if (cancelled || (exc instanceof DOMException && exc.name === "AbortError")) break;
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
  }, [client, sessionId, archived, store]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.typingTs) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [state.typingTs]);
  const isTyping = state.typingTs > 0 && now - state.typingTs < TYPING_MS;
  const isRunning = isTyping || hasRunningAssistant(state);

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
    isRunning,
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
        .filter((id): id is string => typeof id === "string" && !id.startsWith("err-"));
      if (!text.trim() && attachments.length === 0) return;
      const gen = client.sendMessage(sessionId, { text, attachments });
      for await (const env of gen) {
        store.applyEvent(env);
        if (env.hash) setLastHash(sessionId, env.hash);
      }
    },
    onCancel: async () => {
      const sid = store.getSnapshot().currentStreamId;
      if (sessionId && sid) await client.cancelStream(sessionId, sid);
    },
  });

  return { state, store, runtime, conn };
}

export { AssistantRuntimeProvider };

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
