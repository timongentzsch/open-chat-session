"""Shared constants, event taxonomy, and small pure helpers."""

import hashlib
import json
import os
import time
import uuid

PLATFORM_NAME = "open_chat_session"
DEFAULT_BIND = "127.0.0.1:8765"
DEFAULT_DATA_DIR = "~/.hermes/data/open-chat-session"
DEFAULT_MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024  # 100 MB

# Wire-format version sent in `/health` and stamped on every EventEnvelope.
# Bump only on a breaking change to the client API (per 07-client-api.md).
GATEWAY_API_VERSION = "2026-05-15"

# Header names. Spec'd in 07-client-api.md "Headers".
HEADER_DEVICE_ID = "X-Device-Id"
HEADER_AUTHORIZATION = "Authorization"
HEADER_LAST_EVENT_ID = "Last-Event-ID"
# Dashboard proxy hands the per-browser stable device id through this header
# so the adapter can suppress pushes for the device viewing the session even
# though every dashboard request shares the proxy-injected X-Device-Id.
HEADER_DEVICE_ID_OVERRIDE = "X-Open-Chat-Session-Device-Id"

_TRUTHY = ("1", "true", "yes", "on")


# Event kinds — single source of truth, mirrors GatewayEventKind in dashboard/src/types.ts
class EventKind:
    SESSION_CREATED = "gateway.session.created"
    SESSION_ARCHIVED = "gateway.session.archived"
    SESSION_METADATA = "gateway.session.metadata.updated"
    MESSAGE_IN = "gateway.message.in"
    MESSAGE_OUT = "gateway.message.out"
    MESSAGE_EDIT = "gateway.message.edit"
    MESSAGE_CANCEL = "gateway.message.cancel.requested"
    APPROVAL_REQUEST = "gateway.approval.request"
    APPROVAL_RESOLVED = "gateway.approval.resolved"
    CLARIFY_REQUEST = "gateway.clarify.request"
    CLARIFY_RESOLVED = "gateway.clarify.resolved"
    ATTACHMENT_UPLOADED = "gateway.attachment.uploaded"
    TYPING = "gateway.typing"
    ERROR = "gateway.error"
    IMAGE = "gateway.image"
    VIDEO = "gateway.video"
    ANIMATION = "gateway.animation"
    DOCUMENT = "gateway.document"
    VOICE = "gateway.voice"
    RESYNC = "gateway.resync"


def _redact_identity(identity: str | None) -> str:
    """Mask a caller identity for log lines.

    Required by 03-interfaces.md "Log Hygiene": `Authorization` bearer tokens,
    `X-Device-Id` values, and `tailscale whois` logins must not appear in
    cleartext in any log line. We keep enough signal (`bearer:` vs `ts:`
    prefix + 8 hex chars of sha256) to correlate sessions across a debug
    session without leaking the raw value.
    """
    if not identity:
        return ""
    if identity.startswith("bearer:"):
        raw = identity[len("bearer:"):]
        digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:8]
        return f"bearer:{digest}"
    if identity.startswith(("system:", "agent")):
        return identity
    digest = hashlib.sha256(identity.encode("utf-8", errors="replace")).hexdigest()[:8]
    return f"ts:{digest}"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


def _canonical_bytes(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _csv_to_list(s: str) -> list[str]:
    if not s:
        return []
    return [p.strip() for p in s.split(",") if p.strip()]


def _parse_bind(bind: str) -> tuple[str, int]:
    if ":" not in bind:
        return "127.0.0.1", int(bind)
    host, port = bind.rsplit(":", 1)
    return host or "127.0.0.1", int(port)


def _conf_str(extra: dict, key: str, env: str, default: str = "") -> str:
    val = extra.get(key) or os.getenv(env) or default
    return str(val) if val else ""


def _conf_bool(extra: dict, key: str, env: str, default: bool) -> bool:
    if key in extra:
        return str(extra[key]).lower() in _TRUTHY
    env_val = os.getenv(env)
    if env_val is not None:
        return env_val.lower() in _TRUTHY
    return default
