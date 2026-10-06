import { S, act, can, inSpace, isDone, routinesOn, staleCheck, person, spaceSuffix, defaultSpace } from '../state.js';
import { MAIN_SPACE } from '../config.js';
import { call } from '../api.js';
import { $, $$, esc, isoDate, addDays, parseDate, lsGet, lsSet, fmtTime, openModal, confirmBox, toast } from '../util.js';
import { openTask } from './tasks.js';

// What shows depends on the role (the database decides what each person gets):
//   owner/admin  tasks, everyone's routine ticks, every scheduled call, every event
//   member       their tasks and routine ticks, calls they're invited to, events they made or are invited to
//   guest        only their scheduled calls and the events/deadlines made for them
// Events and deadlines are added from here by anyone on the team.
const prefs = { mode: 'month', tasks: true, routines: true, meetings: true, events: true, ...lsGet('teamspace.calprefs', {}) };
const savePrefs = () => lsSet('teamspace.calprefs', prefs);
let anchor = isoDate();

const meetingsOn = (d) => S.calls
  .filter((c) => c.status === 'scheduled' && c.meetingAt && isoDate(new Date(c.meetingAt)) === d)
  .filter((c) => can.guest() || inSpace(c))
  .sort((a, b) => a.meetingAt.localeCompare(b.meetingAt));

const eventsOn = (d) => S.events
  .filter((e) => e.date === d && (can.guest() || inSpace(e)))
  .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
const canChange = (e) => can.admin() || (can.work() && e.createdBy === S.me.email);

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
      ${toggle('cal-meetings', 'meetings', 'Calls')}${toggle('cal-events', 'events', guest ? 'Deadlines and events' : 'Events')}
      <div class="seg" role="group" aria-label="Range">
        <button data-mode="month" class="${prefs.mode === 'month' ? 'on' : ''}">Month</button>
        <button data-mode="week" class="${prefs.mode === 'week' ? 'on' : ''}">Week</button>
      </div>
      ${can.work() ? '<button class="btn primary" id="new-event">+ Event</button>' : ''}`;

    const stale = staleCheck();
    const { checks } = prefs.routines && !guest ? await call('daily.get', { from: start, to: end }).catch(() => ({ checks: [] })) : { checks: [] };
    if (stale()) return;   // moved to another page while loading

    const tasks = guest ? [] : S.tasks.filter(inSpace);
    const showMeetings = prefs.meetings;
    const cells = Array.from({ length: days }, (_, i) => {
      const d = addDays(start, i);
      const inMonth = prefs.mode === 'week' || parseDate(d).getMonth() === a.getMonth();
      const events = [];
      if (showMeetings) {
        meetingsOn(d).forEach((c) => events.push(`<button class="ev ev-meet" data-call="${esc(c.id)}" title="${esc(c.topic)}">${esc(fmtTime(c.meetingAt))} ${esc(c.topic)}</button>`));
      }
      if (prefs.events) {
        eventsOn(d).forEach((e) => {
          const cls = e.kind === 'deadline' ? (d < today ? 'ev-late' : 'ev-deadline') : 'ev-event';
          const label = `${e.kind === 'deadline' ? '⚑ ' : ''}${e.time ? `${fmtTime(new Date(`${e.date}T${e.time}`))} ` : ''}${e.title}`;
          events.push(`<button class="ev ${cls}" data-event="${esc(e.id)}" title="${esc(e.kind === 'deadline' ? `Deadline: ${e.title}` : e.title)}">${esc(label)}</button>`);
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

    const legend = `${showMeetings ? '<span><i class="sw ev-meet"></i>Call</span>' : ''}${prefs.events ? '<span><i class="sw ev-event"></i>Event</span><span><i class="sw ev-deadline"></i>Deadline</span>' : ''}`
      + (guest ? '<span><i class="sw ev-late"></i>Overdue</span><span><a href="#/calls">Request a call</a></span>'
        : `<span><i class="sw ev-due"></i>Task due</span><span><i class="sw ev-done"></i>Task done</span><span><i class="sw ev-late"></i>Overdue</span>
        <span>"4/5" = routine ticks that day. Click it to open Daily.</span>`);
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
    [['#cal-tasks', 'tasks'], ['#cal-routines', 'routines'], ['#cal-meetings', 'meetings'], ['#cal-events', 'events']].forEach(([sel, key]) => {
      const box = $(sel);
      if (box) box.onchange = (e) => { prefs[key] = e.target.checked; savePrefs(); rerender(); };
    });
    $$('[data-task]', el).forEach((b) => b.onclick = () => openTask(b.dataset.task, rerender));
    $$('[data-call]', el).forEach((b) => b.onclick = () => showMeeting(S.calls.find((c) => c.id === b.dataset.call)));
    $$('[data-event]', el).forEach((b) => b.onclick = () => showEvent(S.events.find((x) => x.id === b.dataset.event), rerender));
    const add = $('#new-event');
    if (add) add.onclick = () => editEvent(null, rerender);
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
      ${can.guest() ? '' : `<p class="muted">Client: ${esc(person(c.email)?.name || c.email)}${esc(spaceSuffix(c.space))}</p>`}
      ${c.attendees?.length ? `<p class="muted">From the team: ${esc(c.attendees.map((e) => (e === S.me.email ? 'you' : person(e)?.name || e)).join(', '))}</p>` : ''}
      ${c.link ? `<p><a class="btn primary" href="${esc(c.link)}" target="_blank" rel="noopener">Join the call ↗</a></p><p class="small muted">${esc(c.link)}</p>` : '<p class="muted">No meeting link yet.</p>'}
      ${c.reply ? `<p>${esc(c.reply)}</p>` : ''}
      ${c.notes ? `<p class="small muted">${esc(c.notes)}</p>` : ''}
      <div class="row end"><a class="btn" href="#/calls" data-close>${can.guest() ? 'My call requests' : 'Open Calls'}</a></div>
    </div>`);
  return box;
}

// ---- calendar events and deadlines

const whenText = (e) => {
  const day = parseDate(e.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  if (!e.time) return `${day}${e.kind === 'deadline' ? '' : ', all day'}`;
  const start = new Date(`${e.date}T${e.time}`);
  return e.duration ? `${day}, ${fmtTime(start)} to ${fmtTime(new Date(start.getTime() + e.duration * 60000))}` : `${day}, ${fmtTime(start)}`;
};

function showEvent(e, done) {
  if (!e) return;
  const who = (list) => list.map((x) => (x === S.me.email ? 'you' : person(x)?.name || x)).join(', ');
  const box = openModal(`
    <div class="modal-head"><h2>${e.kind === 'deadline' ? '⚑ ' : ''}${esc(e.title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="stack">
      <p><b>${e.kind === 'deadline' ? 'Deadline: ' : ''}${esc(whenText(e))}</b></p>
      ${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
      ${can.guest() ? '' : `<p class="small muted">${e.client ? `For ${esc(person(e.client)?.name || e.client)} (they see it)` : 'Team only'}${esc(spaceSuffix(e.space))}${e.attendees.length ? ` · invited: ${esc(who(e.attendees))}` : ''} · added by ${esc(person(e.createdBy)?.name || e.createdBy)}</p>`}
      ${canChange(e) ? '<div class="row"><button class="btn danger" data-del>Delete</button><span class="grow"></span><button class="btn primary" data-edit>Edit</button></div>' : ''}
    </div>`);
  const edit = $('[data-edit]', box);
  if (edit) edit.onclick = () => { box.close(); editEvent(e, done); };
  const del = $('[data-del]', box);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Delete "${e.title}"?`))) return;
    if (await act('events.delete', { id: e.id })) {
      S.events = S.events.filter((x) => x.id !== e.id);
      box.close();
      done();
    }
  };
}

// Add (e = null) or change an event or deadline.
function editEvent(e, done) {
  const guests = S.team.filter((p) => p.role === 'guest');
  const people = S.team.filter((p) => p.role !== 'guest');
  const spaces = S.spaces.filter((s) => can.edit(s.id) || s.id === e?.space);
  const date = e?.date || (anchor >= isoDate() ? anchor : isoDate());
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${e ? 'Edit' : 'New'} event</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="seg kind-pick" role="radiogroup" aria-label="Kind">
        <label><input type="radio" name="kind" value="event" ${e?.kind !== 'deadline' ? 'checked' : ''}> Event</label>
        <label><input type="radio" name="kind" value="deadline" ${e?.kind === 'deadline' ? 'checked' : ''}> Deadline</label>
      </div>
      <label>Name<input class="input" name="title" required maxlength="200" value="${esc(e?.title)}" placeholder="e.g. Proposal sign-off"></label>
      <div class="row wrap">
        <label>Date<input class="input" type="date" name="date" required value="${esc(date)}"></label>
        <label>Time <span class="muted small">(optional)</span><input class="input" type="time" name="time" value="${esc(e?.time)}"></label>
        <label data-length>Length<select class="input" name="duration">${[15, 30, 45, 60, 90, 120, 180, 240].map((m) => `<option value="${m}" ${(e?.duration || 60) === m ? 'selected' : ''}>${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join('')}</select></label>
      </div>
      <label>For a client <span class="muted small">(they'll see it on their Calendar)</span><select class="input" name="client">
        <option value="">No one outside the team</option>${guests.map((p) => `<option value="${esc(p.email)}" ${e?.client === p.email ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <fieldset><legend>Invite from the team</legend><div class="row wrap">
        ${people.map((p) => `<label class="pill-check"><input type="checkbox" name="who" value="${esc(p.email)}" ${e?.attendees.includes(p.email) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}
      </div></fieldset>
      <label>Space<select class="input" name="space">${spaces.map((s) => `<option value="${esc(s.id)}" ${(e?.space || defaultSpace()) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label>Notes <span class="muted small">(optional)</span><textarea class="input" name="notes" rows="2" maxlength="2000">${esc(e?.notes)}</textarea></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${e ? 'Save' : 'Add'}</button></div>
    </form>`);
  const form = $('form', box);
  const f = form.elements;
  const syncLength = () => { $('[data-length]', box).hidden = !f.time.value; };
  f.time.oninput = syncLength;
  syncLength();
  // Picking a client puts it in their space (when you can add there).
  f.client.onchange = () => {
    const p = guests.find((g) => g.email === f.client.value);
    const theirs = String(p?.spaces || '').split(',').map((x) => x.trim()).find((id) => spaces.some((s) => s.id === id));
    if (theirs) f.space.value = theirs;
    else if (!f.client.value && !e) f.space.value = defaultSpace();
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const fields = {
      title: f.title.value.trim(), kind: f.kind.value, date: f.date.value, time: f.time.value,
      duration: f.time.value ? Number(f.duration.value) : 0, client: f.client.value, notes: f.notes.value,
      attendees: [...form.querySelectorAll('input[name=who]:checked')].map((x) => x.value), space: f.space.value || MAIN_SPACE,
    };
    const saved = await act('events.save', { id: e?.id, fields });
    if (!saved) return;
    S.events = e ? S.events.map((x) => (x.id === saved.id ? saved : x)) : [...S.events, saved];
    box.close();
    toast(e ? 'Saved' : `Added to ${parseDate(saved.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
    anchor = saved.date;
    done();
  };
}
