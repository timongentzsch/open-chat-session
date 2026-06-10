"""Pending/resolved approval state."""

APPROVAL_TIMEOUT_S = 300
APPROVAL_CHOICES = ("once", "session", "always", "deny")


class ApprovalRail:
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
