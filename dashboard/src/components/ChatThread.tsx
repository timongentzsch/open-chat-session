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

const DEFAULT_EMPTY_HINT = "No messages yet. Send something below.";
const TYPING_DOT_DELAYS_MS = [0, 120, 240];

// Tighten the gap between consecutive messages from the same role. Done in
// CSS rather than JS because mutable closure state inside ThreadPrimitive.Messages
// desyncs on partial re-renders (e.g. assistant-ui's setIsHovering) and causes
// a visible vertical jump on hover.
const SAME_ROLE_TIGHTEN_CSS = `
[data-aui-role="user"] + [data-aui-role="user"],
[data-aui-role="assistant"] + [data-aui-role="assistant"] { margin-top: 0.25rem; }
`;

export interface ChatThreadProps {
  sessionId: string;
  attachments: Record<string, AttachmentRef[]>;
  pendingApprovalCount: number;
  emptyHint?: string;
}

export function ChatThread({ sessionId, attachments, pendingApprovalCount: pending, emptyHint }: ChatThreadProps) {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <style precedence="default">{SAME_ROLE_TIGHTEN_CSS}</style>
      <ThreadPrimitive.Viewport autoScroll className="flex flex-1 flex-col overflow-y-auto px-4 py-4">
        {pending > 0 && (
          <div className="self-center rounded border border-amber-500/40 bg-amber-500/[0.06] px-3 py-1 text-[11px] text-amber-300">
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
    </ThreadPrimitive.Root>
  );
}

interface BubbleProps {
  sessionId: string;
  attachments: Record<string, AttachmentRef[]>;
  role: "user" | "assistant";
}

function Bubble({ sessionId, attachments, role }: BubbleProps) {
  const { id } = useMessage();
  const chips = attachments[id] ?? [];
  const isUser = role === "user";
  return (
    <MessagePrimitive.Root
      data-aui-role={role}
      className={cn("flex flex-col mt-3 first:mt-0", isUser ? "items-end" : "items-start")}
    >
      <div className={cn(
        "max-w-[80%] rounded-md px-3 py-2 text-sm break-words text-foreground",
        isUser ? "bg-foreground/10" : "bg-foreground/[0.04]",
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
