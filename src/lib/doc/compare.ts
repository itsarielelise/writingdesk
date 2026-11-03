import { blocksOf, norm, type BlockInfo, type DocJSON } from "./model";

export interface DocDiff {
  removed: BlockInfo[];                                   // in `then`, gone `now`
  changed: { then: BlockInfo; now: BlockInfo }[];         // same pid, different text
  added: BlockInfo[];                                     // new since `then`
}

/** Paragraph-level diff keyed by pid. */
export function diffDocs(then: DocJSON, now: DocJSON): DocDiff {
  const a = blocksOf(then), b = blocksOf(now);
  const removed: BlockInfo[] = [], changed: DocDiff["changed"] = [], added: BlockInfo[] = [];
  for (const [pid, x] of a) {
    const y = b.get(pid);
    if (!y) { if (norm(x.text)) removed.push(x); }
    else if (norm(x.text) !== norm(y.text) || x.type !== y.type) changed.push({ then: x, now: y });
  }
  for (const [pid, y] of b) if (!a.has(pid) && norm(y.text)) added.push(y);
  return { removed, changed, added };
}

/**
 * Where to reinsert a paragraph that existed in `then`: right after the nearest
 * earlier paragraph (in `then` order) that still exists now. Returns the index
 * in `now` to insert at (0 = top).
 */
export function bringBackIndex(then: DocJSON, now: DocJSON, pid: string): number {
  const order = then.content.map((b) => b.attrs.pid);
  const nowIdx = new Map(now.content.map((b, i) => [b.attrs.pid, i]));
  for (let j = order.indexOf(pid) - 1; j >= 0; j--) {
    const i = nowIdx.get(order[j]);
    if (i !== undefined) return i + 1;
  }
  return 0;
}

export interface Take { text: string; versionId: string | null; kind: string | null; createdAt: string | null; node: BlockInfo["node"] }

/** Every distinct saved text of a pid across versions (newest first), excluding the current text. */
export function takesOf(
  pid: string,
  current: BlockInfo | undefined,
  versions: { id: string; kind: string; created_at: string; content: DocJSON }[],
): Take[] {
  const seen = new Set<string>();
  if (current) seen.add(norm(current.text));
  const takes: Take[] = [];
  const sorted = [...versions].sort((x, y) => y.created_at.localeCompare(x.created_at));
  for (const v of sorted) {
    const b = blocksOf(v.content).get(pid);
    const k = b && norm(b.text);
    if (b && k && !seen.has(k)) {
      seen.add(k);
      takes.push({ text: b.text, versionId: v.id, kind: v.kind, createdAt: v.created_at, node: b.node });
    }
  }
  return takes;
}
