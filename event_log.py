"""Hash-chained per-session event log and its SSE wire helpers."""

import asyncio
import contextlib
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from aiohttp import web

from .common import GATEWAY_API_VERSION, _canonical_bytes, _now_ms, _sha256_hex

# Page size for paginated log scans (see HashChainedLog.iter_after).
LOG_PAGE_LIMIT = 1000

SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


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

    def broadcast(self, session_id: str, kind: str, stream_id: str, data: dict) -> None:
        """Fan out an ephemeral presence event (typing) to live subscribers only.
        Not persisted and carries no seq/hash — it is never replayed, so presence
        stays out of the hash chain and out of history."""
        event = {
            "seq": 0, "prev_hash": "", "hash": "",
            "session_id": session_id, "stream_id": stream_id,
            "kind": kind, "data": data, "ts": _now_ms(),
            "ephemeral": True,
        }
        for q in list(self._subs[session_id]):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(event)

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

    def range_before(self, session_id: str, before_seq: int,
                     limit: int = LOG_PAGE_LIMIT) -> list[dict]:
        """The ``limit`` events immediately before ``before_seq``, ascending."""
        cur = self._db.execute(
            "SELECT seq, prev_hash, hash, stream_id, kind, data, ts "
            "FROM events WHERE session_id=? AND seq < ? "
            "ORDER BY seq DESC LIMIT ?",
            (session_id, before_seq, limit),
        )
        rows = [self._row_to_event(session_id, r) for r in cur]
        rows.reverse()
        return rows

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


def _sse_event(event_payload: dict) -> bytes:
    """SSE wire bytes for an event. Logged events carry id: <hash>; ephemeral
    presence frames (typing) omit it so they never set the client Last-Event-ID."""
    body = _wire_event(event_payload)
    head = "" if event_payload.get("ephemeral") else f"id: {event_payload['hash']}\n"
    return (
        f"{head}"
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
