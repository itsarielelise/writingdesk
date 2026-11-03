-- Writing Desk schema. Every user-owned table is private to its owner via RLS,
-- and every policy also requires the signed-in email to be on the allowlist.


create table if not exists public.allowed_emails (
  email text primary key,
  is_admin boolean not null default false,
  added_at timestamptz not null default now()
);

-- True when the caller's JWT email is invited. SECURITY DEFINER so callers
-- never need (or get) read access to the allowlist itself.
create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create table if not exists public.pieces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text not null default '',
  content jsonb not null,
  anchor_point text not null default '',
  anchor_sections text not null default '',
  anchor_not_this text not null default '',
  word_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pieces_user_updated on public.pieces (user_id, updated_at desc);

create table if not exists public.versions (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references public.pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('flow','auto','manual','safety','stitch')),
  label text not null default '',
  content jsonb not null,
  plain_text text not null,
  word_count int not null,
  created_at timestamptz not null default now()
);
create index if not exists versions_piece_created on public.versions (piece_id, created_at desc);

create table if not exists public.paragraph_meta (
  piece_id uuid not null references public.pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  pid text not null,
  rev_count int not null default 0,
  primary key (piece_id, pid)
);

create table if not exists public.flags (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references public.pieces on delete cascade,
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
create index if not exists flags_piece on public.flags (piece_id, status);

create table if not exists public.parked_items (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references public.pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists parked_piece on public.parked_items (piece_id, created_at desc);

create table if not exists public.ai_usage (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  provider text not null check (provider in ('anthropic','typesafe')),
  feature text not null,                -- coach | stitch | takes | ask | explain
  input_tokens int, output_tokens int,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_day on public.ai_usage (user_id, feature, created_at desc);

-- A child row may only point at a piece its own user owns.
create or replace function public.owns_piece(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pieces where id = p and user_id = auth.uid());
$$;

alter table public.allowed_emails enable row level security;
alter table public.pieces enable row level security;
alter table public.versions enable row level security;
alter table public.paragraph_meta enable row level security;
alter table public.flags enable row level security;
alter table public.parked_items enable row level security;
alter table public.ai_usage enable row level security;

-- allowed_emails: no policies. Only the service role (server) can read or write it.

drop policy if exists pieces_owner on public.pieces;
create policy pieces_owner on public.pieces for all to authenticated
  using (user_id = auth.uid() and public.is_allowed())
  with check (user_id = auth.uid() and public.is_allowed());

drop policy if exists versions_owner on public.versions;
create policy versions_owner on public.versions for all to authenticated
  using (user_id = auth.uid() and public.is_allowed())
  with check (user_id = auth.uid() and public.is_allowed() and public.owns_piece(piece_id));

drop policy if exists meta_owner on public.paragraph_meta;
create policy meta_owner on public.paragraph_meta for all to authenticated
  using (user_id = auth.uid() and public.is_allowed())
  with check (user_id = auth.uid() and public.is_allowed() and public.owns_piece(piece_id));

drop policy if exists flags_owner on public.flags;
create policy flags_owner on public.flags for all to authenticated
  using (user_id = auth.uid() and public.is_allowed())
  with check (user_id = auth.uid() and public.is_allowed() and public.owns_piece(piece_id));

drop policy if exists parked_owner on public.parked_items;
create policy parked_owner on public.parked_items for all to authenticated
  using (user_id = auth.uid() and public.is_allowed())
  with check (user_id = auth.uid() and public.is_allowed() and public.owns_piece(piece_id));

-- Users can read their own usage; only the server (service role) writes it.
drop policy if exists usage_read_own on public.ai_usage;
create policy usage_read_own on public.ai_usage for select to authenticated
  using (user_id = auth.uid());

-- Keep only the newest 15 autosave versions per piece.
create or replace function public.prune_autosaves(p uuid, keep int default 15) returns void
language sql security invoker set search_path = public as $$
  delete from public.versions
  where piece_id = p and kind = 'auto' and id in (
    select id from public.versions where piece_id = p and kind = 'auto'
    order by created_at desc offset keep
  );
$$;
