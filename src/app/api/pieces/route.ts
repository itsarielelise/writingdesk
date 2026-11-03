import { route, json } from "@/lib/server/access";
import { emptyDoc } from "@/lib/doc/model";

export const GET = route("pieces.list", async ({ supabase }) => {
  const { data, error } = await supabase.from("pieces").select("id,title,updated_at,word_count").order("updated_at", { ascending: false });
  if (error) throw error;
  return json({ pieces: data });
});

export const POST = route("pieces.create", async ({ supabase, user }) => {
  const { data, error } = await supabase.from("pieces").insert({ user_id: user.id, content: emptyDoc() }).select("*").single();
  if (error) throw error;
  return json({ piece: data }, 201);
}, { perMinute: 20 });
