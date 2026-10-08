// Everything the app has loaded, plus helpers that mirror the backend's
// permission rules (the backend still checks; these just hide buttons).

import { call } from './api.js';
import { lsGet, lsSet, toast, dayStartIso, addDays } from './util.js';
import { CONFIG, DONE, MAIN_SPACE } from './config.js';

export const S = {
  me: null,
  team: [],
  spaces: [],
  tasks: [],
  routines: [],      // active routines (what admins manage)
  allRoutines: [],   // including removed ones, so past days still count them
  docs: [],
  sheets: [],
  files: [],
  calls: [],
  events: [],   // calendar events and deadlines
  space: lsGet('teamspace.space', 'all'),
  view: 0,   // bumped on every page render, so a slow render can tell it has been replaced
};

// Call at the start of a view's render; after any await, `if (stale()) return;`.
export function staleCheck() {
  const n = S.view;
  return () => S.view !== n;
}

export async function loadAll() {
  const data = await call('bootstrap');
  Object.assign(S, data);
  S.allRoutines = data.routines || [];
  S.routines = S.allRoutines.filter((r) => r.active);
  // Main space first, then client spaces by name.
  S.spaces.sort((a, b) => (b.id === MAIN_SPACE) - (a.id === MAIN_SPACE) || a.name.localeCompare(b.name));
  if (S.space !== 'all' && !S.spaces.some((s) => s.id === S.space)) setSpace('all');
}

export function setSpace(id) {
  S.space = id;
  lsSet('teamspace.space', id);
}

// Runs an API call, showing the error as a toast. Returns null on failure.
export async function act(action, data) {
  try {
    return await call(action, data);
  } catch (err) {
    if (err.code !== 'AUTH') toast(err.message, 'error');
    return null;
  }
}

const RANK = { guest: 1, member: 2, admin: 3, owner: 4 };
const rank = () => RANK[S.me?.role] || 0;

export const can = {
  admin: () => rank() >= RANK.admin,
  owner: () => S.me?.role === 'owner',
  guest: () => S.me?.role === 'guest',
  work: () => rank() >= RANK.member,
  edit: (space) => rank() >= RANK.member && canSee(space),
  remove: (createdBy, space) => canSee(space) && (rank() >= RANK.admin || (rank() >= RANK.member && createdBy === S.me.email)),
  tickFor: (email) => rank() >= RANK.admin || (rank() >= RANK.member && email === S.me.email),
  // Drive: anyone who can see the space uploads; the uploader or admins rename, move and delete.
  upload: (space) => rank() >= RANK.guest && canSee(space),
  removeFile: (f) => canSee(f.space) && (rank() >= RANK.admin || f.uploadedBy === S.me.email),
  editFile: (f) => can.removeFile(f),
};

// The pages each role has, in menu order. Guests are clients: Drive, Calendar and calls only.
// Members' Calls page lists the calls they're invited to.
const VIEWS = {
  guest: ['drive', 'calendar', 'calls'],
  member: ['home', 'tasks', 'calendar', 'daily', 'docs', 'sheets', 'drive', 'calls'],
  admin: ['home', 'tasks', 'calendar', 'daily', 'history', 'docs', 'sheets', 'drive', 'calls', 'team'],
};
export function allowedViews() {
  return VIEWS[rank() >= RANK.admin ? 'admin' : S.me?.role === 'member' ? 'member' : 'guest'];
}

function canSee(space) {
  return personCanSee(S.me, space);
}

// Same rule as private.can_see in the database, for any person. team.spaces lists the
// client spaces someone sees ('*' = all of them); members always see the main space, guests never.
export function personCanSee(p, space) {
  if (!p) return false;
  if (RANK[p.role] >= RANK.admin) return true;
  const sp = space || MAIN_SPACE;
  if (sp === MAIN_SPACE) return p.role !== 'guest';
  const s = String(p.spaces ?? '').trim();
  if (s === '*' && p.role !== 'guest') return true;
  return s.split(',').map((x) => x.trim()).includes(sp);
}

export function person(email) {
  return S.team.find((p) => p.email === email) || (email ? { email, name: email.split('@')[0], role: '' } : null);
}

export function spaceById(id) {
  return S.spaces.find((s) => s.id === id);
}

export function spaceName(id) {
  return spaceById(id || MAIN_SPACE)?.name || (id || 'Scinth');
}

// " · Space name" for a space this person can see, or nothing (e.g. a member invited to a call
// in a client space they don't have: better no label than its internal id).
export const spaceSuffix = (id) => { const s = spaceById(id || MAIN_SPACE); return s ? ` · ${s.name}` : ''; };

// Where a new item goes: the space picked in the sidebar, else the main space.
export const defaultSpace = () => (S.space !== 'all' && can.edit(S.space) ? S.space : MAIN_SPACE);

export const inSpace = (item) => S.space === 'all' || (item.space || MAIN_SPACE) === S.space;

export const statusById = (id) => CONFIG.statuses.find((s) => s.id === id) || CONFIG.statuses[0];
export const priorityById = (id) => CONFIG.priorities.find((p) => p.id === id);
export const isDone = (t) => t.status === DONE;

// How a routine was set up on a date: its history says how it looked until each change.
const ms = (ts) => new Date(ts).getTime();   // times come as "...+00:00" or "...Z"; compare them as times
function setupOn(r, dayEnd) {
  const past = (r.history || []).filter((h) => ms(h.until) > dayEnd).sort((a, b) => ms(a.until) - ms(b.until))[0];
  if (!past) return { assignees: r.assignees, days: r.days, space: r.space };
  return { assignees: past.assignees ?? 'everyone', days: past.days || [], space: past.space || MAIN_SPACE };
}

// Routines that applied on a date, with the people expected to do them, set up as they were that day.
// Owner and admins see everyone; members only themselves.
export function routinesOn(date) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const dayStart = ms(dayStartIso(date));
  const dayEnd = ms(dayStartIso(addDays(date, 1)));
  const members = S.team.filter((p) => p.role !== 'guest');
  return S.allRoutines
    .filter((r) => (!r.createdAt || ms(r.createdAt) < dayEnd) && (!r.removedAt || ms(r.removedAt) > dayStart))
    .map((r) => ({ ...r, ...setupOn(r, dayEnd) }))
    .filter((r) => (r.days?.length ? r.days : [1, 2, 3, 4, 5]).includes(weekday))
    .filter(inSpace)
    .map((r) => {
      // Only people who can see the routine's space can tick it.
      const able = members.filter((p) => personCanSee(p, r.space)).map((p) => p.email);
      let people = r.assignees === 'everyone' ? able : r.assignees.filter((e) => able.includes(e));
      if (!can.admin()) people = people.filter((e) => e === S.me.email);
      return { ...r, people };
    })
    .filter((r) => r.people.length || can.admin());
}
