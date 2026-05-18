import { React, cn } from "@/sdk";
import type { ConnState } from "@/runtime/external-runtime";
import { controlBase, toneClass } from "@/ui";
import { BANNER_CSS } from "@/chat-styles";

// Match Hermes' own status-label aesthetic (see "Gateway Status: Running" in
// the sidebar): just a colored Mondwest label, no border/pill chrome.
const PILL_TONES: Record<ConnState["kind"], string> = {
  idle: toneClass("idle"),
  connecting: toneClass("warning"),
  connected: toneClass("success"),
  reconnecting: "text-warning/80",
};

function pillText(conn: ConnState, platform?: string, healthError?: string | null): string {
  switch (conn.kind) {
    case "idle": return "idle";
    case "connecting": return "connecting";
    case "connected": return healthError ? "stream live · health stale" : platform ? `stream live · ${platform}` : "stream live";
    case "reconnecting": return `retrying in ${Math.round(conn.nextDelayMs / 1000)}s`;
    default: {
      const _exhaustive: never = conn;
      return "";
    }
  }
}

export function ConnectionPill({
  conn,
  platform,
  healthError,
}: {
  conn: ConnState;
  platform?: string;
  healthError?: string | null;
}) {
  const title = conn.kind === "reconnecting"
    ? conn.lastError
    : healthError
      ? `health check failed: ${healthError}`
      : undefined;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-mondwest text-xs font-medium tracking-[0.12em]",
        PILL_TONES[conn.kind],
      )}
      title={title}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current")} aria-hidden />
      {pillText(conn, platform, healthError)}
    </span>
  );
}

type BannerTone = "rose" | "amber" | "midground";

const BANNER_TEXT_TONES: Record<BannerTone, string> = {
  rose: toneClass("destructive"),
  amber: toneClass("warning"),
  midground: toneClass("midground"),
};

const BANNER_BORDER: Record<BannerTone, string> = {
  rose: "border-rose-500/40",
  amber: "border-amber-500/40",
  midground: "border-midground/30",
};

export function Banner({
  tone,
  message,
  detail,
  onDismiss,
}: {
  tone: BannerTone;
  message: string;
  detail?: string;
  onDismiss?: () => void;
}) {
  return (
    <>
      <style precedence="default">{BANNER_CSS}</style>
      <div
        data-aui-ocs-banner-tone={tone}
        className={cn(
          "flex flex-col gap-1 border-b px-3 py-1.5 text-xs",
          BANNER_BORDER[tone],
          BANNER_TEXT_TONES[tone],
        )}
      >
        <div className={cn("flex items-center justify-between gap-3")}>
          <span>{message}</span>
          {onDismiss && (
            <button
              type="button"
              className={cn(controlBase, "h-7 border-midground/30 px-2 text-[11px] text-midground/70 hover:text-foreground")}
              onClick={onDismiss}
            >
              dismiss
            </button>
          )}
        </div>
        {detail && <span className={cn("text-[11px] opacity-80")}>{detail}</span>}
      </div>
    </>
  );
}
