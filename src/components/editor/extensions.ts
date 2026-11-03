import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import Text from "@tiptap/extension-text";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import HardBreak from "@tiptap/extension-hard-break";
import { Dropcursor, Gapcursor, UndoRedo } from "@tiptap/extensions";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Mapping } from "@tiptap/pm/transform";
import { newPid, PID_RE } from "@/lib/doc/model";

const BLOCK_TYPES = ["paragraph", "heading", "blockquote"];

/** A quote is a single text block (like a paragraph), so it keeps one stable pid. */
export const Quote = Node.create({
  name: "blockquote",
  group: "block",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "blockquote" }],
  renderHTML: ({ HTMLAttributes }) => ["blockquote", mergeAttributes(HTMLAttributes), 0],
});

/* ---------- margin marks, current paragraph, flash ---------- */

export interface MarkState { revs: Record<string, number>; cur: string | null; flash: string | null; reworkedAt: number }
export const marksKey = new PluginKey<MarkState>("wdMarks");

export function setMarks(editor: Editor, patch: Partial<MarkState>) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(marksKey, patch).setMeta("addToHistory", false));
}

/* ---------- pids ---------- */

export const pidsKey = new PluginKey("wdPids");

/**
 * Every top-level block gets a pid. When a block is split, the original keeps its
 * pid (the part at the old block's mapped position, unless that part is empty and
 * the other isn't) and the new block gets a fresh one. Pasted blocks get fresh pids.
 */
function fixPids(trs: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  if (!trs.some((t) => t.docChanged)) return null;
  const mapping = new Mapping();
  for (const t of trs) mapping.appendMapping(t.mapping);
  const oldPos = new Map<string, number>();
  oldState.doc.forEach((n, off) => { if (n.attrs.pid) oldPos.set(n.attrs.pid, off); });

  const byPid = new Map<string, { pos: number; node: PMNode }[]>();
  const missing: { pos: number; node: PMNode }[] = [];
  newState.doc.forEach((node, pos) => {
    if (!BLOCK_TYPES.includes(node.type.name)) return;
    const pid = node.attrs.pid;
    if (!pid || !PID_RE.test(pid)) { missing.push({ pos, node }); return; }
    const arr = byPid.get(pid) || [];
    arr.push({ pos, node });
    byPid.set(pid, arr);
  });

  const reassign: { pos: number; node: PMNode }[] = [...missing];
  for (const [pid, arr] of byPid) {
    if (arr.length < 2) continue;
    let keep = 0;
    const op = oldPos.get(pid);
    if (op !== undefined) {
      const mapped = mapping.map(op, 1);
      const hit = arr.findIndex((x) => mapped >= x.pos && mapped < x.pos + x.node.nodeSize);
      if (hit >= 0) keep = hit;
    }
    if (!arr[keep].node.textContent.trim()) {
      const filled = arr.findIndex((x) => x.node.textContent.trim());
      if (filled >= 0) keep = filled;
    }
    arr.forEach((x, i) => { if (i !== keep) reassign.push(x); });
  }
  if (!reassign.length) return null;
  const tr = newState.tr;
  for (const { pos, node } of reassign) tr.setNodeMarkup(pos, undefined, { ...node.attrs, pid: newPid() });
  tr.setMeta("addToHistory", false);
  return tr;
}

function stripPids(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((n) => {
    if (n.isText) { out.push(n); return; }
    const attrs = "pid" in n.attrs ? { ...n.attrs, pid: null } : n.attrs;
    out.push(n.type.create(attrs, stripPids(n.content), n.marks));
  });
  return Fragment.from(out);
}

export const Pids = Extension.create({
  name: "pids",
  addGlobalAttributes() {
    return [{
      types: BLOCK_TYPES,
      attributes: {
        pid: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute("data-pid"),
          renderHTML: (attrs: Record<string, unknown>) => (attrs.pid ? { "data-pid": attrs.pid } : {}),
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pidsKey,
        appendTransaction: fixPids,
        props: {
          transformPasted: (slice: Slice) => new Slice(stripPids(slice.content), slice.openStart, slice.openEnd),
        },
      }),
      new Plugin<MarkState>({
        key: marksKey,
        state: {
          init: () => ({ revs: {}, cur: null, flash: null, reworkedAt: 3 }),
          apply: (tr, v) => { const m = tr.getMeta(marksKey); return m ? { ...v, ...m } : v; },
        },
        props: {
          decorations(state) {
            const s = marksKey.getState(state);
            if (!s) return null;
            const decos: Decoration[] = [];
            state.doc.forEach((node, pos) => {
              const pid = node.attrs.pid as string | null;
              if (!pid) return;
              const cls: string[] = [];
              const rev = s.revs[pid] || 0;
              if (rev >= s.reworkedAt) cls.push("rev-reworked");
              else if (rev > 0) cls.push("rev-revised");
              if (pid === s.cur) cls.push("cur");
              if (pid === s.flash) cls.push("flash");
              if (cls.length) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls.join(" ") }));
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export const editorExtensions = [
  Document,
  Paragraph,
  Heading.configure({ levels: [2, 3] }),
  Quote,
  Text,
  Bold,
  Italic,
  HardBreak,
  UndoRedo,
  Dropcursor,
  Gapcursor,
  Pids,
];

/* ---------- helpers over editor state ---------- */

export interface TopBlock { pid: string; pos: number; index: number; node: PMNode }

export function topBlocks(state: EditorState): TopBlock[] {
  const out: TopBlock[] = [];
  let i = 0;
  state.doc.forEach((node, pos) => { out.push({ pid: node.attrs.pid, pos, index: i++, node }); });
  return out;
}

/** The top-level block containing the selection head. */
export function caretBlock(state: EditorState): TopBlock | null {
  const $h = state.selection.$head;
  if ($h.depth < 1) return null;
  const pos = $h.before(1);
  const node = state.doc.nodeAt(pos);
  return node ? { pid: node.attrs.pid, pos, index: $h.index(0), node } : null;
}

export function findBlock(state: EditorState, pid: string): TopBlock | null {
  let hit: TopBlock | null = null;
  let i = 0;
  state.doc.forEach((node, pos) => { if (!hit && node.attrs.pid === pid) hit = { pid, pos, index: i, node }; i++; });
  return hit;
}

/** Change the caret block's type while keeping its pid (and its history). */
export function toggleBlock(editor: Editor, type: "heading" | "blockquote") {
  const { state } = editor;
  const b = caretBlock(state);
  if (!b) return;
  const target = b.node.type.name === type ? "paragraph" : type;
  const nodeType = state.schema.nodes[target];
  const attrs: Record<string, unknown> = { pid: b.node.attrs.pid };
  if (target === "heading") attrs.level = 2;
  // Hard breaks are only meaningful inside paragraphs/quotes; headings keep them too (harmless).
  editor.view.dispatch(state.tr.setNodeMarkup(b.pos, nodeType, attrs));
  editor.commands.focus();
}
