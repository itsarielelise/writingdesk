"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { api, ls, streamApi } from "./api";
import { Toast, type ToastAction, type ToastState } from "./ui";
import { caretBlock, editorExtensions, findBlock, setMarks, toggleBlock, topBlocks } from "./editor/extensions";
import { CoachPane, VersionsPane, ParkedPane, AnchorPane, AskPane, NotesPane, type AskTurn } from "./panes";
import { VersionModal, CompareModal, TakesModal, StitchModal, GuideModal } from "./modals";
import { FlowDetector, FLOW_CONFIG, MODE_LABEL, MODE_TIP, isWritingMode, type Mode } from "@/lib/flow/detector";
import { autosaveDue, flowVersionLabel, VERSION_CONFIG, type VersionKind } from "@/lib/versions/policy";
import { blockText, blocksOf, docWordCount, norm, plainText, sanitizeDoc, wordCount, type BlockNode, type DocJSON } from "@/lib/doc/model";
import { docToMarkdown, markdownToDoc, plainPasteToDoc } from "@/lib/doc/markdown";
import { dataUrlToBlob, imageFiles, importImage, patchImage, uploadImage } from "./images";
import { COACH_CONFIG, type Anchor, type DraftBlock } from "@/lib/coach/types";
import type { Flag, Note, OpenPiece, ParkedItem, PieceSummary, Version } from "@/lib/api/types";

type Tab = "coach" | "notes" | "versions" | "parked" | "anchor" | "ask";
type ModalState =
  | { kind: "version"; v: Version }
  | { kind: "compare"; v: Version }
  | { kind: "takes"; pid: string }
  | { kind: "stitch" }
  | { kind: "guide" }
  | null;

export interface DeskProps { email: string; isAdmin: boolean }

export default function Desk({ email, isAdmin }: DeskProps) {
  /* ---------- state that renders ---------- */
  const [pieces, setPieces] = useState<PieceSummary[]>([]);
  const [pieceId, setPieceId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [anchor, setAnchor] = useState<Anchor>({ point: "", sections: "", notThis: "" });
  const [versions, setVersions] = useState<Version[]>([]);
  const [parked, setParked] = useState<ParkedItem[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const notesInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [heldFlags, setHeldFlags] = useState<Flag[]>([]);
  const [mode, setModeState] = useState<Mode>("paused");
  const [words, setWords] = useState(0);
  const [saveState, setSaveState] = useState<{ s: "saving" | "saved" | "error" | "idle"; msg?: string }>({ s: "idle", msg: "Opening…" });
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("coach");
  const [unseen, setUnseen] = useState(0);
  const [toast, setToastState] = useState<ToastState | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [coaching, setCoaching] = useState(false);
  const [coachMsg, setCoachMsg] = useState("");
  const [coachBusy, setCoachBusy] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [askTurns, setAskTurns] = useState<AskTurn[]>([]);
  const [docVersion, setDocVersion] = useState(0); // bumps when the doc changes, for panes that read it

  /* ---------- state that doesn't render ---------- */
  const R = useRef({
    detector: new FlowDetector(),
    mode: "paused" as Mode,
    lastLen: 0,
    lastInputAt: 0,
    lastSnap: { words: 0, at: Date.now(), text: "" },
    knownPids: new Set<string>(),
    revs: {} as Record<string, number>,
    revsDirty: new Set<string>(),
    curPid: null as string | null,
    checkedText: {} as Record<string, string>,
    pending: new Set<string>(),
    coachBusy: false,
    lastCoachAt: 0,
    loopToastAt: 0,
    loopToastByPid: {} as Record<string, number>,
    saveTimer: null as ReturnType<typeof setTimeout> | null,
    metaTimer: null as ReturnType<typeof setTimeout> | null,
    suppress: false,
    pieceId: null as string | null,
    title: "",
    anchor: { point: "", sections: "", notThis: "" } as Anchor,
    versions: [] as Version[],
    coaching: false,
    unseen: 0,
    panelOpen: true,
    tab: "coach" as Tab,
    saving: Promise.resolve() as Promise<unknown>,
    heldFlags: [] as Flag[],
    uploads: new Map<string, Blob>(),      // uploadId → file waiting to upload
    imgInflight: new Set<string>(),        // uploadIds / origins being copied
    pasteFiles: [] as File[],              // files that came with a paste (Word puts images here)
  });
  const S = R.current;
  S.versions = versions; S.coaching = coaching; S.panelOpen = panelOpen; S.tab = tab; S.unseen = unseen; S.heldFlags = heldFlags;

  const showToast = useCallback((msg: string, actions: ToastAction[] = []) => setToastState({ id: Date.now(), msg, actions }), []);
  const closeToast = useCallback(() => setToastState(null), []);

  /* ---------- editor ---------- */
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    extensions: editorExtensions,
    immediatelyRender: false,
    editable: false,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: {
      attributes: { spellcheck: "true", "aria-label": "Draft" },
      handlePaste: (view, event) => {
        const dt = event.clipboardData;
        if (!dt) return false;
        const files = imageFiles(dt.files);
        const html = dt.getData("text/html");
        if (html) {
          // Let the editor parse it; <img> tags become image blocks that get copied in the background.
          // Word/Docs sometimes reference local files in the HTML and put the real images in `files`.
          S.pasteFiles = files;
          return false;
        }
        if (files.length) { insertImageFilesRef.current(files); return true; }
        const doc = plainPasteToDoc(dt.getData("text/plain") || "");
        if (!doc) return false;
        editorRef.current?.chain().focus().insertContent(doc.content.map((b) => ({ ...b, attrs: { ...b.attrs, pid: null } }))).run();
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = imageFiles((event as DragEvent).dataTransfer?.files);
        if (moved || !files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
        insertImageFilesRef.current(files, at?.pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => onDocChange(editor),
    onSelectionUpdate: ({ editor }) => onSelection(editor),
  });
  editorRef.current = editor;

  const currentDoc = useCallback((): DocJSON => sanitizeDoc(editorRef.current?.getJSON()), []);
  const draftBlocks = useCallback((): DraftBlock[] => {
    const ed = editorRef.current;
    if (!ed) return [];
    return topBlocks(ed.state).map((b) => ({ pid: b.pid, text: b.node.textBetween(0, b.node.content.size, "\n"), heading: b.node.type.name === "heading" }));
  }, []);
  const draftText = useCallback(() => plainText(currentDoc()), [currentDoc]);

  /* ---------- saving ---------- */
  const saveNow = useCallback(async (keepalive = false) => {
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
    const id = S.pieceId, ed = editorRef.current;
    if (!id || !ed) return;
    const content = currentDoc();
    const payload = { title: S.title, content, anchor_point: S.anchor.point, anchor_sections: S.anchor.sections, anchor_not_this: S.anchor.notThis };
    const run = async () => {
      try {
        const r = await api<{ piece: PieceSummary }>(`/api/pieces/${id}`, { method: "PATCH", json: payload, keepalive });
        setSaveState({ s: "saved" });
        setPieces((ps) => ps.map((p) => (p.id === id ? { ...p, ...r.piece } : p)));
      } catch (e) {
        setSaveState({ s: "error", msg: "Not saved — will retry" });
        S.saveTimer = setTimeout(() => saveNow(), 5000);
      }
    };
    S.saving = S.saving.then(run, run);
    return S.saving;
  }, [S, currentDoc]);

  const saveSoon = useCallback(() => {
    if (!S.pieceId) return;
    setSaveState({ s: "saving" });
    if (S.saveTimer) clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => saveNow(), VERSION_CONFIG.pieceSaveDebounceMs);
  }, [S, saveNow]);

  const saveMetaSoon = useCallback(() => {
    if (S.metaTimer) clearTimeout(S.metaTimer);
    S.metaTimer = setTimeout(() => {
      const id = S.pieceId;
      if (!id || !S.revsDirty.size) return;
      const revs: Record<string, number> = {};
      for (const pid of S.revsDirty) revs[pid] = S.revs[pid] || 0;
      S.revsDirty.clear();
      api(`/api/pieces/${id}/meta`, { method: "PUT", json: { revs } }).catch(() => { for (const p of Object.keys(revs)) S.revsDirty.add(p); });
    }, 3000);
  }, [S]);

  /* ---------- versions ---------- */
  const snapshot = useCallback(async (kind: VersionKind, label?: string): Promise<Version | null> => {
    const id = S.pieceId;
    if (!id || !editorRef.current) return null;
    const content = currentDoc();
    const text = plainText(content);
    if (!text.trim()) return null;
    if (S.versions[0] && S.versions[0].plain_text === text) return null;
    const w = docWordCount(content);
    S.lastSnap = { words: w, at: Date.now(), text };
    try {
      const r = await api<{ version: Version | null; pruned?: string[] }>(`/api/pieces/${id}/versions`, { method: "POST", json: { kind, label: label || "", content } });
      if (!r.version) return null;
      const v = { ...r.version, content: sanitizeDoc(r.version.content) };
      setVersions((vs) => [v, ...vs.filter((x) => !(r.pruned || []).includes(x.id))]);
      S.versions = [v, ...S.versions];
      return v;
    } catch {
      showToast("That version couldn’t be saved.");
      return null;
    }
  }, [S, currentDoc, showToast]);

  /* ---------- margin marks ---------- */
  const pushMarks = useCallback(() => {
    const ed = editorRef.current;
    if (ed) setMarks(ed, { revs: { ...S.revs }, cur: S.curPid, reworkedAt: FLOW_CONFIG.reworkedAt });
  }, [S]);

  const leaveBlock = useCallback((pid: string | null) => {
    const ed = editorRef.current;
    if (!pid || !ed) return;
    const b = findBlock(ed.state, pid);
    if (!b) return;
    const t = norm(b.node.textContent);
    if (wordCount(t) >= COACH_CONFIG.minWords && S.checkedText[pid] !== t) S.pending.add(pid);
  }, [S]);

  const setCur = useCallback((pid: string | null) => {
    if (pid === S.curPid) return;
    leaveBlock(S.curPid);
    S.curPid = pid;
    S.detector.moveCaret(pid);
    pushMarks();
  }, [S, leaveBlock, pushMarks]);

  /* ---------- typing ---------- */
  const tickRef = useRef<() => void>(() => {});

  function onDocChange(ed: Editor) {
    setDocVersion((n) => n + 1);
    queueMicrotask(() => processImagesRef.current());
    if (S.suppress || !S.pieceId) return;
    const now = Date.now();
    const blocks = topBlocks(ed.state);
    for (const b of blocks) if (b.pid && !S.knownPids.has(b.pid)) { S.knownPids.add(b.pid); S.detector.markBorn(b.pid, now); }
    const len = ed.state.doc.textContent.length;
    const diff = len - S.lastLen;
    S.lastLen = len;
    const cb = caretBlock(ed.state);
    let lastFilled = 0;
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].node.textContent.trim()) { lastFilled = i; break; }
    const r = S.detector.recordEdit({
      now, charsInserted: Math.max(diff, 0), charsDeleted: Math.max(-diff, 0),
      pid: cb?.pid ?? null, blockIndex: cb ? cb.index : blocks.length - 1, lastFilledIndex: lastFilled,
      blockHasText: !!cb?.node.textContent.trim(),
    });
    if (r.revisedPid) {
      S.revs[r.revisedPid] = (S.revs[r.revisedPid] || 0) + 1;
      S.revsDirty.add(r.revisedPid);
      saveMetaSoon();
    }
    if (cb) setCur(cb.pid);
    if (r.revisedPid) pushMarks();
    S.lastInputAt = now;
    setEmpty(!ed.state.doc.textContent.trim() && blocks.length <= 1);
    setWords(wordCount(ed.state.doc.textBetween(0, ed.state.doc.content.size, " ", " ")));
    saveSoon();
    if (S.mode === "paused") tickRef.current();
  }

  function onSelection(ed: Editor) {
    const cb = caretBlock(ed.state);
    if (cb) setCur(cb.pid);
  }

  /* ---------- images ---------- */
  const insertImageFilesRef = useRef<(files: File[], pos?: number) => void>(() => {});
  const processImagesRef = useRef<() => void>(() => {});

  insertImageFilesRef.current = (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed || !S.pieceId || !files.length) return;
    const nodes = files.map((f) => {
      const uploadId = Math.random().toString(36).slice(2);
      S.uploads.set(uploadId, f);
      return { type: "image", attrs: { uploadId } };
    });
    ed.view.dispatch(closeHistory(ed.state.tr));
    if (pos != null) ed.chain().focus().insertContentAt(pos, nodes).run();
    else ed.chain().focus().insertContent(nodes).run();
  };

  processImagesRef.current = () => {
    const ed = editorRef.current, pieceId = S.pieceId;
    if (!ed || ed.isDestroyed || !pieceId) return;
    const jobs: { key: string; run: () => Promise<string>; match: (a: Record<string, any>) => boolean }[] = [];
    let localRefs = 0;
    ed.state.doc.forEach((n) => {
      if (n.type.name !== "image" || n.attrs.src || n.attrs.failed) return;
      const { uploadId, origin } = n.attrs as { uploadId?: string; origin?: string };
      if (uploadId) {
        const file = S.uploads.get(uploadId);
        if (!file || S.imgInflight.has(uploadId)) return;
        jobs.push({ key: uploadId, run: () => uploadImage(pieceId, file), match: (a) => a.uploadId === uploadId });
      } else if (origin && !S.imgInflight.has(origin)) {
        if (/^https?:\/\//i.test(origin)) {
          jobs.push({ key: origin, run: () => importImage(pieceId, origin), match: (a) => !a.src && a.origin === origin });
        } else if (origin.startsWith("data:")) {
          const blob = dataUrlToBlob(origin);
          if (blob) jobs.push({ key: origin, run: () => uploadImage(pieceId, blob), match: (a) => !a.src && a.origin === origin });
          else patchImage(ed, (a) => !a.src && a.origin === origin, { failed: true });
        } else {
          // file:, blob:, cid: references from Word/Docs: use the image files that came with the paste, in order.
          const file = S.pasteFiles[localRefs++];
          if (file) jobs.push({ key: origin, run: () => uploadImage(pieceId, file), match: (a) => !a.src && a.origin === origin });
          else patchImage(ed, (a) => !a.src && a.origin === origin, { failed: true });
        }
      }
    });
    if (localRefs) S.pasteFiles = [];
    for (const j of jobs) {
      S.imgInflight.add(j.key);
      j.run().then(
        (src) => { if (editorRef.current) patchImage(editorRef.current, j.match, { src, origin: null, uploadId: null, failed: null }); saveSoon(); },
        (e) => {
          if (editorRef.current) patchImage(editorRef.current, j.match, { failed: true });
          if ((e as Error)?.message) showToast((e as Error).message);
        },
      ).finally(() => { S.imgInflight.delete(j.key); S.uploads.delete(j.key); });
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- flags ---------- */
  const visibleFlags = useMemo(() => {
    const ed = editorRef.current;
    if (!ed) return flags;
    const pids = new Set(topBlocks(ed.state).map((b) => b.pid));
    return flags.filter((f) => pids.has(f.pid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags, docVersion]);

  const openPanel = useCallback((t?: Tab) => { setPanelOpen(true); if (t) selectTab(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const closePanel = useCallback(() => setPanelOpen(false), []);
  function selectTab(t: Tab) {
    setTab(t); ls("wd:tab", t);
    if (t === "coach") { setUnseen(0); S.unseen = 0; }
  }

  const notifyUnseen = useCallback(() => {
    const showsCoach = S.panelOpen && S.tab === "coach";
    if (S.unseen > 0 && !showsCoach) {
      const n = S.unseen;
      showToast(`${n} new ${n === 1 ? "note" : "notes"} from your editor.`, [{ label: "Open", primary: true, fn: () => openPanel("coach") }]);
    }
  }, [S, showToast, openPanel]);

  const runCoach = useCallback(async (targets: string[], full: boolean) => {
    const ed = editorRef.current, id = S.pieceId;
    if (!ed || !id) return;
    targets = targets.filter((pid) => findBlock(ed.state, pid));
    if (!targets.length) return;
    S.coachBusy = true; setCoachBusy(true); S.lastCoachAt = Date.now();
    const snap: Record<string, string> = {};
    for (const pid of targets) snap[pid] = norm(findBlock(ed.state, pid)!.node.textContent);
    if (full) setCoachMsg("Checking the whole draft…");
    try {
      const r = await api<{ flags: Flag[]; checked: string[] }>("/api/ai/coach", {
        method: "POST", json: { pieceId: id, anchor: S.anchor, blocks: draftBlocks(), targets, full },
      });
      for (const pid of r.checked) { S.checkedText[pid] = snap[pid]; S.pending.delete(pid); }
      const checked = new Set(r.checked);
      const replace = (fs: Flag[]) => fs.filter((f) => !checked.has(f.pid));
      const writingNow = isWritingMode(S.mode);
      if (writingNow && !full) {
        // While writing, only the badge changes; notes appear when you pause.
        setFlags((fs) => replace(fs));
        setHeldFlags((h) => [...replace(h), ...r.flags]);
      } else {
        setFlags((fs) => [...r.flags, ...replace(fs)]);
      }
      if (r.flags.length) {
        S.unseen += r.flags.length; setUnseen(S.unseen);
        if (S.mode === "paused") notifyUnseen();
      }
      setCoachMsg(full ? (r.flags.length ? "" : "Nothing stood out. The draft holds together.") : "");
    } catch (e) {
      for (const pid of targets) S.pending.delete(pid);
      setCoachMsg((e as Error).message);
    } finally {
      S.coachBusy = false; setCoachBusy(false); S.lastCoachAt = Date.now();
    }
  }, [S, draftBlocks, notifyUnseen]);

  /* ---------- loop rescue ---------- */
  const openTakes = useCallback((pid: string | null) => {
    const ed = editorRef.current;
    if (!pid || !ed || !findBlock(ed.state, pid)) { showToast("Put your cursor in a paragraph first."); return; }
    setModal({ kind: "takes", pid });
  }, [showToast]);

  const maybeLoopToast = useCallback(() => {
    const now = Date.now();
    const pid = S.detector.loopPid;
    const ed = editorRef.current;
    if (!pid || !ed || now - S.loopToastAt < 180_000 || now - (S.loopToastByPid[pid] || 0) < 360_000) return;
    if (!findBlock(ed.state, pid)) return;
    S.loopToastAt = now; S.loopToastByPid[pid] = now;
    const rev = S.revs[pid] || 0;
    showToast(rev >= 2 ? `You’ve reworked this paragraph ${rev} times. Your earlier takes are saved.` : "Lots of rewriting without moving forward. Your earlier takes are saved.",
      [{ label: "See earlier takes", primary: true, fn: () => openTakes(pid) }, { label: "Keep going", fn: () => {} }]);
  }, [S, showToast, openTakes]);

  /* ---------- the 2-second tick ---------- */
  const tick = useCallback(() => {
    const ed = editorRef.current;
    if (!S.pieceId || !ed) return;
    const now = Date.now();
    const m = S.detector.compute(now, (pid) => !!findBlock(ed.state, pid));
    if (m !== S.mode) {
      const prev = S.mode;
      S.mode = m; setModeState(m);
      const w = docWordCount(currentDoc());
      const label = flowVersionLabel(prev, m, w, S.lastSnap.words);
      if (label) snapshot("flow", label);
      if (m === "looping") maybeLoopToast();
      if (!isWritingMode(m) && S.heldFlags.length) {
        const held = S.heldFlags;
        setFlags((fs) => [...held, ...fs.filter((f) => !held.some((h) => h.pid === f.pid))]);
        setHeldFlags([]); S.heldFlags = [];
      }
      if (m === "paused" || m === "revising") notifyUnseen();
    }
    if (autosaveDue(now, S.lastInputAt, S.lastSnap.at, m)) snapshot("auto");
    if (S.coaching && !S.coachBusy && S.pending.size && now - S.lastCoachAt >= COACH_CONFIG.minIntervalMs && m !== "looping") {
      runCoach([...S.pending].slice(0, COACH_CONFIG.maxTargets), false);
    }
  }, [S, currentDoc, snapshot, maybeLoopToast, notifyUnseen, runCoach]);
  tickRef.current = tick;

  useEffect(() => {
    const t = setInterval(() => tickRef.current(), 2000);
    return () => clearInterval(t);
  }, []);

  /* ---------- opening pieces ---------- */
  const openPiece = useCallback(async (id: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (S.saveTimer) await saveNow();
    setSaveState({ s: "idle", msg: "Opening…" });
    ed.setEditable(false);
    let data: OpenPiece;
    try { data = await api<OpenPiece>(`/api/pieces/${id}`); }
    catch (e) { showToast((e as Error).message || "That piece couldn’t be opened. Try again."); setSaveState({ s: "idle", msg: "" }); return; }
    const p = data.piece;
    S.pieceId = p.id; setPieceId(p.id); ls("wd:last", p.id);
    S.title = p.title; setTitle(p.title);
    const a = { point: p.anchor_point, sections: p.anchor_sections, notThis: p.anchor_not_this };
    S.anchor = a; setAnchor(a);
    const vs = data.versions.map((v) => ({ ...v, content: sanitizeDoc(v.content) }));
    S.versions = vs; setVersions(vs);
    setParked(data.parked); setNotes(data.notes || []); setFlags(data.flags); setHeldFlags([]);
    S.revs = { ...data.meta }; S.revsDirty.clear();
    S.detector.reset(); S.mode = "paused"; setModeState("paused");
    S.pending.clear(); S.unseen = 0; setUnseen(0); S.curPid = null;
    setAskTurns([]);
    S.suppress = true;
    ed.commands.setContent(p.content, { emitUpdate: false });
    S.suppress = false;
    const doc = currentDoc();
    S.knownPids = new Set(doc.content.map((b) => b.attrs.pid));
    S.checkedText = {};
    for (const b of doc.content) S.checkedText[b.attrs.pid] = norm(blockText(b));
    S.lastLen = ed.state.doc.textContent.length;
    const v0 = vs[0];
    const text = plainText(doc);
    S.lastSnap = v0 ? { words: v0.word_count, at: new Date(v0.created_at).getTime(), text: v0.plain_text } : { words: docWordCount(doc), at: Date.now(), text: "" };
    setWords(docWordCount(doc));
    setEmpty(!text.trim());
    pushMarks();
    ed.setEditable(true);
    ed.commands.focus("end");
    queueMicrotask(() => processImagesRef.current());
    setSaveState({ s: "saved" });
    setDocVersion((n) => n + 1);
  }, [S, saveNow, showToast, currentDoc, pushMarks]);

  const newPiece = useCallback(async () => {
    try {
      if (S.saveTimer) await saveNow();
      const r = await api<{ piece: PieceSummary }>("/api/pieces", { method: "POST" });
      setPieces((ps) => [r.piece, ...ps]);
      await openPiece(r.piece.id);
      openPanel("anchor");
    } catch (e) { showToast((e as Error).message); }
  }, [S, saveNow, openPiece, openPanel, showToast]);

  // Startup
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    (async () => {
      if (window.innerWidth <= 860) setPanelOpen(false);
      const t = (ls("wd:tab") as Tab) || "coach";
      setTab(t);
      setCoaching(ls("wd:coach") === "1");
      const th = (ls("wd:theme") as "light" | "dark" | null) || "system";
      setTheme(th);
      if (!ls("wd:guided")) setModal({ kind: "guide" });
      try {
        const { pieces: list } = await api<{ pieces: PieceSummary[] }>("/api/pieces");
        if (cancelled) return;
        setPieces(list);
        const last = ls("wd:last");
        const pick = list.find((p) => p.id === last) || list[0];
        if (pick) await openPiece(pick.id);
        else await newPiece();
      } catch (e) {
        showToast((e as Error).message || "Couldn’t reach your saved pieces.");
        setSaveState({ s: "error", msg: "Couldn’t reach your pieces" });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Save on tab hide
  useEffect(() => {
    const v = () => { if (document.visibilityState === "hidden" && S.saveTimer) saveNow(true); };
    document.addEventListener("visibilitychange", v);
    return () => document.removeEventListener("visibilitychange", v);
  }, [S, saveNow]);

  // Theme
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme);
  }, [theme]);

  // Mode on body (drives the paper bar color and toolbar fade)
  useEffect(() => { document.body.dataset.mode = mode; }, [mode]);

  /* ---------- editing actions ---------- */
  const jumpTo = useCallback((pid: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const b = findBlock(ed.state, pid);
    if (!b) return;
    const dom = ed.view.nodeDOM(b.pos) as HTMLElement | null;
    dom?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setMarks(ed, { flash: pid });
    setTimeout(() => { if (!ed.isDestroyed) setMarks(ed, { flash: null }); }, 1600);
    ed.commands.setTextSelection(b.pos + b.node.nodeSize - 1);
    if (window.innerWidth <= 860) closePanel();
  }, [closePanel]);

  const addParked = useCallback(async (text: string): Promise<ParkedItem | null> => {
    if (!norm(text) || !S.pieceId) return null;
    try {
      const r = await api<{ item: ParkedItem }>(`/api/pieces/${S.pieceId}/parked`, { method: "POST", json: { text: text.trim() } });
      setParked((p) => [r.item, ...p]);
      return r.item;
    } catch (e) { showToast((e as Error).message); return null; }
  }, [S, showToast]);

  const deleteParked = useCallback(async (itemId: string) => {
    setParked((p) => p.filter((x) => x.id !== itemId));
    if (S.pieceId) api(`/api/pieces/${S.pieceId}/parked/${itemId}`, { method: "DELETE" }).catch(() => showToast("That item couldn’t be deleted."));
  }, [S, showToast]);

  const parkUndoToast = useCallback((item: ParkedItem | null) => {
    showToast("Moved to Parked.", [{ label: "Undo", fn: () => { editorRef.current?.chain().focus().undo().run(); if (item) deleteParked(item.id); } }]);
  }, [showToast, deleteParked]);

  const parkBlock = useCallback(async (pid: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const b = findBlock(ed.state, pid);
    const isImg = b?.node.type.name === "image";
    if (!b || (!isImg && !b.node.textContent.trim())) return;
    if (isImg && !b.node.attrs.src) { showToast("Wait for the image to finish copying first."); return; }
    const text = isImg ? blockText(sanitizeDoc({ type: "doc", content: [b.node.toJSON()] }).content[0]) : b.node.textBetween(0, b.node.content.size, "\n");
    const only = ed.state.doc.childCount === 1;
    ed.chain().focus().command(({ tr, state }) => {
      closeHistory(tr); // its own undo step, so Undo brings back just this paragraph
      if (only) tr.replaceWith(b.pos, b.pos + b.node.nodeSize, state.schema.nodes.paragraph.create());
      else tr.delete(b.pos, b.pos + b.node.nodeSize);
      return true;
    }).run();
    parkUndoToast(await addParked(text));
  }, [addParked, parkUndoToast, showToast]);

  const park = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !S.pieceId) return;
    const sel = ed.state.selection as any;
    const { from, to, empty } = sel;
    if (sel.node && sel.node.type.name === "image") { parkBlock(sel.node.attrs.pid); return; }
    if (!empty) {
      // Keep images and bold/italic: park the selection as Markdown.
      const slice = ed.state.doc.slice(from, to).content.toJSON() || [];
      const text = docToMarkdown(sanitizeDoc({ type: "doc", content: slice })).trim() || ed.state.doc.textBetween(from, to, "\n\n", "\n");
      ed.chain().focus().command(({ tr }) => { closeHistory(tr); tr.deleteSelection(); return true; }).run();
      parkUndoToast(await addParked(text));
    } else {
      const cb = caretBlock(ed.state);
      if (cb && (cb.node.type.name === "image" || cb.node.textContent.trim())) parkBlock(cb.pid);
      else showToast("Select some text or put your cursor in a paragraph.");
    }
  }, [S, addParked, parkBlock, parkUndoToast, showToast]);

  const insertMarkdown = useCallback((text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const cb = (S.curPid && findBlock(ed.state, S.curPid)) || null;
    const pos = cb ? cb.pos + cb.node.nodeSize : ed.state.doc.content.size;
    // Parked text may hold image lines (![caption](/api/images/...)), so read it as Markdown.
    const paras = markdownToDoc(text).content.map((b) => ({ ...b, attrs: { ...b.attrs, pid: null } }));
    ed.view.dispatch(closeHistory(ed.state.tr));
    ed.chain().focus().insertContentAt(pos, paras).run();
    const after = topBlocks(ed.state).find((b) => b.pos >= pos);
    if (after) jumpTo(after.pid);
  }, [S, jumpTo]);
  const insertParked = useCallback((it: ParkedItem) => insertMarkdown(it.text), [insertMarkdown]);

  /* ---------- notes ---------- */
  const addNote = useCallback(async (text: string, image_src?: string): Promise<boolean> => {
    if (!S.pieceId) return false;
    try {
      const r = await api<{ note: Note }>(`/api/pieces/${S.pieceId}/notes`, { method: "POST", json: { text, image_src } });
      setNotes((n) => [r.note, ...n]);
      return true;
    } catch (e) { showToast((e as Error).message); return false; }
  }, [S, showToast]);

  const addImageNotes = useCallback(async (files: File[], text: string): Promise<boolean> => {
    if (!S.pieceId) return false;
    let ok = true;
    for (const [i, f] of files.entries()) {
      try { ok = (await addNote(i === 0 ? text : "", await uploadImage(S.pieceId, f))) && ok; }
      catch (e) { showToast((e as Error).message); ok = false; }
    }
    return ok;
  }, [S, addNote, showToast]);

  const updateNote = useCallback(async (id: string, text: string): Promise<boolean> => {
    if (!S.pieceId) return false;
    try {
      const r = await api<{ note: Note }>(`/api/pieces/${S.pieceId}/notes/${id}`, { method: "PATCH", json: { text } });
      setNotes((ns) => ns.map((n) => (n.id === id ? r.note : n)));
      return true;
    } catch (e) { showToast((e as Error).message); return false; }
  }, [S, showToast]);

  const deleteNote = useCallback((id: string) => {
    const removed = notes.find((n) => n.id === id);
    setNotes((ns) => ns.filter((n) => n.id !== id));
    if (S.pieceId) api(`/api/pieces/${S.pieceId}/notes/${id}`, { method: "DELETE" }).catch(() => {
      showToast("That note couldn’t be deleted.");
      if (removed) setNotes((ns) => [removed, ...ns]);
    });
  }, [S, notes, showToast]);

  const insertNote = useCallback((n: Note) => {
    insertMarkdown([n.text.trim(), n.image_src ? `![](${n.image_src})` : ""].filter(Boolean).join("\n\n"));
  }, [insertMarkdown]);

  /** Replace the whole document (restore, stitch). Not counted as typing. */
  const replaceDoc = useCallback((doc: DocJSON) => {
    const ed = editorRef.current;
    if (!ed) return;
    S.suppress = true;
    ed.commands.setContent(doc, { emitUpdate: true });
    S.suppress = false;
    const d = currentDoc();
    for (const b of d.content) { S.knownPids.add(b.attrs.pid); S.checkedText[b.attrs.pid] = norm(blockText(b)); }
    S.lastLen = ed.state.doc.textContent.length;
    S.curPid = null;
    pushMarks();
    setWords(docWordCount(d));
    setEmpty(!plainText(d).trim());
    saveSoon();
  }, [S, currentDoc, pushMarks, saveSoon]);

  /** Replace one paragraph's content, keeping its pid. */
  const replaceBlock = useCallback((pid: string, node: BlockNode) => {
    const ed = editorRef.current;
    if (!ed) return false;
    const b = findBlock(ed.state, pid);
    if (!b) return false;
    const pmNode = ed.state.schema.nodeFromJSON({ ...node, attrs: { ...node.attrs, pid } });
    ed.chain().focus().command(({ tr }) => { closeHistory(tr); tr.replaceWith(b.pos, b.pos + b.node.nodeSize, pmNode); return true; }).run();
    return true;
  }, []);

  const bringBack = useCallback((v: Version, pid: string) => {
    const ed = editorRef.current;
    if (!ed || findBlock(ed.state, pid)) return;
    const node = blocksOf(v.content).get(pid)?.node;
    if (!node) return;
    const order = v.content.content.map((b) => b.attrs.pid);
    let pos = 0;
    for (let j = order.indexOf(pid) - 1; j >= 0; j--) {
      const prev = findBlock(ed.state, order[j]);
      if (prev) { pos = prev.pos + prev.node.nodeSize; break; }
    }
    ed.view.dispatch(closeHistory(ed.state.tr));
    ed.chain().focus().insertContentAt(pos, node).run();
  }, []);

  const restore = useCallback(async (v: Version) => {
    await snapshot("safety", "Before restoring an older version");
    replaceDoc(v.content);
    setModal(null);
    showToast("Restored. Your draft from just before is saved in Versions.");
  }, [snapshot, replaceDoc, showToast]);

  const deleteVersion = useCallback(async (v: Version) => {
    if (!confirm("Delete this version?")) return;
    setVersions((vs) => vs.filter((x) => x.id !== v.id));
    setModal(null);
    if (S.pieceId) api(`/api/pieces/${S.pieceId}/versions/${v.id}`, { method: "DELETE" }).catch(() => showToast("That version couldn’t be deleted."));
  }, [S, showToast]);

  const dismissFlag = useCallback((f: Flag) => {
    setFlags((fs) => fs.filter((x) => x.id !== f.id));
    if (S.pieceId) api(`/api/pieces/${S.pieceId}/flags/${f.id}`, { method: "PATCH" }).catch(() => {});
  }, [S]);

  const exportMd = useCallback((how: "download" | "copy") => {
    const md = docToMarkdown(currentDoc(), S.title || undefined, window.location.origin);
    if (how === "copy") {
      navigator.clipboard?.writeText(md).then(() => showToast("Copied as Markdown."), () => showToast("Couldn’t copy."));
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    a.download = (S.title || "draft").replace(/[\\/:*?"<>|]/g, "").slice(0, 80).trim() + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [S, currentDoc, showToast]);

  const saveVersionNow = useCallback(async () => {
    const v = await snapshot("manual");
    showToast(v ? "Version saved." : "No changes since the last version.");
  }, [snapshot, showToast]);

  const deletePiece = useCallback(async () => {
    if (!S.pieceId || !confirm("Delete this piece and all its versions? This can’t be undone.")) return;
    const id = S.pieceId;
    try {
      if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
      await api(`/api/pieces/${id}`, { method: "DELETE" });
      S.pieceId = null;
      const rest = pieces.filter((p) => p.id !== id);
      setPieces(rest);
      if (rest[0]) await openPiece(rest[0].id); else await newPiece();
    } catch (e) { showToast((e as Error).message); }
  }, [S, pieces, openPiece, newPiece, showToast]);

  /* ---------- keys ---------- */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyP") { e.preventDefault(); park(); }
      if (e.altKey && e.code === "KeyN") { e.preventDefault(); openPanel("notes"); setTimeout(() => notesInputRef.current?.focus(), 0); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveVersionNow(); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [park, saveVersionNow, openPanel]);

  /* ---------- anchor + title ---------- */
  const updateAnchor = useCallback((patch: Partial<Anchor>) => {
    S.anchor = { ...S.anchor, ...patch };
    setAnchor(S.anchor);
    saveSoon();
  }, [S, saveSoon]);

  const updateTitle = useCallback((t: string) => {
    S.title = t; setTitle(t);
    setPieces((ps) => ps.map((p) => (p.id === S.pieceId ? { ...p, title: t } : p)));
    saveSoon();
  }, [S, saveSoon]);

  const toggleCoaching = useCallback((on: boolean) => { setCoaching(on); ls("wd:coach", on ? "1" : "0"); if (on) setCoachMsg(""); }, []);

  const checkAll = useCallback(() => {
    if (S.coachBusy) return;
    const ids = draftBlocks().filter((b) => !b.heading && wordCount(b.text) >= 20).map((b) => b.pid);
    if (!ids.length) { setCoachMsg("Write a few paragraphs first."); return; }
    runCoach(ids.slice(0, 60), true);
  }, [S, draftBlocks, runCoach]);

  const explainFlag = useCallback(async (f: Flag): Promise<string> => {
    const ed = editorRef.current;
    const text = (pid: string | null) => (pid && ed ? findBlock(ed.state, pid)?.node.textContent ?? null : null);
    const r = await api<{ text: string }>("/api/ai/explain", {
      method: "POST", json: { type: f.type, note: f.note, paragraph: text(f.pid) || "", other: text(f.other_pid), anchor: S.anchor },
    });
    return r.text;
  }, [S]);

  /* ---------- ask ---------- */
  const askRef = useRef<AbortController | null>(null);
  const notesRef = useRef<Note[]>([]);
  notesRef.current = notes;
  const [askBusy, setAskBusy] = useState(false);
  const sendAsk = useCallback(async (q: string) => {
    if (askRef.current) return;
    const history = [...askTurns.filter((t) => !t.error), { role: "user" as const, content: q }];
    setAskTurns((t) => [...t, { role: "user", content: q }, { role: "assistant", content: "", citations: [], status: "Thinking…" }]);
    const ctl = new AbortController(); askRef.current = ctl; setAskBusy(true);
    let out = "";
    const patchLast = (p: Partial<AskTurn>) => setAskTurns((t) => { const c = [...t]; c[c.length - 1] = { ...c[c.length - 1], ...p }; return c; });
    try {
      await streamApi("/api/ai/ask", { anchor: S.anchor, draft: draftText().slice(0, 120_000), notes: notesRef.current.map((n) => [n.text, n.image_src ? "(image)" : ""].filter(Boolean).join(" ")).filter(Boolean).slice(0, 300), turns: history.slice(-12).map(({ role, content }) => ({ role, content })) }, (e) => {
        if (e.type === "text") { out += e.text; patchLast({ content: out, status: undefined }); }
        else if (e.type === "citation") setAskTurns((t) => { const c = [...t]; const last = c[c.length - 1]; c[c.length - 1] = { ...last, citations: [...(last.citations || []), { url: e.url, title: e.title }] }; return c; });
        else if (e.type === "status") patchLast({ status: e.text });
        else if (e.type === "error") patchLast({ content: out || e.message, error: !out, status: undefined });
        else if (e.type === "done") patchLast({ status: undefined });
      }, ctl.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") patchLast({ content: out || "Stopped.", status: undefined, error: !out });
      else patchLast({ content: (e as Error).message, error: true, status: undefined });
    } finally {
      askRef.current = null; setAskBusy(false);
    }
  }, [S, askTurns, draftText]);

  /* ---------- render ---------- */
  const badge = unseen > 0 ? String(unseen) : "";
  const curPid = S.curPid;
  const saveText = saveState.s === "saving" ? "Saving…" : saveState.s === "saved" ? "Saved" : saveState.msg || "";

  return (
    <div className="layout-root">
      <header className="bar">
        <div className="bar-group bar-left">
          <select id="docPick" aria-label="Your pieces" value={pieceId || ""} onChange={(e) => { if (e.target.value !== pieceId) openPiece(e.target.value); }}>
            {pieces.map((p) => <option key={p.id} value={p.id}>{p.title || "Untitled piece"}</option>)}
          </select>
          <button className="btn small" onClick={newPiece}>New piece</button>
          <input id="title" placeholder="Untitled piece" aria-label="Title" value={title}
            onChange={(e) => updateTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); editor?.commands.focus(); } }} />
        </div>
        <div className="bar-group fmt" role="toolbar" aria-label="Formatting">
          <button className="btn ghost" title="Bold (Ctrl+B)" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
          <button className="btn ghost" title="Italic (Ctrl+I)" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
          <button className="btn ghost" title="Heading" onMouseDown={(e) => e.preventDefault()} onClick={() => editor && toggleBlock(editor, "heading")}>H</button>
          <button className="btn ghost" title="Quote" onMouseDown={(e) => e.preventDefault()} onClick={() => editor && toggleBlock(editor, "blockquote")}>“ ”</button>
          <button className="btn ghost" title="Move selection or paragraph to Parked (Alt+P)" onMouseDown={(e) => e.preventDefault()} onClick={park}>Park</button>
          <button className="btn ghost" title="Add an image (or paste / drag one in)" onMouseDown={(e) => e.preventDefault()} onClick={() => fileInputRef.current?.click()}>Image</button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { const f = imageFiles(e.target.files); e.target.value = ""; insertImageFilesRef.current(f); }} />
        </div>
        <div className="bar-group">
          <span className="mode" data-mode={mode} title={MODE_TIP[mode]}><span className="dot" /><span>{MODE_LABEL[mode]}</span></span>
          <span className="meta hide-sm">{words} words</span>
          <span className="meta hide-sm" style={saveState.s === "error" ? { color: "var(--loop)" } : undefined}>{saveText}</span>
          <button className="btn small" aria-expanded={panelOpen} aria-controls="panel" onClick={() => setPanelOpen((o) => !o)}>Panel<span className="badge">{badge}</span></button>
          <div className="menu">
            <button className="btn ghost small" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} title="More">⋯</button>
            {menuOpen && (
              <div className="menu-pop" role="menu" onClick={() => setMenuOpen(false)}>
                <div className="who">{email}</div>
                <button className="btn small" role="menuitem" onClick={() => exportMd("download")}>Export .md</button>
                <button className="btn small" role="menuitem" onClick={() => exportMd("copy")}>Copy as Markdown</button>
                <button className="btn small" role="menuitem" onClick={() => { const n = theme === "system" ? "light" : theme === "light" ? "dark" : "system"; setTheme(n); ls("wd:theme", n); }}>
                  Theme: {theme === "system" ? "Match system" : theme === "light" ? "Light" : "Dark"}
                </button>
                <button className="btn small" role="menuitem" onClick={() => setModal({ kind: "guide" })}>How this works</button>
                {isAdmin && <a className="btn small" role="menuitem" href="/admin">Admin</a>}
                <button className="btn small" role="menuitem" onClick={deletePiece}>Delete this piece</button>
                <form action="/auth/signout" method="post"><button className="btn small" role="menuitem" type="submit" style={{ width: "100%" }}>Sign out</button></form>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="layout">
        <div className="desk" onClick={(e) => { if (e.target === e.currentTarget) editor?.commands.focus("end"); }}>
          <article className="page">
            {empty && <div className="ph">Start writing. I’ll keep quiet while you’re in flow and save each run as a version.</div>}
            <EditorContent editor={editor} className="editor" />
          </article>
        </div>

        {panelOpen && (
          <aside className="panel" id="panel">
            <nav className="tabs" role="tablist">
              {(["coach", "notes", "versions", "parked", "anchor", "ask"] as Tab[]).map((t) => (
                <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => selectTab(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </nav>
            {tab === "coach" && (
              <CoachPane
                anchor={anchor} coaching={coaching} coachMsg={coachMsg} busy={coachBusy}
                flags={visibleFlags} paragraphText={(pid) => (editor ? findBlock(editor.state, pid)?.node.textContent ?? "" : "")}
                hasBlock={(pid) => !!(pid && editor && findBlock(editor.state, pid))}
                onSetAnchor={() => selectTab("anchor")} onToggle={toggleCoaching} onCheckAll={checkAll}
                onTakes={() => openTakes(curPid || (editor ? caretBlock(editor.state)?.pid ?? null : null))}
                onJump={jumpTo} onPark={(f) => { parkBlock(f.pid); dismissFlag(f); }} onDismiss={dismissFlag} onExplain={explainFlag}
              />
            )}
            {tab === "notes" && (
              <NotesPane notes={notes} inputRef={notesInputRef} onAdd={(t) => addNote(t)} onAddImages={addImageNotes}
                onUpdate={updateNote} onDelete={deleteNote} onInsert={insertNote}
                onCopy={(t) => navigator.clipboard?.writeText(t).then(() => showToast("Copied."), () => {})} />
            )}
            {tab === "versions" && (
              <VersionsPane versions={versions} onOpen={(v) => setModal({ kind: "version", v })} onSave={saveVersionNow}
                onStitch={() => { if (docWordCount(currentDoc()) < 50) showToast("Write a bit more before stitching."); else setModal({ kind: "stitch" }); }}
                onExport={() => exportMd("download")} onCopy={() => exportMd("copy")} />
            )}
            {tab === "parked" && (
              <ParkedPane items={parked} onInsert={insertParked} onDelete={deleteParked}
                onCopy={(t) => navigator.clipboard?.writeText(t).then(() => showToast("Copied."), () => {})} />
            )}
            {tab === "anchor" && <AnchorPane anchor={anchor} onChange={updateAnchor} />}
            {tab === "ask" && (
              <AskPane turns={askTurns} busy={askBusy} onSend={sendAsk} onStop={() => askRef.current?.abort()} onClear={() => setAskTurns([])} />
            )}
          </aside>
        )}
      </main>

      <Toast toast={toast} onClose={closeToast} />

      {modal?.kind === "version" && (
        <VersionModal v={modal.v} onClose={() => setModal(null)} onDelete={() => deleteVersion(modal.v)}
          onCompare={() => setModal({ kind: "compare", v: modal.v })} onRestore={() => restore(modal.v)} />
      )}
      {modal?.kind === "compare" && (
        <CompareModal v={modal.v} now={currentDoc()} onClose={() => setModal(null)}
          onBringBack={(pid) => bringBack(modal.v, pid)} onPark={(t) => addParked(t)}
          onUseEarlier={async (pid, node) => { await snapshot("safety", "Before using earlier wording"); return replaceBlock(pid, node); }} />
      )}
      {modal?.kind === "takes" && editor && (
        <TakesModal pid={modal.pid} current={blocksOf(currentDoc()).get(modal.pid)} versions={versions} point={anchor.point}
          onClose={() => setModal(null)}
          onUse={async (node) => {
            await snapshot("safety", "Before using an earlier take");
            replaceBlock(modal.pid, node);
            setModal(null);
            showToast("Swapped in the earlier take. The one you replaced is saved.");
          }} />
      )}
      {modal?.kind === "stitch" && pieceId && (
        <StitchModal pieceId={pieceId} draft={draftText()} anchor={anchor} onClose={() => setModal(null)}
          onCopied={() => showToast("Copied.")}
          onReplace={async (doc) => {
            await snapshot("safety", "Before stitching");
            replaceDoc(doc);
            await snapshot("stitch", "Stitched draft");
            setModal(null);
            showToast("Stitched draft is in place. Everything before it is in Versions.");
          }} />
      )}
      {modal?.kind === "guide" && <GuideModal onClose={() => { ls("wd:guided", "1"); setModal(null); }} />}
    </div>
  );
}
