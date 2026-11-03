// Per-user, per-route sliding-window limiter. In-memory, so on serverless it is
// per instance: a cheap first line of defense. Daily AI caps (limits.ts) are the
// durable control and live in Postgres.
const hits = new Map<string, number[]>();

export function checkRate(key: string, perMinute: number, now = Date.now()): boolean {
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (arr.length >= perMinute) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60_000) hits.delete(k);
  return true;
}
