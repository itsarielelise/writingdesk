import { describe, expect, it } from "vitest";
import { computeMode, FlowDetector, FLOW_CONFIG, isTail, type EditEvent } from "@/lib/flow/detector";

const T0 = 1_000_000;
const ev = (t: number, ins: number, del = 0, atTail = true): EditEvent => ({ time: T0 + t, charsInserted: ins, charsDeleted: del, atTail });

describe("computeMode", () => {
  it("is paused with no events", () => {
    expect(computeMode({ events: [], reopens: [], now: T0 }).mode).toBe("paused");
  });

  it("is paused after 20 s without input", () => {
    const events = [ev(0, 10), ev(1000, 10)];
    expect(computeMode({ events, reopens: [], now: T0 + 1000 + 20_001 }).mode).toBe("paused");
    expect(computeMode({ events, reopens: [], now: T0 + 1000 + 19_000 }).mode).not.toBe("paused");
  });

  it("is in flow after steady forward writing at the tail", () => {
    const events = Array.from({ length: 30 }, (_, i) => ev(i * 1000, 3, i % 10 === 0 ? 1 : 0));
    expect(computeMode({ events, reopens: [], now: T0 + 30_000 }).mode).toBe("flow");
  });

  it("needs at least 50 characters for flow; below that it's writing", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i * 1000, 4));
    expect(computeMode({ events, reopens: [], now: T0 + 10_000 }).mode).toBe("writing");
  });

  it("drops out of flow when deletions exceed 40% of insertions", () => {
    const events = Array.from({ length: 20 }, (_, i) => ev(i * 1000, 5, i % 2 ? 5 : 0)); // 100 in, 50 del
    expect(computeMode({ events, reopens: [], now: T0 + 20_000 }).mode).toBe("writing");
  });

  it("requires 70% of edits at the tail for flow", () => {
    const events = Array.from({ length: 20 }, (_, i) => ev(i * 1000, 5, 0, i % 2 === 0)); // 50% tail
    expect(computeMode({ events, reopens: [], now: T0 + 20_000 }).mode).toBe("revising");
  });

  it("only looks at the last 90 s for flow", () => {
    const old = Array.from({ length: 30 }, (_, i) => ev(i * 1000, 5, 0, false)); // 0–29 s, not at tail
    const recent = Array.from({ length: 30 }, (_, i) => ev(100_000 + i * 1000, 5)); // 100–129 s
    expect(computeMode({ events: [...old, ...recent], reopens: [], now: T0 + 130_000 }).mode).toBe("flow");
  });

  it("is revising when editing earlier paragraphs", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i * 1000, 4, 2, false));
    expect(computeMode({ events, reopens: [], now: T0 + 10_000 }).mode).toBe("revising");
  });

  it("is looping when the same finished paragraph is reopened 4 times in 4 minutes", () => {
    const events = [ev(200_000, 3, 0, false)];
    const reopens = [0, 60_000, 120_000, 180_000].map((t) => ({ pid: "abcd1234", time: T0 + t }));
    const r = computeMode({ events, reopens, now: T0 + 201_000 });
    expect(r).toEqual({ mode: "looping", loopPid: "abcd1234" });
  });

  it("is not looping on 3 reopens, or on 4 spread over more than 4 minutes", () => {
    const events = [ev(300_000, 3, 0, false)];
    const three = [0, 60_000, 120_000].map((t) => ({ pid: "abcd1234", time: T0 + 200_000 + t }));
    expect(computeMode({ events, reopens: three, now: T0 + 300_500 }).mode).toBe("revising");
    const spread = [0, 70_000, 140_000, 250_000].map((t) => ({ pid: "abcd1234", time: T0 + t }));
    expect(computeMode({ events, reopens: spread, now: T0 + 300_500 }).mode).toBe("revising");
  });

  it("ignores reopen loops on paragraphs that no longer exist", () => {
    const events = [ev(200_000, 3, 0, false)];
    const reopens = [0, 60_000, 120_000, 180_000].map((t) => ({ pid: "gone0000", time: T0 + t }));
    expect(computeMode({ events, reopens, now: T0 + 201_000, pidExists: () => false }).mode).toBe("revising");
  });

  it("is looping on churn: >150 chars deleted with net growth ≤ 40 over 4 minutes", () => {
    // 40 edits over 200 s, alternating type/delete at the tail: 200 in, 180 out.
    const events = Array.from({ length: 40 }, (_, i) => ev(i * 5000, i % 2 ? 0 : 10, i % 2 ? 9 : 0));
    const r = computeMode({ events, reopens: [], now: T0 + 196_000, curPid: "para0001" });
    expect(r).toEqual({ mode: "looping", loopPid: "para0001" });
  });

  it("is not churn-looping when the draft is growing", () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(i * 5000, i % 2 ? 0 : 20, i % 2 ? 9 : 0)); // 400 in, 180 out
    expect(computeMode({ events, reopens: [], now: T0 + 196_000 }).mode).not.toBe("looping");
  });
});

describe("isTail", () => {
  it("counts the last and second-to-last non-empty blocks (and anything after)", () => {
    expect(isTail(5, 5)).toBe(true);
    expect(isTail(4, 5)).toBe(true);
    expect(isTail(6, 5)).toBe(true);
    expect(isTail(3, 5)).toBe(false);
    expect(isTail(0, 0)).toBe(true);
  });
});

describe("FlowDetector sessions and revisions", () => {
  const base = { charsInserted: 1, charsDeleted: 0, lastFilledIndex: 10, blockHasText: true };

  it("counts a revision when a finished, older paragraph is reopened", () => {
    const d = new FlowDetector();
    const r = d.recordEdit({ ...base, now: T0, pid: "old00001", blockIndex: 2 });
    expect(r.revisedPid).toBe("old00001");
    expect(r.atTail).toBe(false);
  });

  it("doesn't count typing at the tail", () => {
    const d = new FlowDetector();
    expect(d.recordEdit({ ...base, now: T0, pid: "tail0001", blockIndex: 10 }).revisedPid).toBeNull();
  });

  it("doesn't count paragraphs created in the last 3 minutes", () => {
    const d = new FlowDetector();
    d.markBorn("new00001", T0);
    expect(d.recordEdit({ ...base, now: T0 + 60_000, pid: "new00001", blockIndex: 2 }).revisedPid).toBeNull();
    expect(d.recordEdit({ ...base, now: T0 + 200_000, pid: "new00001", blockIndex: 2 }).revisedPid).toBe("new00001");
  });

  it("starts a new session on moving paragraphs or after 8 s idle, not on continuous typing", () => {
    const d = new FlowDetector();
    expect(d.recordEdit({ ...base, now: T0, pid: "aaaa0001", blockIndex: 1 }).revisedPid).toBe("aaaa0001");
    expect(d.recordEdit({ ...base, now: T0 + 2000, pid: "aaaa0001", blockIndex: 1 }).revisedPid).toBeNull();
    expect(d.recordEdit({ ...base, now: T0 + 2000 + FLOW_CONFIG.sessionGapMs + 1, pid: "aaaa0001", blockIndex: 1 }).revisedPid).toBe("aaaa0001");
    expect(d.recordEdit({ ...base, now: T0 + 11_000, pid: "bbbb0001", blockIndex: 2 }).revisedPid).toBe("bbbb0001");
    expect(d.recordEdit({ ...base, now: T0 + 12_000, pid: "aaaa0001", blockIndex: 1 }).revisedPid).toBe("aaaa0001");
  });

  it("detects looping end to end from reopens", () => {
    const d = new FlowDetector();
    let t = T0;
    for (let i = 0; i < 4; i++) {
      d.recordEdit({ ...base, now: (t += 30_000), pid: "loop0001", blockIndex: 1 });
      d.recordEdit({ ...base, now: (t += 1000), pid: "else0001", blockIndex: 3 });
    }
    expect(d.compute(t + 1000)).toBe("looping");
    expect(d.loopPid).toBe("loop0001");
  });

  it("detects flow end to end", () => {
    const d = new FlowDetector();
    d.markBorn("tail0001", T0);
    for (let i = 0; i < 40; i++) d.recordEdit({ ...base, charsInserted: 2, now: T0 + i * 500, pid: "tail0001", blockIndex: 10 });
    expect(d.compute(T0 + 20_000)).toBe("flow");
    expect(d.compute(T0 + 20_000 + 25_000)).toBe("paused");
  });
});
