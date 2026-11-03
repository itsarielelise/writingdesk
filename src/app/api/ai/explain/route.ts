import { z } from "zod";
import { body, json, route } from "@/lib/server/access";
import { anchorSchema } from "@/lib/server/schemas";
import { aiErrorMessage, anthropic, MODELS } from "@/lib/ai/anthropic";
import { explainPrompt } from "@/lib/ai/prompts";
import { enforceDailyCap, logUsage } from "@/lib/server/usage";

export const POST = route("ai.explain", async ({ user, req }) => {
  const args = await body(req, z.object({
    type: z.enum(["repeat", "drift", "order"]),
    note: z.string().max(500),
    paragraph: z.string().max(20_000),
    other: z.string().max(20_000).nullish(),
    anchor: anchorSchema,
  }));
  await enforceDailyCap(user.id, "explain");
  try {
    const msg = await anthropic().messages.create({
      model: MODELS.explain,
      max_tokens: 1000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: explainPrompt(args) }],
    });
    await logUsage(user.id, "explain", [{ provider: "anthropic", inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }]);
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return json({ text: msg.stop_reason === "refusal" ? "Claude declined that request." : text });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 502);
  }
}, { perMinute: 20 });
