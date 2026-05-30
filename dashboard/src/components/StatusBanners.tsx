import { React, cn } from "@/sdk";
// Required in scope by the classic JSX transform (vite.config.ts).
void React;
import type { ConnState } from "@/runtime/external-runtime";
import { controlBase, PILL_TONES, BANNER_TEXT_TONES, BANNER_BORDER, type BannerTone } from "@/ui";
import { BANNER_CSS } from "@/chat-styles";

function pillText(conn: ConnState, _platform?: string, healthError?: string | null): string {
  switch (conn.kind) {
    case "idle": return "idle";
    case "connecting": return "connecting";
    case "connected": return healthError ? "live · stale" : "live";
    case "reconnecting": return `retry ${Math.round(conn.nextDelayMs / 1000)}s`;
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
      <span className="h-1.5 w-1.5 bg-current" aria-hidden />
      {pillText(conn, platform, healthError)}
    </span>
  );
}

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
      <style href="ocs-style-banner" precedence="default">{BANNER_CSS}</style>
      <div
        data-aui-ocs-banner-tone={tone}
        className={cn(
          "flex flex-col gap-1 border-b px-3 py-1.5 text-xs",
          BANNER_BORDER[tone],
          BANNER_TEXT_TONES[tone],
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span>{message}</span>
          {onDismiss && (
            <button
              data-aui-ocs-control
              type="button"
              className={cn(controlBase, "h-7 border-midground/30 px-2 text-[11px] text-midground/70 hover:text-foreground")}
              onClick={onDismiss}
            >
              dismiss
            </button>
          )}
        </div>
        {detail && <span className="text-[11px] opacity-80">{detail}</span>}
      </div>
    </>
  );
}
