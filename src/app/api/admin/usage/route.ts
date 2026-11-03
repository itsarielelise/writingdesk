import { json, route } from "@/lib/server/access";
import { supabaseAdmin } from "@/lib/supabase/server";

/** Usage per user per day per feature for the last N days. Token counts and feature names only. */
export const GET = route("admin.usage", async ({ req }) => {
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 14));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = supabaseAdmin();
  const rows: { user_id: string; provider: string; feature: string; input_tokens: number | null; output_tokens: number | null; created_at: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("ai_usage").select("user_id,provider,feature,input_tokens,output_tokens,created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000 || rows.length >= 50_000) break;
  }
  const emails = new Map<string, string>();
  for (let page = 1; page < 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) emails.set(u.id, u.email || u.id);
    if (data.users.length < 1000) break;
  }
  const agg = new Map<string, { email: string; day: string; feature: string; provider: string; calls: number; input_tokens: number; output_tokens: number }>();
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    const key = `${r.user_id}|${day}|${r.feature}|${r.provider}`;
    const a = agg.get(key) || { email: emails.get(r.user_id) || r.user_id, day, feature: r.feature, provider: r.provider, calls: 0, input_tokens: 0, output_tokens: 0 };
    a.calls++; a.input_tokens += r.input_tokens || 0; a.output_tokens += r.output_tokens || 0;
    agg.set(key, a);
  }
  const usage = [...agg.values()].sort((a, b) => b.day.localeCompare(a.day) || a.email.localeCompare(b.email) || a.feature.localeCompare(b.feature));
  return json({ days, usage });
}, { admin: true });
