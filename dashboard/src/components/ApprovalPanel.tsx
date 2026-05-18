import { React, useState, useEffect, cn } from "@/sdk";
import type { ApprovalView } from "@/runtime/session-store";
import type { ApprovalDecision } from "@/types";
import { actionButton, panelTitle } from "@/ui";
import { APPROVAL_CSS } from "@/chat-styles";

export interface ApprovalPanelProps {
  pending: ApprovalView[];
  recentlyResolved: ApprovalView[];
  onDecide: (toolCallId: string, decision: ApprovalDecision) => Promise<void>;
  disabled?: boolean;
}

// hover:bg-rose-500/10 and hover:bg-emerald-500/10 are absent from host CSS.
// Use hover:bg-warning/10 and hover:bg-destructive/10 which do exist,
// and text-emerald-300/text-rose-300 stay as-is (present in host CSS).
const DECISION_TONE: Record<ApprovalDecision, string> = {
  once: "border-emerald-500/50 text-emerald-300 hover:bg-success/10",
  session: "border-emerald-500/40 text-emerald-300 hover:bg-success/10",
  always: "border-emerald-500/30 text-emerald-300 hover:bg-success/10",
  deny: "border-rose-500/50 text-destructive hover:bg-destructive/10",
};

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  once: "Allow once",
  session: "Allow this session",
  always: "Always allow",
  deny: "Deny",
};

export function ApprovalPanel({
  pending,
  recentlyResolved,
  onDecide,
  disabled,
}: ApprovalPanelProps) {
  if (pending.length === 0 && recentlyResolved.length === 0) return null;
  return (
    <aside
      className={cn(
        "flex w-80 shrink-0 flex-col gap-3 border-l border-midground/20 bg-foreground/20 p-3 overflow-y-auto",
      )}
      aria-label="Tool approvals"
    >
      <style precedence="default">{APPROVAL_CSS}</style>
      <h2 className={cn(panelTitle)}>Approvals</h2>
      {pending.map((a) => (
        <PendingCard key={a.tool_call_id} approval={a} onDecide={onDecide} disabled={disabled} />
      ))}
      {recentlyResolved.map((a) => (
        <ResolvedCard key={a.tool_call_id} approval={a} />
      ))}
    </aside>
  );
}

function PendingCard({
  approval,
  onDecide,
  disabled,
}: {
  approval: ApprovalView;
  onDecide: (id: string, d: ApprovalDecision) => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const hasExpiry = approval.expires_at > 0;
  useEffect(() => {
    if (!hasExpiry) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasExpiry]);
  const expiresIn = Math.max(0, Math.round((approval.expires_at - Date.now()) / 1000));

  const decide = async (d: ApprovalDecision) => {
    setBusy(d);
    setError(null);
    try {
      await onDecide(approval.tool_call_id, d);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      setError(
        msg.includes("already_resolved")
          ? "Already resolved by another device"
          : msg,
      );
      setBusy(null);
    }
  };

  return (
    <div
      data-aui-ocs-card="pending"
      className={cn(
        "flex flex-col gap-2 rounded border border-amber-500/40 p-2",
      )}
    >
      <div className={cn("flex items-center justify-between gap-2")}>
        <span className={cn("font-mondwest text-xs uppercase tracking-[0.1em] text-warning")}>
          {approval.tool_name || "tool"}
        </span>
        {approval.expires_at > 0 && (
          <span className={cn("text-[10px] text-midground/60")} title="time until auto-deny">
            {expiresIn > 0 ? `${expiresIn}s` : "expired"}
          </span>
        )}
      </div>
      <p className={cn("text-xs text-foreground whitespace-pre-wrap break-words")}>
        {approval.prompt}
      </p>
      {approval.command && (
        <pre
          data-aui-ocs-card="resolved-allowed"
          className={cn(
            "max-h-32 overflow-y-auto rounded p-1.5 text-[11px] text-midground/80 whitespace-pre-wrap break-all",
          )}
        >
          {approval.command}
        </pre>
      )}
      {error && (
        <div className={cn("rounded border border-rose-500/40 px-2 py-1 text-[11px] text-destructive")}>
          {error}
        </div>
      )}
      <div className={cn("grid grid-cols-2 gap-1")}>
        {approval.choices.map((d) => (
          <button
            key={d}
            type="button"
            disabled={!!busy || !!disabled}
            onClick={() => decide(d)}
            className={cn(
              actionButton,
              "h-8 px-2 text-[11px]",
              DECISION_TONE[d],
              busy === d && "opacity-60",
              busy && busy !== d && "opacity-40",
            )}
          >
            {DECISION_LABEL[d] ?? d}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResolvedCard({ approval }: { approval: ApprovalView }) {
  const r = approval.resolution;
  if (!r) return null;
  const denied = r.decision === "deny";
  return (
    <div
      data-aui-ocs-card={denied ? "resolved-denied" : "resolved-allowed"}
      className={cn(
        "flex flex-col gap-1 rounded border px-2 py-1.5 text-[11px]",
        denied
          ? "border-rose-500/30 text-destructive/90"
          : "border-emerald-500/30 text-emerald-300/90",
      )}
    >
      <span className={cn("font-mondwest uppercase tracking-[0.1em]")}>
        {approval.tool_name || "tool"}
      </span>
      <span>
        {DECISION_LABEL[r.decision] ?? r.decision} · {r.resolved_by}
      </span>
    </div>
  );
}
