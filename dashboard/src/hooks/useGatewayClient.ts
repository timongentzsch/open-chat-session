import { useMemo } from "../sdk";
import { GatewayClient } from "../gateway-client";
import { PROXY_BASE } from "../constants";

/** Stable GatewayClient instance — safe in `useEffect` deps. */
export function useGatewayClient(): GatewayClient {
  return useMemo(() => new GatewayClient({ baseUrl: PROXY_BASE }), []);
}
