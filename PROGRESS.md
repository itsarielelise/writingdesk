# Progress

All six phases are implemented in code. What could not be done from the build environment is marked **owner**: it needs real accounts and keys.

Test suite: `npm test`, 71 tests in 7 files, all passing. `npm run lint` (tsc) and `next build` are clean.

## 1. Scaffold and auth
- Next.js 16 App Router + TypeScript. Supabase SSR helpers; session refresh in `src/proxy.ts` (Next 16's replacement for `middleware.ts`).
- Google sign-in (`SignIn.tsx` → `/auth/callback`). Uninvited accounts are signed out in the callback and shown `/invite-only`.
- Allowlist checked server-side in every API route and page (`lib/server/access.ts`), and again inside Postgres: every RLS policy calls `is_allowed()`, so removing an invite cuts off data access even with a live session.
- `ADMIN_EMAIL` is upserted as admin on first sign-in. `/admin` adds and removes invites and shows AI usage per writer and per day. It never queries writing.
- **owner:** create the Supabase project, Google OAuth client and Vercel project (README → Setup). Not deployed from here.

## 2. Editor and pieces
- TipTap with a restricted schema. Quotes are single text blocks (not TipTap's paragraph-wrapping blockquote) so a quote keeps one pid, like the prototype.
- `pid` on every block. Tested: survives save/load, undo, paste (pasted blocks get fresh ids, existing ones are untouched), heading/quote toggles; on Enter the original keeps its id (also when splitting at the very start).
- Piece CRUD, 1.2 s autosave with retry, save on tab hide, Anchor tab, Parked tab (Alt+P / button, undoable as its own step), export `.md` and copy as Markdown.
- RLS tests run the real migration in embedded Postgres (PGlite): user A can't read, update, delete or attach to user B's pieces, versions, flags, parked items or paragraph meta; uninvited users see nothing; writers can't read the allowlist or forge usage.

## 3. Flow detection and versions
- `FlowDetector` / `computeMode` ported from the prototype, with unit tests for every mode, both loop rules, session and revision rules. The prototype's guards on churn-looping (30+ events over 150+ s) are kept and configurable.
- Margin marks (revised / reworked / current), paper bar colour, toolbar fade in flow.
- Flow, autosave (5 min, not in flow, newest 15 kept), manual (button + Ctrl/Cmd+S), safety (before restore, take swap, earlier wording, stitch) and stitch versions. Identical text is skipped (client and server).
- Version preview with Restore, Compare with now (Bring back / Add to Parked / Use the earlier wording), Delete. Earlier takes view and loop toast with the prototype's cooldowns.
- Checked in a browser against a mocked backend: a typed run shows *In flow*, Ctrl+S saves a version, park + undo, compare, Ask with citations, heading toggle keeps the pid, no horizontal scroll at phone width.

## 4. Claude features
- Stitch (Opus 5.5, streamed, `effort: high`), strongest take (Sonnet 5.5, `effort: low`), Ask (Sonnet 5.5 with the `web_search_20260209` tool, citations shown as links, `pause_turn` continued), Explain (Haiku 5.5).
- Opus and Sonnet calls opt into Anthropic's server-side refusal fallback (`fallbacks: "default"`), which retries a declined request on a recommended model inside the same call.
- Every call checks the allowlist, logs token counts to `ai_usage`, and enforces daily caps (`DAILY_LIMIT_*`, reset at midnight UTC) plus a per-route rate limit.
- **owner:** not exercised against the live API (no key here).

## 5. Jev coach
- `CoachProvider` with `JevCoach` (`client.systemOne`, `choice` / `score` questions as specified) and `ClaudeCoach` (the prototype prompt on Haiku, now also asked for a confidence so both paths use the same thresholds). Jev errors fall back to Claude automatically.
- Background scheduling: paragraphs of 30+ changed words are queued when the caret leaves them; at most one check every 20 s; never while looping. Notes found while you're writing are held and only bump the badge until you pause.
- Flag cards: Go to paragraph, Show the earlier one, Park paragraph, Explain, Dismiss, with confidence shown.
- `scripts/eval-coach.ts` writes CSV + Markdown side-by-side reports with an empty "correct" column for labelling. Two sample drafts in `samples/` contain a planted repeat, tangent and misplaced paragraph each.
- **owner:** Jev's per-request size limit wasn't in the SDK docs, so the abridging threshold is `JEV_MAX_STATE_CHARS` (default 60 000). Check it and run the eval with both keys before making Jev the default.

## 6. Polish
- Dark mode (system, light or dark from the ⋯ menu; no flash on load), mobile overlay panel, keyboard shortcuts (Ctrl/Cmd+B/I/S, Alt+P, Ctrl/Cmd+Enter in Ask), the prototype's empty/error copy, and a first-run guide covering flow, versions, parking and the anchor.

## Decisions worth a look
- Live coaching is off until the writer turns it on, as in the prototype.
- The rate limiter is in memory (per server instance). The durable controls are the daily caps in Postgres.
- Strongest-take and Explain have their own caps (`DAILY_LIMIT_TAKES`, `DAILY_LIMIT_EXPLAIN`) in addition to the three in the spec.
