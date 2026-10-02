import { S, act, can, spaceName } from '../state.js';
import { $, $$, esc, avatar, timeAgo, openModal, confirmBox, toast } from '../util.js';

const ROLES = {
  owner: { label: 'Owner', text: 'Everything. Only one. Can change roles.' },
  admin: { label: 'Admin', text: 'Adds people, routines and spaces. Sees all History.' },
  member: { label: 'Member', text: 'Creates and edits work. Deletes their own only.' },
  guest: { label: 'Guest', text: 'Views and comments in their space only.' },
};

export default {
  title: 'Team & roles',
  async render(el) {
    if (!can.admin()) {
      el.innerHTML = '<div class="empty">Only the owner and admins can manage the team.</div>';
      return;
    }
    $('#topbar-slot').innerHTML = `<span class="grow"></span>
      <button class="btn" id="manage-spaces">Manage spaces</button>
      <button class="btn primary" id="add-person">+ Add person</button>`;
    const order = { owner: 0, admin: 1, member: 2, guest: 3 };
    const people = S.team.slice().sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));

    el.innerHTML = `
      <div class="team-grid">
        <section class="card flush">
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Person</th><th>Role</th><th>Spaces</th><th>Last active</th><th></th></tr></thead>
            <tbody>${people.map((p) => `<tr>
              <td><div class="row">${avatar(p, 32)}<div><b>${esc(p.name)}</b><div class="small muted">${esc(p.email)}</div></div></div></td>
              <td><span class="role role-${p.role}">${ROLES[p.role]?.label || p.role}</span></td>
              <td>${!p.spaces || p.spaces === '*' ? '<span class="chip">All spaces</span>' : p.spaces.split(',').map((s) => `<span class="chip">${esc(spaceName(s))}</span>`).join(' ')}</td>
              <td class="muted">${p.lastActive ? esc(timeAgo(p.lastActive)) : 'Never'}</td>
              <td>${editable(p) ? `<button class="btn small" data-edit="${esc(p.email)}">Edit</button>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </section>
        <aside class="role-cards">
          ${Object.entries(ROLES).map(([k, r]) => `<div class="card role-card ${k === S.me.role ? 'is-me' : ''}"><b>${r.label}${k === S.me.role ? ' · you' : ''}</b><span class="muted">${r.text}</span></div>`).join('')}
          <p class="small muted">Changes apply on their next click. Every change is logged in History.</p>
        </aside>
      </div>`;

    const rerender = () => this.render(el);
    $('#add-person').onclick = () => editPerson(null, rerender);
    $('#manage-spaces').onclick = () => manageSpaces(rerender);
    $$('[data-edit]', el).forEach((b) => b.onclick = () => editPerson(S.team.find((p) => p.email === b.dataset.edit), rerender));
  },
};

function editable(p) {
  if (p.role === 'owner') return false;
  if (can.owner()) return true;
  return p.role !== 'admin';
}

function editPerson(p, done) {
  const roles = can.owner() ? ['admin', 'member', 'guest'] : ['member', 'guest'];
  const chosen = new Set(!p || !p.spaces || p.spaces === '*' ? [] : p.spaces.split(','));
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${p ? `Edit ${esc(p.name)}` : 'Add a person'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Google email<input class="input" name="email" type="email" required value="${esc(p?.email)}" ${p ? 'readonly' : ''} placeholder="name@company.com"></label>
      <label>Name<input class="input" name="name" value="${esc(p?.name)}" placeholder="How they show in the app"></label>
      <fieldset><legend>Role</legend>
        ${roles.map((r) => `<label class="check role-pick"><input type="radio" name="role" value="${r}" ${(p?.role || 'member') === r ? 'checked' : ''}> <b>${ROLES[r].label}</b> <span class="muted small">${ROLES[r].text}</span></label>`).join('')}
        ${!can.owner() ? '<p class="small muted">Only the owner can make admins or change roles.</p>' : ''}
      </fieldset>
      <fieldset><legend>Spaces they can see</legend>
        <label class="check"><input type="checkbox" name="all" ${!chosen.size ? 'checked' : ''}> All spaces</label>
        <div class="row wrap space-pick" ${!chosen.size ? 'hidden' : ''}>
          ${S.spaces.map((s) => `<label class="pill-check"><input type="checkbox" name="space" value="${esc(s.id)}" ${chosen.has(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') || '<span class="muted small">No spaces yet. Make some with Manage spaces.</span>'}
        </div>
      </fieldset>
      <div class="row">
        ${p ? '<button type="button" class="btn danger" data-remove>Remove from team</button>' : ''}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${p ? 'Save' : 'Add'}</button>
      </div>
    </form>`, { onClose: done });
  const form = $('form', box);
  const syncAll = () => {
    const guest = form.elements.role.value === 'guest';
    if (guest) form.elements.all.checked = false;
    form.elements.all.disabled = guest;
    $('.space-pick', box).hidden = form.elements.all.checked;
  };
  form.elements.all.onchange = syncAll;
  $$('[name=role]', box).forEach((r) => r.onchange = syncAll);
  syncAll();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const spaces = fd.get('all') ? '*' : fd.getAll('space');
    if (spaces !== '*' && !spaces.length) return toast('Pick at least one space.', 'error');
    if (p && p.role !== fd.get('role') && p.email === S.me.email) return toast("You can't change your own role.", 'error');
    const saved = await act('team.save', { email: fd.get('email'), name: fd.get('name'), role: fd.get('role'), spaces });
    if (!saved) return;
    S.team = p ? S.team.map((x) => (x.email === saved.email ? saved : x)) : [...S.team, saved];
    toast(p ? 'Saved' : `${saved.name} added. They can sign in now.`);
    box.close();
  };
  const rm = $('[data-remove]', box);
  if (rm) rm.onclick = async () => {
    if (!(await confirmBox(`Remove ${p.name} from the team? They won't be able to sign in. Their work stays.`, { ok: 'Remove' }))) return;
    if (await act('team.remove', { email: p.email })) {
      S.team = S.team.filter((x) => x.email !== p.email);
      box.close();
    }
  };
}

function manageSpaces(done) {
  const box = openModal(`
    <div class="modal-head"><h2>Spaces</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="small muted">Spaces group tasks, docs and sheets (e.g. Marketing, Client A). Guests only see their space.</p>
    <div class="space-list">${S.spaces.map((s) => `<div class="row space-item"><span class="dot" style="--c:${esc(s.color)}"></span><b class="grow">${esc(s.name)}</b><button class="btn small danger" data-del="${esc(s.id)}">Delete</button></div>`).join('') || '<p class="muted">No spaces yet.</p>'}</div>
    <form class="row" id="new-space"><input class="input grow" name="name" placeholder="New space name" aria-label="New space name" required><input type="color" name="color" value="#0F766E" aria-label="Colour"><button class="btn primary">Add</button></form>`, { onClose: done });
  $('#new-space', box).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const saved = await act('spaces.save', { name: f.name.value.trim(), color: f.color.value });
    if (saved) { S.spaces.push(saved); box.close(); manageSpaces(done); }
  };
  $$('[data-del]', box).forEach((b) => b.onclick = async () => {
    const s = S.spaces.find((x) => x.id === b.dataset.del);
    if (!(await confirmBox(`Delete the space "${s.name}"? Its tasks, docs and sheets stay, with no space.`))) return;
    if (await act('spaces.delete', { id: s.id })) { S.spaces = S.spaces.filter((x) => x.id !== s.id); box.close(); manageSpaces(done); }
  });
}
