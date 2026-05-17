// Bundle entry. Dashboard's plugin loader injects this as a <script>;
// we register ChatPage so PluginPage can mount it.

import "@/sdk";
import { ChatPage } from "@/pages/ChatPage";

const PLUGIN_NAME = "open-chat-session";

if (window.__HERMES_PLUGINS__?.register) {
  window.__HERMES_PLUGINS__.register(PLUGIN_NAME, ChatPage);
} else {
  console.error(
    "[open-chat-session] window.__HERMES_PLUGINS__.register missing — plugin SDK not initialised.",
  );
}
