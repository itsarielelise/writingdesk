"use client";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { BlockNode, DocJSON, InlineNode } from "@/lib/doc/model";

/* ---------- Toast ---------- */

export interface ToastAction { label: string; primary?: boolean; fn: () => void }
export interface ToastState { id: number; msg: string; actions: ToastAction[] }

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, toast.actions.length ? 14000 : 4000);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{toast.msg}</span>
      {toast.actions.map((a) => (
        <button key={a.label} className={"btn small" + (a.primary ? " primary" : "")} onClick={() => { onClose(); a.fn(); }}>{a.label}</button>
      ))}
    </div>
  );
}

/* ---------- Modal ---------- */

export interface ModalAction { label: string; primary?: boolean; disabled?: boolean; hidden?: boolean; fn: () => void }

export function Modal({ title, children, actions = [], onClose }: { title: string; children: ReactNode; actions?: ModalAction[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  const shown = actions.filter((a) => !a.hidden);
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mbox" role="dialog" aria-modal="true" aria-labelledby="mTitle">
        <div className="mhead"><h2 id="mTitle">{title}</h2><button ref={closeRef} className="btn ghost small" onClick={onClose}>Close</button></div>
        <div className="mbody">{children}</div>
        {shown.length > 0 && (
          <div className="mfoot">
            {shown.map((a) => <button key={a.label} className={"btn" + (a.primary ? " primary" : "")} disabled={a.disabled} onClick={a.fn}>{a.label}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Read-only rendering of stored documents ---------- */

export function Inline({ nodes }: { nodes?: InlineNode[] }) {
  return (
    <>
      {(nodes || []).map((n, i) => {
        if (n.type === "hardBreak") return <br key={i} />;
        let el: ReactNode = n.text;
        const marks = new Set((n.marks || []).map((m) => m.type));
        if (marks.has("italic")) el = <i>{el}</i>;
        if (marks.has("bold")) el = <b>{el}</b>;
        return <Fragment key={i}>{el}</Fragment>;
      })}
    </>
  );
}

export function Block({ b }: { b: BlockNode }) {
  if (b.type === "heading") return b.attrs.level === 3 ? <h3><Inline nodes={b.content} /></h3> : <h2><Inline nodes={b.content} /></h2>;
  if (b.type === "blockquote") return <blockquote><Inline nodes={b.content} /></blockquote>;
  return <p><Inline nodes={b.content} /></p>;
}

export function DocView({ doc, className = "prose" }: { doc: DocJSON; className?: string }) {
  return <div className={className}>{doc.content.map((b, i) => <Block key={b.attrs.pid + i} b={b} />)}</div>;
}
