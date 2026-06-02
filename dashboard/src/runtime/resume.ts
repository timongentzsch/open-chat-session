// Last-selected session id (localStorage), restored on next visit.

const NS = "hgw:";

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
