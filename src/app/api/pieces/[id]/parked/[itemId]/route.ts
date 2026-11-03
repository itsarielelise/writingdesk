import { json, route, uuid } from "@/lib/server/access";

export const DELETE = route<{ id: string; itemId: string }>("parked.delete", async ({ supabase, params }) => {
  const { error } = await supabase.from("parked_items").delete().eq("id", uuid.parse(params.itemId)).eq("piece_id", uuid.parse(params.id));
  if (error) throw error;
  return json({ ok: true });
});
