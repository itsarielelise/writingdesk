// Runs the real migration in an embedded Postgres (PGlite) with a minimal stand-in
// for Supabase's auth schema, then checks that writers can only see their own data.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c"; // signed in, but not invited

let db: PGlite;

const SUPABASE_STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

async function as<T>(uid: string, email: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, email })}', false);`);
  try { return await fn(); } finally { await db.exec("reset role; select set_config('request.jwt.claims', '', false);"); }
}
const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of ["0001_init.sql", "0002_private_helpers.sql"]) {
    await db.exec(readFileSync(new URL(`../supabase/migrations/${m}`, import.meta.url), "utf8"));
  }
  await db.exec(`
    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to authenticated, service_role;
    grant all on all sequences in schema public to authenticated, service_role;
    insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com'), ('${C}', 'c@example.com');
    insert into public.allowed_emails (email) values ('a@example.com'), ('b@example.com');
  `);
  // Each invited writer creates a piece with children.
  for (const [uid, email] of [[A, "a@example.com"], [B, "b@example.com"]]) {
    await as(uid, email, async () => {
      const { rows } = await q(`insert into pieces (user_id, title, content) values ($1, $2, '{"type":"doc","content":[]}') returning id`, [uid, `piece of ${email}`]);
      const pid = rows[0].id;
      await q(`insert into versions (piece_id, user_id, kind, content, plain_text, word_count) values ($1, $2, 'manual', '{}', 'secret ' || $3, 2)`, [pid, uid, email]);
      await q(`insert into flags (piece_id, user_id, pid, type, confidence, note) values ($1, $2, 'abcd1234', 'repeat', 0.9, 'n')`, [pid, uid]);
      await q(`insert into parked_items (piece_id, user_id, text) values ($1, $2, 'parked ' || $3)`, [pid, uid, email]);
      await q(`insert into paragraph_meta (piece_id, user_id, pid, rev_count) values ($1, $2, 'abcd1234', 2)`, [pid, uid]);
    });
  }
});
afterAll(async () => { await db?.close(); });

describe("row level security", () => {
  for (const table of ["pieces", "versions", "flags", "parked_items", "paragraph_meta"]) {
    it(`user A sees only their own ${table}`, async () => {
      const rows = await as(A, "a@example.com", async () => (await q(`select user_id from ${table}`)).rows);
      expect(rows.length).toBe(1);
      expect(rows.every((r: any) => r.user_id === A)).toBe(true);
    });
  }

  it("user A can't update or delete user B's piece", async () => {
    const bPiece = (await q(`select id from pieces where user_id = $1`, [B])).rows[0].id;
    await as(A, "a@example.com", async () => {
      const u = await q(`update pieces set title = 'hacked' where id = $1`, [bPiece]);
      const d = await q(`delete from pieces where id = $1`, [bPiece]);
      expect(u.affectedRows).toBe(0);
      expect(d.affectedRows).toBe(0);
    });
    expect((await q(`select title from pieces where id = $1`, [bPiece])).rows[0].title).toBe("piece of b@example.com");
  });

  it("user A can't insert rows owned by user B, or attach rows to B's piece", async () => {
    const bPiece = (await q(`select id from pieces where user_id = $1`, [B])).rows[0].id;
    await as(A, "a@example.com", async () => {
      await expect(q(`insert into pieces (user_id, content) values ($1, '{}')`, [B])).rejects.toThrow(/row-level security/);
      await expect(q(`insert into versions (piece_id, user_id, kind, content, plain_text, word_count) values ($1, $2, 'manual', '{}', 'x', 1)`, [bPiece, A])).rejects.toThrow(/row-level security/);
      await expect(q(`insert into parked_items (piece_id, user_id, text) values ($1, $2, 'x')`, [bPiece, A])).rejects.toThrow(/row-level security/);
    });
  });

  it("a signed-in but uninvited user sees nothing and can't write", async () => {
    await as(C, "c@example.com", async () => {
      expect((await q(`select * from pieces`)).rows).toEqual([]);
      await expect(q(`insert into pieces (user_id, content) values ($1, '{}')`, [C])).rejects.toThrow(/row-level security/);
    });
  });

  it("removing someone from the allowlist cuts off access to their own data", async () => {
    await q(`delete from allowed_emails where email = 'b@example.com'`);
    const rows = await as(B, "b@example.com", async () => (await q(`select * from pieces`)).rows);
    expect(rows).toEqual([]);
    await q(`insert into allowed_emails (email) values ('b@example.com')`);
  });

  it("writers can't read the allowlist or write usage", async () => {
    await as(A, "a@example.com", async () => {
      expect((await q(`select * from allowed_emails`)).rows).toEqual([]);
      await expect(q(`insert into ai_usage (user_id, provider, feature) values ($1, 'anthropic', 'ask')`, [A])).rejects.toThrow(/row-level security/);
    });
  });

  it("RLS helpers aren't callable by anonymous users", async () => {
    await db.exec("set role anon");
    try { await expect(q("select private.is_allowed()")).rejects.toThrow(/permission denied/); }
    finally { await db.exec("reset role"); }
  });

  it("prune_autosaves keeps the newest 15", async () => {
    const aPiece = (await q(`select id from pieces where user_id = $1`, [A])).rows[0].id;
    await as(A, "a@example.com", async () => {
      for (let i = 0; i < 20; i++) {
        await q(`insert into versions (piece_id, user_id, kind, content, plain_text, word_count, created_at) values ($1, $2, 'auto', '{}', $3, 1, now() - ($4 || ' minutes')::interval)`, [aPiece, A, `t${i}`, String(i)]);
      }
      await q(`select prune_autosaves($1)`, [aPiece]);
      const { rows } = await q(`select plain_text from versions where piece_id = $1 and kind = 'auto' order by created_at desc`, [aPiece]);
      expect(rows.map((r: any) => r.plain_text)).toEqual(Array.from({ length: 15 }, (_, i) => `t${i}`));
    });
  });
});
