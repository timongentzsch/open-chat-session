// `/chat-session` page: sessions sidebar, assistant-ui thread/composer,
// and the approval rail.

import { React, cn, useCallback, useEffect, useMemo, useState } from "@/sdk";
import { useGatewayClient } from "@/hooks/useGatewayClient";
import { useSessions } from "@/hooks/useSessions";
import { useResumeParam } from "@/hooks/useResumeParam";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ChatThread } from "@/components/ChatThread";
import { Composer } from "@/components/Composer";
import { ApprovalPanel } from "@/components/ApprovalPanel";
import { Banner, ConnectionPill } from "@/components/StatusBanners";
import {
  AssistantRuntimeProvider,
  useSessionRuntime,
} from "@/runtime/external-runtime";
import { pendingApprovals, recentlyResolved } from "@/runtime/session-store";
import { getSelectedSession, setSelectedSession } from "@/runtime/resume";
import type { ApprovalDecision, HealthResponse, SessionInfo } from "@/types";

export function ChatPage() {
  const client = useGatewayClient();
  const { sessions, loading, error: sessionsError, refresh, createSession } =
    useSessions(client);
  const { resume, setResume } = useResumeParam();

  const [selected, setSelected] = useState<string | null>(() => getSelectedSession());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [resumeFallback, setResumeFallback] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (loading) return;
    const nativeIds = new Set(sessions.map((s) => s.session_id));

    if (resume) {
      if (nativeIds.has(resume)) {
        setSelected(resume);
        setSelectedSession(resume);
        setResumeFallback(null);
        return;
      }
      setResumeFallback(resume);
      setSelected(null);
      setSelectedSession(null);
      return;
    }

    if (selected && nativeIds.has(selected)) return;
    const prev = getSelectedSession();
    if (prev && nativeIds.has(prev)) {
      setSelected(prev);
      return;
    }
    if (sessions.length > 0) {
      setSelected(sessions[0].session_id);
      setSelectedSession(sessions[0].session_id);
    } else {
      setSelected(null);
    }
  }, [loading, sessions, resume, selected]);

  const activeSession: SessionInfo | undefined = useMemo(
    () => sessions.find((s) => s.session_id === selected),
    [sessions, selected],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelected(id);
      setSelectedSession(id);
      setResume(id);
      setResumeFallback(null);
    },
    [setResume],
  );

  const handleCreate = useCallback(
    async (name?: string) => {
      const s = await createSession(name);
      if (s) handleSelect(s.session_id);
    },
    [createSession, handleSelect],
  );

  const { state, store, runtime, conn } = useSessionRuntime(
    client,
    selected,
    !!activeSession?.archived,
  );

  useEffect(() => {
    if (state.resyncing) refresh();
  }, [state.resyncing, refresh]);

  const pending = useMemo(() => pendingApprovals(state), [state]);
  const resolved = useMemo(() => recentlyResolved(state), [state]);

  const handleApproval = useCallback(
    async (toolCallId: string, decision: ApprovalDecision) => {
      if (!selected) return;
      await client.respondToApproval(selected, toolCallId, decision);
    },
    [client, selected],
  );

  const errorMsg = sessionsError || state.errorBanner;

  // The dashboard's route wrapper only constrains height for `/chat` and
  // `/docs`. For other plugin routes it grows with content, so we own
  // height/overflow ourselves: `absolute inset-0` fills the
  // relatively-positioned page container, and the inner Thread is the
  // sole scroller.
  return (
    <div className={cn("absolute inset-0 flex flex-col min-h-0")}>
      <header
        className={cn(
          "flex items-center justify-between gap-3 border-b border-midground/20 px-4 py-2",
        )}
      >
        <div className={cn("flex items-baseline gap-3")}>
          <h1 className={cn("font-mondwest text-base tracking-[0.08em]")}>
            Open Chat Session
          </h1>
          {activeSession && (
            <span className={cn("text-xs text-midground/60")}>
              {activeSession.name} · seq {activeSession.tip_seq ?? 0}
            </span>
          )}
        </div>
        <ConnectionPill conn={conn} platform={health?.platform} />
      </header>

      <div className={cn("flex min-h-0 flex-1")}>
        <SessionSidebar
          sessions={sessions}
          selectedId={selected}
          onSelect={handleSelect}
          onCreate={handleCreate}
          loading={loading}
          error={sessionsError}
        />

        <main className={cn("flex min-w-0 min-h-0 flex-1 flex-col")}>
          {resumeFallback && (
            <Banner
              tone="amber"
              message="That session isn't a native gateway session."
              detail={`?resume=${resumeFallback} doesn't match any /sessions entry. Pick a session in the sidebar, or open it via stock /chat or 'hermes --tui'.`}
            />
          )}
          {activeSession?.archived && (
            <Banner tone="midground" message="this session is archived — read-only" />
          )}
          {state.resyncing && (
            <Banner tone="amber" message="stream re-synced — buffer cleared" />
          )}
          {errorMsg && (
            <Banner
              tone="rose"
              message={errorMsg}
              onDismiss={state.errorBanner ? () => store.setError(null) : undefined}
            />
          )}

          {selected ? (
            <AssistantRuntimeProvider runtime={runtime}>
              <ChatThread
                sessionId={selected}
                attachments={state.attachments}
                pendingApprovalCount={pending.length}
                emptyHint={
                  conn.kind === "connecting"
                    ? "Loading history…"
                    : "No messages yet. Send something below."
                }
              />
              <Composer
                placeholder={
                  !selected
                    ? "Pick a session"
                    : activeSession?.archived
                    ? "Archived session — read-only"
                    : conn.kind !== "connected"
                      ? "Waiting for connection…"
                      : "Message…"
                }
              />
            </AssistantRuntimeProvider>
          ) : (
            <div
              className={cn("flex flex-1 items-center justify-center text-sm text-midground/60")}
            >
              {sessions.length === 0
                ? "No sessions yet. Create one in the sidebar."
                : "Pick a session in the sidebar."}
            </div>
          )}
        </main>

        <ApprovalPanel
          pending={pending}
          recentlyResolved={resolved}
          onDecide={handleApproval}
          disabled={!selected}
        />
      </div>
    </div>
  );
}

export default ChatPage;
