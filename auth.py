"""Request authentication: Tailscale whois with bearer-token fallback."""

import asyncio
import hmac
import json
import logging
import time

from aiohttp import web

from .common import HEADER_AUTHORIZATION, HEADER_DEVICE_ID, HEADER_DEVICE_ID_OVERRIDE

logger = logging.getLogger(__name__)

# How long a resolved `tailscale whois` lookup is reused before re-spawning the
# subprocess for the same peer.
WHOIS_CACHE_TTL_S = 5.0


class RequestAuthenticator:
    def __init__(self, allowed_hosts: set[str], api_server_key: str):
        self._allowed_hosts = allowed_hosts
        self._api_server_key = api_server_key
        # peer_ip -> (monotonic_expiry, (login, tags)); bounds whois subprocess
        # spawns to ~1 per peer per TTL, even on unauthenticated /health.
        self._whois_cache: dict[str, tuple[float, tuple[str | None, list[str]]]] = {}

    async def whois(self, peer_ip: str | None) -> tuple[str | None, list[str]]:
        if not peer_ip:
            return None, []
        if peer_ip in ("127.0.0.1", "::1"):
            return None, []
        cached = self._whois_cache.get(peer_ip)
        now = time.monotonic()
        if cached is not None and cached[0] > now:
            return cached[1]
        result: tuple[str | None, list[str]] = (None, [])
        try:
            proc = await asyncio.create_subprocess_exec(
                "tailscale", "whois", "--json", peer_ip,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            if proc.returncode == 0:
                data = json.loads(stdout)
                user = (data.get("UserProfile") or {}).get("LoginName")
                tags = (data.get("Node") or {}).get("Tags") or []
                result = (user, list(tags))
        except (asyncio.TimeoutError, json.JSONDecodeError,
                FileNotFoundError, OSError) as exc:
            logger.debug("tailscale whois failed: %s", exc)
        self._whois_cache[peer_ip] = (now + WHOIS_CACHE_TTL_S, result)
        return result

    async def authorize(self, request: web.Request) -> tuple[str, list[str]]:
        # X-Device-Id is required on every authenticated endpoint — it
        # scopes per-(device, session) resume cursors and lets us reason
        # about which app instance is talking. Spec: stable UUID per app
        # install. We don't validate the UUID format (any non-empty string
        # is accepted) but it must be present.
        device_id = (request.headers.get(HEADER_DEVICE_ID) or "").strip()
        if not device_id:
            raise web.HTTPBadRequest(reason=f"{HEADER_DEVICE_ID} header required")
        request["device_id"] = device_id
        request["client_device_id"] = (
            request.headers.get(HEADER_DEVICE_ID_OVERRIDE)
            or device_id
        ).strip()

        peer_ip = request.remote
        user, tags = await self.whois(peer_ip)
        if user is not None:
            if (self._allowed_hosts
                    and user not in self._allowed_hosts
                    and not any(t in self._allowed_hosts for t in tags)):
                raise web.HTTPForbidden(reason="host not in allowlist")
            return user, tags
        # Bearer fallback
        if not self._api_server_key:
            raise web.HTTPUnauthorized(
                reason="bearer auth not configured (set API_SERVER_KEY)",
            )
        auth = request.headers.get(HEADER_AUTHORIZATION, "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not token or not hmac.compare_digest(token, self._api_server_key):
            raise web.HTTPUnauthorized(reason="valid bearer token required")
        return f"bearer:{device_id}", []
