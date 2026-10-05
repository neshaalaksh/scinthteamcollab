-- Two fixes:
--   * Doc search finds text with & < > " ' in it (the saved HTML has them as &amp; and so on).
--   * Routine ticks follow the same rules on the server as in the app: you only see and tick
--     routines in spaces you can see, only for people the routine is for, and not for future days.

-- ---------------------------------------------------------------- doc search

create or replace function public.search_docs(q text)
returns table (id text, title text, snippet text)
language sql stable security invoker set search_path = '' as $$
  with t as (
    select d.id, d.title, d.updated_at,
           replace(replace(replace(replace(replace(replace(
             regexp_replace(regexp_replace(d.body, '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g'),
             '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&') as txt
    from public.docs d
  )
  select t.id, t.title,
         case when strpos(lower(t.txt), lower(q)) > 0
              then substr(t.txt, greatest(1, strpos(lower(t.txt), lower(q)) - 40), length(q) + 100)
              else '' end
  from t
  where length(trim(q)) > 0
    and (strpos(lower(t.title), lower(q)) > 0 or strpos(lower(t.txt), lower(q)) > 0)
  order by t.updated_at desc
  limit 50
$$;
revoke execute on function public.search_docs(text) from anon, public;
grant execute on function public.search_docs(text) to authenticated;

-- ---------------------------------------------------------------- routine ticks

-- The routine is one the signed-in person can see (the routines policy checks the space)
-- and `email` is someone it is for.
create or replace function private.tick_allowed(p_routine_id text, p_email text) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.routines r
    where r.id = p_routine_id
      and (r.assignees is null or p_email = any (r.assignees))
  )
$$;
grant execute on function private.tick_allowed(text, text) to authenticated;

drop policy if exists checks_select on public.daily_checks;
create policy checks_select on public.daily_checks for select to authenticated
  using ((select private.is_member())
     and exists (select 1 from public.routines r where r.id = routine_id));

drop policy if exists checks_insert on public.daily_checks;
create policy checks_insert on public.daily_checks for insert to authenticated
  with check (
    ((select private.is_admin()) or ((select private.is_member()) and email = (select private.my_email())))
    and private.tick_allowed(routine_id, email)
    -- "today" in the furthest-ahead time zone is at most a day past UTC
    and date <= (now() at time zone 'utc')::date + 1
  );
