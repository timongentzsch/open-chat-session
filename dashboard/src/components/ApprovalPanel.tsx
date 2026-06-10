// Pending-action bubbles rendered at the tail of the thread: tool approvals
// (gateway.approval.request) and clarify prompts (gateway.clarify.request).

import { React, cn, useState } from "@/sdk";
import type { ApprovalDecision } from "@/types";
import type { ApprovalView, ClarifyView } from "@/runtime/session-store";
import { actionButton, DECISION } from "@/ui";

export function ApprovalBubble({
  approval,
  onDecide,
}: {
  approval: ApprovalView;
  onDecide: (toolCallId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (d: ApprovalDecision) => {
    setBusy(d);
    setError(null);
    try {
      await onDecide(approval.tool_call_id, d);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      setError(msg.includes("already_resolved") ? "Already resolved" : msg);
      setBusy(null);
    }
  };

  return (
    <PendingActionBubble title={`approve · ${approval.tool_name || "tool"}`}>
      {approval.prompt && (
        <p className="whitespace-pre-wrap break-words">{approval.prompt}</p>
      )}
      {approval.command && (
        <pre className="max-h-32 overflow-y-auto border border-midground/20 p-1.5 text-[11px] text-midground/80 whitespace-pre-wrap break-all">
          {approval.command}
        </pre>
      )}
      {error && (
        <div className="border border-destructive/40 px-2 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-1">
        {approval.choices.map((d) => (
          <ChoiceButton
            key={d}
            busy={busy}
            value={d}
            onPick={decide}
            className={DECISION[d]?.tone}
          >
            {DECISION[d]?.label ?? d}
          </ChoiceButton>
        ))}
      </div>
    </PendingActionBubble>
  );
}

export function ClarifyBubble({
  clarify,
  onRespond,
}: {
  clarify: ClarifyView;
  onRespond: (choice: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const pick = async (choice: string) => {
    setBusy(choice);
    try {
      await onRespond(choice);
    } catch {
      setBusy(null);
    }
  };

  return (
    <PendingActionBubble title="clarify">
      {clarify.question && (
        <p className="whitespace-pre-wrap break-words">{clarify.question}</p>
      )}
      {clarify.choices.length > 0 && (
        <div className="flex flex-col gap-1">
          {clarify.choices.map((choice) => (
            <ChoiceButton
              key={choice}
              busy={busy}
              value={choice}
              onPick={pick}
              className="justify-start border-midground/40 hover:bg-foreground/5"
            >
              {choice}
            </ChoiceButton>
          ))}
        </div>
      )}
      <span className="text-[10px] text-midground/60">
        {clarify.choices.length > 0
          ? "or type your own answer in the composer below"
          : "type your answer in the composer below"}
      </span>
    </PendingActionBubble>
  );
}

function ChoiceButton<T extends string>({
  busy,
  value,
  onPick,
  className,
  children,
}: {
  busy: T | null;
  value: T;
  onPick: (value: T) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={!!busy}
      onClick={() => onPick(value)}
      className={cn(
        actionButton,
        "h-8 px-2 text-[11px]",
        className,
        busy === value && "opacity-60",
        busy && busy !== value && "opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function PendingActionBubble({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-aui-role="assistant"
      data-aui-ocs-card="pending"
      className="flex flex-col items-start"
    >
      <div className="flex w-full max-w-[80%] flex-col gap-1.5 border border-warning/40 p-2 text-xs text-foreground">
        <span className="font-mondwest text-[10px] uppercase tracking-[0.1em] text-warning">
          {title}
        </span>
        {children}
      </div>
    </div>
  );
}
