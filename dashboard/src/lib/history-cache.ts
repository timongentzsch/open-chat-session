// Local cache of a session's transcript so reopening renders instantly and we
// fetch only the delta after the cached tip — the server compares by hash (the
// cached tip is sent as Last-Event-ID; it replays newer events or sends
// gateway.resync if the hash is unknown). Best-effort: any storage failure
// degrades silently to "no cache".

import type { EventEnvelope } from "@/types";

const KEY_PREFIX = "ocs:hist:";
const SCHEMA = 1;
const MAX_SESSIONS = 10;  // LRU cap across sessions (evicted by last-write time)
const MAX_EVENTS = 600;   // per-session cap after compaction
const CURSOR = "▉";  // streaming cursor glyph, stripped when freezing the cache

export interface CachedHistory {
  v: number;
  t: number;          // last-write time, for LRU eviction
  lastSeq: number;
  lastHash: string | null;
  firstSeq: number;
  firstHash: string | null;
  events: EventEnvelope[];
}

/** Cursor + raw transcript events as held by the store (uncompacted). */
export interface HistorySnapshot {
  lastSeq: number;
  lastHash: string | null;
  events: EventEnvelope[];
}

function mid(ev: EventEnvelope): string | undefined {
  return (ev.payload as { message_id?: string } | null | undefined)?.message_id;
}

function remove(sessionId: string): void {
  try { window.localStorage.removeItem(KEY_PREFIX + sessionId); } catch { /* best effort */ }
}

/** Evict least-recently-written caches beyond the LRU cap (scan keys; no index,
 *  so it is robust to multi-tab races). `keepFresh` is never evicted. */
function evict(keepFresh: string): void {
  try {
    const entries: Array<{ key: string; t: number }> = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      let t = 0;
      try { t = (JSON.parse(window.localStorage.getItem(key) || "{}").t as number) || 0; } catch { /* corrupt → t=0, evict first */ }
      entries.push({ key, t });
    }
    entries.sort((a, b) => a.t - b.t); // oldest first
    const keepKey = KEY_PREFIX + keepFresh;
    for (const e of entries.slice(0, Math.max(0, entries.length - MAX_SESSIONS))) {
      if (e.key !== keepKey) { try { window.localStorage.removeItem(e.key); } catch { /* best effort */ } }
    }
  } catch { /* best effort */ }
}

export function clearHistory(sessionId: string): void {
  remove(sessionId);
}

export function loadHistory(sessionId: string): CachedHistory | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + sessionId);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedHistory;
    if (!c || c.v !== SCHEMA || !Array.isArray(c.events)) { remove(sessionId); return null; }
    return c;
  } catch {
    return null;
  }
}

export function saveHistory(sessionId: string, snap: HistorySnapshot): void {
  // Drop superseded intermediate edits, then freeze each message's final edit
  // (cache is a settled snapshot — a stale stream must not show as "running").
  const events = freezeTail(compactEvents(snap.events));
  if (events.length === 0) return;
  const oldest = events[0];
  const entry: CachedHistory = {
    v: SCHEMA,
    t: Date.now(),
    lastSeq: snap.lastSeq,
    lastHash: snap.lastHash,
    // Oldest RETAINED event so `before=firstHash` paging never points past a
    // compacted/capped boundary.
    firstSeq: oldest.seq,
    firstHash: oldest.hash,
    events,
  };
  // Don't let a stale tab regress a newer cached tip.
  const existing = loadHistory(sessionId);
  if (existing && existing.lastSeq > entry.lastSeq) return;

  const payload = JSON.stringify(entry);
  try {
    window.localStorage.setItem(KEY_PREFIX + sessionId, payload);
    evict(sessionId);
  } catch {
    evict(sessionId);
    try { window.localStorage.setItem(KEY_PREFIX + sessionId, payload); } catch { /* give up */ }
  }
}

/** Run-compaction: drop a `message.edit` when the next transcript event (by seq)
 *  is another edit of the same message_id. message.in/out/media break a run, so
 *  the last pre-steer edit (the segment-split boundary) and each message's final
 *  edit are always kept — the fold output is byte-identical. Caps to MAX_EVENTS. */
export function compactEvents(events: EventEnvelope[]): EventEnvelope[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const out: EventEnvelope[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const next = sorted[i + 1];
    const superseded =
      ev.kind === "gateway.message.edit" &&
      next?.kind === "gateway.message.edit" &&
      mid(next) === mid(ev);
    if (!superseded) out.push(ev);
  }
  return out.length > MAX_EVENTS ? out.slice(out.length - MAX_EVENTS) : out;
}

/** Mark each message's final edit/out as finalized and strip the streaming
 *  cursor, so a cached mid-stream tip doesn't reopen as a stuck "typing" bubble.
 *  A live delta (a later edit of the same id) overrides this on reconnect. */
function freezeTail(events: EventEnvelope[]): EventEnvelope[] {
  const lastIdx = new Map<string, number>();
  events.forEach((ev, i) => {
    const id = mid(ev);
    if (id && (ev.kind === "gateway.message.edit" || ev.kind === "gateway.message.out")) lastIdx.set(id, i);
  });
  return events.map((ev, i) => {
    if (lastIdx.get(mid(ev) ?? "") !== i) return ev;
    const p = ev.payload as { content?: string } | null;
    const content = typeof p?.content === "string" && p.content.endsWith(CURSOR)
      ? p.content.slice(0, -1) : p?.content;
    return {
      ...ev,
      payload: {
        ...(p ?? {}),
        content,
        finalize: true,
        lifecycle: { phase: "final", reason: "complete" },
      },
    };
  });
}
