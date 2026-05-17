// Minimal SSE frame parser over `fetch().body.getReader()`. Yields one
// frame per `\n\n`-delimited block, preserving `id:` / `event:` /
// concatenated `data:` lines per the spec. Caller closes via AbortSignal.
// Inline (~30 LOC) instead of a runtime dep.

import { GatewayError } from "./errors";

export interface SSEFrame {
  id?: string;
  event?: string;
  data: string;
}

export async function* parseSSE(res: Response): AsyncGenerator<SSEFrame> {
  if (!res.body) {
    throw new GatewayError(503, "no_body", "SSE response had no body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
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
