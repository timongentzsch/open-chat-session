import { React, cn, useCallback, useEffect, useMemo, useRef, useState } from "@/sdk";
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
import { ApprovalBubble, ClarifyBubble } from "@/components/ApprovalPanel";
import { AttachmentChip } from "@/components/AttachmentChip";
import { MarkdownText } from "@/components/MarkdownText";
import type { ApprovalView, ClarifyView, OurMessage } from "@/runtime/session-store";
import { DownIcon, ReplyIcon, CopyIcon, CheckIcon } from "@/components/icons";
import { bubbleActionClass, bubbleActionStyle } from "@/ui";

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
  /** Ordered messages — used only to dedupe consecutive timestamps. */
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
  /** Older history exists above the loaded window (scroll-up paging). */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  /** Fetch + prepend the previous page; `beforePrepend` fires right before the
   *  prepend so we can snapshot scroll position to keep the viewport anchored. */
  onLoadOlder?: (beforePrepend: () => void) => void;
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
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: ChatThreadProps) {
  const pendingList = pendingApprovals ?? [];
  const clarifyList = pendingClarifies ?? [];

  // Show a message's time only when it differs from the previous message's
  // displayed time. Precomputed by id (render-stable, not closure state).
  const showTimeIds = useMemo(() => {
    const ids = new Set<string>();
    let prev: string | null = null;
    for (const m of messages) {
      const label = formatMessageTime(new Date(m.ts));
      if (label !== prev) { ids.add(m.id); prev = label; }
    }
    return ids;
  }, [messages]);

  // Own the button's visibility: assistant-ui's isAtBottom can go stale after a
  // late layout shift, so re-measure on scroll/resize/mutation with a tolerance.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const TOLERANCE_PX = 48;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setShowScrollButton(vp.scrollHeight - vp.clientHeight - vp.scrollTop > TOLERANCE_PX);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    vp.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(vp);
    const mo = new MutationObserver(schedule);
    mo.observe(vp, { childList: true, subtree: true });
    return () => {
      vp.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Prepend stability: pin the first visible message to its screen position
  // across the prepend by id + rect (native CSS scroll anchoring tracks DOM
  // nodes and assistant-ui recreates them on prepend, so it never engages).
  // The pin is corrected pre-paint in a layout effect and re-corrected on
  // every later reflow — async markdown/Shiki/media settling included — and
  // released only on real user scroll intent. A timed release here caused
  // the old "snap back": highlights settling after the timer shifted the
  // viewport with nothing left to re-pin it.
  const pendingAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const beforePrepend = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vpTop = vp.getBoundingClientRect().top;
    pendingAnchorRef.current = null;
    for (const el of vp.querySelectorAll<HTMLElement>("[data-aui-ocs-message-id]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vpTop + 1) {
        const id = el.getAttribute("data-aui-ocs-message-id");
        if (id) pendingAnchorRef.current = { id, top: r.top };
        break;
      }
    }
  }, []);

  React.useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const vp = viewportRef.current;
    if (!anchor || !vp) return;
    const correct = () => {
      const el = vp.querySelector<HTMLElement>(`[data-aui-ocs-message-id="${CSS.escape(anchor.id)}"]`);
      if (!el) return;
      const delta = el.getBoundingClientRect().top - anchor.top;
      if (delta) vp.scrollTop += delta;
    };
    correct(); // synchronous, before paint
    if (loadingOlder) return; // more pages still coming — keep the anchor
    // Re-pin on every reflow (sizes settling, late nodes) until the user
    // actually scrolls; pointerdown covers touch and scrollbar drags.
    const ro = new ResizeObserver(correct);
    const observeAll = () =>
      vp.querySelectorAll<HTMLElement>("[data-aui-ocs-message-id]").forEach((el) => ro.observe(el));
    observeAll();
    const mo = new MutationObserver(observeAll);
    mo.observe(vp, { childList: true, subtree: true });
    const release = () => {
      ro.disconnect();
      mo.disconnect();
      vp.removeEventListener("wheel", release);
      vp.removeEventListener("pointerdown", release);
      vp.removeEventListener("keydown", release);
      pendingAnchorRef.current = null;
    };
    vp.addEventListener("wheel", release, { passive: true });
    vp.addEventListener("pointerdown", release, { passive: true });
    vp.addEventListener("keydown", release);
    return release;
  }, [messages.length, loadingOlder]);

  // Explicit paging: a "load older" button is more predictable than a
  // scroll-position trigger (which was unreliable right after a reload), and
  // keeps the viewport anchored via beforePrepend.
  const handleLoadOlder = useCallback(() => {
    if (!onLoadOlder || loadingOlder) return;
    onLoadOlder(beforePrepend);
  }, [onLoadOlder, loadingOlder, beforePrepend]);

  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        autoScroll
        scrollToBottomOnRunStart={false}
        data-aui-ocs-thread-viewport
        // Disable native scroll anchoring so it can't fight the manual pin
        // on engines where it partially engages (no Tailwind utility for this).
        style={{ overflowAnchor: "none" }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4"
      >
        {hasOlder && (
          <div className="flex shrink-0 justify-center pb-3">
            <button
              data-aui-ocs-control
              type="button"
              onClick={handleLoadOlder}
              disabled={loadingOlder}
              className="border border-midground/30 bg-background px-3 py-1 font-mondwest text-[10px] uppercase tracking-[0.12em] text-midground/70 hover:text-foreground disabled:opacity-50"
            >
              {loadingOlder ? "loading…" : "load older messages"}
            </button>
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
              onReply={onReply}
              showTime={showTimeIds.has(message.id)}
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
          {showScrollButton && (
            <ThreadPrimitive.ScrollToBottom
              data-aui-ocs-control
              behavior="smooth"
              className="ocs-scroll-bottom absolute right-4 bottom-full z-10 mb-2 flex h-8 w-8 items-center justify-center border border-midground/30 bg-background text-midground/80 shadow hover:text-foreground"
              aria-label="scroll to bottom"
              title="scroll to bottom"
            >
              <DownIcon />
            </ThreadPrimitive.ScrollToBottom>
          )}
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
  onReply?: (messageId: string) => void;
  showTime?: boolean;
}

function Bubble({ sessionId, attachments, role, onReply, showTime = true }: BubbleProps) {
  const message = useMessage();
  const { id } = message;
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
      data-aui-ocs-message-id={id}
      className={cn("flex flex-col first:mt-0", isUser ? "items-end" : "items-start")}
    >
      <div className={cn("relative flex max-w-[80%] flex-col", isUser ? "items-end" : "items-start")}>
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
              className={bubbleActionClass}
              style={bubbleActionStyle}
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
                className={bubbleActionClass}
                style={bubbleActionStyle}
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
      {showTime && message.createdAt && (
        <span className="mt-0.5 text-[10px] tracking-[0.06em] text-midground/50 px-1">
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
