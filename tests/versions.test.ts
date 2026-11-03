import { describe, expect, it } from "vitest";
import { autosaveDue, autosavesToPrune, flowVersionLabel, isDuplicate } from "@/lib/versions/policy";

describe("version policy", () => {
  it("saves a flow version when leaving writing/flow with 15+ new words", () => {
    expect(flowVersionLabel("flow", "paused", 120, 100)).toBe("In flow · +20 words");
    expect(flowVersionLabel("writing", "revising", 115, 100)).toBe("Writing · +15 words");
    expect(flowVersionLabel("flow", "paused", 110, 100)).toBeNull();
    expect(flowVersionLabel("flow", "writing", 200, 100)).toBeNull();
    expect(flowVersionLabel("revising", "paused", 200, 100)).toBeNull();
  });

  it("autosaves every 5 minutes of changes, not in flow", () => {
    const at = 1_000_000;
    expect(autosaveDue(at + 300_001, at + 10, at, "revising")).toBe(true);
    expect(autosaveDue(at + 300_001, at + 10, at, "flow")).toBe(false);
    expect(autosaveDue(at + 200_000, at + 10, at, "revising")).toBe(false);
    expect(autosaveDue(at + 300_001, at - 1, at, "paused")).toBe(false); // no changes since
  });

  it("skips identical text", () => {
    expect(isDuplicate("a", "a")).toBe(true);
    expect(isDuplicate("a", "b")).toBe(false);
    expect(isDuplicate("a", undefined)).toBe(false);
  });

  it("keeps only the newest 15 autosaves", () => {
    const vs = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, kind: "auto", created_at: new Date(2026, 0, 1, 0, i).toISOString() }));
    vs.push({ id: "f1", kind: "flow", created_at: new Date(2025, 0, 1).toISOString() });
    expect(autosavesToPrune(vs).sort()).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });
});
