-- Drive folders, renaming and moving.
--
--   * Each space gets its own folder in Google Drive (made by the "drive" function the first
--     time someone uploads to it), and a space can hold folders of its own (drive_files.folder,
--     one level, '' = straight in the space).
--   * drive_folder: the Google Drive folder the file sits in. Empty for files uploaded before
--     this change (they are loose in the main folder) and for files whose space was deleted;
--     the owner and admins sort those with "Sort into folders" on the Drive page.
--   * The uploader, the owner and admins can rename and move a file (same people who can
--     delete it). Renames and moves land in History.

alter table public.drive_files add column if not exists folder text not null default ''
  check (length(folder) <= 100 and position('/' in folder) = 0);
alter table public.drive_files add column if not exists drive_folder text;
alter table public.drive_files add column if not exists updated_at timestamptz;
alter table public.drive_files add column if not exists updated_by text;

create index if not exists drive_files_unsorted_idx on public.drive_files (id) where drive_folder is null;

-- Who uploaded it, when, and where the file lives in Drive never change after upload.
create or replace function private.drive_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.name := trim(new.name);
  new.folder := trim(coalesce(new.folder, ''));
  if tg_op = 'INSERT' then
    new.uploaded_by := coalesce(private.my_email(), new.uploaded_by);
    new.uploaded_at := now();
    new.updated_at := null;
    new.updated_by := null;
    return new;
  end if;
  new.drive_id := old.drive_id;
  new.url := old.url;
  new.mime := old.mime;
  new.size := old.size;
  new.uploaded_by := old.uploaded_by;
  new.uploaded_at := old.uploaded_at;
  -- Moved without saying where it now is in Drive (e.g. its space was deleted): sort it again later.
  if (new.space, new.folder) is distinct from (old.space, old.folder)
     and new.drive_folder is not distinct from old.drive_folder then
    new.drive_folder := null;
  end if;
  if (new.name, new.space, new.folder) is distinct from (old.name, old.space, old.folder) then
    new.updated_at := now();
    new.updated_by := coalesce(private.my_email(), old.updated_by);
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;
drop trigger if exists drive_before on public.drive_files;
create trigger drive_before before insert or update on public.drive_files
  for each row execute function private.drive_before();

create or replace function private.drive_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  place text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'INSERT' then
    perform private.log('uploaded', 'file', new.id, new.name, new.space);
  elsif tg_op = 'DELETE' then
    perform private.log('deleted', 'file', old.id, old.name, old.space);
  else
    if new.name is distinct from old.name then
      perform private.log('renamed', 'file', new.id, new.name, new.space, old.name);
    end if;
    if (new.space, new.folder) is distinct from (old.space, old.folder) then
      select s.name into place from public.spaces s where s.id = new.space;
      place := coalesce(place, new.space) || case when new.folder <> '' then ' / ' || new.folder else '' end;
      perform private.log('moved', 'file', new.id, new.name, new.space, place);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists drive_log on public.drive_files;
create trigger drive_log after insert or update or delete on public.drive_files
  for each row execute function private.drive_log();

-- Rename and move: the uploader, or the owner and admins, into a space they can see.
drop policy if exists drive_update on public.drive_files;
create policy drive_update on public.drive_files for update to authenticated
  using (private.can_see(space) and ((select private.is_admin()) or uploaded_by = (select private.my_email())))
  with check (private.can_see(space) and ((select private.is_admin()) or uploaded_by = (select private.my_email())));
