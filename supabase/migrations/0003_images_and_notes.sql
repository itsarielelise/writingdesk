-- Images: a private bucket. Each writer's files live under <user_id>/<piece_id>/,
-- and only that writer (while invited) can read or add them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 10485760, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists images_read_own on storage.objects;
create policy images_read_own on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_allowed()));

drop policy if exists images_insert_own on storage.objects;
create policy images_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_allowed()));

-- No update/delete policies: stored images are kept so older versions can still show them.

-- Notes: loose scraps for a piece (lines, links, images) that aren't part of the draft.
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references public.pieces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  text text not null default '',
  image_src text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notes_not_empty check (length(text) > 0 or image_src is not null)
);
create index if not exists notes_piece on public.notes (piece_id, created_at desc);
create index if not exists notes_user on public.notes (user_id);

alter table public.notes enable row level security;
drop policy if exists notes_owner on public.notes;
create policy notes_owner on public.notes for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()) and private.owns_piece(piece_id));
