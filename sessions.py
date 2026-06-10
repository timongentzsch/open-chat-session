"""Adapter-owned session registry, materialized from log events."""

import dataclasses
import logging

from .common import EventKind, _new_id, _now_ms, _redact_identity
from .event_log import HashChainedLog

logger = logging.getLogger(__name__)


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
