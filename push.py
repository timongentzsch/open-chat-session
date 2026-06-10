"""Web Push delivery: VAPID keys, device registry, and the dispatcher."""

import asyncio
import base64
import contextlib
import dataclasses
import hashlib
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any

from .common import EventKind, _canonical_bytes, _new_id, _now_ms, _redact_identity
from .event_log import HashChainedLog
from .sessions import SessionRegistry

logger = logging.getLogger(__name__)

PUSH_PLATFORMS = ("web", "ios-home-screen", "macos-safari", "android-chrome")
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
