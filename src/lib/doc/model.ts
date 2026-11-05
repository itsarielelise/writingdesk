// The editor's document model (TipTap/ProseMirror JSON), restricted to what the
// editor supports: paragraphs, h2/h3 headings and quotes as top-level text blocks,
// with bold, italic and hard breaks inline, plus image blocks. Every block carries a stable `pid`.

export type MarkType = "bold" | "italic";
export interface TextNode { type: "text"; text: string; marks?: { type: MarkType }[] }
export interface HardBreakNode { type: "hardBreak" }
export type InlineNode = TextNode | HardBreakNode;
export type BlockType = "paragraph" | "heading" | "blockquote" | "image";
export interface BlockNode {
  type: BlockType;
  /**
   * Images: `src` is an internal path (/api/images/...) once stored; `origin` is the
   * external URL it was pasted from while (or if) it couldn't be copied; `alt` is the caption.
   */
  attrs: { pid: string; level?: 2 | 3; src?: string; alt?: string; origin?: string };
  content?: InlineNode[];
}
export interface DocJSON { type: "doc"; content: BlockNode[] }

export const PID_RE = /^[a-z0-9]{4,16}$/;
export const newPid = (): string => {
  const a = new Uint8Array(8);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join("");
};

/** Stored images live at /api/images/<user>/<piece>/<file>. */
export const IMAGE_SRC_RE = /^\/api\/images\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;
const ORIGIN_RE = /^https?:\/\/[^\s"'<>]{1,2000}$/;

export const emptyDoc = (): DocJSON => ({ type: "doc", content: [{ type: "paragraph", attrs: { pid: newPid() } }] });

const MAX_BLOCKS = 5000;
const MAX_TEXT = 200_000;

/**
 * Sanitize untrusted editor JSON. Unknown nodes are flattened to their text,
 * unknown marks are dropped, invalid or duplicate pids are replaced. Never throws.
 */
export function sanitizeDoc(input: unknown): DocJSON {
  const out: BlockNode[] = [];
  const seen = new Set<string>();
  const root = isObj(input) && Array.isArray(input.content) ? input.content : [];

  const pushBlock = (type: BlockType, attrs: Record<string, unknown>, inl: InlineNode[]) => {
    if (out.length >= MAX_BLOCKS) return;
    let pid = typeof attrs.pid === "string" && PID_RE.test(attrs.pid) ? attrs.pid : "";
    if (!pid || seen.has(pid)) pid = newPid();
    seen.add(pid);
    const b: BlockNode = { type, attrs: { pid } };
    if (type === "heading") b.attrs.level = attrs.level === 3 || attrs.level === 4 ? 3 : 2;
    const content = mergeText(inl);
    if (content.length) b.content = content;
    out.push(b);
  };

  const pushImage = (attrs: Record<string, unknown>) => {
    if (out.length >= MAX_BLOCKS) return;
    const src = typeof attrs.src === "string" && IMAGE_SRC_RE.test(attrs.src) ? attrs.src : "";
    const origin = !src && typeof attrs.origin === "string" && ORIGIN_RE.test(attrs.origin) ? attrs.origin : "";
    if (!src && !origin) return; // nothing to show: a failed or in-flight local upload
    let pid = typeof attrs.pid === "string" && PID_RE.test(attrs.pid) ? attrs.pid : "";
    if (!pid || seen.has(pid)) pid = newPid();
    seen.add(pid);
    const alt = typeof attrs.alt === "string" ? attrs.alt.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    const b: BlockNode = { type: "image", attrs: { pid } };
    if (src) b.attrs.src = src; else b.attrs.origin = origin;
    if (alt) b.attrs.alt = alt;
    out.push(b);
  };

  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      if (!isObj(n)) continue;
      const t = n.type;
      const attrs = isObj(n.attrs) ? n.attrs : {};
      if (t === "image") { pushImage(attrs); continue; }
      if (t === "paragraph" || t === "heading" || t === "blockquote") {
        const kids = Array.isArray(n.content) ? n.content : [];
        // A quote that wraps blocks (TipTap's default shape) is flattened to one quote block.
        if (kids.some((k) => isObj(k) && ["paragraph", "heading", "blockquote"].includes(String(k.type)))) {
          const inl: InlineNode[] = [];
          kids.forEach((k, i) => {
            if (i > 0) inl.push({ type: "hardBreak" });
            inl.push(...inlineOf(isObj(k) && Array.isArray(k.content) ? k.content : []));
          });
          const firstPid = isObj(kids[0]) && isObj(kids[0].attrs) ? kids[0].attrs.pid : undefined;
          pushBlock(t === "heading" ? "heading" : "blockquote", { ...attrs, pid: attrs.pid ?? firstPid }, inl);
        } else {
          pushBlock(t as BlockType, attrs, inlineOf(kids));
        }
      } else if (Array.isArray(n.content)) {
        // bulletList, listItem, codeBlock, etc.: keep the text, lose the structure.
        const hasBlocks = n.content.some((k) => isObj(k) && k.type !== "text" && k.type !== "hardBreak");
        if (hasBlocks) walk(n.content);
        else pushBlock("paragraph", attrs, inlineOf(n.content));
      } else if (t === "text" && typeof n.text === "string") {
        pushBlock("paragraph", {}, inlineOf([n]));
      }
    }
  };
  walk(root);
  if (!out.length) return emptyDoc();
  return { type: "doc", content: out };
}

function inlineOf(nodes: unknown[]): InlineNode[] {
  const res: InlineNode[] = [];
  let budget = MAX_TEXT;
  for (const n of nodes) {
    if (!isObj(n)) continue;
    if (n.type === "hardBreak") res.push({ type: "hardBreak" });
    else if (n.type === "text" && typeof n.text === "string" && n.text) {
      const text = n.text.slice(0, budget);
      budget -= text.length;
      const marks = (Array.isArray(n.marks) ? n.marks : [])
        .map((m) => (isObj(m) ? m.type : null))
        .filter((m): m is MarkType => m === "bold" || m === "italic");
      const uniq = [...new Set(marks)].sort();
      res.push(uniq.length ? { type: "text", text, marks: uniq.map((type) => ({ type })) } : { type: "text", text });
    } else if (Array.isArray(n.content)) res.push(...inlineOf(n.content));
  }
  return res;
}

function mergeText(nodes: InlineNode[]): InlineNode[] {
  const res: InlineNode[] = [];
  for (const n of nodes) {
    const prev = res[res.length - 1];
    if (n.type === "text" && prev && prev.type === "text" && markKey(prev) === markKey(n)) prev.text += n.text;
    else res.push(n.type === "text" ? { ...n } : n);
  }
  return res;
}
const markKey = (n: TextNode) => (n.marks || []).map((m) => m.type).join(",");
function isObj(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/* ---------- text helpers ---------- */

export const wordCount = (t: string): number => (String(t).match(/\S+/g) || []).length;
export const norm = (t: string | null | undefined): string => String(t || "").replace(/\s+/g, " ").trim();

/** Markdown-style token for an image, used in plain text, prompts and export. */
export function imageToken(b: BlockNode): string {
  const alt = (b.attrs.alt || "").replace(/[\[\]]/g, "");
  return `![${alt}](${b.attrs.src || b.attrs.origin || ""})`;
}

export function blockText(b: BlockNode): string {
  if (b.type === "image") return imageToken(b);
  return (b.content || []).map((n) => (n.type === "text" ? n.text : "\n")).join("");
}

export interface BlockInfo { pid: string; type: BlockType; level?: 2 | 3; text: string; index: number; node: BlockNode }

export function blocksOf(doc: DocJSON): Map<string, BlockInfo> {
  const m = new Map<string, BlockInfo>();
  doc.content.forEach((node, index) => {
    m.set(node.attrs.pid, { pid: node.attrs.pid, type: node.type, level: node.attrs.level, text: blockText(node), index, node });
  });
  return m;
}

export function plainText(doc: DocJSON): string {
  return doc.content.map((b) => blockText(b).trim()).filter(Boolean).join("\n\n");
}

/** Words in the draft, not counting images. */
export function docWordCount(doc: DocJSON): number {
  return wordCount(doc.content.filter((b) => b.type !== "image").map(blockText).join("\n\n"));
}

export const isHeading = (b: { type: BlockType }) => b.type === "heading";
