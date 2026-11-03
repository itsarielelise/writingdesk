import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin, supabaseServer } from "../supabase/server";
import { checkRate } from "./rateLimit";

export interface Access { user: User; email: string; isAdmin: boolean; supabase: SupabaseClient }

const adminEmail = () => (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

/** Look up an email on the allowlist. The owner (ADMIN_EMAIL) is always allowed and seeded as admin. */
export async function allowlistEntry(email: string): Promise<{ allowed: boolean; isAdmin: boolean }> {
  const e = email.trim().toLowerCase();
  if (!e) return { allowed: false, isAdmin: false };
  const db = supabaseAdmin();
  if (e === adminEmail()) {
    await db.from("allowed_emails").upsert({ email: e, is_admin: true }, { onConflict: "email" });
    return { allowed: true, isAdmin: true };
  }
  const { data, error } = await db.from("allowed_emails").select("is_admin").eq("email", e).maybeSingle();
  if (error) throw error;
  return { allowed: !!data, isAdmin: !!data?.is_admin };
}

/** For pages: the signed-in user and whether they're allowed. */
export async function currentAccess(): Promise<{ state: "signed-out" } | { state: "not-invited"; email: string } | ({ state: "ok" } & Access)> {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { state: "signed-out" };
  const email = (user.email || "").toLowerCase();
  const { allowed, isAdmin } = await allowlistEntry(email);
  if (!allowed) return { state: "not-invited", email };
  return { state: "ok", user, email, isAdmin, supabase };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const json = (data: unknown, init?: number | ResponseInit) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

type Handler<P> = (ctx: Access & { req: Request; params: P }) => Promise<Response>;

/**
 * Wrap an API route: requires a signed-in, invited user (checked server-side on
 * every call), applies a per-user rate limit, and turns thrown errors into JSON.
 */
export function route<P = Record<string, string>>(
  name: string,
  handler: Handler<P>,
  opts: { admin?: boolean; perMinute?: number } = {},
) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      const supabase = await supabaseServer();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return json({ error: "Sign in first." }, 401);
      const email = (user.email || "").toLowerCase();
      const { allowed, isAdmin } = await allowlistEntry(email);
      if (!allowed) return json({ error: "This app is invite-only." }, 403);
      if (opts.admin && !isAdmin) return json({ error: "Admins only." }, 403);
      if (!checkRate(`${user.id}:${name}`, opts.perMinute ?? 120)) return json({ error: "Too many requests. Slow down a little." }, 429);
      const params = (ctx?.params ? await ctx.params : {}) as P;
      return await handler({ user, email, isAdmin, supabase, req, params });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof z.ZodError) return json({ error: "That request wasn’t valid." }, 400);
      console.error(`[${name}]`, (e as Error)?.message || e); // never logs draft text
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  };
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new HttpError(400, "Expected JSON."); }
  return schema.parse(raw);
}

export const uuid = z.string().uuid();
