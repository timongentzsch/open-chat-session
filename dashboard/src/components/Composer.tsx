import { React, cn } from "@/sdk";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  type AssistantState,
  unstable_useSlashCommandAdapter,
  useAui,
} from "@assistant-ui/react";
import { actionButton, composerControlStyle, composerIconStyle, fieldBase, iconButton } from "@/ui";
import { SLASH_ITEM_CSS, COMPOSER_CSS } from "@/chat-styles";

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
] as const;

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

function RemoveIcon() {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ComposerAttachment() {
  return (
    <AttachmentPrimitive.Root
      className="inline-flex h-8 max-w-[14rem] items-center gap-2 rounded border border-midground/35 px-2 text-[11px] text-foreground"
      style={{ background: "color-mix(in srgb, var(--foreground-base, #fff) 4%, transparent)" }}
    >
      <AttachmentPrimitive.unstable_Thumb className="flex h-5 min-w-6 items-center justify-center rounded border border-midground/25 px-1 font-mondwest text-[9px] text-midground/70" />
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove
        className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded border border-midground/25 text-midground/70 hover:text-foreground"
        aria-label="remove attachment"
      >
        <RemoveIcon />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}


function SlashCommands() {
  const aui = useAui();
  const slash = unstable_useSlashCommandAdapter({
    removeOnExecute: true,
    commands: SLASH_COMMANDS.map(([id, description]) => ({
      id,
      label: `/${id}`,
      description,
      execute: () => aui.composer().setText(`/${id}`),
    })),
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
      className="absolute bottom-full left-12 right-20 z-20 mb-2 max-h-72 overflow-hidden rounded-md border border-midground/30 bg-background p-1 shadow-xl"
    >
      <style precedence="default">{SLASH_ITEM_CSS}</style>
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => (
          <div className="max-h-64 overflow-y-auto">
            {items.map((item, index) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={index}
                data-aui-ocs-slash-item
                className="flex w-full items-start gap-3 rounded px-2.5 py-2 text-left text-sm text-foreground"
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-midground/25 font-mondwest text-[11px] text-midground">
                  /
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{item.label}</span>
                  {item.description && (
                    <span className="block truncate text-xs text-midground/70">
                      {item.description}
                    </span>
                  )}
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

export function Composer({ placeholder }: { placeholder?: string }) {
  return (
    <ComposerPrimitive.AttachmentDropzone
      data-aui-ocs-composer
    >
      <style precedence="default">{COMPOSER_CSS}</style>
      <ComposerPrimitive.Root className="relative flex flex-col gap-1.5 px-3 py-2">
        <ComposerPrimitive.Unstable_TriggerPopoverRoot>
          <ComposerPrimitive.Attachments>
            {() => <ComposerAttachment />}
          </ComposerPrimitive.Attachments>
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
            <AuiIf condition={(s: AssistantState) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel
                className={cn(
                  actionButton,
                  "shrink-0 border-rose-500/40 text-destructive hover:bg-destructive/10",
                )}
                style={composerControlStyle}
              >
                stop
              </ComposerPrimitive.Cancel>
            </AuiIf>
            <AuiIf condition={(s: AssistantState) => !s.thread.isRunning}>
              <ComposerPrimitive.Send
                className={cn(
                  actionButton,
                  "shrink-0 border-emerald-500/40 text-success",
                  "hover:bg-success/10 disabled:opacity-40 disabled:hover:bg-transparent",
                )}
                style={composerControlStyle}
              >
                send
              </ComposerPrimitive.Send>
            </AuiIf>
          </div>
          <SlashCommands />
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.AttachmentDropzone>
  );
}
