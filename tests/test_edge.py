"""TailnetEdge static-serving contract.

The edge is published to the whole tailnet by Tailscale Serve and its static
path is unauthenticated (the PWA installer must fetch SW/manifest/icons
anonymously). Only `public/` browser assets may be served directly; every
other /dashboard-plugins/ path falls through to the host dashboard, which
enforces its own browser-asset allowlist. In particular plugin_api.py and
.device-id must never be direct-served.
"""

import pytest

from open_chat_session import edge as edge_mod

ROUTE = edge_mod.PLUGIN_DASHBOARD_ROUTE


@pytest.fixture
def edge(tmp_path):
    d = tmp_path / "dashboard"
    for rel, content in {
        "public/sw.js": "// sw",
        "public/manifest.json": "{}",
        "public/icons/192.png": "png",
        "plugin_api.py": "SECRET = 1",
        ".device-id": "dev-123",
        "package.json": "{}",
        "dist/index.js": "// bundle",
        "src/index.tsx": "// src",
    }.items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return edge_mod.TailnetEdge(
        bind="127.0.0.1:0", dashboard_url="http://127.0.0.1:9119",
        dashboard_dir=d,
    )


@pytest.mark.parametrize("rel", [
    "public/sw.js",
    "public/manifest.json",
    "public/icons/192.png",
])
def test_pwa_public_assets_are_direct_served(edge, rel):
    target = edge._resolve_asset(f"{ROUTE}{rel}")
    assert target is not None and target.is_file()


@pytest.mark.parametrize("rel", [
    "plugin_api.py",
    ".device-id",
    "package.json",
    "dist/index.js",
    "src/index.tsx",
    "public/../plugin_api.py",
    "public/%2e%2e/plugin_api.py",
    "public/.hidden",
])
def test_non_public_files_fall_through_to_proxy(edge, rel):
    assert edge._resolve_asset(f"{ROUTE}{rel}") is None


def test_missing_public_file_is_none(edge):
    assert edge._resolve_asset(f"{ROUTE}public/nope.png") is None
