import { CONFIG } from '../config.js';
import { store } from '../store.js';
import { get, mutate, getTeam, personFinder, statusById, priorityById, doneStatusIds } from '../data.js';
import { $, $$, esc, uid, avatar, fmtDate, dueClass, timeAgo, openModal, toast } from '../util.js';
import { renderMarkdown } from '../markdown.js';

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('teamspace.taskprefs') || '{}'); } catch { return {}; }
})();
function savePrefs() {
  try { localStorage.setItem('teamspace.taskprefs', JSON.stringify(prefs)); } catch { /* ignore */ }
}
prefs.mode ??= 'board';
prefs.who ??= 'all';

let ctx = null; // { el, tasks, team, me, find }

export default {
  title: 'Tasks',
  async render(el, params) {
    const [tasks, team, me] = await Promise.all([get('tasks'), getTeam(), store.whoami()]);
    ctx = { el, tasks, team, me, find: personFinder(team) };
    el.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" data-act="new">+ New task</button>
        <input type="search" class="input" id="task-search" placeholder="Search tasks…" value="${esc(prefs.q || '')}">
        <select class="input" id="task-who">
          <option value="all">Everyone</option>
          <option value="me">My tasks</option>
          <option value="none">Unassigned</option>
          ${team.map((p) => `<option value="${esc(p.login)}">${esc(p.name)}</option>`).join('')}
        </select>
        <div class="seg">
          <button data-mode="board" class="${prefs.mode === 'board' ? 'on' : ''}">Board</button>
          <button data-mode="list" class="${prefs.mode === 'list' ? 'on' : ''}">List</button>
        </div>
      </div>
      <div id="task-body"></div>`;
    $('#task-who', el).value = prefs.who;
    $('[data-act=new]', el).onclick = () => openTask(null);
    $('#task-search', el).oninput = (e) => { prefs.q = e.target.value; savePrefs(); renderBody(); };
    $('#task-who', el).onchange = (e) => { prefs.who = e.target.value; savePrefs(); renderBody(); };
    $$('[data-mode]', el).forEach((b) => b.onclick = () => {
      prefs.mode = b.dataset.mode; savePrefs();
      $$('[data-mode]', el).forEach((x) => x.classList.toggle('on', x === b));
      renderBody();
    });
    renderBody();
    if (params[0]) {
      const t = tasks.find((x) => x.id === params[0]);
      if (t) openTask(t);
    }
  },
};

function visibleTasks() {
  const q = (prefs.q || '').toLowerCase();
  return ctx.tasks.filter((t) => {
    if (prefs.who === 'me' && t.assignee !== ctx.me.login) return false;
    if (prefs.who === 'none' && t.assignee) return false;
    if (!['all', 'me', 'none'].includes(prefs.who) && t.assignee !== prefs.who) return false;
    if (q && !`${t.title} ${t.description || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const priorityRank = (t) => {
  const i = CONFIG.priorities.findIndex((p) => p.id === t.priority);
  return i < 0 ? CONFIG.priorities.length : i;
};

function sortTasks(list) {
  return list.sort((a, b) =>
    (a.order ?? 0) - (b.order ?? 0)
    || priorityRank(a) - priorityRank(b)
    || (a.due || '9999').localeCompare(b.due || '9999')
    || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function taskMeta(t) {
  const who = ctx.find(t.assignee);
  const pr = priorityById(t.priority);
  const checklist = t.checklist || [];
  const doneCount = checklist.filter((c) => c.done).length;
  return `
    ${pr ? `<span class="tag" style="--c:${pr.color}">${esc(pr.label)}</span>` : ''}
    ${t.due ? `<span class="due ${doneStatusIds.has(t.status) ? '' : dueClass(t.due)}">📅 ${fmtDate(t.due)}</span>` : ''}
    ${checklist.length ? `<span class="muted small">☑ ${doneCount}/${checklist.length}</span>` : ''}
    ${t.comments?.length ? `<span class="muted small">💬 ${t.comments.length}</span>` : ''}
    <span class="spacer"></span>
    ${who ? avatar(who, 22) : ''}`;
}

function renderBody() {
  const body = $('#task-body', ctx.el);
  const list = visibleTasks();
  if (prefs.mode === 'list') return renderList(body, list);

  body.innerHTML = `<div class="board">${CONFIG.statuses.map((s) => {
    const col = sortTasks(list.filter((t) => statusById(t.status).id === s.id));
    return `<section class="column" data-status="${s.id}">
      <header><span class="status-dot" style="--c:${s.color}"></span>${esc(s.label)}<span class="count">${col.length}</span></header>
      <div class="cards">
        ${col.map((t) => `<article class="card ${doneStatusIds.has(t.status) ? 'is-done' : ''}" draggable="true" data-id="${t.id}">
          <div class="card-title">${esc(t.title)}</div>
          <div class="card-meta">${taskMeta(t)}</div>
        </article>`).join('')}
      </div>
      <form class="quick-add"><input class="input" name="title" placeholder="+ Add task"></form>
    </section>`;
  }).join('')}</div>`;

  $$('.card', body).forEach((card) => {
    card.onclick = () => openTask(ctx.tasks.find((t) => t.id === card.dataset.id));
    card.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('dragging');
    };
    card.ondragend = () => card.classList.remove('dragging');
  });
  $$('.column', body).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      const status = col.dataset.status;
      const task = ctx.tasks.find((t) => t.id === id);
      if (!task || task.status === status) return;
      task.status = status; // optimistic
      renderBody();
      await saveTask(id, { status }, `move "${task.title}" to ${statusById(status).label}`);
    };
    $('.quick-add', col).onsubmit = async (e) => {
      e.preventDefault();
      const title = e.target.elements.title.value.trim();
      if (!title) return;
      e.target.reset();
      await createTask({ title, status: col.dataset.status, assignee: prefs.who === 'me' ? ctx.me.login : '' });
      $('.column[data-status="' + col.dataset.status + '"] .quick-add input', ctx.el)?.focus();
    };
  });
}

function renderList(body, list) {
  if (!list.length) {
    body.innerHTML = '<div class="empty">No tasks here yet. Click <b>+ New task</b> to add one.</div>';
    return;
  }
  body.innerHTML = CONFIG.statuses.map((s) => {
    const group = sortTasks(list.filter((t) => statusById(t.status).id === s.id));
    if (!group.length) return '';
    return `<section class="list-group">
      <h3><span class="status-dot" style="--c:${s.color}"></span>${esc(s.label)} <span class="count">${group.length}</span></h3>
      <table class="table">
        <thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th>Priority</th></tr></thead>
        <tbody>${group.map((t) => {
          const who = ctx.find(t.assignee);
          const pr = priorityById(t.priority);
          return `<tr data-id="${t.id}" class="${doneStatusIds.has(t.status) ? 'is-done' : ''}">
            <td class="title-cell">${esc(t.title)}</td>
            <td>${who ? `${avatar(who, 20)} ${esc(who.name)}` : '<span class="muted">-</span>'}</td>
            <td class="${doneStatusIds.has(t.status) ? '' : dueClass(t.due)}">${t.due ? fmtDate(t.due) : '<span class="muted">-</span>'}</td>
            <td>${pr ? `<span class="tag" style="--c:${pr.color}">${esc(pr.label)}</span>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </section>`;
  }).join('');
  $$('tr[data-id]', body).forEach((tr) => tr.onclick = () => openTask(ctx.tasks.find((t) => t.id === tr.dataset.id)));
}

async function saveTask(id, patch, message) {
  try {
    const all = await mutate('tasks', (tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (t) Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    }, message);
    ctx.tasks = all;
    renderBody();
    return all.find((t) => t.id === id);
  } catch {
    return null;
  }
}

async function createTask(fields) {
  const task = {
    id: uid(),
    title: '',
    description: '',
    status: CONFIG.statuses[0].id,
    assignee: '',
    due: '',
    priority: '',
    checklist: [],
    comments: [],
    createdAt: new Date().toISOString(),
    createdBy: ctx.me.login,
    ...fields,
  };
  try {
    ctx.tasks = await mutate('tasks', (tasks) => { tasks.push(task); }, `add task "${task.title}"`);
    renderBody();
  } catch { /* toast shown by store */ }
  return task;
}

// Shared by other views (home) to open a task editor.
export async function openTaskById(id, onDone) {
  const [tasks, team, me] = await Promise.all([get('tasks'), getTeam(), store.whoami()]);
  ctx = { el: document.createElement('div'), tasks, team, me, find: personFinder(team) };
  ctx.el.innerHTML = '<div id="task-body"></div>';
  const t = tasks.find((x) => x.id === id);
  if (t) openTask(t, onDone);
}

function openTask(task, onDone) {
  const isNew = !task;
  const draft = structuredClone(task || {
    title: '', description: '', status: CONFIG.statuses[0].id,
    assignee: prefs.who === 'me' ? ctx.me.login : '', due: '', priority: '', checklist: [], comments: [],
  });

  const modal = openModal(`
    <form class="task-form">
      <div class="modal-head">
        <input class="title-input" name="title" placeholder="Task name" value="${esc(draft.title)}" required>
        <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="field-row">
        <label>Status<select class="input" name="status">${CONFIG.statuses.map((s) =>
          `<option value="${s.id}" ${draft.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
        <label>Assignee<select class="input" name="assignee"><option value="">Unassigned</option>${ctx.team.map((p) =>
          `<option value="${esc(p.login)}" ${draft.assignee === p.login ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label>Due<input class="input" type="date" name="due" value="${esc(draft.due)}"></label>
        <label>Priority<select class="input" name="priority"><option value="">None</option>${CONFIG.priorities.map((p) =>
          `<option value="${p.id}" ${draft.priority === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      </div>
      <div class="md-field">
        <div class="md-tabs"><span>Description</span>
          <button type="button" class="on" data-tab="write">Write</button><button type="button" data-tab="preview">Preview</button></div>
        <textarea class="input" name="description" rows="6" placeholder="Details, links… paste a Google Sheets link on its own line to embed it.">${esc(draft.description)}</textarea>
        <div class="md preview" hidden></div>
      </div>
      <div class="checklist">
        <h4>Checklist</h4>
        <ul></ul>
        <div class="add-row"><input class="input" placeholder="Add an item" data-new-item><button type="button" class="btn" data-add-item>Add</button></div>
      </div>
      ${isNew ? '' : `<div class="comments"><h4>Comments</h4><div class="comment-list"></div>
        <div class="add-row"><textarea class="input" rows="2" placeholder="Write a comment…" data-new-comment></textarea><button type="button" class="btn" data-add-comment>Post</button></div></div>`}
      <div class="modal-foot">
        ${isNew ? '' : `<button type="button" class="btn danger" data-delete>Delete</button>
          <span class="muted small">Created ${timeAgo(draft.createdAt)} by ${esc(ctx.find(draft.createdBy)?.name || draft.createdBy || '?')}</span>`}
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary">${isNew ? 'Create task' : 'Save'}</button>
      </div>
    </form>`, { wide: true });

  const form = $('form', modal);
  if (onDone) modal.addEventListener('closed', onDone);

  // Description write/preview
  $$('[data-tab]', modal).forEach((b) => b.onclick = () => {
    $$('[data-tab]', modal).forEach((x) => x.classList.toggle('on', x === b));
    const preview = b.dataset.tab === 'preview';
    form.elements.description.hidden = preview;
    const pv = $('.preview', modal);
    pv.hidden = !preview;
    if (preview) pv.innerHTML = renderMarkdown(form.elements.description.value) || '<p class="muted">Nothing yet</p>';
  });

  // Checklist: saved immediately for existing tasks
  const renderChecklist = () => {
    $('.checklist ul', modal).innerHTML = draft.checklist.map((c) => `
      <li data-id="${c.id}" class="${c.done ? 'done' : ''}">
        <label><input type="checkbox" ${c.done ? 'checked' : ''}> <span>${esc(c.text)}</span></label>
        <button type="button" class="icon-btn small" data-remove>✕</button>
      </li>`).join('');
    $$('.checklist li', modal).forEach((li) => {
      const item = draft.checklist.find((c) => c.id === li.dataset.id);
      $('input', li).onchange = (e) => { item.done = e.target.checked; persistChecklist(); renderChecklist(); };
      $('[data-remove]', li).onclick = () => {
        draft.checklist = draft.checklist.filter((c) => c !== item);
        persistChecklist(); renderChecklist();
      };
    });
  };
  const persistChecklist = () => {
    if (!isNew) saveTask(task.id, { checklist: draft.checklist }, `update checklist on "${draft.title}"`);
  };
  const addItem = () => {
    const input = $('[data-new-item]', modal);
    const text = input.value.trim();
    if (!text) return;
    draft.checklist.push({ id: uid(), text, done: false });
    input.value = '';
    persistChecklist(); renderChecklist();
  };
  $('[data-add-item]', modal).onclick = addItem;
  $('[data-new-item]', modal).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } };
  renderChecklist();

  // Comments (existing tasks only)
  if (!isNew) {
    const renderComments = () => {
      $('.comment-list', modal).innerHTML = (draft.comments || []).map((c) => `
        <div class="comment">${avatar(ctx.find(c.by), 24)}
          <div><div class="small"><b>${esc(ctx.find(c.by)?.name || c.by)}</b> <span class="muted">${timeAgo(c.at)}</span></div>
          <div class="md">${renderMarkdown(c.text)}</div></div></div>`).join('') || '<p class="muted small">No comments yet.</p>';
    };
    $('[data-add-comment]', modal).onclick = async () => {
      const box = $('[data-new-comment]', modal);
      const text = box.value.trim();
      if (!text) return;
      const comment = { id: uid(), by: ctx.me.login, text, at: new Date().toISOString() };
      box.value = '';
      draft.comments = [...(draft.comments || []), comment];
      renderComments();
      try {
        ctx.tasks = await mutate('tasks', (tasks) => {
          const t = tasks.find((x) => x.id === task.id);
          if (t) (t.comments ??= []).push(comment);
        }, `comment on "${draft.title}"`);
      } catch { /* toast shown */ }
    };
    renderComments();

    $('[data-delete]', modal).onclick = async () => {
      if (!confirm(`Delete "${draft.title}"?`)) return;
      modal.close();
      try {
        ctx.tasks = await mutate('tasks', (tasks) => tasks.filter((t) => t.id !== task.id), `delete task "${draft.title}"`);
        renderBody();
        toast('Task deleted');
      } catch { /* toast shown */ }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const fields = {
      title: f.title.value.trim(),
      status: f.status.value,
      assignee: f.assignee.value,
      due: f.due.value,
      priority: f.priority.value,
      description: f.description.value,
    };
    if (!fields.title) return;
    modal.close();
    if (isNew) {
      await createTask({ ...fields, checklist: draft.checklist });
      toast('Task created');
    } else {
      await saveTask(task.id, fields, `edit task "${fields.title}"`);
    }
  };
}
