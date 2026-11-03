import { z } from "zod";
import { body, json, route } from "@/lib/server/access";
import { supabaseAdmin } from "@/lib/supabase/server";

export const GET = route("admin.emails.list", async () => {
  const { data, error } = await supabaseAdmin().from("allowed_emails").select("*").order("added_at", { ascending: true });
  if (error) throw error;
  return json({ emails: data });
}, { admin: true });

export const POST = route("admin.emails.add", async ({ req }) => {
  const { email, isAdmin } = await body(req, z.object({ email: z.string().trim().toLowerCase().email(), isAdmin: z.boolean().default(false) }));
  const { error } = await supabaseAdmin().from("allowed_emails").upsert({ email, is_admin: isAdmin }, { onConflict: "email" });
  if (error) throw error;
  return json({ ok: true }, 201);
}, { admin: true });

export const DELETE = route("admin.emails.remove", async ({ req, email: me }) => {
  const { email } = await body(req, z.object({ email: z.string().trim().toLowerCase() }));
  if (email === me || email === (process.env.ADMIN_EMAIL || "").toLowerCase()) return json({ error: "You can’t remove the owner." }, 400);
  const { error } = await supabaseAdmin().from("allowed_emails").delete().eq("email", email);
  if (error) throw error;
  return json({ ok: true });
}, { admin: true });
