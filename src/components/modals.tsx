"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAbort, streamApi, when } from "./api";
import { Block, DocView, Modal } from "./ui";
import { diffDocs, takesOf } from "@/lib/doc/compare";
import { markdownToDoc } from "@/lib/doc/markdown";
import type { BlockInfo, BlockNode, DocJSON } from "@/lib/doc/model";
import { splitStitch } from "@/lib/ai/prompts";
import type { Anchor } from "@/lib/coach/types";
import type { Version } from "@/lib/api/types";
import { KIND_LABEL } from "@/lib/versions/policy";

/* ---------- Version preview ---------- */

export function VersionModal(p: { v: Version; onClose: () => void; onDelete: () => void; onCompare: () => void; onRestore: () => void }) {
  return (
    <Modal title={`${KIND_LABEL[p.v.kind] || "Version"} · ${when(p.v.created_at)}`} onClose={p.onClose} actions={[
      { label: "Delete version", fn: p.onDelete },
      { label: "Compare with now", fn: p.onCompare },
      { label: "Restore this version", primary: true, fn: p.onRestore },
    ]}>
      <DocView doc={p.v.content} />
    </Modal>
  );
}

/* ---------- Compare with now ---------- */

export function CompareModal(p: {
  v: Version; now: DocJSON; onClose: () => void;
  onBringBack: (pid: string) => void; onPark: (text: string) => void; onUseEarlier: (pid: string, node: BlockNode) => Promise<boolean>;
}) {
  const diff = useMemo(() => diffDocs(p.v.content, p.now), [p.v, p.now]);
  const [done, setDone] = useState<Record<string, string>>({});
  const mark = (k: string, label: string) => setDone((d) => ({ ...d, [k]: label }));
  const none = !diff.changed.length && !diff.removed.length && !diff.added.length;
  return (
    <Modal title={`Compare: ${when(p.v.created_at)} vs now`} onClose={p.onClose}>
      {none && <p className="hint">No differences in paragraphs.</p>}
      {!!diff.removed.length && <h3>In that version, gone now ({diff.removed.length})</h3>}
      {diff.removed.map((b) => (
        <div className="take" key={b.pid}>
          <div className="diff-then prose"><Block b={b.node} /></div>
          <div className="row">
            <button className="btn small" disabled={!!done["bb" + b.pid]} onClick={() => { p.onBringBack(b.pid); mark("bb" + b.pid, "Brought back"); }}>{done["bb" + b.pid] || "Bring back"}</button>
            <button className="btn small" disabled={!!done["pk" + b.pid]} onClick={() => { p.onPark(b.text); mark("pk" + b.pid, "Parked"); }}>{done["pk" + b.pid] || "Add to Parked"}</button>
          </div>
        </div>
      ))}
      {!!diff.changed.length && <h3>Changed since ({diff.changed.length})</h3>}
      {diff.changed.map(({ then, now }) => (
        <div className="take" key={then.pid}>
          <div className="th">Then</div>
          <div className="diff-then prose"><Block b={then.node} /></div>
          <div className="th">Now</div>
          <div className="diff-now prose"><Block b={now.node} /></div>
          <div className="row">
            <button className="btn small" disabled={!!done["ue" + then.pid]} onClick={async () => { if (await p.onUseEarlier(then.pid, then.node)) mark("ue" + then.pid, "Used"); }}>{done["ue" + then.pid] || "Use the earlier wording"}</button>
          </div>
        </div>
      ))}
      {!!diff.added.length && <h3>New since ({diff.added.length})</h3>}
      {diff.added.map((b) => <div className="diff-now prose" key={b.pid}><Block b={b.node} /></div>)}
    </Modal>
  );
}

/* ---------- Earlier takes ---------- */

export function TakesModal(p: { pid: string; current: BlockInfo | undefined; versions: Version[]; point: string; onClose: () => void; onUse: (node: BlockNode) => void }) {
  const takes = useMemo(() => takesOf(p.pid, p.current, p.versions), [p.pid, p.current, p.versions]);
  const [verdict, setVerdict] = useState<{ text: string; err?: boolean; busy?: boolean } | null>(null);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const ask = async () => {
    setVerdict({ text: "Thinking…", busy: true });
    const all = [
      { label: "current", text: p.current?.text || "" },
      ...takes.map((t) => ({ label: `${KIND_LABEL[t.kind as keyof typeof KIND_LABEL] || ""}, ${when(t.createdAt!)}`, text: t.text })),
    ];
    ctl.current = new AbortController();
    let out = "";
    try {
      await streamApi("/api/ai/takes", { point: p.point, takes: all }, (e) => {
        if (e.type === "text") { out += e.text; setVerdict({ text: out, busy: true }); }
        else if (e.type === "error") setVerdict({ text: e.message, err: true });
        else if (e.type === "done") setVerdict({ text: out });
      }, ctl.current.signal);
    } catch (e) {
      if (!isAbort(e)) setVerdict({ text: (e as Error).message, err: true });
    }
  };
  return (
    <Modal title="Earlier takes of this paragraph" onClose={p.onClose} actions={takes.length ? [
      { label: "Ask Claude which take is strongest", primary: true, disabled: !!verdict?.busy, fn: ask },
    ] : []}>
      <div className="take">
        <div className="th"><span>Take 1 · now</span></div>
        <div className="prose">{p.current ? <Block b={p.current.node} /> : null}</div>
      </div>
      {!takes.length && <p className="hint">No earlier takes of this paragraph are saved yet. New takes save each time you pause.</p>}
      {takes.map((t, i) => (
        <div className="take" key={t.versionId! + i}>
          <div className="th">
            <span>Take {i + 2} · {KIND_LABEL[t.kind as keyof typeof KIND_LABEL] || ""} · {when(t.createdAt!)}</span>
            <button className="btn small" onClick={() => p.onUse(t.node)}>Use this take</button>
          </div>
          <div className="prose"><Block b={t.node} /></div>
        </div>
      ))}
      {verdict && <div className={"msg ai" + (verdict.err ? " err" : "")}>{verdict.text}</div>}
    </Modal>
  );
}

/* ---------- Stitch ---------- */

export function StitchModal(p: { pieceId: string; draft: string; anchor: Anchor; onClose: () => void; onCopied: () => void; onReplace: (doc: DocJSON) => void }) {
  const [result, setResult] = useState("");
  const [status, setStatus] = useState<{ text: string; err?: boolean }>({ text: "Reading your versions… this can take a minute or two for a long piece." });
  const [state, setState] = useState<"running" | "done" | "stopped" | "error">("running");
  const ctl = useRef<AbortController | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const c = new AbortController();
    ctl.current = c;
    let out = "";
    streamApi("/api/ai/stitch", { pieceId: p.pieceId, draft: p.draft, anchor: p.anchor }, (e) => {
      if (e.type === "text") { out += e.text; setResult(out); setStatus({ text: "Stitching…" }); }
      else if (e.type === "status") setStatus({ text: e.text });
      else if (e.type === "error") { setStatus({ text: e.message, err: true }); setState("error"); }
      else if (e.type === "done") {
        setStatus({ text: e.truncated ? "This was cut short. Try stitching with fewer versions, or stitch one section at a time." : "Review it, then copy it or replace your draft. Words in [brackets] were added by Claude." });
        setState("done");
      }
    }, c.signal).catch((e) => {
      if (isAbort(e)) { setStatus({ text: "Stopped." }); setState("stopped"); }
      else { setStatus({ text: (e as Error).message, err: true }); setState("error"); }
    });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [article, notes] = splitStitch(result);
  const doc = useMemo(() => markdownToDoc(article || " "), [article]);
  return (
    <Modal title="Stitched draft" onClose={p.onClose} actions={[
      { label: "Stop", hidden: state !== "running", fn: () => ctl.current?.abort() },
      { label: "Copy", disabled: !result || state === "running", fn: () => navigator.clipboard?.writeText(article.trim()).then(p.onCopied, () => {}) },
      { label: "Replace my draft with this", primary: true, disabled: state !== "done", fn: () => p.onReplace(markdownToDoc(article)) },
    ]}>
      <p className="hint" style={status.err ? { color: "var(--loop)" } : undefined}>{status.text}</p>
      {article.trim() && <DocView doc={doc} />}
      {notes && <div className="notes">Editor’s notes{notes}</div>}
    </Modal>
  );
}

/* ---------- First-run guide ---------- */

export function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How Writing Desk works" onClose={onClose} actions={[{ label: "Start writing", primary: true, fn: onClose }]}>
      <div className="guide">
        <p>Writing Desk stays out of your way while you write, and keeps everything you might want back.</p>
        <ol>
          <li><b>Flow</b>The pill at the top shows how you’re writing. When you’re moving forward steadily it says <i>In flow</i>, the bar on the page turns green and the toolbar fades. If you keep reworking the same paragraph it says <i>Looping?</i> and offers your earlier takes.</li>
          <li><b>Versions</b>A version saves itself when a run of writing ends, every few minutes while you revise, and before any big change. Open one to restore it or compare it with now, paragraph by paragraph. <i>Stitch best draft</i> asks Claude to assemble the strongest draft from them.</li>
          <li><b>Parking</b>Select text, or put your cursor in a paragraph, and press <i>Park</i> (Alt+P). It leaves the draft but waits in the Parked tab for a later post.</li>
          <li><b>Notes</b>The Notes tab (Alt+N) is for scraps: lines, links and images that connect to the piece but aren’t part of it yet. They stay out of the word count and the coach. Drag one into the draft when it’s ready.</li>
          <li><b>Images</b>Paste or drag images in, or use the Image button. Images pasted from web pages or Google Docs are copied into your private storage so they don’t disappear later.</li>
          <li><b>The anchor</b>Tell the Anchor tab what the piece is about, its sections and what’s not in it. Live coaching uses it to flag repeats, tangents and paragraphs in the wrong section, and only shows notes when you pause.</li>
        </ol>
        <p className="hint">Ctrl/Cmd+S saves a version. Your writing is private to you.</p>
      </div>
    </Modal>
  );
}
