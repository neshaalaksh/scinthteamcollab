// Names and shapes of the shared JSON files, plus small helpers on top.

import { store } from './store.js';
import { CONFIG } from './config.js';

export const C = {
  team: ['team', []],
  tasks: ['tasks', []],
  docs: ['docs', []],
  sheets: ['sheets', []],
  routines: ['routines', []],
};

export const dailyFile = (isoDate) => `daily-${isoDate.slice(0, 7)}`;

export const get = (key) => store.get(...C[key]);

export const mutate = (key, change, message) => store.mutate(C[key][0], C[key][1], change, message);

export async function getDaily(isoDate) {
  return store.get(dailyFile(isoDate), { days: {} });
}

export function mutateDay(isoDate, change, message) {
  return store.mutate(dailyFile(isoDate), { days: {} }, (file) => {
    file.days[isoDate] ??= { checks: {}, updates: {} };
    change(file.days[isoDate]);
    return file;
  }, message);
}

export const statusById = (id) => CONFIG.statuses.find((s) => s.id === id) || CONFIG.statuses[0];
export const priorityById = (id) => CONFIG.priorities.find((p) => p.id === id);
export const doneStatusIds = new Set(CONFIG.statuses.filter((s) => s.done).map((s) => s.id));

// Team list, making sure the current user is on it.
export async function getTeam() {
  const [team, me] = await Promise.all([get('team'), store.whoami()]);
  if (!team.some((p) => p.login === me.login)) {
    try {
      return await mutate('team', (t) => {
        if (!t.some((p) => p.login === me.login)) t.push({ login: me.login, name: me.name });
      }, `add ${me.login} to team`);
    } catch {
      return [...team, me];
    }
  }
  return team;
}

export function personFinder(team) {
  return (login) => team.find((p) => p.login === login) || (login ? { login, name: login } : null);
}

// Which routines apply on a given date and to whom.
export function routinesFor(routines, team, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  return routines
    .filter((r) => (r.days || [1, 2, 3, 4, 5]).includes(weekday))
    .filter((r) => !r.startDate || r.startDate <= isoDate)
    .map((r) => ({
      ...r,
      people: r.assignees === 'everyone' || !r.assignees?.length
        ? team.map((p) => p.login)
        : r.assignees,
    }));
}
