import { useCallback, useEffect, useState } from "../sdk";
import type { GatewayClient } from "../gateway-client";
import { errorMessage } from "../errors";
import type { SessionInfo } from "../types";

export interface UseSessionsResult {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (name?: string) => Promise<SessionInfo | null>;
  archiveSession: (sessionId: string) => Promise<boolean>;
}

export function useSessions(client: GatewayClient): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await client.listSessions({ includeArchived: false });
      setSessions(list);
      setError(null);
    } catch (exc) {
      setError(errorMessage(exc));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createSession = useCallback(
    async (name?: string) => {
      try {
        const s = await client.createSession({ name });
        await refresh();
        return s;
      } catch (exc) {
        setError(errorMessage(exc));
        return null;
      }
    },
    [client, refresh],
  );

  const archiveSession = useCallback(
    async (sessionId: string) => {
      // Optimistically drop the row so the click feels instant; refresh
      // reconciles with the gateway's hash chain.
      setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
      try {
        await client.archiveSession(sessionId);
        await refresh();
        return true;
      } catch (exc) {
        setError(errorMessage(exc));
        await refresh();
        return false;
      }
    },
    [client, refresh],
  );

  return { sessions, loading, error, refresh, createSession, archiveSession };
}
