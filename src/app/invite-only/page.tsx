import SignIn from "@/components/SignIn";

export default async function InviteOnly({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return (
    <div className="center">
      <div className="signin">
        <h1>This app is invite-only</h1>
        <p>
          {email ? <>The Google account <b>{email}</b> isn’t on the invite list. </> : null}
          If you think it should be, ask the person who invited you to add this address. You’ve been signed out.
        </p>
        <a className="btn" href="/">Try another account</a>
      </div>
    </div>
  );
}
