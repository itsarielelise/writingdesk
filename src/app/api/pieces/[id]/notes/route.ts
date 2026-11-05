import { z } from "zod";
import { body, HttpError, json, route, uuid } from "@/lib/server/access";
import { IMAGE_SRC_RE } from "@/lib/doc/model";

const noteBody = z.object({
  text: z.string().max(20_000).default(""),
  image_src: z.string().regex(IMAGE_SRC_RE).nullish(),
});

export const POST = route<{ id: string }>("notes.create", async ({ supabase, user, params, req }) => {
  const n = await body(req, noteBody);
  const text = n.text.trim();
  if (!text && !n.image_src) throw new HttpError(400, "Write something or add an image first.");
  if (n.image_src && !n.image_src.startsWith(`/api/images/${user.id}/`)) throw new HttpError(400, "That image isn’t yours.");
  const { data, error } = await supabase.from("notes")
    .insert({ piece_id: uuid.parse(params.id), user_id: user.id, text, image_src: n.image_src ?? null })
    .select("id,text,image_src,created_at,updated_at").single();
  if (error) throw error;
  return json({ note: data }, 201);
}, { perMinute: 120 });
