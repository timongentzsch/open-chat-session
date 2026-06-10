"""Content-addressed attachment storage and media-ref helpers."""

import contextlib
import dataclasses
import hashlib
import mimetypes
import os
import shutil
import sqlite3
import uuid
from pathlib import Path
from urllib.parse import unquote

from aiohttp import web

from .common import DEFAULT_MAX_ATTACHMENT_SIZE, _now_ms


@dataclasses.dataclass
class AttachmentInfo:
    attachment_id: str
    mime: str
    size: int
    uploaded_by: str
    uploaded_at: int


def _ext_from_mime(mime: str) -> str:
    mapping = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
        "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov",
        "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
        "application/pdf": ".pdf", "text/plain": ".txt",
    }
    return mapping.get(mime, "")


def _resolve_local_ref(ref: str) -> str | None:
    """Return a filesystem path if `ref` resolves to one we should host
    (raw path or `file://` URL); otherwise None. http/https/data/existing
    /sessions/ URLs pass through as remote refs."""
    if not ref:
        return None
    if ref.startswith(("http://", "https://", "data:", "/sessions/")):
        return None
    if ref.startswith("file://"):
        from urllib.parse import urlparse
        parsed = urlparse(ref)
        path = unquote(parsed.path or "")
        return path if path else None
    if ref.startswith(("/", "./")):
        return ref
    return None


_MIME_BY_EXT = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain",
}


def _mime_from_url(url: str) -> str:
    lower = url.lower().split("?", 1)[0]
    dot = lower.rfind(".")
    return _MIME_BY_EXT.get(lower[dot:], "") if dot >= 0 else ""


def _attachment_ref(
    url: str, *,
    mime: str = "", filename: str | None = None,
    caption: str | None = None, size: int = 0, sha256: str = "",
) -> dict:
    """Coerce a media URL into an AttachmentRef dict.

    Hermes can hand us external URLs (DALL-E, S3) where size/sha256
    aren't free. We fill what we can — attachment_id resolved from a
    `/attachments/<id>` path when present, else stable hash of the URL.
    """
    aid = ""
    m = url.rfind("/attachments/")
    if m >= 0:
        tail = url[m + len("/attachments/"):]
        aid = tail.split("/", 1)[0].split("?", 1)[0].split(".", 1)[0]
    if not aid:
        aid = hashlib.sha256(url.encode()).hexdigest()[:32]
    ref = {
        "attachment_id": aid,
        "url": url,
        "mime": mime or _mime_from_url(url),
        "size": size,
        "sha256": sha256 or (aid if size and aid else ""),
    }
    if filename:
        ref["filename"] = filename
    if caption:
        ref["caption"] = caption
    return ref


class AttachmentStore:
    def __init__(self, root: Path, max_size: int = DEFAULT_MAX_ATTACHMENT_SIZE):
        self._root = root
        self._max_size = max_size
        root.mkdir(parents=True, exist_ok=True)
        self._meta_db = sqlite3.connect(
            str(root / "attachments.db"), check_same_thread=False,
        )
        self._meta_db.executescript(
            """
            CREATE TABLE IF NOT EXISTS attachments (
                attachment_id TEXT PRIMARY KEY,
                mime          TEXT NOT NULL,
                size          INTEGER NOT NULL,
                uploaded_by   TEXT NOT NULL,
                uploaded_at   INTEGER NOT NULL,
                ext           TEXT
            );
            """
        )
        self._meta_db.commit()

    async def upload(self, field, uploaded_by: str,
                     mime_hint: str = "application/octet-stream") -> AttachmentInfo:
        h = hashlib.sha256()
        size = 0
        tmp = self._root / f".tmp-{uuid.uuid4().hex}"
        try:
            with open(tmp, "wb") as f:
                while True:
                    chunk = await field.read_chunk(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self._max_size:
                        raise web.HTTPRequestEntityTooLarge(
                            max_size=self._max_size, actual_size=size,
                        )
                    h.update(chunk)
                    f.write(chunk)
            digest = h.hexdigest()
            ext = _ext_from_mime(mime_hint)
            final = self._root / f"{digest}{ext}"
            if final.exists():
                tmp.unlink()
            else:
                tmp.rename(final)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
            raise

        uploaded_at = _now_ms()
        try:
            self._meta_db.execute(
                "INSERT INTO attachments (attachment_id, mime, size, "
                "uploaded_by, uploaded_at, ext) VALUES (?,?,?,?,?,?)",
                (digest, mime_hint, size, uploaded_by, uploaded_at, ext),
            )
            self._meta_db.commit()
        except sqlite3.IntegrityError:
            # dedup — return the original row so uploaded_at / uploaded_by
            # reflect the first upload, not now.
            prior = self.info(digest)
            if prior is not None:
                return prior[0]

        return AttachmentInfo(
            attachment_id=digest, mime=mime_hint, size=size,
            uploaded_by=uploaded_by, uploaded_at=uploaded_at,
        )

    def upload_local(
        self, src_path: str, uploaded_by: str,
        mime_hint: str | None = None,
    ) -> AttachmentInfo:
        """Copy a local file into the store. Used when Hermes sends media via
        ``send_image_file``/``send_voice``/etc. — we host the bytes so the
        dashboard can fetch them through the proxy (Discord-style)."""
        if not os.path.exists(src_path):
            raise FileNotFoundError(src_path)
        size = os.path.getsize(src_path)
        if size > self._max_size:
            raise ValueError(
                f"attachment {src_path} is {size} bytes; max is {self._max_size}",
            )
        if not mime_hint:
            mime_hint, _ = mimetypes.guess_type(src_path)
            mime_hint = mime_hint or "application/octet-stream"
        h = hashlib.sha256()
        with open(src_path, "rb") as f:
            for chunk in iter(lambda: f.read(64 * 1024), b""):
                h.update(chunk)
        digest = h.hexdigest()
        ext = _ext_from_mime(mime_hint) or os.path.splitext(src_path)[1]
        final = self._root / f"{digest}{ext}"
        if not final.exists():
            shutil.copyfile(src_path, final)
        uploaded_at = _now_ms()
        try:
            self._meta_db.execute(
                "INSERT INTO attachments (attachment_id, mime, size, "
                "uploaded_by, uploaded_at, ext) VALUES (?,?,?,?,?,?)",
                (digest, mime_hint, size, uploaded_by, uploaded_at, ext),
            )
            self._meta_db.commit()
        except sqlite3.IntegrityError:
            prior = self.info(digest)
            if prior is not None:
                return prior[0]
        return AttachmentInfo(
            attachment_id=digest, mime=mime_hint, size=size,
            uploaded_by=uploaded_by, uploaded_at=uploaded_at,
        )

    def info(self, attachment_id: str) -> tuple[AttachmentInfo, Path] | None:
        cur = self._meta_db.execute(
            "SELECT mime, size, uploaded_by, uploaded_at, ext "
            "FROM attachments WHERE attachment_id=?",
            (attachment_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        mime, size, uploaded_by, uploaded_at, ext = row
        return (
            AttachmentInfo(
                attachment_id=attachment_id, mime=mime, size=size,
                uploaded_by=uploaded_by, uploaded_at=uploaded_at,
            ),
            self._root / f"{attachment_id}{ext or ''}",
        )
