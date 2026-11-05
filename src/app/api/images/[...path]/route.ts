import { NextResponse } from "next/server";
import { HttpError, route } from "@/lib/server/access";

const PART = /^[0-9a-f-]{36}$/;
const FILE = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

/** Serve a stored image to its owner by redirecting to a short-lived signed URL. */
export const GET = route<{ path: string[] }>("images.get", async ({ supabase, user, params }) => {
  const p = params.path || [];
  if (p.length !== 3 || !PART.test(p[0]) || !PART.test(p[1]) || !FILE.test(p[2])) throw new HttpError(404, "Not found.");
  if (p[0] !== user.id) throw new HttpError(404, "Not found.");
  const { data, error } = await supabase.storage.from("images").createSignedUrl(p.join("/"), 3600);
  if (error || !data?.signedUrl) throw new HttpError(404, "Not found.");
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "cache-control": "private, max-age=3000" } });
}, { perMinute: 1200 });
