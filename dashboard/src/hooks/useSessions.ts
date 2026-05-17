import { useCallback, useEffect, useState } from "../sdk";
import type { GatewayClient } from "../gateway-client";
import type { SessionInfo } from "../types";

export interface UseSessionsResult {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (name?: string) => Promise<SessionInfo | null>;
  archive: (id: string) => Promise<void>;
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
      setError(exc instanceof Error ? exc.message : String(exc));
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
        setError(exc instanceof Error ? exc.message : String(exc));
        return null;
      }
    },
    [client, refresh],
  );

  const archive = useCallback(
    async (id: string) => {
      try {
        await client.archiveSession(id);
        await refresh();
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : String(exc));
      }
    },
    [client, refresh],
  );

  return { sessions, loading, error, refresh, createSession, archive };
}
