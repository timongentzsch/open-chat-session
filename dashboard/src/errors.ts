// Thrown by GatewayClient on non-2xx. `code` is the gateway's own error
// code (`already_resolved`, `archived`, ...) when present, else `http_error`.

import type { EventEnvelope } from "./types";

export class GatewayError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(`[${status}] ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isEventEnvelope(v: unknown): v is EventEnvelope {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seq === "number" &&
    typeof o.ts === "number" &&
    typeof o.kind === "string" &&
    "payload" in o &&
    o.payload !== null &&
    typeof o.payload === "object" &&
    !Array.isArray(o.payload)
  );
}

export function errorMessage(exc: unknown): string {
  if (exc instanceof GatewayError) return exc.code;
  if (exc instanceof Error) return exc.message;
  return String(exc);
}
