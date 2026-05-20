import { useCallback, useEffect, useState } from "@/sdk";
import type { GatewayClient } from "@/gateway-client";
import type {
  PushPlatform,
  PushNotificationPolicy,
} from "@/types";
import { getOrCreateClientDeviceId, PWA_SW_URL } from "@/constants";

export type PushStatus =
  | "unsupported"
  | "needs-pwa-install"
  | "permission-denied"
  | "not-subscribed"
  | "subscribed"
  | "working"
  | "error";

export interface PushHookState {
  status: PushStatus;
  error: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

const IOS_UA = /iPad|iPhone|iPod/;

function isIOS(): boolean {
  return IOS_UA.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (window.navigator as { standalone?: boolean }).standalone === true;
}

function detectPlatform(): PushPlatform {
  const ua = navigator.userAgent;
  if (isIOS() && isStandalone()) return "ios-home-screen";
  if (/Android/.test(ua)) return "android-chrome";
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua)) {
    return "macos-safari";
  }
  return "web";
}

function available(): PushStatus | null {
  if (
    !("serviceWorker" in navigator)
    || !("PushManager" in window)
    || !("Notification" in window)
  ) {
    return "unsupported";
  }
  if (isIOS() && !isStandalone()) return "needs-pwa-install";
  return Notification.permission === "denied" ? "permission-denied" : null;
}

function b64urlToBytes(b64url: string): ArrayBuffer {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

const DEFAULT_POLICY = {
  message_in: false,
  message_out: true,
  approvals: true,
  preview_text: true,
  dedupe_ms: 5000,
} satisfies PushNotificationPolicy;

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(PWA_SW_URL);
  const worker = reg.active || reg.installing || reg.waiting;
  if (!reg.active && worker && worker.state !== "activated") {
    await new Promise<void>((resolve) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      });
    });
  }
  return reg;
}

export function usePushSubscription(
  client: GatewayClient,
  policy: PushNotificationPolicy = DEFAULT_POLICY,
): PushHookState {
  const [status, setStatus] = useState<PushStatus>("unsupported");
  const [error, setError] = useState<string | null>(null);
  const [deviceId] = useState<string>(() => getOrCreateClientDeviceId());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blocked = available();
      if (blocked) return void (!cancelled && setStatus(blocked));
      try {
        const reg = await navigator.serviceWorker.getRegistration(PWA_SW_URL);
        const sub = reg && (await reg.pushManager.getSubscription());
        if (!cancelled) setStatus(sub ? "subscribed" : "not-subscribed");
      } catch {
        if (!cancelled) setStatus("not-subscribed");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const subscribe = useCallback(async () => {
    setError(null);
    setStatus("working");
    try {
      const reg = await activeRegistration();
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "permission-denied" : "not-subscribed");
        return;
      }

      const { public_key } = await client.getVapidPublicKey();
      const appKey = b64urlToBytes(public_key);

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appKey,
        });
      }

      const raw = sub.toJSON();
      await client.registerPushDevice({
        device_id: deviceId,
        platform: detectPlatform(),
        notification_policy: policy,
        subscription: {
          endpoint: raw.endpoint || sub.endpoint,
          expirationTime: raw.expirationTime ?? null,
          keys: {
            p256dh: raw.keys?.p256dh || "",
            auth: raw.keys?.auth || "",
          },
        },
      });
      setStatus("subscribed");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      setStatus("error");
    }
  }, [client, deviceId, policy]);

  const unsubscribe = useCallback(async () => {
    setError(null);
    setStatus("working");
    try {
      const reg = await navigator.serviceWorker.getRegistration(PWA_SW_URL);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) await sub.unsubscribe();
      await client.deletePushDevice(deviceId).catch(() => undefined);
      setStatus("not-subscribed");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      setStatus("error");
    }
  }, [client, deviceId]);

  return { status, error, subscribe, unsubscribe };
}
