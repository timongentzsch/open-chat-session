import { React, cn } from "@/sdk";
import {
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
  type AssistantState,
  type EnrichedPartState,
  type MessageState,
} from "@assistant-ui/react";
import type { AttachmentRef } from "@/types";
import { AttachmentChip } from "@/components/AttachmentChip";
import { MarkdownText } from "@/components/MarkdownText";
import { BUBBLE_AND_SPACING_CSS } from "@/chat-styles";

const DEFAULT_EMPTY_HINT = "No messages yet. Send something below.";
const TYPING_DOT_DELAYS_MS = [0, 120, 240];

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
  pendingApprovalCount: number;
  emptyHint?: string;
  footer?: React.ReactNode;
}

function DownIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

export function ChatThread({ sessionId, attachments, pendingApprovalCount: pending, emptyHint, footer }: ChatThreadProps) {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <style precedence="default">{BUBBLE_AND_SPACING_CSS}</style>
      <ThreadPrimitive.Viewport
        autoScroll
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4"
      >
        {pending > 0 && (
          <div className="self-center rounded border border-amber-500/40 bg-warning/10 px-3 py-1 text-[11px] text-warning">
            {`${pending} tool approval${pending === 1 ? "" : "s"} waiting`}
          </div>
        )}
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
              role={message.role === "user" ? "user" : "assistant"}
            />
          )}
        </ThreadPrimitive.Messages>
        <AuiIf condition={(s: AssistantState) => s.thread.isRunning}>
          <TypingIndicator />
        </AuiIf>
      </ThreadPrimitive.Viewport>
      {footer && (
        <div className="relative shrink-0 bg-background">
          <ThreadPrimitive.ScrollToBottom
            behavior="smooth"
            className="ocs-scroll-bottom absolute right-4 bottom-full z-10 mb-2 flex h-8 w-8 items-center justify-center rounded-full border border-midground/30 bg-background text-midground/80 shadow hover:text-foreground"
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
  role: "user" | "assistant";
}

function Bubble({ sessionId, attachments, role }: BubbleProps) {
  const message = useMessage();
  const { id } = message;
  const chips = attachments[id] ?? [];
  const isUser = role === "user";

  // Suppress the empty placeholder bubble assistant-ui creates while the run
  // is in flight but no content has arrived yet. The typing indicator below
  // already covers that state — an empty bubble on top is noise.
  const hasContent = (message.content ?? []).some((p) => {
    if (p.type === "text") return ((p as { text?: string }).text ?? "").trim().length > 0;
    return true;
  });
  if (!hasContent && chips.length === 0) return null;

  return (
    <MessagePrimitive.Root
      data-aui-role={role}
      className={cn("flex flex-col first:mt-0", isUser ? "items-end" : "items-start")}
    >
      <div className={cn(
        "max-w-[80%] rounded-md px-3 py-2 text-sm break-words text-foreground",
      )}>
        <MessagePrimitive.Parts>
          {({ part }: { part: EnrichedPartState }) => (part.type === "text" ? <MarkdownText /> : null)}
        </MessagePrimitive.Parts>
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((a) => (
              <AttachmentChip key={a.attachment_id} attachment={a} sessionId={sessionId} inline />
            ))}
          </div>
        )}
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
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
      <span className="ml-1 text-[10px] uppercase tracking-[0.12em]">typing</span>
    </div>
  );
}
