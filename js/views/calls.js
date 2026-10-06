// Calls. Guests (clients) ask for a call and see their requests; the owner and admins
// schedule them (date, time, length, meeting link, who from the team joins) or decline them.
// Scheduled calls show on the Calendar for that guest, the invited team members, and the
// owner and admins. Invited members see their calls here too (read-only).

import { S, act, can, person, spaceName, spaceSuffix } from '../state.js';
import { $, $$, esc, fmtTime, timeAgo, isoDate, openModal, confirmBox, toast } from '../util.js';

const STATUS = {
  requested: ['Waiting for a reply', 'warn'],
  scheduled: ['Scheduled', 'good'],
  declined: ['Declined', 'bad'],
  cancelled: ['Cancelled', 'muted'],
};
let tab = 'waiting';

const when = (c) => {
  if (!c.meetingAt) return '';
  const start = new Date(c.meetingAt);
  const end = new Date(start.getTime() + (c.duration || 0) * 60000);
  return `${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(start)} to ${fmtTime(end)}`;
};
const names = (emails) => emails.map((e) => (e === S.me.email ? 'you' : person(e)?.name || e)).join(', ');
const withLine = (c) => (c.attendees?.length ? `<div class="small muted">With ${esc(names(c.attendees))}</div>` : '');
const upcoming = (c) => c.status === 'scheduled' && new Date(c.meetingAt).getTime() + (c.duration || 0) * 60000 > Date.now();

export default {
  title: () => (can.guest() ? 'Request a call' : 'Calls'),
  async render(el) {
    if (can.guest()) return renderGuest(el);
    if (!can.admin()) return renderInvited(el);
    return renderAdmin(el, () => this.render(el));
  },
};

// ---- guests

function renderGuest(el) {
  const mine = S.calls.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const spaces = S.spaces;   // a guest sees only their client space(s)
  el.innerHTML = `
    <div class="calls-grid">
      <section class="card">
        <h2>Request a call</h2>
        <form class="stack" id="call-form">
          <label>What is it about?<input class="input" name="topic" required maxlength="200" placeholder="e.g. Review the proposal"></label>
          <label>When suits you? <span class="muted small">(days and times, with your time zone)</span>
            <input class="input" name="preferred" maxlength="500" placeholder="e.g. Tue or Wed afternoon, London time"></label>
          <label>Anything we should know first? <span class="muted small">(optional)</span><textarea class="input" name="notes" rows="3" maxlength="2000"></textarea></label>
          ${spaces.length > 1 ? `<label>For<select class="input" name="space">${spaces.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}
          <div class="row end"><button class="btn primary">Send request</button></div>
        </form>
      </section>
      <section class="stack">
        <h2>Your requests</h2>
        ${mine.map((c) => {
          const [label, cls] = STATUS[c.status] || [c.status, 'muted'];
          return `<div class="card call-card">
            <div class="row"><b class="grow">${esc(c.topic)}</b><span class="status-pill ${cls}">${label}</span></div>
            ${c.status === 'scheduled' ? `<div><b>${esc(when(c))}</b></div>${withLine(c)}${c.link ? `<a class="btn small primary" href="${esc(c.link)}" target="_blank" rel="noopener">Join the call ↗</a>` : ''}` : ''}
            ${c.preferred && c.status === 'requested' ? `<div class="small muted">You suggested: ${esc(c.preferred)}</div>` : ''}
            ${c.reply ? `<div class="small">${esc(c.reply)}</div>` : ''}
            <div class="row small muted">Asked ${esc(timeAgo(c.createdAt))}<span class="grow"></span>
              ${['requested', 'scheduled'].includes(c.status) ? `<button class="link-btn" data-cancel="${esc(c.id)}">Cancel</button>` : ''}</div>
          </div>`;
        }).join('') || '<p class="muted">No requests yet. Scheduled calls also show on your Calendar.</p>'}
      </section>
    </div>`;

  $('#call-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const saved = await act('calls.request', {
      topic: f.topic.value, preferred: f.preferred.value, notes: f.notes.value, space: f.space?.value || spaces[0]?.id,
    });
    if (!saved) return;
    S.calls = [saved, ...S.calls];
    toast("Request sent. You'll see the time here and on your Calendar once it's scheduled.");
    renderGuest(el);
  };
  $$('[data-cancel]', el).forEach((b) => b.onclick = async () => {
    if (!(await confirmBox('Cancel this call request?', { ok: 'Cancel request' }))) return;
    const saved = await act('calls.update', { id: b.dataset.cancel, fields: { status: 'cancelled' } });
    if (saved) { S.calls = S.calls.map((c) => (c.id === saved.id ? saved : c)); renderGuest(el); }
  });
}

// ---- members: the calls they're invited to

function renderInvited(el) {
  const mine = S.calls.filter((c) => c.status === 'scheduled' && c.attendees?.includes(S.me.email));
  const next = mine.filter(upcoming).sort((a, b) => a.meetingAt.localeCompare(b.meetingAt));
  const past = mine.filter((c) => !upcoming(c)).sort((a, b) => b.meetingAt.localeCompare(a.meetingAt));
  const card = (c) => `<div class="card call-card">
      <div class="row"><b class="grow">${esc(c.topic)}</b><span class="status-pill ${upcoming(c) ? 'good' : 'muted'}">${upcoming(c) ? 'Upcoming' : 'Done'}</span></div>
      <div><b>${esc(when(c))}</b></div>
      <div class="small muted">Client: ${esc(person(c.email)?.name || c.email)}${esc(spaceSuffix(c.space))}${c.attendees.length > 1 ? ` · with ${esc(names(c.attendees.filter((e) => e !== S.me.email)))}` : ''}</div>
      ${c.notes ? `<div class="small"><b>Notes:</b> ${esc(c.notes)}</div>` : ''}
      ${c.link && upcoming(c) ? `<div><a class="btn small primary" href="${esc(c.link)}" target="_blank" rel="noopener">Join the call ↗</a></div>` : ''}
    </div>`;
  el.innerHTML = `<div class="stack calls-admin">
    <p class="muted">Client calls you're invited to. They also show on your Calendar. The owner and admins schedule them.</p>
    ${next.map(card).join('') || '<div class="empty">No upcoming calls for you.</div>'}
    ${past.length ? `<h2>Past</h2>${past.map(card).join('')}` : ''}
  </div>`;
}

// ---- owner and admins

function renderAdmin(el, rerender) {
  const groups = {
    waiting: S.calls.filter((c) => c.status === 'requested').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    scheduled: S.calls.filter(upcoming).sort((a, b) => a.meetingAt.localeCompare(b.meetingAt)),
    closed: S.calls.filter((c) => c.status !== 'requested' && !upcoming(c)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  };
  $('#topbar-slot').innerHTML = `<div class="seg" role="group" aria-label="Show">
    ${[['waiting', 'Waiting'], ['scheduled', 'Upcoming'], ['closed', 'Past and closed']].map(([k, l]) =>
      `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l} (${groups[k].length})</button>`).join('')}</div>`;
  const list = groups[tab];
  el.innerHTML = `<div class="stack calls-admin">${list.map((c) => {
    const [label, cls] = STATUS[c.status] || [c.status, 'muted'];
    const who = person(c.email);
    return `<div class="card call-card">
      <div class="row"><b class="grow">${esc(c.topic)}</b><span class="status-pill ${cls}">${c.status === 'scheduled' && !upcoming(c) ? 'Done' : label}</span></div>
      <div class="small muted">${esc(who?.name || c.email)} · ${esc(spaceName(c.space))} · asked ${esc(timeAgo(c.createdAt))}${c.handledBy ? ` · handled by ${esc(person(c.handledBy)?.name || c.handledBy)}` : ''}</div>
      ${c.status === 'scheduled' ? `<div><b>${esc(when(c))}</b>${c.link ? ` · <a href="${esc(c.link)}" target="_blank" rel="noopener">meeting link ↗</a>` : ''}</div>${c.attendees?.length ? `<div class="small"><b>Invited:</b> ${esc(names(c.attendees))}</div>` : ''}` : ''}
      ${c.preferred ? `<div class="small"><b>Suggested times:</b> ${esc(c.preferred)}</div>` : ''}
      ${c.notes ? `<div class="small"><b>Notes:</b> ${esc(c.notes)}</div>` : ''}
      ${c.reply ? `<div class="small"><b>Your message:</b> ${esc(c.reply)}</div>` : ''}
      ${['requested', 'scheduled'].includes(c.status) ? `<div class="row end">
        ${c.status === 'scheduled' ? `<button class="btn small" data-close-call="${esc(c.id)}">Cancel call</button>` : `<button class="btn small" data-decline="${esc(c.id)}">Decline</button>`}
        <button class="btn small primary" data-schedule="${esc(c.id)}">${c.status === 'scheduled' ? 'Reschedule' : 'Schedule'}</button></div>` : ''}
    </div>`;
  }).join('') || `<div class="empty">${tab === 'waiting' ? 'No requests waiting. Clients ask for calls from their "Request a call" page.' : 'Nothing here.'}</div>`}</div>`;

  $$('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; rerender(); });
  const replace = (saved) => { S.calls = S.calls.map((c) => (c.id === saved.id ? saved : c)); rerender(); };
  $$('[data-schedule]', el).forEach((b) => b.onclick = () => schedule(S.calls.find((c) => c.id === b.dataset.schedule), replace));
  $$('[data-decline]', el).forEach((b) => b.onclick = () => decline(S.calls.find((c) => c.id === b.dataset.decline), 'declined', replace));
  $$('[data-close-call]', el).forEach((b) => b.onclick = () => decline(S.calls.find((c) => c.id === b.dataset.closeCall), 'cancelled', replace));
}

function schedule(c, done) {
  const at = c.meetingAt ? new Date(c.meetingAt) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${c.status === 'scheduled' ? 'Reschedule' : 'Schedule'}: ${esc(c.topic)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      ${c.preferred ? `<p class="small muted">${esc(person(c.email)?.name || c.email)} suggested: ${esc(c.preferred)}</p>` : ''}
      <div class="row wrap">
        <label>Date<input class="input" type="date" name="date" required min="${isoDate()}" value="${at ? isoDate(at) : ''}"></label>
        <label>Time <span class="muted small">(your time)</span><input class="input" type="time" name="time" required value="${at ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : ''}"></label>
        <label>Length<select class="input" name="duration">${[15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${(c.duration || 30) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
      </div>
      <fieldset><legend>Who from the team joins</legend><div class="row wrap">
        ${S.team.filter((p) => p.role !== 'guest').map((p) => `<label class="pill-check"><input type="checkbox" name="who" value="${esc(p.email)}" ${(c.status === 'scheduled' ? c.attendees.includes(p.email) : p.email === S.me.email) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}
      </div><p class="small muted">They see the call on their Calendar and Calls page.</p></fieldset>
      <label>Meeting link <span class="muted small">(Google Meet, Zoom…)</span><input class="input" name="link" type="url" placeholder="https://meet.google.com/…" value="${esc(c.link)}"></label>
      <label>Message to the client <span class="muted small">(optional)</span><textarea class="input" name="reply" rows="2" maxlength="1000">${esc(c.reply)}</textarea></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
  const form = $('form', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const start = new Date(`${f.date.value}T${f.time.value}`);
    if (Number.isNaN(start.getTime())) return toast('Pick a date and time.', 'error');
    if (f.link.value && !/^https:\/\//.test(f.link.value.trim())) return toast('The meeting link must start with https://', 'error');
    const saved = await act('calls.update', { id: c.id, fields: {
      status: 'scheduled', meetingAt: start.toISOString(), duration: Number(f.duration.value), link: f.link.value, reply: f.reply.value,
      attendees: [...form.querySelectorAll('input[name=who]:checked')].map((x) => x.value),
    } });
    if (!saved) return;
    box.close();
    toast('Scheduled. It shows on their Calendar.');
    done(saved);
  };
}

function decline(c, status, done) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${status === 'declined' ? 'Decline' : 'Cancel'}: ${esc(c.topic)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Message to the client <span class="muted small">(optional)</span><textarea class="input" name="reply" rows="3" maxlength="1000" placeholder="e.g. Let's handle this by email instead."></textarea></label>
      <div class="row end"><button type="button" class="btn" data-close>Back</button><button class="btn danger">${status === 'declined' ? 'Decline request' : 'Cancel call'}</button></div>
    </form>`);
  $('form', box).onsubmit = async (e) => {
    e.preventDefault();
    const saved = await act('calls.update', { id: c.id, fields: { status, reply: e.target.elements.reply.value } });
    if (!saved) return;
    box.close();
    done(saved);
  };
}
