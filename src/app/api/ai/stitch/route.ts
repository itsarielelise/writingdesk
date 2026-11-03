import { z } from "zod";
import { body, json, route, uuid } from "@/lib/server/access";
import { anchorSchema } from "@/lib/server/schemas";
import { aiErrorMessage, anthropic, FALLBACK_BETA, MODELS } from "@/lib/ai/anthropic";
import { stitchPrompt } from "@/lib/ai/prompts";
import { norm, wordCount } from "@/lib/doc/model";
import { KIND_LABEL, type VersionKind } from "@/lib/versions/policy";
import { enforceDailyCap, logUsage } from "@/lib/server/usage";
import { ndjson } from "@/lib/server/stream";

export const maxDuration = 300;

const BUDGET_CHARS = 160_000;
const MAX_EARLIER = 11;

export const POST = route("ai.stitch", async ({ supabase, user, req }) => {
  const { pieceId, draft, anchor } = await body(req, z.object({ pieceId: uuid, draft: z.string().max(BUDGET_CHARS), anchor: anchorSchema }));
  if (wordCount(draft) < 50) return json({ error: "Write a bit more before stitching." }, 400);
  await enforceDailyCap(user.id, "stitch");

  const { data: versions, error } = await supabase.from("versions").select("kind,plain_text,created_at")
    .eq("piece_id", pieceId).neq("kind", "stitch").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;

  // Flow and manual versions first, newest first; deduplicated; within budget.
  const rank = (k: string) => (k === "flow" ? 0 : k === "manual" ? 1 : 2);
  const pool = [...(versions || [])].sort((a, b) => rank(a.kind) - rank(b.kind) || b.created_at.localeCompare(a.created_at));
  const sources = [{ label: "CURRENT DRAFT", text: draft }];
  const seen = new Set([norm(draft)]);
  let budget = BUDGET_CHARS - draft.length;
  for (const v of pool) {
    if (sources.length > MAX_EARLIER) break;
    const k = norm(v.plain_text);
    if (seen.has(k) || v.plain_text.length > budget) continue;
    seen.add(k); budget -= v.plain_text.length;
    sources.push({ label: `EARLIER VERSION (${KIND_LABEL[v.kind as VersionKind]}, ${new Date(v.created_at).toUTCString()})`, text: v.plain_text });
  }

  return ndjson(async (send, signal) => {
    try {
      const stream = anthropic().beta.messages.stream({
        model: MODELS.stitch,
        max_tokens: 64000,
        output_config: { effort: "high" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        messages: [{ role: "user", content: stitchPrompt(anchor, sources) }],
      }, { signal });
      send({ type: "status", text: `Reading ${sources.length} versions…` });
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") send({ type: "text", text: ev.delta.text });
      }
      const final = await stream.finalMessage();
      await logUsage(user.id, "stitch", [{ provider: "anthropic", inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }]);
      if (final.stop_reason === "refusal") send({ type: "error", message: "Claude declined that request." });
      else send({ type: "done", truncated: final.stop_reason === "max_tokens" });
    } catch (e) {
      send({ type: "error", message: aiErrorMessage(e) });
    }
  }, req.signal);
}, { perMinute: 3 });
