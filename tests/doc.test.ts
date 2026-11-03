import { describe, expect, it } from "vitest";
import { blocksOf, emptyDoc, plainText, sanitizeDoc, wordCount, type DocJSON } from "@/lib/doc/model";
import { docToMarkdown, markdownToDoc, plainPasteToDoc } from "@/lib/doc/markdown";
import { bringBackIndex, diffDocs, takesOf } from "@/lib/doc/compare";

const p = (pid: string, text: string) => ({ type: "paragraph" as const, attrs: { pid }, content: [{ type: "text" as const, text }] });
const doc = (...content: any[]): DocJSON => ({ type: "doc", content });

describe("sanitizeDoc", () => {
  it("keeps supported nodes, marks and pids", () => {
    const d = sanitizeDoc(doc(
      { type: "heading", attrs: { pid: "head0001", level: 2 }, content: [{ type: "text", text: "Title" }] },
      { type: "paragraph", attrs: { pid: "para0001" }, content: [{ type: "text", text: "Hi ", marks: [{ type: "bold" }] }, { type: "hardBreak" }, { type: "text", text: "there" }] },
      { type: "blockquote", attrs: { pid: "quot0001" }, content: [{ type: "text", text: "Q" }] },
    ));
    expect(d.content.map((b) => b.attrs.pid)).toEqual(["head0001", "para0001", "quot0001"]);
    expect(d.content[0].attrs.level).toBe(2);
    expect(d.content[1].content).toEqual([{ type: "text", text: "Hi ", marks: [{ type: "bold" }] }, { type: "hardBreak" }, { type: "text", text: "there" }]);
  });

  it("drops unsupported marks and attributes, flattens unsupported nodes", () => {
    const d = sanitizeDoc({ type: "doc", content: [
      { type: "paragraph", attrs: { pid: "para0001", onclick: "x" }, content: [{ type: "text", text: "a", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }, { type: "italic" }] }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
      { type: "image", attrs: { src: "x" } },
      { type: "codeBlock", content: [{ type: "text", text: "code" }] },
    ] });
    expect(d.content[0]).toEqual({ type: "paragraph", attrs: { pid: "para0001" }, content: [{ type: "text", text: "a", marks: [{ type: "italic" }] }] });
    expect(plainText(d)).toBe("a\n\nitem\n\ncode");
    expect(JSON.stringify(d)).not.toMatch(/javascript|onclick|image|link/);
  });

  it("replaces invalid and duplicate pids", () => {
    const d = sanitizeDoc(doc(p("BAD PID", "a"), p("same0001", "b"), p("same0001", "c")));
    const pids = d.content.map((b) => b.attrs.pid);
    expect(pids[0]).toMatch(/^[a-z0-9]{8}$/);
    expect(pids[1]).toBe("same0001");
    expect(pids[2]).not.toBe("same0001");
    expect(new Set(pids).size).toBe(3);
  });

  it("flattens TipTap's wrapped-paragraph blockquote into one quote block", () => {
    const d = sanitizeDoc(doc({ type: "blockquote", content: [p("inner001", "one"), p("inner002", "two")] }));
    expect(d.content).toHaveLength(1);
    expect(d.content[0].type).toBe("blockquote");
    expect(plainText(d)).toBe("one\ntwo");
  });

  it("never returns an empty doc and survives garbage", () => {
    for (const bad of [null, 1, "x", {}, { content: "nope" }, { content: [null, 3] }]) {
      const d = sanitizeDoc(bad);
      expect(d.content.length).toBe(1);
      expect(d.content[0].type).toBe("paragraph");
    }
    expect(emptyDoc().content).toHaveLength(1);
  });
});

describe("markdown", () => {
  it("exports headings, quotes, bold and italic", () => {
    const d = doc(
      { type: "heading", attrs: { pid: "h0000001", level: 2 }, content: [{ type: "text", text: "Start" }] },
      { type: "paragraph", attrs: { pid: "p0000001" }, content: [{ type: "text", text: "A " }, { type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "text", text: " and " }, { type: "text", text: "slanted", marks: [{ type: "italic" }] }, { type: "text", text: " word." }] },
      { type: "blockquote", attrs: { pid: "q0000001" }, content: [{ type: "text", text: "line one" }, { type: "hardBreak" }, { type: "text", text: "line two" }] },
      { type: "paragraph", attrs: { pid: "e0000001" } },
    );
    expect(docToMarkdown(d, "My piece")).toBe("# My piece\n\n## Start\n\nA **bold** and *slanted* word.\n\n> line one\n> line two");
  });

  it("round-trips the subset Claude writes", () => {
    const md = "## Section\n\nFirst **strong** and *soft*.\n\n> quoted\n> lines\n\n### Sub\n\nPoem line\nnext line";
    const d = markdownToDoc(md);
    expect(d.content.map((b) => b.type)).toEqual(["heading", "paragraph", "blockquote", "heading", "paragraph"]);
    expect(d.content[3].attrs.level).toBe(3);
    expect(docToMarkdown(d)).toBe(md);
    expect(new Set(d.content.map((b) => b.attrs.pid)).size).toBe(5);
  });

  it("splits multi-paragraph plain-text pastes and leaves single lines alone", () => {
    expect(plainPasteToDoc("just one line")).toBeNull();
    expect(plainPasteToDoc("one\n\ntwo\n\nthree")!.content).toHaveLength(3);
    expect(plainPasteToDoc("a\r\nb")!.content).toHaveLength(2);
  });

  it("counts words", () => {
    expect(wordCount("  one two\nthree ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("compare", () => {
  const then = doc(p("aaaa0001", "Alpha."), p("bbbb0001", "Bravo."), p("cccc0001", "Charlie."), p("dddd0001", "Delta."));
  const now = doc(p("aaaa0001", "Alpha."), p("cccc0001", "Charlie, changed."), p("eeee0001", "Echo."));

  it("diffs by pid", () => {
    const d = diffDocs(then, now);
    expect(d.removed.map((b) => b.pid)).toEqual(["bbbb0001", "dddd0001"]);
    expect(d.changed.map((c) => c.then.pid)).toEqual(["cccc0001"]);
    expect(d.added.map((b) => b.pid)).toEqual(["eeee0001"]);
  });

  it("brings a paragraph back after the nearest surviving earlier one", () => {
    expect(bringBackIndex(then, now, "bbbb0001")).toBe(1); // after Alpha
    expect(bringBackIndex(then, now, "dddd0001")).toBe(2); // after Charlie
    expect(bringBackIndex(then, doc(p("zzzz0001", "Z")), "bbbb0001")).toBe(0);
  });

  it("lists distinct earlier takes of a paragraph, newest first", () => {
    const versions = [
      { id: "v1", kind: "flow", created_at: "2026-01-01T10:00:00Z", content: doc(p("cccc0001", "Charlie one.")) },
      { id: "v2", kind: "auto", created_at: "2026-01-01T11:00:00Z", content: doc(p("cccc0001", "Charlie two.")) },
      { id: "v3", kind: "manual", created_at: "2026-01-01T12:00:00Z", content: doc(p("cccc0001", "Charlie   one.")) },
      { id: "v4", kind: "auto", created_at: "2026-01-01T13:00:00Z", content: doc(p("cccc0001", "Charlie, changed.")) },
      { id: "v5", kind: "auto", created_at: "2026-01-01T14:00:00Z", content: doc(p("xxxx0001", "Other.")) },
    ];
    const cur = blocksOf(now).get("cccc0001");
    expect(takesOf("cccc0001", cur, versions).map((t) => t.versionId)).toEqual(["v3", "v2"]);
  });
});
