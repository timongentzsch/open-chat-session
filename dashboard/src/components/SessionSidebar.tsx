import { React, useState, cn, timeAgo } from "@/sdk";
import type { SessionInfo } from "@/types";
import { actionButton, fieldBase, iconButton, panelTitle } from "@/ui";

export interface SessionSidebarProps {
  sessions: SessionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name?: string) => void;
  loading?: boolean;
  error?: string | null;
}

export function SessionSidebar({
  sessions,
  selectedId,
  onSelect,
  onCreate,
  loading,
  error,
}: SessionSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  return (
    <aside
      className={cn(
        "flex w-64 shrink-0 flex-col gap-2 border-r border-midground/20 bg-foreground/[0.02] p-3",
      )}
    >
      <div className={cn("flex h-9 items-center justify-between")}>
        <h2 className={cn(panelTitle)}>Sessions</h2>
        <button
          type="button"
          className={cn(iconButton)}
          onClick={() => setCreating((v: boolean) => !v)}
          aria-label="New session"
          title="New session"
        >
          +
        </button>
      </div>

      {creating && (
        <form
          className={cn("flex items-center gap-1")}
          onSubmit={(e: React.FormEvent) => {
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
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
          />
          <button
            type="submit"
            className={cn(actionButton, "h-8 border-foreground/40 px-2 text-foreground hover:bg-foreground/10")}
          >
            ok
          </button>
        </form>
      )}

      {error && (
        <div className={cn("rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-400")}>
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
                type="button"
                onClick={() => onSelect(s.session_id)}
                className={cn(
                  "w-full rounded px-2 py-1.5 text-left text-xs",
                  active
                    ? "bg-foreground/10 text-foreground"
                    : "text-midground/80 hover:bg-foreground/5",
                )}
              >
                <div className={cn("truncate font-medium")}>{s.name || "Untitled"}</div>
                <div className={cn("text-[10px] text-midground/50")}>
                  {(s.event_count ?? s.tip_seq ?? 0)} ev · {s.created_at ? timeAgo(s.created_at) : ""}
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
