import { useMemo } from "../sdk";
import { GatewayClient } from "../gateway-client";

const PROXY_BASE = "/api/plugins/open-chat-session";

/** Stable GatewayClient instance — safe in `useEffect` deps. */
export function useGatewayClient(): GatewayClient {
  return useMemo(() => new GatewayClient({ baseUrl: PROXY_BASE }), []);
}
