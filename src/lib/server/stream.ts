// Newline-delimited JSON streaming from route handlers to the browser.
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "citation"; url: string; title: string }
  | { type: "status"; text: string }
  | { type: "done"; truncated?: boolean }
  | { type: "error"; message: string };

export function ndjson(run: (send: (e: StreamEvent) => void, signal: AbortSignal) => Promise<void>, reqSignal: AbortSignal): Response {
  const enc = new TextEncoder();
  const ctl = new AbortController();
  reqSignal.addEventListener("abort", () => ctl.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const send = (e: StreamEvent) => { try { c.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { /* closed */ } };
      try { await run(send, ctl.signal); }
      finally { try { c.close(); } catch { /* closed */ } }
    },
    cancel() { ctl.abort(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
