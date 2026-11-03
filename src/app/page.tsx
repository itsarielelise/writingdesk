import { redirect } from "next/navigation";
import Desk from "@/components/Desk";
import SignIn from "@/components/SignIn";
import { currentAccess } from "@/lib/server/access";
import { supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!supabaseConfigured()) {
    return (
      <div className="center"><div className="signin">
        <h1>Writing Desk</h1>
        <p>This deployment isn’t connected to Supabase yet. Set the environment variables in <code>.env.example</code> and redeploy.</p>
      </div></div>
    );
  }
  const access = await currentAccess();
  if (access.state === "not-invited") redirect(`/invite-only?email=${encodeURIComponent(access.email)}`);
  if (access.state === "signed-out") {
    const { error } = await searchParams;
    return <SignIn error={error === "signin" ? "Sign-in didn’t finish. Try again." : undefined} />;
  }
  return <Desk email={access.email} isAdmin={access.isAdmin} />;
}
