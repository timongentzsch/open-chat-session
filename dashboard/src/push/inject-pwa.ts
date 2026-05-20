import { PWA_MANIFEST_URL, PWA_APPLE_TOUCH_ICON_URL } from "@/constants";

const META = {
  "viewport": "width=device-width, initial-scale=1, viewport-fit=cover",
  "mobile-web-app-capable": "yes",
  "apple-mobile-web-app-capable": "yes",
  "apple-mobile-web-app-status-bar-style": "black-translucent",
  "apple-mobile-web-app-title": "OCS Chat",
};

let injected = false;

export function injectPwaTags(): void {
  if (injected) return;
  injected = true;

  const head = document.head;
  if (!head) return;

  upsertLink("manifest", PWA_MANIFEST_URL, { type: "application/manifest+json" });
  upsertLink("apple-touch-icon", PWA_APPLE_TOUCH_ICON_URL, { sizes: "180x180" });
  Object.entries(META).forEach(([name, content]) => upsertMeta(name, content));
}

function upsertLink(rel: string, href: string, attrs: Record<string, string>): void {
  if (document.querySelector(`link[rel="${rel}"]`)) return;
  const el = document.createElement("link");
  el.rel = rel;
  el.href = href;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  document.head.appendChild(el);
}

function upsertMeta(name: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}
