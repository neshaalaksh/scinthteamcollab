import { CONFIG, DONE } from '../config.js';
import { S, act, can, inSpace, person, spaceName, statusById, priorityById, isDone } from '../state.js';
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
      <select class="input" id="task-who" aria-label="Whose tasks">
        <option value="all">Everyone</option>
        <option value="me">My tasks</option>
        <option value="none">Unassigned</option>
        ${S.team.filter((p) => p.role !== 'guest').map((p) => `<option value="${esc(p.email)}">${esc(p.name)}</option>`).join('')}
      </select>
      ${can.work() ? '<button class="btn primary" id="new-task">+ New task</button>' : ''}`;
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

function visible() {
  const q = prefs.q.toLowerCase();
  return S.tasks.filter((t) => {
    if (!inSpace(t)) return false;
    if (prefs.who === 'me' && t.assignee !== S.me.email) return false;
    if (prefs.who === 'none' && t.assignee) return false;
    if (!['all', 'me', 'none'].includes(prefs.who) && t.assignee !== prefs.who) return false;
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
      ${s.id === DONE && total > col.length ? '<a class="small" href="#/history">See all in History →</a>' : ''}
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
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const t = S.tasks.find((x) => x.id === e.dataTransfer.getData('text/plain'));
      if (!t || t.status === col.dataset.status) return;
      const before = { ...t };
      t.status = col.dataset.status; // show it moved right away
      if (isDone(t)) { t.completedAt = new Date().toISOString(); t.completedBy = S.me.email; }
      renderBody();
      const saved = await act('tasks.save', { id: t.id, fields: { status: t.status } });
      Object.assign(t, saved || before);
      renderBody();
    };
    const form = $('.quick-add', col);
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const title = form.elements.title.value.trim();
      if (!title) return;
      form.reset();
      await createTask({ title, status: col.dataset.status, space: S.space === 'all' ? '' : S.space, assignee: prefs.who === 'me' ? S.me.email : '' });
      $(`.column[data-status="${col.dataset.status}"] .quick-add input`, rootEl)?.focus();
    };
  });
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
    title: '', description: '', status: CONFIG.statuses[0].id, assignee: prefs.who === 'me' ? S.me.email : '',
    due: '', priority: '', space: S.space === 'all' ? '' : S.space, checklist: [], comments: [],
  });
  const dis = editable ? '' : 'disabled';
  const opt = (value, label, current) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;

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
          <label>Status<select class="input" name="status" ${dis}>${CONFIG.statuses.map((s) => opt(s.id, s.label, draft.status)).join('')}</select></label>
          <label>Assignee<select class="input" name="assignee" ${dis}>${opt('', 'Unassigned', draft.assignee)}${S.team.filter((p) => p.role !== 'guest').map((p) => opt(p.email, p.name, draft.assignee)).join('')}</select></label>
          <label>Due<input class="input" type="date" name="due" value="${esc(draft.due)}" ${dis}></label>
          <label>Priority<select class="input" name="priority" ${dis}>${opt('', 'None', draft.priority)}${CONFIG.priorities.map((p) => opt(p.id, p.label, draft.priority)).join('')}</select></label>
          <label>Space<select class="input" name="space" ${dis}>${can.admin() || S.me.spaces === '*' || (!isNew && !draft.space) ? opt('', 'General', draft.space) : ''}${S.spaces.map((s) => opt(s.id, s.name, draft.space)).join('')}</select></label>
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
