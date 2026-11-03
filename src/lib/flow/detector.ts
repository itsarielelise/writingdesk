// Flow and loop detection. Pure and deterministic: callers pass `now`.
// Ported from the prototype's computeMode / onInput logic.

export type Mode = "paused" | "writing" | "flow" | "revising" | "looping";

export const FLOW_CONFIG = {
  /** No input for this long → Paused. */
  pausedAfterMs: 20_000,
  /** Window for flow / writing / revising. */
  windowMs: 90_000,
  flowMinInserted: 50,
  flowMaxDeleteRatio: 0.4,
  writingMaxDeleteRatio: 0.6,
  minTailRatio: 0.7,
  /** Looping (a): the same finished paragraph reopened this many times within loopWindowMs. */
  loopWindowMs: 240_000,
  loopReopenCount: 4,
  /** Looping (b): churn over loopWindowMs. */
  churnMinDeleted: 150,
  churnMaxNetGrowth: 40,
  /** Guards so a burst of early edits can't look like churn. */
  churnMinEvents: 30,
  churnMinSpanMs: 150_000,
  /** A new editing session in a paragraph starts after this much idle time in it. */
  sessionGapMs: 8_000,
  /** Paragraphs younger than this don't count as revised. */
  youngParagraphMs: 180_000,
  /** How long to keep events at all. */
  retainMs: 300_000,
  /** rev_count at which a paragraph is marked "reworked". */
  reworkedAt: 3,
};
export type FlowConfig = typeof FLOW_CONFIG;

export interface EditEvent { time: number; charsInserted: number; charsDeleted: number; atTail: boolean }
export interface Reopen { pid: string; time: number }

export interface EditInput {
  now: number;
  charsInserted: number;
  charsDeleted: number;
  /** Caret block's pid (null if none). */
  pid: string | null;
  /** Index of the caret block among top-level blocks. */
  blockIndex: number;
  /** Index of the last non-empty block. */
  lastFilledIndex: number;
  /** Whether the caret block has text. */
  blockHasText: boolean;
}

export interface EditResult {
  atTail: boolean;
  /** Set when this edit started a revision session in a finished paragraph. */
  revisedPid: string | null;
}

export class FlowDetector {
  events: EditEvent[] = [];
  reopens: Reopen[] = [];
  bornAt = new Map<string, number>();
  private lastPid: string | null = null;
  private lastEditAt = 0;
  loopPid: string | null = null;
  /** The pid the caret was in most recently (for churn loops). */
  curPid: string | null = null;

  constructor(public cfg: FlowConfig = FLOW_CONFIG) {}

  /** Paragraphs created during this session; pids loaded from storage are "old". */
  markBorn(pid: string, now: number) { if (!this.bornAt.has(pid)) this.bornAt.set(pid, now); }

  /** Caret moved into a different paragraph without typing. */
  moveCaret(pid: string | null) { this.curPid = pid; }

  recordEdit(e: EditInput): EditResult {
    const atTail = isTail(e.blockIndex, e.lastFilledIndex);
    this.events.push({ time: e.now, charsInserted: Math.max(0, e.charsInserted), charsDeleted: Math.max(0, e.charsDeleted), atTail });
    let revisedPid: string | null = null;
    if (e.pid) {
      const newSession = e.pid !== this.lastPid || e.now - this.lastEditAt > this.cfg.sessionGapMs;
      if (newSession) {
        const born = this.bornAt.get(e.pid);
        const young = born !== undefined && e.now - born < this.cfg.youngParagraphMs;
        if (!atTail && !young && e.blockHasText) {
          revisedPid = e.pid;
          this.reopens.push({ pid: e.pid, time: e.now });
        }
      }
      this.lastPid = e.pid;
      this.lastEditAt = e.now;
      this.curPid = e.pid;
    }
    return { atTail, revisedPid };
  }

  compute(now: number, pidExists: (pid: string) => boolean = () => true): Mode {
    this.events = this.events.filter((e) => now - e.time < this.cfg.retainMs);
    this.reopens = this.reopens.filter((r) => now - r.time < this.cfg.retainMs);
    const r = computeMode({ events: this.events, reopens: this.reopens, now, cfg: this.cfg, pidExists, curPid: this.curPid });
    if (r.loopPid !== undefined) this.loopPid = r.loopPid;
    return r.mode;
  }

  reset() {
    this.events = []; this.reopens = []; this.bornAt.clear();
    this.lastPid = null; this.lastEditAt = 0; this.loopPid = null; this.curPid = null;
  }
}

/** `atTail`: the caret is in the last or second-to-last non-empty block (or after them). */
export const isTail = (blockIndex: number, lastFilledIndex: number) => blockIndex >= Math.max(0, lastFilledIndex - 1);

export function computeMode(args: {
  events: EditEvent[];
  reopens: Reopen[];
  now: number;
  cfg?: FlowConfig;
  pidExists?: (pid: string) => boolean;
  curPid?: string | null;
}): { mode: Mode; loopPid?: string | null } {
  const { events, reopens, now } = args;
  const cfg = args.cfg ?? FLOW_CONFIG;
  const pidExists = args.pidExists ?? (() => true);
  const last = events.length ? events[events.length - 1].time : 0;
  if (!last || now - last > cfg.pausedAfterMs) return { mode: "paused" };

  // Looping (a): the same finished paragraph reopened again and again.
  const counts = new Map<string, number>();
  for (const r of reopens) if (now - r.time < cfg.loopWindowMs) counts.set(r.pid, (counts.get(r.pid) || 0) + 1);
  for (const [pid, n] of counts) if (n >= cfg.loopReopenCount && pidExists(pid)) return { mode: "looping", loopPid: pid };

  // Looping (b): lots of churn with no net progress.
  const w4 = events.filter((e) => now - e.time < cfg.loopWindowMs);
  if (w4.length > cfg.churnMinEvents && now - w4[0].time > cfg.churnMinSpanMs) {
    let i4 = 0, d4 = 0;
    for (const e of w4) { i4 += e.charsInserted; d4 += e.charsDeleted; }
    if (d4 > cfg.churnMinDeleted && i4 - d4 <= cfg.churnMaxNetGrowth) return { mode: "looping", loopPid: args.curPid ?? null };
  }

  const w = events.filter((e) => now - e.time < cfg.windowMs);
  let ins = 0, del = 0, tails = 0;
  for (const e of w) { ins += e.charsInserted; del += e.charsDeleted; if (e.atTail) tails++; }
  const tailRatio = w.length ? tails / w.length : 0;
  if (ins >= cfg.flowMinInserted && del <= ins * cfg.flowMaxDeleteRatio && tailRatio >= cfg.minTailRatio) return { mode: "flow" };
  if (tailRatio >= cfg.minTailRatio && del <= ins * cfg.writingMaxDeleteRatio) return { mode: "writing" };
  return { mode: "revising" };
}

export const MODE_LABEL: Record<Mode, string> = { paused: "Paused", writing: "Writing", flow: "In flow", revising: "Revising", looping: "Looping?" };
export const MODE_TIP: Record<Mode, string> = {
  paused: "Not typing right now.",
  writing: "Moving forward at the end of the draft.",
  flow: "Steady forward writing. Notes will wait.",
  revising: "Editing earlier parts of the draft.",
  looping: "Reworking the same ground. Your earlier takes are saved.",
};

export const isWritingMode = (m: Mode) => m === "flow" || m === "writing";
