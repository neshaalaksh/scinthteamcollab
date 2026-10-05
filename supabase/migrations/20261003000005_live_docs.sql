-- Live co-editing for Docs.
--   * Everyone with edit rights can be in a doc at once (the edit lock is gone).
--   * The editor keeps a Yjs copy of the doc (`ydoc`) so edits merge instead of overwrite.
--     `body` is now the doc as HTML (older docs stay markdown until someone opens them).
--   * Live edits and cursors travel over a private Realtime channel named doc:<id>.
--     The policies below make sure only people who may see / edit the doc can use it.

alter table public.docs add column if not exists ydoc text check (length(ydoc) <= 4000000);

-- Same as before minus the lock: saves from several people merge in the editor, so the
-- database only keeps the newest text, bumps `version`, and snapshots old text for Versions.
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
  -- Deleting a space clears it from its docs; that must work even while one is being edited.
  if pg_trigger_depth() > 1 then return new; end if;

  if new.body <> old.body then
    -- One snapshot per editing session (after 10 quiet minutes), not one per autosave.
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

-- Search looks at the words, not the HTML tags.
create or replace function public.search_docs(q text)
returns table (id text, title text, snippet text)
language sql stable security invoker set search_path = '' as $$
  with t as (
    select d.id, d.title, d.updated_at,
           regexp_replace(regexp_replace(d.body, '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g') as txt
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

-- Who may listen to / send on a doc's live channel (topic is "doc:<doc id>").
drop policy if exists docs_live_receive on realtime.messages;
create policy docs_live_receive on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'doc:%'
    and exists (select 1 from public.docs d
                where d.id = substr(realtime.topic(), 5) and private.can_see(d.space))
  );

drop policy if exists docs_live_send on realtime.messages;
create policy docs_live_send on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'doc:%'
    and exists (select 1 from public.docs d
                where d.id = substr(realtime.topic(), 5) and private.can_edit(d.space))
  );
