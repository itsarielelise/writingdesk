import { z } from "zod";
import { body, HttpError, json, route, uuid } from "@/lib/server/access";

type P = { id: string; noteId: string };

export const PATCH = route<P>("notes.update", async ({ supabase, params, req }) => {
  const { text } = await body(req, z.object({ text: z.string().max(20_000) }));
  const { data, error } = await supabase.from("notes")
    .update({ text: text.trim(), updated_at: new Date().toISOString() })
    .eq("id", uuid.parse(params.noteId)).eq("piece_id", uuid.parse(params.id))
    .select("id,text,image_src,created_at,updated_at").maybeSingle();
  if (error) { if (error.code === "23514") throw new HttpError(400, "A note needs some text or an image."); throw error; }
  if (!data) throw new HttpError(404, "That note couldn’t be found.");
  return json({ note: data });
});

export const DELETE = route<P>("notes.delete", async ({ supabase, params }) => {
  const { error } = await supabase.from("notes").delete().eq("id", uuid.parse(params.noteId)).eq("piece_id", uuid.parse(params.id));
  if (error) throw error;
  return json({ ok: true });
});
