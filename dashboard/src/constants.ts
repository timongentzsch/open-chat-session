export const PROXY_BASE = "/api/plugins/open-chat-session";

const PWA_BASE = "/dashboard-plugins/open-chat-session/public";
export const PWA_SW_URL = `${PWA_BASE}/sw.js`;
export const PWA_MANIFEST_URL = `${PWA_BASE}/manifest.json`;
export const PWA_APPLE_TOUCH_ICON_URL = `${PWA_BASE}/icons/180.png`;
export const CLIENT_DEVICE_ID_HEADER = "X-Open-Chat-Session-Device-Id";
const CLIENT_DEVICE_ID_KEY = "ocs:push:device_id";

export const HEALTH_POLL_MS = 15_000;
export const BLOB_URL_CLEANUP_MS = 30_000;

export const DEFAULT_BACKFILL_COUNT = 200;
export const ERR_ID_PREFIX = "err-";

export const RELATIVE_TIME_BUCKETS = {
  MINUTE_MS: 60_000,
  HOUR_MS: 60 * 60_000,
  DAY_MS: 24 * 60 * 60_000,
  WEEK_MS: 14 * 24 * 60 * 60_000,
} as const;

const SIZE_UNITS = ["B", "kB", "MB", "GB"];
export function humanSize(bytes: number): string {
  if (!bytes) return "0 B";
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${SIZE_UNITS[i]}`;
}

export function authHeaders(): Record<string, string> {
  const token = window.__HERMES_SESSION_TOKEN__;
  return token ? { "X-Hermes-Session-Token": token } : {};
}

export function getOrCreateClientDeviceId(): string {
  try {
    const id = window.localStorage.getItem(CLIENT_DEVICE_ID_KEY);
    if (id) return id;
  } catch {
    // best effort
  }
  const fresh = `pd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    window.localStorage.setItem(CLIENT_DEVICE_ID_KEY, fresh);
  } catch {
    // best effort
  }
  return fresh;
}
