// The Reminders card on Home (last on the page), and the pop-up when a reminder's time comes.
// A reminder is for you or a teammate; only the person who set it and the person it's for see it.

import { S, act, person } from './state.js';
import { esc, isoDate, fmtDay, lsGet, lsSet, toast, $, $$ } from './util.js';

const SHOW = 8;          // reminders shown before "Show all"
let showAll = false;

// "16:00" in the viewer's clock style ("4:00 PM" or "16:00").
function clock(time) {
  const [h, m] = time.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const nowClock = () => new Date().toTimeString().slice(0, 5);

// Open ones first (soonest first, undated last), then the ones ticked off today.
function visible() {
  const today = isoDate();
  const when = (r) => (r.date ? `${r.date}T${r.time || '99:99'}` : '9999');
  return S.reminders
    .filter((r) => !r.doneAt || isoDate(new Date(r.doneAt)) === today)
    .sort((a, b) => (!!a.doneAt - !!b.doneAt) || when(a).localeCompare(when(b)) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

function whenLabel(r) {
  if (!r.date) return { text: '', cls: '' };
  const today = isoDate();
  const text = `${fmtDay(r.date)}${r.time ? `, ${clock(r.time)}` : ''}`;
  if (r.doneAt) return { text, cls: '' };
  if (r.date < today || (r.date === today && r.time && r.time <= nowClock())) return { text, cls: 'overdue' };
  if (r.date === today) return { text, cls: 'due-today' };
  return { text, cls: '' };
}

function itemHtml(r) {
  const me = S.me.email;
  const when = whenLabel(r);
  const who = r.forEmail !== me ? `for ${person(r.forEmail)?.name}` : r.createdBy && r.createdBy !== me ? `from ${person(r.createdBy)?.name}` : '';
  return `
    <div class="reminder-row ${r.doneAt ? 'is-done' : ''}">
      <input type="checkbox" data-rem-done="${esc(r.id)}" ${r.doneAt ? 'checked' : ''} aria-label="Done: ${esc(r.text)}">
      <span class="grow"><span class="reminder-text">${esc(r.text)}</span>${who ? `<span class="reminder-who">${esc(who)}</span>` : ''}</span>
      ${when.text ? `<span class="due ${when.cls}">${esc(when.text)}</span>` : ''}
      <button class="reminder-del" data-rem-del="${esc(r.id)}" title="Delete reminder" aria-label="Delete reminder: ${esc(r.text)}">×</button>
    </div>`;
}

let showOptions = false;   // the date, time and "for" fields under the box

// Draws the Reminders card into `el` (a <section>). Redraws only itself after each change.
export function renderReminderBar(el) {
  const me = S.me.email;
  const teammates = S.team.filter((p) => p.role !== 'guest' && p.email !== me);
  const items = visible();
  const open = items.filter((r) => !r.doneAt);
  const late = open.filter((r) => whenLabel(r).cls === 'overdue').length;
  const shown = showAll ? items : items.slice(0, SHOW);

  el.innerHTML = `
    <div class="card-head">
      <h2>Reminders</h2>
      <span class="small muted">${open.length ? `${open.length} to do${late ? ` · <b class="bad">${late} late</b>` : ''}` : ''}</span>
    </div>
    <form class="reminder-add" autocomplete="off">
      <div class="reminder-add-row">
        <input class="input grow" name="text" maxlength="300" placeholder="Remind me to…" aria-label="Reminder" required>
        <button class="btn primary small" type="submit">Add</button>
      </div>
      <div class="reminder-opts" ${showOptions ? '' : 'hidden'}>
        <input class="input" type="date" name="date" aria-label="Date (optional)" title="Date (optional)">
        <input class="input" type="time" name="time" aria-label="Time (optional)" title="Time (optional)">
        ${teammates.length ? `<select class="input" name="for" aria-label="Who it's for" title="Who it's for">
          <option value="${esc(me)}">For me</option>
          ${teammates.map((p) => `<option value="${esc(p.email)}">For ${esc(p.name)}</option>`).join('')}
        </select>` : ''}
      </div>
      <button class="link-btn small" type="button" data-rem-opts>${showOptions ? 'Hide date, time and person' : `Add a date, time${teammates.length ? ' or teammate' : ''}`}</button>
    </form>
    ${items.length ? `<div class="reminder-list">${shown.map(itemHtml).join('')}</div>` : '<p class="muted">No reminders yet.</p>'}
    ${items.length > SHOW ? `<button class="link-btn small" data-rem-more>${showAll ? 'Show fewer' : `Show all ${items.length}`}</button>` : ''}`;

  $('[data-rem-opts]', el).onclick = () => {
    showOptions = !showOptions;
    $('.reminder-opts', el).hidden = !showOptions;
    $('[data-rem-opts]', el).textContent = showOptions ? 'Hide date, time and person' : `Add a date, time${teammates.length ? ' or teammate' : ''}`;
  };

  const form = $('.reminder-add', el);
  const text = form.elements.text;
  const forSel = form.elements.for;
  if (forSel) {
    forSel.onchange = () => {
      text.placeholder = forSel.value === me ? 'Remind me to…' : `Remind ${person(forSel.value)?.name} to…`;
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    const time = form.elements.time.value;
    const date = form.elements.date.value || (time ? isoDate() : '');   // a time on its own means today
    const forEmail = forSel?.value || me;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    const saved = await act('reminders.save', { fields: { text: value, date, time, forEmail } });
    btn.disabled = false;
    if (!saved) return;
    S.reminders.push(saved);
    if (saved.forEmail !== me) toast(`Reminder sent to ${person(saved.forEmail)?.name}`);
    renderReminderBar(el);
    $('.reminder-add input[name=text]', el)?.focus();
  };

  $$('[data-rem-done]', el).forEach((box) => box.onchange = async () => {
    const id = box.dataset.remDone;
    box.closest('.reminder-row').classList.toggle('is-done', box.checked);
    const saved = await act('reminders.save', { id, fields: { done: box.checked } });
    if (saved) S.reminders = S.reminders.map((r) => (r.id === id ? saved : r));
    renderReminderBar(el);
  });

  $$('[data-rem-del]', el).forEach((b) => b.onclick = async () => {
    const id = b.dataset.remDel;
    b.disabled = true;
    if (!(await act('reminders.delete', { id }))) { b.disabled = false; return; }
    S.reminders = S.reminders.filter((r) => r.id !== id);
    renderReminderBar(el);
  });

  const more = $('[data-rem-more]', el);
  if (more) more.onclick = () => { showAll = !showAll; renderReminderBar(el); };
}

// Pops up your reminders whose time has just come (each once per browser), on any page.
// Ones long past aren't popped up: Home already shows them as overdue.
const SHOWN_KEY = 'teamspace.reminded';
const POP_WINDOW = 6 * 3600000;

export function remindDue() {
  if (!S.me || !S.reminders.length) return;
  const now = Date.now();
  const shown = new Set(lsGet(SHOWN_KEY, []));
  let changed = false;
  for (const r of S.reminders) {
    if (r.forEmail !== S.me.email || r.doneAt || !r.date || !r.time || shown.has(r.id)) continue;
    const at = new Date(`${r.date}T${r.time}`).getTime();   // no time zone given: local time
    if (at > now || now - at > POP_WINDOW) continue;
    const from = r.createdBy && r.createdBy !== S.me.email ? ` (from ${person(r.createdBy)?.name})` : '';
    toast(`Reminder: ${r.text}${from}`, 'reminder');
    shown.add(r.id);
    changed = true;
  }
  // Forget ones that are gone, so the list doesn't grow forever.
  if (changed) lsSet(SHOWN_KEY, [...shown].filter((id) => S.reminders.some((r) => r.id === id)));
}
