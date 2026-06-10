import type { ConnState } from "@/runtime/external-runtime";
import type { PushStatus } from "@/push/usePushSubscription";
import type { ApprovalDecision } from "@/types";

export const panelTitle =
  "font-mondwest text-sm uppercase tracking-[0.12em] text-midground/70";

// Focus styling is central in styles.css (:focus-visible outline + input
// :focus border) — no per-class focus rings here.
export const controlBase =
  "inline-flex h-9 items-center justify-center border text-xs transition focus:outline-none disabled:opacity-40";

export const iconButton =
  `${controlBase} w-9 border-midground/30 text-midground/70 hover:bg-foreground/2 hover:text-foreground`;

export const actionButton =
  `${controlBase} px-3 font-medium`;

export const fieldBase =
  "h-9 min-w-0 border border-midground/30 bg-transparent px-2 text-sm leading-5 text-foreground placeholder:text-midground/50 focus:outline-none";

// Small square action button used for hover-revealed controls — message
// bubble copy/reply and session-row archive. Kept here so the surfaces
// stay visually identical.
export const bubbleActionClass =
  "flex items-center justify-center border border-midground/25 bg-background text-midground/70 shadow transition hover:text-foreground";
export const bubbleActionStyle = { width: "1.5rem", height: "1.5rem" } as const;

// Inline remove button (h-5 w-5) used for in-row dismiss controls —
// attachment chip "×", reply-target "×". Different from bubbleActionClass:
// no background, no shadow, sits inline with adjacent text/inputs.
export const smallIconControl =
  "flex h-5 w-5 shrink-0 items-center justify-center border border-midground/25 text-midground/70 hover:text-foreground";

export const REPLY_PREVIEW_LEN = 140;

export function toneClass(kind: "success" | "warning" | "destructive" | "midground" | "idle"): string {
  switch (kind) {
    case "success": return "text-success";
    case "warning": return "text-warning";
    case "destructive": return "text-destructive";
    case "midground": return "text-midground/70";
    case "idle": return "text-midground/60";
  }
}

export type BannerTone = "destructive" | "warning" | "midground";

export const PILL_TONES: Record<ConnState["kind"], string> = {
  idle: toneClass("idle"),
  connecting: toneClass("warning"),
  connected: toneClass("success"),
  reconnecting: "text-warning/80",
  unauthorized: toneClass("destructive"),
};

export const BANNER_TEXT_TONES: Record<BannerTone, string> = {
  destructive: toneClass("destructive"),
  warning: toneClass("warning"),
  midground: toneClass("midground"),
};

export const BANNER_BORDER: Record<BannerTone, string> = {
  destructive: "border-destructive/40",
  warning: "border-warning/40",
  midground: "border-midground/30",
};

export const PUSH_TONE: Partial<Record<PushStatus, string>> = {
  subscribed: "border-success/40 text-success",
  "permission-denied": "border-destructive/40 text-destructive",
  error: "border-destructive/40 text-destructive",
  "needs-pwa-install": "border-warning/40 text-warning",
  working: "border-midground/30 text-midground/70 opacity-70",
};

export const DECISION: Record<ApprovalDecision, { label: string; tone: string }> = {
  once: { label: "Allow once", tone: "border-success/50 text-success hover:bg-success/10" },
  session: { label: "Allow this session", tone: "border-success/40 text-success hover:bg-success/10" },
  always: { label: "Always allow", tone: "border-success/30 text-success hover:bg-success/10" },
  deny: { label: "Deny", tone: "border-destructive/50 text-destructive hover:bg-destructive/10" },
};
