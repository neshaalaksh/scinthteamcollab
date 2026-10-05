// Everything the app has loaded, plus helpers that mirror the backend's
// permission rules (the backend still checks; these just hide buttons).

import { call } from './api.js';
import { lsGet, lsSet, toast } from './util.js';
import { CONFIG, DONE } from './config.js';

export const S = {
  me: null,
  team: [],
  spaces: [],
  tasks: [],
  routines: [],
  docs: [],
  sheets: [],
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
  work: () => rank() >= RANK.member,
  edit: (space) => rank() >= RANK.member && canSee(space),
  remove: (createdBy, space) => canSee(space) && (rank() >= RANK.admin || (rank() >= RANK.member && createdBy === S.me.email)),
  tickFor: (email) => rank() >= RANK.admin || (rank() >= RANK.member && email === S.me.email),
};

function canSee(space) {
  return personCanSee(S.me, space);
}

// Same rule as private.can_see in the database, for any person.
function personCanSee(p, space) {
  if (!p) return false;
  if (RANK[p.role] >= RANK.admin) return true;
  const s = String(p.spaces || '').trim();
  if ((s === '' || s === '*') && p.role !== 'guest') return true;
  if (!space) return p.role !== 'guest';
  return s.split(',').map((x) => x.trim()).includes(space);
}

export function person(email) {
  return S.team.find((p) => p.email === email) || (email ? { email, name: email.split('@')[0], role: '' } : null);
}

export function spaceById(id) {
  return S.spaces.find((s) => s.id === id);
}

export function spaceName(id) {
  return spaceById(id)?.name || (id ? id : 'General');
}

export const inSpace = (item) => S.space === 'all' || item.space === S.space;

export const statusById = (id) => CONFIG.statuses.find((s) => s.id === id) || CONFIG.statuses[0];
export const priorityById = (id) => CONFIG.priorities.find((p) => p.id === id);
export const isDone = (t) => t.status === DONE;

// Routines that apply on a date, with the people expected to do them.
export function routinesOn(date) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const members = S.team.filter((p) => p.role !== 'guest');
  return S.routines
    .filter((r) => (r.days?.length ? r.days : [1, 2, 3, 4, 5]).includes(weekday))
    .filter(inSpace)
    .map((r) => {
      // Only people who can see the routine's space can tick it.
      const able = members.filter((p) => personCanSee(p, r.space)).map((p) => p.email);
      return { ...r, people: r.assignees === 'everyone' ? able : r.assignees.filter((e) => able.includes(e)) };
    });
}
