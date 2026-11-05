import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/origin";

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${publicOrigin(request)}/`, { status: 303 });
}
