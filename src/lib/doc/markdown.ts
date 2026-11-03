import { blockText, newPid, type BlockNode, type DocJSON, type InlineNode, type TextNode } from "./model";

/* ---------- doc → Markdown ---------- */

function inlineToMd(nodes: InlineNode[] = []): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "hardBreak") { out += "\n"; continue; }
    const marks = new Set((n.marks || []).map((m) => m.type));
    let t = n.text;
    if (marks.has("italic")) t = `*${t}*`;
    if (marks.has("bold")) t = `**${t}**`;
    out += t;
  }
  return out;
}

export function docToMarkdown(doc: DocJSON, title?: string): string {
  const parts = doc.content.map((b) => {
    const t = inlineToMd(b.content).trim();
    if (!t) return null;
    if (b.type === "heading") return (b.attrs.level === 3 ? "### " : "## ") + t;
    if (b.type === "blockquote") return t.split("\n").map((l) => "> " + l).join("\n");
    return t;
  }).filter(Boolean) as string[];
  return (title ? `# ${title}\n\n` : "") + parts.join("\n\n");
}

/* ---------- Markdown → doc (the subset Claude writes for stitches) ---------- */

export function inlineFromMd(s: string): InlineNode[] {
  const out: InlineNode[] = [];
  const lines = s.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    const re = /\*\*(.+?)\*\*|(^|[^*])\*([^*\n]+?)\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const push = (text: string, marks?: TextNode["marks"]) => { if (text) out.push(marks ? { type: "text", text, marks } : { type: "text", text }); };
    while ((m = re.exec(line))) {
      if (m[1] !== undefined) {
        push(line.slice(last, m.index));
        push(m[1], [{ type: "bold" }]);
      } else {
        push(line.slice(last, m.index) + m[2]);
        push(m[3], [{ type: "italic" }]);
      }
      last = re.lastIndex;
    }
    push(line.slice(last));
  });
  return out;
}

export function markdownToDoc(md: string): DocJSON {
  const blocks: BlockNode[] = md.trim().split(/\n\s*\n/).map((chunk): BlockNode | null => {
    const c = chunk.trim();
    if (!c) return null;
    const h = c.match(/^(#{1,3})\s+([\s\S]*)$/);
    if (h) return { type: "heading", attrs: { pid: newPid(), level: h[1].length === 3 ? 3 : 2 }, content: inlineFromMd(h[2].replace(/\n/g, " ")) };
    const lines = c.split("\n");
    if (lines.every((l) => /^>/.test(l))) return { type: "blockquote", attrs: { pid: newPid() }, content: inlineFromMd(lines.map((l) => l.replace(/^>\s?/, "")).join("\n")) };
    return { type: "paragraph", attrs: { pid: newPid() }, content: inlineFromMd(c) };
  }).filter((b): b is BlockNode => !!b);
  return { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph", attrs: { pid: newPid() } }] };
}

/** Split pasted plain text into blocks the way the prototype did. */
export function plainPasteToDoc(t: string): DocJSON | null {
  const text = t.replace(/\r\n?/g, "\n");
  const parts = (/\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split("\n")).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return null;
  return markdownToDoc(parts.join("\n\n"));
}

export { blockText };
