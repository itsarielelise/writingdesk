"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function SignIn({ error }: { error?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error);
  const go = async () => {
    setBusy(true); setErr(undefined);
    const { error } = await supabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback`, queryParams: { prompt: "select_account" } },
    });
    if (error) { setErr("Couldn’t start Google sign-in. Try again."); setBusy(false); }
  };
  return (
    <div className="center">
      <div className="signin">
        <h1>Writing Desk</h1>
        <p>A quiet place to draft. It notices when you’re in flow, saves your versions, and helps you assemble the best draft. Invited writers only.</p>
        <button className="btn primary" onClick={go} disabled={busy}>{busy ? "Opening Google…" : "Sign in with Google"}</button>
        {err && <p className="err-text" style={{ marginTop: 14 }}>{err}</p>}
      </div>
    </div>
  );
}
