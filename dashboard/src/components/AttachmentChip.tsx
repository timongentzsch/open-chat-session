import { React, cn, useEffect, useState } from "@/sdk";
import type { AttachmentRef } from "@/types";

const PROXY_BASE = "/api/plugins/open-chat-session";
const SIZE_UNITS = ["B", "kB", "MB", "GB"];

function humanSize(bytes: number): string {
  if (!bytes) return "0 B";
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${SIZE_UNITS[i]}`;
}

function kindLabel(mime = ""): string {
  if (mime.includes("pdf")) return "PDF";
  if (mime.startsWith("image/")) return "IMG";
  if (mime.startsWith("video/")) return "VID";
  if (mime.startsWith("audio/")) return "AUD";
  if (mime.startsWith("text/")) return "TXT";
  if (mime.includes("json")) return "JSON";
  return "FILE";
}

function displayName(a: AttachmentRef): string {
  if (a.filename) return a.filename;
  const kind = kindLabel(a.mime).toLowerCase();
  return `${kind}-${(a.attachment_id || a.sha256 || "attachment").slice(0, 10)}`;
}

function useAuthedBlobUrl(url: string | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let revoke: string | null = null;
    const token = window.__HERMES_SESSION_TOKEN__;
    const headers: Record<string, string> = {};
    if (token) headers["X-Hermes-Session-Token"] = token;
    fetch(url, { headers })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => {
        if (cancelled) return;
        revoke = URL.createObjectURL(blob);
        setBlobUrl(revoke);
      })
      .catch(() => {
        /* chip still renders without thumbnail */
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [url]);
  return blobUrl;
}

function useAttachmentLink(attachment: AttachmentRef, sessionId: string) {
  const fallback = `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.attachment_id)}`;
  const raw = attachment.url ?? fallback;
  const url = raw.startsWith("/") ? `${PROXY_BASE}${raw}` : raw;
  const sameOrigin = url.startsWith(PROXY_BASE);
  const blobUrl = useAuthedBlobUrl(sameOrigin ? url : null);
  return {
    href: sameOrigin ? (blobUrl ?? url) : url,
    imageSrc: sameOrigin ? blobUrl : url,
  };
}

export function AttachmentChip({
  attachment,
  sessionId,
  inline,
}: {
  attachment: AttachmentRef;
  sessionId: string;
  inline?: boolean;
}) {
  const { href, imageSrc } = useAttachmentLink(attachment, sessionId);
  const isImage = (attachment.mime ?? "").startsWith("image/");
  const name = displayName(attachment);
  const kind = kindLabel(attachment.mime);
  const size = humanSize(attachment.size);
  const title = `${attachment.mime} · ${attachment.sha256?.slice(0, 8) ?? ""}`;
  const anchorProps = { href, target: "_blank", rel: "noreferrer", title } as const;

  if (inline && isImage) {
    return (
      <a
        {...anchorProps}
        className="block max-w-[18rem] overflow-hidden rounded-md border border-midground/25 bg-background/30 hover:border-midground/45"
      >
        {imageSrc ? (
          <img src={imageSrc} alt="" loading="lazy" className="max-h-64 w-full bg-black/20 object-contain" />
        ) : (
          <div className="flex h-28 items-center justify-center text-xs text-midground/50">loading image</div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-midground/15 px-2 py-1">
          <span className="truncate text-[11px] text-foreground/80">{name}</span>
          <span className="shrink-0 text-[10px] text-midground/60">{`${kind} · ${size}`}</span>
        </div>
      </a>
    );
  }

  return (
    <a
      {...anchorProps}
      className={cn(
        "inline-flex h-9 max-w-[18rem] items-center gap-2 rounded-md border border-midground/30 px-2 text-[11px]",
        "text-midground/80 hover:bg-foreground/[0.04] hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-6 w-8 shrink-0 items-center justify-center rounded border border-midground/20",
          "bg-foreground/[0.04] font-mondwest text-[10px] text-midground/70",
        )}
      >
        {kind}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <span className="shrink-0 text-[10px] text-midground/60">{size}</span>
    </a>
  );
}
