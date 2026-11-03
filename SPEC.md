# Writing Desk: Build Spec

A distraction-aware writing app for a small, invite-only group of writers. It notices when a writer is in flow versus looping, saves versions automatically, flags repeats and drift without interrupting flow, and helps assemble the best final draft from earlier versions.

A working single-file prototype lives at `reference/writing-desk.html`. Treat it as the behavioral and visual source of truth: port its logic, prompts, copy and design tokens rather than reinventing them. It used claude.ai's built-in storage and AI. This build replaces both with our own backend.

---

## 1. Goals and non-goals

**Goals**
- Google sign-in, limited to an allowlist of invited emails.
- A Google Docs-like editor with a collapsible side panel.
- Flow and loop detection that runs entirely in the browser, with no AI calls.
- Automatic, smart version history, plus paragraph-level history ("earlier takes").
- Background structural checks (repeat, drift, section fit) using the TypeSafe Jev decision model.
- On-demand writing help from Claude: stitching the best draft, comparing takes, and an Ask panel with web search.
- Each user's writing is private to them.

**Non-goals for v1**
- Real-time collaboration between users on one piece.
- Payments or subscriptions.
- Mobile apps (the web app must still work on a phone browser).

---

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| App | Next.js (App Router), TypeScript | One codebase for UI and server routes; deploys cleanly on Vercel. |
| Editor | TipTap (ProseMirror) | Real document model with stable per-paragraph IDs as node attributes, plus undo, paste handling and formatting. The prototype's raw `contenteditable` approach should not be carried over. |
| Auth + DB | Supabase (Postgres, Auth with Google provider, Row Level Security) | Google OAuth built in; RLS keeps each writer's data private. |
| Writing AI | Anthropic Claude API, server-side only | Stitching, take comparison, Ask with web search. |
| Decision AI | TypeSafe Jev via `@typesafe-ai/sdk`, server-side only | Cheap, fast, typed answers for the background checks. |
| Hosting | Vercel | Native Next.js hosting and environment variables. |

Use current stable versions. Before writing integration code, check the latest docs for Supabase Auth (Next.js SSR helpers), the Anthropic TypeScript SDK and its web search tool, and the TypeSafe SDK (`client.systemOne`, question helpers `choice`, `score`, `noul`).

---

## 3. Access control

- Sign-in is Google only, through Supabase Auth.
- An `allowed_emails` table holds invited addresses. After sign-in, if the user's email is not on the list, show a polite "This app is invite-only" screen and sign them out. Enforce this server-side too: every API route checks the allowlist, not just the UI.
- One admin role (the owner). The admin sees a simple `/admin` page to add and remove invited emails and to view per-user AI usage totals. The admin cannot read other users' writing.

---

## 4. Data model (Postgres)

All user-owned tables have `user_id uuid references auth.users` and RLS policies limiting select, insert, update and delete to `user_id = auth.uid()`.

```sql
create table allowed_emails (
  email text primary key,
  is_admin boolean not null default false,
  added_at timestamptz not null default now()
);

create table pieces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text not null default '',
  content jsonb not null,               -- TipTap JSON document
  anchor_point text not null default '',
  anchor_sections text not null default '',   -- one section per line
  anchor_not_this text not null default '',
  word_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table versions (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('flow','auto','manual','safety','stitch')),
  label text not null default '',
  content jsonb not null,
  plain_text text not null,
  word_count int not null,
  created_at timestamptz not null default now()
);
create index on versions (piece_id, created_at desc);

create table paragraph_meta (            -- revision counts that drive the margin marks
  piece_id uuid not null references pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  pid text not null,
  rev_count int not null default 0,
  primary key (piece_id, pid)
);

create table flags (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  pid text not null,
  type text not null check (type in ('repeat','drift','order')),
  other_pid text,
  target_section text,
  confidence real not null,
  note text not null,
  status text not null default 'open' check (status in ('open','dismissed')),
  created_at timestamptz not null default now()
);

create table parked_items (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create table ai_usage (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  provider text not null check (provider in ('anthropic','typesafe')),
  feature text not null,                -- coach | stitch | takes | ask
  input_tokens int, output_tokens int,
  created_at timestamptz not null default now()
);
```

Paragraph IDs (`pid`) are a TipTap node attribute on every block (paragraph, heading, blockquote). They must survive save, load, undo and paste. When a block is split (Enter), the new block gets a new pid and the original keeps its own. This is what makes paragraph history, compare and the coach's references work.

---

## 5. Features to port from the prototype

### 5.1 Editor and layout
- Top bar: piece picker, New piece, editable title, Bold, Italic, Heading, Quote, Park, flow-state pill, word count, save state, panel toggle.
- Page: white "paper" centered on a desk background, serif body text, a 3px bar across the top colored by flow state, and margin marks per paragraph (amber = revised after moving on, rose = reworked three or more times, green = the paragraph currently being written in flow).
- Side panel with tabs: Coach, Versions, Parked, Anchor, Ask. Collapsible; becomes an overlay on narrow screens.
- In flow, the toolbar fades to 40% opacity until hovered.
- Port the design tokens (light and dark), fonts (Newsreader for writing, Instrument Sans for interface), and all interface copy from the prototype.
- Autosave the piece about 1.2 s after typing stops.

### 5.2 Flow and loop detection (client-side, no AI)
Port `computeMode` and the related logic from the prototype as a pure, unit-tested TypeScript module.
- Record each edit as `{time, charsInserted, charsDeleted, atTail}`, where `atTail` means the caret is in the last or second-to-last non-empty block.
- **Paused:** no input for 20 s.
- **In flow:** in the last 90 s, at least 50 characters inserted, deletions at most 40% of insertions, and at least 70% of edits at the tail.
- **Writing:** at the tail but below the flow threshold.
- **Revising:** everything else.
- **Looping:** either (a) the same finished paragraph was reopened for a new editing session four or more times within 4 minutes, or (b) over the last 4 minutes, more than 150 characters deleted with net growth of 40 characters or less.
- A new editing session in a paragraph begins when the caret moves into it from another paragraph, or after 8 s of no typing in it. A session counts as a revision only if the paragraph is not at the tail and was not created in the last 3 minutes. Each revision increments `rev_count`.
- All thresholds live in one config object so they can be tuned per user later.

### 5.3 Versions
- **Flow version:** when the state leaves Writing or In flow and at least 15 words were added since the last version.
- **Autosave version:** every 5 minutes of changes, not while in flow. Keep the newest 15 autosaves per piece and prune older ones.
- **Manual version:** a button, plus Ctrl/Cmd+S.
- **Safety version:** automatically saved before any restore, take swap, "use earlier wording", or stitch replacement.
- Skip a version when the text is identical to the newest one.
- Version preview offers Restore, Compare with now, and Delete.
- **Compare with now** is a paragraph-level diff by pid. It lists paragraphs that existed then but are gone now (with "Bring back", which reinserts after the nearest surviving earlier paragraph, and "Add to Parked"), paragraphs changed since (with "Use the earlier wording"), and paragraphs that are new.

### 5.4 Earlier takes (the loop rescue)
- On entering Looping, show a toast once per paragraph (cooling down 6 minutes, and at most once every 3 minutes overall): "You've reworked this paragraph N times. Your earlier takes are saved." with "See earlier takes" and "Keep going".
- The takes view lists every distinct saved text of that pid across versions, newest first, each with "Use this take".
- "Ask Claude which take is strongest" (see 6.2).
- Also reachable from the Coach tab for the paragraph under the cursor.

### 5.5 Parking
- Alt+P or the Park button moves the selection, or the whole current paragraph if nothing is selected, into Parked. The deletion must be undoable.
- Parked items can be inserted at the cursor, copied, or deleted.

### 5.6 Anchor
- Three fields: the point of the piece, sections in order (one per line), and topics that are not in this piece.
- The Coach shows a nudge to fill these in when the point is empty. Without an anchor, the coach checks only for repeats.

### 5.7 Export
- Export as Markdown (`.md`) and copy to clipboard.

---

## 6. AI architecture

All AI calls go through server routes. API keys never reach the browser. Every call checks the allowlist, writes a row to `ai_usage`, and respects per-user limits (section 7).

### 6.1 Background coach: TypeSafe Jev
Trigger: when the caret leaves a paragraph of 30 or more words whose text has changed since it was last checked. Batch pending paragraphs and run at most one check every 20 s per user. Never run while Looping. Results are stored as flags and shown only when the writer is not in flow; while in flow, only the panel badge count changes.

For each target paragraph, send one Jev request with three questions:

- **State:** the anchor, then the draft as an ordered list of `{pid, text}` objects, with the target pid named. If the draft exceeds Jev's per-request limit, send the full text of the target and the paragraphs around it, plus the first two sentences of every other paragraph.
- **`repeat`: `choice`.** "Does the target paragraph restate a point already made in another paragraph? If so, which?" Criteria: one option per other paragraph (key = pid, description = its first sentence), plus `none`: "The target makes a point not already made elsewhere."
- **`serves_point`: `score`**, with four levels from lowest to highest: "Unrelated to the main point", "Loosely related; a tangent", "Supports the point indirectly (an analogy, example or aside that earns its place)", "Directly advances the main point". Skip this question when there is no anchor.
- **`section`: `choice`.** "Which planned section does this paragraph belong in?" One option per anchor section, plus `none`. Skip when no sections are given.

Turning answers into flags (store the confidence with each):
- **repeat:** the chosen option is not `none` and its confidence is at least 0.80. Note: "This makes the same point as the paragraph beginning "…"."
- **drift:** the expected score is below the "supports indirectly" level and the confidence is at least 0.75. Note: "This may be a tangent from your main point. Park it for a later post?"
- **order:** the chosen section differs from the section the paragraph currently sits in (derived from the nearest preceding heading or from paragraph position), with confidence at least 0.80. Note: "This looks like it belongs in "{section}"."
- Keep the thresholds in config. Flag cards get an "Explain" button that asks Claude Haiku for a one-sentence explanation on demand.

**Fallback:** if `TYPESAFE_API_KEY` is not set or Jev errors, use the prototype's Claude coaching prompt (JSON array of flags) with Claude Haiku. Keep both paths behind one `CoachProvider` interface.

### 6.2 Claude features
Check the current model IDs in Anthropic's docs. At the time of writing, the lineup is `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`.

- **Stitch best draft (Opus, streamed):** use the prototype's stitch prompt. Send the current draft plus up to 11 earlier versions (flow and manual versions first, newest first), deduplicated, within the context budget. The output is the article in Markdown, then `=====NOTES=====`, then bullet notes. Words Claude adds go in [square brackets]. Show it in a review view with Copy and "Replace my draft with this" (which saves a safety version first, then a stitch version).
- **Strongest take (Sonnet, streamed):** use the prototype's prompt. Under 80 words, names the take by number, quotes any sentence worth combining, and does not rewrite.
- **Ask (Sonnet, streamed, with the web search tool enabled):** this is the research assistant. The system prompt contains the anchor and the current draft. The assistant keeps the writer's voice when suggesting edits, quotes the exact sentences it would change, and cites sources for researched facts. Show citations as links. Keep chat history per piece, in memory for v1.
- **Explain flag (Haiku):** one sentence.

### 6.3 Evaluation harness
Build `scripts/eval-coach.ts`. It takes a folder of sample drafts (Markdown, with an anchor in front matter), runs both the Jev provider and the Claude fallback over every paragraph, and writes a side-by-side report (CSV and Markdown) of the flags each produced, with confidences. The owner will label which flags were right, so thresholds can be tuned before Jev becomes the default.

---

## 7. Cost and abuse controls
- Per-user daily caps, configurable in env: for example 300 Jev checks, 3 stitches, 60 Ask messages.
- Server-side rate limit per user per route.
- Truncate inputs to the configured budgets before sending.
- The admin page shows usage per user per day.

---

## 8. Security and privacy
- RLS on every user table, with tests confirming user A cannot read user B's pieces, versions, flags or parked items.
- Sanitize editor content on save and load (only the node and mark types the editor supports).
- Server routes validate input with zod.
- Never log draft text. Usage logs record only token counts and feature names.

---

## 9. Environment variables
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server only; admin page and allowlist checks
ANTHROPIC_API_KEY=
TYPESAFE_API_KEY=                 # optional; coach falls back to Claude if empty
ADMIN_EMAIL=                      # seeded into allowed_emails as admin
DAILY_LIMIT_JEV=300
DAILY_LIMIT_STITCH=3
DAILY_LIMIT_ASK=60
```

---

## 10. Build phases
Work through these in order. Each phase ends with passing tests and a short note in `PROGRESS.md`.

1. **Scaffold and auth:** Next.js app, Supabase project wiring, Google sign-in, allowlist gate, admin page for invites, deploy to Vercel. *Done when an invited Google account can sign in and an uninvited one sees the invite-only screen.*
2. **Editor and pieces:** TipTap editor with pid attributes, piece CRUD, autosave, Anchor tab, Parked tab, export. *Done when pids survive reload, undo and paste, and two users cannot see each other's pieces.*
3. **Flow detection and versions:** port the mode detector as a tested module, margin marks, the top bar color, all version triggers, preview, restore, compare and earlier takes (without AI). *Done when the unit tests for each mode pass and a flow version saves after a run of writing.*
4. **Claude features:** stitch, strongest take, Ask with web search and citations, usage logging and limits.
5. **Jev coach:** the `CoachProvider` interface with Jev and Claude implementations, background scheduling, flags UI, Explain, and the eval harness.
6. **Polish:** dark mode, mobile layout, keyboard shortcuts, empty and error states using the prototype's copy, and a short first-run guide covering flow, versions, parking and the anchor.

---

## 11. Setup the owner must do (outside the code)
1. Create a Supabase project. In Auth, enable the Google provider.
2. In Google Cloud Console, create an OAuth client (web application). Add the Supabase callback URL it shows you as an authorized redirect URI, then paste the client ID and secret into Supabase.
3. Get an Anthropic API key from the Claude Console. Get a TypeSafe API key (optional at first).
4. Create a Vercel project from the GitHub repo and add the environment variables above.
5. Add your own email as `ADMIN_EMAIL`, then invite the other writers from `/admin`.
