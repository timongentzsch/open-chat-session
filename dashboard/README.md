# Dashboard plugin

First-party graphical chat for the gateway, mounted inside the existing `hermes dashboard` via the plugin extension system. Adds `/chat-session`; leaves built-in `/chat` untouched.

```
~/.hermes/plugins/open_chat_session/
dashboard/
  manifest.json         - discovery manifest
  plugin_api.py         - authenticated reverse proxy to :8765
  src/                  - Vite IIFE using the Hermes Plugin SDK
    index.tsx           - entry; calls register("open-chat-session", ChatPage)
    sdk.ts              - typed view onto window.__HERMES_PLUGIN_SDK__
    types.ts            - client API types
    errors.ts           - GatewayError
    parse-sse.ts        - SSE parser
    gateway-client.ts   - REST + SSE client
    runtime/            - session store + assistant-ui runtime
    hooks/              - session list, stream subscription, resume param
    components/         - sidebar, thread, composer, approval rail, banners
    pages/ChatPage.tsx
  dist/                 - Vite output, shipped in-tree
```

## Build

```sh
cd ~/.hermes/plugins/open_chat_session/dashboard
npm install
npm run build
```

Rebuilds are picked up by the dashboard's static file server live (ETag-validated). The browser may need a hard reload to bypass cache.

`plugin_api.py` changes require a dashboard restart:

```sh
hermes dashboard --stop
hermes dashboard --no-open --skip-build
```

## Reverse proxy & auth

```
Browser --HTTPS--> Dashboard --in-process--> plugin_api.py --HTTP localhost:8765--> gateway
            X-Hermes-Session-Token             Authorization: Bearer <API_SERVER_KEY>
                                              X-Device-Id: dashboard-<uuid>
```

`plugin_api.py`:

- **Strips** browser-supplied `Authorization` and `X-Device-Id` before forwarding.
- **Injects** `Authorization: Bearer <API_SERVER_KEY>`, resolved from `os.getenv`, `~/.hermes/.env`, or `~/.hermes/config.yaml`.
- **Injects** a stable `X-Device-Id` persisted at `dashboard/.device-id` so the gateway's per-device resume state survives dashboard restarts.
- **Streams SSE** end-to-end via `httpx.AsyncClient.stream(...)` and FastAPI `StreamingResponse`.

The proxy targets `http://127.0.0.1:8765`; the gateway's `bind` config must keep a localhost-reachable interface listening (default `0.0.0.0:8765` satisfies this).

`adapter.py::register(ctx)` passes `is_connected=is_platform_connected` so the plugin surfaces in the dashboard's `/sessions > Connected Platforms` panel.

## Resume semantics — `/chat-session?resume=<id>`

| Input | Behaviour |
|---|---|
| native gateway session id (e.g. `s_...`) | select that session |
| any other id | show fallback banner; user picks from the sidebar or opens the id in `hermes --tui` |
| no `?resume=` | restore last-selected (localStorage) or first session |

URL is updated via `history.replaceState` so links stay shareable.

## Uninstall

Remove `dashboard/manifest.json` (or the whole `dashboard/` directory), then `GET /api/dashboard/plugins/rescan`.

## Web Push (not implemented)

Web Push requires PWA scaffolding (root web manifest, root-scoped service worker, stable HTTPS origin, VAPID key surfacing) that the dashboard host does not currently provide. The plugin cannot supply root-scoped assets from `/api/plugins/*`.
