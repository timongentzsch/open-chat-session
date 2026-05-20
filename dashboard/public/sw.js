const CHAT_URL = "/chat-session";
const ICON_URL = new URL("icons/192.png", self.location.href).href;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch (_) {
    return { title: "open-chat-session", body: "New message" };
  }
}

function notificationData(event) {
  const payload = readPayload(event);
  const note = payload.notification || payload;
  const sessionId = payload.session_id || "";
  return {
    title: note.title || payload.title || "open-chat-session",
    body: note.body || payload.body || "",
    sessionId,
    navigate: note.navigate || (sessionId ? `${CHAT_URL}?resume=${sessionId}` : CHAT_URL),
    badge: note.app_badge ?? payload.app_badge,
  };
}

async function focusedOnSession(sessionId) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return wins.some((c) => {
    if (!c.focused) return false;
    try {
      const u = new URL(c.url);
      return u.pathname === CHAT_URL && (!sessionId || u.searchParams.get("resume") === sessionId);
    } catch (_) {
      return false;
    }
  });
}

function updateBadge(badge) {
  if (badge === undefined || !("setAppBadge" in navigator)) return;
  const n = Number(badge);
  const op = Number.isFinite(n) && n > 0
    ? navigator.setAppBadge?.(n)
    : navigator.clearAppBadge?.();
  op?.catch(() => undefined);
}

async function focusOrOpen(target) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of wins) {
    try {
      if (new URL(client.url).pathname !== CHAT_URL) continue;
      await client.focus();
      if (client.navigate) await client.navigate(target).catch(() => undefined);
      return;
    } catch (_) {
      // ignore malformed URLs
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const { title, body, sessionId, navigate, badge } = notificationData(event);
    if (await focusedOnSession(sessionId)) {
      navigator.clearAppBadge?.().catch(() => undefined);
      return;
    }
    updateBadge(badge);
    await self.registration.showNotification(title, {
      body,
      tag: sessionId || "open-chat-session",
      icon: ICON_URL,
      badge: ICON_URL,
      data: { navigate, session_id: sessionId },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusOrOpen(event.notification.data?.navigate || CHAT_URL));
});
