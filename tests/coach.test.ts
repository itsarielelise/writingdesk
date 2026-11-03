import { describe, expect, it } from "vitest";
import { answersToFlags, currentSection, firstSentences, jevQuestions, jevState, SERVES_POINT_LEVELS } from "@/lib/coach/jevLogic";
import { coachPrompt, parseJsonArray, splitStitch } from "@/lib/ai/prompts";
import type { Anchor, DraftBlock } from "@/lib/coach/types";

const anchor: Anchor = { point: "Remote work needs written culture.", sections: "Why\nHow\nWhat next", notThis: "Office design" };
const blocks: DraftBlock[] = [
  { pid: "h0000001", text: "Why", heading: true },
  { pid: "p0000001", text: "Teams that write things down move faster. Everyone can catch up." },
  { pid: "h0000002", text: "How", heading: true },
  { pid: "p0000002", text: "Start every project with a one-page memo. Keep it short." },
  { pid: "p0000003", text: "Writing it down is what makes teams quick. It lets people catch up." },
];

describe("jev questions", () => {
  it("asks repeat, serves_point and section with the right criteria", () => {
    const q = jevQuestions(anchor, blocks, "p0000003");
    expect(Object.keys(q.repeat!.criteria)).toEqual(["p0000001", "p0000002", "none"]);
    expect(q.repeat!.criteria.p0000001).toBe("Teams that write things down move faster.");
    expect(q.serves_point!.criteria).toEqual([...SERVES_POINT_LEVELS]);
    expect(q.section!.criteria).toEqual({ s1: "Why", s2: "How", s3: "What next", none: expect.any(String) });
  });

  it("skips serves_point without an anchor and section without sections", () => {
    const q = jevQuestions({ point: "", sections: "", notThis: "" }, blocks, "p0000003");
    expect(q.repeat).toBeDefined();
    expect(q.serves_point).toBeUndefined();
    expect(q.section).toBeUndefined();
  });

  it("abridges distant paragraphs when the draft is over budget", () => {
    const long: DraftBlock[] = Array.from({ length: 50 }, (_, i) => ({ pid: `p${String(i).padStart(7, "0")}`, text: `Sentence one ${i}. Sentence two. Sentence three is long ${"x".repeat(200)}.` }));
    const full = jevState(anchor, long, "p0000025", 1_000_000);
    expect(full.draft.every((b) => !b.abridged)).toBe(true);
    const cut = jevState(anchor, long, "p0000025", 2000);
    expect(cut.draft.find((b) => b.pid === "p0000025")!.text).toBe(long[25].text);
    expect(cut.draft.find((b) => b.pid === "p0000024")!.abridged).toBeUndefined();
    expect(cut.draft.find((b) => b.pid === "p0000000")).toMatchObject({ abridged: true, text: "Sentence one 0. Sentence two." });
  });
});

describe("answers → flags", () => {
  it("flags a confident repeat", () => {
    const f = answersToFlags(anchor, blocks, "p0000003", { repeat: { choice: "p0000001", confidence: 0.9 } });
    expect(f).toEqual([expect.objectContaining({ type: "repeat", otherPid: "p0000001", confidence: 0.9 })]);
    expect(f[0].note).toMatch(/^This makes the same point as the paragraph beginning “Teams that write things down move faster\.…”\.$/);
  });

  it("ignores low-confidence or 'none' repeats", () => {
    expect(answersToFlags(anchor, blocks, "p0000003", { repeat: { choice: "p0000001", confidence: 0.79 } })).toEqual([]);
    expect(answersToFlags(anchor, blocks, "p0000003", { repeat: { choice: "none", confidence: 0.99 } })).toEqual([]);
  });

  it("flags drift below 'supports indirectly' with confidence ≥ 0.75", () => {
    expect(answersToFlags(anchor, blocks, "p0000002", { serves_point: { score: 1.4, confidence: 0.8 } })[0].type).toBe("drift");
    expect(answersToFlags(anchor, blocks, "p0000002", { serves_point: { score: 2.1, confidence: 0.9 } })).toEqual([]);
    expect(answersToFlags(anchor, blocks, "p0000002", { serves_point: { score: 0.5, confidence: 0.7 } })).toEqual([]);
    expect(answersToFlags({ point: "", sections: "", notThis: "" }, blocks, "p0000002", { serves_point: { score: 0, confidence: 1 } })).toEqual([]);
  });

  it("flags order when the chosen section differs from where it sits", () => {
    expect(currentSection(anchor, blocks, "p0000002")).toBe(1);
    const f = answersToFlags(anchor, blocks, "p0000002", { section: { choice: "s1", confidence: 0.85 } });
    expect(f).toEqual([expect.objectContaining({ type: "order", targetSection: "Why", note: "This looks like it belongs in “Why”." })]);
    expect(answersToFlags(anchor, blocks, "p0000002", { section: { choice: "s2", confidence: 0.95 } })).toEqual([]);
    expect(answersToFlags(anchor, blocks, "p0000002", { section: { choice: "s1", confidence: 0.7 } })).toEqual([]);
  });

  it("derives the current section by position when there are no matching headings", () => {
    const plain: DraftBlock[] = Array.from({ length: 6 }, (_, i) => ({ pid: `q000000${i}`, text: `Para ${i}.` }));
    expect([0, 1, 2, 3, 4, 5].map((i) => currentSection(anchor, plain, `q000000${i}`))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("prompt helpers", () => {
  it("splits sentences", () => {
    expect(firstSentences("One. Two! Three? Four.", 2)).toBe("One. Two!");
    expect(firstSentences("No terminator here", 1)).toBe("No terminator here");
  });
  it("builds the coaching prompt with ids and targets", () => {
    const s = coachPrompt(anchor, blocks, ["p0000003"]);
    expect(s).toContain("[p0000003] Writing it down");
    expect(s).toContain("[h0000001] (heading) Why");
    expect(s).toContain("TARGET paragraph ids: p0000003");
  });
  it("parses JSON arrays tolerantly", () => {
    expect(parseJsonArray('Here you go:\n[{"pid":"a"}]\nThanks')).toEqual([{ pid: "a" }]);
    expect(parseJsonArray("nothing")).toEqual([]);
    expect(parseJsonArray("[oops")).toEqual([]);
  });
  it("splits stitch output", () => {
    expect(splitStitch("Article\n=====NOTES=====\n- a")).toEqual(["Article\n", "\n- a"]);
    expect(splitStitch("Just article")).toEqual(["Just article", ""]);
  });
});
