import type { ConnState } from "@/runtime/external-runtime";
import type { PushStatus } from "@/push/usePushSubscription";
import type { ApprovalDecision } from "@/types";

export const panelTitle =
  "font-mondwest text-sm uppercase tracking-[0.12em] text-midground/70";

export const controlBase =
  "inline-flex h-9 items-center justify-center border text-xs transition focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-40";

export const iconButton =
  `${controlBase} w-9 border-midground/30 text-midground/70 hover:bg-foreground/2 hover:text-foreground`;

export const actionButton =
  `${controlBase} px-3 font-medium`;

export const fieldBase =
  "h-9 min-w-0 border border-midground/30 bg-transparent px-2 text-sm leading-5 text-foreground placeholder:text-midground/50 focus:border-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/20";

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

export const DECISION_TONE: Record<ApprovalDecision, string> = {
  once: "border-success/50 text-success hover:bg-success/10",
  session: "border-success/40 text-success hover:bg-success/10",
  always: "border-success/30 text-success hover:bg-success/10",
  deny: "border-destructive/50 text-destructive hover:bg-destructive/10",
};

export const DECISION_LABEL: Record<ApprovalDecision, string> = {
  once: "Allow once",
  session: "Allow this session",
  always: "Always allow",
  deny: "Deny",
};
