import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseFrontMatter } from "../scripts/eval-coach";

describe("eval harness front matter", () => {
  it("parses point, list sections and not_this", () => {
    const { anchor, body } = parseFrontMatter(readFileSync(new URL("../samples/remote-writing.md", import.meta.url), "utf8"));
    expect(anchor.point).toMatch(/^Remote teams/);
    expect(anchor.sections.split("\n")).toEqual(["The meeting tax", "What writing changes", "How to start"]);
    expect(anchor.notThis).toBe("Office design, hiring remote, time zones");
    expect(body.startsWith("## The meeting tax")).toBe(true);
  });
  it("treats a file without front matter as body only", () => {
    expect(parseFrontMatter("Just text")).toEqual({ anchor: { point: "", sections: "", notThis: "" }, body: "Just text" });
  });
});
