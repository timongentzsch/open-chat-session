"""
open-chat-session adapter — native HTTP/SSE client surface for Hermes Agent.

Serves /sessions/* REST + SSE on the configured bind address. Runs alongside
Hermes's stock api_server; does NOT expose /v1/* (that surface is unmodified).

Peer identity: Tailscale ``whois`` is the canonical source; bearer-token auth
(``API_SERVER_KEY``) is the fallback for localhost/proxy callers.
"""

import asyncio
import base64
import contextlib
import contextvars
import dataclasses
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import shutil
import sqlite3
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

import httpx
from aiohttp import ClientSession, WSMsgType, web

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig
from gateway.session import build_session_key

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PLATFORM_NAME = "open_chat_session"
DEFAULT_BIND = "127.0.0.1:8765"
DEFAULT_DATA_DIR = "~/.hermes/data/open-chat-session"
DEFAULT_EDGE_BIND = "127.0.0.1:9120"
DEFAULT_EDGE_DASHBOARD_URL = "http://127.0.0.1:9119"
DEFAULT_MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024  # 100 MB
APPROVAL_TIMEOUT_S = 300
APPROVAL_CHOICES = ("once", "session", "always", "deny")
# How long a resolved `tailscale whois` lookup is reused before re-spawning the
# subprocess for the same peer.
WHOIS_CACHE_TTL_S = 5.0
# Page size for paginated log scans (see HashChainedLog.iter_after).
LOG_PAGE_LIMIT = 1000
PUSH_PLATFORMS = ("web", "ios-home-screen", "macos-safari", "android-chrome")
PLUGIN_DASHBOARD_NAME = "open-chat-session"
PLUGIN_DASHBOARD_ROUTE = f"/dashboard-plugins/{PLUGIN_DASHBOARD_NAME}/"
# Web Push payload cap is ~4 KB per RFC 8030; keep our envelope well under.
PUSH_BODY_MAX_CHARS = 140
# Per-(user, session) throttle window; approvals bypass this.
PUSH_DEFAULT_DEDUPE_MS = 5000
# Bound the in-memory push dedupe map. Once it exceeds the threshold, entries
# older than the retention window are evicted; retention sits well above any
# per-device dedupe_ms so an evicted entry could never have produced a hit.
PUSH_LAST_PUSH_SWEEP_THRESHOLD = 256
PUSH_LAST_PUSH_RETENTION_MS = 3_600_000  # 1 hour
# VAPID `sub` contact. Apple Push Service rejects mailto: addresses whose
# TLD isn't deliverable (.local, .localhost, .invalid, .test, .example) with
# `403 BadJwtToken`, silently breaking Safari/iOS subscribers. FCM and Mozilla
# autopush are lenient. The default uses a plausible public-domain address so
# iOS works out of the box; operators can override OPEN_CHAT_SESSION_VAPID_SUBJECT
# to route abuse reports to their own inbox.
PUSH_VAPID_SUBJECT = os.getenv(
    "OPEN_CHAT_SESSION_VAPID_SUBJECT", "mailto:open_chat_session@mail.com",
)
_NON_DELIVERABLE_TLDS = (".local", ".localhost", ".invalid", ".test", ".example")


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


SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}
# Hermes's GatewayStreamConsumer appends this cursor glyph while streaming a
# response. We use its presence/absence to distinguish in-flight `send()`
# from a final non-streamed `send()` that needs a synthetic finalize edit.
# Load-bearing: if hermes ever changes the cursor, the synthetic-finalize
# path in send() breaks.
STREAM_CURSOR_CHAR = "▉"
_TRUTHY = ("1", "true", "yes", "on")
_CURRENT_STREAM_ID: "contextvars.ContextVar[str | None]" = contextvars.ContextVar(
    "open_chat_session_stream_id", default=None,
)

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


def _stream_id(fallback: str) -> str:
    return _CURRENT_STREAM_ID.get() or fallback


def _csv_to_list(s: str) -> list[str]:
    if not s:
        return []
    return [p.strip() for p in s.split(",") if p.strip()]


def _parse_bind(bind: str) -> tuple[str, int]:
    if ":" not in bind:
        return "127.0.0.1", int(bind)
    host, port = bind.rsplit(":", 1)
    return host or "127.0.0.1", int(port)


def _ext_from_mime(mime: str) -> str:
    mapping = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
        "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov",
        "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
        "application/pdf": ".pdf", "text/plain": ".txt",
    }
    return mapping.get(mime, "")


def _resolve_local_ref(ref: str) -> str | None:
    """Return a filesystem path if `ref` resolves to one we should host
    (raw path or `file://` URL); otherwise None. http/https/data/existing
    /sessions/ URLs pass through as remote refs."""
    if not ref:
        return None
    if ref.startswith(("http://", "https://", "data:", "/sessions/")):
        return None
    if ref.startswith("file://"):
        from urllib.parse import urlparse
        parsed = urlparse(ref)
        path = unquote(parsed.path or "")
        return path if path else None
    if ref.startswith(("/", "./")):
        return ref
    return None


_MIME_BY_EXT = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain",
}


def _mime_from_url(url: str) -> str:
    lower = url.lower().split("?", 1)[0]
    dot = lower.rfind(".")
    return _MIME_BY_EXT.get(lower[dot:], "") if dot >= 0 else ""


def _attachment_ref(
    url: str, *,
    mime: str = "", filename: str | None = None,
    caption: str | None = None, size: int = 0, sha256: str = "",
) -> dict:
    """Coerce a media URL into an AttachmentRef dict.

    Hermes can hand us external URLs (DALL-E, S3) where size/sha256
    aren't free. We fill what we can — attachment_id resolved from a
    `/attachments/<id>` path when present, else stable hash of the URL.
    """
    aid = ""
    m = url.rfind("/attachments/")
    if m >= 0:
        tail = url[m + len("/attachments/"):]
        aid = tail.split("/", 1)[0].split("?", 1)[0].split(".", 1)[0]
    if not aid:
        aid = hashlib.sha256(url.encode()).hexdigest()[:32]
    ref = {
        "attachment_id": aid,
        "url": url,
        "mime": mime or _mime_from_url(url),
        "size": size,
        "sha256": sha256 or (aid if size and aid else ""),
    }
    if filename:
        ref["filename"] = filename
    if caption:
        ref["caption"] = caption
    return ref


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


async def _body_json(request) -> dict:
    """Parse request body as JSON; 400 on malformed input."""
    if not request.can_read_body:
        return {}
    try:
        return await request.json()
    except Exception as exc:
        raise web.HTTPBadRequest(reason="invalid JSON body") from exc


# ---------------------------------------------------------------------------
# SessionInfo
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class SessionInfo:
    session_id: str
    name: str
    metadata: dict
    created_by: str
    created_at: int
    archived: bool = False
    parent_session_id: str | None = None
    archived_at: int | None = None
    archived_by: str | None = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class AttachmentInfo:
    attachment_id: str
    mime: str
    size: int
    uploaded_by: str
    uploaded_at: int


# ---------------------------------------------------------------------------
# HashChainedLog
# ---------------------------------------------------------------------------

class HashChainedLog:
    """Append-only, hash-chained event log per session_id, backed by SQLite."""

    # Reads (``tip``, ``lookup_hash``, ``range_after``, ``last_n``,
    # ``known_sessions``) are synchronous and serialized by the asyncio event
    # loop; only ``append`` needs the async lock for ordering across awaits.

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._db: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()
        # session_id -> list of subscriber asyncio.Queue
        self._subs: dict[str, list[asyncio.Queue]] = defaultdict(list)
        # Cross-session subscribers (push dispatcher etc.). Each gets every
        # appended event regardless of session_id.
        self._global_subs: list[asyncio.Queue] = []

    async def open(self):
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                session_id TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                prev_hash  TEXT NOT NULL,
                hash       TEXT NOT NULL,
                stream_id  TEXT NOT NULL,
                kind       TEXT NOT NULL,
                data       BLOB NOT NULL,
                ts         INTEGER NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS events_hash_idx
                ON events(session_id, hash);
            CREATE INDEX IF NOT EXISTS events_stream_idx
                ON events(session_id, stream_id, seq);
            """
        )
        self._db.commit()

    async def close(self):
        if self._db:
            self._db.close()
            self._db = None

    async def append(self, session_id: str, kind: str, stream_id: str, data: dict) -> dict:
        async with self._lock:
            cur = self._db.execute(
                "SELECT seq, hash FROM events "
                "WHERE session_id=? ORDER BY seq DESC LIMIT 1",
                (session_id,),
            )
            row = cur.fetchone()
            if row:
                prev_seq, prev_hash = row
                seq = prev_seq + 1
            else:
                prev_hash = ""
                seq = 1
            ts = _now_ms()
            data_bytes = _canonical_bytes(data)
            event_for_hash = {
                "seq": seq,
                "prev_hash": prev_hash,
                "session_id": session_id,
                "stream_id": stream_id,
                "kind": kind,
                "data": data,
                "ts": ts,
            }
            h = _sha256_hex(_canonical_bytes(event_for_hash))

            self._db.execute(
                "INSERT INTO events (session_id, seq, prev_hash, hash, "
                "stream_id, kind, data, ts) VALUES (?,?,?,?,?,?,?,?)",
                (session_id, seq, prev_hash, h, stream_id, kind,
                 data_bytes, ts),
            )
            self._db.commit()

            event = {**event_for_hash, "hash": h}
            for q in list(self._subs[session_id]):
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    # Flag overflow so _stream_sse drops the connection and the
                    # client resumes by Last-Event-ID (02-protocol.md).
                    q._ocs_overflowed = True
            for q in list(self._global_subs):
                # Push firehose has no client to resume, so stay lossy.
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(event)
            return event

    def subscribe(self, session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        q._ocs_overflowed = False
        self._subs[session_id].append(q)
        return q

    def unsubscribe(self, session_id: str, q: asyncio.Queue):
        with contextlib.suppress(ValueError):
            self._subs[session_id].remove(q)

    def subscribe_all(self) -> asyncio.Queue:
        """Subscribe to every appended event across all sessions.

        Used by background workers (e.g. the push dispatcher) that need a
        firehose view without registering a separate queue per session.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=2048)
        self._global_subs.append(q)
        return q

    def unsubscribe_all(self, q: asyncio.Queue) -> None:
        with contextlib.suppress(ValueError):
            self._global_subs.remove(q)

    def tip(self, session_id: str) -> tuple[int, str] | None:
        cur = self._db.execute(
            "SELECT seq, hash FROM events WHERE session_id=? "
            "ORDER BY seq DESC LIMIT 1",
            (session_id,),
        )
        row = cur.fetchone()
        return (row[0], row[1]) if row else None

    def lookup_hash(self, session_id: str, h: str) -> int | None:
        cur = self._db.execute(
            "SELECT seq FROM events WHERE session_id=? AND hash=?",
            (session_id, h),
        )
        row = cur.fetchone()
        return row[0] if row else None

    def range_after(self, session_id: str, after_seq: int,
                    limit: int = LOG_PAGE_LIMIT) -> list[dict]:
        cur = self._db.execute(
            "SELECT seq, prev_hash, hash, stream_id, kind, data, ts "
            "FROM events WHERE session_id=? AND seq > ? "
            "ORDER BY seq ASC LIMIT ?",
            (session_id, after_seq, limit),
        )
        return [self._row_to_event(session_id, r) for r in cur]

    def iter_after(self, session_id: str, after_seq: int = 0):
        """Yield every event after ``after_seq`` in seq order, paging internally
        so callers are not truncated at the range_after page limit."""
        cursor = after_seq
        while True:
            batch = self.range_after(session_id, cursor, limit=LOG_PAGE_LIMIT)
            if not batch:
                return
            yield from batch
            if len(batch) < LOG_PAGE_LIMIT:
                return
            cursor = batch[-1]["seq"]

    def last_n(self, session_id: str, n: int) -> list[dict]:
        cur = self._db.execute(
            "SELECT seq, prev_hash, hash, stream_id, kind, data, ts "
            "FROM events WHERE session_id=? "
            "ORDER BY seq DESC LIMIT ?",
            (session_id, n),
        )
        rows = list(cur)
        rows.reverse()
        return [self._row_to_event(session_id, r) for r in rows]

    def known_sessions(self) -> list[str]:
        cur = self._db.execute("SELECT DISTINCT session_id FROM events")
        return [r[0] for r in cur]

    @staticmethod
    def _row_to_event(session_id: str, r) -> dict:
        return {
            "seq": r[0],
            "prev_hash": r[1],
            "hash": r[2],
            "session_id": session_id,
            "stream_id": r[3],
            "kind": r[4],
            "data": json.loads(r[5]),
            "ts": r[6],
        }


# ---------------------------------------------------------------------------
# SessionRegistry
# ---------------------------------------------------------------------------

class SessionRegistry:
    """Adapter-owned session list; materialized from log events."""

    def __init__(self, log: HashChainedLog):
        self._log = log
        self._sessions: dict[str, SessionInfo] = {}

    def load_from_log(self):
        for sid in self._log.known_sessions():
            # Page the full history so a late archive/rename past LOG_PAGE_LIMIT
            # is not missed on restart.
            info: SessionInfo | None = None
            for ev in self._log.iter_after(sid, 0):
                if ev["kind"] == EventKind.SESSION_CREATED:
                    d = ev["data"]
                    info = SessionInfo(
                        session_id=sid,
                        name=d.get("name", sid),
                        metadata=d.get("metadata", {}) or {},
                        created_by=d.get("created_by", "unknown"),
                        created_at=ev["ts"],
                        archived=False,
                        parent_session_id=d.get("parent_session_id"),
                    )
                elif info and ev["kind"] == EventKind.SESSION_ARCHIVED:
                    info.archived = True
                    info.archived_at = ev["ts"]
                    info.archived_by = (ev["data"] or {}).get("by")
                elif info and ev["kind"] == EventKind.SESSION_METADATA:
                    patch = ev["data"].get("patch", {}) or {}
                    if "name" in patch:
                        info.name = patch["name"]
                    if "metadata" in patch:
                        info.metadata = patch["metadata"]
            if info:
                self._sessions[sid] = info

    def exists(self, session_id: str) -> bool:
        s = self._sessions.get(session_id)
        return bool(s and not s.archived)

    def has(self, session_id: str) -> bool:
        return session_id in self._sessions

    def get(self, session_id: str) -> SessionInfo:
        return self._sessions[session_id]

    def list(self, include_archived: bool = False) -> list[SessionInfo]:
        return [
            s for s in self._sessions.values()
            if include_archived or not s.archived
        ]

    async def create(self, *, name: str | None, metadata: dict,
                     created_by: str) -> SessionInfo:
        sid = _new_id("s_")
        info = SessionInfo(
            session_id=sid,
            name=name or f"session-{sid[2:8]}",
            metadata=metadata,
            created_by=created_by,
            created_at=_now_ms(),
        )
        await self._log.append(
            sid, EventKind.SESSION_CREATED, sid,
            {
                "name": info.name,
                "metadata": info.metadata,
                "created_by": info.created_by,
            },
        )
        self._sessions[sid] = info
        logger.info(
            "session created sid=%s name=%s by=%s",
            sid, info.name, _redact_identity(created_by),
        )
        return info

    async def archive(self, session_id: str, by: str):
        if session_id not in self._sessions:
            raise KeyError(session_id)
        ts = _now_ms()
        await self._log.append(
            session_id, EventKind.SESSION_ARCHIVED, session_id, {"by": by},
        )
        info = self._sessions[session_id]
        info.archived = True
        info.archived_at = ts
        info.archived_by = by
        logger.info("session archived sid=%s by=%s", session_id, _redact_identity(by))

    async def rename(self, session_id: str, name: str, by: str):
        if session_id not in self._sessions:
            raise KeyError(session_id)
        await self._log.append(
            session_id, EventKind.SESSION_METADATA, session_id,
            {"by": by, "patch": {"name": name}},
        )
        self._sessions[session_id].name = name

    async def update_metadata(self, session_id: str, metadata: dict, by: str):
        if session_id not in self._sessions:
            raise KeyError(session_id)
        await self._log.append(
            session_id, EventKind.SESSION_METADATA, session_id,
            {"by": by, "patch": {"metadata": metadata}},
        )
        self._sessions[session_id].metadata = metadata


# ---------------------------------------------------------------------------
# AttachmentStore
# ---------------------------------------------------------------------------

class AttachmentStore:
    def __init__(self, root: Path, max_size: int = DEFAULT_MAX_ATTACHMENT_SIZE):
        self._root = root
        self._max_size = max_size
        root.mkdir(parents=True, exist_ok=True)
        self._meta_db = sqlite3.connect(
            str(root / "attachments.db"), check_same_thread=False,
        )
        self._meta_db.executescript(
            """
            CREATE TABLE IF NOT EXISTS attachments (
                attachment_id TEXT PRIMARY KEY,
                mime          TEXT NOT NULL,
                size          INTEGER NOT NULL,
                uploaded_by   TEXT NOT NULL,
                uploaded_at   INTEGER NOT NULL,
                ext           TEXT
            );
            """
        )
        self._meta_db.commit()

    async def upload(self, field, uploaded_by: str,
                     mime_hint: str = "application/octet-stream") -> AttachmentInfo:
        h = hashlib.sha256()
        size = 0
        tmp = self._root / f".tmp-{uuid.uuid4().hex}"
        try:
            with open(tmp, "wb") as f:
                while True:
                    chunk = await field.read_chunk(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self._max_size:
                        raise web.HTTPRequestEntityTooLarge(
                            max_size=self._max_size, actual_size=size,
                        )
                    h.update(chunk)
                    f.write(chunk)
            digest = h.hexdigest()
            ext = _ext_from_mime(mime_hint)
            final = self._root / f"{digest}{ext}"
            if final.exists():
                tmp.unlink()
            else:
                tmp.rename(final)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
            raise

        uploaded_at = _now_ms()
        try:
            self._meta_db.execute(
                "INSERT INTO attachments (attachment_id, mime, size, "
                "uploaded_by, uploaded_at, ext) VALUES (?,?,?,?,?,?)",
                (digest, mime_hint, size, uploaded_by, uploaded_at, ext),
            )
            self._meta_db.commit()
        except sqlite3.IntegrityError:
            # dedup — return the original row so uploaded_at / uploaded_by
            # reflect the first upload, not now.
            prior = self.info(digest)
            if prior is not None:
                return prior[0]

        return AttachmentInfo(
            attachment_id=digest, mime=mime_hint, size=size,
            uploaded_by=uploaded_by, uploaded_at=uploaded_at,
        )

    def upload_local(
        self, src_path: str, uploaded_by: str,
        mime_hint: str | None = None,
    ) -> AttachmentInfo:
        """Copy a local file into the store. Used when Hermes sends media via
        ``send_image_file``/``send_voice``/etc. — we host the bytes so the
        dashboard can fetch them through the proxy (Discord-style)."""
        if not os.path.exists(src_path):
            raise FileNotFoundError(src_path)
        size = os.path.getsize(src_path)
        if size > self._max_size:
            raise ValueError(
                f"attachment {src_path} is {size} bytes; max is {self._max_size}",
            )
        if not mime_hint:
            mime_hint, _ = mimetypes.guess_type(src_path)
            mime_hint = mime_hint or "application/octet-stream"
        h = hashlib.sha256()
        with open(src_path, "rb") as f:
            for chunk in iter(lambda: f.read(64 * 1024), b""):
                h.update(chunk)
        digest = h.hexdigest()
        ext = _ext_from_mime(mime_hint) or os.path.splitext(src_path)[1]
        final = self._root / f"{digest}{ext}"
        if not final.exists():
            shutil.copyfile(src_path, final)
        uploaded_at = _now_ms()
        try:
            self._meta_db.execute(
                "INSERT INTO attachments (attachment_id, mime, size, "
                "uploaded_by, uploaded_at, ext) VALUES (?,?,?,?,?,?)",
                (digest, mime_hint, size, uploaded_by, uploaded_at, ext),
            )
            self._meta_db.commit()
        except sqlite3.IntegrityError:
            prior = self.info(digest)
            if prior is not None:
                return prior[0]
        return AttachmentInfo(
            attachment_id=digest, mime=mime_hint, size=size,
            uploaded_by=uploaded_by, uploaded_at=uploaded_at,
        )

    def info(self, attachment_id: str) -> tuple[AttachmentInfo, Path] | None:
        cur = self._meta_db.execute(
            "SELECT mime, size, uploaded_by, uploaded_at, ext "
            "FROM attachments WHERE attachment_id=?",
            (attachment_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        mime, size, uploaded_by, uploaded_at, ext = row
        return (
            AttachmentInfo(
                attachment_id=attachment_id, mime=mime, size=size,
                uploaded_by=uploaded_by, uploaded_at=uploaded_at,
            ),
            self._root / f"{attachment_id}{ext or ''}",
        )


# ---------------------------------------------------------------------------
# Push Delivery
# ---------------------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _endpoint_hash(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


@dataclasses.dataclass
class PushDevice:
    """Persisted push subscription. ``policy`` carries the per-device
    notification_policy from the spec (07-client-api.md:239-247) verbatim."""

    device_id: str
    user_id: str
    endpoint_hash: str
    platform: str
    subscription: dict
    policy: dict
    sessions: list[str] | None
    created_at: int
    updated_at: int

    def to_public(self) -> dict:
        return {
            "device_id": self.device_id,
            "platform": self.platform,
            "endpoint_hash": self.endpoint_hash,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class VapidKey:
    """Load or generate an EC P-256 VAPID keypair for Web Push."""

    def __init__(self, key_path: Path):
        self._path = key_path
        self._vapid = None
        self._public_b64: str = ""

    def load_or_generate(self) -> None:
        from py_vapid import Vapid  # imported lazily so tests can stub
        from cryptography.hazmat.primitives.serialization import (
            Encoding, PublicFormat,
        )

        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._path.exists():
            self._vapid = Vapid.from_file(str(self._path))
        else:
            self._vapid = Vapid()
            self._vapid.generate_keys()
            # Pre-create 0600 so save_key's truncating write never leaves the
            # key briefly world-readable; post-write chmod is belt-and-braces.
            with contextlib.suppress(OSError):
                os.close(os.open(
                    self._path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600,
                ))
            self._vapid.save_key(str(self._path))
            with contextlib.suppress(OSError):
                os.chmod(self._path, 0o600)

        raw = self._vapid.public_key.public_bytes(
            encoding=Encoding.X962, format=PublicFormat.UncompressedPoint,
        )
        self._public_b64 = _b64url(raw)

    @property
    def public_key_b64(self) -> str:
        return self._public_b64

    @property
    def instance(self):
        """Parsed Vapid keypair, reused so pywebpush doesn't re-parse the PEM
        on every send."""
        return self._vapid


class PushStore:
    """SQLite push device registry keyed by (user_id, endpoint_hash)."""

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._db: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    def open(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS push_devices (
                device_id     TEXT NOT NULL,
                user_id       TEXT NOT NULL,
                endpoint_hash TEXT NOT NULL,
                platform      TEXT NOT NULL,
                subscription  BLOB NOT NULL,
                policy        BLOB NOT NULL,
                sessions      BLOB,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                PRIMARY KEY (user_id, endpoint_hash)
            );
            CREATE INDEX IF NOT EXISTS push_devices_user_idx
                ON push_devices(user_id);
            CREATE INDEX IF NOT EXISTS push_devices_device_idx
                ON push_devices(device_id);
            """
        )
        self._migrate_preview_policy()
        self._db.commit()

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    def _migrate_preview_policy(self) -> None:
        rows = self._db.execute("SELECT rowid, policy FROM push_devices").fetchall()
        for rowid, raw in rows:
            policy = json.loads(raw)
            if policy.get("preview_text") is False:
                policy["preview_text"] = True
                self._db.execute(
                    "UPDATE push_devices SET policy=?, updated_at=? WHERE rowid=?",
                    (_canonical_bytes(policy), _now_ms(), rowid),
                )

    async def upsert(
        self, *,
        device_id: str,
        user_id: str,
        platform: str,
        subscription: dict,
        policy: dict,
        sessions: list[str] | None,
    ) -> PushDevice:
        endpoint = subscription.get("endpoint") or ""
        eh = _endpoint_hash(endpoint)
        now = _now_ms()
        async with self._lock:
            cur = self._db.execute(
                "SELECT device_id, created_at FROM push_devices "
                "WHERE user_id=? AND endpoint_hash=?",
                (user_id, eh),
            )
            row = cur.fetchone()
            if row:
                existing_id, created = row
                final_device_id = device_id or existing_id
                self._db.execute(
                    "UPDATE push_devices SET device_id=?, platform=?, "
                    "subscription=?, policy=?, sessions=?, updated_at=? "
                    "WHERE user_id=? AND endpoint_hash=?",
                    (
                        final_device_id, platform,
                        _canonical_bytes(subscription),
                        _canonical_bytes(policy),
                        _canonical_bytes(sessions) if sessions else None,
                        now, user_id, eh,
                    ),
                )
                created_at = created
            else:
                final_device_id = device_id or _new_id("pd_")
                created_at = now
                self._db.execute(
                    "INSERT INTO push_devices (device_id, user_id, "
                    "endpoint_hash, platform, subscription, policy, "
                    "sessions, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        final_device_id, user_id, eh, platform,
                        _canonical_bytes(subscription),
                        _canonical_bytes(policy),
                        _canonical_bytes(sessions) if sessions else None,
                        created_at, now,
                    ),
                )
            self._db.commit()
        return PushDevice(
            device_id=final_device_id, user_id=user_id, endpoint_hash=eh,
            platform=platform, subscription=subscription, policy=policy,
            sessions=sessions, created_at=created_at, updated_at=now,
        )

    async def delete(self, *, user_id: str, device_id: str) -> bool:
        async with self._lock:
            cur = self._db.execute(
                "DELETE FROM push_devices WHERE user_id=? AND device_id=?",
                (user_id, device_id),
            )
            self._db.commit()
            return cur.rowcount > 0

    def _row_to_device(self, row) -> PushDevice:
        return PushDevice(
            device_id=row[0], user_id=row[1], endpoint_hash=row[2],
            platform=row[3],
            subscription=json.loads(row[4]),
            policy=json.loads(row[5]),
            sessions=json.loads(row[6]) if row[6] else None,
            created_at=row[7], updated_at=row[8],
        )

    def all_devices(self) -> list[PushDevice]:
        cur = self._db.execute(
            "SELECT device_id, user_id, endpoint_hash, platform, "
            "subscription, policy, sessions, created_at, updated_at "
            "FROM push_devices"
        )
        return [self._row_to_device(r) for r in cur]

    async def prune_endpoint(self, endpoint_hash: str) -> None:
        async with self._lock:
            self._db.execute(
                "DELETE FROM push_devices WHERE endpoint_hash=?",
                (endpoint_hash,),
            )
            self._db.commit()
        logger.info("pruned stale push endpoint hash=%s", endpoint_hash)


_PUSH_NOTIFY_KINDS = {
    EventKind.MESSAGE_OUT: ("message_out", "New message"),
    EventKind.IMAGE: ("message_out", "Sent an image"),
    EventKind.DOCUMENT: ("message_out", "Sent a file"),
    EventKind.VOICE: ("message_out", "Sent a voice note"),
    EventKind.VIDEO: ("message_out", "Sent a video"),
    EventKind.MESSAGE_IN: ("message_in", "New inbound message"),
    EventKind.APPROVAL_REQUEST: ("approvals", "Approval required"),
}


def _truncate(text: str, limit: int = PUSH_BODY_MAX_CHARS) -> str:
    text = (text or "").strip().replace("\n", " ")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


class PushDispatcher:
    """Background worker translating log events to Web Push deliveries."""

    def __init__(
        self,
        *,
        log: HashChainedLog,
        store: PushStore,
        vapid,
        vapid_subject: str,
        session_registry: SessionRegistry,
        active_views: dict[tuple[str, str, str], int],
    ) -> None:
        self._log = log
        self._store = store
        self._vapid = vapid
        self._vapid_subject = vapid_subject
        self._sessions = session_registry
        self._active_views = active_views
        self._queue: asyncio.Queue | None = None
        self._task: asyncio.Task | None = None
        # last-push timestamp per (user_id, session_id) for dedupe.
        self._last_push: dict[tuple[str, str], int] = {}
        # per-user unread count, surfaced as app_badge; reset when the user
        # themselves sends a message (their `message.in` event).
        self._unread: dict[str, int] = {}

    def start(self) -> None:
        if self._task is not None:
            return
        self._queue = self._log.subscribe_all()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None
        if self._queue is not None:
            self._log.unsubscribe_all(self._queue)
            self._queue = None

    async def _run(self) -> None:
        assert self._queue is not None
        while True:
            try:
                event = await self._queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._dispatch(event)
            except Exception:
                logger.exception("push dispatch failed for event %s",
                                 event.get("hash", "?"))

    def _select_targets(
        self, event: dict
    ) -> tuple[list[tuple[PushDevice, str, str]], set[str]]:
        kind = event["kind"]
        spec = _PUSH_NOTIFY_KINDS.get(kind)
        if spec is None:
            return [], set()
        policy_key, redacted_body = spec
        sid = event["session_id"]
        session_info = (
            self._sessions.get(sid) if self._sessions.has(sid) else None
        )
        session_name = session_info.name if session_info else sid
        targets: list[tuple[PushDevice, str, str]] = []
        suppressed_user_ids: set[str] = set()
        for device in self._store.all_devices():
            policy = device.policy or {}
            # If this gateway user has the session open on any dashboard
            # client, treat it like Discord foreground chat and don't fan out
            # background notifications to their other subscribed devices.
            if self._has_active_view(device.user_id, sid):
                suppressed_user_ids.add(device.user_id)
                continue
            if (
                policy.get(policy_key) is False
                or sid in (policy.get("muted_session_ids") or ())
                or (device.sessions and sid not in device.sessions)
            ):
                continue
            if kind != EventKind.APPROVAL_REQUEST:
                dedupe_ms = int(policy.get("dedupe_ms") or PUSH_DEFAULT_DEDUPE_MS)
                key = (device.user_id, sid)
                if dedupe_ms > 0 and event["ts"] - self._last_push.get(key, 0) < dedupe_ms:
                    continue
            body = redacted_body
            if policy.get("preview_text") and (preview := _preview_for_kind(event)):
                body = _truncate(preview)
            targets.append((device, session_name, body))
        return targets, suppressed_user_ids

    def _has_active_view(self, user_id: str, session_id: str) -> bool:
        return any(
            uid == user_id and sid == session_id and count > 0
            for (uid, sid, _device_id), count in self._active_views.items()
        )

    def _build_payload(
        self, *,
        title: str, body: str, session_id: str, app_badge: str | None = None,
    ) -> bytes:
        navigate = f"/chat-session?resume={session_id}"
        notification: dict[str, Any] = {
            "title": title,
            "body": body,
            "navigate": navigate,
            "silent": False,
            "lang": "en",
            "dir": "auto",
        }
        if app_badge is not None:
            notification["app_badge"] = app_badge
        return json.dumps({
            "web_push": 8030,
            "notification": notification,
            "title": title,
            "body": body,
            "session_id": session_id,
            "app_badge": app_badge,
        }, separators=(",", ":")).encode("utf-8")

    async def _dispatch(self, event: dict) -> None:
        sid = event["session_id"]
        now = event["ts"]
        # Bound the dedupe map (entries past the retention window can't hit).
        if len(self._last_push) > PUSH_LAST_PUSH_SWEEP_THRESHOLD:
            cutoff = now - PUSH_LAST_PUSH_RETENTION_MS
            self._last_push = {
                k: ts for k, ts in self._last_push.items() if ts >= cutoff
            }
        if event["kind"] == EventKind.MESSAGE_IN:
            if author := (event.get("data") or {}).get("author"):
                self._unread.pop(author, None)
        targets, suppressed_user_ids = self._select_targets(event)
        for uid in suppressed_user_ids:
            self._unread.pop(uid, None)
        if not targets:
            return
        # app_badge is per-user: one proposed count per user, reused across that
        # user's devices (per-device increment would inflate it to N).
        proposed: dict[str, int] = {}
        for device, title, body in targets:
            uid = device.user_id
            if uid not in proposed:
                proposed[uid] = self._unread.get(uid, 0) + 1
            proposed_count = proposed[uid]
            payload = self._build_payload(
                title=title, body=body, session_id=sid,
                app_badge=str(proposed_count),
            )
            self._last_push[(uid, sid)] = now
            try:
                await asyncio.to_thread(self._send_one, device, payload)
                self._unread[uid] = proposed_count
                logger.debug(
                    "push sent device=%s sid=%s",
                    _redact_identity(device.device_id), sid,
                )
            except _PushGone as exc:
                logger.info(
                    "pruning push device %s (endpoint gone: %s)",
                    _redact_identity(device.device_id), exc,
                )
                await self._store.prune_endpoint(device.endpoint_hash)
            except Exception:
                logger.exception(
                    "push send failed for device %s",
                    _redact_identity(device.device_id),
                )

    def _send_one(self, device: PushDevice, payload: bytes) -> None:
        from pywebpush import webpush, WebPushException

        try:
            webpush(
                subscription_info=device.subscription,
                data=payload,
                # Parsed instance: pywebpush reuses it instead of re-parsing PEM.
                vapid_private_key=self._vapid,
                vapid_claims={"sub": self._vapid_subject},
                content_encoding="aes128gcm",
                ttl=300,
                headers={"Topic": device.endpoint_hash[:32]},
            )
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None) if exc.response else None
            if status in (404, 410):
                raise _PushGone(f"HTTP {status}") from exc
            raise


def _preview_for_kind(event: dict) -> str:
    data = event.get("data") or {}
    kind = event["kind"]
    if kind in (
        EventKind.MESSAGE_OUT, EventKind.MESSAGE_IN, EventKind.IMAGE,
        EventKind.DOCUMENT, EventKind.VOICE, EventKind.VIDEO,
    ):
        return data.get("content") or data.get("text") or data.get("caption") or ""
    if kind == EventKind.APPROVAL_REQUEST:
        prompt = data.get("prompt") or ""
        tool = data.get("tool_name") or "tool"
        return f"{tool}: {prompt}" if prompt else f"approval for {tool}"
    return ""


class _PushGone(Exception):
    """Marker raised when a push endpoint returns 404/410 (gone)."""


# ---------------------------------------------------------------------------
# Tailnet edge
# ---------------------------------------------------------------------------

_HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class TailnetEdge:
    """Local reverse proxy for Tailscale Serve.

    Tailscale should publish this listener, not the Hermes dashboard directly.
    The edge rewrites the upstream Host header to loopback so Hermes' dashboard
    DNS-rebinding guard stays intact, and it serves this plugin's dashboard
    files itself so PWA assets do not rely on host edits.
    """

    def __init__(self, bind: str, dashboard_url: str, dashboard_dir: Path):
        self._bind = bind
        self._dashboard_url = dashboard_url.rstrip("/")
        self._dashboard_dir = dashboard_dir.resolve()
        self._dashboard_host = urlsplit(self._dashboard_url).netloc
        self._app = web.Application(client_max_size=DEFAULT_MAX_ATTACHMENT_SIZE * 2)
        self._app.router.add_route("*", "/{path:.*}", self._handle)
        self._client: ClientSession | None = None
        self._http: httpx.AsyncClient | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.BaseSite | None = None

    async def start(self) -> None:
        self._client = ClientSession(auto_decompress=False)
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(5.0, read=None))
        self._runner = web.AppRunner(self._app, access_log=None)
        await self._runner.setup()
        host, port = _parse_bind(self._bind)
        self._site = web.TCPSite(self._runner, host=host, port=port)
        await self._site.start()
        logger.info(
            "open-chat-session tailnet edge listening on %s:%s -> %s",
            host, port, self._dashboard_url,
        )

    async def stop(self) -> None:
        if self._site:
            with contextlib.suppress(Exception):
                await self._site.stop()
        if self._runner:
            with contextlib.suppress(Exception):
                await self._runner.cleanup()
        if self._client:
            with contextlib.suppress(Exception):
                await self._client.close()
        if self._http:
            with contextlib.suppress(Exception):
                await self._http.aclose()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        if request.path.startswith(PLUGIN_DASHBOARD_ROUTE):
            return self._serve_dashboard_asset(request)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await self._proxy_websocket(request)
        return await self._proxy_http(request)

    def _serve_dashboard_asset(self, request: web.Request) -> web.FileResponse:
        rel = request.path[len(PLUGIN_DASHBOARD_ROUTE):].lstrip("/")
        target = (self._dashboard_dir / unquote(rel)).resolve()
        if not target.is_relative_to(self._dashboard_dir):
            raise web.HTTPForbidden(reason="path traversal blocked")
        if not target.is_file():
            raise web.HTTPNotFound(reason="file not found")

        headers = {}
        if target.name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
            headers["Cache-Control"] = "no-store"
        elif target.name == "manifest.json":
            headers["Cache-Control"] = "no-store"

        media_type = {
            ".js": "application/javascript",
            ".mjs": "application/javascript",
            ".css": "text/css",
            ".json": "application/manifest+json" if target.name == "manifest.json" else "application/json",
            ".webmanifest": "application/manifest+json",
            ".html": "text/html",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
        }.get(target.suffix.lower(), "application/octet-stream")
        headers["Content-Type"] = media_type
        return web.FileResponse(target, headers=headers)

    def _upstream_headers(self, request: web.Request) -> dict[str, str]:
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in _HOP_BY_HOP_HEADERS
        }
        headers["Host"] = self._dashboard_host
        headers["X-Forwarded-Host"] = request.headers.get("host", "")
        headers["X-Forwarded-Proto"] = "https"
        return headers

    def _upstream_url(self, request: web.Request, *, websocket: bool = False) -> str:
        base = self._dashboard_url
        if websocket:
            if base.startswith("https://"):
                base = "wss://" + base[len("https://"):]
            elif base.startswith("http://"):
                base = "ws://" + base[len("http://"):]
        return f"{base}{request.raw_path}"

    async def _proxy_http(self, request: web.Request) -> web.StreamResponse:
        if self._http is None:
            raise web.HTTPServiceUnavailable(reason="tailnet edge not started")
        try:
            upstream_cm = self._http.stream(
                request.method,
                self._upstream_url(request),
                headers=self._upstream_headers(request),
                content=await request.read(),
                follow_redirects=False,
            )
        except Exception as exc:
            logger.warning("tailnet edge dashboard proxy failed: %s", exc)
            raise web.HTTPBadGateway(reason="dashboard unreachable") from exc

        try:
            async with upstream_cm as upstream:
                headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP_HEADERS
                }
                response = web.StreamResponse(
                    status=upstream.status_code,
                    reason=upstream.reason_phrase,
                    headers=headers,
                )
                # Once prepare() flushes headers a fresh 502 is impossible, so a
                # mid-stream failure logs and aborts; only a pre-prepare failure
                # becomes HTTPBadGateway (outer except).
                await response.prepare(request)
                try:
                    async for chunk in upstream.aiter_raw():
                        await response.write(chunk)
                    await response.write_eof()
                except Exception as exc:
                    logger.warning(
                        "tailnet edge dashboard proxy aborted mid-stream: %s",
                        exc,
                    )
                return response
        except Exception as exc:
            logger.warning("tailnet edge dashboard proxy failed: %s", exc)
            raise web.HTTPBadGateway(reason="dashboard unreachable") from exc

    async def _proxy_websocket(self, request: web.Request) -> web.WebSocketResponse:
        if self._client is None:
            raise web.HTTPServiceUnavailable(reason="tailnet edge not started")
        browser_ws = web.WebSocketResponse()
        await browser_ws.prepare(request)
        try:
            upstream_ws = await self._client.ws_connect(
                self._upstream_url(request, websocket=True),
                headers=self._upstream_headers(request),
                autoping=True,
            )
        except Exception as exc:
            logger.warning("tailnet edge websocket proxy failed: %s", exc)
            await browser_ws.close(code=1011, message=b"dashboard unreachable")
            return browser_ws

        async with upstream_ws:
            async def browser_to_upstream() -> None:
                async for msg in browser_ws:
                    if msg.type == WSMsgType.TEXT:
                        await upstream_ws.send_str(msg.data)
                    elif msg.type == WSMsgType.BINARY:
                        await upstream_ws.send_bytes(msg.data)
                    elif msg.type == WSMsgType.CLOSE:
                        await upstream_ws.close()

            async def upstream_to_browser() -> None:
                async for msg in upstream_ws:
                    if msg.type == WSMsgType.TEXT:
                        await browser_ws.send_str(msg.data)
                    elif msg.type == WSMsgType.BINARY:
                        await browser_ws.send_bytes(msg.data)
                    elif msg.type == WSMsgType.CLOSE:
                        await browser_ws.close()

            tasks = [
                asyncio.create_task(browser_to_upstream()),
                asyncio.create_task(upstream_to_browser()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                with contextlib.suppress(Exception):
                    task.result()
        return browser_ws

# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------

def _sse_event(event_payload: dict) -> bytes:
    """SSE wire bytes for a logged hash-chain event (includes id: <hash>)."""
    body = _wire_event(event_payload)
    return (
        f"id: {event_payload['hash']}\n"
        f"event: {event_payload['kind']}\n"
        f"data: {json.dumps(body)}\n\n"
    ).encode()


def _sse_simple(event: str, data: dict) -> bytes:
    """SSE wire bytes for an ad-hoc event that doesn't go into the log."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def _wire_event(event_payload: dict) -> dict:
    # Stamp schema_version on wire output only (not the hashed event), so the
    # required EventEnvelope.schema_version is present without touching the chain.
    event = dict(event_payload)
    event["payload"] = event.pop("data", {})
    event["schema_version"] = GATEWAY_API_VERSION
    return event


async def _prepare_sse(request: web.Request) -> web.StreamResponse:
    resp = web.StreamResponse(headers=SSE_HEADERS)
    await resp.prepare(request)
    return resp


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

class _ApprovalRail:
    """Pending + resolved approval state for one adapter instance.

    First-responder-wins (02-protocol.md "Approval Decisions"): a pending
    approval is popped atomically on resolve; a later POST against the same
    tool_call_id returns the stored resolution so the handler can answer 409.
    """

    def __init__(self) -> None:
        # tool_call_id -> {"session_key": str, "stream_id": str}
        self._pending: dict[str, dict] = {}
        # tool_call_id -> {"decision": str, "by": str, "sid": str, "ts": int}
        self._resolved: dict[str, dict] = {}

    def register(self, tool_call_id: str, *, session_key: str, stream_id: str) -> None:
        self._pending[tool_call_id] = {
            "session_key": session_key,
            "stream_id": stream_id,
        }

    def get_resolved(self, tool_call_id: str) -> dict | None:
        return self._resolved.get(tool_call_id)

    def resolve(
        self, tool_call_id: str, *,
        decision: str, by: str, sid: str, ts: int,
    ) -> dict | None:
        """Pop the pending entry and record the resolution.

        Returns the popped pending entry, or ``None`` if no such approval is
        pending (caller answers 404).
        """
        pending = self._pending.pop(tool_call_id, None)
        if pending is None:
            return None
        self._resolved[tool_call_id] = {
            "decision": decision,
            "by": by,
            "sid": sid,
            "ts": ts,
        }
        return pending


class OpenChatSessionAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH: int = 0
    REQUIRES_EDIT_FINALIZE: bool = True

    def __init__(self, config: PlatformConfig):
        # Platform("open_chat_session") only works after register(ctx) populated
        # the platform_registry. PluginManager calls register() before
        # adapter_factory(), so this is safe in normal flow.
        super().__init__(config, Platform(PLATFORM_NAME))

        # Force shared-context session derivation. Hermes reads these from
        # config.extra at build_session_key time; the base default would give
        # per-user sessions within a chat.
        extra = getattr(config, "extra", None)
        if extra is None:
            extra = {}
            try:
                config.extra = extra
            except AttributeError as exc:
                logger.warning("could not set config.extra: %s", exc)
        extra["group_sessions_per_user"] = False
        extra["thread_sessions_per_user"] = False

        self._bind = _conf_str(
            extra, "bind", "OPEN_CHAT_SESSION_BIND", DEFAULT_BIND,
        )
        self._edge_enabled = _conf_bool(
            extra, "edge_enabled", "OPEN_CHAT_SESSION_EDGE_ENABLED", default=True,
        )
        self._edge_bind = _conf_str(
            extra, "edge_bind", "OPEN_CHAT_SESSION_EDGE_BIND", DEFAULT_EDGE_BIND,
        )
        self._edge_dashboard_url = _conf_str(
            extra,
            "edge_dashboard_url",
            "OPEN_CHAT_SESSION_EDGE_DASHBOARD_URL",
            DEFAULT_EDGE_DASHBOARD_URL,
        )
        allowed_raw = extra.get("allowed_hosts") or os.getenv(
            "OPEN_CHAT_SESSION_ALLOWED_HOSTS", "",
        )
        if isinstance(allowed_raw, str):
            self._allowed_hosts = set(_csv_to_list(allowed_raw))
        else:
            self._allowed_hosts = set(allowed_raw or [])
        self._data_dir = Path(os.path.expanduser(_conf_str(
            extra, "data_dir", "OPEN_CHAT_SESSION_DATA_DIR", DEFAULT_DATA_DIR,
        )))
        self._api_server_key = _conf_str(
            extra, "api_server_key", "API_SERVER_KEY",
        )
        self._auto_default = _conf_bool(
            extra, "auto_create_default_session",
            "OPEN_CHAT_SESSION_AUTO_DEFAULT_SESSION", default=True,
        )

        self._log = HashChainedLog(self._data_dir / "log.db")
        self._sessions = SessionRegistry(self._log)
        self._attachments = AttachmentStore(self._data_dir / "attachments")
        self._vapid = VapidKey(self._data_dir / "vapid.pem")
        self._push = PushStore(self._data_dir / "push.db")
        self._push_dispatcher: "PushDispatcher | None" = None
        # (user_id, session_id, client_device_id) -> live SSE viewer count.
        # Dashboard auth is server-side, while push subscriptions are browser
        # device ids. Suppress only the device actively viewing the session.
        self._active_views: dict[tuple[str, str, str], int] = {}

        self._approvals = _ApprovalRail()
        # session_id -> FIFO list of pending clarify_ids. Lets us emit a
        # gateway.clarify.resolved event the moment a user reply arrives so
        # the dashboard's ClarifyBubble disappears immediately (the actual
        # agent-thread unblock is handled by gateway/run.py's text-intercept).
        self._active_clarify_ids: dict[str, list[str]] = {}
        # (session_id, outbound_message_id) -> inbound stream id
        self._message_streams: dict[tuple[str, str], str] = {}
        # (session_id, inbound_stream_id) -> active Hermes dispatch task.
        # This makes /cancel an actual run cancellation path instead of only
        # an audit-log marker.
        self._active_runs: dict[tuple[str, str], asyncio.Task] = {}
        # Strong refs to fire-and-forget approval auto-deny timers so the loop's
        # weak refs can't GC them mid-flight.
        self._timeout_tasks: set[asyncio.Task] = set()
        # peer_ip -> (monotonic_expiry, (login, tags)); bounds whois subprocess
        # spawns to ~1 per peer per TTL, even on unauthenticated /health.
        self._whois_cache: dict[str, tuple[float, tuple[str | None, list[str]]]] = {}

        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.BaseSite | None = None
        self._edge: TailnetEdge | None = None

    # --- lifecycle ---

    async def connect(self) -> bool:
        await self._log.open()
        self._sessions.load_from_log()
        if self._auto_default and not self._sessions.list():
            await self._sessions.create(
                name="General", metadata={}, created_by="system",
            )

        # Push infrastructure: VAPID keypair on disk + push_devices store +
        # background dispatcher subscribed to every session's event stream.
        try:
            self._vapid.load_or_generate()
            self._push.open()
            # Warn on a VAPID subject Apple will reject. We don't fail because
            # FCM/Mozilla accept the placeholder fine; only Safari/iOS break.
            sub = PUSH_VAPID_SUBJECT.lower()
            domain = sub.partition("@")[2] if sub.startswith("mailto:") else ""
            if any(domain.endswith(tld) for tld in _NON_DELIVERABLE_TLDS):
                logger.warning(
                    "OPEN_CHAT_SESSION_VAPID_SUBJECT=%r uses a non-deliverable TLD; "
                    "Apple Push Service will reject Safari/iOS subscribers with "
                    "'BadJwtToken'. Set it to a real mailto: or https:// URL.",
                    PUSH_VAPID_SUBJECT,
                )
            self._push_dispatcher = PushDispatcher(
                log=self._log,
                store=self._push,
                vapid=self._vapid.instance,
                vapid_subject=PUSH_VAPID_SUBJECT,
                session_registry=self._sessions,
                active_views=self._active_views,
            )
            self._push_dispatcher.start()
        except Exception:
            logger.exception(
                "push delivery init failed; /devices/push endpoints disabled",
            )
            self._push_dispatcher = None

        self._app = web.Application(
            client_max_size=DEFAULT_MAX_ATTACHMENT_SIZE * 2,
        )
        r = self._app.router
        r.add_get("/health", self._handle_health)
        r.add_get("/sessions", self._handle_sessions_list)
        r.add_post("/sessions", self._handle_sessions_create)
        r.add_patch("/sessions/{session_id}", self._handle_sessions_patch)
        r.add_delete("/sessions/{session_id}", self._handle_sessions_delete)
        r.add_get("/sessions/{session_id}/events",
                  self._handle_session_events)
        r.add_post("/sessions/{session_id}/messages",
                   self._handle_session_message)
        r.add_post("/sessions/{session_id}/cancel",
                   self._handle_session_cancel)
        r.add_post("/sessions/{session_id}/approvals/{tool_call_id}",
                   self._handle_approval)
        r.add_post("/sessions/{session_id}/attachments",
                   self._handle_attachment_upload)
        r.add_get("/sessions/{session_id}/attachments/{attachment_id}",
                  self._handle_attachment_download)
        r.add_get("/sessions/{session_id}/history", self._handle_history)
        r.add_get("/devices/push/vapid-public-key",
                  self._handle_push_vapid_public_key)
        r.add_post("/devices/push", self._handle_push_register)
        r.add_delete("/devices/push/{device_id}",
                     self._handle_push_unregister)

        self._runner = web.AppRunner(self._app, access_log=None)
        await self._runner.setup()
        host, port = _parse_bind(self._bind)
        self._site = web.TCPSite(self._runner, host=host, port=port)
        await self._site.start()
        logger.info("open-chat-session listening on %s:%s", host, port)

        if self._edge_enabled:
            self._edge = TailnetEdge(
                bind=self._edge_bind,
                dashboard_url=self._edge_dashboard_url,
                dashboard_dir=Path(__file__).parent / "dashboard",
            )
            try:
                await self._edge.start()
            except Exception:
                logger.exception(
                    "tailnet edge init failed; publish the Hermes dashboard "
                    "directly only if you accept host-level configuration",
                )
                self._edge = None
        return True

    async def disconnect(self) -> None:
        for timer in list(self._timeout_tasks):
            timer.cancel()
        for timer in list(self._timeout_tasks):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await timer
        self._timeout_tasks.clear()
        if self._edge is not None:
            with contextlib.suppress(Exception):
                await self._edge.stop()
        if self._push_dispatcher is not None:
            with contextlib.suppress(Exception):
                await self._push_dispatcher.stop()
        with contextlib.suppress(Exception):
            self._push.close()
        if self._site:
            with contextlib.suppress(Exception):
                await self._site.stop()
        if self._runner:
            with contextlib.suppress(Exception):
                await self._runner.cleanup()
        await self._log.close()

    # --- required egress (BasePlatformAdapter) ---

    async def send(self, chat_id, content, reply_to=None,
                   metadata=None) -> SendResult:
        session_id = chat_id
        message_id = _new_id("o_")
        stream_id = _stream_id(message_id)
        if stream_id != message_id:
            self._message_streams[(session_id, message_id)] = stream_id
        await self._log.append(
            session_id, EventKind.MESSAGE_OUT, stream_id,
            {
                "message_id": message_id,
                "content": content,
                "reply_to": reply_to,
                "metadata": metadata or {},
            },
        )
        # Synthetic finalize: any send() whose content isn't an in-stream
        # cursor-tailed chunk is a complete message. Without this, one-shot
        # system notices (no follow-up edit_message) render with the
        # streaming cursor stuck on forever.
        if not str(content).endswith(STREAM_CURSOR_CHAR):
            await self._log.append(
                session_id, EventKind.MESSAGE_EDIT, stream_id,
                {
                    "message_id": message_id,
                    "content": content,
                    "finalize": True,
                },
            )
            self._message_streams.pop((session_id, message_id), None)
        return SendResult(success=True, message_id=message_id)

    async def edit_message(self, chat_id, message_id, content, *,
                           finalize: bool = False) -> SendResult:
        session_id = chat_id
        key = (session_id, message_id)
        stream_id = (
            self._message_streams.get(key)
            or _stream_id(message_id)
        )
        await self._log.append(
            session_id, EventKind.MESSAGE_EDIT, stream_id,
            {
                "message_id": message_id,
                "content": content,
                "finalize": finalize,
            },
        )
        if finalize:
            self._message_streams.pop(key, None)
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id, metadata=None) -> None:
        # `active: true` matches the documented gateway.typing payload; there is
        # no active:false event — clients expire typing via a client-side TTL.
        await self._log.append(
            chat_id, EventKind.TYPING, _stream_id("typing"),
            {"active": True, "metadata": metadata or {}},
        )

    # Media egress — emits `{message_id, attachments: AttachmentRef[],
    # caption?, reply_to?}`. Local file paths are hosted in the
    # AttachmentStore so the dashboard can fetch them through the proxy;
    # external URLs pass through.

    async def send_image(self, chat_id, image_url, caption=None,
                         reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, EventKind.IMAGE, [image_url],
            caption=caption, reply_to=reply_to,
        )

    async def send_image_file(self, chat_id, image_path, caption=None,
                              reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, EventKind.IMAGE, [str(image_path)],
            caption=caption, reply_to=reply_to,
        )

    async def send_multiple_images(self, chat_id, images, caption=None,
                                   reply_to=None, metadata=None, **_) -> SendResult:
        # Base contract: images is List[Tuple[url, alt_text]] (or
        # List[str] for some callers). Normalise to a flat list of refs;
        # alt_text is dropped (we don't render it on the dashboard).
        refs = [
            (item[0] if isinstance(item, (list, tuple)) else item)
            for item in images
        ]
        return await self._emit_media(
            chat_id, EventKind.IMAGE, refs,
            caption=caption, reply_to=reply_to,
        )

    async def send_video(self, chat_id, video_url=None, caption=None,
                         reply_to=None, metadata=None,
                         video_path=None, **_) -> SendResult:
        ref = video_url or video_path
        if not ref:
            return SendResult(success=False, error="missing video path")
        return await self._emit_media(
            chat_id, EventKind.VIDEO, [str(ref)],
            caption=caption, reply_to=reply_to,
        )

    async def send_animation(self, chat_id, animation_url, caption=None,
                             reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, EventKind.ANIMATION, [animation_url],
            caption=caption, reply_to=reply_to,
        )

    async def send_document(self, chat_id, document_url=None, caption=None,
                            file_name=None, filename=None,
                            reply_to=None, metadata=None,
                            file_path=None, **_) -> SendResult:
        ref = document_url or file_path
        if not ref:
            return SendResult(success=False, error="missing document path")
        name = file_name or filename or os.path.basename(str(ref))
        return await self._emit_media(
            chat_id, EventKind.DOCUMENT, [str(ref)],
            caption=caption, reply_to=reply_to,
            filename=name,
        )

    async def send_voice(self, chat_id, audio_path, caption=None,
                         reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, EventKind.VOICE, [str(audio_path)],
            caption=caption, reply_to=reply_to,
        )

    async def _resolve_media_ref(
        self, chat_id: str, ref: str,
        *, filename: str | None = None, caption: str | None = None,
        uploaded_by: str = "agent",
    ) -> dict:
        """AttachmentRef for a media ref. Local paths (raw or `file://`) are
        uploaded into the AttachmentStore so the dashboard can fetch them
        through the proxy; http(s)/data/`/sessions/...` URLs pass through."""
        local_path = _resolve_local_ref(ref)
        if local_path:
            try:
                # Offload: upload_local does blocking IO + sha256 + copy up to
                # the 100 MB cap, which would otherwise stall the event loop.
                info = await asyncio.to_thread(
                    self._attachments.upload_local, local_path,
                    uploaded_by=uploaded_by,
                )
            except Exception as exc:
                logger.warning("upload_local failed for %s: %s", ref, exc)
                return _attachment_ref(ref, filename=filename, caption=caption)
            return {
                "attachment_id": info.attachment_id,
                "url": f"/sessions/{chat_id}/attachments/{info.attachment_id}",
                "mime": info.mime,
                "size": info.size,
                "sha256": info.attachment_id,
                **({"filename": filename} if filename else {}),
                **({"caption": caption} if caption else {}),
            }
        return _attachment_ref(ref, filename=filename, caption=caption)

    async def _emit_media(
        self, chat_id: str, kind: str, refs: list[str],
        *, caption: str | None = None, reply_to: str | None = None,
        filename: str | None = None,
    ) -> SendResult:
        message_id = _new_id("o_")
        stream_id = _stream_id(message_id)
        # Sequential awaits (not gather): preserve order + serialize sqlite.
        attachments = [
            await self._resolve_media_ref(
                chat_id, r, filename=filename, caption=caption,
            )
            for r in refs if r
        ]
        payload: dict[str, Any] = {"message_id": message_id, "attachments": attachments}
        if caption:
            payload["caption"] = caption
        if reply_to:
            payload["reply_to"] = reply_to
        await self._log.append(chat_id, kind, stream_id, payload)
        return SendResult(success=True, message_id=message_id)

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: list | None,
        clarify_id: str,
        session_key: str,
        metadata: dict | None = None,
    ) -> SendResult:
        """Hermes hook: a tool wants the user to pick from a list of choices.

        Emits a ``gateway.clarify.request`` event with the structured payload
        instead of the base class's plain-text fallback. The dashboard renders
        each choice as a button. A button click POSTs the choice as a normal
        user message; gateway/run.py's ``_maybe_intercept_clarify_text`` then
        resolves the clarify and unblocks the agent thread. We also call
        ``mark_awaiting_text`` so users without buttons (other SSE consumers)
        can still type a reply.
        """
        from tools.clarify_gateway import mark_awaiting_text

        clean_choices = [
            str(c).strip()
            for c in (choices or [])
            if c is not None and str(c).strip()
        ]
        mark_awaiting_text(clarify_id)
        self._active_clarify_ids.setdefault(chat_id, []).append(clarify_id)
        stream_id = _stream_id(clarify_id)
        await self._log.append(
            chat_id, EventKind.CLARIFY_REQUEST, stream_id,
            {
                "clarify_id": clarify_id,
                "session_key": session_key,
                "question": str(question or ""),
                "choices": clean_choices,
                "requested_at": _now_ms(),
            },
        )
        return SendResult(success=True, message_id=clarify_id)

    async def send_exec_approval(
        self, chat_id: str, command: str, session_key: str,
        description: str = "dangerous command",
        metadata: dict | None = None,
    ) -> SendResult:
        """Hermes hook: a tool wants approval.

        We emit a ``gateway.approval.request`` event on the session's SSE
        stream. Any allowed host can answer via
        ``POST /sessions/{id}/approvals/{tool_call_id}``, which routes back
        through ``resolve_gateway_approval(session_key, choice)``. A
        standalone timer auto-resolves as ``"deny"`` after
        APPROVAL_TIMEOUT_S so the agent unblocks even if no one responds.
        """
        tool_call_id = _new_id("ap_")
        stream_id = _stream_id(tool_call_id)
        self._approvals.register(
            tool_call_id, session_key=session_key, stream_id=stream_id,
        )
        md = metadata or {}
        await self._log.append(
            chat_id, EventKind.APPROVAL_REQUEST, stream_id,
            {
                "tool_call_id": tool_call_id,
                "tool_name": md.get("tool_name") or "exec",
                "prompt": description,
                "command": command,
                "args": md.get("args"),
                "choices": list(APPROVAL_CHOICES),
                "expires_at": _now_ms() + APPROVAL_TIMEOUT_S * 1000,
                "session_key": session_key,
            },
        )
        # Strong ref so the timer isn't GC'd before the auto-deny fires.
        timer = asyncio.create_task(self._approval_timeout(
            chat_id, tool_call_id, session_key, stream_id,
        ))
        self._timeout_tasks.add(timer)
        timer.add_done_callback(self._timeout_tasks.discard)
        return SendResult(success=True, message_id=tool_call_id)

    async def _approval_timeout(
        self, sid: str, tool_call_id: str,
        session_key: str, stream_id: str,
    ) -> None:
        """Auto-resolve a pending approval as deny after APPROVAL_TIMEOUT_S.

        No-op if the approval was already answered before the timer fires;
        the rail's ``resolve`` returns ``None`` in that case.
        """
        await asyncio.sleep(APPROVAL_TIMEOUT_S)
        ts = _now_ms()
        if self._approvals.resolve(
            tool_call_id, decision="deny", by="system:timeout", sid=sid, ts=ts,
        ) is None:
            return
        await self._log.append(
            sid, EventKind.APPROVAL_RESOLVED, stream_id,
            {
                "tool_call_id": tool_call_id,
                "decision": "deny",
                "resolved_by": "system:timeout",
                "resolved_at": ts,
            },
        )
        try:
            from tools.approval import resolve_gateway_approval
            resolve_gateway_approval(session_key, "deny")
        except Exception as exc:
            logger.warning(
                "resolve_gateway_approval (timeout) failed: %s", exc,
            )

    async def get_chat_info(self, chat_id) -> dict:
        if self._sessions.exists(chat_id):
            info = self._sessions.get(chat_id)
            return {"name": info.name, "type": "group", "chat_id": chat_id}
        return {"name": chat_id, "type": "group", "chat_id": chat_id}

    # --- auth ---

    async def _tailscale_whois(
        self, peer_ip: str | None,
    ) -> tuple[str | None, list[str]]:
        if not peer_ip:
            return None, []
        if peer_ip in ("127.0.0.1", "::1"):
            return None, []
        cached = self._whois_cache.get(peer_ip)
        now = time.monotonic()
        if cached is not None and cached[0] > now:
            return cached[1]
        result: tuple[str | None, list[str]] = (None, [])
        try:
            proc = await asyncio.create_subprocess_exec(
                "tailscale", "whois", "--json", peer_ip,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            if proc.returncode == 0:
                data = json.loads(stdout)
                user = (data.get("UserProfile") or {}).get("LoginName")
                tags = (data.get("Node") or {}).get("Tags") or []
                result = (user, list(tags))
        except (asyncio.TimeoutError, json.JSONDecodeError,
                FileNotFoundError, OSError) as exc:
            logger.debug("tailscale whois failed: %s", exc)
        self._whois_cache[peer_ip] = (now + WHOIS_CACHE_TTL_S, result)
        return result

    async def _authorize(self, request: web.Request) -> tuple[str, list[str]]:
        # X-Device-Id is required on every authenticated endpoint — it
        # scopes per-(device, session) resume cursors and lets us reason
        # about which app instance is talking. Spec: stable UUID per app
        # install. We don't validate the UUID format (any non-empty string
        # is accepted) but it must be present.
        device_id = (request.headers.get(HEADER_DEVICE_ID) or "").strip()
        if not device_id:
            raise web.HTTPBadRequest(reason=f"{HEADER_DEVICE_ID} header required")
        request["device_id"] = device_id
        request["client_device_id"] = (
            request.headers.get(HEADER_DEVICE_ID_OVERRIDE)
            or device_id
        ).strip()

        peer_ip = request.remote
        user, tags = await self._tailscale_whois(peer_ip)
        if user is not None:
            if (self._allowed_hosts
                    and user not in self._allowed_hosts
                    and not any(t in self._allowed_hosts for t in tags)):
                raise web.HTTPForbidden(reason="host not in allowlist")
            return user, tags
        # Bearer fallback
        if not self._api_server_key:
            raise web.HTTPUnauthorized(
                reason="bearer auth not configured (set API_SERVER_KEY)",
            )
        auth = request.headers.get(HEADER_AUTHORIZATION, "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not token or not hmac.compare_digest(token, self._api_server_key):
            raise web.HTTPUnauthorized(reason="valid bearer token required")
        return f"bearer:{device_id}", []

    def _require_session(
        self, sid: str, *, include_archived: bool = False,
    ) -> SessionInfo:
        if include_archived:
            if not self._sessions.has(sid):
                raise web.HTTPNotFound(reason="unknown session")
        elif not self._sessions.exists(sid):
            raise web.HTTPNotFound(reason="unknown session")
        return self._sessions.get(sid)

    async def _stream_sse(
        self,
        resp: web.StreamResponse,
        q: asyncio.Queue,
        *,
        skip_below_seq: int = 0,
        accept: Callable[[dict], bool] | None = None,
        stop_on: Callable[[dict], bool] | None = None,
        deadline_s: float | None = None,
        on_deadline: Callable[[], bytes] | None = None,
    ) -> None:
        """Drain a log subscriber queue to an SSE response.

        Used by both /events (no deadline, run forever) and POST /messages
        (filter to one stream_id, stop on finalize, hard 5-min deadline).
        """
        deadline = (
            time.monotonic() + deadline_s if deadline_s is not None else None
        )
        while True:
            # Queue overflowed: drop the connection so the client resumes by
            # Last-Event-ID rather than receiving a gapped chain.
            if getattr(q, "_ocs_overflowed", False):
                return
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    if on_deadline is not None:
                        await resp.write(on_deadline())
                    return
                wait = min(20.0, remaining)
            else:
                wait = 20.0
            try:
                ev = await asyncio.wait_for(q.get(), timeout=wait)
            except asyncio.TimeoutError:
                await resp.write(b": ping\n\n")
                continue
            if getattr(q, "_ocs_overflowed", False):
                return
            if ev["seq"] <= skip_below_seq:
                continue
            if accept is not None and not accept(ev):
                continue
            await resp.write(_sse_event(ev))
            if stop_on is not None and stop_on(ev):
                return

    # --- HTTP handlers ---

    async def _handle_health(self, request) -> web.Response:
        # Optionally authenticate so authenticated callers can see their
        # resolved gateway identity in diagnostics.
        caller = ""
        try:
            caller, _ = await self._authorize(request)
        except web.HTTPException:
            pass
        return web.json_response({
            "ok": True,
            "platform": PLATFORM_NAME,
            "sessions": len(self._sessions.list()),
            "caller": caller,
            "gateway_api_version": GATEWAY_API_VERSION,
            "server_time": _now_ms(),
        })

    async def _handle_sessions_list(self, request) -> web.Response:
        await self._authorize(request)
        include_archived = (
            request.query.get("include_archived", "").lower()
            in _TRUTHY
        )
        out = []
        for s in self._sessions.list(include_archived=include_archived):
            tip = self._log.tip(s.session_id)
            out.append({
                **s.to_dict(),
                "tip_seq": tip[0] if tip else 0,
                "tip_hash": tip[1] if tip else "",
                "event_count": tip[0] if tip else 0,
            })
        return web.json_response({"sessions": out})

    async def _handle_sessions_create(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        body = await _body_json(request)
        info = await self._sessions.create(
            name=body.get("name"),
            metadata=body.get("metadata", {}) or {},
            created_by=user,
        )
        return web.json_response(info.to_dict(), status=201)

    async def _handle_sessions_patch(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid)
        body = await _body_json(request)
        if "name" in body:
            await self._sessions.rename(sid, body["name"], by=user)
        if "metadata" in body:
            await self._sessions.update_metadata(
                sid, body["metadata"], by=user,
            )
        return web.json_response(self._sessions.get(sid).to_dict())

    async def _handle_sessions_delete(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid)
        await self._sessions.archive(sid, by=user)
        return web.Response(status=204)

    async def _handle_session_events(self, request) -> web.StreamResponse:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid, include_archived=True)

        last_event_id = request.headers.get(HEADER_LAST_EVENT_ID) or ""
        cursor = request.query.get("cursor", "")
        q = self._log.subscribe(sid)
        resp: web.StreamResponse | None = None
        client_device_id = request.get("client_device_id") or request["device_id"]
        view_key = (user, sid, client_device_id)
        self._active_views[view_key] = self._active_views.get(view_key, 0) + 1

        try:
            resync_payload: dict[str, Any] | None = None
            # Full-history paths page through the whole log (replay_after = seq);
            # bounded tail paths use a capped list (replay_tail).
            replay_after: int | None = None
            replay_tail: list[dict] | None = None
            if last_event_id:
                seq = self._log.lookup_hash(sid, last_event_id)
                if seq is None:
                    resync_payload = {
                        "session_id": sid,
                        "reason": "unknown_tip",
                        "from_seq": 0,
                        "unknown_tip": last_event_id,
                    }
                    replay_after = 0
                else:
                    replay_after = seq
            elif cursor == "genesis" or cursor == "snapshot":
                replay_after = 0
            elif cursor.startswith("latest:"):
                try:
                    n = int(cursor.split(":", 1)[1])
                except ValueError:
                    n = 200
                replay_tail = self._log.last_n(sid, n)
            else:
                replay_tail = self._log.last_n(sid, 200)

            resp = await _prepare_sse(request)
            if resync_payload is not None:
                await resp.write(_sse_simple(EventKind.RESYNC, resync_payload))
            start_seq = 0
            if replay_after is not None:
                for ev in self._log.iter_after(sid, replay_after):
                    await resp.write(_sse_event(ev))
                    start_seq = ev["seq"]
            else:
                for ev in replay_tail or []:
                    await resp.write(_sse_event(ev))
                    start_seq = ev["seq"]
            await self._stream_sse(resp, q, skip_below_seq=start_seq)
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            self._log.unsubscribe(sid, q)
            n = self._active_views.get(view_key, 0) - 1
            if n <= 0:
                self._active_views.pop(view_key, None)
            else:
                self._active_views[view_key] = n
            with contextlib.suppress(Exception):
                if resp is not None:
                    await resp.write_eof()
        return resp or web.Response(status=500)

    def _resolve_inbound_attachments(
        self, sid: str, attachments_in: list[str],
    ) -> tuple[list[str], list[str], list[dict]]:
        media_urls: list[str] = []
        media_types: list[str] = []
        refs: list[dict] = []
        for ref in attachments_in:
            aid = ref.rsplit("/", 1)[-1].split(".", 1)[0]
            res = self._attachments.info(aid)
            if not res:
                raise web.HTTPBadRequest(reason=f"unknown attachment {aid}")
            info, path = res
            public_url = f"/sessions/{sid}/attachments/{aid}"
            media_urls.append(str(path))
            media_types.append(info.mime)
            refs.append({
                "attachment_id": aid,
                "url": public_url,
                "mime": info.mime,
                "size": info.size,
                "sha256": aid,
            })
        return media_urls, media_types, refs

    async def _handle_session_message(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        sess = self._require_session(sid)
        body = await _body_json(request)
        text = body.get("text", "") or ""
        attachments_in = body.get("attachments", []) or []
        reply_to = body.get("reply_to")
        thread_id = body.get("thread_id")

        media_urls, media_types, attachment_refs = (
            self._resolve_inbound_attachments(sid, attachments_in)
        )

        req_id = _new_id("i_")
        source = self.build_source(
            chat_id=sid,
            chat_type="group",
            # HTTP auth has already resolved the caller. Keep Hermes' session
            # key session-centric so approval/clarify follow-ups hit the active
            # run instead of a bearer-specific sibling key.
            user_id="",
            user_name=user,
            chat_name=sess.name,
            thread_id=thread_id,
            message_id=req_id,
        )
        # If audio attachment(s) are present and the user didn't type a
        # command, mark the message as VOICE so the runner's universal STT
        # pipeline transcribes it (same path used by Discord/Signal/Matrix/
        # WhatsApp/Mattermost). The transcript is prepended to the user's
        # text by ``_enrich_message_with_transcription`` in ``gateway/run.py``.
        is_command = text.lstrip().startswith("/")
        has_audio = any(mt.startswith("audio/") for mt in media_types)
        event = MessageEvent(
            text=text,
            message_type=(
                MessageType.COMMAND if is_command
                else MessageType.VOICE if has_audio
                else MessageType.TEXT
            ),
            source=source,
            raw_message=body,
            message_id=req_id,
            media_urls=media_urls,
            media_types=media_types,
            reply_to_message_id=reply_to,
            # HTTP auth already enforced Tailscale/bearer authorization.
            # Mark internal so Hermes does not apply its separate platform
            # allowlist/pairing gate to synthetic gateway users.
            internal=True,
        )

        # Subscribe BEFORE appending so the POSTer sees their own in.message.
        # Everything after subscribe lives in the try/finally so a mid-handshake
        # failure still unsubscribes the queue instead of leaking it into _subs.
        q = self._log.subscribe(sid)
        resp: web.StreamResponse | None = None
        try:
            # Pending clarify for this session: emit a resolved event now (FIFO,
            # matching run.py's text-intercept) so the dashboard's ClarifyBubble
            # disappears immediately. Stamp req_id as stream_id so the POSTer's
            # filtered SSE response delivers it.
            active_clarifies = self._active_clarify_ids.get(sid) or []
            if active_clarifies:
                cid = active_clarifies.pop(0)
                if not active_clarifies:
                    self._active_clarify_ids.pop(sid, None)
                await self._log.append(
                    sid, EventKind.CLARIFY_RESOLVED, req_id,
                    {"clarify_id": cid, "response": text, "resolved_by": user},
                )

            await self._log.append(
                sid, EventKind.MESSAGE_IN, req_id,
                {
                    "message_id": req_id,
                    "author": user,
                    "text": text,
                    "attachments": attachment_refs,
                    "reply_to": reply_to,
                    "thread_id": thread_id,
                },
            )
            logger.info(
                "message in sid=%s author=%s len=%d",
                sid, _redact_identity(user), len(text),
            )

            resp = await _prepare_sse(request)

            # Dispatch to hermes; outbound events arrive via send / edit_message
            # → log fan-out → our queue.
            task = asyncio.create_task(
                self._safe_handle_message(event, sid, req_id))
            self._active_runs[(sid, req_id)] = task

            def _is_terminal(ev: dict) -> bool:
                if ev["kind"] in (EventKind.ERROR, EventKind.MESSAGE_CANCEL):
                    return True
                return (
                    ev["kind"] == EventKind.MESSAGE_EDIT
                    and ev["data"].get("finalize") is True
                )

            await self._stream_sse(
                resp, q,
                accept=lambda e: e["stream_id"] == req_id,
                stop_on=_is_terminal,
                deadline_s=APPROVAL_TIMEOUT_S,
                on_deadline=lambda: _sse_simple(EventKind.ERROR, {
                    "code": "poster_timeout",
                    "message": "no finalize within 5min",
                }),
            )
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            self._log.unsubscribe(sid, q)
            with contextlib.suppress(Exception):
                if resp is not None:
                    await resp.write_eof()
        return resp or web.Response(status=500)

    async def _safe_handle_message(
        self, event: MessageEvent, sid: str, stream_id: str,
    ):
        token = _CURRENT_STREAM_ID.set(stream_id)
        try:
            await self.handle_message(event)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("handle_message failed for %s", sid)
            await self._log.append(
                sid, EventKind.ERROR, stream_id,
                {"code": "dispatch_failed", "message": str(e)},
            )
        finally:
            self._active_runs.pop((sid, stream_id), None)
            _CURRENT_STREAM_ID.reset(token)

    async def _handle_session_cancel(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        sess = self._require_session(sid)
        body = await _body_json(request)
        requested_stream_id = str(body.get("stream_id") or "")
        # Empty stream_id means "cancel the active run(s)"; if none are active,
        # targets stays empty (no MESSAGE_CANCEL with an empty stream_id).
        targets = (
            [requested_stream_id]
            if requested_stream_id
            else [stream_id for sess_id, stream_id in self._active_runs if sess_id == sid]
        )

        cancelled = 0
        for stream_id in targets:
            task = self._active_runs.get((sid, stream_id))
            if task and not task.done():
                task.cancel()
                cancelled += 1
            await self._log.append(
                sid, EventKind.MESSAGE_CANCEL, stream_id,
                {"by": user, "stream_id": stream_id},
            )

        source = self.build_source(
            chat_id=sid,
            chat_type="group",
            user_id="",
            user_name=user,
            chat_name=sess.name,
            message_id=_new_id("i_"),
        )
        session_key = build_session_key(
            source,
            group_sessions_per_user=self.config.extra.get("group_sessions_per_user", True),
            thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
        )
        # Compatibility for runs started before the session-centric source fix:
        # those active Hermes guards were keyed with the bearer/tailnet identity.
        legacy_source = self.build_source(
            chat_id=sid,
            chat_type="group",
            user_id=user,
            user_name=user,
            chat_name=sess.name,
            message_id=_new_id("i_"),
        )
        legacy_session_key = build_session_key(
            legacy_source,
            group_sessions_per_user=True,
            thread_sessions_per_user=self.config.extra.get("thread_sessions_per_user", False),
        )
        for key in dict.fromkeys((session_key, legacy_session_key)):
            await self.cancel_session_processing(key)
            with contextlib.suppress(Exception):
                from tools import clarify_gateway
                clarify_gateway.clear_session(key)
            with contextlib.suppress(Exception):
                from tools.approval import resolve_gateway_approval
                resolve_gateway_approval(key, "deny", resolve_all=True)
        # Drop queued clarify ids so a cancelled clarify isn't later emitted as
        # a spurious CLARIFY_RESOLVED.
        self._active_clarify_ids.pop(sid, None)
        return web.json_response({
            "acknowledged": True,
            "cancelled": cancelled,
            "stream_ids": targets,
        })

    async def _handle_approval(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid)
        tool_call_id = request.match_info["tool_call_id"]
        body = await _body_json(request)
        decision = body.get("decision", "")
        if decision not in APPROVAL_CHOICES:
            raise web.HTTPBadRequest(
                reason="decision must be one of once/session/always/deny",
            )

        # First-responder-wins
        prior = self._approvals.get_resolved(tool_call_id)
        if prior is not None:
            return web.json_response(
                {
                    "error": "already_resolved",
                    "resolved_by": prior["by"],
                    "decision": prior["decision"],
                    "resolved_at": prior["ts"],
                },
                status=409,
            )
        ts = _now_ms()
        pending = self._approvals.resolve(
            tool_call_id, decision=decision, by=user, sid=sid, ts=ts,
        )
        if pending is None:
            raise web.HTTPNotFound(reason="unknown approval")
        stream_id = pending.get("stream_id", tool_call_id)
        await self._log.append(
            sid, EventKind.APPROVAL_RESOLVED, stream_id,
            {
                "tool_call_id": tool_call_id,
                "decision": decision,
                "resolved_by": user,
                "resolved_at": ts,
            },
        )
        logger.info(
            "approval resolved tool_call_id=%s decision=%s by=%s",
            tool_call_id, decision, _redact_identity(user),
        )
        try:
            from tools.approval import resolve_gateway_approval
            resolve_gateway_approval(pending["session_key"], decision)
        except Exception as e:
            logger.warning("resolve_gateway_approval failed: %s", e)

        return web.json_response({"resolved_by": user, "decision": decision})

    # --- push delivery ---

    def _require_push(self) -> None:
        if self._push_dispatcher is None:
            raise web.HTTPServiceUnavailable(reason="push delivery not initialised")

    async def _handle_push_vapid_public_key(self, request) -> web.Response:
        await self._authorize(request)
        self._require_push()
        return web.json_response({"public_key": self._vapid.public_key_b64})

    async def _handle_push_register(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        self._require_push()
        body = await _body_json(request)
        device_id = str(body.get("device_id") or "").strip()
        platform = str(body.get("platform") or "web").strip()
        if platform not in PUSH_PLATFORMS:
            raise web.HTTPBadRequest(
                reason=f"platform must be one of {','.join(PUSH_PLATFORMS)}",
            )
        subscription = body.get("subscription") or {}
        if not isinstance(subscription, dict) or not subscription.get("endpoint"):
            raise web.HTTPBadRequest(reason="subscription.endpoint required")
        keys = subscription.get("keys") or {}
        if not (keys.get("p256dh") and keys.get("auth")):
            raise web.HTTPBadRequest(reason="subscription.keys.p256dh and .auth required")
        policy = body.get("notification_policy") or {}
        if not isinstance(policy, dict):
            raise web.HTTPBadRequest(reason="notification_policy must be an object")
        sessions = body.get("sessions")
        if sessions is not None and not isinstance(sessions, list):
            raise web.HTTPBadRequest(reason="sessions must be a list of ids")

        device = await self._push.upsert(
            device_id=device_id, user_id=user, platform=platform,
            subscription=subscription, policy=policy, sessions=sessions,
        )
        return web.json_response(device.to_public(), status=201)

    async def _handle_push_unregister(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        self._require_push()
        device_id = request.match_info["device_id"]
        await self._push.delete(user_id=user, device_id=device_id)
        return web.Response(status=204)

    async def _handle_attachment_upload(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid)
        reader = await request.multipart()
        field = await reader.next()
        if field is None or field.name != "file":
            raise web.HTTPBadRequest(reason="missing 'file' field")
        mime = field.headers.get("Content-Type", "application/octet-stream")
        info = await self._attachments.upload(
            field, uploaded_by=user, mime_hint=mime,
        )
        await self._log.append(
            sid, EventKind.ATTACHMENT_UPLOADED, info.attachment_id,
            {
                "attachment_id": info.attachment_id,
                "mime": info.mime,
                "size": info.size,
                "by": user,
            },
        )
        return web.json_response({
            "attachment_id": info.attachment_id,
            "url": f"/sessions/{sid}/attachments/{info.attachment_id}",
            "mime": info.mime,
            "size": info.size,
            "sha256": info.attachment_id,
        }, status=201)

    async def _handle_attachment_download(self, request) -> web.StreamResponse:
        await self._authorize(request)
        self._require_session(request.match_info["session_id"], include_archived=True)
        aid = request.match_info["attachment_id"]
        res = self._attachments.info(aid)
        if not res:
            raise web.HTTPNotFound(reason="unknown attachment")
        info, path = res
        if not path.exists():
            raise web.HTTPNotFound(reason="file missing")
        # Stored mime is attacker-controlled (verbatim from upload), so nosniff +
        # attachment disposition prevent stored XSS from an uploaded
        # text/html / svg. The dashboard's fetch()->blob render is unaffected.
        return web.FileResponse(path, headers={
            "Content-Type": info.mime,
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "attachment",
        })

    async def _handle_history(self, request) -> web.Response:
        await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid, include_archived=True)
        after = request.query.get("after", "")
        try:
            limit = int(request.query.get("limit", "100"))
        except ValueError:
            limit = 100
        seq = self._log.lookup_hash(sid, after) if after else 0
        if seq is None:
            seq = 0
        events = self._log.range_after(sid, seq, limit=limit)
        resp: dict[str, Any] = {"events": [_wire_event(ev) for ev in events]}
        # A full page implies more may follow; expose next_cursor so a client
        # can page forward (HistoryResponse.next_cursor, 07-client-api.md).
        if events and len(events) == limit:
            resp["next_cursor"] = events[-1]["hash"]
        return web.json_response(resp)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def check_requirements() -> bool:
    # Always returns True — accept config.yaml-only configuration.
    return True


def validate_config(config) -> bool:
    # The platform is always configured: bind resolves to ``extra.bind``,
    # then ``OPEN_CHAT_SESSION_BIND``, then ``DEFAULT_BIND`` as a final
    # fallback inside the adapter constructor. We therefore accept any
    # config — actual liveness is reflected by the runtime status file.
    return True


def is_platform_connected(config) -> bool:
    # ``GatewayConfig.get_connected_platforms()`` calls this via the
    # platform registry to populate the dashboard's "Connected Platforms"
    # panel. Whenever this plugin is loaded and enabled in config, the
    # gateway listener comes up (DEFAULT_BIND guarantees a port). Real
    # liveness is monitored separately by the gateway runtime status.
    return True


def _env_enablement() -> dict[str, Any] | None:
    seed: dict = {}
    bind = os.getenv("OPEN_CHAT_SESSION_BIND", "").strip()
    if bind:
        seed["bind"] = bind
    allowed = os.getenv("OPEN_CHAT_SESSION_ALLOWED_HOSTS", "").strip()
    if allowed:
        seed["allowed_hosts"] = _csv_to_list(allowed)
    data_dir = os.getenv("OPEN_CHAT_SESSION_DATA_DIR", "").strip()
    if data_dir:
        seed["data_dir"] = data_dir
    auto_default = os.getenv(
        "OPEN_CHAT_SESSION_AUTO_DEFAULT_SESSION", "",
    ).strip()
    if auto_default:
        seed["auto_create_default_session"] = auto_default.lower() in _TRUTHY
    edge_enabled = os.getenv("OPEN_CHAT_SESSION_EDGE_ENABLED", "").strip()
    if edge_enabled:
        seed["edge_enabled"] = edge_enabled.lower() in _TRUTHY
    edge_bind = os.getenv("OPEN_CHAT_SESSION_EDGE_BIND", "").strip()
    if edge_bind:
        seed["edge_bind"] = edge_bind
    edge_dashboard = os.getenv("OPEN_CHAT_SESSION_EDGE_DASHBOARD_URL", "").strip()
    if edge_dashboard:
        seed["edge_dashboard_url"] = edge_dashboard
    if not seed:
        return None
    return seed


def register(ctx):
    """Plugin entry point — called by hermes's PluginManager."""
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Open Chat Session",
        adapter_factory=lambda cfg: OpenChatSessionAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_platform_connected,
        required_env=[],
        install_hint=(
            "Defaults are enough for local use. For phone/PWA access, publish "
            "the plugin edge with: tailscale serve --bg https / "
            "http://127.0.0.1:9120"
        ),
        env_enablement_fn=_env_enablement,
        max_message_length=0,
        emoji="🔌",
        platform_hint=(
            "You are talking to clients via the Open Chat Session — a native "
            "REST/SSE session-based protocol over a tailscale network. "
            "Clients are custom apps or our reference web UI."
        ),
    )
