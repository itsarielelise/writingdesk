import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { body, route } from "@/lib/server/access";
import { anchorSchema } from "@/lib/server/schemas";
import { aiErrorMessage, anthropic, FALLBACK_BETA, MODELS } from "@/lib/ai/anthropic";
import { askSystemPrompt } from "@/lib/ai/prompts";
import { enforceDailyCap, logUsage } from "@/lib/server/usage";
import { ndjson } from "@/lib/server/stream";

export const maxDuration = 300;

const MAX_CONTINUES = 3;

export const POST = route("ai.ask", async ({ user, req }) => {
  const { anchor, draft, turns } = await body(req, z.object({
    anchor: anchorSchema,
    draft: z.string().max(120_000),
    turns: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20_000) })).min(1).max(24),
  }));
  if (turns[turns.length - 1].role !== "user") return Response.json({ error: "That request wasn’t valid." }, { status: 400 });
  await enforceDailyCap(user.id, "ask");

  return ndjson(async (send, signal) => {
    const messages: Anthropic.Beta.BetaMessageParam[] = turns.slice(-12).map((t) => ({ role: t.role, content: t.content }));
    // A history slice must start with a user turn.
    while (messages.length && messages[0].role !== "user") messages.shift();
    const seen = new Set<string>();
    const usage = { input: 0, output: 0 };
    try {
      for (let i = 0; i <= MAX_CONTINUES; i++) {
        const stream = anthropic().beta.messages.stream({
          model: MODELS.ask,
          max_tokens: 16000,
          output_config: { effort: "medium" },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: askSystemPrompt(anchor, draft),
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
          messages,
        }, { signal });
        for await (const ev of stream) {
          if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") send({ type: "text", text: ev.delta.text });
            else if (ev.delta.type === "citations_delta" && ev.delta.citation.type === "web_search_result_location") {
              const c = ev.delta.citation;
              if (!seen.has(c.url)) { seen.add(c.url); send({ type: "citation", url: c.url, title: c.title || c.url }); }
            }
          } else if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
            send({ type: "status", text: "Searching the web…" });
          }
        }
        const final = await stream.finalMessage();
        usage.input += final.usage.input_tokens; usage.output += final.usage.output_tokens;
        if (final.stop_reason === "pause_turn") {
          // A long server-tool turn paused; send it back so the server continues it.
          messages.push({ role: "assistant", content: final.content as Anthropic.Beta.BetaContentBlockParam[] });
          continue;
        }
        if (final.stop_reason === "refusal") send({ type: "error", message: "Claude declined that request." });
        else send({ type: "done", truncated: final.stop_reason === "max_tokens" });
        break;
      }
    } catch (e) {
      send({ type: "error", message: aiErrorMessage(e) });
    } finally {
      if (usage.input || usage.output) await logUsage(user.id, "ask", [{ provider: "anthropic", inputTokens: usage.input, outputTokens: usage.output }]);
    }
  }, req.signal);
}, { perMinute: 10 });
