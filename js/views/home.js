import { S, act, can, inSpace, routinesOn, isDone, statusById, staleCheck } from '../state.js';
import { call } from '../api.js';
import { esc, avatar, isoDate, addDays, parseDate, dueLabel, $$ } from '../util.js';
import { openTask } from './tasks.js';
import { renderReminderBar } from '../reminders.js';

// Where each card goes, so cards stack in columns with no gaps and keep their place every day.
// Wide screens: "Due this week" across the top, then three columns (what to do today on the
// left, your tasks and pinned links in the middle, reminders on the right).
// Medium: the week on top, then two columns. Phones: one column, the day's lists first.
const PLANS = {
  3: { top: ['week'], cols: [['routines', 'team'], ['tasks', 'pinned'], ['reminders']] },
  2: { top: ['week'], cols: [['routines', 'reminders'], ['tasks', 'team', 'pinned']] },
  1: { top: [], cols: [['routines', 'tasks', 'reminders', 'week', 'team', 'pinned']] },
};
const wide = matchMedia('(min-width: 1180px)');
const medium = matchMedia('(min-width: 861px)');
let rearrange = null;
const onResize = () => rearrange?.();
wide.addEventListener('change', onResize);
medium.addEventListener('change', onResize);

// Moves the cards (keeping their buttons working) into the columns for this screen width.
function arrange(root) {
  const plan = PLANS[wide.matches ? 3 : medium.matches ? 2 : 1];
  const cards = Object.fromEntries([...root.querySelectorAll('[data-card]')].map((c) => [c.dataset.card, c]));
  const group = (cls, keys) => {
    const div = document.createElement('div');
    div.className = cls;
    keys.forEach((k) => cards[k] && div.append(cards[k]));
    return div;
  };
  const cols = plan.cols.map((keys) => group('home-col', keys)).filter((c) => c.children.length);
  const grid = document.createElement('div');
  grid.className = 'home-cols';
  grid.style.setProperty('--cols', cols.length);
  grid.append(...cols);
  root.replaceChildren(...(plan.top.length ? [group('home-top', plan.top)] : []), grid);
  rearrange = () => (root.isConnected ? arrange(root) : (rearrange = null));
}

export default {
  title: 'Home',
  async render(el) {
    const today = isoDate();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const stale = staleCheck();
    const { checks } = await call('daily.get', { from: today, to: today }).catch(() => ({ checks: [] }));
    if (!S.me || stale()) return; // signed out, or moved to another page, while loading
    const todays = routinesOn(today);
    const mine = todays.filter((r) => r.people.includes(S.me.email));
    const tickedByMe = new Set(checks.filter((c) => c.email === S.me.email).map((c) => c.routineId));
    const myDone = mine.filter((r) => tickedByMe.has(r.id)).length;
    const myTasks = S.tasks.filter((t) => t.assignee === S.me.email && !isDone(t) && inSpace(t))
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 7);

    const weekStart = addDays(today, -((parseDate(today).getDay() + 6) % 7));
    const fullWeek = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const dueThisWeek = S.tasks.filter((t) => t.due && !isDone(t) && inSpace(t) && t.due >= fullWeek[0] && t.due <= fullWeek[6]);
    // Mon–Fri, plus the weekend when something is due then (so those tasks don't vanish).
    const weekDays = dueThisWeek.some((t) => t.due > fullWeek[4]) ? fullWeek : fullWeek.slice(0, 5);

    const people = S.team.filter((p) => p.role !== 'guest').map((p) => {
      const expected = todays.filter((r) => r.people.includes(p.email));
      const done = expected.filter((r) => checks.some((c) => c.routineId === r.id && c.email === p.email)).length;
      return { p, done, total: expected.length };
    }).filter((x) => x.total);

    const pinned = [
      ...S.docs.filter((d) => d.pinned && inSpace(d)).map((d) => ({ kind: 'DOC', name: d.title, href: `#/docs/${d.id}` })),
      ...S.sheets.filter((s) => inSpace(s) && s.pinned).map((s) => ({ kind: 'SHEET', name: s.name, href: s.url, ext: true })),
    ];

    const card = (key, html) => `<section class="card" data-card="${key}">${html}</section>`;
    const cards = {
      week: card('week', `
        <div class="card-head"><h2>Due this week</h2><a href="#/calendar">Calendar</a></div>
        ${dueThisWeek.length ? `<div class="week-strip" style="--days:${weekDays.length}">
          ${weekDays.map((d) => `<div class="week-day ${d === today ? 'is-today' : ''}">
            <b>${parseDate(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</b>
            ${dueThisWeek.filter((t) => t.due === d).map((t) => `<button class="chip-btn" data-task="${esc(t.id)}" title="${esc(t.title)}"><span class="clamp-2">${esc(t.title)}</span></button>`).join('')}
          </div>`).join('')}
        </div>` : '<p class="muted">Nothing due this week.</p>'}`),
      routines: card('routines', `
        <div class="card-head"><h2>My routines today</h2><a href="#/daily">Open Daily</a></div>
        ${mine.length ? `
          <div class="progress-inline"><div class="progress"><div style="width:${Math.round((myDone / mine.length) * 100)}%"></div></div>
            <span class="small muted"><b>${myDone} / ${mine.length}</b> done</span></div>
          <div class="check-list">
            ${mine.map((r) => `<label class="check ${tickedByMe.has(r.id) ? 'is-done' : ''}">
              <input type="checkbox" data-routine="${esc(r.id)}" ${tickedByMe.has(r.id) ? 'checked' : ''}> <span>${esc(r.title)}</span></label>`).join('')}
          </div>` : '<p class="muted">No routines for you today.</p>'}`),
      tasks: card('tasks', `
        <div class="card-head"><h2>My tasks</h2><a href="#/tasks">All tasks</a></div>
        <div class="row-list">${myTasks.length ? myTasks.map((t) => {
          const due = dueLabel(t.due);
          return `<button class="row-btn" data-task="${esc(t.id)}"><span class="dot" style="--c:${statusById(t.status).color}"></span><span class="grow">${esc(t.title)}</span><span class="due ${due.cls}">${esc(due.text)}</span></button>`;
        }).join('') : '<p class="muted">Nothing assigned to you. Nice.</p>'}</div>`),
      reminders: '<section class="card" data-card="reminders" id="reminder-bar" aria-label="Reminders"></section>',
      team: !can.admin() ? '' : card('team', `
        <div class="card-head"><h2>Team routines today</h2><a href="#/history">History</a></div>
        ${people.map(({ p, done, total }) => `<div class="team-row">${avatar(p, 26)}<span class="grow">${esc(p.name)}</span>
          <b class="${done === total ? 'good' : done === 0 ? 'bad' : 'warn'}">${done}/${total}</b></div>`).join('') || '<p class="muted">No routines today.</p>'}`),
      pinned: card('pinned', `
        <div class="card-head"><h2>Pinned</h2></div>
        ${pinned.map((p) => `<a class="pin" href="${esc(p.href)}"${p.ext ? ' target="_blank" rel="noopener"' : ''}><span class="kind kind-${p.kind.toLowerCase()}">${p.kind}</span><span class="grow">${esc(p.name)}</span></a>`).join('') || '<p class="muted">Pin docs and sheets to share them with the team here.</p>'}`),
    };

    el.innerHTML = `
      <p class="lede">${greeting}, ${esc(S.me.name.split(' ')[0])}. ${parseDate(today).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <div class="home-layout">${Object.values(cards).join('')}</div>`;
    arrange(el.querySelector('.home-layout'));

    const bar = el.querySelector('#reminder-bar');
    if (bar) renderReminderBar(bar);
    $$('[data-task]', el).forEach((b) => b.onclick = () => openTask(b.dataset.task, () => this.render(el)));
    $$('[data-routine]', el).forEach((box) => box.onchange = async () => {
      box.closest('label').classList.toggle('is-done', box.checked);
      const ok = await act('daily.toggle', { date: today, routineId: box.dataset.routine, on: box.checked });
      if (!ok) box.checked = !box.checked;
      if (!stale()) this.render(el);
    });
  },
};

