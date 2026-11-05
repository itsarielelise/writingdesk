import type { SupabaseClient } from "@supabase/supabase-js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./access";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
export type ImageExt = keyof typeof TYPES;

/** Identify an image by its first bytes; the declared content type is not trusted. */
export function sniffImage(b: Uint8Array): ImageExt | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

/** Store image bytes in the caller's folder (RLS applies via their session). Returns the app-relative src. */
export async function storeImage(supabase: SupabaseClient, userId: string, pieceId: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "That image is over 10 MB.");
  const ext = sniffImage(bytes);
  if (!ext) throw new HttpError(415, "That file isn’t a PNG, JPEG, WebP or GIF image.");
  const { data: piece } = await supabase.from("pieces").select("id").eq("id", pieceId).maybeSingle();
  if (!piece) throw new HttpError(404, "That piece couldn’t be found.");
  const path = `${userId}/${pieceId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("images").upload(path, bytes, { contentType: TYPES[ext], upsert: false });
  if (error) throw error;
  return `/api/images/${path}`;
}

/* ---------- fetching images from the web (pasted from pages or docs) ---------- */

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, "That isn’t a web address."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only web images can be copied.");
  if (u.username || u.password) throw new HttpError(400, "That address isn’t allowed.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new HttpError(400, "That address isn’t allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, "That image’s site couldn’t be found.");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "That address isn’t allowed.");
  return u;
}

/** Download a public image (max 10 MB, 15 s, 3 redirects), checking every hop. */
export async function fetchPublicImage(raw: string, signal?: AbortSignal): Promise<Uint8Array> {
  let url = await assertPublicUrl(raw);
  const timeout = AbortSignal.timeout(15_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: sig, headers: { accept: "image/*", "user-agent": "WritingDesk/1.0 (image import)" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok || !res.body) throw new HttpError(422, "That image couldn’t be downloaded.");
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES) throw new HttpError(413, "That image is over 10 MB.");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) { reader.cancel().catch(() => {}); throw new HttpError(413, "That image is over 10 MB."); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  throw new HttpError(422, "That image redirected too many times.");
}
