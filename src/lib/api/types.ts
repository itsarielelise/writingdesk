import type { DocJSON } from "../doc/model";
import type { VersionKind } from "../versions/policy";

export interface PieceSummary { id: string; title: string; updated_at: string; word_count: number }
export interface Piece extends PieceSummary {
  content: DocJSON;
  anchor_point: string; anchor_sections: string; anchor_not_this: string;
  created_at: string;
}
export interface Version { id: string; piece_id: string; kind: VersionKind; label: string; content: DocJSON; plain_text: string; word_count: number; created_at: string }
export interface Flag { id: string; pid: string; type: "repeat" | "drift" | "order"; other_pid: string | null; target_section: string | null; confidence: number; note: string; status: "open" | "dismissed"; created_at: string }
export interface ParkedItem { id: string; text: string; created_at: string }
export interface OpenPiece { piece: Piece; versions: Version[]; parked: ParkedItem[]; flags: Flag[]; meta: Record<string, number> }
