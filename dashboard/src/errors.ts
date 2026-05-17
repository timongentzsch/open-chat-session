// Thrown by GatewayClient on non-2xx. `code` is the gateway's own error
// code (`already_resolved`, `archived`, ...) when present, else `http_error`.

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
