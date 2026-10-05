-- Team-wide pinning for sheets (stars stay personal, in the browser).
alter table public.sheet_links add column if not exists pinned boolean not null default false;
