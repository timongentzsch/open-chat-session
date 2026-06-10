"""HashChainedLog characterization: chain integrity, fan-out, paging."""

import json

from open_chat_session import event_log
from open_chat_session.common import (
    GATEWAY_API_VERSION,
    EventKind,
    _canonical_bytes,
    _sha256_hex,
)


async def test_append_chains_hashes(log):
    e1 = await log.append("s1", EventKind.MESSAGE_IN, "i_1", {"text": "a"})
    e2 = await log.append("s1", EventKind.MESSAGE_OUT, "i_1", {"content": "b"})
    assert e1["seq"] == 1 and e1["prev_hash"] == ""
    assert e2["seq"] == 2 and e2["prev_hash"] == e1["hash"]
    # Hash covers the canonical event sans its own hash.
    recomputed = _sha256_hex(_canonical_bytes({
        "seq": e2["seq"], "prev_hash": e2["prev_hash"], "session_id": "s1",
        "stream_id": "i_1", "kind": e2["kind"], "data": e2["data"], "ts": e2["ts"],
    }))
    assert recomputed == e2["hash"]


async def test_chains_are_per_session(log):
    a = await log.append("s1", EventKind.MESSAGE_IN, "x", {})
    b = await log.append("s2", EventKind.MESSAGE_IN, "x", {})
    assert a["seq"] == 1 and b["seq"] == 1
    assert log.tip("s1") == (1, a["hash"])
    assert log.tip("s2") == (1, b["hash"])


async def test_subscribers_receive_appends_and_ephemeral_broadcast(log):
    q = log.subscribe("s1")
    appended = await log.append("s1", EventKind.MESSAGE_IN, "x", {"text": "hi"})
    log.broadcast("s1", EventKind.TYPING, "typing", {"active": True})
    got1 = q.get_nowait()
    got2 = q.get_nowait()
    assert got1["hash"] == appended["hash"]
    assert got2["ephemeral"] is True and got2["seq"] == 0 and got2["hash"] == ""
    log.unsubscribe("s1", q)


async def test_broadcast_is_not_persisted(log):
    log.broadcast("s1", EventKind.TYPING, "typing", {"active": True})
    assert log.tip("s1") is None


async def test_range_before_and_after_are_ascending(log):
    for i in range(5):
        await log.append("s1", EventKind.MESSAGE_IN, "x", {"i": i})
    after = log.range_after("s1", 2, limit=10)
    before = log.range_before("s1", 4, limit=2)
    assert [e["seq"] for e in after] == [3, 4, 5]
    assert [e["seq"] for e in before] == [2, 3]


async def test_iter_after_pages_past_limit(log, monkeypatch):
    monkeypatch.setattr(event_log, "LOG_PAGE_LIMIT", 2)
    for i in range(5):
        await log.append("s1", EventKind.MESSAGE_IN, "x", {"i": i})
    assert [e["seq"] for e in log.iter_after("s1", 0)] == [1, 2, 3, 4, 5]


async def test_lookup_hash_roundtrip(log):
    e = await log.append("s1", EventKind.MESSAGE_IN, "x", {})
    assert log.lookup_hash("s1", e["hash"]) == 1
    assert log.lookup_hash("s1", "nope") is None


def test_wire_event_moves_data_to_payload():
    wire = event_log._wire_event({
        "seq": 1, "prev_hash": "", "hash": "h", "session_id": "s",
        "stream_id": "x", "kind": "gateway.message.in", "data": {"text": "t"},
        "ts": 0,
    })
    assert wire["payload"] == {"text": "t"}
    assert "data" not in wire
    assert wire["schema_version"] == GATEWAY_API_VERSION


def test_sse_event_ephemeral_omits_id_line():
    logged = event_log._sse_event({
        "seq": 1, "prev_hash": "", "hash": "abc", "session_id": "s",
        "stream_id": "x", "kind": "gateway.message.in", "data": {}, "ts": 0,
    })
    ephemeral = event_log._sse_event({
        "seq": 0, "prev_hash": "", "hash": "", "session_id": "s",
        "stream_id": "typing", "kind": "gateway.typing",
        "data": {"active": True}, "ts": 0, "ephemeral": True,
    })
    assert logged.startswith(b"id: abc\n")
    assert not ephemeral.startswith(b"id:")
    body = json.loads(ephemeral.split(b"data: ", 1)[1])
    assert body["payload"] == {"active": True}
