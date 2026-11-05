import { body, HttpError, json, route, uuid } from "@/lib/server/access";
import { versionCreate } from "@/lib/server/schemas";
import { docWordCount, plainText, sanitizeDoc } from "@/lib/doc/model";
import { VERSION_CONFIG } from "@/lib/versions/policy";

type P = { id: string };

export const POST = route<P>("versions.create", async ({ supabase, user, params, req }) => {
  const pieceId = uuid.parse(params.id);
  const v = await body(req, versionCreate);
  const content = sanitizeDoc(v.content);
  const text = plainText(content);
  if (!text.trim()) return json({ version: null, skipped: "empty" });
  const { data: newest, error: e1 } = await supabase.from("versions").select("plain_text").eq("piece_id", pieceId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (e1) throw e1;
  if (newest && newest.plain_text === text) return json({ version: null, skipped: "identical" });
  const { data, error } = await supabase.from("versions").insert({
    piece_id: pieceId, user_id: user.id, kind: v.kind, label: v.label, content, plain_text: text, word_count: docWordCount(content),
  }).select("*").single();
  if (error) { if (error.code === "42501") throw new HttpError(404, "That piece couldn’t be found."); throw error; }
  let pruned: string[] = [];
  if (v.kind === "auto") {
    const { data: old } = await supabase.from("versions").select("id").eq("piece_id", pieceId).eq("kind", "auto")
      .order("created_at", { ascending: false }).range(VERSION_CONFIG.keepAutosaves, 1000);
    pruned = (old || []).map((o) => o.id);
    if (pruned.length) await supabase.from("versions").delete().in("id", pruned);
  }
  return json({ version: data, pruned }, 201);
}, { perMinute: 60 });
