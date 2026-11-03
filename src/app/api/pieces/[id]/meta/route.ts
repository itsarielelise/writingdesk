import { z } from "zod";
import { body, json, route, uuid } from "@/lib/server/access";

/** Upsert paragraph revision counts (they drive the margin marks). */
export const PUT = route<{ id: string }>("meta.save", async ({ supabase, user, params, req }) => {
  const pieceId = uuid.parse(params.id);
  const { revs } = await body(req, z.object({ revs: z.record(z.string().regex(/^[a-z0-9]{4,16}$/), z.number().int().min(0).max(100_000)) }));
  const rows = Object.entries(revs).slice(0, 2000).map(([pid, rev_count]) => ({ piece_id: pieceId, user_id: user.id, pid, rev_count }));
  if (rows.length) {
    const { error } = await supabase.from("paragraph_meta").upsert(rows, { onConflict: "piece_id,pid" });
    if (error) throw error;
  }
  return json({ ok: true });
});
