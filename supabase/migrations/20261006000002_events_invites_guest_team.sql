-- Calendar events, call invites, and guests seeing the team.
--
--   * Calendar events (new table `events`): a deadline or an event on a date, optionally at a
--     time, optionally for a client (guest) and with team members invited. They replace the
--     "Client" field on tasks. Guests see the events made for them; members the ones they made
--     or are invited to; owner and admins all of them.
--   * Calls: owner and admins can invite team members (call_requests.attendees); invited
--     members see the call (read-only).
--   * Guests see everyone on the team except other guests (one client never sees another).

-- ---------------------------------------------------------------- the task "Client" field goes

drop function if exists public.client_deadlines();
drop trigger if exists tasks_client_check on public.tasks;
drop function if exists private.tasks_client_check();
alter table public.tasks drop column if exists client;

-- ---------------------------------------------------------------- guests see the team (not other guests)

drop policy if exists team_select on public.team;
create policy team_select on public.team for select to authenticated
  using ((select private.my_rank()) >= 2
      or ((select private.my_rank()) = 1 and (email = (select private.my_email()) or role <> 'guest')));

-- ---------------------------------------------------------------- calendar events

create table if not exists public.events (
  id           text primary key default private.new_id(),
  title        text not null check (length(title) between 1 and 200),
  kind         text not null default 'event' check (kind in ('event', 'deadline')),
  date         date not null,
  time         time,                                  -- null = all day
  duration_min integer check (duration_min between 5 and 1440),
  notes        text not null default '' check (length(notes) <= 2000),
  client       text,                                  -- a guest this is for (they see it)
  attendees    text[] not null default '{}',          -- team members invited (they see it)
  space        text not null default 'scinth' references public.spaces (id) on delete set default,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists events_date_idx on public.events (date);
create index if not exists events_client_idx on public.events (client);
revoke all on public.events from anon;

-- The client must be a guest; invited people must be on the team and not guests.
create or replace function private.events_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare bad text;
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(private.my_email(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.client := nullif(lower(trim(coalesce(new.client, ''))), '');
  if new.client is not null and not exists (select 1 from public.team t where t.email = new.client and t.role = 'guest') then
    raise exception 'Pick the client from the list (clients are guests on the team).';
  end if;
  new.attendees := coalesce(array(select distinct lower(trim(a)) from unnest(new.attendees) a where trim(a) <> ''), '{}');
  select string_agg(a, ', ') into bad from unnest(new.attendees) a
   where not exists (select 1 from public.team t where t.email = a and t.role <> 'guest');
  if bad is not null then raise exception 'Only people on the team can be invited (not %).', bad; end if;
  if new.time is null then new.duration_min := null; end if;
  return new;
end $$;
drop trigger if exists events_before on public.events;
create trigger events_before before insert or update on public.events
  for each row execute function private.events_before();

create or replace function private.events_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'INSERT' then perform private.log('added', 'event', new.id, new.title, new.space, new.date::text);
  elsif tg_op = 'DELETE' then perform private.log('deleted', 'event', old.id, old.title, old.space, old.date::text);
  elsif not (new.space is distinct from old.space and private.space_gone(old.space)) then
    perform private.log('updated', 'event', new.id, new.title, new.space, new.date::text);
  end if;
  return null;
end $$;
drop trigger if exists events_log on public.events;
create trigger events_log after insert or update or delete on public.events
  for each row execute function private.events_log();

alter table public.events enable row level security;
drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using ((select private.is_admin())
      or ((select private.is_member()) and (created_by = (select private.my_email()) or (select private.my_email()) = any (attendees)))
      or ((select private.my_rank()) = 1 and client = (select private.my_email())));
drop policy if exists events_insert on public.events;
create policy events_insert on public.events for insert to authenticated
  with check ((select private.is_member()) and private.can_edit(space));
drop policy if exists events_update on public.events;
create policy events_update on public.events for update to authenticated
  using ((select private.is_admin()) or created_by = (select private.my_email()))
  with check (((select private.is_admin()) or created_by = (select private.my_email())) and private.can_edit(space));
drop policy if exists events_delete on public.events;
create policy events_delete on public.events for delete to authenticated
  using ((select private.is_admin()) or created_by = (select private.my_email()));

-- ---------------------------------------------------------------- call invites

alter table public.call_requests add column if not exists attendees text[] not null default '{}';

create or replace function private.calls_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_email();
  bad text;
begin
  if tg_op = 'INSERT' then
    new.email := coalesce(me, new.email);
    new.status := 'requested';
    new.meeting_at := null; new.duration_min := null; new.meeting_link := null; new.reply := ''; new.handled_by := null;
    new.attendees := '{}';
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
  new.attendees := coalesce(array(select distinct lower(trim(a)) from unnest(new.attendees) a where trim(a) <> ''), '{}');
  select string_agg(a, ', ') into bad from unnest(new.attendees) a
   where not exists (select 1 from public.team t where t.email = a and t.role <> 'guest');
  if bad is not null then raise exception 'Only people on the team can be invited (not %).', bad; end if;
  if new.status is distinct from old.status then new.handled_by := me; end if;
  return new;
end $$;

drop policy if exists calls_select on public.call_requests;
create policy calls_select on public.call_requests for select to authenticated
  using ((select private.is_admin()) or email = (select private.my_email())
      or ((select private.is_member()) and (select private.my_email()) = any (attendees)));

-- ---------------------------------------------------------------- live updates

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;
