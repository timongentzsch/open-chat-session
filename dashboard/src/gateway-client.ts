// REST + SSE client for the plugin's reverse proxy at
// `/api/plugins/open-chat-session/*`. The proxy injects gateway auth +
// X-Device-Id server-side; we only forward the dashboard session
// token. Streaming methods yield via async generators — break to
// close via the caller's AbortController.

import { GatewayError } from "./errors";
import { parseSSE } from "./parse-sse";
import type {
  AttachmentInfo,
  CreateSessionRequest,
  EventEnvelope,
  GatewayEventKind,
  HealthResponse,
  HistoryResponse,
  PatchSessionRequest,
  SendMessageRequest,
  SessionInfo,
  SessionsListResponse,
  StreamId,
} from "./types";

// Smooth over wire drift: envelopes may carry `data` instead of `payload`,
// and SSE frames omit `kind` from the JSON body (it lives in the `event:`
// header). REST history is unaffected.
function normalizeEnvelope(raw: any, sseEventKind?: string): EventEnvelope {
  if (raw && raw.payload === undefined && raw.data !== undefined) raw.payload = raw.data;
  if (raw && raw.kind === undefined && sseEventKind) raw.kind = sseEventKind;
  return raw as EventEnvelope;
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
    return { ...init, headers };
  }

  private async expect(res: Response, fallbackCode: string): Promise<void> {
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    let code = fallbackCode;
    let message = body || res.statusText || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      code = parsed?.error?.code ?? parsed?.code ?? code;
      message = parsed?.error?.message ?? parsed?.message ?? message;
    } catch {
      // plain text body
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

  private async *eventsFrom(res: Response, fallbackCode: string): AsyncGenerator<EventEnvelope> {
    await this.expect(res, fallbackCode);
    for await (const frame of parseSSE(res)) {
      if (!frame.data) continue;
      try {
        yield normalizeEnvelope(JSON.parse(frame.data), frame.event);
      } catch {
        // Ignore malformed frames; the next valid one re-anchors via hash chain.
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

  patchSession(sessionId: string, req: PatchSessionRequest): Promise<SessionInfo> {
    return this.request<SessionInfo>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  }

  async archiveSession(sessionId: string): Promise<void> {
    const res = await fetch(
      this.url(`/sessions/${encodeURIComponent(sessionId)}`),
      this.auth({ method: "DELETE" }),
    );
    await this.expect(res, "archive_failed");
  }

  async history(
    sessionId: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<HistoryResponse> {
    const body = await this.request<{ events: any[]; next_cursor?: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/history`,
      undefined,
      { after: opts.after, limit: opts.limit ?? 100 },
    );
    return {
      events: (body.events ?? []).map((raw) => normalizeEnvelope(raw)),
      next_cursor: body.next_cursor,
    };
  }

  async cancelStream(sessionId: string, streamId: StreamId): Promise<void> {
    const res = await fetch(
      this.url(`/sessions/${encodeURIComponent(sessionId)}/cancel`),
      this.auth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_id: streamId }),
      }),
    );
    await this.expect(res, "cancel_failed");
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

  async downloadAttachment(sessionId: string, attachmentId: string): Promise<Blob> {
    const res = await fetch(
      this.url(
        `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
      this.auth(),
    );
    await this.expect(res, "attachment_fetch_failed");
    return res.blob();
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
    else if (cursor.cursor === "latest") params.cursor = `latest:${cursor.latestN ?? 200}`;
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

export type { EventEnvelope, GatewayEventKind } from "./types";
