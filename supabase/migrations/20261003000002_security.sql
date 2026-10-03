-- Row-level security: the same rules backend/Code.gs enforced.
--   Owner/Admin: see and manage everything.
--   Member: sees every space unless limited to some; edits in spaces they see;
--           deletes only what they made.
--   Guest: sees only their listed spaces, read-only, no routines or History.
-- Signed-out visitors (the anon role) get nothing.

-- ---------------------------------------------------------------- helpers

create or replace function private.my_email() returns text
language sql stable set search_path = '' as $$
  select lower(nullif(auth.jwt() ->> 'email', ''))
$$;

create or replace function private.me() returns public.team
language sql stable security definer set search_path = '' as $$
  select t.* from public.team t where t.email = private.my_email()
$$;

create or replace function private.my_rank() returns int
language sql stable security definer set search_path = '' as $$
  select case (private.me()).role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'guest' then 1 else 0 end
$$;

create or replace function private.is_member() returns boolean
language sql stable set search_path = '' as $$ select private.my_rank() >= 2 $$;

create or replace function private.is_admin() returns boolean
language sql stable set search_path = '' as $$ select private.my_rank() >= 3 $$;

create or replace function private.can_see(space text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  m public.team := private.me();
  s text;
begin
  if m.email is null then return false; end if;
  if m.role in ('owner', 'admin') then return true; end if;
  s := trim(coalesce(m.spaces, ''));
  if s in ('', '*') and m.role <> 'guest' then return true; end if;
  if space is null then return m.role <> 'guest'; end if;
  return space = any (select trim(x) from unnest(string_to_array(s, ',')) x);
end $$;

create or replace function private.can_edit(space text) returns boolean
language sql stable set search_path = '' as $$
  select private.my_rank() >= 2 and private.can_see(space)
$$;

create or replace function private.can_delete(created_by text, space text) returns boolean
language sql stable set search_path = '' as $$
  select private.can_see(space)
     and (private.my_rank() >= 3 or (private.my_rank() >= 2 and created_by = private.my_email()))
$$;

grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------- policies

alter table public.team         enable row level security;
alter table public.spaces       enable row level security;
alter table public.tasks        enable row level security;
alter table public.routines     enable row level security;
alter table public.daily_checks enable row level security;
alter table public.updates      enable row level security;
alter table public.docs         enable row level security;
alter table public.doc_versions enable row level security;
alter table public.sheet_links  enable row level security;
alter table public.activity     enable row level security;

-- team: everyone on the team sees the team; admins manage it
-- (finer role rules are in the team_rules trigger).
create policy team_select on public.team for select to authenticated
  using ((select private.my_rank()) >= 1);
create policy team_insert on public.team for insert to authenticated
  with check ((select private.is_admin()));
create policy team_update on public.team for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy team_delete on public.team for delete to authenticated
  using ((select private.is_admin()));

-- spaces
create policy spaces_select on public.spaces for select to authenticated
  using (private.can_see(id));
create policy spaces_insert on public.spaces for insert to authenticated
  with check ((select private.is_admin()));
create policy spaces_update on public.spaces for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy spaces_delete on public.spaces for delete to authenticated
  using ((select private.is_admin()));

-- tasks (comments: anyone who can see a task may add one)
create policy tasks_select on public.tasks for select to authenticated
  using (private.can_see(space));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (private.can_edit(space));
create policy tasks_update on public.tasks for update to authenticated
  using (private.can_see(space)) with check (private.can_see(space));
create policy tasks_delete on public.tasks for delete to authenticated
  using (private.can_delete(created_by, space));

-- routines: members see them, admins set them up
create policy routines_select on public.routines for select to authenticated
  using ((select private.is_member()) and private.can_see(space));
create policy routines_insert on public.routines for insert to authenticated
  with check ((select private.is_admin()));
create policy routines_update on public.routines for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- daily ticks: members tick their own, admins tick for anyone
create policy checks_select on public.daily_checks for select to authenticated
  using ((select private.is_member()));
create policy checks_insert on public.daily_checks for insert to authenticated
  with check ((select private.is_admin()) or ((select private.is_member()) and email = (select private.my_email())));
create policy checks_delete on public.daily_checks for delete to authenticated
  using ((select private.is_admin()) or ((select private.is_member()) and email = (select private.my_email())));

-- daily updates: members read all, write their own
create policy updates_select on public.updates for select to authenticated
  using ((select private.is_member()));
create policy updates_insert on public.updates for insert to authenticated
  with check ((select private.is_member()) and email = (select private.my_email()));
create policy updates_update on public.updates for update to authenticated
  using ((select private.is_member()) and email = (select private.my_email()))
  with check (email = (select private.my_email()));

-- docs (edit locks are checked in the docs_before trigger)
create policy docs_select on public.docs for select to authenticated
  using (private.can_see(space));
create policy docs_insert on public.docs for insert to authenticated
  with check (private.can_edit(space));
create policy docs_update on public.docs for update to authenticated
  using (private.can_edit(space)) with check (private.can_edit(space));
create policy docs_delete on public.docs for delete to authenticated
  using (private.can_delete(created_by, space));

-- doc versions: readable with the doc; written only by the docs trigger
create policy versions_select on public.doc_versions for select to authenticated
  using (exists (select 1 from public.docs d where d.id = doc_id and private.can_see(d.space)));

-- sheet links
create policy sheets_select on public.sheet_links for select to authenticated
  using (private.can_see(space));
create policy sheets_insert on public.sheet_links for insert to authenticated
  with check (private.can_edit(space));
create policy sheets_update on public.sheet_links for update to authenticated
  using (private.can_edit(space)) with check (private.can_edit(space));
create policy sheets_delete on public.sheet_links for delete to authenticated
  using (private.can_delete(added_by, space));

-- activity: members see their own, admins see everyone's; written only by triggers
create policy activity_select on public.activity for select to authenticated
  using ((select private.is_member())
     and ((select private.is_admin()) or email = (select private.my_email()))
     and private.can_see(space));
