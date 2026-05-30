import { React, cn, useEffect, useState } from "@/sdk";
import type { AttachmentRef } from "@/types";
import { PROXY_BASE, authHeaders, humanSize, BLOB_URL_CLEANUP_MS } from "@/constants";
import { SURFACE_CSS } from "@/chat-styles";
import { DownloadIcon, FileIcon } from "@/components/icons";

type RenderKind = "image" | "video" | "audio" | "file";

function renderKind(mime = ""): RenderKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function displayName(a: AttachmentRef): string {
  if (a.filename) return a.filename;
  const kind = renderKind(a.mime);
  return `${kind}-${(a.attachment_id || a.sha256 || "attachment").slice(0, 10)}`;
}

function useAuthedBlobUrl(url: string | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setBlobUrl(null);
      return;
    }
    const ac = new AbortController();
    let objectUrl: string | null = null;
    setBlobUrl(null);
    fetch(url, { headers: authHeaders(), signal: ac.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((exc) => {
        if (!(exc instanceof DOMException && exc.name === "AbortError")) {
          setBlobUrl(null);
        }
      });
    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return blobUrl;
}

function downloadBlob(blob: Blob, name: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), BLOB_URL_CLEANUP_MS);
}

function useAttachmentLink(attachment: AttachmentRef, sessionId: string, preview: boolean) {
  const fallback = `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.attachment_id)}`;
  const raw = attachment.url ?? fallback;
  const url = raw.startsWith("/") ? `${PROXY_BASE}${raw}` : raw;
  const sameOrigin = url.startsWith(PROXY_BASE);
  const blobUrl = useAuthedBlobUrl(preview && sameOrigin ? url : null);
  return {
    url,
    sameOrigin,
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
  const kind = renderKind(attachment.mime);
  const shouldPreview = !!inline && kind !== "file";
  const { url, sameOrigin, href, imageSrc } = useAttachmentLink(attachment, sessionId, shouldPreview);
  const name = displayName(attachment);
  const size = humanSize(attachment.size);
  const title = `${attachment.mime} · ${attachment.sha256?.slice(0, 8) ?? ""}`;
  const anchorProps = { href, target: "_blank", rel: "noreferrer", title } as const;
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "error">("idle");

  async function handleDownload(e: React.MouseEvent<HTMLElement>): Promise<void> {
    if (!sameOrigin) return;
    e.preventDefault();
    if (downloadState === "loading") return;
    setDownloadState("loading");
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      downloadBlob(await res.blob(), name);
      setDownloadState("idle");
    } catch {
      setDownloadState("error");
    }
  }

  function DownloadControl() {
    const label = `Download ${name}`;
    const content = downloadState === "loading" ? "..." : downloadState === "error" ? "!" : <DownloadIcon />;
    const className = cn(
      "flex h-8 w-8 shrink-0 items-center justify-center border border-midground/20 text-midground/70",
      "transition hover:border-midground/45 hover:text-foreground",
      downloadState === "error" && "border-destructive/40 text-destructive",
    );
    if (!sameOrigin) {
      return (
        <a {...anchorProps} download={name} aria-label={label} className={className}>
          {content}
        </a>
      );
    }
    return (
      <button
        data-aui-ocs-control
        type="button"
        onClick={handleDownload}
        disabled={downloadState === "loading"}
        aria-label={label}
        title={label}
        className={className}
      >
        {content}
      </button>
    );
  }

  function MediaFooter({ label }: { label: string }) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-midground/15 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">{name}</span>
        <span className="shrink-0 text-[10px] text-midground/60">{`${label} · ${size}`}</span>
        <DownloadControl />
      </div>
    );
  }

  if (inline && kind === "image") {
    return (
      <div
        data-aui-ocs-attachment
        className="block max-w-[18rem] overflow-hidden border border-midground/25 bg-background/30 hover:border-midground/45"
      >
        <a {...anchorProps} className="block">
          {imageSrc ? (
            <img src={imageSrc} alt="" loading="lazy" className="max-h-64 w-full bg-background/30 object-contain" />
          ) : (
            <div className="flex h-28 items-center justify-center text-xs text-midground/50">loading image</div>
          )}
        </a>
        <MediaFooter label="image" />
      </div>
    );
  }

  if (inline && kind === "video") {
    return (
      <div
        data-aui-ocs-attachment
        className="max-w-[22rem] overflow-hidden border border-midground/25 bg-background/30"
      >
        {imageSrc ? (
          <video src={imageSrc} controls className="max-h-72 w-full bg-background/30" />
        ) : (
          <div className="flex h-28 items-center justify-center text-xs text-midground/50">loading video</div>
        )}
        <MediaFooter label="video" />
      </div>
    );
  }

  if (inline && kind === "audio") {
    return (
      <div
        data-aui-ocs-attachment
        className="max-w-[22rem] overflow-hidden border border-midground/25 bg-background/30"
      >
        <div className="p-2">
          {imageSrc ? (
            <audio src={imageSrc} controls className="w-full" />
          ) : (
            <div className="flex h-10 items-center justify-center text-xs text-midground/50">loading audio</div>
          )}
        </div>
        <MediaFooter label="audio" />
      </div>
    );
  }

  return (
    <a
      data-aui-ocs-attachment
      {...anchorProps}
      download={!sameOrigin ? name : undefined}
      onClick={handleDownload}
      aria-label={`Download ${name}`}
      style={{ width: "18rem" }}
      className={cn(
        "inline-flex min-h-14 max-w-full items-center gap-3 border border-midground/30 bg-background/30 px-3 py-2 text-xs",
        "text-midground/80 transition hover:border-midground/50 hover:text-foreground",
        downloadState === "error" && "border-destructive/40 text-destructive",
      )}
    >
      <style href="ocs-style-surface" precedence="default">{SURFACE_CSS}</style>
      <span
        aria-hidden
        data-aui-ocs-surface="mid"
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center border border-midground/20",
          "text-midground/70",
        )}
      >
        <FileIcon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground/90">{name}</span>
        <span className="mt-0.5 block text-[11px] text-midground/60">{size}</span>
      </span>
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center border border-midground/20 text-midground/70"
      >
        {downloadState === "loading" ? "..." : downloadState === "error" ? "!" : <DownloadIcon />}
      </span>
    </a>
  );
}
