-- Reminders: the bar at the top of Home.
--
--   * A reminder is a short note, optionally on a date and at a time. It is for one person:
--     yourself, or a teammate (not a guest). Only the person who set it and the person it is
--     for can see it; it is private, so it is not written to History.
--   * The person it is for can tick it off or delete it. Only the person who set it can
--     change its text, date, time or who it is for.
--   * Ticked-off reminders are kept (done_at) so a mis-tick can be undone; the website only
--     loads the ones ticked off in the last couple of days.

create table if not exists public.reminders (
  id         text primary key default private.new_id(),
  text       text not null check (length(text) between 1 and 300),
  date       date,                                   -- null = no date
  time       time,                                   -- null = any time that day
  for_email  text not null references public.team (email) on delete cascade,
  created_by text,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists reminders_for_idx on public.reminders (for_email);
create index if not exists reminders_created_by_idx on public.reminders (created_by);
revoke all on public.reminders from anon;

create or replace function private.reminders_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me text := private.my_email();
begin
  new.text := trim(new.text);
  if tg_op = 'INSERT' then
    new.created_by := coalesce(me, new.created_by);
    new.created_at := now();
    new.for_email := lower(trim(coalesce(nullif(trim(new.for_email), ''), new.created_by)));
    new.done_at := null;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    -- The person it is for (when someone else set it) can only tick it off.
    if me is not null and me is distinct from old.created_by
       and (to_jsonb(new) - 'done_at') <> (to_jsonb(old) - 'done_at') then
      raise exception 'Only the person who set this reminder can change it.';
    end if;
    new.for_email := lower(trim(new.for_email));
    if new.done_at is null then null;
    elsif old.done_at is null then new.done_at := now();
    else new.done_at := old.done_at;
    end if;
  end if;
  if new.date is null then new.time := null; end if;
  if not exists (select 1 from public.team t where t.email = new.for_email and t.role <> 'guest') then
    raise exception 'Reminders can only go to people on the team.';
  end if;
  return new;
end $$;
drop trigger if exists reminders_before on public.reminders;
create trigger reminders_before before insert or update on public.reminders
  for each row execute function private.reminders_before();

alter table public.reminders enable row level security;
drop policy if exists reminders_select on public.reminders;
create policy reminders_select on public.reminders for select to authenticated
  using ((select private.is_member())
     and (created_by = (select private.my_email()) or for_email = (select private.my_email())));
drop policy if exists reminders_insert on public.reminders;
create policy reminders_insert on public.reminders for insert to authenticated
  with check ((select private.is_member()));
drop policy if exists reminders_update on public.reminders;
create policy reminders_update on public.reminders for update to authenticated
  using ((select private.is_member())
     and (created_by = (select private.my_email()) or for_email = (select private.my_email())))
  with check (created_by = (select private.my_email()) or for_email = (select private.my_email()));
drop policy if exists reminders_delete on public.reminders;
create policy reminders_delete on public.reminders for delete to authenticated
  using ((select private.is_member())
     and (created_by = (select private.my_email()) or for_email = (select private.my_email())));

-- ---------------------------------------------------------------- live updates

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reminders') then
    alter publication supabase_realtime add table public.reminders;
  end if;
end $$;
