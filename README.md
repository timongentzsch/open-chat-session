# open-chat-session

<p align="center">
  <img src="assets/dashboard-preview.webp" alt="Hermes Agent dashboard showing the open chat session reference client" width="100%">
</p>

Hermes Agent chat platform plugin centered on the **open chat protocol**: a
native REST + SSE surface for persistent sessions, streaming messages,
attachments, approvals, push, and resumable event history.

The bundled `/chat-session` dashboard tab is a reference implementation of that
protocol. It is useful as the default UI, but the protocol is the stable
integration surface for other web, mobile, CLI, or peer clients. The plugin does
not replace the stock `/chat` page.

## Current Surface

- Native REST + SSE gateway on `127.0.0.1:8765`.
- Plugin-owned HTTPS-friendly edge on `127.0.0.1:9120` for Tailscale Serve.
- Reference dashboard UI built from `@assistant-ui/react` headless primitives.
- Multi-session chat with rename, history replay (forward + backward paging),
  live streaming, replies, attachments, ephemeral typing, slash commands, opt-in
  `@`-context completion, clarify prompts, exec approvals, cancellation, and
  background Web Push.
- Dashboard caches each session's transcript in `localStorage` for an instant
  reopen, then resumes from the cached tip hash to fetch only new events.
- Sessions report their Hermes `SessionDB` id (`sessiondb_id`), so the same
  conversation is addressable across the dashboard, desktop app, and TUI.
- Hash-chained per-session `log.db`; blobs stored content-addressed in
  `attachments/`; push subscriptions stored separately in `push.db`.
- Plugin-contained PWA assets and mobile metadata; no Hermes host edits.

## Layout

```text
adapter.py              # platform adapter, REST/SSE server, event log, edge, push
plugin.yaml             # Hermes plugin manifest
requirements.txt        # Python runtime deps
dashboard/
  manifest.json         # dashboard plugin manifest, entry hash auto-updated
  plugin_api.py         # authenticated reverse proxy to :8765
  src/                  # Vite IIFE using window.__HERMES_PLUGIN_SDK__
  public/               # service worker, web manifest, icons
  dist/                 # committed build output
```

## Install

```sh
git clone https://github.com/timongentzsch/open-chat-session.git ~/.hermes/plugins/open_chat_session
~/.hermes/hermes-agent/venv/bin/python -m pip install -r ~/.hermes/plugins/open_chat_session/requirements.txt
```

Start Hermes normally. Defaults:

- gateway API: `127.0.0.1:8765`
- plugin edge: `127.0.0.1:9120`
- Hermes dashboard upstream: `http://127.0.0.1:9119`

Keep the Hermes dashboard on loopback and publish the plugin edge:

```sh
hermes dashboard --host 127.0.0.1 --no-open --skip-build
tailscale serve --bg http://127.0.0.1:9120
```

Useful env overrides:

- `OPEN_CHAT_SESSION_BIND`
- `OPEN_CHAT_SESSION_EDGE_ENABLED`
- `OPEN_CHAT_SESSION_EDGE_BIND`
- `OPEN_CHAT_SESSION_EDGE_DASHBOARD_URL`
- `OPEN_CHAT_SESSION_DATA_DIR`
- `OPEN_CHAT_SESSION_CONTEXT_COMPLETION` (opt-in `@`-completion; default off)
- `OPEN_CHAT_SESSION_COMPLETION_CWD` (advanced override for the `@`-completion
  root; defaults to the agent workspace `terminal.cwd` / `TERMINAL_CWD`)

## Dashboard Build

Only needed when changing `dashboard/src` or `dashboard/public`.

```sh
cd ~/.hermes/plugins/open_chat_session/dashboard
npm install
npm run build
```

`npm run build` runs Vite and then updates `dashboard/manifest.json` with the
current `dist/index.js` hash, so the plugin host cache is busted automatically.
Changes to `plugin_api.py` require restarting `hermes dashboard`.

## Protocol

Browser calls go through `dashboard/plugin_api.py`, which injects
`Authorization: Bearer <API_SERVER_KEY>` and a stable dashboard `X-Device-Id`.
Direct clients must send auth and `X-Device-Id` themselves.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` / `POST` | `/sessions` | list or create sessions |
| `PATCH` / `DELETE` | `/sessions/{id}` | update metadata or archive |
| `GET` | `/sessions/{id}/events` | SSE stream |
| `POST` | `/sessions/{id}/messages` | send message and stream this run |
| `POST` | `/sessions/{id}/cancel` | cancel active run and resolve blockers |
| `GET` | `/sessions/{id}/history` | event replay (`?after=` forward, `?before=` backward) |
| `GET` | `/sessions/{id}/complete` | `@`-reference completions (opt-in — see Context Completion) |
| `POST` | `/sessions/{id}/attachments` | multipart upload |
| `GET` | `/sessions/{id}/attachments/{aid}` | download |
| `POST` | `/sessions/{id}/approvals/{tool_call_id}` | answer approval |
| `GET` | `/devices/push/vapid-public-key` | VAPID public key |
| `POST` / `DELETE` | `/devices/push[/{device_id}]` | manage push device |

SSE events use the event hash as `id`; clients should dedupe by `hash` and
ignore unknown `kind` values. Ephemeral presence (`gateway.typing`) is the
exception: it is broadcast live only — no `id`, no `seq`, never replayed — so
clients drive the indicator off a short receipt-time TTL.

## Context Completion

`@`-references (`@file:src/app.ts`, `@diff`, `@staged`, `@git:`, `@folder:`) are
completed server-side against the **agent workspace** (`terminal.cwd` /
`TERMINAL_CWD`) — the same root the agent resolves `@file:` against, shared by
all sessions (Hermes has no per-session workspace; scope it per profile).

**Off by default** — enabling it exposes that workspace's tree and git history to
every allowlisted Tailscale peer. Enable with
`OPEN_CHAT_SESSION_CONTEXT_COMPLETION=1`; `/health` reports `context_completion`
so clients can gate the affordance. `OPEN_CHAT_SESSION_COMPLETION_CWD` is an
advanced override (may diverge from where the agent reads). Picked refs are
inserted as plain `@type:value` text the agent resolves; `@url:`/`@image:`/
`@tool:` are not served.

## Push

Push works through the plugin edge on a trusted HTTPS origin, for example:

```sh
tailscale serve --bg http://127.0.0.1:9120
```

Open `https://<machine>.ts.net/chat-session`. On iOS, install to Home Screen,
reopen from the icon, then tap `enable push`. Android Chrome can subscribe
directly. Notifications include message previews by default and are suppressed
for a user when that same session is already open on any of their dashboard
devices.

## Validate

```sh
~/.hermes/hermes-agent/venv/bin/python -m py_compile adapter.py dashboard/plugin_api.py
cd dashboard && ./node_modules/.bin/tsc --noEmit && npm run build
git diff --check
```

## License

MIT
