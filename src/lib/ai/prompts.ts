// Prompts ported from the prototype. Pure string builders, shared by routes and the eval script.
import { hasAnchor, type Anchor, type DraftBlock } from "../coach/types";

export function anchorBlock(a: Anchor): string {
  const has = (a.point || a.sections || "").trim();
  return has
    ? `Main point: ${a.point || "(not given)"}\nPlanned sections, in order:\n${a.sections || "(not given)"}\nNot in this piece (saved for later posts): ${a.notThis || "(nothing listed)"}`
    : "(The writer hasn’t set an anchor. Do not flag drift or order; only flag repeats.)";
}

export function draftForPrompt(blocks: DraftBlock[], limit = 90_000): string {
  let out = "";
  for (const b of blocks) {
    const t = b.text.trim();
    if (!t) continue;
    const line = `[${b.pid}] ${b.heading ? "(heading) " : ""}${t}\n\n`;
    if (out.length + line.length > limit) break;
    out += line;
  }
  return out;
}

export function coachPrompt(anchor: Anchor, blocks: DraftBlock[], targets: string[]): string {
  return `You are a developmental editor watching a writer draft in real time. Flag only clear structural problems in the TARGET paragraphs. Never comment on style, grammar, tone or word choice.

Flag types:
- "repeat": the target paragraph restates a point already made in another paragraph. Give that other paragraph's id.
- "drift": the target paragraph doesn't serve the piece's main point or any planned section, or covers a topic the writer saved for later.
- "order": the target paragraph belongs in a different planned section than where it sits. Name that section in "section" and in the note.

Be conservative. A deliberate callback, a vivid analogy that supports the point, or a short transition is not a problem. Most paragraphs need no flag.

Reply with only a JSON array. Each item: {"pid": "<target id>", "type": "repeat" | "drift" | "order", "other_pid": "<id or null>", "section": "<planned section name or null>", "confidence": <0 to 1>, "note": "<one plain sentence under 25 words, addressed to the writer>"}. Reply [] if nothing clearly needs flagging.

PIECE ANCHOR
${anchorBlock(anchor)}

DRAFT (each paragraph starts with its id in brackets)
${draftForPrompt(blocks)}
TARGET paragraph ids: ${targets.join(", ")}`;
}

export function takesPrompt(point: string, takes: { label: string; text: string }[]): string {
  return `A writer has several takes of one paragraph. Pick the strongest one for the piece, in under 80 words. Name the take by number and say why. If another take has a sentence the winner lacks, quote that sentence exactly and say where it fits. Do not rewrite anything yourself.\n\nMain point of the piece: ${point || "(not given)"}\n\n`
    + takes.map((t, i) => `TAKE ${i + 1} (${t.label}):\n${t.text}`).join("\n\n");
}

export const STITCH_NOTES_MARK = "=====NOTES=====";

export function stitchPrompt(anchor: Anchor, sources: { label: string; text: string }[]): string {
  return `You are stitching the best version of an article from a writer's drafts. This writer drafts well in flow, then sometimes loses good material while revising, or loops on the same point.

Rules:
- Keep the writer's voice. Use their own sentences verbatim wherever you can. You may cut, reorder, and choose between versions of a passage.
- Only add new words as short connecting phrases, and put every added word in [square brackets] so the writer can see it.
- When a passage exists in several versions, pick the strongest. Prefer an earlier flow version when later edits lost content, energy or clarity.
- Remove repeated points: keep the best statement of each idea, once.
- Follow the planned section order when one is given. Put material that doesn't serve the main point in a final section headed "## Parked for later" instead of deleting it.
- Format in Markdown: ## for section headings, > for quotations, a blank line between paragraphs. Keep poem lines on separate lines.

Write the stitched article first. Then a line containing exactly ${STITCH_NOTES_MARK} and then 3 to 8 short bullet notes on your main choices: what you restored and from which version, what you cut as repeated, and what you moved.

PIECE ANCHOR
${anchorBlock(anchor)}

SOURCES (the current draft first, then earlier versions)
` + sources.map((s) => `===== ${s.label} =====\n${s.text}`).join("\n\n");
}

export function askSystemPrompt(anchor: Anchor, draft: string): string {
  return `You are the writer's research assistant and editor for the piece below. You can search the web: use it to check facts, find references and sources, and cite the pages you relied on. Say plainly when something is uncertain or you couldn't confirm it.

When you suggest edits, keep the writer's voice: quote the exact sentences you would change and keep changes small. Never rewrite whole paragraphs unless asked. Be concise.

PIECE ANCHOR
${anchorBlock(anchor)}

CURRENT DRAFT
${draft}`;
}

export function explainPrompt(args: { type: string; note: string; paragraph: string; other?: string | null; anchor: Anchor }): string {
  return `A writing coach flagged a paragraph. In one plain sentence addressed to the writer, explain why this note might apply. Don't rewrite anything, and don't hedge with "may" more than once.

Note type: ${args.type}
Note: ${args.note}
${hasAnchor(args.anchor) ? `Main point of the piece: ${args.anchor.point}\n` : ""}
Flagged paragraph:
${args.paragraph}
${args.other ? `\nThe other paragraph it was compared with:\n${args.other}\n` : ""}`;
}

/** Parse the stitch output into article and notes. */
export function splitStitch(t: string): [string, string] {
  const i = t.indexOf(STITCH_NOTES_MARK);
  return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i + STITCH_NOTES_MARK.length)];
}

/** Tolerant parse of a JSON array from a model reply. */
export function parseJsonArray(text: string): unknown[] {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s < 0 || e < s) return [];
  try { const v = JSON.parse(text.slice(s, e + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}
