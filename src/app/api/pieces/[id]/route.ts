import { body, HttpError, json, route, uuid } from "@/lib/server/access";
import { piecePatch } from "@/lib/server/schemas";
import { docWordCount, sanitizeDoc } from "@/lib/doc/model";

type P = { id: string };

/** Everything needed to open a piece in one round trip. */
export const GET = route<P>("pieces.get", async ({ supabase, params }) => {
  const id = uuid.parse(params.id);
  const [piece, versions, parked, flags, meta, notes] = await Promise.all([
    supabase.from("pieces").select("*").eq("id", id).maybeSingle(),
    supabase.from("versions").select("*").eq("piece_id", id).order("created_at", { ascending: false }).limit(200),
    supabase.from("parked_items").select("id,text,created_at").eq("piece_id", id).order("created_at", { ascending: false }),
    supabase.from("flags").select("*").eq("piece_id", id).eq("status", "open").order("created_at", { ascending: false }),
    supabase.from("paragraph_meta").select("pid,rev_count").eq("piece_id", id),
    supabase.from("notes").select("id,text,image_src,created_at,updated_at").eq("piece_id", id).order("created_at", { ascending: false }),
  ]);
  for (const r of [piece, versions, parked, flags, meta, notes]) if (r.error) throw r.error;
  if (!piece.data) throw new HttpError(404, "That piece couldn’t be found.");
  const p = { ...piece.data, content: sanitizeDoc(piece.data.content) };
  const vs = (versions.data || []).map((v) => ({ ...v, content: sanitizeDoc(v.content) }));
  return json({
    piece: p, versions: vs, parked: parked.data, notes: notes.data, flags: flags.data,
    meta: Object.fromEntries((meta.data || []).map((m) => [m.pid, m.rev_count])),
  });
});

export const PATCH = route<P>("pieces.save", async ({ supabase, params, req }) => {
  const id = uuid.parse(params.id);
  const patch = await body(req, piecePatch);
  const row: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (patch.content) {
    const doc = sanitizeDoc(patch.content);
    row.content = doc;
    row.word_count = docWordCount(doc);
  }
  const { data, error } = await supabase.from("pieces").update(row).eq("id", id).select("id,title,updated_at,word_count").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "That piece couldn’t be found.");
  return json({ piece: data });
}, { perMinute: 240 });

export const DELETE = route<P>("pieces.delete", async ({ supabase, params }) => {
  const id = uuid.parse(params.id);
  const { error } = await supabase.from("pieces").delete().eq("id", id);
  if (error) throw error;
  return json({ ok: true });
}, { perMinute: 20 });
