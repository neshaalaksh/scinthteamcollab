-- Rules the database applies on every write, so the website can't skip them:
-- who-did-it stamps, the History (activity) log, team role rules,
-- doc edit locks and doc version snapshots.

create or replace function private.log(
  p_action text, p_type text, p_item_id text, p_title text, p_space text,
  p_detail text default null, p_email text default null
) returns void
language sql security definer set search_path = '' as $$
  insert into public.activity (email, action, type, item_id, title, space, detail)
  values (coalesce(p_email, private.my_email(), 'system'), p_action, p_type, p_item_id, p_title, p_space, p_detail)
$$;

-- Signed-in people call this on load to show "last active" (at most every 5 minutes).
create or replace function public.touch_last_active() returns void
language sql security definer set search_path = '' as $$
  update public.team set last_active = now()
  where email = private.my_email() and (last_active is null or last_active < now() - interval '5 minutes')
$$;
revoke execute on function public.touch_last_active() from anon, public;
grant execute on function public.touch_last_active() to authenticated;

-- ---------------------------------------------------------------- team

create or replace function private.team_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_email();
  my_role text := (private.me()).role;
begin
  -- Migrations and the dashboard (no signed-in user) may do anything.
  if me is null then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    if old.role = 'owner' then raise exception 'The owner cannot be removed.'; end if;
    if old.role = 'admin' and my_role <> 'owner' then raise exception 'Only the owner can remove an admin.'; end if;
    return old;
  end if;

  new.email := lower(trim(new.email));
  if new.role = 'guest' and trim(coalesce(new.spaces, '')) in ('', '*') then
    raise exception 'Pick the space this guest can see.';
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'owner' then raise exception 'Pick Admin, Member or Guest.'; end if;
    if new.role = 'admin' and my_role <> 'owner' then raise exception 'Only the owner can make someone an admin.'; end if;
    new.added_at := now();
    new.last_active := null;
    return new;
  end if;

  -- UPDATE
  if new.email <> old.email then raise exception 'An email address cannot be changed. Remove the person and add them again.'; end if;
  if old.role = 'owner' and new.role <> 'owner' then raise exception 'The owner role cannot be changed here.'; end if;
  if new.role = 'owner' and old.role <> 'owner' then raise exception 'Pick Admin, Member or Guest.'; end if;
  if my_role <> 'owner' then
    if old.role = 'admin' and old.email <> me then raise exception 'Only the owner can change an admin.'; end if;
    if new.role <> old.role then raise exception 'Only the owner can change roles.'; end if;
  end if;
  return new;
end $$;

create trigger team_rules before insert or update or delete on public.team
  for each row execute function private.team_rules();

create or replace function private.team_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.my_email() is null then return null; end if;
  if tg_op = 'INSERT' then
    perform private.log('added', 'person', new.email, new.name, null, new.role);
  elsif tg_op = 'DELETE' then
    perform private.log('removed', 'person', old.email, old.name, null);
  elsif new.role <> old.role then
    perform private.log('changed role', 'person', new.email, new.name, null, old.role || ' → ' || new.role);
  elsif new.name <> old.name or new.spaces <> old.spaces then
    perform private.log('updated', 'person', new.email, new.name, null);
  end if;
  return null;
end $$;

create trigger team_log after insert or update or delete on public.team
  for each row execute function private.team_log();

-- ---------------------------------------------------------------- spaces

create or replace function private.spaces_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log('created', 'space', new.id, new.name, new.id);
  else
    perform private.log('deleted', 'space', old.id, old.name, null);
  end if;
  return null;
end $$;

create trigger spaces_log after insert or delete on public.spaces
  for each row execute function private.spaces_log();

-- ---------------------------------------------------------------- tasks

create or replace function private.tasks_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me text := private.my_email();
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(me, new.created_by);
    new.created_at := now();
    new.completed_at := null;
    new.completed_by := null;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    -- People who can only view this space (guests) may add comments, nothing else.
    if me is not null and not private.can_edit(old.space)
       and (to_jsonb(new) - 'comments' - 'updated_at') <> (to_jsonb(old) - 'comments' - 'updated_at') then
      raise exception 'You cannot edit tasks in this space.';
    end if;
  end if;
  new.updated_at := now();
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := now();
    new.completed_by := me;
  elsif new.status <> 'done' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end $$;

create trigger tasks_before before insert or update on public.tasks
  for each row execute function private.tasks_before();

create or replace function private.tasks_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare last_comment jsonb;
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- e.g. a deleted space clearing itself from tasks
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

create trigger tasks_log after insert or update or delete on public.tasks
  for each row execute function private.tasks_log();

-- ---------------------------------------------------------------- routines

create or replace function private.routines_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(private.my_email(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

create trigger routines_before before insert or update on public.routines
  for each row execute function private.routines_before();

create or replace function private.routines_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log('created', 'routine', new.id, new.title, new.space);
  elsif old.active and not new.active then
    perform private.log('deleted', 'routine', new.id, new.title, new.space);
  else
    perform private.log('updated', 'routine', new.id, new.title, new.space);
  end if;
  return null;
end $$;

create trigger routines_log after insert or update on public.routines
  for each row execute function private.routines_log();

-- ---------------------------------------------------------------- daily ticks and updates

create or replace function private.checks_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.email := lower(new.email);
  new.at := now();
  new.ticked_by := coalesce(private.my_email(), new.ticked_by);
  return new;
end $$;

create trigger checks_before before insert on public.daily_checks
  for each row execute function private.checks_before();

-- History shows whose routine it was, even when an admin ticked it for them.
create or replace function private.checks_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r public.daily_checks := coalesce(new, old);
  routine public.routines;
begin
  select * into routine from public.routines where id = r.routine_id;
  perform private.log(case when tg_op = 'INSERT' then 'ticked' else 'unticked' end,
    'routine', r.routine_id, routine.title, routine.space, r.date::text, r.email);
  return null;
end $$;

create trigger checks_log after insert or delete on public.daily_checks
  for each row execute function private.checks_log();

create or replace function private.updates_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.at := now();
  return new;
end $$;

create trigger updates_before before insert or update on public.updates
  for each row execute function private.updates_before();

create or replace function private.updates_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.log('posted update', 'daily', new.date::text, 'Daily update ' || new.date::text, null, null, new.email);
  return null;
end $$;

create trigger updates_log after insert or update on public.updates
  for each row execute function private.updates_log();

-- ---------------------------------------------------------------- docs

-- A doc is locked while someone edits it; the lock expires after 10 quiet minutes.
-- Each change to the body bumps `version`, so the app can save with
-- `.eq('version', baseVersion)` and notice when someone else saved first.
-- The text as it was before each editing session is kept in doc_versions.
create or replace function private.docs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_email();
  holder text;
  holder_name text;
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(me, new.created_by);
    new.created_at := now();
    new.updated_at := now();
    new.updated_by := new.created_by;
    new.version := 1;
    if new.locked_by is not null then new.locked_by := me; new.locked_at := now(); end if;
    return new;
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  -- Deleting a space clears it from its docs; that must work even while one is being edited.
  if pg_trigger_depth() > 1 then return new; end if;

  if old.locked_by is not null and old.locked_by <> me and old.locked_at > now() - interval '10 minutes' then
    holder := old.locked_by;
  end if;
  if holder is not null then
    -- Admins may only clear someone else's lock, not edit through it.
    if not (private.is_admin() and new.locked_by is null
            and new.body = old.body and new.title = old.title and new.space is not distinct from old.space) then
      select coalesce(t.name, holder) into holder_name from public.team t where t.email = holder;
      raise exception '% is editing this doc right now.', coalesce(holder_name, holder);
    end if;
  end if;
  if new.locked_by is not null and new.locked_by is distinct from old.locked_by then
    new.locked_by := me;
  end if;
  if new.locked_by is null then new.locked_at := null;
  elsif new.locked_by = me then new.locked_at := now();   -- autosave keeps your lock fresh
  else new.locked_at := old.locked_at;                     -- never refresh someone else's lock
  end if;

  if new.body <> old.body then
    if old.updated_by is distinct from me or old.updated_at < now() - interval '10 minutes' then
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

create trigger docs_before before insert or update on public.docs
  for each row execute function private.docs_before();

create or replace function private.docs_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log('created', 'doc', new.id, new.title, new.space);
  elsif tg_op = 'DELETE' then
    perform private.log('deleted', 'doc', old.id, old.title, old.space);
  elsif pg_trigger_depth() > 1 then
    null;
  elsif new.version <> old.version
    and not exists (select 1 from public.activity a
                    where a.type = 'doc' and a.item_id = new.id and a.action = 'edited'
                      and a.email = private.my_email() and a.at > now() - interval '10 minutes') then
    perform private.log('edited', 'doc', new.id, new.title, new.space);
  end if;
  return null;
end $$;

create trigger docs_log after insert or update or delete on public.docs
  for each row execute function private.docs_log();

-- ---------------------------------------------------------------- sheet links

create or replace function private.sheets_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.added_by := coalesce(private.my_email(), new.added_by);
    new.added_at := now();
  else
    new.added_by := old.added_by;
    new.added_at := old.added_at;
  end if;
  return new;
end $$;

create trigger sheets_before before insert or update on public.sheet_links
  for each row execute function private.sheets_before();

create or replace function private.sheets_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.log('added', 'sheet', new.id, new.name, new.space);
  else
    perform private.log('removed', 'sheet', old.id, old.name, old.space);
  end if;
  return null;
end $$;

create trigger sheets_log after insert or delete on public.sheet_links
  for each row execute function private.sheets_log();

-- ---------------------------------------------------------------- live updates

-- Lets the website hear about teammates' changes instantly instead of polling.
alter publication supabase_realtime add table
  public.team, public.spaces, public.tasks, public.routines, public.daily_checks,
  public.updates, public.docs, public.sheet_links;
