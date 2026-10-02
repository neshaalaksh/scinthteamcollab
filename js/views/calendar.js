import { S, inSpace, isDone, routinesOn } from '../state.js';
import { call } from '../api.js';
import { $, $$, esc, isoDate, addDays, parseDate, lsGet, lsSet } from '../util.js';
import { openTask } from './tasks.js';

const prefs = lsGet('teamspace.calprefs', { mode: 'month', tasks: true, routines: true });
let anchor = isoDate();

export default {
  title: 'Calendar',
  async render(el) {
    const today = isoDate();
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

    $('#topbar-slot').innerHTML = `
      <button class="icon-btn" data-step="-1" aria-label="Previous">‹</button>
      <b class="range-label">${esc(label)}</b>
      <button class="icon-btn" data-step="1" aria-label="Next">›</button>
      <button class="btn" data-today>Today</button>
      <span class="grow"></span>
      <label class="check"><input type="checkbox" id="cal-tasks" ${prefs.tasks ? 'checked' : ''}> Tasks</label>
      <label class="check"><input type="checkbox" id="cal-routines" ${prefs.routines ? 'checked' : ''}> Routines</label>
      <div class="seg" role="group" aria-label="Range">
        <button data-mode="month" class="${prefs.mode === 'month' ? 'on' : ''}">Month</button>
        <button data-mode="week" class="${prefs.mode === 'week' ? 'on' : ''}">Week</button>
      </div>`;

    const { checks } = prefs.routines && S.me.role !== 'guest'
      ? await call('daily.get', { from: start, to: end }).catch(() => ({ checks: [] }))
      : { checks: [] };

    const tasks = S.tasks.filter(inSpace);
    const cells = Array.from({ length: days }, (_, i) => {
      const d = addDays(start, i);
      const inMonth = prefs.mode === 'week' || parseDate(d).getMonth() === a.getMonth();
      const events = !prefs.tasks ? [] : [
        ...tasks.filter((t) => t.completedAt && isoDate(new Date(t.completedAt)) === d).map((t) => ({ t, cls: 'ev-done' })),
        ...tasks.filter((t) => !isDone(t) && t.due === d).map((t) => ({ t, cls: d < today ? 'ev-late' : 'ev-due' })),
      ];
      let routine = '';
      if (prefs.routines && d <= today && S.me.role !== 'guest') {
        const expected = routinesOn(d).reduce((n, r) => n + r.people.length, 0);
        const ticked = checks.filter((c) => c.date === d).length;
        if (expected) routine = `${Math.min(ticked, expected)}/${expected}`;
      }
      return `<div class="cal-cell ${inMonth ? '' : 'out'} ${d === today ? 'is-today' : ''}">
        <div class="cal-top"><span class="cal-num">${parseDate(d).getDate()}</span>${routine ? `<a class="cal-routines" href="#/daily/${d}" title="Routines ticked">${routine}</a>` : ''}</div>
        ${events.map(({ t, cls }) => `<button class="ev ${cls}" data-task="${esc(t.id)}" title="${esc(t.title)}">${esc(t.title)}</button>`).join('')}
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="cal ${prefs.mode}">
        <div class="cal-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </div>
      <div class="legend">
        <span><i class="sw ev-due"></i>Task due</span><span><i class="sw ev-done"></i>Task done</span><span><i class="sw ev-late"></i>Overdue</span>
        <span>"4/5" = routine ticks that day. Click it to open Daily.</span>
      </div>`;

    const rerender = () => this.render(el);
    $$('[data-step]').forEach((b) => b.onclick = () => {
      const step = Number(b.dataset.step);
      if (prefs.mode === 'month') { const d = parseDate(anchor); anchor = isoDate(new Date(d.getFullYear(), d.getMonth() + step, 1)); }
      else anchor = addDays(anchor, step * 7);
      rerender();
    });
    $('[data-today]').onclick = () => { anchor = isoDate(); rerender(); };
    $$('[data-mode]').forEach((b) => b.onclick = () => { prefs.mode = b.dataset.mode; lsSet('teamspace.calprefs', prefs); rerender(); });
    $('#cal-tasks').onchange = (e) => { prefs.tasks = e.target.checked; lsSet('teamspace.calprefs', prefs); rerender(); };
    $('#cal-routines').onchange = (e) => { prefs.routines = e.target.checked; lsSet('teamspace.calprefs', prefs); rerender(); };
    $$('[data-task]', el).forEach((b) => b.onclick = () => openTask(b.dataset.task, rerender));
  },
};
