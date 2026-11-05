import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { allowlistEntry } from "@/lib/server/access";
import { publicOrigin } from "@/lib/server/origin";

/** Google OAuth lands here. Uninvited accounts are signed out straight away. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const origin = publicOrigin(request);
  if (!code) return NextResponse.redirect(`${origin}/?error=signin`);
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return NextResponse.redirect(`${origin}/?error=signin`);
  const email = (data.user.email || "").toLowerCase();
  const { allowed } = await allowlistEntry(email);
  if (!allowed) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/invite-only?email=${encodeURIComponent(email)}`);
  }
  return NextResponse.redirect(`${origin}/`);
}
