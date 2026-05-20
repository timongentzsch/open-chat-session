import { React, cn } from "@/sdk";
import { useGatewayClient } from "@/hooks/useGatewayClient";
import { usePushSubscription, type PushStatus } from "@/push/usePushSubscription";
import { PUSH_TONE } from "@/ui";

const LABEL: Record<PushStatus, string> = {
  unsupported: "push: n/a",
  "needs-pwa-install": "install PWA",
  "permission-denied": "push blocked",
  "not-subscribed": "enable push",
  subscribed: "push on",
  working: "…",
  error: "push: error",
};

const TITLE: Record<PushStatus, string> = {
  unsupported: "This browser doesn't support Web Push.",
  "needs-pwa-install":
    "iOS Safari only sends push from an installed PWA. Share → Add to Home Screen, then re-open from the icon.",
  "permission-denied":
    "Notifications are blocked. Enable them in browser settings, then reload.",
  "not-subscribed": "Click to enable background notifications for this device.",
  subscribed: "Click to turn off background notifications on this device.",
  working: "Working…",
  error: "Something went wrong. See console for details.",
};

const DISABLED = new Set<PushStatus>([
  "working",
  "needs-pwa-install",
  "permission-denied",
]);

export function PushPanel(): React.ReactElement | null {
  const client = useGatewayClient();
  const push = usePushSubscription(client);

  if (push.status === "unsupported") return null;

  const disabled = DISABLED.has(push.status);
  const onClick = () => {
    if (push.status === "subscribed") void push.unsubscribe();
    else if (!disabled) void push.subscribe();
  };

  return (
    <button
      data-aui-ocs-control
      data-aui-ocs-push
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={push.error ? `${TITLE[push.status]} (${push.error})` : TITLE[push.status]}
      className={cn(
        "border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.08em]",
        "transition-colors",
        PUSH_TONE[push.status] ?? "border-midground/30 text-midground/80 hover:text-foreground",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      {LABEL[push.status]}
    </button>
  );
}
