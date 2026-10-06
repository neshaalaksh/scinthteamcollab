-- Roles, spaces, Drive and calls.
--
--   * "Scinth" is the main space. There is no "no space" (General) any more: everything
--     that had none moves to Scinth. Other spaces are client spaces; guests are clients.
--     team.spaces now lists the CLIENT spaces a person sees: '*' = all of them,
--     '' = none (members always see Scinth; guests never do).
--   * Tasks: owner and admins see all; members see tasks assigned to them or made by them.
--     Guests don't see tasks, only the deadlines tagged with their name (tasks.client).
--   * Routines and ticks: admins see everyone's; members only their own.
--   * History: owner and admins only.
--   * Guests: no docs, sheets, routines or tasks; they see Drive, Calendar and their calls,
--     and of the team only themselves plus the owner and admins.
--   * Routines remember when they were removed and what they looked like before each
--     change, so past days are counted with the setup of that day.
--   * New tables: drive_files (the files live in Google Drive) and call_requests.

-- ---------------------------------------------------------------- Scinth, the main space

insert into public.spaces (id, name, color) values ('scinth', 'Scinth', '#0F766E')
on conflict (id) do nothing;

-- Move "no space" items into Scinth without each move landing in History or bumping "last edited".
alter table public.tasks disable trigger tasks_log;
alter table public.tasks disable trigger tasks_before;
alter table public.docs disable trigger docs_before;
alter table public.docs disable trigger docs_log;
alter table public.routines disable trigger routines_log;
alter table public.routines disable trigger routines_before;

update public.tasks set space = 'scinth' where space is null;
update public.docs set space = 'scinth' where space is null;
update public.sheet_links set space = 'scinth' where space is null;
update public.routines set space = 'scinth' where space is null;

alter table public.tasks enable trigger tasks_log;
alter table public.tasks enable trigger tasks_before;
alter table public.docs enable trigger docs_before;
alter table public.docs enable trigger docs_log;
alter table public.routines enable trigger routines_log;
alter table public.routines enable trigger routines_before;

-- Every item has a space; deleting a client space moves its items to Scinth.
do $$
declare t text;
begin
  foreach t in array array['tasks', 'docs', 'sheet_links', 'routines'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_space_fkey');
    execute format('alter table public.%I alter column space set default ''scinth''', t);
    execute format('alter table public.%I alter column space set not null', t);
    execute format('alter table public.%I add constraint %I foreign key (space) references public.spaces (id) on delete set default', t, t || '_space_fkey');
  end loop;
end $$;

-- People's lists name client spaces only; drop Scinth and spaces that no longer exist.
alter table public.team disable trigger team_rules;
alter table public.team disable trigger team_log;
update public.team t
   set spaces = array_to_string(array(
         select trim(x) from unnest(string_to_array(t.spaces, ',')) x
         where trim(x) <> '' and trim(x) <> 'scinth' and exists (select 1 from public.spaces s where s.id = trim(x))), ',')
 where trim(t.spaces) <> '*' and t.role in ('member', 'guest');
alter table public.team enable trigger team_rules;
alter table public.team enable trigger team_log;

-- ---------------------------------------------------------------- who can see which space

create or replace function private.can_see(space text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  m public.team := private.me();
  sp text := coalesce(space, 'scinth');
  s text;
begin
  if m.email is null then return false; end if;
  if m.role in ('owner', 'admin') then return true; end if;
  if sp = 'scinth' then return m.role <> 'guest'; end if;
  s := trim(coalesce(m.spaces, ''));
  if s = '*' and m.role <> 'guest' then return true; end if;
  return sp = any (select trim(x) from unnest(string_to_array(s, ',')) x);
end $$;

-- Guests are clients: they belong to client spaces, never to Scinth.
create or replace function private.team_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_email();
  my_role text := (private.me()).role;
begin
  if me is null then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    if old.role = 'owner' then raise exception 'The owner cannot be removed.'; end if;
    if old.role = 'admin' and my_role <> 'owner' then raise exception 'Only the owner can remove an admin.'; end if;
    return old;
  end if;

  new.email := lower(trim(new.email));
  new.spaces := trim(coalesce(new.spaces, ''));
  if new.role = 'guest' then
    if new.spaces in ('', '*') then raise exception 'Pick the client space this guest belongs to.'; end if;
    if 'scinth' = any (select trim(x) from unnest(string_to_array(new.spaces, ',')) x) then
      raise exception 'Guests are clients: pick a client space, not Scinth.';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'owner' then raise exception 'Pick Admin, Member or Guest.'; end if;
    if new.role = 'admin' and my_role <> 'owner' then raise exception 'Only the owner can make someone an admin.'; end if;
    new.added_at := now();
    new.last_active := null;
    return new;
  end if;

  if new.email <> old.email then raise exception 'An email address cannot be changed. Remove the person and add them again.'; end if;
  if old.role = 'owner' and new.role <> 'owner' then raise exception 'The owner role cannot be changed here.'; end if;
  if new.role = 'owner' and old.role <> 'owner' then raise exception 'Pick Admin, Member or Guest.'; end if;
  if my_role <> 'owner' then
    if old.role = 'admin' and old.email <> me then raise exception 'Only the owner can change an admin.'; end if;
    if new.role <> old.role then raise exception 'Only the owner can change roles.'; end if;
  end if;
  return new;
end $$;

-- Scinth can't be deleted. A client space can, unless it is some guest's only space;
-- its items move to Scinth (the foreign keys) and it leaves everyone's lists.
create or replace function private.spaces_before_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare stuck text;
begin
  if old.id = 'scinth' then raise exception 'Scinth is the main space and cannot be deleted.'; end if;
  select string_agg(t.name, ', ') into stuck
    from public.team t
   where t.role = 'guest'
     and old.id = any (select trim(x) from unnest(string_to_array(t.spaces, ',')) x)
     and not exists (select 1 from unnest(string_to_array(t.spaces, ',')) x where trim(x) not in ('', old.id));
  if stuck is not null then
    raise exception '% only belong(s) to this space. Move them to another client space or remove them first.', stuck;
  end if;
  update public.team t
     set spaces = array_to_string(array(
           select trim(x) from unnest(string_to_array(t.spaces, ',')) x where trim(x) not in ('', old.id)), ',')
   where t.role in ('member', 'guest')
     and old.id = any (select trim(x) from unnest(string_to_array(t.spaces, ',')) x);
  return old;
end $$;

drop trigger if exists spaces_before_delete on public.spaces;
create trigger spaces_before_delete before delete on public.spaces
  for each row execute function private.spaces_before_delete();

-- ---------------------------------------------------------------- team: guests see only who they need

drop policy if exists team_select on public.team;
create policy team_select on public.team for select to authenticated
  using ((select private.my_rank()) >= 2
      or ((select private.my_rank()) = 1 and (email = (select private.my_email()) or role in ('owner', 'admin'))));

-- ---------------------------------------------------------------- tasks

alter table public.tasks add column if not exists client text;   -- a guest (client) this deadline is for

create or replace function private.task_visible(p_assignee text, p_created_by text, p_space text) returns boolean
language sql stable set search_path = '' as $$
  select private.is_admin()
      or (private.is_member() and private.can_see(p_space)
          and (p_assignee = private.my_email() or p_created_by = private.my_email()))
$$;
grant execute on function private.task_visible(text, text, text) to authenticated;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (private.task_visible(assignee, created_by, space));
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (private.can_edit(space));
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (private.task_visible(assignee, created_by, space) and private.can_edit(space))
  with check (private.task_visible(assignee, created_by, space) and private.can_edit(space));

-- The client on a task must be a guest on the team.
create or replace function private.tasks_client_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.client := nullif(lower(trim(coalesce(new.client, ''))), '');
  if new.client is not null and (tg_op = 'INSERT' or new.client is distinct from old.client)
     and not exists (select 1 from public.team t where t.email = new.client and t.role = 'guest') then
    raise exception 'Pick the client from the list (clients are guests on the team).';
  end if;
  return new;
end $$;
drop trigger if exists tasks_client_check on public.tasks;
create trigger tasks_client_check before insert or update on public.tasks
  for each row execute function private.tasks_client_check();

-- Comments: anyone who can see the task (guests no longer see tasks).
create or replace function public.add_task_comment(p_task_id text, p_text text)
returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare
  t public.tasks;
  body text := left(trim(coalesce(p_text, '')), 5000);
begin
  if body = '' then raise exception 'Write something first.'; end if;
  select * into t from public.tasks where id = p_task_id;
  if t.id is null or not private.task_visible(t.assignee, t.created_by, t.space) then
    raise exception 'That task is gone. It may have been deleted.';
  end if;
  perform set_config('app.adding_comment', '1', true);
  update public.tasks
     set comments = comments || jsonb_build_array(jsonb_build_object(
       'id', private.new_id(), 'by', private.my_email(), 'text', body, 'at', now()))
   where id = p_task_id
  returning * into t;
  perform set_config('app.adding_comment', '', true);
  return t;
end $$;

-- A guest's own deadlines: title and date only, never the task's details.
create or replace function public.client_deadlines()
returns table (id text, title text, due date, done boolean)
language sql stable security definer set search_path = '' as $$
  select t.id, t.title, t.due, t.status = 'done'
    from public.tasks t
   where t.client = private.my_email() and t.due is not null
   order by t.due
$$;
revoke execute on function public.client_deadlines() from anon, public;
grant execute on function public.client_deadlines() to authenticated;

-- ---------------------------------------------------------------- routines: own only, with history

alter table public.routines add column if not exists removed_at timestamptz;
alter table public.routines add column if not exists history jsonb not null default '[]';

-- history: one entry per change, { until, assignees, days, space } = how it was until then.
create or replace function private.routines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(private.my_email(), new.created_by);
    new.created_at := now();
    new.history := '[]';
    new.removed_at := null;
    return new;
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.history := old.history;          -- only this trigger writes these two
  new.removed_at := old.removed_at;
  if old.active and not new.active then new.removed_at := now(); end if;
  if new.active and not old.active then new.removed_at := null; end if;
  if pg_trigger_depth() = 1
     and (new.assignees is distinct from old.assignees or new.days is distinct from old.days
          or new.space is distinct from old.space) then
    new.history := old.history || jsonb_build_array(jsonb_build_object(
      'until', now(), 'assignees', to_jsonb(old.assignees), 'days', to_jsonb(old.days), 'space', old.space));
  end if;
  return new;
end $$;

create or replace function private.routines_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- e.g. a deleted space moving it to Scinth
  if tg_op = 'INSERT' then
    perform private.log('created', 'routine', new.id, new.title, new.space);
  elsif old.active and not new.active then
    perform private.log('deleted', 'routine', new.id, new.title, new.space);
  else
    perform private.log('updated', 'routine', new.id, new.title, new.space);
  end if;
  return null;
end $$;

-- Is (or was) this routine for me? Past assignments count, so old ticks keep their routine.
create or replace function private.routine_mine(p_assignees text[], p_history jsonb) returns boolean
language sql stable set search_path = '' as $$
  select p_assignees is null or private.my_email() = any (p_assignees)
      or exists (select 1 from jsonb_array_elements(coalesce(p_history, '[]')) h
                 where jsonb_typeof(h -> 'assignees') = 'null' or (h -> 'assignees') ? private.my_email())
$$;
grant execute on function private.routine_mine(text[], jsonb) to authenticated;

drop policy if exists routines_select on public.routines;
create policy routines_select on public.routines for select to authenticated
  using ((select private.is_admin())
      or ((select private.is_member()) and private.can_see(space) and private.routine_mine(assignees, history)));

drop policy if exists checks_select on public.daily_checks;
create policy checks_select on public.daily_checks for select to authenticated
  using ((select private.is_admin())
      or ((select private.is_member()) and email = (select private.my_email())
          and exists (select 1 from public.routines r where r.id = routine_id)));

-- ---------------------------------------------------------------- History: owner and admins

drop policy if exists activity_select on public.activity;
create policy activity_select on public.activity for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------- docs and sheets: team only

drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated
  using ((select private.is_member()) and private.can_see(space));
drop policy if exists sheets_select on public.sheet_links;
create policy sheets_select on public.sheet_links for select to authenticated
  using ((select private.is_member()) and private.can_see(space));

-- ---------------------------------------------------------------- Drive files

-- The files live in Google Drive (uploaded by the "drive" function); this is the list.
create table if not exists public.drive_files (
  id          text primary key default private.new_id(),
  name        text not null check (length(name) between 1 and 255),
  drive_id    text not null,
  url         text not null check (url ~ '^https://(drive|docs)\.google\.com/'),
  mime        text not null default '',
  size        bigint not null default 0,
  space       text not null default 'scinth' references public.spaces (id) on delete set default,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);
create index if not exists drive_files_space_idx on public.drive_files (space);
revoke all on public.drive_files from anon;

create or replace function private.drive_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.uploaded_by := coalesce(private.my_email(), new.uploaded_by);
  new.uploaded_at := now();
  return new;
end $$;
drop trigger if exists drive_before on public.drive_files;
create trigger drive_before before insert on public.drive_files
  for each row execute function private.drive_before();

create or replace function private.drive_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'INSERT' then perform private.log('uploaded', 'file', new.id, new.name, new.space);
  else perform private.log('deleted', 'file', old.id, old.name, old.space); end if;
  return null;
end $$;
drop trigger if exists drive_log on public.drive_files;
create trigger drive_log after insert or delete on public.drive_files
  for each row execute function private.drive_log();

alter table public.drive_files enable row level security;
drop policy if exists drive_select on public.drive_files;
create policy drive_select on public.drive_files for select to authenticated
  using (private.can_see(space));
drop policy if exists drive_insert on public.drive_files;
create policy drive_insert on public.drive_files for insert to authenticated
  with check ((select private.my_rank()) >= 1 and private.can_see(space));
drop policy if exists drive_delete on public.drive_files;
create policy drive_delete on public.drive_files for delete to authenticated
  using (private.can_see(space) and ((select private.is_admin()) or uploaded_by = (select private.my_email())));

-- ---------------------------------------------------------------- call requests

create table if not exists public.call_requests (
  id           text primary key default private.new_id(),
  email        text not null,                       -- the guest who asked
  space        text not null default 'scinth' references public.spaces (id) on delete set default,
  topic        text not null check (length(topic) between 1 and 200),
  notes        text not null default '' check (length(notes) <= 2000),
  preferred    text not null default '' check (length(preferred) <= 500),
  status       text not null default 'requested' check (status in ('requested', 'scheduled', 'declined', 'cancelled')),
  meeting_at   timestamptz,
  duration_min integer check (duration_min between 5 and 480),
  meeting_link text check (meeting_link is null or meeting_link ~ '^https://'),
  reply        text not null default '' check (length(reply) <= 1000),
  handled_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists call_requests_email_idx on public.call_requests (email);
revoke all on public.call_requests from anon;

-- Guests ask and may cancel; owner and admins schedule or decline.
create or replace function private.calls_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me text := private.my_email();
begin
  if tg_op = 'INSERT' then
    new.email := coalesce(me, new.email);
    new.status := 'requested';
    new.meeting_at := null; new.duration_min := null; new.meeting_link := null; new.reply := ''; new.handled_by := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  new.email := old.email;
  new.created_at := old.created_at;
  new.updated_at := now();
  if me is not null and not private.is_admin() then
    if new.status <> 'cancelled' or old.status not in ('requested', 'scheduled')
       or (to_jsonb(new) - 'status' - 'updated_at') <> (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'You can only cancel your own request.';
    end if;
    return new;
  end if;
  if new.status = 'scheduled' and (new.meeting_at is null or new.duration_min is null) then
    raise exception 'Pick a date, time and length for the call.';
  end if;
  if new.status is distinct from old.status then new.handled_by := me; end if;
  return new;
end $$;
drop trigger if exists calls_before on public.call_requests;
create trigger calls_before before insert or update on public.call_requests
  for each row execute function private.calls_before();

create or replace function private.calls_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'INSERT' then
    perform private.log('requested', 'call', new.id, new.topic, new.space);
  elsif new.status is distinct from old.status or new.meeting_at is distinct from old.meeting_at then
    perform private.log(case new.status when 'scheduled' then 'scheduled' when 'declined' then 'declined'
                        when 'cancelled' then 'cancelled' else 'updated' end, 'call', new.id, new.topic, new.space,
                        to_char(new.meeting_at at time zone 'utc', 'YYYY-MM-DD HH24:MI "UTC"'));
  end if;
  return null;
end $$;
drop trigger if exists calls_log on public.call_requests;
create trigger calls_log after insert or update on public.call_requests
  for each row execute function private.calls_log();

alter table public.call_requests enable row level security;
drop policy if exists calls_select on public.call_requests;
create policy calls_select on public.call_requests for select to authenticated
  using ((select private.is_admin()) or email = (select private.my_email()));
drop policy if exists calls_insert on public.call_requests;
create policy calls_insert on public.call_requests for insert to authenticated
  with check ((select private.my_rank()) = 1 and email = (select private.my_email()) and private.can_see(space));
drop policy if exists calls_update on public.call_requests;
create policy calls_update on public.call_requests for update to authenticated
  using ((select private.is_admin()) or email = (select private.my_email()))
  with check ((select private.is_admin()) or email = (select private.my_email()));

-- ---------------------------------------------------------------- live updates

do $$
declare t text;
begin
  foreach t in array array['drive_files', 'call_requests'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- moves caused by deleting a space

-- When a client space is deleted, its items move to Scinth. That move is not an edit:
-- no History entry, no new "last edited by", no routine history entry.
create or replace function private.space_gone(p_space text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_space is not null and not exists (select 1 from public.spaces s where s.id = p_space)
$$;

create or replace function private.tasks_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare last_comment jsonb;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'UPDATE' and new.space is distinct from old.space and private.space_gone(old.space) then return null; end if;
  if tg_op = 'INSERT' then
    perform private.log('created', 'task', new.id, new.title, new.space);
  elsif tg_op = 'DELETE' then
    perform private.log('deleted', 'task', old.id, old.title, old.space);
  elsif new.status = 'done' and old.status <> 'done' then
    perform private.log('completed', 'task', new.id, new.title, new.space);
  elsif old.status = 'done' and new.status <> 'done' then
    perform private.log('reopened', 'task', new.id, new.title, new.space);
  elsif new.status <> old.status then
    perform private.log('moved', 'task', new.id, new.title, new.space, new.status);
  elsif jsonb_array_length(new.comments) > jsonb_array_length(old.comments) then
    last_comment := new.comments -> -1;
    perform private.log('commented', 'task', new.id, new.title, new.space, left(last_comment ->> 'text', 120));
  elsif (to_jsonb(new) - 'checklist' - 'sort_order' - 'updated_at' - 'comments')
     <> (to_jsonb(old) - 'checklist' - 'sort_order' - 'updated_at' - 'comments') then
    perform private.log('updated', 'task', new.id, new.title, new.space);
  end if;
  return null;
end $$;

create or replace function private.docs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_email();
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(me, new.created_by);
    new.created_at := now();
    new.updated_at := now();
    new.updated_by := new.created_by;
    new.version := 1;
    new.locked_by := null;
    new.locked_at := null;
    return new;
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.locked_by := null;
  new.locked_at := null;
  if pg_trigger_depth() > 1 then return new; end if;
  if new.space is distinct from old.space and private.space_gone(old.space) then
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    return new;
  end if;

  if new.body <> old.body then
    if old.updated_at < now() - interval '10 minutes' then
      insert into public.doc_versions (doc_id, version, title, body, saved_at, saved_by)
      values (old.id, old.version, old.title, old.body, old.updated_at, old.updated_by)
      on conflict do nothing;
    end if;
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;

  if new.body <> old.body or new.title <> old.title or new.space is distinct from old.space
     or new.folder <> old.folder or new.pinned <> old.pinned then
    new.updated_at := now();
    new.updated_by := me;
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;

create or replace function private.docs_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log('created', 'doc', new.id, new.title, new.space);
  elsif tg_op = 'DELETE' then
    perform private.log('deleted', 'doc', old.id, old.title, old.space);
  elsif pg_trigger_depth() > 1 or (new.space is distinct from old.space and private.space_gone(old.space)) then
    null;
  elsif new.version <> old.version
    and not exists (select 1 from public.activity a
                    where a.type = 'doc' and a.item_id = new.id and a.action = 'edited'
                      and a.email = private.my_email() and a.at > now() - interval '10 minutes') then
    perform private.log('edited', 'doc', new.id, new.title, new.space);
  end if;
  return null;
end $$;

create or replace function private.routines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(private.my_email(), new.created_by);
    new.created_at := now();
    new.history := '[]';
    new.removed_at := null;
    return new;
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.history := old.history;          -- only this trigger writes these two
  new.removed_at := old.removed_at;
  if old.active and not new.active then new.removed_at := now(); end if;
  if new.active and not old.active then new.removed_at := null; end if;
  if pg_trigger_depth() = 1
     and not (new.space is distinct from old.space and private.space_gone(old.space))
     and (new.assignees is distinct from old.assignees or new.days is distinct from old.days
          or new.space is distinct from old.space) then
    new.history := old.history || jsonb_build_array(jsonb_build_object(
      'until', now(), 'assignees', to_jsonb(old.assignees), 'days', to_jsonb(old.days), 'space', old.space));
  end if;
  return new;
end $$;

create or replace function private.routines_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'UPDATE' and new.space is distinct from old.space and private.space_gone(old.space) then return null; end if;
  if tg_op = 'INSERT' then
    perform private.log('created', 'routine', new.id, new.title, new.space);
  elsif old.active and not new.active then
    perform private.log('deleted', 'routine', new.id, new.title, new.space);
  else
    perform private.log('updated', 'routine', new.id, new.title, new.space);
  end if;
  return null;
end $$;
