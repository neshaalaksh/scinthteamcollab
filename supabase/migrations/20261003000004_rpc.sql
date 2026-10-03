-- Functions the website calls directly (supabase.rpc).

-- Adding a comment goes through here so the author and time can't be faked.
-- Anyone who can see a task may comment, including guests.
create or replace function public.add_task_comment(p_task_id text, p_text text)
returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare
  t public.tasks;
  body text := left(trim(coalesce(p_text, '')), 5000);
begin
  if body = '' then raise exception 'Write something first.'; end if;
  select * into t from public.tasks where id = p_task_id;
  if t.id is null or not private.can_see(t.space) then raise exception 'That task is gone. It may have been deleted.'; end if;
  perform set_config('app.adding_comment', '1', true);
  update public.tasks
     set comments = comments || jsonb_build_array(jsonb_build_object(
       'id', private.new_id(), 'by', private.my_email(), 'text', body, 'at', now()))
   where id = p_task_id
  returning * into t;
  perform set_config('app.adding_comment', '', true);
  return t;
end $$;
revoke execute on function public.add_task_comment(text, text) from anon, public;
grant execute on function public.add_task_comment(text, text) to authenticated;

-- Only add_task_comment may change comments; everything else needs edit rights.
create or replace function private.tasks_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me text := private.my_email();
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(me, new.created_by);
    new.created_at := now();
    new.completed_at := null;
    new.completed_by := null;
    if me is not null then new.comments := '[]'; end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if me is not null then
      if new.comments is distinct from old.comments
         and coalesce(current_setting('app.adding_comment', true), '') <> '1' then
        raise exception 'Comments can only be added with the comment box.';
      end if;
      if not private.can_edit(old.space)
         and (to_jsonb(new) - 'comments' - 'updated_at') <> (to_jsonb(old) - 'comments' - 'updated_at') then
        raise exception 'You cannot edit tasks in this space.';
      end if;
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

-- Editing a task directly now needs edit rights (comments go through the function above).
alter policy tasks_update on public.tasks
  using (private.can_edit(space)) with check (private.can_edit(space));

-- Doc search: title or text match, with a short snippet. Runs as the caller,
-- so it only finds docs they can see.
create or replace function public.search_docs(q text)
returns table (id text, title text, snippet text)
language sql stable security invoker set search_path = '' as $$
  select d.id, d.title,
         case when strpos(lower(d.body), lower(q)) > 0
              then substr(d.body, greatest(1, strpos(lower(d.body), lower(q)) - 40), length(q) + 100)
              else '' end
  from public.docs d
  where length(trim(q)) > 0
    and (strpos(lower(d.title), lower(q)) > 0 or strpos(lower(d.body), lower(q)) > 0)
  order by d.updated_at desc
  limit 50
$$;
revoke execute on function public.search_docs(text) from anon, public;
grant execute on function public.search_docs(text) to authenticated;
