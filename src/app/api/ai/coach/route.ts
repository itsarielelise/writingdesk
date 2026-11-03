import { z } from "zod";
import { body, json, route, uuid } from "@/lib/server/access";
import { anchorSchema, draftBlocks } from "@/lib/server/schemas";
import { aiErrorMessage } from "@/lib/ai/anthropic";
import { runCoach } from "@/lib/coach/providers";
import { COACH_CONFIG } from "@/lib/coach/types";
import { enforceDailyCap, logUsage } from "@/lib/server/usage";

export const maxDuration = 120;

export const POST = route("ai.coach", async ({ supabase, user, req }) => {
  const input = await body(req, z.object({
    pieceId: uuid,
    anchor: anchorSchema,
    blocks: draftBlocks,
    targets: z.array(z.string()).min(1).max(60),
    full: z.boolean().optional(),
  }));
  const known = new Set(input.blocks.map((b) => b.pid));
  const targets = [...new Set(input.targets)].filter((t) => known.has(t)).slice(0, input.full ? 60 : COACH_CONFIG.maxTargets);
  if (!targets.length) return json({ flags: [], checked: [] });
  // Make sure the piece is the caller's before spending anything.
  const { data: piece } = await supabase.from("pieces").select("id").eq("id", input.pieceId).maybeSingle();
  if (!piece) return json({ error: "That piece couldn’t be found." }, 404);
  await enforceDailyCap(user.id, "coach", targets.length);

  let result;
  try {
    result = await runCoach({ anchor: input.anchor, blocks: input.blocks, targets }, { signal: req.signal });
  } catch (e) {
    return json({ error: aiErrorMessage(e) }, 502);
  }
  await logUsage(user.id, "coach", result.usage);

  // Replace open flags on the checked paragraphs with the new ones.
  const { error: delErr } = await supabase.from("flags").delete().eq("piece_id", input.pieceId).eq("status", "open").in("pid", result.checked);
  if (delErr) throw delErr;
  let flags: unknown[] = [];
  if (result.flags.length) {
    const { data, error } = await supabase.from("flags").insert(result.flags.map((f) => ({
      piece_id: input.pieceId, user_id: user.id, pid: f.pid, type: f.type, other_pid: f.otherPid,
      target_section: f.targetSection, confidence: f.confidence, note: f.note,
    }))).select("*");
    if (error) throw error;
    flags = data || [];
  }
  return json({ flags, checked: result.checked, provider: result.provider });
}, { perMinute: 6 });
