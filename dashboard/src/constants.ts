export const PROXY_BASE = "/api/plugins/open-chat-session";

export const HEALTH_POLL_MS = 15_000;

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
