/**
 * The public origin the browser used. Behind a host's proxy (Render, etc.)
 * `request.url` can be the internal address (e.g. http://localhost:10000), so
 * prefer the forwarded headers, then SITE_URL.
 */
export function publicOrigin(request: Request): string {
  const h = request.headers;
  const host = (h.get("x-forwarded-host") || h.get("host") || "").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") || "").split(",")[0].trim() || (host.startsWith("localhost") ? "http" : "https");
  if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host)) return `${proto}://${host}`;
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}
