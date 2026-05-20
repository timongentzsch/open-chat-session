import { React, cn } from "@/sdk";
import {
  ActionBarPrimitive,
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
  type AssistantState,
  type EnrichedPartState,
  type MessageState,
} from "@assistant-ui/react";
import type { ApprovalDecision, AttachmentRef } from "@/types";
import { AttachmentChip } from "@/components/AttachmentChip";
import { MarkdownText } from "@/components/MarkdownText";
import { BUBBLE_AND_SPACING_CSS } from "@/chat-styles";
import type { ApprovalView, ClarifyView, OurMessage } from "@/runtime/session-store";
import { DownIcon, ReplyIcon, CopyIcon, CheckIcon } from "@/components/icons";
import { previewText } from "@/lib/preview";
import { actionButton, DECISION_LABEL, DECISION_TONE } from "@/ui";

const DEFAULT_EMPTY_HINT = "No messages yet. Send something below.";
const TYPING_DOT_DELAYS_MS = [0, 120, 240];

// Shared style for the small bubble action-bar buttons (copy / reply).
const BUBBLE_ACTION_CLASS =
  "flex items-center justify-center border border-midground/25 bg-background text-midground/70 shadow transition hover:text-foreground";
const BUBBLE_ACTION_STYLE = { width: "1.5rem", height: "1.5rem" } as const;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric",
});
function formatMessageTime(d: Date): string {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? TIME_FMT.format(d) : `${DATE_FMT.format(d)} · ${TIME_FMT.format(d)}`;
}

export interface ChatThreadProps {
  sessionId: string;
  attachments: Record<string, AttachmentRef[]>;
  messages: OurMessage[];
  /** Pending approvals — rendered as bubbles at the end of the thread. */
  pendingApprovals?: ApprovalView[];
  onApprovalDecide?: (toolCallId: string, decision: ApprovalDecision) => Promise<void>;
  /** Pending clarify prompts — rendered as bubbles with choice buttons. */
  pendingClarifies?: ClarifyView[];
  onClarifyRespond?: (choice: string) => Promise<void>;
  onReply?: (messageId: string) => void;
  showTyping?: boolean;
  emptyHint?: string;
  footer?: React.ReactNode;
}

function ToolFallbackPart({ part }: { part: Extract<EnrichedPartState, { type: "tool-call" }> }) {
  const status = part.status?.type ?? "complete";
  const statusLabel =
    status === "running" ? "running…" :
    status === "incomplete" ? "cancelled" :
    status === "requires-action" ? "needs action" : "done";
  return (
    <details
      data-aui-ocs-tool
      className="my-1 border border-midground/25 bg-foreground/5 text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-midground/80 hover:text-foreground">
        <span className="font-mondwest tracking-[0.06em] uppercase text-[10px] text-midground/60">tool</span>
        <span className="font-medium text-foreground">{part.toolName}</span>
        <span className="ml-auto text-[10px] text-midground/60">{statusLabel}</span>
      </summary>
      {part.argsText && (
        <pre className="mx-2 mt-1 overflow-x-auto whitespace-pre-wrap break-words border-t border-midground/20 pt-1 text-[11px] text-foreground/80">
          {part.argsText}
        </pre>
      )}
      {part.result !== undefined && (
        <pre className="mx-2 mt-1 overflow-x-auto whitespace-pre-wrap break-words border-t border-dashed border-midground/20 pt-1 text-[11px] text-foreground/80">
          {typeof part.result === "string" ? part.result : JSON.stringify(part.result, null, 2)}
        </pre>
      )}
    </details>
  );
}

export function ChatThread({
  sessionId,
  attachments,
  messages,
  pendingApprovals,
  onApprovalDecide,
  pendingClarifies,
  onClarifyRespond,
  onReply,
  showTyping = false,
  emptyHint,
  footer,
}: ChatThreadProps) {
  const pendingList = pendingApprovals ?? [];
  const clarifyList = pendingClarifies ?? [];
  const messagesById = React.useMemo(
    () => Object.fromEntries(messages.map((m) => [m.id, m])),
    [messages],
  );
  const previousMessageById = React.useMemo(
    () => Object.fromEntries(messages.map((m, i) => [m.id, messages[i - 1]?.id])),
    [messages],
  );

  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <style precedence="default">{BUBBLE_AND_SPACING_CSS}</style>
      <ThreadPrimitive.Viewport
        autoScroll
        scrollToBottomOnRunStart={false}
        data-aui-ocs-thread-viewport
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4"
      >
        <AuiIf condition={(s: AssistantState) => s.thread.isEmpty}>
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-midground/60">
            {emptyHint ?? DEFAULT_EMPTY_HINT}
          </div>
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }: { message: MessageState }) => (
            <Bubble
              sessionId={sessionId}
              attachments={attachments}
              messagesById={messagesById}
              previousMessageById={previousMessageById}
              role={message.role === "user" ? "user" : "assistant"}
              onReply={onReply}
            />
          )}
        </ThreadPrimitive.Messages>
        {onApprovalDecide && pendingList.map((a) => (
          <ApprovalBubble key={a.tool_call_id} approval={a} onDecide={onApprovalDecide} />
        ))}
        {onClarifyRespond && clarifyList.map((c) => (
          <ClarifyBubble key={c.clarify_id} clarify={c} onRespond={onClarifyRespond} />
        ))}
        {showTyping && pendingList.length === 0 && clarifyList.length === 0 && (
          <TypingIndicator />
        )}
      </ThreadPrimitive.Viewport>
      {footer && (
        <div data-aui-ocs-footer className="relative shrink-0 bg-background">
          <ThreadPrimitive.ScrollToBottom
            data-aui-ocs-control
            behavior="smooth"
            className="ocs-scroll-bottom absolute right-4 bottom-full z-10 mb-2 flex h-8 w-8 items-center justify-center border border-midground/30 bg-background text-midground/80 shadow hover:text-foreground"
            aria-label="scroll to bottom"
            title="scroll to bottom"
          >
            <DownIcon />
          </ThreadPrimitive.ScrollToBottom>
          {footer}
        </div>
      )}
    </ThreadPrimitive.Root>
  );
}

interface BubbleProps {
  sessionId: string;
  attachments: Record<string, AttachmentRef[]>;
  messagesById: Record<string, OurMessage>;
  previousMessageById: Record<string, string | undefined>;
  role: "user" | "assistant";
  onReply?: (messageId: string) => void;
}

function ApprovalBubble({
  approval,
  onDecide,
}: {
  approval: ApprovalView;
  onDecide: (toolCallId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<ApprovalDecision | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
          <button
            key={d}
            type="button"
            disabled={!!busy}
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
    </PendingActionBubble>
  );
}

function ClarifyBubble({
  clarify,
  onRespond,
}: {
  clarify: ClarifyView;
  onRespond: (choice: string) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);

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
            <button
              key={choice}
              type="button"
              disabled={!!busy}
              onClick={() => pick(choice)}
              className={cn(
                actionButton,
                "h-8 justify-start px-2 text-[11px] border-midground/40 hover:bg-foreground/5",
                busy === choice && "opacity-60",
                busy && busy !== choice && "opacity-40",
              )}
            >
              {choice}
            </button>
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

function Bubble({ sessionId, attachments, messagesById, previousMessageById, role, onReply }: BubbleProps) {
  const message = useMessage();
  const { id } = message;
  const meta = messagesById[id];
  const replyTarget = meta?.replyTo ? messagesById[meta.replyTo] : undefined;
  const showReplyContext = !!replyTarget && previousMessageById[id] !== meta?.replyTo;
  const chips = attachments[id] ?? [];
  const isUser = role === "user";
  const hasText = (message.content ?? []).some((p) =>
    p.type === "text" && p.text.trim().length > 0
  );

  // Suppress the empty placeholder bubble assistant-ui creates while the run
  // is in flight but no content has arrived yet. The typing indicator below
  // already covers that state — an empty bubble on top is noise.
  const hasContent = (message.content ?? []).some((p) => {
    if (p.type === "text") return p.text.trim().length > 0;
    return true;
  });
  if (!hasContent && chips.length === 0) return null;

  return (
    <MessagePrimitive.Root
      data-aui-role={role}
      className={cn("flex flex-col first:mt-0", isUser ? "items-end" : "items-start")}
    >
      <div className={cn("relative flex max-w-[80%] flex-col", isUser ? "items-end" : "items-start")}>
        {showReplyContext && (
          <div
            data-aui-ocs-reply-context
            className={cn(
              "mb-1 flex max-w-full items-center gap-2 px-1 text-[11px] text-midground/60",
              isUser ? "justify-end text-right" : "justify-start",
            )}
          >
            <span className="h-4 w-4 shrink-0 border-l border-t border-midground/30" />
            <span className="truncate">
              replying to {replyTarget.role}: {previewText(replyTarget.content)}
            </span>
          </div>
        )}
        <div
          data-aui-ocs-bubble
          data-aui-ocs-replyable={onReply ? "" : undefined}
          className={cn(
            "relative w-fit max-w-full px-3 py-2 text-sm break-words text-foreground",
          )}
        >
          <ActionBarPrimitive.Root
            autohide="always"
            autohideFloat="always"
            className="z-10 flex items-center gap-1"
            style={{
              position: "absolute",
              top: "0.25rem",
              right: "0.25rem",
            }}
          >
            <ActionBarPrimitive.Copy
              data-aui-ocs-control
              data-aui-ocs-reply-button
              className={BUBBLE_ACTION_CLASS}
              style={BUBBLE_ACTION_STYLE}
              aria-label="copy"
              title="copy message"
            >
              <MessagePrimitive.If copied>
                <CheckIcon />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <CopyIcon />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
            {onReply && (
              <button
                data-aui-ocs-control
                data-aui-ocs-reply-button
                type="button"
                onClick={() => onReply(id)}
                className={BUBBLE_ACTION_CLASS}
                style={BUBBLE_ACTION_STYLE}
                aria-label="reply"
                title="reply"
              >
                <ReplyIcon />
              </button>
            )}
          </ActionBarPrimitive.Root>
          <MessagePrimitive.Parts>
            {({ part }: { part: EnrichedPartState }) => {
              if (part.type === "text") return <MarkdownText />;
              if (part.type === "tool-call") return <ToolFallbackPart part={part} />;
              return null;
            }}
          </MessagePrimitive.Parts>
          {chips.length > 0 && (
            <div
              data-aui-ocs-attachments
              className={cn("flex flex-wrap gap-1.5", hasText && "mt-2")}
            >
              {chips.map((a) => (
                <AttachmentChip key={a.attachment_id} attachment={a} sessionId={sessionId} inline />
              ))}
            </div>
          )}
        </div>
      </div>
      {message.createdAt && (
        <span className={cn("mt-0.5 text-[10px] tracking-[0.06em] text-midground/50 px-1")}>
          {formatMessageTime(message.createdAt)}
        </span>
      )}
    </MessagePrimitive.Root>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 self-start px-1 text-midground/60">
      {TYPING_DOT_DELAYS_MS.map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-pulse bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
      <span className="ml-1 text-[10px] uppercase tracking-[0.12em]">typing</span>
    </div>
  );
}
