import { React, cn } from "@/sdk";
import type { ConnState } from "@/runtime/external-runtime";
import { controlBase } from "@/ui";

const PILL_TONES: Record<ConnState["kind"], string> = {
  idle: "border-midground/30 text-midground/60",
  connecting: "border-amber-500/40 text-amber-300",
  connected: "border-emerald-500/40 text-emerald-300",
  reconnecting: "border-amber-500/40 text-amber-300",
  error: "border-rose-500/40 text-rose-300",
};

function pillText(conn: ConnState, platform?: string): string {
  switch (conn.kind) {
    case "idle": return "idle";
    case "connecting": return "connecting…";
    case "connected": return platform ? `live · ${platform}` : "live";
    case "reconnecting": return `retrying in ${Math.round(conn.nextDelayMs / 1000)}s`;
    case "error": return "offline";
  }
  return "unknown";
}

export function ConnectionPill({ conn, platform }: { conn: ConnState; platform?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-mondwest tracking-[0.1em]",
        PILL_TONES[conn.kind],
      )}
      title={conn.kind === "reconnecting" ? conn.lastError : undefined}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current")} aria-hidden />
      {pillText(conn, platform)}
    </span>
  );
}

type BannerTone = "rose" | "amber" | "midground";

const BANNER_TONES: Record<BannerTone, string> = {
  rose: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  midground: "border-midground/30 bg-foreground/[0.04] text-midground/70",
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
    <div
      className={cn(
        "flex flex-col gap-1 border-b px-3 py-1.5 text-xs",
        BANNER_TONES[tone],
      )}
    >
      <div className={cn("flex items-center justify-between gap-3")}>
        <span>{message}</span>
        {onDismiss && (
          <button
            type="button"
            className={cn(controlBase, "h-7 border-current/30 px-2 text-[11px] text-current/80 hover:text-current")}
            onClick={onDismiss}
          >
            dismiss
          </button>
        )}
      </div>
      {detail && <span className={cn("text-[11px] opacity-80")}>{detail}</span>}
    </div>
  );
}
