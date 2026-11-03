import { json, route, uuid } from "@/lib/server/access";

export const DELETE = route<{ id: string; vid: string }>("versions.delete", async ({ supabase, params }) => {
  const { error } = await supabase.from("versions").delete().eq("id", uuid.parse(params.vid)).eq("piece_id", uuid.parse(params.id));
  if (error) throw error;
  return json({ ok: true });
});
