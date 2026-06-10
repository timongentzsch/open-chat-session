"""_ApprovalRail characterization: first-responder-wins semantics."""

from open_chat_session.approvals import ApprovalRail


def test_resolve_pops_pending_and_records():
    rail = ApprovalRail()
    rail.register("ap_1", session_key="sk", stream_id="i_1")
    pending = rail.resolve("ap_1", decision="once", by="alice", sid="s1", ts=10)
    assert pending == {"session_key": "sk", "stream_id": "i_1"}
    assert rail.get_resolved("ap_1") == {
        "decision": "once", "by": "alice", "sid": "s1", "ts": 10,
    }


def test_second_resolve_returns_none_and_keeps_first_resolution():
    rail = ApprovalRail()
    rail.register("ap_1", session_key="sk", stream_id="i_1")
    assert rail.resolve("ap_1", decision="deny", by="alice", sid="s1", ts=10)
    assert rail.resolve("ap_1", decision="once", by="bob", sid="s1", ts=11) is None
    assert rail.get_resolved("ap_1")["by"] == "alice"
    assert rail.get_resolved("ap_1")["decision"] == "deny"


def test_resolve_unknown_returns_none():
    rail = ApprovalRail()
    assert rail.resolve("ap_x", decision="deny", by="t", sid="s", ts=0) is None
    assert rail.get_resolved("ap_x") is None
