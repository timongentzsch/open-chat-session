import { React, cn, useState } from "@/sdk";
// Required in scope by the classic JSX transform (vite.config.ts).
void React;
import type { SessionInfo } from "@/types";
import {
  actionButton,
  bubbleActionClass,
  bubbleActionStyle,
  fieldBase,
  iconButton,
  panelTitle,
} from "@/ui";
import { RELATIVE_TIME_BUCKETS } from "@/constants";
import { SURFACE_CSS } from "@/chat-styles";
import { RemoveIcon } from "@/components/icons";

// Scoped hover-reveal for the per-row archive button. Host Tailwind doesn't
// reliably emit `group`/`group-hover:*` utilities for plugin source, so we
// inline a plain CSS rule. Keyboard-focus also reveals the button so it
// remains discoverable without a pointer.
const SESSION_ROW_CSS = `
[data-aui-ocs-session-row] [data-aui-ocs-session-archive] {
  opacity: 0;
  transition: opacity 0.1s ease-in-out;
}
[data-aui-ocs-session-row]:hover [data-aui-ocs-session-archive],
[data-aui-ocs-session-row]:focus-within [data-aui-ocs-session-archive] {
  opacity: 1;
}
`;

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
  /** DELETE /sessions/{id} (soft archive). Hidden when not provided. */
  onArchive?: (id: string) => void;
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
  onArchive,
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
      className="flex h-full w-64 shrink-0 flex-col gap-2 border-r border-midground/20 p-3"
    >
      <style href="ocs-style-surface" precedence="default">{SURFACE_CSS}</style>
      <style href="ocs-style-session-row" precedence="default">{SESSION_ROW_CSS}</style>
      <div className="flex h-9 items-center justify-between">
        <h2 className={panelTitle}>Sessions</h2>
        <div className="flex items-center gap-1">
          <button
            data-aui-ocs-control
            type="button"
            className={iconButton}
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
              className={iconButton}
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
          className="flex items-center gap-1"
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
        <div className="border border-destructive/40 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="px-2 py-1 text-xs text-midground/60">loading…</div>
      )}

      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {sessions.map((s) => {
          const active = s.session_id === selectedId;
          return (
            <li
              key={s.session_id}
              data-aui-ocs-session-row={active ? "active" : "idle"}
              className={cn(
                "relative",
                active ? "text-foreground" : "text-midground/80",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(s.session_id)}
                className="block w-full px-2 py-1.5 pr-8 text-left text-xs"
              >
                <div className="truncate font-medium">{s.name || "Untitled"}</div>
                <div className="text-[10px] text-midground/50">
                  {(s.event_count ?? s.tip_seq ?? 0)} ev · {s.created_at ? formatRelative(s.created_at) : ""}
                </div>
              </button>
              {onArchive && (
                <button
                  data-aui-ocs-session-archive
                  data-aui-ocs-control
                  type="button"
                  onClick={() => onArchive(s.session_id)}
                  className={cn(bubbleActionClass, "z-10")}
                  style={{
                    ...bubbleActionStyle,
                    position: "absolute",
                    top: "0.25rem",
                    right: "0.25rem",
                  }}
                  aria-label={`archive ${s.name || s.session_id}`}
                  title="archive session"
                >
                  <RemoveIcon />
                </button>
              )}
            </li>
          );
        })}
        {!loading && sessions.length === 0 && (
          <li className="px-2 py-1 text-xs text-midground/50">no sessions yet</li>
        )}
      </ul>
    </aside>
  );
}
