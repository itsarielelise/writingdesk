-- Move RLS helper functions out of the API-exposed public schema so they can't be
-- called via /rest/v1/rpc, and add indexes on user_id foreign keys.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function private.owns_piece(p uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pieces where id = p and user_id = auth.uid());
$$;

revoke all on function private.is_allowed() from public, anon;
revoke all on function private.owns_piece(uuid) from public, anon;
grant execute on function private.is_allowed() to authenticated, service_role;
grant execute on function private.owns_piece(uuid) to authenticated, service_role;

drop policy if exists pieces_owner on public.pieces;
create policy pieces_owner on public.pieces for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()));

drop policy if exists versions_owner on public.versions;
create policy versions_owner on public.versions for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()) and private.owns_piece(piece_id));

drop policy if exists meta_owner on public.paragraph_meta;
create policy meta_owner on public.paragraph_meta for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()) and private.owns_piece(piece_id));

drop policy if exists flags_owner on public.flags;
create policy flags_owner on public.flags for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()) and private.owns_piece(piece_id));

drop policy if exists parked_owner on public.parked_items;
create policy parked_owner on public.parked_items for all to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()) and private.owns_piece(piece_id));

drop policy if exists usage_read_own on public.ai_usage;
create policy usage_read_own on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()));

drop function if exists public.is_allowed();
drop function if exists public.owns_piece(uuid);

revoke all on function public.prune_autosaves(uuid, int) from public, anon;
grant execute on function public.prune_autosaves(uuid, int) to authenticated, service_role;

create index if not exists versions_user on public.versions (user_id);
create index if not exists paragraph_meta_user on public.paragraph_meta (user_id);
create index if not exists flags_user on public.flags (user_id);
create index if not exists parked_user on public.parked_items (user_id);
