// Wire types for the gateway client API (see project README for the contract).

export type Hash = string;
export type SessionId = string;
export type StreamId = string;
export type MessageId = string;
export type AttachmentId = string;
export type ToolCallId = string;
export type Host = string;
export type UnixMs = number;
export type JsonObject = Record<string, unknown>;

export interface SessionInfo {
  session_id: SessionId;
  name: string;
  metadata: JsonObject;
  created_by: Host;
  created_at: UnixMs;
  archived: boolean;
  archived_at?: UnixMs;
  archived_by?: Host;
  parent_session_id?: SessionId;
  tip_seq?: number;
  tip_hash?: Hash;
  event_count?: number;
}

export interface AttachmentRef {
  attachment_id: AttachmentId;
  url: string;
  mime: string;
  size: number;
  sha256: string;
  filename?: string;
  caption?: string;
}

export type AttachmentInfo = AttachmentRef & {
  uploaded_by?: Host;
  uploaded_at?: UnixMs;
};

export type GatewayEventKind =
  | "gateway.session.created"
  | "gateway.session.archived"
  | "gateway.session.metadata.updated"
  | "gateway.message.in"
  | "gateway.message.out"
  | "gateway.message.edit"
  | "gateway.message.cancel.requested"
  | "gateway.typing"
  | "gateway.image"
  | "gateway.video"
  | "gateway.animation"
  | "gateway.document"
  | "gateway.voice"
  | "gateway.approval.request"
  | "gateway.approval.resolved"
  | "gateway.clarify.request"
  | "gateway.clarify.resolved"
  | "gateway.resync"
  | "gateway.error";

export type ClarifyId = string;

export interface EventEnvelope<P = unknown> {
  schema_version: "2026-05-15";
  seq: number;
  hash: Hash;
  prev_hash: Hash | "";
  session_id: SessionId;
  stream_id?: StreamId;
  kind: GatewayEventKind;
  ts: UnixMs;
  payload: P;
}

export interface MessageInPayload {
  message_id: MessageId;
  author: Host;
  text: string;
  attachments: AttachmentRef[];
  reply_to?: MessageId;
  thread_id?: string;
  metadata?: JsonObject;
}

export interface MessageOutPayload {
  message_id: MessageId;
  content: string;
  reply_to?: MessageId;
  metadata?: JsonObject;
}

export interface MessageEditPayload {
  message_id: MessageId;
  content: string;
  finalize: boolean;
}

export interface MessageCancelPayload {
  by: Host;
  stream_id: StreamId;
}

export interface ApprovalRequestPayload {
  tool_call_id: ToolCallId;
  tool_name: string;
  prompt: string;
  command?: string;
  args?: JsonObject;
  choices: ApprovalDecision[];
  expires_at: UnixMs;
}

export interface ApprovalResolvedPayload {
  tool_call_id: ToolCallId;
  decision: ApprovalDecision;
  resolved_by: Host;
  resolved_at: UnixMs;
}

export interface ClarifyRequestPayload {
  clarify_id: ClarifyId;
  session_key: string;
  question: string;
  choices: string[];
  requested_at: UnixMs;
}

export interface ClarifyResolvedPayload {
  clarify_id: ClarifyId;
  response: string;
  resolved_by: Host;
}

export interface TypingPayload {
  active?: boolean;
  message_id?: MessageId;
  metadata?: JsonObject;
}

export interface ResyncPayload {
  reason: string;
  from_seq: number;
  tip_seq?: number;
  tip_hash?: Hash;
  snapshot?: JsonObject;
}

export type ApprovalDecision = "once" | "session" | "always" | "deny";

export interface CreateSessionRequest {
  name?: string;
  metadata?: JsonObject;
}

export interface SendMessageRequest {
  text: string;
  attachments?: Array<AttachmentId | string>;
  reply_to?: MessageId;
  thread_id?: string;
  metadata?: JsonObject;
}

// The gateway sends additional fields; the dashboard only reads `platform`.
export interface HealthResponse {
  ok: true;
  platform: "open_chat_session";
}

export interface SessionsListResponse {
  sessions: SessionInfo[];
}

export interface HistoryResponse {
  events: EventEnvelope[];
  next_cursor?: Hash;
}

// --- Push delivery ---

export type PushPlatform =
  | "web"
  | "ios-home-screen"
  | "macos-safari"
  | "android-chrome";

export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushNotificationPolicy {
  message_in?: boolean;
  message_out?: boolean;
  approvals?: boolean;
  preview_text?: boolean;
  dedupe_ms?: number;
  muted_session_ids?: SessionId[];
}

export interface RegisterPushDeviceRequest {
  device_id: string;
  platform: PushPlatform;
  subscription: PushSubscriptionJson;
  sessions?: SessionId[];
  notification_policy?: PushNotificationPolicy;
}

export interface PushDevice {
  device_id: string;
  platform: PushPlatform;
  endpoint_hash: string;
  created_at: UnixMs;
  updated_at: UnixMs;
}

export interface VapidPublicKeyResponse {
  public_key: string;
}

export type GatewayEvent =
  | { kind: "gateway.message.in"; payload: MessageInPayload }
  | { kind: "gateway.message.out"; payload: MessageOutPayload }
  | { kind: "gateway.message.edit"; payload: MessageEditPayload }
  | { kind: "gateway.message.cancel.requested"; payload: MessageCancelPayload }
  | { kind: "gateway.approval.request"; payload: ApprovalRequestPayload }
  | { kind: "gateway.approval.resolved"; payload: ApprovalResolvedPayload }
  | { kind: "gateway.clarify.request"; payload: ClarifyRequestPayload }
  | { kind: "gateway.clarify.resolved"; payload: ClarifyResolvedPayload }
  | { kind: "gateway.typing"; payload: TypingPayload };
