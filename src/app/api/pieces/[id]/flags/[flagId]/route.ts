import { json, route, uuid } from "@/lib/server/access";

/** Dismiss a flag. */
export const PATCH = route<{ id: string; flagId: string }>("flags.dismiss", async ({ supabase, params }) => {
  const { error } = await supabase.from("flags").update({ status: "dismissed" }).eq("id", uuid.parse(params.flagId)).eq("piece_id", uuid.parse(params.id));
  if (error) throw error;
  return json({ ok: true });
});
