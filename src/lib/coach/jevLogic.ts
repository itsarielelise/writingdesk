// Pure logic for the Jev coach: building the request and turning answers into flags.
import { norm } from "../doc/model";
import { COACH_CONFIG, hasAnchor, sectionsOf, type Anchor, type CoachFlag, type DraftBlock } from "./types";

export const SERVES_POINT_LEVELS = [
  "Unrelated to the main point",
  "Loosely related; a tangent",
  "Supports the point indirectly (an analogy, example or aside that earns its place)",
  "Directly advances the main point",
] as const;

export const NONE_REPEAT = "The target makes a point not already made elsewhere.";
export const NONE_SECTION = "It doesn't fit any planned section.";

export function firstSentences(text: string, n: number): string {
  const t = norm(text);
  const parts = t.match(/[^.!?]+[.!?]+["”’)\]]*|[^.!?]+$/g) || [t];
  return parts.slice(0, n).map((s) => s.trim()).join(" ");
}

const sectionKey = (i: number) => `s${i + 1}`;

export interface JevQuestionsSpec {
  repeat?: { instructions: string; criteria: Record<string, string> };
  serves_point?: { instructions: string; criteria: string[] };
  section?: { instructions: string; criteria: Record<string, string> };
}

/** The questions to ask for one target paragraph (plain data, mapped to SDK helpers by the provider). */
export function jevQuestions(anchor: Anchor, blocks: DraftBlock[], target: string): JevQuestionsSpec {
  const q: JevQuestionsSpec = {};
  const others = blocks.filter((b) => b.pid !== target && !b.heading && norm(b.text));
  if (others.length) {
    const criteria: Record<string, string> = {};
    for (const b of others) criteria[b.pid] = firstSentences(b.text, 1).slice(0, 300);
    criteria.none = NONE_REPEAT;
    q.repeat = { instructions: "Does the target paragraph restate a point already made in another paragraph? If so, which?", criteria };
  }
  if (hasAnchor(anchor)) {
    q.serves_point = { instructions: "How well does the target paragraph serve the piece's main point?", criteria: [...SERVES_POINT_LEVELS] };
  }
  const secs = sectionsOf(anchor);
  if (secs.length) {
    const criteria: Record<string, string> = {};
    secs.forEach((s, i) => { criteria[sectionKey(i)] = s; });
    criteria.none = NONE_SECTION;
    q.section = { instructions: "Which planned section does this paragraph belong in?", criteria };
  }
  return q;
}

export interface JevState {
  anchor: { point: string; sections: string[]; not_in_this_piece: string };
  target_pid: string;
  draft: { pid: string; text: string; heading?: true; abridged?: true }[];
}

/** Build the state, abridging distant paragraphs if the draft exceeds the per-request budget. */
export function jevState(anchor: Anchor, blocks: DraftBlock[], target: string, maxChars = COACH_CONFIG.jevMaxStateChars): JevState {
  const base = {
    anchor: { point: anchor.point || "", sections: sectionsOf(anchor), not_in_this_piece: anchor.notThis || "" },
    target_pid: target,
  };
  const full: JevState = { ...base, draft: blocks.filter((b) => norm(b.text)).map((b) => ({ pid: b.pid, text: b.text, ...(b.heading ? { heading: true as const } : {}) })) };
  if (JSON.stringify(full).length <= maxChars) return full;
  const idx = full.draft.findIndex((b) => b.pid === target);
  const abridged: JevState = {
    ...base,
    draft: full.draft.map((b, i) => (Math.abs(i - idx) <= 1 || b.heading ? b : { ...b, text: firstSentences(b.text, 2), abridged: true as const })),
  };
  return abridged;
}

/** Which planned section a paragraph currently sits in: by nearest preceding heading, else by position. */
export function currentSection(anchor: Anchor, blocks: DraftBlock[], pid: string): number | null {
  const secs = sectionsOf(anchor);
  if (!secs.length) return null;
  const idx = blocks.findIndex((b) => b.pid === pid);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (!blocks[i].heading) continue;
    const h = norm(blocks[i].text).toLowerCase();
    const hit = secs.findIndex((s) => { const k = norm(s).toLowerCase(); return !!k && (h === k || h.includes(k) || k.includes(h)); });
    if (hit >= 0) return hit;
    break; // nearest heading didn't match a planned section → fall back to position
  }
  const body = blocks.filter((b) => !b.heading && norm(b.text));
  const pos = body.findIndex((b) => b.pid === pid);
  if (pos < 0) return null;
  return Math.min(secs.length - 1, Math.floor((pos / Math.max(1, body.length)) * secs.length));
}

export interface JevAnswers {
  repeat?: { choice: string; confidence: number };
  serves_point?: { score: number; confidence: number };
  section?: { choice: string; confidence: number };
}

export function answersToFlags(
  anchor: Anchor,
  blocks: DraftBlock[],
  target: string,
  a: JevAnswers,
  cfg = COACH_CONFIG,
): CoachFlag[] {
  const flags: CoachFlag[] = [];
  const byPid = new Map(blocks.map((b) => [b.pid, b]));
  if (a.repeat && a.repeat.choice !== "none" && byPid.has(a.repeat.choice) && a.repeat.choice !== target && a.repeat.confidence >= cfg.repeatMinConfidence) {
    const other = byPid.get(a.repeat.choice)!;
    const opening = firstSentences(other.text, 1).split(/\s+/).slice(0, 8).join(" ");
    flags.push({ pid: target, type: "repeat", otherPid: other.pid, targetSection: null, confidence: a.repeat.confidence, note: `This makes the same point as the paragraph beginning “${opening}…”.` });
  }
  if (a.serves_point && hasAnchor(anchor) && a.serves_point.score < cfg.driftBelowScore && a.serves_point.confidence >= cfg.driftMinConfidence) {
    flags.push({ pid: target, type: "drift", otherPid: null, targetSection: null, confidence: a.serves_point.confidence, note: "This may be a tangent from your main point. Park it for a later post?" });
  }
  if (a.section && a.section.choice !== "none" && a.section.confidence >= cfg.orderMinConfidence) {
    const secs = sectionsOf(anchor);
    const chosen = Number(a.section.choice.replace(/^s/, "")) - 1;
    const cur = currentSection(anchor, blocks, target);
    if (chosen >= 0 && chosen < secs.length && cur !== null && chosen !== cur) {
      flags.push({ pid: target, type: "order", otherPid: null, targetSection: secs[chosen], confidence: a.section.confidence, note: `This looks like it belongs in “${secs[chosen]}”.` });
    }
  }
  return flags;
}
