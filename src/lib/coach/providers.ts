import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { anthropic, MODELS } from "../ai/anthropic";
import { coachPrompt, parseJsonArray } from "../ai/prompts";
import { answersToFlags, jevQuestions, jevState, type JevAnswers } from "./jevLogic";
import { COACH_CONFIG, sectionsOf, type CoachFlag, type CoachInput, type CoachProvider, type CoachResult, type CoachUsage } from "./types";

/* ---------- TypeSafe Jev ---------- */

export class JevCoach implements CoachProvider {
  readonly name = "jev" as const;
  private client: TypeSafeClient;
  constructor(apiKey = process.env.TYPESAFE_API_KEY) {
    this.client = new TypeSafeClient({ apiKey });
  }

  async checkOne(input: CoachInput, target: string, signal?: AbortSignal): Promise<{ flags: CoachFlag[]; usage: CoachUsage }> {
    const spec = jevQuestions(input.anchor, input.blocks, target);
    const questions: Record<string, any> = {};
    if (spec.repeat) questions.repeat = choice(spec.repeat.instructions, spec.repeat.criteria);
    if (spec.serves_point) questions.serves_point = score(spec.serves_point.instructions, spec.serves_point.criteria as [string, string, ...string[]]);
    if (spec.section) questions.section = choice(spec.section.instructions, spec.section.criteria);
    if (!Object.keys(questions).length) return { flags: [], usage: { provider: "typesafe", inputTokens: 0, outputTokens: 0 } };
    const state = jevState(input.anchor, input.blocks, target);
    const res = await this.client.systemOne({ state: state as any, questions }, { signal } as any);
    const ans = res.answers as Record<string, any>;
    const answers: JevAnswers = {
      repeat: ans.repeat ? { choice: ans.repeat.choice, confidence: ans.repeat.confidence } : undefined,
      serves_point: ans.serves_point ? { score: ans.serves_point.score, confidence: ans.serves_point.confidence } : undefined,
      section: ans.section ? { choice: ans.section.choice, confidence: ans.section.confidence } : undefined,
    };
    return {
      flags: answersToFlags(input.anchor, input.blocks, target, answers),
      usage: { provider: "typesafe", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }

  async check(input: CoachInput, opts?: { signal?: AbortSignal }): Promise<CoachResult> {
    const results = await Promise.all(input.targets.map((t) => this.checkOne(input, t, opts?.signal)));
    return { flags: results.flatMap((r) => r.flags), usage: results.map((r) => r.usage), checked: [...input.targets] };
  }
}

/* ---------- Claude Haiku fallback (the prototype's coaching prompt) ---------- */

export class ClaudeCoach implements CoachProvider {
  readonly name = "claude" as const;

  async check(input: CoachInput, opts?: { signal?: AbortSignal }): Promise<CoachResult> {
    const msg = await anthropic().messages.create({
      model: MODELS.coach,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: coachPrompt(input.anchor, input.blocks, input.targets) }],
    }, { signal: opts?.signal });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const known = new Set(input.blocks.map((b) => b.pid));
    const secs = sectionsOf(input.anchor);
    const flags: CoachFlag[] = [];
    for (const it of parseJsonArray(text) as any[]) {
      if (!it || !input.targets.includes(it.pid) || !["repeat", "drift", "order"].includes(it.type)) continue;
      const confidence = typeof it.confidence === "number" ? Math.max(0, Math.min(1, it.confidence)) : 0.8;
      const min = it.type === "drift" ? COACH_CONFIG.driftMinConfidence : it.type === "repeat" ? COACH_CONFIG.repeatMinConfidence : COACH_CONFIG.orderMinConfidence;
      if (confidence < min) continue;
      if (it.type === "drift" && !(input.anchor.point || "").trim()) continue;
      const otherPid = typeof it.other_pid === "string" && known.has(it.other_pid) ? it.other_pid : null;
      if (it.type === "repeat" && !otherPid) continue;
      const section = typeof it.section === "string" ? secs.find((s) => s.toLowerCase() === it.section.toLowerCase()) ?? it.section : null;
      flags.push({ pid: it.pid, type: it.type, otherPid, targetSection: it.type === "order" ? section : null, confidence, note: String(it.note || "").slice(0, 300) });
    }
    return {
      flags,
      usage: [{ provider: "anthropic", inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }],
      checked: [...input.targets],
    };
  }
}

/** Jev when TYPESAFE_API_KEY is set, Claude otherwise. */
export function primaryCoach(): CoachProvider {
  return process.env.TYPESAFE_API_KEY ? new JevCoach() : new ClaudeCoach();
}

/** Run the primary provider, falling back to Claude if Jev errors. */
export async function runCoach(input: CoachInput, opts?: { signal?: AbortSignal }): Promise<CoachResult & { provider: "jev" | "claude" }> {
  const p = primaryCoach();
  try {
    return { ...(await p.check(input, opts)), provider: p.name };
  } catch (e) {
    if (p.name !== "jev") throw e;
    console.warn("[coach] Jev failed, falling back to Claude:", (e as Error)?.name || "error");
    return { ...(await new ClaudeCoach().check(input, opts)), provider: "claude" };
  }
}
