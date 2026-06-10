"""send()/edit_message() streaming-lifecycle contract.

The Hermes cursor glyph is inferred and stripped at the adapter boundary;
events carry an explicit payload.lifecycle. A one-shot send() still gets a
synthetic finalize edit so it never renders with a stuck streaming cursor.
"""

from open_chat_session import adapter
from open_chat_session.common import EventKind

CURSOR = adapter.STREAM_CURSOR_CHAR


def events(log, sid):
    return log.range_after(sid, 0)


async def test_plain_send_appends_out_plus_synthetic_finalize(bare_adapter, log):
    res = await bare_adapter.send("s1", "hello world")
    assert res.success
    evs = events(log, "s1")
    assert [e["kind"] for e in evs] == [
        EventKind.MESSAGE_OUT, EventKind.MESSAGE_EDIT,
    ]
    out, edit = evs
    assert out["data"]["lifecycle"] == {"phase": "final", "reason": "complete"}
    assert edit["data"]["finalize"] is True
    assert edit["data"]["lifecycle"]["phase"] == "final"
    assert edit["data"]["message_id"] == out["data"]["message_id"]
    assert out["stream_id"] == edit["stream_id"]


async def test_cursor_tailed_send_is_streaming_with_glyph_stripped(bare_adapter, log):
    await bare_adapter.send("s1", f"partial{CURSOR}")
    evs = events(log, "s1")
    assert [e["kind"] for e in evs] == [EventKind.MESSAGE_OUT]
    assert evs[0]["data"]["content"] == "partial"
    assert evs[0]["data"]["lifecycle"] == {"phase": "streaming"}


async def test_streamed_turn_finalizes_via_edit(bare_adapter, log):
    token = adapter._CURRENT_STREAM_ID.set("i_req")
    try:
        res = await bare_adapter.send("s1", f"par{CURSOR}")
        mid = res.message_id
        assert bare_adapter._message_streams[("s1", mid)] == "i_req"
        await bare_adapter.edit_message("s1", mid, f"partial{CURSOR}")
        await bare_adapter.edit_message("s1", mid, "complete", finalize=True)
    finally:
        adapter._CURRENT_STREAM_ID.reset(token)
    evs = events(log, "s1")
    assert [e["kind"] for e in evs] == [
        EventKind.MESSAGE_OUT,
        EventKind.MESSAGE_EDIT,
        EventKind.MESSAGE_EDIT,
    ]
    assert all(e["stream_id"] == "i_req" for e in evs)
    assert evs[1]["data"]["finalize"] is False
    assert evs[1]["data"]["content"] == "partial"
    assert evs[1]["data"]["lifecycle"] == {"phase": "streaming"}
    assert evs[2]["data"]["finalize"] is True
    assert evs[2]["data"]["lifecycle"]["phase"] == "final"
    assert ("s1", mid) not in bare_adapter._message_streams


async def test_edit_message_defaults_to_non_final(bare_adapter, log):
    await bare_adapter.edit_message("s1", "o_x", "progress…")
    (edit,) = events(log, "s1")
    assert edit["data"]["finalize"] is False
    assert edit["data"]["lifecycle"] == {"phase": "streaming"}


def test_split_lifecycle():
    assert adapter._split_lifecycle("done") == (
        "done", {"phase": "final", "reason": "complete"})
    assert adapter._split_lifecycle(f"mid{CURSOR}") == (
        "mid", {"phase": "streaming"})
    assert adapter._split_lifecycle(f"mid{CURSOR}", final=True) == (
        "mid", {"phase": "final", "reason": "complete"})
    assert adapter._split_lifecycle("mid", final=False) == (
        "mid", {"phase": "streaming"})
