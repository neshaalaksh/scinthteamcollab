import { S, act, can, person, routinesOn, spaceName, staleCheck, personCanSee, defaultSpace } from '../state.js';
import { call } from '../api.js';
import { $, $$, esc, avatar, isoDate, addDays, fmtDay, fmtTime, openModal, confirmBox, toast } from '../util.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default {
  title: 'Daily',
  async render(el, params) {
    if (S.me.role === 'guest') {
      el.innerHTML = '<div class="empty">Daily routines are for team members.</div>';
      return;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : isoDate();
    const stale = staleCheck();
    const { checks } = await call('daily.get', { from: date, to: date });
    if (stale()) return;   // moved to another page while loading
    const routines = routinesOn(date);
    // Owner and admins see everyone's column; members only their own.
    const people = can.admin() ? S.team.filter((p) => p.role !== 'guest') : [S.me];
    const expected = routines.reduce((n, r) => n + r.people.length, 0);
    const ticked = checks.filter((c) => routines.some((r) => r.id === c.routineId && r.people.includes(c.email))).length;
    const check = (rid, email) => checks.find((c) => c.routineId === rid && c.email === email);
    const isFuture = date > isoDate();

    $('#topbar-slot').innerHTML = `
      <a class="icon-btn" href="#/daily/${addDays(date, -1)}" aria-label="Previous day">‹</a>
      <b class="range-label">${esc(fmtDay(date))}</b>
      <a class="icon-btn" href="#/daily/${addDays(date, 1)}" aria-label="Next day">›</a>
      ${date !== isoDate() ? '<a class="btn" href="#/daily">Today</a>' : ''}
      <span class="grow"></span>
      <div class="progress-inline"><div class="progress"><div style="width:${expected ? Math.round((ticked / expected) * 100) : 0}%"></div></div><b>${ticked} / ${expected} done</b></div>
      ${can.admin() ? '<button class="btn" id="manage-routines">Manage routines</button>' : ''}`;

    el.innerHTML = `
      <div class="daily-wrap">
        <section class="card flush">
          ${routines.length ? `<div class="table-wrap"><table class="table routine-table">
            <thead><tr><th>Routine</th>${people.map((p) => `<th class="center">${avatar(p, 24)}<span class="sr-only">${esc(p.name)}</span><div class="small">${esc(p.name.split(' ')[0])}</div></th>`).join('')}</tr></thead>
            <tbody>${routines.map((r) => `<tr>
              <td><b>${esc(r.title)}</b><div class="small muted">${esc(daysLabel(r.days))}${can.admin() ? ` · ${r.assignees === 'everyone' ? 'everyone' : `${r.people.length} ${r.people.length === 1 ? 'person' : 'people'}`}` : ''} · ${esc(spaceName(r.space))}</div></td>
              ${people.map((p) => {
                if (!r.people.includes(p.email)) return '<td class="center muted" title="Not assigned">–</td>';
                const c = check(r.id, p.email);
                const allowed = can.tickFor(p.email) && !isFuture;
                return `<td class="center"><button class="tick ${c ? 'on' : ''}" ${allowed ? '' : 'disabled'} data-r="${esc(r.id)}" data-p="${esc(p.email)}"
                  aria-pressed="${!!c}" aria-label="${esc(r.title)} for ${esc(p.name)}">${c ? '✓' : ''}</button>
                  <div class="tick-time">${c ? esc(fmtTime(c.at)) : ''}</div></td>`;
              }).join('')}
            </tr>`).join('')}</tbody></table></div>
            <p class="small muted pad">Tick a box when it's done. The time is saved${can.admin() ? ' and shows in History. Admins can tick for others.' : '.'}</p>`
          : `<div class="empty">No routines on this day.${can.admin() ? ' Add one with <b>Manage routines</b>.' : ''}</div>`}
        </section>
      </div>`;

    $$('.tick:not([disabled])', el).forEach((b) => b.onclick = async () => {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      b.textContent = on ? '✓' : '';
      const ok = await act('daily.toggle', { date, routineId: b.dataset.r, email: b.dataset.p, on });
      if (!stale()) this.render(el, params);
      if (!ok) toast("That didn't save. Try again.", 'error');
    });

    const manage = $('#manage-routines');
    if (manage) manage.onclick = () => manageRoutines(() => this.render(el, params));
  },
};

function daysLabel(days) {
  const d = (days?.length ? days : [1, 2, 3, 4, 5]).slice().sort();
  if (d.length === 7) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Mon–Fri';
  return d.map((n) => DAYS[n]).join(', ');
}

function manageRoutines(done) {
  const box = openModal(`
    <div class="modal-head"><h2>Routines</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="routine-list">
      ${S.routines.map((r) => `<div class="row routine-item">
        <div class="grow"><b>${esc(r.title)}</b><div class="small muted">${esc(daysLabel(r.days))} · ${r.assignees === 'everyone' ? 'everyone' : r.assignees.map((e) => esc(person(e).name)).join(', ')}</div></div>
        <button class="btn" data-edit="${esc(r.id)}">Edit</button>
      </div>`).join('') || '<p class="muted">No routines yet.</p>'}
    </div>
    <div class="row end"><button class="btn primary" data-new>+ New routine</button></div>`, { wide: true, onClose: done });
  $('[data-new]', box).onclick = () => { box.close(); editRoutine(null, done); };
  $$('[data-edit]', box).forEach((b) => b.onclick = () => { box.close(); editRoutine(S.routines.find((r) => r.id === b.dataset.edit), done); });
}

function editRoutine(r, done) {
  const days = r?.days?.length ? r.days : [1, 2, 3, 4, 5];
  const everyone = !r || r.assignees === 'everyone';
  const people = S.team.filter((p) => p.role !== 'guest');
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${r ? 'Edit routine' : 'New routine'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Name<input class="input" name="title" value="${esc(r?.title)}" required placeholder="e.g. Check team inbox"></label>
      <fieldset><legend>Repeats on</legend><div class="row wrap">
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="pill-check"><input type="checkbox" name="day" value="${d}" ${days.includes(d) ? 'checked' : ''}> ${DAYS[d]}</label>`).join('')}
      </div></fieldset>
      <fieldset><legend>Who does it</legend>
        <label class="check"><input type="checkbox" name="everyone" ${everyone ? 'checked' : ''}> Everyone on the team</label>
        <div class="row wrap people-pick" ${everyone ? 'hidden' : ''}>
          ${people.map((p) => `<label class="pill-check"><input type="checkbox" name="who" value="${esc(p.email)}" ${!everyone && r.assignees.includes(p.email) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}
        </div>
      </fieldset>
      <label>Space<select class="input" name="space">${S.spaces.map((s) => `<option value="${esc(s.id)}" ${(r?.space || defaultSpace()) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <div class="row">
        ${r ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ''}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button>
      </div>
    </form>`, { onClose: done });
  const form = $('form', box);
  form.elements.everyone.onchange = (e) => { $('.people-pick', box).hidden = e.target.checked; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const fields = {
      title: fd.get('title').trim(),
      days: fd.getAll('day').map(Number),
      assignees: fd.get('everyone') ? 'everyone' : fd.getAll('who'),
      space: fd.get('space'),
    };
    if (!fields.days.length) return toast('Pick at least one day.', 'error');
    if (fields.assignees !== 'everyone' && !fields.assignees.length) return toast('Pick who does it.', 'error');
    // Someone who can't see the routine's space can't tick it, so it would never show for them.
    const blind = fields.assignees === 'everyone' ? [] : fields.assignees.filter((em) => !personCanSee(person(em), fields.space));
    if (blind.length) return toast(`${blind.map((em) => person(em).name).join(', ')} can't see ${spaceName(fields.space)}. Pick another space or other people.`, 'error');
    const saved = await act('routines.save', { id: r?.id, fields });
    if (!saved) return;
    S.routines = r ? S.routines.map((x) => (x.id === saved.id ? saved : x)) : [...S.routines, saved];
    toast('Routine saved');
    box.close();
  };
  const del = $('[data-delete]', box);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Delete "${r.title}"? Past ticks stay in History.`))) return;
    if (await act('routines.delete', { id: r.id })) {
      S.routines = S.routines.filter((x) => x.id !== r.id);
      box.close();
    }
  };
}

