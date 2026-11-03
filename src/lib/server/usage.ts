import { supabaseAdmin } from "../supabase/server";
import { HttpError } from "./access";

export type Feature = "coach" | "stitch" | "takes" | "ask" | "explain";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function dailyLimit(feature: Feature): number {
  switch (feature) {
    case "coach": return num(process.env.DAILY_LIMIT_JEV, 300);
    case "stitch": return num(process.env.DAILY_LIMIT_STITCH, 3);
    case "ask": return num(process.env.DAILY_LIMIT_ASK, 60);
    case "takes": return num(process.env.DAILY_LIMIT_TAKES, 40);
    case "explain": return num(process.env.DAILY_LIMIT_EXPLAIN, 100);
  }
}

const startOfDayUtc = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

/** Throws 429 if the user has used up today's allowance (`cost` = units this call will use). */
export async function enforceDailyCap(userId: string, feature: Feature, cost = 1): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from("ai_usage").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("feature", feature).gte("created_at", startOfDayUtc());
  if (error) throw error;
  const used = count || 0;
  const limit = dailyLimit(feature);
  if (used + cost > limit) throw new HttpError(429, `You’ve reached today’s limit for this (${limit}). It resets at midnight UTC.`);
  return limit - used;
}

/** Record usage. Only feature names and token counts, never text. */
export async function logUsage(userId: string, feature: Feature, rows: { provider: "anthropic" | "typesafe"; inputTokens: number | null; outputTokens: number | null }[]) {
  if (!rows.length) return;
  const { error } = await supabaseAdmin().from("ai_usage").insert(rows.map((r) => ({
    user_id: userId, provider: r.provider, feature, input_tokens: r.inputTokens, output_tokens: r.outputTokens,
  })));
  if (error) console.error("[usage] insert failed:", error.message);
}
