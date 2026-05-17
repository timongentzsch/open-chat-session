# open-chat-session

Self-hosted multi-session chat backend with hash-chained per-session event logs, streamed over HTTP + Server-Sent Events.

Ships as a [Hermes Agent](https://github.com/nousresearch/hermes-agent) platform plugin. Includes a dashboard tab that mounts at `/chat-session`, built on `@assistant-ui/react` headless primitives — no styled UI dependencies, no bundled React.

## Features

- Native REST + SSE on `:8765`; no WebSocket framing.
- Hash-chained per-session event log; resume by `Last-Event-ID` or cursor.
- Tailscale `whois` allowlist with bearer-token fallback for localhost/proxy callers.
- Multi-session shared context across hosts (one Hermes conversation per session).
- Inline attachments, exec approvals, typing, and media events as first-class events.
- Dashboard chat with sidebar, attachment upload, approval rail; stock `/chat` is left untouched.

## Layout

```
adapter.py             # Hermes platform adapter + HTTP/SSE server
plugin.yaml            # plugin manifest
dashboard/
  manifest.json        # dashboard plugin manifest
  plugin_api.py        # authenticated reverse proxy to :8765
  src/                 # Vite IIFE using window.__HERMES_PLUGIN_SDK__
  dist/index.js        # built bundle (committed; no React/UI bundled)
```

## Install

Clone into Hermes's plugin directory:

```sh
git clone git@github.com:timongentzsch/open-chat-session.git ~/.hermes/plugins/open_chat_session
```

Set `OPEN_CHAT_SESSION_BIND` (e.g. `0.0.0.0:8765` or `127.0.0.1:8765`) and start Hermes. Dashboard plugin loads on dashboard start.

## Dashboard build

```sh
cd dashboard
npm install
npm run build      # -> dist/index.js
```

Rebuild after source changes; hard-reload the browser to bypass the dashboard's ETag cache. `plugin_api.py` changes require a dashboard restart.

## Protocol

Authenticated routes require `X-Device-Id`. Tailscale identity is matched against `allowed_hosts`; localhost/proxy callers fall back to `Authorization: Bearer <API_SERVER_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/sessions` | list sessions |
| `POST` | `/sessions` | create session |
| `PATCH` | `/sessions/{id}` | rename / update metadata |
| `DELETE` | `/sessions/{id}` | archive (never hard-delete in v0) |
| `GET` | `/sessions/{id}/events` | long-lived SSE event stream |
| `POST` | `/sessions/{id}/messages` | send message; SSE filtered to this run |
| `POST` | `/sessions/{id}/cancel` | close caller-facing stream |
| `GET` | `/sessions/{id}/history` | paginated event replay |
| `POST` | `/sessions/{id}/attachments` | multipart upload |
| `GET` | `/sessions/{id}/attachments/{aid}` | download |
| `POST` | `/sessions/{id}/approvals/{tool_call_id}` | answer pending approval |

SSE envelope:

```
id: <event-hash>
event: <gateway.event.kind>
data: {"schema_version":"2026-05-15","seq":N,"hash":"...","prev_hash":"...","kind":"...","ts":..., "payload":{...}}
```

`id == data.hash`, `event == data.kind`, `seq` monotonic per session, `prev_hash` links the chain. Clients dedupe by `hash` and must ignore unknown event kinds.

## License

MIT — see [LICENSE](LICENSE).
