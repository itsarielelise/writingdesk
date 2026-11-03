import { isWritingMode, type Mode } from "../flow/detector";

export type VersionKind = "flow" | "auto" | "manual" | "safety" | "stitch";

export const VERSION_CONFIG = {
  flowMinWordsAdded: 15,
  autosaveEveryMs: 5 * 60_000,
  keepAutosaves: 15,
  pieceSaveDebounceMs: 1200,
};

export const KIND_LABEL: Record<VersionKind, string> = {
  flow: "Flow", auto: "Autosave", manual: "Saved by you", safety: "Before a change", stitch: "Stitched",
};

/** A flow version saves when the state leaves Writing/In flow after enough new words. */
export function flowVersionLabel(prev: Mode, next: Mode, wordsNow: number, wordsAtLastVersion: number, cfg = VERSION_CONFIG): string | null {
  if (!isWritingMode(prev) || isWritingMode(next)) return null;
  const added = wordsNow - wordsAtLastVersion;
  if (added < cfg.flowMinWordsAdded) return null;
  return `${prev === "flow" ? "In flow" : "Writing"} · +${added} words`;
}

/** An autosave version is due every 5 minutes of changes, never while in flow. */
export function autosaveDue(now: number, lastInputAt: number, lastVersionAt: number, mode: Mode, cfg = VERSION_CONFIG): boolean {
  return mode !== "flow" && lastInputAt > lastVersionAt && now - lastVersionAt > cfg.autosaveEveryMs;
}

/** Skip a version whose text is identical to the newest one. */
export const isDuplicate = (text: string, newestText: string | undefined) => newestText !== undefined && newestText === text;

/** Ids of autosaves to delete so only the newest `keep` remain. */
export function autosavesToPrune(versions: { id: string; kind: string; created_at: string }[], keep = VERSION_CONFIG.keepAutosaves): string[] {
  return versions
    .filter((v) => v.kind === "auto")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(keep)
    .map((v) => v.id);
}
