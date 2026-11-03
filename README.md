# Writing Desk

A distraction-aware writing app for a small, invite-only group of writers. It notices when you're in flow and when you're looping, saves versions on its own, flags repeats and drift without interrupting, and helps assemble the best final draft from earlier versions.

- **Spec:** [`SPEC.md`](SPEC.md) · **Prototype (behavioral source of truth):** [`reference/writing-desk.html`](reference/writing-desk.html) · **Status:** [`PROGRESS.md`](PROGRESS.md)
- **Stack:** Next.js 16 (App Router, TypeScript) · TipTap 3 · Supabase (Postgres, Google auth, RLS) · Anthropic Claude API · TypeSafe Jev · Vercel

## Setup (one-time, outside the code)

1. **Supabase.** Create a project. In *SQL Editor*, run the files in [`supabase/migrations/`](supabase/migrations/) in order (or `supabase db push` with the CLI).
2. **Google sign-in.** In Google Cloud Console create an OAuth client (*Web application*). Add the callback URL Supabase shows under *Authentication → Providers → Google* as an authorized redirect URI, then paste the client ID and secret into that Supabase page and enable the provider.
3. **Redirect URLs.** In Supabase *Authentication → URL Configuration*, set *Site URL* to your app's URL and add `https://<your-app>/auth/callback` (and `http://localhost:3000/auth/callback` for local dev) to *Redirect URLs*.
4. **Keys.** Get an Anthropic API key from the Claude Console. A TypeSafe API key is optional; without it the coach uses Claude Haiku.
5. **Vercel.** Create a project from this repo and add the environment variables from [`.env.example`](.env.example). Put your own address in `ADMIN_EMAIL`.
6. Sign in once with that address (it's seeded as admin on first sign-in), then invite the other writers from `/admin`.

## Local development

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev                  # http://localhost:3000
```

```bash
npm test                     # unit, editor, and RLS tests (no network needed)
npm run lint                 # type check
npm run eval:coach -- samples
```

## How it's put together

| Path | What |
| --- | --- |
| `src/lib/flow/detector.ts` | Flow / loop detection. Pure, tested, all thresholds in `FLOW_CONFIG`. |
| `src/lib/versions/policy.ts` | When flow, autosave and manual versions are taken; pruning. |
| `src/lib/doc/` | Document model, sanitizer, Markdown in/out, paragraph-level compare and earlier takes. |
| `src/components/editor/extensions.ts` | TipTap schema, stable paragraph ids (`pid`), margin-mark decorations. |
| `src/components/Desk.tsx` | The writing screen: wires the editor to detection, saving, versions, coach, parking. |
| `src/lib/coach/` | `CoachProvider` interface with Jev and Claude implementations; Jev question building and answer → flag rules. |
| `src/lib/ai/` | Claude client, model IDs, and the prompts ported from the prototype. |
| `src/app/api/` | Route handlers. Every one checks sign-in **and** the allowlist (`lib/server/access.ts`), validates with zod, and rate-limits. |
| `supabase/migrations/` | Schema and RLS. Policies require `user_id = auth.uid()` **and** an invited email. |
| `scripts/eval-coach.ts` | Side-by-side report of Jev vs Claude flags over `samples/*.md`. |

### Privacy

- Writing is only ever read with the signed-in user's own Supabase session, so RLS applies to every query. The service-role key is used only for the allowlist, usage logging, and the admin page, none of which touch writing.
- Usage logs store feature names and token counts, never text. Server errors log only messages.
- Editor JSON is sanitized on save and on load (only paragraphs, h2/h3, quotes, bold, italic, line breaks).
