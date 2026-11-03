"use client";
import { useEffect, useRef, useState } from "react";
import { when } from "./api";
import type { Anchor } from "@/lib/coach/types";
import type { Flag, ParkedItem, Version } from "@/lib/api/types";
import { KIND_LABEL } from "@/lib/versions/policy";

/* ---------- Coach ---------- */

const FLAG_KIND: Record<string, [string, string]> = { repeat: ["Repeat", "k-repeat"], drift: ["Off the point", "k-drift"], order: ["Out of order", "k-order"] };

export function CoachPane(p: {
  anchor: Anchor; coaching: boolean; coachMsg: string; busy: boolean; flags: Flag[];
  paragraphText: (pid: string) => string; hasBlock: (pid: string | null) => boolean;
  onSetAnchor: () => void; onToggle: (on: boolean) => void; onCheckAll: () => void; onTakes: () => void;
  onJump: (pid: string) => void; onPark: (f: Flag) => void; onDismiss: (f: Flag) => void; onExplain: (f: Flag) => Promise<string>;
}) {
  return (
    <section className="pane">
      {!(p.anchor.point || "").trim() && (
        <div className="card">
          <p>Set this piece’s anchor so I can tell a rabbit trail from a good aside.</p>
          <button className="btn small" onClick={p.onSetAnchor}>Set anchor</button>
        </div>
      )}
      {!p.coaching ? (
        <div className="card">
          <p>Live coaching checks each paragraph after you finish it for repeats, drift and order. Notes wait until you pause, so they never break your flow.</p>
          <button className="btn primary small" onClick={() => p.onToggle(true)}>Turn on live coaching</button>
        </div>
      ) : (
        <div>
          <p className="hint">Live coaching is on. Notes wait until you pause.</p>
          <div className="row">
            <button className="btn small" onClick={p.onCheckAll} disabled={p.busy}>Check whole draft</button>
            <button className="btn small" onClick={p.onTakes}>Earlier takes of this paragraph</button>
            <button className="btn ghost small" onClick={() => p.onToggle(false)}>Turn off</button>
          </div>
        </div>
      )}
      {!p.coaching && (
        <div className="row"><button className="btn small" onClick={p.onTakes}>Earlier takes of this paragraph</button></div>
      )}
      <p className="hint" aria-live="polite">{p.coachMsg}</p>
      <h3>Notes</h3>
      <div>
        {!p.flags.length ? <p className="hint">No notes yet.</p> : [...p.flags].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((f) => (
          <FlagCard key={f.id} f={f} p={p} />
        ))}
      </div>
      <h3>Margin marks</h3>
      <div className="legend">
        <i style={{ background: "var(--flow)" }} /><span>Paragraph you’re writing in flow</span>
        <i style={{ background: "var(--revise)" }} /><span>Revised after you moved on</span>
        <i style={{ background: "var(--loop)" }} /><span>Reworked three or more times</span>
      </div>
    </section>
  );
}

function FlagCard({ f, p }: { f: Flag; p: Parameters<typeof CoachPane>[0] }) {
  const [label, cls] = FLAG_KIND[f.type] || ["Note", ""];
  const [explain, setExplain] = useState<{ busy: boolean; text?: string; err?: boolean }>({ busy: false });
  return (
    <div className="card">
      <div className={"kind " + cls}>{label}<span className="conf" title="How sure the coach was">{Math.round(f.confidence * 100)}%</span></div>
      <div>{f.note}</div>
      <div className="quote">{p.paragraphText(f.pid).trim()}</div>
      {explain.text && <div className="explain" style={explain.err ? { color: "var(--loop)" } : undefined}>{explain.text}</div>}
      <div className="row">
        <button className="btn small" onClick={() => p.onJump(f.pid)}>Go to paragraph</button>
        {f.type === "repeat" && p.hasBlock(f.other_pid) && <button className="btn small" onClick={() => p.onJump(f.other_pid!)}>Show the earlier one</button>}
        {f.type === "drift" && <button className="btn small" onClick={() => p.onPark(f)}>Park paragraph</button>}
        {!explain.text && (
          <button className="btn small" disabled={explain.busy} onClick={async () => {
            setExplain({ busy: true });
            try { setExplain({ busy: false, text: await p.onExplain(f) }); }
            catch (e) { setExplain({ busy: false, text: (e as Error).message, err: true }); }
          }}>{explain.busy ? "Thinking…" : "Explain"}</button>
        )}
        <button className="btn ghost small" onClick={() => p.onDismiss(f)}>Dismiss</button>
      </div>
    </div>
  );
}

/* ---------- Versions ---------- */

export function VersionsPane(p: { versions: Version[]; onOpen: (v: Version) => void; onSave: () => void; onStitch: () => void; onExport: () => void; onCopy: () => void }) {
  return (
    <section className="pane">
      <p className="hint">Versions save themselves when a run of writing ends, before you start revising, and every few minutes. Your flow versions are the raw material for stitching.</p>
      <div className="row">
        <button className="btn small" onClick={p.onSave}>Save version now</button>
        <button className="btn primary small" onClick={p.onStitch}>Stitch best draft</button>
        <button className="btn small" onClick={p.onExport}>Export .md</button>
        <button className="btn small" onClick={p.onCopy}>Copy as Markdown</button>
      </div>
      <div className="vlist">
        {!p.versions.length ? <p className="hint">No versions yet. The first one saves when you pause after writing.</p> : p.versions.map((v) => (
          <button key={v.id} className="vrow" onClick={() => p.onOpen(v)}>
            <span className={"vchip " + v.kind}>{KIND_LABEL[v.kind] || v.kind}</span>
            <span className="lbl">{v.label || KIND_LABEL[v.kind]}</span>
            <span className="when">{when(v.created_at)}</span>
            <span />
            <span className="when">{v.word_count} words</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ---------- Parked ---------- */

export function ParkedPane(p: { items: ParkedItem[]; onInsert: (it: ParkedItem) => void; onCopy: (t: string) => void; onDelete: (id: string) => void }) {
  return (
    <section className="pane">
      <p className="hint">Select text, or put your cursor in a paragraph, and press Park (Alt+P). It leaves the draft but stays here for a later post.</p>
      {!p.items.length ? <p className="hint">Nothing parked yet.</p> : p.items.map((it) => (
        <div className="card" key={it.id}>
          <div className="park-item">{it.text}</div>
          <div className="hint">{when(it.created_at)}</div>
          <div className="row">
            <button className="btn small" onClick={() => p.onInsert(it)}>Insert at cursor</button>
            <button className="btn small" onClick={() => p.onCopy(it.text)}>Copy</button>
            <button className="btn ghost small" onClick={() => p.onDelete(it.id)}>Delete</button>
          </div>
        </div>
      ))}
    </section>
  );
}

/* ---------- Anchor ---------- */

export function AnchorPane({ anchor, onChange }: { anchor: Anchor; onChange: (p: Partial<Anchor>) => void }) {
  return (
    <section className="pane">
      <p className="hint">Coaching and stitching measure every paragraph against this.</p>
      <label className="fld" htmlFor="aPoint">The point of this piece<span>One or two sentences.</span></label>
      <textarea className="in" id="aPoint" rows={3} value={anchor.point} onChange={(e) => onChange({ point: e.target.value })} />
      <label className="fld" htmlFor="aSections">Sections, in order<span>One per line.</span></label>
      <textarea className="in" id="aSections" rows={6} value={anchor.sections} onChange={(e) => onChange({ sections: e.target.value })} />
      <label className="fld" htmlFor="aNot">Not in this piece<span>Topics saved for later posts.</span></label>
      <textarea className="in" id="aNot" rows={4} value={anchor.notThis} onChange={(e) => onChange({ notThis: e.target.value })} />
    </section>
  );
}

/* ---------- Ask ---------- */

export interface AskTurn { role: "user" | "assistant"; content: string; citations?: { url: string; title: string }[]; status?: string; error?: boolean }

export function AskPane(p: { turns: AskTurn[]; busy: boolean; onSend: (q: string) => void; onStop: () => void; onClear: () => void }) {
  const [q, setQ] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [p.turns]);
  const send = () => { const t = q.trim(); if (!t || p.busy) return; setQ(""); p.onSend(t); };
  return (
    <section className="pane">
      <p className="hint">Ask about this draft: a reference, a fact, a passage that isn’t landing. Claude can search the web here and will link its sources.</p>
      <div className="chat">
        {p.turns.map((t, i) => (
          <div key={i} className={"msg " + (t.role === "user" ? "you" : "ai") + (t.error ? " err" : "")}>
            {t.content || (t.status ? "" : "…")}
            {t.status && <div className="status">{t.status}</div>}
            {!!t.citations?.length && (
              <div className="cites">
                <span className="hint">Sources</span>
                {t.citations.map((c) => <a key={c.url} href={c.url} target="_blank" rel="noopener noreferrer" title={c.url}>{c.title}</a>)}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <textarea className="in" rows={3} placeholder="Ask about this draft" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
      <div className="row">
        <button className="btn primary small" onClick={send} disabled={p.busy}>Send</button>
        {p.busy && <button className="btn small" onClick={p.onStop}>Stop</button>}
        <button className="btn ghost small" onClick={p.onClear} disabled={p.busy}>Clear chat</button>
      </div>
    </section>
  );
}
