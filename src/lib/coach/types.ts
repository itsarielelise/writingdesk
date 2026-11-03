export type FlagType = "repeat" | "drift" | "order";

export interface Anchor { point: string; sections: string; notThis: string }
export interface DraftBlock { pid: string; text: string; heading?: boolean }

export interface CoachInput {
  anchor: Anchor;
  /** The whole draft, in order. */
  blocks: DraftBlock[];
  /** Pids to check. */
  targets: string[];
}

export interface CoachFlag {
  pid: string;
  type: FlagType;
  otherPid: string | null;
  targetSection: string | null;
  confidence: number;
  note: string;
}

export interface CoachUsage { provider: "anthropic" | "typesafe"; inputTokens: number | null; outputTokens: number | null }

export interface CoachResult {
  flags: CoachFlag[];
  usage: CoachUsage[];
  /** Which pids were actually checked (so the client can mark them done). */
  checked: string[];
}

export interface CoachProvider {
  readonly name: "jev" | "claude";
  check(input: CoachInput, opts?: { signal?: AbortSignal }): Promise<CoachResult>;
}

export const COACH_CONFIG = {
  repeatMinConfidence: 0.8,
  driftMinConfidence: 0.75,
  orderMinConfidence: 0.8,
  /** Score index of "Supports the point indirectly"; anything below drifts. */
  driftBelowScore: 2,
  /** Paragraphs must have at least this many words to be checked in the background. */
  minWords: 30,
  /** At most one background check per user this often. */
  minIntervalMs: 20_000,
  /** Max targets per background batch. */
  maxTargets: 12,
  /** Jev per-request budget for the serialized state, in characters. */
  jevMaxStateChars: Number(process.env.JEV_MAX_STATE_CHARS || 60_000),
};

export const hasAnchor = (a: Anchor) => !!(a.point || "").trim();
export const sectionsOf = (a: Anchor) => (a.sections || "").split("\n").map((s) => s.trim()).filter(Boolean);
