import { S, can, person, spaceName, staleCheck, statusById } from '../state.js';
import { call } from '../api.js';
import { $, $$, esc, avatar, isoDate, addDays, dayStartIso, fmtDay, fmtTime, parseDate, lsGet, lsSet } from '../util.js';
import { openTask } from './tasks.js';

const prefs = lsGet('teamspace.histprefs', { filter: 'completed', who: 'all', days: 7 });
const save = () => lsSet('teamspace.histprefs', prefs);

const FILTERS = {
  completed: (a) => (a.type === 'task' && a.action === 'completed') || (a.type === 'routine' && a.action === 'ticked'),
  tasks: (a) => a.type === 'task' && a.action === 'completed',
  routines: (a) => a.type === 'routine' && a.action === 'ticked',
  everything: () => true,
};

const ICON = {
  completed: ['✓', 'k-done'], ticked: ['↻', 'k-routine'], created: ['+', 'k-new'], commented: ['“', 'k-note'],
  deleted: ['✕', 'k-del'], removed: ['✕', 'k-del'], reopened: ['↺', 'k-new'], edited: ['✎', 'k-note'],
  uploaded: ['↑', 'k-new'], renamed: ['✎', 'k-note'], requested: ['☎', 'k-note'], scheduled: ['☎', 'k-done'], declined: ['✕', 'k-del'], cancelled: ['✕', 'k-del'],
};

function describe(a) {
  const what = { task: 'task', doc: 'doc', routine: 'routine', sheet: 'sheet', person: 'person', space: 'space', file: 'file', call: 'call', daily: '' }[a.type] ?? a.type;
  if (a.type === 'event') return `${esc(a.action[0].toUpperCase() + a.action.slice(1))} calendar event <b>${esc(a.title)}</b>`;
  if (a.type === 'call') {
    const verb = { requested: 'Requested a call', scheduled: 'Scheduled the call', declined: 'Declined the call', cancelled: 'Cancelled the call' }[a.action] || 'Updated the call';
    return `${verb} <b>${esc(a.title)}</b>`;
  }
  if (a.type === 'routine' && a.action === 'ticked') return `<b>${esc(a.title)}</b>`;
  if (a.type === 'task' && a.action === 'completed') return `<b>${esc(a.title)}</b>`;
  if (a.type === 'file' && a.action === 'moved') return `Moved file <b>${esc(a.title)}</b> to ${esc(a.detail)}`;
  if (a.type === 'file' && a.action === 'renamed') return `Renamed file <b>${esc(a.detail)}</b> to <b>${esc(a.title)}</b>`;
  if (a.action === 'moved') return `Moved <b>${esc(a.title)}</b> to ${esc(statusById(a.detail).label)}`;
  if (a.action === 'changed role') return `Changed <b>${esc(a.title)}</b>'s role: ${esc(a.detail)}`;
  if (a.type === 'daily') return 'Posted daily update';
  return `${esc(a.action[0].toUpperCase() + a.action.slice(1))} ${what} <b>${esc(a.title)}</b>`;
}

export default {
  title: 'History',
  async render(el) {
    if (!can.admin()) {
      el.innerHTML = '<div class="empty">History is for the owner and admins.</div>';
      return;
    }
    const today = isoDate();
    const fromDay = addDays(today, -(prefs.days - 1));
    $('#topbar-slot').innerHTML = `
      <div class="seg" role="group" aria-label="Show">
        ${[['completed', 'Completed'], ['tasks', 'Tasks'], ['routines', 'Routines'], ['everything', 'Everything']]
          .map(([k, label]) => `<button data-filter="${k}" class="${prefs.filter === k ? 'on' : ''}">${label}</button>`).join('')}
      </div>
      <span class="grow"></span>
      ${can.admin() ? `<select class="input" id="hist-who" aria-label="Person"><option value="all">Everyone</option>${S.team.filter((p) => p.role !== 'guest').map((p) => `<option value="${esc(p.email)}">${esc(p.name)}</option>`).join('')}</select>` : ''}
      <select class="input" id="hist-days" aria-label="Date range">
        ${[[1, 'Today'], [7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']].map(([n, l]) => `<option value="${n}" ${prefs.days === n ? 'selected' : ''}>${l}</option>`).join('')}
      </select>`;
    if ($('#hist-who')) $('#hist-who').value = prefs.who;

    el.innerHTML = '<div class="loading">Loading history…</div>';
    const stale = staleCheck();
    const rows = await call('history.get', { from: dayStartIso(fromDay), to: new Date(Date.now() + 60000).toISOString() });
    if (stale()) return;   // moved to another page while loading
    const who = can.admin() ? prefs.who : S.me.email;
    // A routine can be ticked and unticked; only its latest tick counts.
    const latest = new Map();
    rows.forEach((a) => {
      const key = `${a.itemId}|${a.email}|${a.detail}`;
      if ((a.action === 'ticked' || a.action === 'unticked') && !latest.has(key)) latest.set(key, a);
    });
    // Same for tasks: completed, reopened and completed again counts once, and a reopened task not at all.
    const lastState = new Map();
    rows.forEach((a) => {
      if (a.type === 'task' && (a.action === 'completed' || a.action === 'reopened') && !lastState.has(a.itemId)) lastState.set(a.itemId, a);
    });
    const live = rows.filter((a) => {
      if (a.action === 'ticked') return latest.get(`${a.itemId}|${a.email}|${a.detail}`) === a;
      if (a.type === 'task' && a.action === 'completed') return lastState.get(a.itemId) === a;
      return true;
    });
    // A tick belongs to the day of the routine (ticking yesterday's routine today counts for yesterday).
    const dayOf = (a) => (a.action === 'ticked' && /^\d{4}-\d{2}-\d{2}$/.test(a.detail) ? a.detail : isoDate(new Date(a.at)));
    const list = live.filter((a) => (who === 'all' || a.email === who) && FILTERS[prefs.filter](a));

    const byDay = new Map();
    list.forEach((a) => {
      const d = dayOf(a);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(a);
    });

    const counted = live.filter((a) => (who === 'all' || a.email === who) && FILTERS.completed(a));
    const barDays = Array.from({ length: Math.min(prefs.days, 14) }, (_, i) => addDays(today, -(Math.min(prefs.days, 14) - 1 - i)));
    const perDay = barDays.map((d) => counted.filter((a) => dayOf(a) === d).length);
    const max = Math.max(1, ...perDay);
    const perPerson = S.team.filter((p) => p.role !== 'guest' && (who === 'all' || p.email === who)).map((p) => ({
      p,
      tasks: counted.filter((a) => a.email === p.email && a.type === 'task').length,
      ticks: counted.filter((a) => a.email === p.email && a.type === 'routine').length,
    })).sort((a, b) => (b.tasks + b.ticks) - (a.tasks + a.ticks));

    el.innerHTML = `
      <div class="history-grid">
        <section class="card feed">
          ${byDay.size ? [...byDay.entries()].map(([d, items]) => `
            <div class="day-head"><h2>${esc(fmtDay(d))}${d !== today && d !== addDays(today, -1) ? '' : ` · ${esc(parseDate(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}`}</h2>
              <span class="small muted">${items.filter(FILTERS.completed).length} done</span></div>
            ${items.map((a) => {
              const [icon, cls] = ICON[a.action] || ['•', 'k-note'];
              const p = person(a.email);
              const clickable = a.type === 'task' && S.tasks.some((t) => t.id === a.itemId);
              return `<div class="ev-row">
                <span class="k ${cls}" aria-hidden="true">${icon}</span>
                <span class="grow">${clickable ? `<button class="link-btn" data-task="${esc(a.itemId)}">${describe(a)}</button>` : describe(a)}
                  <span class="muted"> · ${esc(spaceName(a.space))}</span>${a.action === 'commented' ? `<div class="small muted">${esc(a.detail)}</div>` : ''}</span>
                <span class="who">${avatar(p, 22)} ${esc(p.name)}</span>
                <span class="time">${esc(fmtTime(a.at))}</span>
              </div>`;
            }).join('')}`).join('') : '<div class="empty">Nothing in this range yet.</div>'}
        </section>
        <aside class="history-side">
          <section class="card">
            <h2>Done per day</h2>
            <div class="bars" role="img" aria-label="Completed items per day">
              ${barDays.map((d, i) => `<div class="bar-col"><span class="bar-n">${perDay[i] || ''}</span><div class="bar" style="height:${Math.round((perDay[i] / max) * 100)}%"></div><span class="bar-d">${esc(parseDate(d).toLocaleDateString(undefined, barDays.length > 7 ? { day: 'numeric' } : { weekday: 'short' }))}</span></div>`).join('')}
            </div>
          </section>
          <section class="card">
            <h2>By person</h2>
            ${perPerson.map(({ p, tasks, ticks }) => `<div class="team-row">${avatar(p, 24)}<span class="grow">${esc(p.name)}</span><b>${tasks} task${tasks === 1 ? '' : 's'} · ${ticks} tick${ticks === 1 ? '' : 's'}</b></div>`).join('')}
            <p class="small muted">${can.admin() ? 'Owner and admins see everyone.' : 'You see your own history.'}</p>
          </section>
        </aside>
      </div>`;

    const rerender = () => { S.view++; this.render(el); };   // a newer render replaces this one
    $$('[data-filter]').forEach((b) => b.onclick = () => { prefs.filter = b.dataset.filter; save(); rerender(); });
    $('#hist-days').onchange = (e) => { prefs.days = Number(e.target.value); save(); rerender(); };
    if ($('#hist-who')) $('#hist-who').onchange = (e) => { prefs.who = e.target.value; save(); rerender(); };
    $$('[data-task]', el).forEach((b) => b.onclick = () => openTask(b.dataset.task));
  },
};
