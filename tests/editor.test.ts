// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { editorExtensions, findBlock, toggleBlock, topBlocks } from "@/components/editor/extensions";
import { sanitizeDoc } from "@/lib/doc/model";

// jsdom lacks a few layout APIs ProseMirror touches.
(globalThis as any).document.elementFromPoint = () => null;
if (!(globalThis as any).ClipboardEvent) (globalThis as any).ClipboardEvent = class extends Event { clipboardData = null; };
(Range.prototype as any).getClientRects = () => [];
(Range.prototype as any).getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });

const start = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { pid: "aaaa0001" }, content: [{ type: "text", text: "First paragraph here." }] },
    { type: "paragraph", attrs: { pid: "bbbb0001" }, content: [{ type: "text", text: "Second paragraph." }] },
  ],
};

let ed: Editor | null = null;
const make = () => (ed = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: start }));
const pids = (e: Editor) => topBlocks(e.state).map((b) => b.pid);
const caretIn = (e: Editor, pid: string, offset: number) => {
  const b = findBlock(e.state, pid)!;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, b.pos + 1 + offset)));
};
afterEach(() => { ed?.destroy(); ed = null; });

describe("paragraph ids in the editor", () => {
  it("keeps pids on load and through a save/load round trip", () => {
    const e = make();
    expect(pids(e)).toEqual(["aaaa0001", "bbbb0001"]);
    const reloaded = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: sanitizeDoc(e.getJSON()) });
    expect(pids(reloaded)).toEqual(["aaaa0001", "bbbb0001"]);
    reloaded.destroy();
  });

  it("assigns pids to blocks that lack them", () => {
    const e = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: { type: "doc", content: [{ type: "paragraph" }] } });
    ed = e;
    e.commands.insertContent("x");
    expect(pids(e)[0]).toMatch(/^[a-z0-9]{8}$/);
  });

  it("on Enter mid-paragraph, the original keeps its pid and the new block gets a new one", () => {
    const e = make();
    caretIn(e, "aaaa0001", 5);
    e.commands.splitBlock();
    const p = pids(e);
    expect(p).toHaveLength(3);
    expect(p[0]).toBe("aaaa0001");
    expect(p[1]).not.toBe("aaaa0001");
    expect(p[2]).toBe("bbbb0001");
    expect(new Set(p).size).toBe(3);
  });

  it("on Enter at the end, the new empty block gets a new pid", () => {
    const e = make();
    caretIn(e, "aaaa0001", "First paragraph here.".length);
    e.commands.splitBlock();
    expect(pids(e)[0]).toBe("aaaa0001");
    expect(pids(e)[1]).not.toBe("aaaa0001");
  });

  it("on Enter at the start, the text keeps its pid", () => {
    const e = make();
    caretIn(e, "bbbb0001", 0);
    e.commands.splitBlock();
    const blocks = topBlocks(e.state);
    const withText = blocks.find((b) => b.node.textContent === "Second paragraph.")!;
    expect(withText.pid).toBe("bbbb0001");
    expect(new Set(pids(e)).size).toBe(3);
  });

  it("restores pids on undo", () => {
    const e = make();
    caretIn(e, "aaaa0001", 5);
    e.commands.splitBlock();
    e.commands.insertContent("typed");
    e.commands.undo();
    e.commands.undo();
    expect(pids(e)).toEqual(["aaaa0001", "bbbb0001"]);
    expect(e.state.doc.textContent).toBe("First paragraph here.Second paragraph.");
  });

  it("gives pasted blocks fresh pids and leaves existing ones alone", () => {
    const e = make();
    caretIn(e, "bbbb0001", "Second paragraph.".length);
    // Paste HTML that carries pids copied from this same document.
    (e.view as any).pasteHTML('<p data-pid="aaaa0001">Copied one.</p><p data-pid="bbbb0001">Copied two.</p>');
    const p = pids(e);
    expect(p[0]).toBe("aaaa0001");
    expect(p[1]).toBe("bbbb0001");
    expect(new Set(p).size).toBe(p.length);
    expect(e.state.doc.textContent).toContain("Copied one.");
  });

  it("keeps the pid when a paragraph becomes a heading or quote and back", () => {
    const e = make();
    caretIn(e, "bbbb0001", 2);
    toggleBlock(e, "heading");
    expect(findBlock(e.state, "bbbb0001")!.node.type.name).toBe("heading");
    toggleBlock(e, "blockquote");
    expect(findBlock(e.state, "bbbb0001")!.node.type.name).toBe("blockquote");
    toggleBlock(e, "blockquote");
    expect(findBlock(e.state, "bbbb0001")!.node.type.name).toBe("paragraph");
    expect(pids(e)).toEqual(["aaaa0001", "bbbb0001"]);
  });

  it("only produces node and mark types the sanitizer accepts", () => {
    const e = make();
    e.commands.setContent('<h1>Big</h1><ul><li>item</li></ul><p><a href="x">link</a> <u>u</u> <b>b</b></p><blockquote><p>q</p></blockquote>');
    const json = e.getJSON();
    expect(sanitizeDoc(json).content.map((b) => b.type)).toEqual(sanitizeDoc(sanitizeDoc(json)).content.map((b) => b.type));
    const types = new Set<string>();
    const walk = (n: any) => { types.add(n.type); (n.marks || []).forEach((m: any) => types.add("mark:" + m.type)); (n.content || []).forEach(walk); };
    walk(json);
    expect([...types].every((t) => ["doc", "paragraph", "heading", "blockquote", "text", "hardBreak", "mark:bold", "mark:italic"].includes(t))).toBe(true);
  });
});

describe("undo boundaries", () => {
  it("an edit marked with closeHistory is its own undo step even right after typing", async () => {
    const { closeHistory } = await import("@tiptap/pm/history");
    const e = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: start });
    caretIn(e, "bbbb0001", "Second paragraph.".length);
    e.commands.insertContent(" more");
    const a = findBlock(e.state, "aaaa0001")!;
    e.chain().command(({ tr }) => { closeHistory(tr); tr.delete(a.pos, a.pos + a.node.nodeSize); return true; }).run();
    expect(pids(e)).toEqual(["bbbb0001"]);
    e.commands.undo();
    expect(pids(e)).toEqual(["aaaa0001", "bbbb0001"]);
    expect(e.state.doc.textContent).toContain("Second paragraph. more");
    e.destroy();
  });
});

describe("images in the editor", () => {
  it("turns pasted <img> tags into image blocks with fresh pids, queued for copying", () => {
    const e = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: start });
    caretIn(e, "bbbb0001", "Second paragraph.".length);
    (e.view as any).pasteHTML('<p>Intro</p><p><img src="https://example.com/cat.png" alt="A cat"></p><p>After</p>');
    const imgs = topBlocks(e.state).filter((b) => b.node.type.name === "image");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].node.attrs).toMatchObject({ origin: "https://example.com/cat.png", alt: "A cat", src: null });
    expect(imgs[0].pid).toMatch(/^[a-z0-9]{8}$/);
    expect(new Set(pids(e)).size).toBe(pids(e).length);
    expect(pids(e).slice(0, 2)).toEqual(["aaaa0001", "bbbb0001"]);
    e.destroy();
  });

  it("recognises images already stored by this app", () => {
    const e = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: start });
    const src = "/api/images/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.png";
    (e.view as any).pasteHTML(`<img src="${src}">`);
    const img = topBlocks(e.state).find((b) => b.node.type.name === "image")!;
    expect(img.node.attrs.src).toBe(src);
    expect(sanitizeDoc(e.getJSON()).content.find((b) => b.type === "image")!.attrs.src).toBe(src);
    e.destroy();
  });

  it("keeps an image's pid through undo", () => {
    const e = new Editor({ element: document.createElement("div"), extensions: editorExtensions, content: {
      type: "doc", content: [...start.content, { type: "image", attrs: { pid: "imgx0001", src: "/api/images/a" } }] } });
    const img = findBlock(e.state, "imgx0001")!;
    e.chain().command(({ tr }) => { tr.delete(img.pos, img.pos + img.node.nodeSize); return true; }).run();
    expect(findBlock(e.state, "imgx0001")).toBeNull();
    e.commands.undo();
    expect(findBlock(e.state, "imgx0001")).not.toBeNull();
    e.destroy();
  });
});
