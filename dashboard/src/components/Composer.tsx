import { React, cn } from "@/sdk";
import { AuiIf, ComposerPrimitive, useThreadComposer } from "@assistant-ui/react";
import { actionButton, composerControlStyle, composerIconStyle, fieldBase, iconButton } from "@/ui";

function PaperclipIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function humanSize(bytes: number): string {
  if (!bytes) return "";
  const u = ["B", "kB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}

function PendingChips() {
  const composer = useThreadComposer();
  const attachments = (composer.attachments ?? []) as any[];
  if (!attachments.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1")}>
      {attachments.map((a, i) => {
        const status = a.status?.type;
        const tone =
          status === "incomplete"
            ? "border-rose-500/40 text-rose-300 bg-rose-500/10"
            : status === "running"
              ? "border-amber-500/40 text-amber-300 bg-amber-500/10"
              : "border-midground/40 text-foreground bg-foreground/[0.04]";
        return (
          <span
            key={a.id ?? i}
            className={cn(
              "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px]",
              tone,
            )}
            title={`${a.contentType ?? ""} · ${a.id ?? ""}`}
          >
            <span className={cn("truncate max-w-[10rem]")}>{a.name}</span>
            {a.file?.size != null && (
              <span className={cn("text-[10px] opacity-70")}>{humanSize(a.file.size)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function Composer({ placeholder }: { placeholder?: string }) {
  return (
    <ComposerPrimitive.Root
      className={cn(
        "flex flex-col gap-1.5 border-t border-midground/20 bg-foreground/[0.02] px-3 py-2",
      )}
    >
      <PendingChips />
      <div className={cn("flex items-end gap-2")}>
        <ComposerPrimitive.AddAttachment
          className={cn(iconButton, "shrink-0")}
          style={composerIconStyle}
          aria-label="attach file"
          title="attach file"
        >
          <PaperclipIcon />
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          rows={1}
          placeholder={placeholder ?? "Message…"}
          className={cn(
            fieldBase,
            "max-h-40 min-h-9 flex-1 resize-none py-2",
          )}
          style={composerControlStyle}
        />
        <AuiIf condition={(s: any) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            className={cn(
              actionButton,
              "shrink-0 border-rose-500/40 text-rose-300 hover:bg-rose-500/10",
            )}
            style={composerControlStyle}
          >
            stop
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <AuiIf condition={(s: any) => !s.thread.isRunning}>
          <ComposerPrimitive.Send
            className={cn(
              actionButton,
              "shrink-0 border-emerald-500/40 text-emerald-300",
              "hover:bg-emerald-500/10 disabled:opacity-40 disabled:hover:bg-transparent",
            )}
            style={composerControlStyle}
          >
            send
          </ComposerPrimitive.Send>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
}
