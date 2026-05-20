// Bundle entry. Dashboard's plugin loader injects this as a <script>;
// we register ChatPage so PluginPage can mount it.

import "@/sdk";
import { ChatPage } from "@/pages/ChatPage";
import { injectPwaTags } from "@/push/inject-pwa";

const PLUGIN_NAME = "open-chat-session";

// PWA discovery tags need to be in <head> before the user taps Share →
// Add to Home Screen, so we add them as soon as the bundle loads — long
// before the user opens the chat-session tab.
injectPwaTags();

if (window.__HERMES_PLUGINS__?.register) {
  window.__HERMES_PLUGINS__.register(PLUGIN_NAME, ChatPage);
} else {
  console.error(
    "[open-chat-session] window.__HERMES_PLUGINS__.register missing — plugin SDK not initialised.",
  );
}
