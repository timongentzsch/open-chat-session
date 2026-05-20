import { React, useState, cn } from "@/sdk";
import type { SessionInfo } from "@/types";
import { actionButton, fieldBase, iconButton, panelTitle } from "@/ui";
import { RELATIVE_TIME_BUCKETS } from "@/constants";
import { SURFACE_CSS } from "@/chat-styles";

// Host SDK's `timeAgo` returns "just now" for every timestamp regardless of
// age (verified empirically). Local fallback until that's fixed upstream.
function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < RELATIVE_TIME_BUCKETS.MINUTE_MS) return "just now";
  const m = Math.floor(diff / RELATIVE_TIME_BUCKETS.MINUTE_MS);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(diff / RELATIVE_TIME_BUCKETS.HOUR_MS);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(diff / RELATIVE_TIME_BUCKETS.DAY_MS);
  if (d < 14) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface SessionSidebarProps {
  sessions: SessionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name?: string) => void;
  loading?: boolean;
  error?: string | null;
  /** Open state for the mobile drawer (ignored at md+). */
  mobileOpen?: boolean;
  /** Called when the user dismisses the mobile drawer. */
  onClose?: () => void;
}

export function SessionSidebar({
  sessions,
  selectedId,
  onSelect,
  onCreate,
  loading,
  error,
  mobileOpen = false,
  onClose,
}: SessionSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  return (
    <aside
      data-aui-ocs-panel="sessions"
      data-aui-ocs-sidebar
      data-aui-ocs-surface="dim"
      data-open={mobileOpen ? "true" : "false"}
      id="ocs-session-sidebar"
      aria-label="Sessions"
      className={cn(
        "flex h-full w-64 shrink-0 flex-col gap-2 border-r border-midground/20 p-3",
      )}
    >
      <style precedence="default">{SURFACE_CSS}</style>
      <div className={cn("flex h-9 items-center justify-between")}>
        <h2 className={cn(panelTitle)}>Sessions</h2>
        <div className={cn("flex items-center gap-1")}>
          <button
            data-aui-ocs-control
            type="button"
            className={cn(iconButton)}
            onClick={() => setCreating((v: boolean) => !v)}
            aria-label="New session"
            title="New session"
          >
            +
          </button>
          {onClose && (
            <button
              data-aui-ocs-control
              data-aui-ocs-mobile-only
              type="button"
              className={cn(iconButton)}
              onClick={onClose}
              aria-label="Close sessions"
              title="Close sessions"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {creating && (
        <form
          className={cn("flex items-center gap-1")}
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            onCreate(name || undefined);
            setNewName("");
            setCreating(false);
          }}
        >
          <input
            autoFocus
            className={cn(fieldBase, "h-8 flex-1 text-xs")}
            placeholder="session name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            data-aui-ocs-control
            type="submit"
            className={cn(actionButton, "h-8 border-foreground/40 px-2 text-foreground hover:bg-foreground/20")}
          >
            ok
          </button>
        </form>
      )}

      {error && (
        <div className={cn("border border-destructive/40 px-2 py-1 text-xs text-destructive")}>
          {error}
        </div>
      )}

      {loading && (
        <div className={cn("px-2 py-1 text-xs text-midground/60")}>loading…</div>
      )}

      <ul className={cn("flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto")}>
        {sessions.map((s) => {
          const active = s.session_id === selectedId;
          return (
            <li key={s.session_id}>
              <button
                data-aui-ocs-session-row={active ? "active" : "idle"}
                type="button"
                onClick={() => onSelect(s.session_id)}
                className={cn(
                  "w-full px-2 py-1.5 text-left text-xs",
                  active
                    ? "bg-foreground/20 text-foreground"
                    : "text-midground/80 hover:bg-foreground/2",
                )}
              >
                <div className={cn("truncate font-medium")}>{s.name || "Untitled"}</div>
                <div className={cn("text-[10px] text-midground/50")}>
                  {(s.event_count ?? s.tip_seq ?? 0)} ev · {s.created_at ? formatRelative(s.created_at) : ""}
                </div>
              </button>
            </li>
          );
        })}
        {!loading && sessions.length === 0 && (
          <li className={cn("px-2 py-1 text-xs text-midground/50")}>no sessions yet</li>
        )}
      </ul>
    </aside>
  );
}
