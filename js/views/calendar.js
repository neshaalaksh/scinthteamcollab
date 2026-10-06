import { S, can, inSpace, isDone, routinesOn, staleCheck, person, spaceName } from '../state.js';
import { call } from '../api.js';
import { $, $$, esc, isoDate, addDays, parseDate, lsGet, lsSet, fmtTime, openModal } from '../util.js';
import { openTask } from './tasks.js';

// What shows depends on the role:
//   owner/admin  tasks, everyone's routine ticks, every scheduled call
//   member       their tasks and their own routine ticks
//   guest        only their meetings (scheduled calls) and the deadlines tagged with their name
const prefs = { mode: 'month', tasks: true, routines: true, meetings: true, ...lsGet('teamspace.calprefs', {}) };
const savePrefs = () => lsSet('teamspace.calprefs', prefs);
let anchor = isoDate();

const meetingsOn = (d) => S.calls
  .filter((c) => c.status === 'scheduled' && c.meetingAt && isoDate(new Date(c.meetingAt)) === d)
  .filter((c) => can.guest() || inSpace(c))
  .sort((a, b) => a.meetingAt.localeCompare(b.meetingAt));

export default {
  title: 'Calendar',
  async render(el) {
    const today = isoDate();
    const guest = can.guest();
    const a = parseDate(anchor);
    let start;
    let days;
    let label;
    if (prefs.mode === 'month') {
      const first = new Date(a.getFullYear(), a.getMonth(), 1);
      start = addDays(isoDate(first), -((first.getDay() + 6) % 7));
      const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
      const span = Math.round((last - parseDate(start)) / 86400000) + 1;
      days = Math.ceil(span / 7) * 7;
      label = a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    } else {
      start = addDays(anchor, -((a.getDay() + 6) % 7));
      days = 7;
      label = `Week of ${parseDate(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    const end = addDays(start, days - 1);
    const toggle = (id, key, text) => `<label class="check"><input type="checkbox" id="${id}" ${prefs[key] ? 'checked' : ''}> ${text}</label>`;

    $('#topbar-slot').innerHTML = `
      <button class="icon-btn" data-step="-1" aria-label="Previous">‹</button>
      <b class="range-label">${esc(label)}</b>
      <button class="icon-btn" data-step="1" aria-label="Next">›</button>
      <button class="btn" data-today>Today</button>
      <span class="grow"></span>
      ${guest ? '' : toggle('cal-tasks', 'tasks', 'Tasks') + toggle('cal-routines', 'routines', 'Routines')}
      ${guest || can.admin() ? toggle('cal-meetings', 'meetings', 'Meetings') : ''}
      <div class="seg" role="group" aria-label="Range">
        <button data-mode="month" class="${prefs.mode === 'month' ? 'on' : ''}">Month</button>
        <button data-mode="week" class="${prefs.mode === 'week' ? 'on' : ''}">Week</button>
      </div>`;

    const stale = staleCheck();
    const [{ checks }, deadlines] = await Promise.all([
      prefs.routines && !guest ? call('daily.get', { from: start, to: end }).catch(() => ({ checks: [] })) : { checks: [] },
      guest && prefs.tasks ? call('client.deadlines').catch(() => []) : [],
    ]);
    if (stale()) return;   // moved to another page while loading

    const tasks = guest ? [] : S.tasks.filter(inSpace);
    const showMeetings = (guest || can.admin()) && prefs.meetings;
    const cells = Array.from({ length: days }, (_, i) => {
      const d = addDays(start, i);
      const inMonth = prefs.mode === 'week' || parseDate(d).getMonth() === a.getMonth();
      const events = [];
      if (showMeetings) {
        meetingsOn(d).forEach((c) => events.push(`<button class="ev ev-meet" data-call="${esc(c.id)}" title="${esc(c.topic)}">${esc(fmtTime(c.meetingAt))} ${esc(c.topic)}</button>`));
      }
      if (guest && prefs.tasks) {
        deadlines.filter((t) => t.due === d).forEach((t) => {
          const cls = t.done ? 'ev-done' : d < today ? 'ev-late' : 'ev-due';
          events.push(`<span class="ev ${cls}" title="Deadline: ${esc(t.title)}">${t.done ? '✓ ' : ''}${esc(t.title)}</span>`);
        });
      }
      if (!guest && prefs.tasks) {
        tasks.filter((t) => t.completedAt && isoDate(new Date(t.completedAt)) === d)
          .forEach((t) => events.push(`<button class="ev ev-done" data-task="${esc(t.id)}" title="${esc(t.title)}">${esc(t.title)}</button>`));
        tasks.filter((t) => !isDone(t) && t.due === d)
          .forEach((t) => events.push(`<button class="ev ${d < today ? 'ev-late' : 'ev-due'}" data-task="${esc(t.id)}" title="${esc(t.title)}">${esc(t.title)}</button>`));
      }
      let routine = '';
      if (prefs.routines && d <= today && !guest) {
        // Same count as the Daily page: only ticks for routines shown here, by people expected to do them.
        const todays = routinesOn(d);
        const expected = todays.reduce((n, r) => n + r.people.length, 0);
        const ticked = checks.filter((c) => c.date === d && todays.some((r) => r.id === c.routineId && r.people.includes(c.email))).length;
        if (expected) routine = `${ticked}/${expected}`;
      }
      return `<div class="cal-cell ${inMonth ? '' : 'out'} ${d === today ? 'is-today' : ''}">
        <div class="cal-top"><span class="cal-num">${parseDate(d).getDate()}</span>${routine ? `<a class="cal-routines" href="#/daily/${d}" title="Routines ticked">${routine}</a>` : ''}</div>
        ${events.join('')}
      </div>`;
    }).join('');

    const legend = guest
      ? '<span><i class="sw ev-meet"></i>Meeting</span><span><i class="sw ev-due"></i>Deadline</span><span><i class="sw ev-late"></i>Overdue</span><span><i class="sw ev-done"></i>Done</span><span><a href="#/calls">Request a call</a></span>'
      : `${showMeetings ? '<span><i class="sw ev-meet"></i>Meeting</span>' : ''}<span><i class="sw ev-due"></i>Task due</span><span><i class="sw ev-done"></i>Task done</span><span><i class="sw ev-late"></i>Overdue</span>
        <span>"4/5" = routine ticks that day. Click it to open Daily.</span>`;
    el.innerHTML = `
      <div class="cal ${prefs.mode}">
        <div class="cal-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </div>
      <div class="legend">${legend}</div>`;

    const rerender = () => { S.view++; this.render(el); };   // a newer render replaces this one
    $$('[data-step]').forEach((b) => b.onclick = () => {
      const step = Number(b.dataset.step);
      if (prefs.mode === 'month') { const d = parseDate(anchor); anchor = isoDate(new Date(d.getFullYear(), d.getMonth() + step, 1)); }
      else anchor = addDays(anchor, step * 7);
      rerender();
    });
    $('[data-today]').onclick = () => { anchor = isoDate(); rerender(); };
    $$('[data-mode]').forEach((b) => b.onclick = () => { prefs.mode = b.dataset.mode; savePrefs(); rerender(); });
    [['#cal-tasks', 'tasks'], ['#cal-routines', 'routines'], ['#cal-meetings', 'meetings']].forEach(([sel, key]) => {
      const box = $(sel);
      if (box) box.onchange = (e) => { prefs[key] = e.target.checked; savePrefs(); rerender(); };
    });
    $$('[data-task]', el).forEach((b) => b.onclick = () => openTask(b.dataset.task, rerender));
    $$('[data-call]', el).forEach((b) => b.onclick = () => showMeeting(S.calls.find((c) => c.id === b.dataset.call)));
  },
};

function showMeeting(c) {
  if (!c) return;
  const startAt = new Date(c.meetingAt);
  const endAt = new Date(startAt.getTime() + (c.duration || 0) * 60000);
  const when = `${startAt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${fmtTime(startAt)} to ${fmtTime(endAt)}`;
  const box = openModal(`
    <div class="modal-head"><h2>${esc(c.topic)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="stack">
      <p><b>${esc(when)}</b></p>
      ${can.guest() ? '' : `<p class="muted">With ${esc(person(c.email)?.name || c.email)} · ${esc(spaceName(c.space))}</p>`}
      ${c.link ? `<p><a class="btn primary" href="${esc(c.link)}" target="_blank" rel="noopener">Join the call ↗</a></p><p class="small muted">${esc(c.link)}</p>` : '<p class="muted">No meeting link yet.</p>'}
      ${c.reply ? `<p>${esc(c.reply)}</p>` : ''}
      ${c.notes ? `<p class="small muted">${esc(c.notes)}</p>` : ''}
      <div class="row end"><a class="btn" href="#/calls" data-close>${can.guest() ? 'My call requests' : 'Open Calls'}</a></div>
    </div>`);
  return box;
}
