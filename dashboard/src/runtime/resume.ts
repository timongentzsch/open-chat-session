// Persisted last-known event hash per session (sessionStorage) +
// last-selected session id (localStorage). Both are advisory: the SSE
// loop always re-fetches /history on session change, so a stale cursor
// can't black-hole the thread.

const NS = "hgw:";

export function setLastHash(sessionId: string, hash: string | null): void {
  try {
    if (hash) sessionStorage.setItem(`${NS}lastHash:${sessionId}`, hash);
    else sessionStorage.removeItem(`${NS}lastHash:${sessionId}`);
  } catch {
    /* sessionStorage may be unavailable in private mode */
  }
}

export function getLastHash(sessionId: string): string | null {
  try {
    return sessionStorage.getItem(`${NS}lastHash:${sessionId}`);
  } catch {
    return null;
  }
}

export function getSelectedSession(): string | null {
  try {
    return localStorage.getItem(`${NS}selectedSession`);
  } catch {
    return null;
  }
}

export function setSelectedSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(`${NS}selectedSession`, id);
    else localStorage.removeItem(`${NS}selectedSession`);
  } catch {
    /* ignore */
  }
}
