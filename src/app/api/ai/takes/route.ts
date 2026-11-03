import { z } from "zod";
import { body, route } from "@/lib/server/access";
import { aiErrorMessage, anthropic, FALLBACK_BETA, MODELS } from "@/lib/ai/anthropic";
import { takesPrompt } from "@/lib/ai/prompts";
import { enforceDailyCap, logUsage } from "@/lib/server/usage";
import { ndjson } from "@/lib/server/stream";

export const maxDuration = 120;

export const POST = route("ai.takes", async ({ user, req }) => {
  const { point, takes } = await body(req, z.object({
    point: z.string().max(5000).default(""),
    takes: z.array(z.object({ label: z.string().max(200), text: z.string().max(20_000) })).min(2).max(30),
  }));
  await enforceDailyCap(user.id, "takes");
  return ndjson(async (send, signal) => {
    try {
      const stream = anthropic().beta.messages.stream({
        model: MODELS.takes,
        max_tokens: 2000,
        output_config: { effort: "low" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        messages: [{ role: "user", content: takesPrompt(point, takes) }],
      }, { signal });
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") send({ type: "text", text: ev.delta.text });
      }
      const final = await stream.finalMessage();
      await logUsage(user.id, "takes", [{ provider: "anthropic", inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }]);
      send(final.stop_reason === "refusal" ? { type: "error", message: "Claude declined that request." } : { type: "done" });
    } catch (e) {
      send({ type: "error", message: aiErrorMessage(e) });
    }
  }, req.signal);
}, { perMinute: 6 });
