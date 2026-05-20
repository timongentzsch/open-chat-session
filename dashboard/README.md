# Dashboard Plugin

Reference web client for the `open_chat_session` protocol, mounted at
`/chat-session` inside `hermes dashboard`. The open chat protocol is the primary
surface; this dashboard is one plugin-contained implementation and leaves stock
`/chat` untouched.

## Pieces

```text
manifest.json          # dashboard plugin metadata, entry hash managed by build
plugin_api.py          # dashboard-side proxy to http://127.0.0.1:8765
public/                # sw.js, web manifest, icons
src/index.tsx          # register("open-chat-session", ChatPage)
src/sdk.ts             # typed window.__HERMES_PLUGIN_SDK__ access
src/gateway-client.ts  # REST + SSE client
src/runtime/           # event store + assistant-ui runtime bridge
src/components/        # thread, composer, sidebar, attachments, banners, push
src/chat-styles.ts     # scoped CSS using Hermes dashboard tokens
dist/                  # committed Vite output
scripts/               # build helpers
```

## Build

```sh
cd ~/.hermes/plugins/open_chat_session/dashboard
npm install
npm run build
```

The build runs Vite and `scripts/update-entry-hash.mjs`. The script hashes
`dist/index.js` and rewrites `manifest.json` only when the entry URL changes,
so cache busting is automatic.

## Runtime Path

```text
Browser
  -> plugin edge :9120 when published through Tailscale
  -> hermes dashboard :9119
  -> plugin_api.py
  -> open_chat_session gateway :8765
```

`plugin_api.py` strips browser-supplied auth headers, injects the dashboard
bearer token, injects a stable `X-Device-Id`, and streams SSE without buffering.

## Mobile And Push

- PWA files are served by the plugin edge from `/dashboard-plugins/...`.
- `src/push/inject-pwa.ts` injects manifest, Apple icon, viewport, and iOS
  standalone metadata.
- Inputs are 16px on mobile to avoid iOS focus zoom.
- The composer has no visible send/stop button; Enter submits and assistant-ui
  still exposes cancellation through its runtime hook.
- Push notifications show message previews by default and are suppressed when
  the session is already open for the same gateway user on any dashboard device.

## Notes

Slash commands use assistant-ui trigger popover primitives with an internal
scroll area. The UI should inherit Hermes dashboard tokens (`background`,
`foreground-base`, `midground`, `success`, `warning`, `destructive`) instead of
hard-coded palette colors.
