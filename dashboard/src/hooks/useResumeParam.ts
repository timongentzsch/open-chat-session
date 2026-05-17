// Read/write `?resume=<id>` without pulling in react-router (not exposed
// via the plugin SDK). Updates use `history.replaceState` so the URL stays
// shareable without triggering a route transition.

import { useCallback, useEffect, useState } from "../sdk";

const PARAM = "resume";

export function useResumeParam(): {
  resume: string | null;
  setResume: (id: string | null) => void;
} {
  const [resume, setResumeState] = useState<string | null>(() => readParam());

  useEffect(() => {
    const onPop = () => setResumeState(readParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setResume = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(PARAM, id);
    else url.searchParams.delete(PARAM);
    window.history.replaceState({}, "", url.toString());
    setResumeState(id);
  }, []);

  return { resume, setResume };
}

function readParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get(PARAM);
  } catch {
    return null;
  }
}
