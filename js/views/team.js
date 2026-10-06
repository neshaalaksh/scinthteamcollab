import { S, act, can, spaceName, spaceById } from '../state.js';
import { MAIN_SPACE } from '../config.js';
import { $, $$, esc, avatar, timeAgo, openModal, confirmBox, toast } from '../util.js';

const ROLES = {
  owner: { label: 'Owner', text: 'Everything. Only one. Can change roles.' },
  admin: { label: 'Admin', text: "Sees everyone's tasks, routines and History. Adds people, routines, spaces; handles calls." },
  member: { label: 'Member', text: 'Their own tasks (and ones they give out), their routines, docs, sheets and Drive.' },
  guest: { label: 'Guest', text: 'A client: Drive and Calendar for their client space, and can request calls.' },
};

const clientSpaces = () => S.spaces.filter((s) => s.id !== MAIN_SPACE);
const listOf = (spaces) => String(spaces || '').split(',').map((x) => x.trim()).filter(Boolean);

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
              <td>${spacesChips(p)}</td>
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

// What someone sees: admins everything; members the main space plus their client spaces; guests their client spaces.
function spacesChips(p) {
  const chip = (t) => `<span class="chip">${esc(t)}</span>`;
  if (p.role === 'owner' || p.role === 'admin') return chip('All spaces');
  const clients = p.spaces === '*' ? [chip('All client spaces')] : listOf(p.spaces).filter((id) => spaceById(id)).map((id) => chip(spaceName(id)));
  if (p.role === 'guest') return clients.join(' ') || '<span class="small muted">No client space</span>';
  return [chip(spaceName(MAIN_SPACE)), ...clients].join(' ');
}

function editable(p) {
  if (p.role === 'owner') return false;
  if (can.owner()) return true;
  return p.role !== 'admin';
}

function editPerson(p, done) {
  // Only the owner can change roles (the database enforces it), so others just see the current one.
  const roles = can.owner() ? ['admin', 'member', 'guest'] : p ? [p.role] : ['member', 'guest'];
  const chosen = new Set(p && p.spaces !== '*' ? listOf(p.spaces) : []);
  const allClients = p?.spaces === '*';
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${p ? `Edit ${esc(p.name)}` : 'Add a person'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Google email<input class="input" name="email" type="email" required value="${esc(p?.email)}" ${p ? 'readonly' : ''} placeholder="name@company.com"></label>
      <label>Name<input class="input" name="name" value="${esc(p?.name)}" placeholder="How they show in the app"></label>
      <fieldset><legend>Role</legend>
        ${roles.map((r) => `<label class="check role-pick"><input type="radio" name="role" value="${r}" ${(p?.role || 'member') === r ? 'checked' : ''}> <b>${ROLES[r].label}</b> <span class="muted small">${ROLES[r].text}</span></label>`).join('')}
        ${!can.owner() ? `<p class="small muted">${p ? 'Only the owner can change roles.' : 'Only the owner can make admins or change roles.'}</p>` : ''}
      </fieldset>
      <fieldset class="spaces-field"><legend>Client spaces they can see</legend>
        <p class="small muted" data-hint></p>
        <label class="check" data-all-row><input type="checkbox" name="all" ${allClients ? 'checked' : ''}> All client spaces</label>
        <div class="row wrap space-pick">
          ${clientSpaces().map((s) => `<label class="pill-check"><input type="checkbox" name="space" value="${esc(s.id)}" ${chosen.has(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') || '<span class="muted small">No client spaces yet. Make one with Manage spaces.</span>'}
        </div>
      </fieldset>
      <div class="row">
        ${p ? '<button type="button" class="btn danger" data-remove>Remove from team</button>' : ''}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${p ? 'Save' : 'Add'}</button>
      </div>
    </form>`, { onClose: done });
  const form = $('form', box);
  const syncAll = () => {
    const role = form.elements.role.value;
    const guest = role === 'guest';
    // Admins see every space, so there's nothing to pick.
    $('.spaces-field', box).hidden = role === 'admin';
    if (guest) form.elements.all.checked = false;
    $('[data-all-row]', box).hidden = guest;
    $('[data-hint]', box).textContent = guest
      ? 'A guest is a client: pick the client space(s) they belong to. They never see Scinth.'
      : `Members always see ${spaceName(MAIN_SPACE)}. Tick the client spaces they also work in (or none).`;
    $('.space-pick', box).hidden = form.elements.all.checked;
  };
  form.elements.all.onchange = syncAll;
  $$('[name=role]', box).forEach((r) => r.onchange = syncAll);
  syncAll();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const role = fd.get('role');
    const spaces = role === 'admin' || fd.get('all') ? '*' : fd.getAll('space');
    if (role === 'guest' && !spaces.length) return toast('Pick the client space this guest belongs to.', 'error');
    if (p && p.role !== fd.get('role') && p.email === S.me.email) return toast("You can't change your own role.", 'error');
    const email = String(fd.get('email') || '').trim().toLowerCase();
    if (!p && S.team.some((x) => x.email === email)) return toast('That person is already on the team. Use Edit next to their name.', 'error');
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
    <p class="small muted">${esc(spaceName(MAIN_SPACE))} is the team's own space. Every other space is for a client: their guests see only that space's Drive files, calls and deadlines.</p>
    <div class="space-list">${S.spaces.map((s) => `<div class="row space-item"><span class="dot" style="--c:${esc(s.color)}"></span><b class="grow">${esc(s.name)}</b>${s.id === MAIN_SPACE ? '<span class="small muted">Main space</span>' : `<button class="btn small danger" data-del="${esc(s.id)}">Delete</button>`}</div>`).join('')}</div>
    <form class="row" id="new-space"><input class="input grow" name="name" placeholder="New client space, e.g. Acme Ltd" aria-label="New client space name" required><input type="color" name="color" value="#0F766E" aria-label="Colour"><button class="btn primary">Add</button></form>`, { onClose: done });
  $('#new-space', box).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const saved = await act('spaces.save', { name: f.name.value.trim(), color: f.color.value });
    if (saved) { S.spaces.push(saved); box.close(); manageSpaces(done); }
  };
  $$('[data-del]', box).forEach((b) => b.onclick = async () => {
    const s = S.spaces.find((x) => x.id === b.dataset.del);
    // A guest must belong to some client space: those who only have this one block the delete.
    const stuck = S.team.filter((p) => p.role === 'guest' && listOf(p.spaces).includes(s.id) && listOf(p.spaces).every((x) => x === s.id));
    if (stuck.length) {
      return toast(`${stuck.map((p) => p.name).join(', ')} only belong${stuck.length === 1 ? 's' : ''} to ${s.name}. Move them to another client space or remove them first.`, 'error');
    }
    // Things in a deleted space move to the main space, which every member sees: say so, with numbers.
    const n = (list) => list.filter((x) => x.space === s.id).length;
    const counts = [[n(S.tasks), 'task'], [n(S.docs), 'doc'], [n(S.sheets), 'sheet'], [n(S.allRoutines), 'routine'], [n(S.files), 'file'], [n(S.calls), 'call']]
      .filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`);
    const guests = S.team.filter((p) => p.role === 'guest' && listOf(p.spaces).includes(s.id)).map((p) => p.name);
    const msg = `Delete the space "${s.name}"?`
      + (counts.length ? ` Its ${counts.join(', ')} will move to ${spaceName(MAIN_SPACE)}, where every member can see them.` : '')
      + (guests.length ? ` ${guests.join(', ')} (guest${guests.length === 1 ? '' : 's'}) will lose access to them.` : '');
    if (!(await confirmBox(msg))) return;
    if (await act('spaces.delete', { id: s.id })) { S.spaces = S.spaces.filter((x) => x.id !== s.id); box.close(); manageSpaces(done); }
  });
}
