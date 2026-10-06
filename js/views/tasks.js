import { CONFIG, DONE } from '../config.js';
import { S, act, can, inSpace, person, spaceName, statusById, priorityById, isDone, personCanSee, defaultSpace } from '../state.js';
import { $, $$, esc, avatar, dueLabel, fmtStamp, timeAgo, openModal, confirmBox, toast, lsGet, lsSet, uid } from '../util.js';
import { renderMarkdown } from '../markdown.js';

const prefs = lsGet('teamspace.taskprefs', { mode: 'board', who: 'all', q: '' });
const savePrefs = () => lsSet('teamspace.taskprefs', prefs);
let rootEl = null;

export default {
  title: 'Tasks',
  async render(el, params) {
    rootEl = el;
    $('#topbar-slot').innerHTML = `
      <div class="seg" role="group" aria-label="View">
        <button data-mode="board" class="${prefs.mode === 'board' ? 'on' : ''}">Board</button>
        <button data-mode="list" class="${prefs.mode === 'list' ? 'on' : ''}">List</button>
      </div>
      <span class="grow"></span>
      <input type="search" class="input" id="task-search" placeholder="Search tasks…" aria-label="Search tasks" value="${esc(prefs.q)}">
      <select class="input" id="task-who" aria-label="Whose tasks">${whoOptions()}</select>
      ${can.work() ? '<button class="btn primary" id="new-task">+ New task</button>' : ''}`;
    if (![...$('#task-who').options].some((o) => o.value === prefs.who)) prefs.who = 'all';
    $('#task-who').value = prefs.who;
    $('#task-search').oninput = (e) => { prefs.q = e.target.value; savePrefs(); renderBody(); };
    $('#task-who').onchange = (e) => { prefs.who = e.target.value; savePrefs(); renderBody(); };
    $$('[data-mode]').forEach((b) => b.onclick = () => {
      prefs.mode = b.dataset.mode; savePrefs();
      $$('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      renderBody();
    });
    if ($('#new-task')) $('#new-task').onclick = () => openTask(null);
    el.innerHTML = '<div id="task-body"></div>';
    renderBody();
    // #/tasks/<id> opens that task (used by task links inside docs).
    if (params[0]) {
      // Drop a link to a deleted task from the address, so the message shows once, not on every refresh.
      if (!S.tasks.some((t) => t.id === params[0])) history.replaceState(null, '', '#/tasks');
      openTask(params[0], () => { history.replaceState(null, '', '#/tasks'); });
    }
  },
};

// Owner and admins see every task, so they filter by person. Members only have their own
// tasks and the ones they gave to someone else, so they filter between those two.
function whoOptions() {
  if (!can.admin()) {
    return '<option value="all">All my tasks</option><option value="me">Assigned to me</option><option value="byme">Assigned by me</option>';
  }
  return `<option value="all">Everyone</option><option value="me">My tasks</option><option value="none">Unassigned</option>
    ${S.team.filter((p) => p.role !== 'guest').map((p) => `<option value="${esc(p.email)}">${esc(p.name)}</option>`).join('')}`;
}

function visible() {
  const q = prefs.q.toLowerCase();
  return S.tasks.filter((t) => {
    if (!inSpace(t)) return false;
    if (prefs.who === 'me' && t.assignee !== S.me.email) return false;
    if (prefs.who === 'none' && t.assignee) return false;
    if (prefs.who === 'byme' && !(t.createdBy === S.me.email && t.assignee !== S.me.email)) return false;
    if (!['all', 'me', 'none', 'byme'].includes(prefs.who) && t.assignee !== prefs.who) return false;
    if (q && !`${t.title} ${t.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const prRank = (t) => { const i = CONFIG.priorities.findIndex((p) => p.id === t.priority); return i < 0 ? 99 : i; };
const sorted = (list) => list.sort((a, b) => (a.order - b.order) || (prRank(a) - prRank(b)) || (a.due || '9999').localeCompare(b.due || '9999'));
const sortDone = (list) => list.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

function prTag(t) {
  const p = priorityById(t.priority);
  return p ? `<span class="tag" style="background:${p.bg};color:${p.fg}">${esc(p.label)}</span>` : '';
}

function card(t) {
  const due = dueLabel(t.due);
  const cl = t.checklist || [];
  const who = person(t.assignee);
  if (isDone(t)) {
    return `<article class="card-task is-done" draggable="${can.edit(t.space)}" data-id="${esc(t.id)}" tabindex="0">
      <b>${esc(t.title)}</b>
      <span class="small good">✓ ${esc(person(t.completedBy)?.name || '')} · ${esc(fmtStamp(t.completedAt))}</span></article>`;
  }
  return `<article class="card-task" draggable="${can.edit(t.space)}" data-id="${esc(t.id)}" tabindex="0">
    <b>${esc(t.title)}</b>
    <div class="meta">${prTag(t)}${due.text ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : ''}
      ${cl.length ? `<span class="muted">☑ ${cl.filter((c) => c.done).length}/${cl.length}</span>` : ''}
      <span class="grow"></span>${who ? avatar(who, 22) : ''}</div>
    <div class="small muted">${esc(spaceName(t.space))}${t.comments?.length ? ` · ${t.comments.length} comment${t.comments.length > 1 ? 's' : ''}` : ''}</div>
  </article>`;
}

function renderBody() {
  const body = $('#task-body', rootEl);
  if (!body) return;
  const list = visible();
  if (prefs.mode === 'list') return renderList(body, list);

  body.innerHTML = `<div class="board">${CONFIG.statuses.map((s) => {
    let col = list.filter((t) => statusById(t.status).id === s.id);
    col = s.id === DONE ? sortDone(col).slice(0, 15) : sorted(col);
    const total = list.filter((t) => statusById(t.status).id === s.id).length;
    return `<section class="column" data-status="${s.id}" aria-label="${esc(s.label)}">
      <header><span class="dot" style="--c:${s.color}"></span>${esc(s.label)}<span class="count">${total}</span></header>
      <div class="cards">${col.map(card).join('')}</div>
      ${s.id === DONE && total > col.length ? (can.admin() ? '<a class="small" href="#/history">See all in History →</a>' : `<span class="small muted">Showing the latest ${col.length}. All of them are in List view.</span>`) : ''}
      ${can.work() && s.id !== DONE ? `<form class="quick-add"><input class="input" name="title" placeholder="+ Add task" aria-label="Add task to ${esc(s.label)}"></form>` : ''}
    </section>`;
  }).join('')}</div>`;

  $$('.card-task', body).forEach((c) => {
    c.onclick = () => openTask(c.dataset.id);
    c.onkeydown = (e) => { if (e.key === 'Enter') openTask(c.dataset.id); };
    c.ondragstart = (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); };
    c.ondragend = () => c.classList.remove('dragging');
  });
  $$('.column', body).forEach((col) => {
    const clearMarks = () => $$('.drop-before, .drop-end', col).forEach((x) => x.classList.remove('drop-before', 'drop-end'));
    col.ondragover = (e) => {
      e.preventDefault();
      col.classList.add('drop');
      clearMarks();
      if (col.dataset.status === DONE) return;   // Done is ordered by when things were finished
      const { cards, index } = dropSpot(col, e.clientY);
      if (cards[index]) cards[index].classList.add('drop-before'); else $('.cards', col).classList.add('drop-end');
    };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) { col.classList.remove('drop'); clearMarks(); } };
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      clearMarks();
      const t = S.tasks.find((x) => x.id === e.dataTransfer.getData('text/plain'));
      if (!t) return;
      await moveTask(t, col, e.clientY);
    };
    const form = $('.quick-add', col);
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const title = form.elements.title.value.trim();
      if (!title) return;
      form.reset();
      await createTask({ title, status: col.dataset.status, space: defaultSpace(), assignee: prefs.who === 'me' || !can.admin() ? S.me.email : '' });
      $(`.column[data-status="${col.dataset.status}"] .quick-add input`, rootEl)?.focus();
    };
  });
}

// Where in a column the pointer is: before cards[index], or at the end when index === cards.length.
function dropSpot(col, y) {
  const cards = $$('.card-task:not(.dragging)', col);
  const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return { cards, index: i < 0 ? cards.length : i };
}

// Moves a task to another column and/or to a spot between two cards, and saves it.
async function moveTask(t, col, y) {
  const status = col.dataset.status;
  const changes = new Map();   // task id -> fields to save
  if (status !== DONE) {
    const { cards, index } = dropSpot(col, y);
    const seq = cards.map((c) => c.dataset.id).filter((id) => id !== t.id);
    const at = Math.min(index, seq.length);   // the dragged card isn't in `cards` (it has .dragging)
    seq.splice(at, 0, t.id);
    const byId = (id) => S.tasks.find((x) => x.id === id);
    const prev = byId(seq[at - 1]);
    const next = byId(seq[at + 1]);
    let order = t.order;
    if (prev && next) order = prev.order < next.order ? (prev.order + next.order) / 2 : null;
    else if (prev) order = prev.order + 1;
    else if (next) order = next.order - 1;
    if (order === null) {
      // Neighbours share a position (e.g. never ordered): number the whole column in its new order.
      seq.forEach((id, i) => { const x = byId(id); if (x && x.order !== (i + 1) * 10) changes.set(id, { order: (i + 1) * 10 }); });
    } else if (order !== t.order) changes.set(t.id, { order });
  }
  if (t.status !== status) changes.set(t.id, { ...(changes.get(t.id) || {}), status });
  if (!changes.size) return;

  const before = new Map([...changes.keys()].map((id) => [id, { ...S.tasks.find((x) => x.id === id) }]));
  for (const [id, f] of changes) {   // show it right away
    const x = S.tasks.find((y2) => y2.id === id);
    Object.assign(x, f);
    if (f.status && isDone(x)) { x.completedAt = new Date().toISOString(); x.completedBy = S.me.email; }
  }
  renderBody();
  for (const [id, f] of changes) {
    const saved = await act('tasks.save', { id, fields: f });
    const x = S.tasks.find((y2) => y2.id === id);
    if (x) Object.assign(x, saved || before.get(id));
  }
  renderBody();
}

function renderList(body, list) {
  if (!list.length) {
    body.innerHTML = '<div class="empty">No tasks here yet.</div>';
    return;
  }
  body.innerHTML = CONFIG.statuses.map((s) => {
    let group = list.filter((t) => statusById(t.status).id === s.id);
    if (!group.length) return '';
    group = s.id === DONE ? sortDone(group) : sorted(group);
    return `<section class="card flush list-group">
      <h2 class="group-head"><span class="dot" style="--c:${s.color}"></span>${esc(s.label)} <span class="count">${group.length}</span></h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Task</th><th>Assignee</th><th>Space</th><th>Priority</th><th>Due</th><th>Completed</th></tr></thead>
        <tbody>${group.map((t) => {
          const who = person(t.assignee);
          const due = dueLabel(t.due);
          return `<tr data-id="${esc(t.id)}" tabindex="0">
            <td><b>${esc(t.title)}</b></td>
            <td>${who ? `${avatar(who, 20)} ${esc(who.name)}` : '<span class="muted">-</span>'}</td>
            <td class="muted">${esc(spaceName(t.space))}</td>
            <td>${prTag(t)}</td>
            <td class="due ${isDone(t) ? '' : due.cls}">${esc(isDone(t) ? (t.due || '') : due.text) || '<span class="muted">-</span>'}</td>
            <td class="good">${t.completedAt ? `✓ ${esc(person(t.completedBy)?.name || '')} · ${esc(fmtStamp(t.completedAt))}` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table></div></section>`;
  }).join('');
  $$('tr[data-id]', body).forEach((tr) => {
    tr.onclick = () => openTask(tr.dataset.id);
    tr.onkeydown = (e) => { if (e.key === 'Enter') openTask(tr.dataset.id); };
  });
}

async function createTask(fields) {
  const saved = await act('tasks.save', { fields });
  if (saved) { S.tasks.push(saved); renderBody(); }
  return saved;
}

function replaceTask(saved) {
  const i = S.tasks.findIndex((t) => t.id === saved.id);
  if (i >= 0) S.tasks[i] = saved;
  renderBody();
}

// Task detail side panel. Pass an id, or null for a new task.
export function openTask(id, onClose) {
  const task = id ? S.tasks.find((t) => t.id === id) : null;
  if (id && !task) return toast('That task is gone. It may have been deleted.', 'error');
  const isNew = !task;
  const editable = isNew ? can.work() : can.edit(task.space);
  const draft = structuredClone(task || {
    title: '', description: '', status: CONFIG.statuses[0].id, assignee: prefs.who === 'me' || !can.admin() ? S.me.email : '',
    due: '', priority: '', space: defaultSpace(), checklist: [], comments: [],
  });
  const dis = editable ? '' : 'disabled';
  // Members only see tasks given to them or made by them, so a task someone else gave you stays yours.
  const assigneeLocked = !isNew && !can.admin() && task.createdBy !== S.me.email;
  const opt = (value, label, current) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
  // Lists for the dropdowns. A value that's no longer in a list (someone removed from the team, a status or
  // priority taken out of config.js) stays as an option, so saving never changes it behind your back.
  const keep = (list, current, label) => (current && !list.some(([v]) => v === current) ? [[current, label], ...list] : list);
  const statusOpts = keep(CONFIG.statuses.map((s) => [s.id, s.label]), draft.status, `${draft.status} (not a column now)`);
  const priorityOpts = keep(CONFIG.priorities.map((p) => [p.id, p.label]), draft.priority, `${draft.priority} (removed)`);
  // Only people who can see the task's space: anyone else would never see a task assigned to them.
  const assigneeOpts = (space, current) => keep(
    S.team.filter((p) => p.role !== 'guest' && personCanSee(p, space)).map((p) => [p.email, p.name]),
    current, `${person(current)?.name || current} (${S.team.some((p) => p.email === current) ? "can't see this space" : 'not on the team'})`);
  const assigneeHtml = (space, current) => opt('', 'Unassigned', current) + assigneeOpts(space, current).map(([v, l]) => opt(v, l, current)).join('');
  // Spaces: the main one first, then the client spaces you can work in. No "no space".
  const spaceOpts = keep(S.spaces.filter((s) => can.edit(s.id)).map((s) => [s.id, s.name]), draft.space, spaceName(draft.space));

  const panel = openModal(`
    <form class="task-form">
      <div class="panel-head">
        <span class="small muted">${esc(spaceName(draft.space))} / Tasks</span>
        <span class="grow"></span>
        ${!isNew && editable ? `<button type="button" class="btn ${isDone(draft) ? '' : 'success'}" data-complete>${isDone(draft) ? 'Reopen' : '✓ Mark complete'}</button>` : ''}
        <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="panel-body">
        <input class="title-input" name="title" placeholder="Task name" value="${esc(draft.title)}" aria-label="Task name" required ${dis}>
        <div class="field-grid">
          <label>Status<select class="input" name="status" ${dis}>${statusOpts.map(([v, l]) => opt(v, l, draft.status)).join('')}</select></label>
          <label>Assignee<select class="input" name="assignee" ${dis} ${assigneeLocked ? `disabled title="${esc(person(task.createdBy)?.name || 'Someone')} gave you this task, so only they or an admin can reassign it."` : ''}>${assigneeHtml(draft.space, draft.assignee)}</select></label>
          <label>Due<input class="input" type="date" name="due" value="${esc(draft.due)}" ${dis}></label>
          <label>Priority<select class="input" name="priority" ${dis}>${opt('', 'None', draft.priority)}${priorityOpts.map(([v, l]) => opt(v, l, draft.priority)).join('')}</select></label>
          <label>Space<select class="input" name="space" ${dis}>${spaceOpts.map(([v, l]) => opt(v, l, draft.space)).join('')}</select></label>
        </div>
        <div class="md-field">
          <div class="md-tabs"><b>Description</b>${editable ? '<button type="button" data-tab="write">Write</button><button type="button" class="on" data-tab="preview">Preview</button>' : ''}</div>
          <textarea class="input" name="description" rows="6" hidden placeholder="Details. Paste a Google Sheets link on its own line to show the sheet here.">${esc(draft.description)}</textarea>
          <div class="md preview">${renderMarkdown(draft.description) || '<p class="muted">No description.</p>'}</div>
        </div>
        <div class="checklist"><b>Checklist</b><ul></ul>
          ${editable ? '<div class="add-row"><input class="input" placeholder="Add an item" aria-label="Add checklist item" data-new-item><button type="button" class="btn" data-add-item>Add</button></div>' : ''}
        </div>
        ${isNew ? '' : `<div class="comments"><b>Comments</b><div class="comment-list"></div>
          <div class="add-row"><textarea class="input" rows="2" placeholder="Write a comment…" aria-label="Write a comment" data-new-comment></textarea><button type="button" class="btn" data-add-comment>Post</button></div></div>
          <div class="timeline small muted"><b>Timeline</b>
            <span>Created by ${esc(person(draft.createdBy)?.name || '?')} · ${esc(fmtStamp(draft.createdAt))}</span>
            ${draft.updatedAt && draft.updatedAt !== draft.createdAt ? `<span>Last changed ${esc(timeAgo(draft.updatedAt))}</span>` : ''}
            <span>${draft.completedAt ? `Completed by ${esc(person(draft.completedBy)?.name || '?')} · ${esc(fmtStamp(draft.completedAt))}` : 'Not completed yet'}</span>
          </div>`}
      </div>
      <div class="panel-foot">
        ${!isNew && can.remove(draft.createdBy, draft.space) ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-close>${editable ? 'Cancel' : 'Close'}</button>
        ${editable ? `<button class="btn primary">${isNew ? 'Create task' : 'Save'}</button>` : ''}
      </div>
    </form>`, { panel: true, onClose });

  const form = $('form', panel);
  const f = form.elements;
  // Changing the space updates who can be assigned.
  f.space.onchange = () => { f.assignee.innerHTML = assigneeHtml(f.space.value, f.assignee.value); };
  const formFields = () => ({
    title: f.title.value.trim(), status: f.status.value, assignee: f.assignee.value,
    due: f.due.value, priority: f.priority.value, space: f.space.value, description: f.description.value,
  });

  $$('[data-tab]', panel).forEach((b) => b.onclick = () => {
    $$('[data-tab]', panel).forEach((x) => x.classList.toggle('on', x === b));
    const preview = b.dataset.tab === 'preview';
    f.description.hidden = preview;
    $('.preview', panel).hidden = !preview;
    if (preview) $('.preview', panel).innerHTML = renderMarkdown(f.description.value) || '<p class="muted">No description.</p>';
    else f.description.focus();
  });

  // Checklist: saved right away on existing tasks.
  const persistChecklist = async () => {
    if (isNew) return;
    const saved = await act('tasks.save', { id: task.id, fields: { checklist: draft.checklist } });
    if (saved) replaceTask(saved);
  };
  const renderChecklist = () => {
    $('.checklist ul', panel).innerHTML = draft.checklist.map((c) => `
      <li data-id="${esc(c.id)}" class="${c.done ? 'is-done' : ''}">
        <label class="check"><input type="checkbox" ${c.done ? 'checked' : ''} ${dis}> <span>${esc(c.text)}</span></label>
        ${editable ? '<button type="button" class="icon-btn small" data-remove aria-label="Remove item">✕</button>' : ''}
      </li>`).join('') || '<li class="muted small">No items.</li>';
    $$('.checklist li[data-id]', panel).forEach((li) => {
      const item = draft.checklist.find((c) => c.id === li.dataset.id);
      $('input', li).onchange = (e) => { item.done = e.target.checked; renderChecklist(); persistChecklist(); };
      const rm = $('[data-remove]', li);
      if (rm) rm.onclick = () => { draft.checklist = draft.checklist.filter((c) => c !== item); renderChecklist(); persistChecklist(); };
    });
  };
  const addItem = () => {
    const input = $('[data-new-item]', panel);
    if (!input.value.trim()) return;
    draft.checklist.push({ id: uid(), text: input.value.trim(), done: false });
    input.value = '';
    renderChecklist();
    persistChecklist();
  };
  if (editable) {
    $('[data-add-item]', panel).onclick = addItem;
    $('[data-new-item]', panel).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } };
  }
  renderChecklist();

  if (!isNew) {
    const renderComments = () => {
      $('.comment-list', panel).innerHTML = (draft.comments || []).map((c) => `
        <div class="comment">${avatar(person(c.by), 26)}
          <div><div class="small"><b>${esc(person(c.by)?.name)}</b> <span class="muted">${esc(timeAgo(c.at))}</span></div>
          <div class="md">${renderMarkdown(c.text)}</div></div></div>`).join('') || '<p class="muted small">No comments yet.</p>';
    };
    renderComments();
    $('[data-add-comment]', panel).onclick = async () => {
      const box = $('[data-new-comment]', panel);
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      const saved = await act('tasks.comment', { id: task.id, text });
      if (saved) { draft.comments = saved.comments; renderComments(); replaceTask(saved); } else box.value = text;
    };
    const completeBtn = $('[data-complete]', panel);
    if (completeBtn) completeBtn.onclick = async () => {
      const status = isDone(draft) ? CONFIG.statuses[0].id : DONE;
      // Keep anything changed in the panel too, not just the status.
      const fields = { ...formFields(), status };
      if (!fields.title) delete fields.title;
      panel.close();
      const saved = await act('tasks.save', { id: task.id, fields });
      if (saved) { replaceTask(saved); toast(status === DONE ? 'Marked complete' : 'Reopened'); }
    };
    const del = $('[data-delete]', panel);
    if (del) del.onclick = async () => {
      if (!(await confirmBox(`Delete "${draft.title}"? This can't be undone.`))) return;
      panel.close();
      if (await act('tasks.delete', { id: task.id })) {
        S.tasks = S.tasks.filter((t) => t.id !== task.id);
        renderBody();
        toast('Task deleted');
      }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = formFields();
    if (!fields.title) return;
    panel.close();
    if (isNew) {
      if (await createTask({ ...fields, checklist: draft.checklist })) toast('Task created');
    } else {
      const saved = await act('tasks.save', { id: task.id, fields });
      if (saved) replaceTask(saved);
    }
  };
}
