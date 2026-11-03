"use client";
import type { StreamEvent } from "@/lib/server/stream";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // Session ended or access was removed: go back to the front door.
      if (typeof window !== "undefined" && res.status === 401) window.location.href = "/";
    }
    throw new ApiError(res.status, data?.error || "Connection problem. Try again.");
  }
  return data as T;
}

/** POST and read an NDJSON event stream. Resolves when the stream ends. */
export async function streamApi(path: string, json: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json), signal });
  if (!res.ok || !res.body) {
    let msg = "Connection problem. Try again.";
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { onEvent(JSON.parse(line)); } catch { /* skip */ } }
    }
  }
}

export const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

const tf = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }) : null;
const df = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }) : null;
export function when(t: string | number): string {
  const d = new Date(t), n = new Date();
  return (d.toDateString() === n.toDateString() ? "Today " : df!.format(d) + ", ") + tf!.format(d);
}

export function ls(k: string, v?: string): string | null {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); return v; } catch { return null; }
}
