// `/chat-session` page: sessions sidebar, assistant-ui thread/composer,
// and the approval rail.

import { React, cn, useCallback, useEffect, useMemo, useState } from "@/sdk";
import { useGatewayClient } from "@/hooks/useGatewayClient";
import { useSessions } from "@/hooks/useSessions";
import { useResumeParam } from "@/hooks/useResumeParam";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ChatThread } from "@/components/ChatThread";
import { Composer } from "@/components/Composer";
import { Banner, ConnectionPill } from "@/components/StatusBanners";
import { PushPanel } from "@/components/PushPanel";
import { MenuIcon } from "@/components/icons";
import { PLUGIN_CURSOR_CSS, OCS_LAYOUT_CSS } from "@/chat-styles";
import {
  AssistantRuntimeProvider,
  useSessionRuntime,
} from "@/runtime/external-runtime";
import { pendingApprovals } from "@/runtime/session-store";
import { getSelectedSession, setSelectedSession } from "@/runtime/resume";
import type { ApprovalDecision, HealthResponse, SessionInfo } from "@/types";
import { HEALTH_POLL_MS } from "@/constants";

export function ChatPage() {
  const client = useGatewayClient();
  const { sessions, loading, error: sessionsError, refresh, createSession } =
    useSessions(client);
  const { resume, setResume } = useResumeParam();

  const [selected, setSelected] = useState<string | null>(() => getSelectedSession());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Close drawer on Escape and lock body scroll while open.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  // Close drawer once the layout switches to the permanent-sidebar mode.
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setSidebarOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const clearBadge = (navigator as Navigator & { clearAppBadge?: () => Promise<void> })
      .clearAppBadge;
    if (!clearBadge) return;
    const clear = () => { void clearBadge.call(navigator).catch(() => undefined); };
    clear();
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("focus", clear);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("focus", clear);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const h = await client.health();
        if (!cancelled) {
          setHealth(h);
          setHealthError(null);
        }
      } catch (exc) {
        if (!cancelled) {
          setHealth(null);
          setHealthError(exc instanceof Error ? exc.message : String(exc));
        }
      }
    }
    void check();
    const id = window.setInterval(check, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [client]);

  const nativeIds = useMemo(() => new Set(sessions.map((s) => s.session_id)), [sessions]);
  const resumeFallback = resume && !nativeIds.has(resume) ? resume : null;

  useEffect(() => {
    if (loading) return;

    if (resume) {
      if (nativeIds.has(resume)) {
        setSelected(resume);
        setSelectedSession(resume);
        return;
      }
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
  }, [loading, nativeIds, resume, selected]);

  const activeSession: SessionInfo | undefined = useMemo(
    () => sessions.find((s) => s.session_id === selected),
    [sessions, selected],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelected(id);
      setSelectedSession(id);
      setResume(id);
      setReplyTo(null);
      setSidebarOpen(false);
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

  const { state, store, runtime, conn, isTyping } = useSessionRuntime(
    client,
    selected,
    !!activeSession?.archived,
    replyTo,
    () => setReplyTo(null),
  );

  const replyTarget = useMemo(
    () => state.messages.find((m) => m.id === replyTo),
    [state.messages, replyTo],
  );

  useEffect(() => {
    if (state.resyncing) refresh();
  }, [state.resyncing, refresh]);

  const pending = useMemo(() => pendingApprovals(state), [state]);
  const pendingClarifies = useMemo(
    () => Object.values(state.clarifies).sort((a, b) => a.requested_at - b.requested_at),
    [state.clarifies],
  );

  const handleApproval = useCallback(
    async (toolCallId: string, decision: ApprovalDecision) => {
      if (!selected) return;
      await client.respondToApproval(selected, toolCallId, decision);
    },
    [client, selected],
  );

  // Click on a clarify choice → send it as a regular user message. The
  // gateway's _maybe_intercept_clarify_text resolves the clarify and
  // unblocks the agent thread. We also drain the stream so any subsequent
  // assistant events flow into the store.
  const handleClarifyRespond = useCallback(
    async (choice: string) => {
      if (!selected) return;
      const gen = client.sendMessage(selected, { text: choice });
      for await (const env of gen) {
        store.applyEvent(env);
      }
    },
    [client, selected, store],
  );

  const errorMsg = sessionsError || state.errorBanner;

  // The dashboard's route wrapper only constrains height for `/chat` and
  // `/docs`. For other plugin routes it grows with content, so we own
  // height/overflow ourselves: `absolute inset-0` fills the
  // relatively-positioned page container, and the inner Thread is the
  // sole scroller.
  return (
    <div data-aui-ocs-plugin className={cn("absolute inset-0 flex flex-col min-h-0")}>
      <style precedence="default">{PLUGIN_CURSOR_CSS}</style>
      <style precedence="default">{OCS_LAYOUT_CSS}</style>
      <header
        data-aui-ocs-header
        className={cn(
          "flex items-center justify-between gap-3 border-b border-midground/20 px-4 py-2",
        )}
      >
        <div className={cn("flex items-center gap-3 min-w-0")}>
          <button
            data-aui-ocs-control
            data-aui-ocs-mobile-only
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sessions"
            aria-controls="ocs-session-sidebar"
            aria-expanded={sidebarOpen}
            className={cn(
              "h-8 w-8 shrink-0 items-center justify-center border border-midground/25 text-midground/80 hover:text-foreground",
            )}
          >
            <MenuIcon />
          </button>
          {activeSession && (
            <h1 className={cn("font-mondwest text-sm tracking-[0.08em] truncate")}>
              {activeSession.name}
              <span className={cn("ml-2 text-xs text-midground/50")}>
                #{activeSession.tip_seq ?? 0}
              </span>
            </h1>
          )}
        </div>
        <div className={cn("flex items-center gap-3 shrink-0")}>
          <PushPanel />
          <ConnectionPill conn={conn} platform={health?.platform} healthError={healthError} />
        </div>
      </header>

      <div className={cn("relative flex min-h-0 flex-1")}>
        {sidebarOpen && (
          <button
            data-aui-ocs-backdrop
            type="button"
            aria-label="Close sessions"
            onClick={closeSidebar}
          />
        )}
        <SessionSidebar
          sessions={sessions}
          selectedId={selected}
          onSelect={handleSelect}
          onCreate={handleCreate}
          loading={loading}
          error={sessionsError}
          mobileOpen={sidebarOpen}
          onClose={closeSidebar}
        />

        <main className={cn("flex min-w-0 min-h-0 flex-1 flex-col")}>
          {resumeFallback && (
            <Banner
              tone="warning"
              message="That session isn't a native gateway session."
              detail={`?resume=${resumeFallback} doesn't match any /sessions entry. Pick a session in the sidebar, or open it via stock /chat or 'hermes --tui'.`}
            />
          )}
          {activeSession?.archived && (
            <Banner tone="midground" message="this session is archived — read-only" />
          )}
          {state.resyncing && (
            <Banner tone="warning" message="stream re-synced — buffer cleared" />
          )}
          {errorMsg && (
            <Banner
              tone="destructive"
              message={errorMsg}
              onDismiss={state.errorBanner ? () => store.setError(null) : undefined}
            />
          )}

          {selected ? (
            <AssistantRuntimeProvider runtime={runtime}>
              <ChatThread
                sessionId={selected}
                attachments={state.attachments}
                messages={state.messages}
                pendingApprovals={pending}
                onApprovalDecide={handleApproval}
                pendingClarifies={pendingClarifies}
                onClarifyRespond={handleClarifyRespond}
                onReply={setReplyTo}
                showTyping={isTyping}
                emptyHint={
                  conn.kind === "connecting"
                    ? "Loading history…"
                    : "No messages yet. Send something below."
                }
                footer={
                  <Composer
                    replyTarget={replyTarget}
                    onCancelReply={() => setReplyTo(null)}
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
      </div>
    </div>
  );
}

export default ChatPage;
