// Minimal SSE frame parser over `fetch().body.getReader()`. Yields one
// frame per `\n\n`-delimited block, preserving `id:` / `event:` /
// concatenated `data:` lines per the spec. Caller closes via AbortSignal.
// Inline (~30 LOC) instead of a runtime dep.

import { SSE_IDLE_TIMEOUT_MS } from "./constants";
import { GatewayError } from "./errors";

export interface SSEFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Read with an idle watchdog. Resolves on the next chunk, or rejects if no
 * bytes arrive within `idleMs`. Heartbeat (`: ping`) frames count as bytes, so
 * a live-but-quiet stream never trips it — only a silently-dead socket does.
 */
async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
): Promise<ReadableStreamReadResult<T>> {
  if (idleMs <= 0) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new GatewayError(504, "stream_idle_timeout", `no SSE data for ${idleMs}ms`)),
      idleMs,
    );
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function* parseSSE(
  res: Response,
  idleMs = SSE_IDLE_TIMEOUT_MS,
): AsyncGenerator<SSEFrame> {
  if (!res.body) {
    throw new GatewayError(503, "no_body", "SSE response had no body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await readWithIdleTimeout(reader, idleMs);
      if (done) return;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseFrame(block);
        if (frame) yield frame;
      }
    }
  } finally {
    // Release the network on idle-timeout throw or caller break/return.
    void reader.cancel().catch(() => undefined);
  }
}

function parseFrame(block: string): SSEFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}
