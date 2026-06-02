// Live `@`-reference completion adapter backed by the gateway's complete.path
// RPC. assistant-ui's `search()` is sync, so we return cached items and rebuild
// the adapter when an async fetch resolves.

import { useCallback, useMemo, useRef, useState } from "@/sdk";
import type {
  Unstable_DirectiveFormatter,
  Unstable_TriggerAdapter,
  Unstable_TriggerItem,
} from "@assistant-ui/core";
import type { GatewayClient } from "@/gateway-client";
import type { CompletionItem } from "@/types";

const DEBOUNCE_MS = 120;

const STARTERS: readonly Unstable_TriggerItem[] = [
  { id: "@diff", type: "git", label: "@diff", description: "unstaged git diff", metadata: { rawText: "@diff" } },
  { id: "@staged", type: "git", label: "@staged", description: "staged git diff", metadata: { rawText: "@staged" } },
];

function classify(text: string): string {
  if (text.startsWith("@file:")) return "file";
  if (text.startsWith("@folder:")) return "folder";
  if (text.startsWith("@diff") || text.startsWith("@staged") || text.startsWith("@git")) return "git";
  return "ref";
}

function toItems(raw: CompletionItem[]): Unstable_TriggerItem[] {
  const out: Unstable_TriggerItem[] = [];
  raw.forEach((it, i) => {
    const text = it.text;
    // Bare `@kind:` starters can't insert cleanly (the appended space ends the
    // trigger), so list concrete refs / fuzzy hits only.
    if (!text || text.endsWith(":")) return;
    out.push({
      id: `${text}|${i}`,
      type: classify(text),
      label: it.display || text,
      ...(it.meta ? { description: it.meta } : {}),
      metadata: { rawText: text },
    });
  });
  return out;
}

const FORMATTER: Unstable_DirectiveFormatter = {
  serialize: (item) => {
    const raw = item.metadata?.["rawText"];
    return typeof raw === "string" ? raw : item.label;
  },
  parse: (text) => [{ kind: "text", text }],
};

export function useAtCompletions(
  client: GatewayClient,
  sessionId: string,
): { adapter: Unstable_TriggerAdapter; formatter: Unstable_DirectiveFormatter } {
  const cacheRef = useRef<Map<string, Unstable_TriggerItem[]>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [version, setVersion] = useState(0);

  // Bump a generation on session change so a stale in-flight fetch from the
  // previous session can't write into the new session's cache.
  const genRef = useRef(0);
  const sidRef = useRef(sessionId);
  if (sidRef.current !== sessionId) {
    sidRef.current = sessionId;
    genRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    cacheRef.current = new Map();
    inflightRef.current = new Set();
  }

  const fetchFor = useCallback((query: string) => {
    if (cacheRef.current.has(query) || inflightRef.current.has(query)) return;
    const gen = genRef.current;
    inflightRef.current.add(query);
    client.complete(sessionId, "@" + query)
      .then((items) => {
        if (gen !== genRef.current) return;
        cacheRef.current.set(query, toItems(items));
        setVersion((v) => v + 1);
      })
      .catch(() => undefined)
      .finally(() => {
        if (gen === genRef.current) inflightRef.current.delete(query);
      });
  }, [client, sessionId]);

  const adapter = useMemo<Unstable_TriggerAdapter>(() => ({
    categories: () => [],
    categoryItems: () => [],
    search: (query: string) => {
      const cached = cacheRef.current.get(query);
      if (!cached && !inflightRef.current.has(query)) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fetchFor(query), DEBOUNCE_MS);
      }
      return cached ?? (query ? [] : STARTERS);
    },
    // `version` rebuilds the adapter when a fetch resolves, so the popover
    // re-derives against the freshly-cached items.
  }), [fetchFor, version]);

  return useMemo(() => ({ adapter, formatter: FORMATTER }), [adapter]);
}
