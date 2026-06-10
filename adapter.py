"""
open-chat-session adapter — native HTTP/SSE client surface for Hermes Agent.

Serves /sessions/* REST + SSE on the configured bind address. Runs alongside
Hermes's stock api_server; does NOT expose /v1/* (that surface is unmodified).

Peer identity: Tailscale ``whois`` is the canonical source; bearer-token auth
(``API_SERVER_KEY``) is the fallback for localhost/proxy callers.

Module map: event_log (hash-chained log + SSE wire), sessions (registry),
attachments (store), push (Web Push), edge (tailnet proxy), auth, approvals.
This module keeps the Hermes platform adapter and its HTTP handlers.
"""

import asyncio
import contextlib
import contextvars
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

from aiohttp import web

from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.config import Platform, PlatformConfig
from gateway.session import build_session_key

from .approvals import APPROVAL_CHOICES, APPROVAL_TIMEOUT_S, ApprovalRail
from .attachments import AttachmentStore, _attachment_ref, _resolve_local_ref
from .auth import RequestAuthenticator
from .common import (
    DEFAULT_BIND,
    DEFAULT_DATA_DIR,
    DEFAULT_MAX_ATTACHMENT_SIZE,
    GATEWAY_API_VERSION,
    HEADER_LAST_EVENT_ID,
    PLATFORM_NAME,
    EventKind,
    _TRUTHY,
    _conf_bool,
    _conf_str,
    _csv_to_list,
    _new_id,
    _now_ms,
    _parse_bind,
    _redact_identity,
)
from .edge import DEFAULT_EDGE_BIND, DEFAULT_EDGE_DASHBOARD_URL, TailnetEdge
from .event_log import (
    HashChainedLog,
    _prepare_sse,
    _sse_event,
    _sse_simple,
    _wire_event,
)
from .push import (
    PUSH_PLATFORMS,
    PUSH_VAPID_SUBJECT,
    _NON_DELIVERABLE_TLDS,
    PushDispatcher,
    PushStore,
    VapidKey,
)
from .sessions import SessionInfo, SessionRegistry

logger = logging.getLogger(__name__)

# Hermes's GatewayStreamConsumer appends this glyph while streaming. The
# cursor inference lives only here: `_split_lifecycle` strips it at the
# adapter boundary and stamps an explicit `payload.lifecycle`; clients treat
# glyph detection as a fallback for rows persisted before this field.
STREAM_CURSOR_CHAR = "▉"

_CURRENT_STREAM_ID: "contextvars.ContextVar[str | None]" = contextvars.ContextVar(
    "open_chat_session_stream_id", default=None,
)


def _split_lifecycle(content, *, final: bool | None = None) -> tuple[str, dict]:
    """Strip a trailing stream cursor and derive the lifecycle stamp.
    ``final=None`` infers the phase from the cursor (send() path)."""
    body = str(content)
    streaming = body.endswith(STREAM_CURSOR_CHAR)
    if streaming:
        body = body[: -len(STREAM_CURSOR_CHAR)]
    phase_final = not streaming if final is None else final
    if phase_final:
        return body, {"phase": "final", "reason": "complete"}
    return body, {"phase": "streaming"}


def _stream_id(fallback: str) -> str:
    return _CURRENT_STREAM_ID.get() or fallback


async def _body_json(request) -> dict:
    """Parse request body as JSON; 400 on malformed input."""
    if not request.can_read_body:
        return {}
    try:
        return await request.json()
    except Exception as exc:
        raise web.HTTPBadRequest(reason="invalid JSON body") from exc


# Skip url completions (network fetch). @image:/@tool: aren't emitted by the
# gateway's complete.path, so they need no entry here.
_COMPLETION_BLOCKED_PREFIXES = ("@url:",)


def _filter_completion_items(items: list) -> list[dict]:
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        text = it.get("text", "")
        if isinstance(text, str) and text.startswith(_COMPLETION_BLOCKED_PREFIXES):
            continue
        out.append(it)
    return out


def _ocs_to_sessiondb_map() -> dict[str, str]:
    """Map OCS session_id -> Hermes SessionDB id via the runner's session_key
    index (sessions.json). Read-only, best-effort: the OCS id is embedded in
    the key as ``…:open_chat_session:group:s_<id>[:suffix]``."""
    out: dict[str, str] = {}
    try:
        from hermes_constants import get_hermes_home
        path = get_hermes_home() / "sessions" / "sessions.json"
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return out
    marker = ":open_chat_session:group:"
    for key, entry in data.items():
        if marker not in key or not isinstance(entry, dict):
            continue
        ocs_id = key.split(marker, 1)[1].split(":", 1)[0]
        sid = entry.get("session_id")
        if ocs_id and sid:
            out[ocs_id] = sid
    return out


def _complete_path_sync(word: str, cwd: str = "") -> list[dict]:
    """Call the gateway's `complete.path` RPC in-process. Blocking (git +
    os.walk) — call via ``asyncio.to_thread``. With no `cwd`, the gateway
    resolves against the agent workspace (TERMINAL_CWD)."""
    # Imported lazily so tui_gateway.server's import-time side effects only load
    # when @-completion is used; the module cache makes re-imports cheap.
    from tui_gateway.server import handle_request
    params: dict = {"word": word}
    if cwd:
        params["cwd"] = cwd
    res = handle_request({
        "jsonrpc": "2.0",
        "id": "ocs-complete",
        "method": "complete.path",
        "params": params,
    })
    result = res.get("result") if isinstance(res, dict) else None
    items = result.get("items") if isinstance(result, dict) else None
    return _filter_completion_items(items) if isinstance(items, list) else []


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
        # Off by default: serves the host's filesystem/git tree to any
        # allowlisted tailnet peer. `completion_cwd` pins the root (default cwd).
        self._context_completion = _conf_bool(
            extra, "context_completion",
            "OPEN_CHAT_SESSION_CONTEXT_COMPLETION", default=False,
        )
        self._completion_cwd = _conf_str(
            extra, "context_completion_cwd",
            "OPEN_CHAT_SESSION_COMPLETION_CWD",
        )

        self._auth = RequestAuthenticator(self._allowed_hosts, self._api_server_key)
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

        self._approvals = ApprovalRail()
        # session_id -> FIFO list of pending clarify_ids. Lets us emit a
        # gateway.clarify.resolved event the moment a user reply arrives so
        # the dashboard's ClarifyBubble disappears immediately (the actual
        # agent-thread unblock is handled by gateway/run.py's text-intercept).
        self._active_clarify_ids: dict[str, list[str]] = {}
        # (session_id, outbound_message_id) -> inbound stream id
        self._message_streams: dict[tuple[str, str], str] = {}
        # chats with a live typing indicator — lets stop_typing emit a single
        # authoritative active:false instead of relying on the client TTL.
        # Serialized by Hermes's per-chat run dispatch (no concurrent send/stop
        # for the same chat_id), so no lock is needed.
        self._typing_on: set[str] = set()
        # (session_id, inbound_stream_id) -> active Hermes dispatch task.
        # This makes /cancel an actual run cancellation path instead of only
        # an audit-log marker.
        self._active_runs: dict[tuple[str, str], asyncio.Task] = {}
        # Strong refs to fire-and-forget approval auto-deny timers so the loop's
        # weak refs can't GC them mid-flight.
        self._timeout_tasks: set[asyncio.Task] = set()

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
        r.add_get("/sessions/{session_id}/complete", self._handle_complete)
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
        body, lifecycle = _split_lifecycle(content)
        await self._log.append(
            session_id, EventKind.MESSAGE_OUT, stream_id,
            {
                "message_id": message_id,
                "content": body,
                "reply_to": reply_to,
                "metadata": metadata or {},
                "lifecycle": lifecycle,
            },
        )
        # Synthetic finalize: a send() without an in-stream cursor is a
        # complete one-shot message that gets no follow-up edit.
        if lifecycle["phase"] == "final":
            await self._log.append(
                session_id, EventKind.MESSAGE_EDIT, stream_id,
                {
                    "message_id": message_id,
                    "content": body,
                    "finalize": True,
                    "lifecycle": lifecycle,
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
        body, lifecycle = _split_lifecycle(content, final=finalize)
        await self._log.append(
            session_id, EventKind.MESSAGE_EDIT, stream_id,
            {
                "message_id": message_id,
                "content": body,
                "finalize": finalize,
                "lifecycle": lifecycle,
            },
        )
        if finalize:
            self._message_streams.pop(key, None)
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id, metadata=None) -> None:
        # Ephemeral presence — broadcast to live subscribers, never persisted, so
        # the hash chain isn't bloated by ~2s heartbeats (was 328 rows/session).
        self._typing_on.add(chat_id)
        self._log.broadcast(
            chat_id, EventKind.TYPING, _stream_id("typing"),
            {"active": True, "metadata": metadata or {}},
        )

    async def stop_typing(self, chat_id) -> None:
        # Authoritative clear at run end/error so clients drop the indicator at
        # once rather than waiting out the heartbeat TTL. Deduped per chat.
        if chat_id not in self._typing_on:
            return
        self._typing_on.discard(chat_id)
        self._log.broadcast(
            chat_id, EventKind.TYPING, _stream_id("typing"),
            {"active": False, "metadata": {}},
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

    async def _authorize(self, request: web.Request) -> tuple[str, list[str]]:
        return await self._auth.authorize(request)

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
            # Ephemeral presence (typing) has no seq and is never part of replay,
            # so it bypasses the resume-point filter; logged events still gate.
            if not ev.get("ephemeral") and ev["seq"] <= skip_below_seq:
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
            "context_completion": self._context_completion,
        })

    async def _handle_sessions_list(self, request) -> web.Response:
        await self._authorize(request)
        include_archived = (
            request.query.get("include_archived", "").lower()
            in _TRUTHY
        )
        id_map = await asyncio.to_thread(_ocs_to_sessiondb_map)
        out = []
        for s in self._sessions.list(include_archived=include_archived):
            tip = self._log.tip(s.session_id)
            out.append({
                **s.to_dict(),
                "tip_seq": tip[0] if tip else 0,
                "tip_hash": tip[1] if tip else "",
                "event_count": tip[0] if tip else 0,
                # Hermes SessionDB id for the same conversation (identity bridge).
                "sessiondb_id": id_map.get(s.session_id),
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
        try:
            limit = int(request.query.get("limit", "100"))
        except ValueError:
            limit = 100
        # Backward paging (scroll-up): the page of events before `before`.
        before = request.query.get("before", "")
        if before:
            before_seq = self._log.lookup_hash(sid, before)
            if not before_seq or before_seq <= 1:
                return web.json_response({"events": []})
            events = self._log.range_before(sid, before_seq, limit=limit)
            resp: dict[str, Any] = {"events": [_wire_event(ev) for ev in events]}
            if events and events[0]["seq"] > 1:
                resp["prev_cursor"] = events[0]["hash"]
            return web.json_response(resp)
        after = request.query.get("after", "")
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

    async def _handle_complete(self, request) -> web.Response:
        # Authorize before the feature check so a probe can't detect it.
        await self._authorize(request)
        sid = request.match_info["session_id"]
        self._require_session(sid, include_archived=True)
        if not self._context_completion:
            raise web.HTTPNotFound(reason="context completion disabled")
        word = request.query.get("word", "")
        if not word:
            return web.json_response({"items": []})
        # Root: explicit override if set, else let the gateway resolve against
        # the agent workspace (TERMINAL_CWD) so the picker matches where the
        # agent actually resolves @file:/@git:.
        try:
            items = await asyncio.to_thread(_complete_path_sync, word, self._completion_cwd)
        except Exception as exc:
            logger.warning("complete.path failed: %s", exc)
            items = []
        return web.json_response({"items": items})


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
