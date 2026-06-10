"""PushDispatcher._select_targets characterization: policy, mute, session
filter, dedupe window, approval bypass, active-view suppression, preview."""

import pytest
import pytest_asyncio

from open_chat_session import push
from open_chat_session.common import EventKind
from open_chat_session.sessions import SessionRegistry


SUB = {
    "endpoint": "https://push.example/ep1",
    "keys": {"p256dh": "k", "auth": "a"},
}


@pytest_asyncio.fixture
async def push_store(tmp_path):
    store = push.PushStore(tmp_path / "push.db")
    store.open()
    yield store
    store.close()


@pytest.fixture
def dispatcher(log, push_store):
    registry = SessionRegistry(log)
    active_views: dict = {}
    d = push.PushDispatcher(
        log=log, store=push_store, vapid=None, vapid_subject="mailto:t@example.com",
        session_registry=registry, active_views=active_views,
    )
    d._active_views_ref = active_views
    return d


def make_event(kind, sid="s1", ts=1_000_000, data=None):
    return {
        "seq": 1, "prev_hash": "", "hash": "h", "session_id": sid,
        "stream_id": "x", "kind": kind, "data": data or {}, "ts": ts,
    }


async def register(store, *, user="alice", device="d1", policy=None,
                   sessions=None, endpoint="https://push.example/ep1"):
    sub = {**SUB, "endpoint": endpoint}
    return await store.upsert(
        device_id=device, user_id=user, platform="web",
        subscription=sub, policy=policy or {}, sessions=sessions,
    )


async def test_message_out_targets_subscribed_device(dispatcher, push_store):
    await register(push_store)
    targets, suppressed = dispatcher._select_targets(
        make_event(EventKind.MESSAGE_OUT))
    assert len(targets) == 1 and not suppressed
    device, title, body = targets[0]
    assert device.user_id == "alice"
    assert title == "s1"  # unknown session falls back to sid as title
    assert body == "New message"  # redacted default (no preview opt-in)


async def test_typing_kind_never_notifies(dispatcher, push_store):
    await register(push_store)
    targets, _ = dispatcher._select_targets(make_event(EventKind.TYPING))
    assert targets == []


async def test_policy_false_and_muted_and_session_filter_skip(dispatcher, push_store):
    await register(push_store, device="d1", policy={"message_out": False})
    await register(push_store, user="bob", device="d2",
                   policy={"muted_session_ids": ["s1"]},
                   endpoint="https://push.example/ep2")
    await register(push_store, user="carol", device="d3",
                   sessions=["other"], endpoint="https://push.example/ep3")
    targets, _ = dispatcher._select_targets(make_event(EventKind.MESSAGE_OUT))
    assert targets == []


async def test_dedupe_window_skips_then_allows(dispatcher, push_store):
    await register(push_store)
    dispatcher._last_push[("alice", "s1")] = 999_000  # 1s before event ts
    targets, _ = dispatcher._select_targets(
        make_event(EventKind.MESSAGE_OUT, ts=1_000_000))
    assert targets == []  # inside default 5s window
    targets, _ = dispatcher._select_targets(
        make_event(EventKind.MESSAGE_OUT, ts=1_005_001))
    assert len(targets) == 1


async def test_approval_bypasses_dedupe(dispatcher, push_store):
    await register(push_store)
    dispatcher._last_push[("alice", "s1")] = 999_900
    targets, _ = dispatcher._select_targets(
        make_event(EventKind.APPROVAL_REQUEST, ts=1_000_000,
                   data={"tool_name": "exec", "prompt": "rm -rf?"}))
    assert len(targets) == 1
    assert targets[0][2] == "Approval required"


async def test_active_view_suppresses_user(dispatcher, push_store):
    await register(push_store)
    dispatcher._active_views_ref[("alice", "s1", "browser-1")] = 1
    targets, suppressed = dispatcher._select_targets(
        make_event(EventKind.MESSAGE_OUT))
    assert targets == []
    assert suppressed == {"alice"}


async def test_preview_text_opt_in_truncates(dispatcher, push_store):
    await register(push_store, policy={"preview_text": True})
    long_text = "x" * 500
    targets, _ = dispatcher._select_targets(
        make_event(EventKind.MESSAGE_OUT, data={"content": long_text}))
    body = targets[0][2]
    assert body.endswith("…")
    assert len(body) <= push.PUSH_BODY_MAX_CHARS


def test_payload_shape(dispatcher):
    import json
    payload = json.loads(dispatcher._build_payload(
        title="General", body="hi", session_id="s_1", app_badge="3"))
    assert payload["web_push"] == 8030
    assert payload["notification"]["navigate"] == "/chat-session?resume=s_1"
    assert payload["notification"]["app_badge"] == "3"
    assert payload["session_id"] == "s_1"
