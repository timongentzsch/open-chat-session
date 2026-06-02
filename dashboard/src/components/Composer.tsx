import { React, cn, useCallback, useEffect, useRef, useState } from "@/sdk";
// `React` is intentionally imported but unused at the top level — Vite's
// esbuild JSX transform compiles every <jsx /> to `React.createElement(...)`
// and needs that binding in scope. See vite.config.ts `esbuild.jsxFactory`.
void React;
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  unstable_useTriggerPopoverScopeContext,
  unstable_useSlashCommandAdapter,
  useAui,
} from "@assistant-ui/react";
import type { Unstable_TriggerItem } from "@assistant-ui/core";
import { controlBase, fieldBase, iconButton, smallIconControl } from "@/ui";
import { SLASH_ITEM_CSS, COMPOSER_CSS, SURFACE_CSS } from "@/chat-styles";
import type { OurMessage } from "@/runtime/session-store";
import type { GatewayClient } from "@/gateway-client";
import { useAtCompletions } from "@/hooks/useAtCompletions";
import { PaperclipIcon, RemoveIcon, MicIcon, StopRecordIcon, SendIcon } from "@/components/icons";
import { previewText } from "@/lib/preview";

const SLASH_COMMANDS = [
  ["usage", "Show token usage and rate limits"],
  ["sessions", "Browse and resume sessions"],
  ["sethome", "Set this chat as the home channel"],
  ["whoami", "Show command access for this chat"],
  ["commands", "Browse all commands and skills"],
  ["help", "Show available commands"],
  ["status", "Show session info"],
  ["model", "Switch or show the active model"],
  ["reasoning", "Change reasoning effort"],
  ["personality", "Switch assistant personality"],
  ["retry", "Retry the last response"],
  ["undo", "Remove the last exchange"],
  ["compress", "Compress session history"],
  ["title", "Set or show the session title"],
  ["resume", "Resume a named session"],
  ["background", "Run a background prompt"],
  ["steer", "Inject a follow-up without interrupting"],
  ["stop", "Stop the running response"],
  ["voice", "Toggle voice replies — /voice on|tts|off|status"],
] as const;

// Browsers expose different MediaRecorder codecs. Pick the first one that
// works so we record a real container; if MediaRecorder.isTypeSupported
// rejects all, the browser-default mime is used (still works, just opaque).
function pickAudioMime(): { mime: string; ext: string } {
  const candidates: Array<{ mime: string; ext: string }> = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/mpeg", ext: "mp3" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)) {
      return c;
    }
  }
  return { mime: "", ext: "webm" };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const ELAPSED_TICK_MS = 250;
const ERROR_TIMEOUT_MS = 4000;
const CHUNK_INTERVAL_MS = 250;

function VoiceRecordButton() {
  const aui = useAui();
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTsRef = useRef<number>(0);

  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      setElapsed(Date.now() - startTsRef.current);
    }, ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [recording]);

  // Hide a transient error after a few seconds.
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [error]);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("recording not supported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("mic permission denied");
      return;
    }
    const { mime, ext } = pickAudioMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (exc) {
      stream.getTracks().forEach((t) => t.stop());
      setError(exc instanceof Error ? exc.message : "recorder init failed");
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onerror = (e: ErrorEvent) => {
      setError(e.error?.message ?? e.message ?? "recorder error");
    };
    rec.onstop = async () => {
      const recordedMime = rec.mimeType || mime || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: recordedMime });
      cleanup();
      if (blob.size === 0) {
        setError("recording was empty");
        return;
      }
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: recordedMime });
      try {
        await aui.composer().addAttachment(file);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "upload failed");
      }
    };
    streamRef.current = stream;
    recorderRef.current = rec;
    startTsRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    // Flush a chunk every CHUNK_INTERVAL_MS so we still have data even on very short clips.
    rec.start(CHUNK_INTERVAL_MS);
  }, [aui, cleanup]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    setRecording(false);
    if (!rec || rec.state === "inactive") {
      cleanup();
      return;
    }
    try {
      rec.requestData();
    } catch {
      // Some browsers throw if state is not "recording" — onstop still fires.
    }
    rec.stop();
  }, [cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  if (recording) {
    return (
      <button
        data-aui-ocs-control
        type="button"
        onClick={stop}
        aria-label="stop recording"
        title={`stop · ${formatElapsed(elapsed)}`}
        className={cn(
          controlBase,
          "shrink-0 gap-1.5 px-2.5 border-destructive/50 text-destructive hover:bg-destructive/10",
        )}
      >
        <StopRecordIcon />
        <span className="font-mondwest text-[10px] tracking-[0.06em]">
          {formatElapsed(elapsed)}
        </span>
      </button>
    );
  }
  return (
    <button
      data-aui-ocs-control
      type="button"
      onClick={start}
      aria-label="record audio"
      title={error ?? "record audio"}
      className={cn(iconButton, "shrink-0", error && "border-destructive/40 text-destructive")}
    >
      <MicIcon />
    </button>
  );
}

function ComposerAttachment() {
  return (
    <AttachmentPrimitive.Root
      data-aui-ocs-composer-attachment
      data-aui-ocs-surface="mid"
      className="inline-flex h-8 max-w-[14rem] items-center gap-2 border border-midground/35 px-2 text-[11px] text-foreground"
    >
      <AttachmentPrimitive.unstable_Thumb className="flex h-5 min-w-6 items-center justify-center border border-midground/25 px-1 font-mondwest text-[9px] text-midground/70" />
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove
        data-aui-ocs-control
        className={cn("ml-auto", smallIconControl)}
        aria-label="remove attachment"
      >
        <RemoveIcon />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}


function commitSlashCommand(aui: ReturnType<typeof useAui>, id: string) {
  const text = `/${id} `;
  aui.composer().setText(text);
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>("[data-aui-ocs-composer] textarea");
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(text.length, text.length);
    // notify trigger detection that cursor moved past the inserted command
    input.dispatchEvent(new Event("select", { bubbles: true }));
  });
}

function SlashCommands() {
  const aui = useAui();
  const slash = unstable_useSlashCommandAdapter({
    removeOnExecute: true,
    commands: SLASH_COMMANDS.map(([id, description]) => ({
      id,
      // The popover already shows a leading "/" badge to the left of each
      // row; including it in the label too is redundant. The inserted text
      // still gets the slash (see commitSlashCommand).
      label: id,
      description,
      execute: () => commitSlashCommand(aui, id),
    })),
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
      className="absolute z-20 flex flex-col overflow-hidden border border-midground/30 bg-background p-1 shadow-xl"
      data-aui-ocs-slash-popover
    >
      <style href="ocs-style-slash-item" precedence="default">{SLASH_ITEM_CSS}</style>
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => (
          <div data-aui-ocs-slash-items className="flex-1">
            {items.map((item, index) => (
              <PopoverItem key={item.id} item={item} index={index} glyph="/" />
            ))}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

function PopoverItem(
  { item, index, glyph, truncateLabel }:
  { item: Unstable_TriggerItem; index: number; glyph: string; truncateLabel?: boolean },
) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const { highlightedIndex } = unstable_useTriggerPopoverScopeContext();
  const isHighlighted = highlightedIndex === index;

  useEffect(() => {
    if (!isHighlighted) return;
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [isHighlighted]);

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItem
      ref={ref}
      type="button"
      item={item}
      index={index}
      data-aui-ocs-slash-item
      className="flex w-full items-start gap-3 px-2.5 py-2 text-left text-sm text-foreground"
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border border-midground/25 font-mondwest text-[11px] text-midground">
        {glyph}
      </span>
      <span className="min-w-0">
        <span className={cn("block font-medium", truncateLabel && "truncate")}>{item.label}</span>
        {item.description && (
          <span className="block truncate text-xs text-midground/70">
            {item.description}
          </span>
        )}
      </span>
    </ComposerPrimitive.Unstable_TriggerPopoverItem>
  );
}

function AtCompletions({ client, sessionId }: { client: GatewayClient; sessionId: string }) {
  const { adapter, formatter } = useAtCompletions(client, sessionId);
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      className="absolute z-20 flex flex-col overflow-hidden border border-midground/30 bg-background p-1 shadow-xl"
      data-aui-ocs-slash-popover
    >
      <style href="ocs-style-slash-item" precedence="default">{SLASH_ITEM_CSS}</style>
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={formatter} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => (
          <div data-aui-ocs-slash-items className="flex-1">
            {items.map((item, index) => (
              <PopoverItem key={item.id} item={item} index={index} glyph="@" truncateLabel />
            ))}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

export interface ComposerProps {
  placeholder?: string;
  replyTarget?: OurMessage;
  onCancelReply?: () => void;
  client?: GatewayClient;
  sessionId?: string | null;
  completionEnabled?: boolean;
}

export function Composer({
  placeholder,
  replyTarget,
  onCancelReply,
  client,
  sessionId,
  completionEnabled,
}: ComposerProps) {
  return (
    <ComposerPrimitive.AttachmentDropzone
      data-aui-ocs-composer
    >
      <style href="ocs-style-composer" precedence="default">{COMPOSER_CSS}</style>
      <style href="ocs-style-surface" precedence="default">{SURFACE_CSS}</style>
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="relative flex flex-col gap-1.5 px-3 py-2">
          {replyTarget && (
            <div className="flex h-8 items-center gap-2 border border-midground/25 px-2 text-xs text-midground/80">
              <span className="shrink-0 font-mondwest uppercase tracking-[0.1em]">
                reply to {replyTarget.role}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {previewText(replyTarget.content)}
              </span>
              <button
                data-aui-ocs-control
                type="button"
                className={smallIconControl}
                onClick={onCancelReply}
                aria-label="cancel reply"
                title="cancel reply"
              >
                <RemoveIcon />
              </button>
            </div>
          )}
          <ComposerPrimitive.Attachments>
            {() => <ComposerAttachment />}
          </ComposerPrimitive.Attachments>
          <div data-aui-ocs-composer-row className="flex items-end gap-2">
            <ComposerPrimitive.AddAttachment
              data-aui-ocs-control
              className={cn(iconButton, "shrink-0")}
              aria-label="attach file"
              title="attach file"
            >
              <PaperclipIcon />
            </ComposerPrimitive.AddAttachment>
            <VoiceRecordButton />
            <ComposerPrimitive.Input
              data-aui-ocs-field
              rows={1}
              enterKeyHint="send"
              placeholder={placeholder ?? "Message…"}
              className={cn(
                fieldBase,
                "max-h-40 flex-1 resize-none",
              )}
            />
            <ComposerPrimitive.Send
              data-aui-ocs-control
              className={cn(iconButton, "shrink-0 disabled:opacity-40")}
              aria-label="send"
              title="send"
            >
              <SendIcon />
            </ComposerPrimitive.Send>
          </div>
          <SlashCommands />
          {completionEnabled && client && sessionId && (
            <AtCompletions client={client} sessionId={sessionId} />
          )}
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </ComposerPrimitive.AttachmentDropzone>
  );
}
