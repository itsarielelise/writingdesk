import { z } from "zod";
import { body, json, route, uuid } from "@/lib/server/access";

export const POST = route<{ id: string }>("parked.create", async ({ supabase, user, params, req }) => {
  const { text } = await body(req, z.object({ text: z.string().trim().min(1).max(100_000) }));
  const { data, error } = await supabase.from("parked_items")
    .insert({ piece_id: uuid.parse(params.id), user_id: user.id, text }).select("id,text,created_at").single();
  if (error) throw error;
  return json({ item: data }, 201);
});
