"""open-chat-session dashboard plugin — authenticated reverse proxy.

Mounted at ``/api/plugins/open-chat-session/<path>`` by the dashboard's plugin
discovery; forwards to the gateway at ``http://127.0.0.1:8765/<path>``.

Auth posture
------------
The dashboard's session-token middleware already protects ``/api/*``. This
proxy adds belt-and-suspenders: gateway credentials are always injected
server-side, and any browser-supplied ``Authorization`` / ``X-Device-Id``
headers are dropped before forwarding upstream. The browser never sees the
gateway bearer token.

Device id
---------
The dashboard process gets one stable ``X-Device-Id`` for the gateway,
persisted in ``~/.hermes/plugins/open_chat_session/dashboard/.device-id``
so the gateway's per-device resume state survives dashboard restarts.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

log = logging.getLogger(__name__)

router = APIRouter()

UPSTREAM = "http://127.0.0.1:8765"

_DEVICE_ID_FILE = Path(__file__).parent / ".device-id"


def _load_or_create_device_id() -> str:
    try:
        if _DEVICE_ID_FILE.exists():
            existing = _DEVICE_ID_FILE.read_text().strip()
            if existing:
                return existing
    except OSError:
        pass
    new = f"dashboard-{uuid.uuid4()}"
    try:
        _DEVICE_ID_FILE.write_text(new)
    except OSError as exc:
        log.warning("could not persist device id: %s", exc)
    return new


DEVICE_ID = _load_or_create_device_id()


def _resolve_api_key() -> Optional[str]:
    """Find the gateway bearer token.

    Order: process env, ~/.hermes/.env, then ~/.hermes/config.yaml — matching
    where ``_conf_str`` in the gateway adapter itself looks (env first, then
    the per-plugin extra/config). On a typical install the value lives in
    config.yaml as a top-level ``API_SERVER_KEY``.
    """
    key = os.getenv("API_SERVER_KEY") or os.getenv("OPEN_CHAT_SESSION_BEARER")
    if key:
        return key
    try:
        from hermes_cli.config import load_env, load_config  # type: ignore

        env = load_env() or {}
        val = env.get("API_SERVER_KEY")
        if isinstance(val, str) and val:
            return val

        cfg = load_config() or {}
        cfg_val = cfg.get("API_SERVER_KEY")
        if isinstance(cfg_val, str) and cfg_val:
            return cfg_val
    except (ImportError, OSError, json.JSONDecodeError) as exc:
        log.warning("could not resolve API_SERVER_KEY from hermes config: %s", exc)
    return None


API_KEY = _resolve_api_key()


_client = httpx.AsyncClient(
    base_url=UPSTREAM,
    timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0),
    follow_redirects=False,
)


_DROP_REQUEST_HEADERS = {
    "host",
    "content-length",
    "authorization",
    "x-device-id",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-authenticate",
}

_DROP_RESPONSE_HEADERS = {
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
}


def _build_upstream_headers(request: Request) -> dict[str, str]:
    headers: dict[str, str] = {}
    for k, v in request.headers.items():
        lk = k.lower()
        if lk in _DROP_REQUEST_HEADERS:
            continue
        headers[k] = v
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    headers["X-Device-Id"] = DEVICE_ID
    return headers


def _passthrough_response_headers(upstream_headers: httpx.Headers) -> dict[str, str]:
    return {
        k: v for k, v in upstream_headers.items()
        if k.lower() not in _DROP_RESPONSE_HEADERS
    }


# PWA assets (sw.js, manifest.json, icons) are served by the plugin's own
# TailnetEdge (adapter.py), not this proxy — it serves dashboard/public/* and
# bypasses the session-token middleware the browser can't send for SW/manifest.

@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
)
async def proxy(path: str, request: Request) -> Response:
    upstream_url = f"/{path}"
    method = request.method
    headers = _build_upstream_headers(request)
    params = list(request.query_params.multi_items())

    accept = request.headers.get("accept", "") or ""
    wants_sse = "text/event-stream" in accept

    # Buffer the body up front: starlette's BaseHTTPMiddleware (used by the
    # dashboard's auth/host middlewares) breaks request.stream() once a
    # StreamingResponse starts — the deferred read sees http.disconnect.
    method_supports_body = method not in ("GET", "HEAD", "DELETE", "OPTIONS")
    request_body = await request.body() if method_supports_body else None

    if wants_sse:
        async def gen() -> AsyncIterator[bytes]:
            try:
                async with _client.stream(
                    method,
                    upstream_url,
                    headers=headers,
                    params=params,
                    content=request_body,
                ) as upstream:
                    if upstream.status_code >= 400:
                        body = await upstream.aread()
                        payload = json.dumps({
                            "code": "upstream_error",
                            "status": upstream.status_code,
                            "message": body.decode("utf-8", "replace"),
                        })
                        yield f"event: gateway.error\ndata: {payload}\n\n".encode()
                        return
                    async for chunk in upstream.aiter_raw():
                        if chunk:
                            yield chunk
            except httpx.HTTPError as exc:
                log.warning("gateway SSE proxy error: %s", exc)
                payload = json.dumps({"code": "upstream_error", "message": str(exc)})
                yield f"event: gateway.error\ndata: {payload}\n\n".encode()
        return StreamingResponse(gen(), media_type="text/event-stream")

    try:
        upstream = await _client.request(
            method,
            upstream_url,
            headers=headers,
            params=params,
            content=request_body,
        )
    except httpx.ConnectError as exc:
        log.warning("gateway connect error: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"gateway unreachable at {UPSTREAM}: {exc}",
        )
    except httpx.HTTPError as exc:
        log.warning("gateway proxy error: %s", exc)
        raise HTTPException(status_code=502, detail=f"gateway error: {exc}")

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_passthrough_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type") or None,
    )
