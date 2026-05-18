"""
open-chat-session adapter — native HTTP/SSE client surface for Hermes Agent.

Serves /sessions/* REST + SSE on the configured bind address. Runs alongside
Hermes's stock api_server; does NOT expose /v1/* (that surface is unmodified).

Peer identity: Tailscale ``whois`` is the canonical source; bearer-token auth
(``API_SERVER_KEY``) is the fallback for localhost/proxy callers.
"""

import asyncio
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
from typing import Any, Callable, Dict, List, Optional, Tuple

from aiohttp import web

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PLATFORM_NAME = "open_chat_session"
DEFAULT_BIND = "0.0.0.0:8765"
DEFAULT_DATA_DIR = "~/.hermes/data/open-chat-session"
DEFAULT_MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024  # 100 MB
APPROVAL_TIMEOUT_S = 300
APPROVAL_CHOICES = ("once", "session", "always", "deny")
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
_CURRENT_STREAM_ID: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar(
    "open_chat_session_stream_id", default=None,
)


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


def _csv_to_list(s: str) -> List[str]:
    if not s:
        return []
    return [p.strip() for p in s.split(",") if p.strip()]


def _parse_bind(bind: str) -> Tuple[str, int]:
    if ":" not in bind:
        return "0.0.0.0", int(bind)
    host, port = bind.rsplit(":", 1)
    return host or "0.0.0.0", int(port)


def _ext_from_mime(mime: str) -> str:
    mapping = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
        "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov",
        "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
        "application/pdf": ".pdf", "text/plain": ".txt",
    }
    return mapping.get(mime, "")


def _resolve_local_ref(ref: str) -> Optional[str]:
    """Return a filesystem path if `ref` resolves to one we should host
    (raw path or `file://` URL); otherwise None. http/https/data/existing
    /sessions/ URLs pass through as remote refs."""
    if not ref:
        return None
    if ref.startswith(("http://", "https://", "data:", "/sessions/")):
        return None
    if ref.startswith("file://"):
        from urllib.parse import unquote, urlparse
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
    mime: str = "", filename: Optional[str] = None,
    caption: Optional[str] = None, size: int = 0, sha256: str = "",
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
    parent_session_id: Optional[str] = None

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
        self._db: Optional[sqlite3.Connection] = None
        self._lock = asyncio.Lock()
        # session_id -> list of subscriber asyncio.Queue
        self._subs: Dict[str, List[asyncio.Queue]] = defaultdict(list)

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
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(event)
            return event

    def subscribe(self, session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._subs[session_id].append(q)
        return q

    def unsubscribe(self, session_id: str, q: asyncio.Queue):
        with contextlib.suppress(ValueError):
            self._subs[session_id].remove(q)

    def tip(self, session_id: str) -> Optional[Tuple[int, str]]:
        cur = self._db.execute(
            "SELECT seq, hash FROM events WHERE session_id=? "
            "ORDER BY seq DESC LIMIT 1",
            (session_id,),
        )
        row = cur.fetchone()
        return (row[0], row[1]) if row else None

    def lookup_hash(self, session_id: str, h: str) -> Optional[int]:
        cur = self._db.execute(
            "SELECT seq FROM events WHERE session_id=? AND hash=?",
            (session_id, h),
        )
        row = cur.fetchone()
        return row[0] if row else None

    def range_after(self, session_id: str, after_seq: int,
                    limit: int = 1000) -> List[dict]:
        cur = self._db.execute(
            "SELECT seq, prev_hash, hash, stream_id, kind, data, ts "
            "FROM events WHERE session_id=? AND seq > ? "
            "ORDER BY seq ASC LIMIT ?",
            (session_id, after_seq, limit),
        )
        return [self._row_to_event(session_id, r) for r in cur]

    def last_n(self, session_id: str, n: int) -> List[dict]:
        cur = self._db.execute(
            "SELECT seq, prev_hash, hash, stream_id, kind, data, ts "
            "FROM events WHERE session_id=? "
            "ORDER BY seq DESC LIMIT ?",
            (session_id, n),
        )
        rows = list(cur)
        rows.reverse()
        return [self._row_to_event(session_id, r) for r in rows]

    def known_sessions(self) -> List[str]:
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
        self._sessions: Dict[str, SessionInfo] = {}

    def load_from_log(self):
        for sid in self._log.known_sessions():
            events = self._log.range_after(sid, 0)
            info: Optional[SessionInfo] = None
            for ev in events:
                if ev["kind"] == "gateway.session.created":
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
                elif info and ev["kind"] == "gateway.session.archived":
                    info.archived = True
                elif info and ev["kind"] == "gateway.session.metadata.updated":
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

    def list(self, include_archived: bool = False) -> List[SessionInfo]:
        return [
            s for s in self._sessions.values()
            if include_archived or not s.archived
        ]

    async def create(self, *, name: Optional[str], metadata: dict,
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
            sid, "gateway.session.created", sid,
            {
                "name": info.name,
                "metadata": info.metadata,
                "created_by": info.created_by,
            },
        )
        self._sessions[sid] = info
        return info

    async def archive(self, session_id: str, by: str):
        if session_id not in self._sessions:
            raise KeyError(session_id)
        await self._log.append(
            session_id, "gateway.session.archived", session_id, {"by": by},
        )
        self._sessions[session_id].archived = True

    async def rename(self, session_id: str, name: str, by: str):
        if session_id not in self._sessions:
            raise KeyError(session_id)
        await self._log.append(
            session_id, "gateway.session.metadata.updated", session_id,
            {"by": by, "patch": {"name": name}},
        )
        self._sessions[session_id].name = name

    async def update_metadata(self, session_id: str, metadata: dict, by: str):
        if session_id not in self._sessions:
            raise KeyError(session_id)
        await self._log.append(
            session_id, "gateway.session.metadata.updated", session_id,
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
        mime_hint: Optional[str] = None,
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

    def info(self, attachment_id: str) -> Optional[Tuple[AttachmentInfo, Path]]:
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
    event = dict(event_payload)
    event["payload"] = event.pop("data", {})
    return event


async def _prepare_sse(request: web.Request) -> web.StreamResponse:
    resp = web.StreamResponse(headers=SSE_HEADERS)
    await resp.prepare(request)
    return resp


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

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

        # tool_call_id -> {"decision": str, "by": str, "sid": str, "ts": int}
        self._resolved_approvals: Dict[str, dict] = {}
        # tool_call_id -> {session_key, stream_id}
        self._pending_approvals: Dict[str, dict] = {}
        # (session_id, outbound_message_id) -> inbound stream id
        self._message_streams: Dict[Tuple[str, str], str] = {}

        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.BaseSite] = None

    # --- lifecycle ---

    async def connect(self) -> bool:
        await self._log.open()
        self._sessions.load_from_log()
        if self._auto_default and not self._sessions.list():
            await self._sessions.create(
                name="General", metadata={}, created_by="system",
            )

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

        self._runner = web.AppRunner(self._app, access_log=None)
        await self._runner.setup()
        host, port = _parse_bind(self._bind)
        self._site = web.TCPSite(self._runner, host=host, port=port)
        await self._site.start()
        logger.info("open-chat-session listening on %s:%s", host, port)
        return True

    async def disconnect(self) -> None:
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
            session_id, "gateway.message.out", stream_id,
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
                session_id, "gateway.message.edit", stream_id,
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
            session_id, "gateway.message.edit", stream_id,
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
        await self._log.append(
            chat_id, "gateway.typing", _stream_id("typing"),
            {"metadata": metadata or {}},
        )

    # Media egress — emits `{message_id, attachments: AttachmentRef[],
    # caption?, reply_to?}`. Local file paths are hosted in the
    # AttachmentStore so the dashboard can fetch them through the proxy;
    # external URLs pass through.

    async def send_image(self, chat_id, image_url, caption=None,
                         reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, "gateway.image", [image_url],
            caption=caption, reply_to=reply_to,
        )

    async def send_image_file(self, chat_id, image_path, caption=None,
                              reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, "gateway.image", [str(image_path)],
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
            chat_id, "gateway.image", refs,
            caption=caption, reply_to=reply_to,
        )

    async def send_video(self, chat_id, video_url=None, caption=None,
                         reply_to=None, metadata=None,
                         video_path=None, **_) -> SendResult:
        ref = video_url or video_path
        if not ref:
            return SendResult(success=False, error="missing video path")
        return await self._emit_media(
            chat_id, "gateway.video", [str(ref)],
            caption=caption, reply_to=reply_to,
        )

    async def send_animation(self, chat_id, animation_url, caption=None,
                             reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, "gateway.animation", [animation_url],
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
            chat_id, "gateway.document", [str(ref)],
            caption=caption, reply_to=reply_to,
            filename=name,
        )

    async def send_voice(self, chat_id, audio_path, caption=None,
                         reply_to=None, metadata=None, **_) -> SendResult:
        return await self._emit_media(
            chat_id, "gateway.voice", [str(audio_path)],
            caption=caption, reply_to=reply_to,
        )

    def _resolve_media_ref(
        self, chat_id: str, ref: str,
        *, filename: Optional[str] = None, caption: Optional[str] = None,
        uploaded_by: str = "agent",
    ) -> dict:
        """AttachmentRef for a media ref. Local paths (raw or `file://`) are
        uploaded into the AttachmentStore so the dashboard can fetch them
        through the proxy; http(s)/data/`/sessions/...` URLs pass through."""
        local_path = _resolve_local_ref(ref)
        if local_path:
            try:
                info = self._attachments.upload_local(local_path, uploaded_by=uploaded_by)
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
        self, chat_id: str, kind: str, refs: List[str],
        *, caption: Optional[str] = None, reply_to: Optional[str] = None,
        filename: Optional[str] = None,
    ) -> SendResult:
        message_id = _new_id("o_")
        stream_id = _stream_id(message_id)
        attachments = [
            self._resolve_media_ref(
                chat_id, r, filename=filename, caption=caption,
            )
            for r in refs if r
        ]
        payload: Dict[str, Any] = {"message_id": message_id, "attachments": attachments}
        if caption:
            payload["caption"] = caption
        if reply_to:
            payload["reply_to"] = reply_to
        await self._log.append(chat_id, kind, stream_id, payload)
        return SendResult(success=True, message_id=message_id)

    async def send_exec_approval(
        self, chat_id: str, command: str, session_key: str,
        description: str = "dangerous command",
        metadata: Optional[dict] = None,
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
        self._pending_approvals[tool_call_id] = {
            "session_key": session_key,
            "stream_id": stream_id,
        }
        md = metadata or {}
        await self._log.append(
            chat_id, "gateway.approval.request", stream_id,
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
        asyncio.create_task(self._approval_timeout(
            chat_id, tool_call_id, session_key, stream_id,
        ))
        return SendResult(success=True, message_id=tool_call_id)

    async def _approval_timeout(
        self, sid: str, tool_call_id: str,
        session_key: str, stream_id: str,
    ) -> None:
        """Auto-resolve a pending approval as deny after APPROVAL_TIMEOUT_S.

        No-op if the approval was answered before the timer fires
        (we only act when ``tool_call_id`` is still in
        ``_pending_approvals``).
        """
        await asyncio.sleep(APPROVAL_TIMEOUT_S)
        if tool_call_id not in self._pending_approvals:
            return
        self._pending_approvals.pop(tool_call_id, None)
        ts = _now_ms()
        self._resolved_approvals[tool_call_id] = {
            "decision": "deny",
            "by": "system:timeout",
            "sid": sid,
            "ts": ts,
        }
        await self._log.append(
            sid, "gateway.approval.resolved", stream_id,
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
        self, peer_ip: Optional[str],
    ) -> Tuple[Optional[str], List[str]]:
        if not peer_ip:
            return None, []
        if peer_ip in ("127.0.0.1", "::1"):
            return None, []
        try:
            proc = await asyncio.create_subprocess_exec(
                "tailscale", "whois", "--json", peer_ip,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            if proc.returncode != 0:
                return None, []
            data = json.loads(stdout)
            user = (data.get("UserProfile") or {}).get("LoginName")
            tags = (data.get("Node") or {}).get("Tags") or []
            return user, list(tags)
        except (asyncio.TimeoutError, json.JSONDecodeError,
                FileNotFoundError, OSError) as exc:
            logger.debug("tailscale whois failed: %s", exc)
            return None, []

    async def _authorize(self, request: web.Request) -> Tuple[str, List[str]]:
        # X-Device-Id is required on every authenticated endpoint — it
        # scopes per-(device, session) resume cursors and lets us reason
        # about which app instance is talking. Spec: stable UUID per app
        # install. We don't validate the UUID format (any non-empty string
        # is accepted) but it must be present.
        device_id = (request.headers.get("X-Device-Id") or "").strip()
        if not device_id:
            raise web.HTTPBadRequest(reason="X-Device-Id header required")
        request["device_id"] = device_id

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
        auth = request.headers.get("Authorization", "")
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
        accept: Optional[Callable[[dict], bool]] = None,
        stop_on: Optional[Callable[[dict], bool]] = None,
        deadline_s: Optional[float] = None,
        on_deadline: Optional[Callable[[], bytes]] = None,
    ) -> None:
        """Drain a log subscriber queue to an SSE response.

        Used by both /events (no deadline, run forever) and POST /messages
        (filter to one stream_id, stop on finalize, hard 5-min deadline).
        """
        deadline = (
            time.monotonic() + deadline_s if deadline_s is not None else None
        )
        while True:
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
            "gateway_api_version": "2026-05-15",
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
        await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid, include_archived=True)

        last_event_id = request.headers.get("Last-Event-ID") or ""
        cursor = request.query.get("cursor", "")
        q = self._log.subscribe(sid)
        resp: Optional[web.StreamResponse] = None

        try:
            resync_payload: Optional[Dict[str, Any]] = None
            if last_event_id:
                seq = self._log.lookup_hash(sid, last_event_id)
                if seq is None:
                    resync_payload = {
                        "session_id": sid,
                        "reason": "unknown_tip",
                        "from_seq": 0,
                        "unknown_tip": last_event_id,
                    }
                    replay = self._log.range_after(sid, 0)
                else:
                    replay = self._log.range_after(sid, seq)
            elif cursor == "genesis" or cursor == "snapshot":
                replay = self._log.range_after(sid, 0)
            elif cursor.startswith("latest:"):
                try:
                    n = int(cursor.split(":", 1)[1])
                except ValueError:
                    n = 200
                replay = self._log.last_n(sid, n)
            else:
                replay = self._log.last_n(sid, 200)

            start_seq = replay[-1]["seq"] if replay else 0
            resp = await _prepare_sse(request)
            if resync_payload is not None:
                await resp.write(_sse_simple("gateway.resync", resync_payload))
            for ev in replay:
                await resp.write(_sse_event(ev))
            await self._stream_sse(resp, q, skip_below_seq=start_seq)
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            self._log.unsubscribe(sid, q)
            with contextlib.suppress(Exception):
                if resp is not None:
                    await resp.write_eof()
        return resp or web.Response(status=500)

    def _resolve_inbound_attachments(
        self, sid: str, attachments_in: List[str],
    ) -> Tuple[List[str], List[str], List[dict]]:
        media_urls: List[str] = []
        media_types: List[str] = []
        refs: List[dict] = []
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
            user_id=user,
            user_name=user,
            chat_name=sess.name,
            thread_id=thread_id,
            message_id=req_id,
        )
        event = MessageEvent(
            text=text,
            message_type=(
                MessageType.COMMAND
                if text.lstrip().startswith("/")
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

        # Subscribe BEFORE appending so the POSTer sees their own in.message
        # in the SSE response.
        q = self._log.subscribe(sid)

        await self._log.append(
            sid, "gateway.message.in", req_id,
            {
                "message_id": req_id,
                "author": user,
                "text": text,
                "attachments": attachment_refs,
                "reply_to": reply_to,
                "thread_id": thread_id,
            },
        )

        resp = await _prepare_sse(request)

        # Dispatch to hermes; outbound events arrive via send / edit_message
        # → log fan-out → our queue.
        asyncio.create_task(self._safe_handle_message(event, sid, req_id))

        try:
            def _is_terminal(ev: dict) -> bool:
                if ev["kind"] == "gateway.error":
                    return True
                return (
                    ev["kind"] == "gateway.message.edit"
                    and ev["data"].get("finalize") is True
                )

            await self._stream_sse(
                resp, q,
                accept=lambda e: e["stream_id"] == req_id,
                stop_on=_is_terminal,
                deadline_s=APPROVAL_TIMEOUT_S,
                on_deadline=lambda: _sse_simple("gateway.error", {
                    "code": "poster_timeout",
                    "message": "no finalize within 5min",
                }),
            )
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            self._log.unsubscribe(sid, q)
            with contextlib.suppress(Exception):
                await resp.write_eof()
        return resp

    async def _safe_handle_message(
        self, event: MessageEvent, sid: str, stream_id: str,
    ):
        token = _CURRENT_STREAM_ID.set(stream_id)
        try:
            await self.handle_message(event)
        except Exception as e:
            logger.exception("handle_message failed for %s", sid)
            await self._log.append(
                sid, "gateway.error", stream_id,
                {"code": "dispatch_failed", "message": str(e)},
            )
        finally:
            _CURRENT_STREAM_ID.reset(token)

    async def _handle_session_cancel(self, request) -> web.Response:
        user, _ = await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid)
        body = await _body_json(request)
        stream_id = body.get("stream_id", "")
        await self._log.append(
            sid, "gateway.message.cancel.requested", stream_id,
            {"by": user, "stream_id": stream_id},
        )
        return web.json_response({"acknowledged": True})

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
        prior = self._resolved_approvals.get(tool_call_id)
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
        pending = self._pending_approvals.pop(tool_call_id, None)
        if pending is None:
            raise web.HTTPNotFound(reason="unknown approval")

        ts = _now_ms()
        self._resolved_approvals[tool_call_id] = {
            "decision": decision,
            "by": user,
            "sid": sid,
            "ts": ts,
        }
        stream_id = pending.get("stream_id", tool_call_id)
        await self._log.append(
            sid, "gateway.approval.resolved", stream_id,
            {
                "tool_call_id": tool_call_id,
                "decision": decision,
                "resolved_by": user,
                "resolved_at": ts,
            },
        )
        try:
            from tools.approval import resolve_gateway_approval
            resolve_gateway_approval(pending["session_key"], decision)
        except Exception as e:
            logger.warning("resolve_gateway_approval failed: %s", e)

        return web.json_response({"resolved_by": user, "decision": decision})

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
            sid, "gateway.attachment.uploaded", info.attachment_id,
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
        return web.FileResponse(path, headers={"Content-Type": info.mime})

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
        return web.json_response({"events": [_wire_event(ev) for ev in events]})


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


def _env_enablement() -> Optional[Dict[str, Any]]:
    bind = os.getenv("OPEN_CHAT_SESSION_BIND", "").strip()
    if not bind:
        return None
    seed: dict = {"bind": bind}
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
        required_env=["OPEN_CHAT_SESSION_BIND"],
        install_hint=(
            "Set OPEN_CHAT_SESSION_BIND=0.0.0.0:8765 in env, "
            "or extra.bind in config.yaml under gateway.platforms.open_chat_session"
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
