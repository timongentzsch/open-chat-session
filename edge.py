"""Tailnet edge: local reverse proxy published by Tailscale Serve."""

import asyncio
import contextlib
import logging
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx
from aiohttp import ClientSession, WSMsgType, web

from .common import DEFAULT_MAX_ATTACHMENT_SIZE, _parse_bind

logger = logging.getLogger(__name__)

DEFAULT_EDGE_BIND = "127.0.0.1:9120"
DEFAULT_EDGE_DASHBOARD_URL = "http://127.0.0.1:9119"
PLUGIN_DASHBOARD_NAME = "open-chat-session"
PLUGIN_DASHBOARD_ROUTE = f"/dashboard-plugins/{PLUGIN_DASHBOARD_NAME}/"

# Browser-safe suffixes eligible for unauthenticated direct serving from
# dashboard/public/ (PWA assets). Everything else proxies to the host.
_EDGE_PUBLIC_SUFFIXES = {
    ".js", ".mjs", ".json", ".webmanifest", ".html", ".css", ".svg",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff2", ".woff",
}

_HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class TailnetEdge:
    """Local reverse proxy for Tailscale Serve.

    Tailscale should publish this listener, not the Hermes dashboard directly.
    The edge rewrites the upstream Host header to loopback so Hermes' dashboard
    DNS-rebinding guard stays intact, and it serves this plugin's PWA assets
    itself so they do not rely on host edits.
    """

    def __init__(self, bind: str, dashboard_url: str, dashboard_dir: Path):
        self._bind = bind
        self._dashboard_url = dashboard_url.rstrip("/")
        self._dashboard_dir = dashboard_dir.resolve()
        self._dashboard_host = urlsplit(self._dashboard_url).netloc
        self._app = web.Application(client_max_size=DEFAULT_MAX_ATTACHMENT_SIZE * 2)
        self._app.router.add_route("*", "/{path:.*}", self._handle)
        self._client: ClientSession | None = None
        self._http: httpx.AsyncClient | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.BaseSite | None = None

    async def start(self) -> None:
        self._client = ClientSession(auto_decompress=False)
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(5.0, read=None))
        self._runner = web.AppRunner(self._app, access_log=None)
        await self._runner.setup()
        host, port = _parse_bind(self._bind)
        self._site = web.TCPSite(self._runner, host=host, port=port)
        await self._site.start()
        logger.info(
            "open-chat-session tailnet edge listening on %s:%s -> %s",
            host, port, self._dashboard_url,
        )

    async def stop(self) -> None:
        if self._site:
            with contextlib.suppress(Exception):
                await self._site.stop()
        if self._runner:
            with contextlib.suppress(Exception):
                await self._runner.cleanup()
        if self._client:
            with contextlib.suppress(Exception):
                await self._client.close()
        if self._http:
            with contextlib.suppress(Exception):
                await self._http.aclose()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        if request.path.startswith(PLUGIN_DASHBOARD_ROUTE):
            target = self._resolve_asset(request.rel_url.raw_path)
            if target is not None:
                return self._file_response(target)
            # Fall through: the host dashboard serves the remaining plugin
            # files behind its own browser-asset allowlist, so plugin sources
            # and dotfiles are never exposed on this unauthenticated listener.
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await self._proxy_websocket(request)
        return await self._proxy_http(request)

    def _resolve_asset(self, raw_path: str) -> Path | None:
        """Filesystem target for a direct-served PWA asset, or None to proxy.

        Tailscale Serve publishes this listener tailnet-wide and this path is
        unauthenticated (the PWA installer fetches SW/manifest/icons
        anonymously), so eligibility is strict: browser-suffixed files under
        dashboard/public/ only, no dotfiles.
        """
        rel = unquote(raw_path[len(PLUGIN_DASHBOARD_ROUTE):]).lstrip("/")
        parts = rel.split("/")
        if parts[0] != "public" or any(not p or p.startswith(".") for p in parts):
            return None
        public_root = (self._dashboard_dir / "public").resolve()
        target = (self._dashboard_dir / rel).resolve()
        if not target.is_relative_to(public_root):
            return None
        if target.suffix.lower() not in _EDGE_PUBLIC_SUFFIXES:
            return None
        if not target.is_file():
            return None
        return target

    def _file_response(self, target: Path) -> web.FileResponse:
        headers = {}
        if target.name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
            headers["Cache-Control"] = "no-store"
        elif target.name == "manifest.json":
            headers["Cache-Control"] = "no-store"

        media_type = {
            ".js": "application/javascript",
            ".mjs": "application/javascript",
            ".css": "text/css",
            ".json": "application/manifest+json" if target.name == "manifest.json" else "application/json",
            ".webmanifest": "application/manifest+json",
            ".html": "text/html",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
        }.get(target.suffix.lower(), "application/octet-stream")
        headers["Content-Type"] = media_type
        return web.FileResponse(target, headers=headers)

    def _upstream_headers(self, request: web.Request) -> dict[str, str]:
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in _HOP_BY_HOP_HEADERS
        }
        headers["Host"] = self._dashboard_host
        headers["X-Forwarded-Host"] = request.headers.get("host", "")
        headers["X-Forwarded-Proto"] = "https"
        return headers

    def _upstream_url(self, request: web.Request, *, websocket: bool = False) -> str:
        base = self._dashboard_url
        if websocket:
            if base.startswith("https://"):
                base = "wss://" + base[len("https://"):]
            elif base.startswith("http://"):
                base = "ws://" + base[len("http://"):]
        return f"{base}{request.raw_path}"

    async def _proxy_http(self, request: web.Request) -> web.StreamResponse:
        if self._http is None:
            raise web.HTTPServiceUnavailable(reason="tailnet edge not started")
        try:
            upstream_cm = self._http.stream(
                request.method,
                self._upstream_url(request),
                headers=self._upstream_headers(request),
                content=await request.read(),
                follow_redirects=False,
            )
        except Exception as exc:
            logger.warning("tailnet edge dashboard proxy failed: %s", exc)
            raise web.HTTPBadGateway(reason="dashboard unreachable") from exc

        try:
            async with upstream_cm as upstream:
                headers = {
                    k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP_HEADERS
                }
                response = web.StreamResponse(
                    status=upstream.status_code,
                    reason=upstream.reason_phrase,
                    headers=headers,
                )
                # Once prepare() flushes headers a fresh 502 is impossible, so a
                # mid-stream failure logs and aborts; only a pre-prepare failure
                # becomes HTTPBadGateway (outer except).
                await response.prepare(request)
                try:
                    async for chunk in upstream.aiter_raw():
                        await response.write(chunk)
                    await response.write_eof()
                except Exception as exc:
                    logger.warning(
                        "tailnet edge dashboard proxy aborted mid-stream: %s",
                        exc,
                    )
                return response
        except Exception as exc:
            logger.warning("tailnet edge dashboard proxy failed: %s", exc)
            raise web.HTTPBadGateway(reason="dashboard unreachable") from exc

    async def _proxy_websocket(self, request: web.Request) -> web.WebSocketResponse:
        if self._client is None:
            raise web.HTTPServiceUnavailable(reason="tailnet edge not started")
        browser_ws = web.WebSocketResponse()
        await browser_ws.prepare(request)
        try:
            upstream_ws = await self._client.ws_connect(
                self._upstream_url(request, websocket=True),
                headers=self._upstream_headers(request),
                autoping=True,
            )
        except Exception as exc:
            logger.warning("tailnet edge websocket proxy failed: %s", exc)
            await browser_ws.close(code=1011, message=b"dashboard unreachable")
            return browser_ws

        async with upstream_ws:
            async def browser_to_upstream() -> None:
                async for msg in browser_ws:
                    if msg.type == WSMsgType.TEXT:
                        await upstream_ws.send_str(msg.data)
                    elif msg.type == WSMsgType.BINARY:
                        await upstream_ws.send_bytes(msg.data)
                    elif msg.type == WSMsgType.CLOSE:
                        await upstream_ws.close()

            async def upstream_to_browser() -> None:
                async for msg in upstream_ws:
                    if msg.type == WSMsgType.TEXT:
                        await browser_ws.send_str(msg.data)
                    elif msg.type == WSMsgType.BINARY:
                        await browser_ws.send_bytes(msg.data)
                    elif msg.type == WSMsgType.CLOSE:
                        await browser_ws.close()

            tasks = [
                asyncio.create_task(browser_to_upstream()),
                asyncio.create_task(upstream_to_browser()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                with contextlib.suppress(Exception):
                    task.result()
        return browser_ws
