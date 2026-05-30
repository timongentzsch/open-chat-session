// REST + SSE client for the plugin's reverse proxy at
// `/api/plugins/open-chat-session/*`. The proxy injects gateway auth +
// X-Device-Id server-side; we only forward the dashboard session
// token. Streaming methods yield via async generators — break to
// close via the caller's AbortController.

import { GatewayError, errorMessage, isEventEnvelope } from "./errors";
import {
  CLIENT_DEVICE_ID_HEADER,
  DEFAULT_BACKFILL_COUNT,
  getOrCreateClientDeviceId,
} from "./constants";
import { parseSSE } from "./parse-sse";
import type {
  AttachmentInfo,
  CreateSessionRequest,
  EventEnvelope,
  Hash,
  HealthResponse,
  HistoryResponse,
  PushDevice,
  RegisterPushDeviceRequest,
  SendMessageRequest,
  SessionInfo,
  SessionsListResponse,
  StreamId,
  VapidPublicKeyResponse,
} from "./types";

type ErrorBody = {
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
};

function isErrorBody(v: unknown): v is ErrorBody {
  return typeof v === "object" && v !== null && (
    "error" in v || "code" in v || "message" in v
  );
}

export interface GatewayClientOpts {
  baseUrl: string;
}

export interface StreamCursor {
  lastEventId?: string;
  cursor?: "latest" | "snapshot" | "genesis" | string;
  latestN?: number;
}

export class GatewayClient {
  private baseUrl: string;

  constructor(opts: GatewayClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  private url(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const q = qs.toString();
    return `${this.baseUrl}${path}${q ? `?${q}` : ""}`;
  }

  private auth(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    const token = window.__HERMES_SESSION_TOKEN__;
    if (token) headers.set("X-Hermes-Session-Token", token);
    headers.set(CLIENT_DEVICE_ID_HEADER, getOrCreateClientDeviceId());
    return { ...init, headers };
  }

  private async expect(res: Response, fallbackCode: string): Promise<void> {
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    let code = fallbackCode;
    let message = body || res.statusText || `HTTP ${res.status}`;
    try {
      const raw: unknown = JSON.parse(body);
      const parsed: ErrorBody = isErrorBody(raw) ? raw : {};
      code = parsed?.error?.code ?? parsed?.code ?? code;
      message = parsed?.error?.message ?? parsed?.message ?? message;
    } catch (exc) {
      message = errorMessage(exc) || message;
    }
    throw new GatewayError(res.status, code, message, body);
  }

  private async json<T>(res: Response, fallbackCode = "http_error"): Promise<T> {
    await this.expect(res, fallbackCode);
    return (await res.json()) as T;
  }

  private request<T>(
    path: string,
    init?: RequestInit,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return fetch(this.url(path, params), this.auth(init)).then((res) => this.json<T>(res));
  }

  private async requestVoid(path: string, fallbackCode: string, init?: RequestInit): Promise<void> {
    const res = await fetch(this.url(path), this.auth(init));
    await this.expect(res, fallbackCode);
  }

  private async *eventsFrom(res: Response, fallbackCode: string): AsyncGenerator<EventEnvelope> {
    await this.expect(res, fallbackCode);
    for await (const frame of parseSSE(res)) {
      if (!frame.data) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        // Ignore malformed frames; the next valid one re-anchors via hash chain.
        continue;
      }
      if (isEventEnvelope(parsed)) {
        yield parsed;
        continue;
      }
      // The proxy reports an upstream >=400 as a flat `gateway.error` frame
      // ({code,status,message}, not an envelope) inside a 200 response. Surface
      // it as a GatewayError so reconnect/banner runs instead of ending
      // silently. Real adapter gateway.error events are envelopes, handled above.
      if (frame.event === "gateway.error") {
        const body = (parsed ?? {}) as { code?: string; status?: number; message?: string };
        throw new GatewayError(
          body.status ?? 502,
          body.code ?? "stream_error",
          body.message ?? "stream error",
        );
      }
    }
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  async listSessions(opts: { includeArchived?: boolean } = {}): Promise<SessionInfo[]> {
    const body = await this.request<SessionsListResponse>(
      "/sessions",
      undefined,
      { include_archived: opts.includeArchived ?? false },
    );
    return body.sessions ?? [];
  }

  createSession(req: CreateSessionRequest): Promise<SessionInfo> {
    return this.request<SessionInfo>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.requestVoid(
      `/sessions/${encodeURIComponent(sessionId)}`,
      "archive_failed",
      { method: "DELETE" },
    );
  }

  async history(
    sessionId: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<HistoryResponse> {
    const body = await this.request<{ events: unknown[]; next_cursor?: Hash }>(
      `/sessions/${encodeURIComponent(sessionId)}/history`,
      undefined,
      { after: opts.after, limit: opts.limit ?? 100 },
    );
    return {
      events: (body.events ?? []).filter(isEventEnvelope),
      next_cursor: body.next_cursor,
    };
  }

  async cancelStream(sessionId: string, streamId: StreamId): Promise<void> {
    await this.requestVoid(
      `/sessions/${encodeURIComponent(sessionId)}/cancel`,
      "cancel_failed",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_id: streamId }),
      },
    );
  }

  uploadAttachment(sessionId: string, file: File, caption?: string): Promise<AttachmentInfo> {
    const form = new FormData();
    form.append("file", file);
    if (caption) form.append("caption", caption);
    return this.request<AttachmentInfo>(
      `/sessions/${encodeURIComponent(sessionId)}/attachments`,
      { method: "POST", body: form },
    );
  }

  // --- Push devices ---

  getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
    return this.request<VapidPublicKeyResponse>("/devices/push/vapid-public-key");
  }

  registerPushDevice(req: RegisterPushDeviceRequest): Promise<PushDevice> {
    return this.request<PushDevice>("/devices/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  }

  async deletePushDevice(deviceId: string): Promise<void> {
    await this.requestVoid(
      `/devices/push/${encodeURIComponent(deviceId)}`,
      "push_unregister_failed",
      { method: "DELETE" },
    );
  }

  async respondToApproval(
    sessionId: string,
    toolCallId: string,
    decision: "once" | "session" | "always" | "deny",
  ): Promise<void> {
    const res = await fetch(
      this.url(
        `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(toolCallId)}`,
      ),
      this.auth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      }),
    );
    await this.expect(res, res.status === 409 ? "already_resolved" : "approval_failed");
  }

  async *streamEvents(
    sessionId: string,
    cursor: StreamCursor = {},
    signal?: AbortSignal,
  ): AsyncGenerator<EventEnvelope> {
    const params: Record<string, string> = {};
    if (cursor.cursor === "snapshot") params.cursor = "snapshot";
    else if (cursor.cursor === "genesis") params.cursor = "genesis";
    else if (cursor.cursor === "latest") params.cursor = `latest:${cursor.latestN ?? DEFAULT_BACKFILL_COUNT}`;
    else if (cursor.cursor) params.cursor = cursor.cursor;

    const headers: HeadersInit = { Accept: "text/event-stream" };
    if (cursor.lastEventId) {
      (headers as Record<string, string>)["Last-Event-ID"] = cursor.lastEventId;
    }
    const res = await fetch(
      this.url(`/sessions/${encodeURIComponent(sessionId)}/events`, params),
      this.auth({ headers, signal }),
    );
    yield* this.eventsFrom(res, "events_subscribe_failed");
  }

  async *sendMessage(
    sessionId: string,
    req: SendMessageRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<EventEnvelope> {
    const res = await fetch(
      this.url(`/sessions/${encodeURIComponent(sessionId)}/messages`),
      this.auth({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(req),
        signal,
      }),
    );
    yield* this.eventsFrom(res, "send_failed");
  }
}
