"""Shared fixtures. The plugin is imported as a package (mirroring hermes's
PluginManager, which loads __init__.py with submodule_search_locations).
Run with the hermes venv: ~/.hermes/hermes-agent/venv/bin/python -m pytest
"""

import sys
from pathlib import Path

import pytest
import pytest_asyncio

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN_ROOT.parent))

from open_chat_session import adapter, event_log  # noqa: E402


@pytest_asyncio.fixture
async def log(tmp_path):
    lg = event_log.HashChainedLog(tmp_path / "log.db")
    await lg.open()
    yield lg
    await lg.close()


@pytest.fixture
def bare_adapter(log):
    """Adapter instance with only the attributes send()/edit_message() touch.

    Constructing the real adapter needs Hermes's platform registry; these
    egress methods only use _log and _message_streams.
    """
    a = adapter.OpenChatSessionAdapter.__new__(adapter.OpenChatSessionAdapter)
    a._log = log
    a._message_streams = {}
    a._typing_on = set()
    return a
