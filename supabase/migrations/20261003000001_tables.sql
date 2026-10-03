-- Teamspace tables. One table per tab of the old "Teamspace DB" Google Sheet.
-- Who may read or write what lives in 20261003000002_security.sql.

create extension if not exists pgcrypto;

create schema if not exists private;

-- 12-character ids, like the Apps Script backend made.
create or replace function private.new_id() returns text
language sql volatile set search_path = '' as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;

create table public.team (
  email       text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name        text not null check (length(name) <= 100),
  role        text not null default 'member' check (role in ('owner', 'admin', 'member', 'guest')),
  spaces      text not null default '*',          -- '*' = every space, else comma-separated space ids
  added_at    timestamptz not null default now(),
  last_active timestamptz
);

create table public.spaces (
  id         text primary key default private.new_id(),
  name       text not null check (length(name) between 1 and 100),
  color      text not null default '#0F766E',
  created_at timestamptz not null default now()
);

create table public.tasks (
  id           text primary key default private.new_id(),
  title        text not null check (length(title) between 1 and 300),
  description  text not null default '',
  status       text not null default 'todo',
  assignee     text,
  due          date,
  priority     text,
  space        text references public.spaces (id) on delete set null,
  checklist    jsonb not null default '[]',
  comments     jsonb not null default '[]',
  sort_order   double precision not null default 0,
  created_at   timestamptz not null default now(),
  created_by   text,
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,
  completed_by text
);

create table public.routines (
  id         text primary key default private.new_id(),
  title      text not null check (length(title) between 1 and 300),
  notes      text not null default '',
  assignees  text[],                               -- null = everyone
  days       smallint[] not null default '{1,2,3,4,5}',   -- 0 = Sunday
  space      text references public.spaces (id) on delete set null,
  active     boolean not null default true,       -- removed routines stay so History keeps their names
  created_at timestamptz not null default now(),
  created_by text
);

create table public.daily_checks (
  date       date not null,
  routine_id text not null references public.routines (id) on delete cascade,
  email      text not null,                        -- whose routine it is
  at         timestamptz not null default now(),
  ticked_by  text,                                 -- who ticked it (an admin can tick for someone)
  primary key (date, routine_id, email)
);

create table public.updates (
  date      date not null,
  email     text not null,
  yesterday text not null default '' check (length(yesterday) <= 2000),
  today     text not null default '' check (length(today) <= 2000),
  blockers  text not null default '' check (length(blockers) <= 2000),
  at        timestamptz not null default now(),
  primary key (date, email)
);

create table public.docs (
  id         text primary key default private.new_id(),
  title      text not null default 'Untitled',
  space      text references public.spaces (id) on delete set null,
  folder     text not null default '',
  pinned     boolean not null default false,
  version    integer not null default 1,
  body       text not null default '' check (length(body) <= 1000000),
  updated_at timestamptz not null default now(),
  updated_by text,
  locked_by  text,
  locked_at  timestamptz,
  created_at timestamptz not null default now(),
  created_by text
);

create table public.doc_versions (
  doc_id   text not null references public.docs (id) on delete cascade,
  version  integer not null,
  title    text not null,
  body     text not null,
  saved_at timestamptz not null,
  saved_by text,
  primary key (doc_id, version)
);

create table public.sheet_links (
  id         text primary key default private.new_id(),
  name       text not null check (length(name) between 1 and 200),
  url        text not null check (url ~ '^https://docs\.google\.com/'),
  mode       text not null default 'edit' check (mode in ('edit', 'view')),
  space      text references public.spaces (id) on delete set null,
  height     integer not null default 0,
  sort_order double precision not null default 0,
  added_by   text,
  added_at   timestamptz not null default now()
);

create table public.activity (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  email   text not null,
  action  text not null,
  type    text not null,
  item_id text,
  title   text,
  space   text,
  detail  text
);

-- Indexes for the lookups the app makes (and every foreign key).
create index on public.tasks (space);
create index on public.tasks (assignee);
create index on public.tasks (due);
create index on public.routines (space);
create index on public.daily_checks (routine_id);
create index on public.daily_checks (date);
create index on public.updates (date);
create index on public.docs (space);
create index on public.sheet_links (space);
create index on public.activity (at desc);
create index on public.activity (email, at desc);
