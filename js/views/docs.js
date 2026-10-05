import { S, act, can, inSpace, person, spaceName } from '../state.js';
import { call } from '../api.js';
import { $, $$, esc, timeAgo, fmtStamp, openModal, confirmBox, toast, debounce } from '../util.js';
import { renderMarkdown } from '../markdown.js';
import { toEmbed } from '../embed.js';

let editing = null; // { id, editor, baseVersion, timer, dirty }
let rootEl = null;

export default {
  title: 'Docs',
  busy: () => !!editing,
  leave: () => { if (editing) finishEditing(true); },

  async render(el, params) {
    rootEl = el;
    const [id, mode] = params;
    if (editing && (editing.id !== id || mode !== 'edit')) await finishEditing(true);

    el.innerHTML = `
      <div class="docs-layout">
        <aside class="doc-tree">
          <div class="row"><h2 class="grow">Docs</h2>${can.work() ? '<button class="btn primary small" id="new-doc">+ New</button>' : ''}</div>
          <input type="search" class="input" id="doc-search" placeholder="Search all docs…" aria-label="Search all docs">
          <div id="doc-list"></div>
        </aside>
        <section class="doc-main" id="doc-main"></section>
      </div>`;
    renderTree(id);
    $('#doc-search').oninput = debounce(async (e) => {
      const q = e.target.value.trim();
      if (!q) return renderTree(id);
      const hits = await call('docs.search', { q }).catch(() => []);
      $('#doc-list').innerHTML = hits.length ? hits.map((h) => `
        <a class="doc-link" href="#/docs/${esc(h.id)}"><b>${esc(h.title)}</b>${h.snippet ? `<span class="small muted">…${esc(h.snippet)}…</span>` : ''}</a>`).join('')
        : '<p class="muted small">No docs match.</p>';
    }, 300);
    if ($('#new-doc')) $('#new-doc').onclick = newDoc;

    const main = $('#doc-main');
    if (!id) {
      const first = S.docs.find(inSpace);
      main.innerHTML = `<div class="empty">${first ? 'Pick a doc on the left.' : 'No docs yet.'}${can.work() ? ' Or start a new one.' : ''}</div>`;
      return;
    }
    if (mode === 'edit') return openEditor(main, id);
    return showDoc(main, id);
  },
};

function renderTree(activeId) {
  const docs = S.docs.filter(inSpace).sort((a, b) => a.title.localeCompare(b.title));
  const groups = new Map();
  docs.forEach((d) => {
    const g = d.folder || spaceName(d.space);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  });
  $('#doc-list').innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) => `
    <div class="tree-group">${esc(g)}</div>
    ${list.map((d) => `<a class="doc-link ${d.id === activeId ? 'active' : ''}" href="#/docs/${esc(d.id)}">${d.pinned ? '<span class="pin-dot" title="Starred"></span>' : ''}${esc(d.title || 'Untitled')}</a>`).join('')}
  `).join('') || '<p class="muted small">No docs in this space.</p>';
}

function lockedByOther(doc) {
  if (!doc.lockedBy || doc.lockedBy === S.me.email) return null;
  const age = (Date.now() - new Date(doc.lockedAt).getTime()) / 60000;
  return age < 10 ? person(doc.lockedBy) : null;
}

async function showDoc(main, id) {
  main.innerHTML = '<div class="loading">Loading…</div>';
  let doc;
  try {
    doc = await call('docs.get', { id });
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const meta = S.docs.find((d) => d.id === id);
  if (meta) Object.assign(meta, { ...doc, body: undefined });
  const holder = lockedByOther(doc);
  main.innerHTML = `
    <div class="doc-bar">
      ${holder ? `<span class="badge warn">${esc(holder.name)} is editing</span>` : ''}
      <span class="small muted">${esc(spaceName(doc.space))} · edited ${esc(timeAgo(doc.updatedAt))} by ${esc(person(doc.updatedBy)?.name || '?')}</span>
      <span class="grow"></span>
      ${can.edit(doc.space) ? `<button class="btn" id="pin">${doc.pinned ? 'Unstar' : 'Star'}</button>` : ''}
      <button class="btn" id="versions">Versions</button>
      ${can.remove(doc.createdBy, doc.space) ? '<button class="btn danger" id="del-doc">Delete</button>' : ''}
      ${can.edit(doc.space) ? `<a class="btn primary ${holder ? 'disabled' : ''}" href="#/docs/${esc(id)}/edit" ${holder ? 'aria-disabled="true"' : ''}>Edit</a>` : ''}
    </div>
    <article class="doc-view">
      <h1 class="doc-title">${esc(doc.title)}</h1>
      <div class="md">${renderMarkdown(doc.body) || '<p class="muted">This doc is empty.</p>'}</div>
    </article>`;

  const pin = $('#pin');
  if (pin) pin.onclick = async () => {
    const saved = await act('docs.save', { id, fields: { pinned: !doc.pinned } });
    if (saved) { Object.assign(meta, { pinned: saved.pinned }); showDoc(main, id); renderTree(id); }
  };
  $('#versions').onclick = () => showVersions(id, null);
  const del = $('#del-doc');
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Delete "${doc.title}"? This can't be undone.`))) return;
    if (await act('docs.delete', { id })) {
      S.docs = S.docs.filter((d) => d.id !== id);
      toast('Doc deleted');
      location.hash = '#/docs';
    }
  };
}

async function newDoc() {
  const saved = await act('docs.save', { fields: { title: 'Untitled', space: S.space === 'all' ? '' : S.space, body: '' }, lock: true });
  if (!saved) return;
  S.docs.push({ ...saved, body: undefined });
  location.hash = `#/docs/${saved.id}/edit`;
}

// ---- editing

let editorLib = null;
function loadEditorLib() {
  if (window.toastui?.Editor) return Promise.resolve(window.toastui.Editor);
  editorLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/toastui-editor-all.min.js';
    s.onload = () => resolve(window.toastui.Editor);
    s.onerror = () => reject(new Error("Couldn't load the editor."));
    document.head.append(s);
  });
  return editorLib;
}

async function openEditor(main, id) {
  if (editing?.id === id) return; // already open (a re-render while editing)
  main.innerHTML = '<div class="loading">Opening editor…</div>';
  const locked = await act('docs.lock', { id, on: true });
  if (!locked) { location.hash = `#/docs/${id}`; return; }
  let doc;
  let Editor;
  try {
    [doc, Editor] = await Promise.all([call('docs.get', { id }), loadEditorLib()]);
  } catch (err) {
    toast(err.message, 'error');
    location.hash = `#/docs/${id}`;
    return;
  }

  main.innerHTML = `
    <div class="doc-bar">
      <span class="badge warn"><span class="live-dot"></span>You're editing · others see it locked</span>
      <span class="small muted" id="save-state">Opened</span>
      <span class="grow"></span>
      <button class="btn" id="versions">Versions</button>
      <button class="btn" id="cancel-edit">Cancel</button>
      <button class="btn primary" id="done-edit">Done</button>
    </div>
    <div class="doc-edit">
      <input class="doc-title-input" id="doc-title" value="${esc(doc.title)}" aria-label="Doc title" placeholder="Untitled">
      <div class="row wrap doc-settings">
        <label>Space <select class="input" id="doc-space">${can.admin() || S.me.spaces === '*' ? `<option value="">General</option>` : ''}${S.spaces.map((s) => `<option value="${esc(s.id)}" ${doc.space === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Folder <input class="input" id="doc-folder" value="${esc(doc.folder)}" placeholder="optional"></label>
        <span class="small muted">Type <b>/</b> on an empty line to embed a Google Sheet, Doc, task and more.</span>
      </div>
      <div id="editor"></div>
    </div>`;
  $('#doc-space').value = doc.space || '';

  const embedButton = document.createElement('button');
  embedButton.type = 'button';
  embedButton.className = 'toastui-editor-toolbar-icons embed-btn';
  embedButton.textContent = '+ Embed';
  embedButton.setAttribute('aria-label', 'Embed');
  embedButton.style.backgroundImage = 'none';

  const editor = new Editor({
    el: $('#editor'),
    height: 'calc(100vh - 290px)',
    minHeight: '320px',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    initialValue: doc.body || '',
    usageStatistics: false,
    placeholder: 'Start writing…',
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'quote'],
      ['table', 'link', 'hr', 'code'],
      [{ name: 'embed', el: embedButton, tooltip: 'Embed a Google Sheet, Doc, task…' }],
    ],
  });
  editing = { id, editor, baseVersion: doc.version, dirty: false, saving: false };

  const status = (t) => { const el = $('#save-state'); if (el) el.textContent = t; };
  editor.on('change', () => { editing.dirty = true; status('Unsaved changes'); });
  $('#doc-title').oninput = () => { editing.dirty = true; status('Unsaved changes'); };

  // Autosave every 30s so nothing is lost and the lock stays fresh.
  editing.timer = setInterval(() => saveDraft(false), 30000);

  embedButton.onclick = () => embedMenu(editor, null);
  editor.on('keyup', (_mode, ev) => {
    if (ev.key !== '/') return;
    const [from] = editor.getSelection();
    const sel = window.getSelection();
    const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    embedMenu(editor, { from, rect });
  });

  $('#versions').onclick = () => showVersions(id, editor);
  $('#cancel-edit').onclick = async () => {
    if (editing.dirty && !(await confirmBox('Throw away your changes?', { ok: 'Discard' }))) return;
    clearInterval(editing.timer);
    editing = null;
    await act('docs.lock', { id, on: false });
    location.hash = `#/docs/${id}`;
  };
  $('#done-edit').onclick = async () => {
    if (await finishEditing(false)) location.hash = `#/docs/${id}`;
  };
}

function editorFields() {
  return {
    title: $('#doc-title')?.value.trim() || 'Untitled',
    space: $('#doc-space')?.value ?? undefined,
    folder: $('#doc-folder')?.value.trim() ?? undefined,
    body: editing.editor.getMarkdown(),
  };
}

async function saveDraft(final) {
  if (!editing || editing.saving) return false;
  if (!final && !editing.dirty) {
    act('docs.save', { id: editing.id, fields: {}, final: false }); // keeps the lock alive
    return true;
  }
  editing.saving = true;
  const fields = editorFields();
  const saved = await act('docs.save', { id: editing.id, fields, baseVersion: editing.baseVersion, final });
  if (editing) editing.saving = false;
  if (!saved) return false;
  const meta = S.docs.find((d) => d.id === saved.id);
  if (meta) Object.assign(meta, { ...saved, body: undefined });
  if (editing) {
    editing.baseVersion = saved.version;
    editing.dirty = false;
    const el = $('#save-state');
    if (el) el.textContent = `Saved ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return true;
}

async function finishEditing(quiet) {
  if (!editing) return true;
  const ok = await saveDraft(true);
  if (!ok && !quiet) return false;
  clearInterval(editing.timer);
  editing.editor.destroy?.();
  editing = null;
  if (!quiet) toast('Doc saved');
  if (rootEl && quiet) renderTree();
  return true;
}

// ---- embeds

const EMBED_KINDS = [
  { id: 'sheet', label: 'Google Sheet', hint: 'Paste the sheet link' },
  { id: 'doc', label: 'Google Doc (live co-editing)', hint: 'Paste the Google Doc link' },
  { id: 'task', label: 'Link a task' },
  { id: 'slides', label: 'Google Slides / Form / Drive file', hint: 'Paste the link' },
  { id: 'video', label: 'YouTube / Loom / Figma', hint: 'Paste the link' },
];

function embedMenu(editor, slash) {
  $('.slash-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'slash-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = EMBED_KINDS.map((k, i) => `<button role="menuitem" data-kind="${k.id}" class="${i === 0 ? 'on' : ''}">${esc(k.label)}</button>`).join('');
  document.body.append(menu);
  const rect = slash?.rect && slash.rect.width + slash.rect.height > 0 ? slash.rect : $('.embed-btn')?.getBoundingClientRect();
  if (rect) {
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
  }
  let idx = 0;
  const items = $$('button', menu);
  const close = () => {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
  };
  const choose = (kind) => {
    close();
    if (slash) editor.replaceSelection('', slash.from - 1, slash.from); // remove the "/"
    if (kind === 'task') pickTask(editor);
    else askLink(editor, EMBED_KINDS.find((k) => k.id === kind));
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items.forEach((b, i) => b.classList.toggle('on', i === idx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[idx].dataset.kind);
    } else if (e.key === 'Escape' || (slash && e.key.length === 1)) {
      close();
    }
  };
  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  items.forEach((b) => b.onmousedown = (e) => { e.preventDefault(); choose(b.dataset.kind); });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
}

// Puts text in a paragraph of its own (so a link becomes an embed): reuses the
// current line if it's empty, otherwise adds a new paragraph after this block.
function insertBlock(editor, text) {
  editor.focus();
  const view = editor.isWysiwygMode() ? editor.getCurrentModeEditor()?.view : null;
  if (!view) {
    editor.insertText(`\n\n${text}\n\n`);
    return;
  }
  const { state } = view;
  const { $from } = state.selection;
  const para = state.schema.nodes.paragraph;
  const node = para.create(null, state.schema.text(text));
  const tr = state.tr;
  if ($from.parent.type === para && $from.parent.content.size === 0 && $from.depth === 1) {
    tr.replaceWith($from.before(1), $from.after(1), node);
  } else {
    tr.insert($from.after(1), node);
  }
  view.dispatch(tr.scrollIntoView());
}

function askLink(editor, kind) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>Embed: ${esc(kind.label)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>${esc(kind.hint)}<input class="input" name="url" required placeholder="https://docs.google.com/…" autofocus></label>
      ${kind.id === 'sheet' ? `<fieldset><legend>Show it as</legend>
        <label class="check"><input type="radio" name="mode" value="edit" checked> Editable (people edit inside the app; needs Google sign-in)</label>
        <label class="check"><input type="radio" name="mode" value="view"> Read-only (works for everyone)</label></fieldset>` : ''}
      <label>Height in pixels (optional)<input class="input" name="height" type="number" min="150" max="2000" placeholder="auto"></label>
      <p class="small muted" id="embed-check"></p>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Embed</button></div>
    </form>`);
  const form = $('form', box);
  form.elements.url.oninput = (e) => {
    const info = toEmbed(e.target.value);
    $('#embed-check', box).textContent = e.target.value ? (info ? `Looks good: ${info.label}` : "We can't embed that link, so it will show as a normal link.") : '';
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    let url = form.elements.url.value.trim();
    if (kind.id === 'sheet' && form.elements.mode?.value === 'view') {
      url = url.replace(/\/(edit|htmlview|preview)([?#].*)?$/, '/preview$2').replace(/\/d\/([\w-]+)\/?$/, '/d/$1/preview');
    }
    const h = form.elements.height.value;
    box.close();
    insertBlock(editor, `${url}${h ? ` | ${h}` : ''}`);
  };
}

function pickTask(editor) {
  const tasks = S.tasks.filter(inSpace).slice(0, 200);
  const box = openModal(`
    <div class="modal-head"><h2>Link a task</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <input class="input" placeholder="Search tasks…" aria-label="Search tasks" id="task-pick-q" autofocus>
    <div class="pick-list" id="task-pick"></div>`);
  const list = () => {
    const q = $('#task-pick-q', box).value.toLowerCase();
    $('#task-pick', box).innerHTML = tasks.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 30)
      .map((t) => `<button class="row-btn" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join('') || '<p class="muted">No tasks match.</p>';
    $$('[data-id]', box).forEach((b) => b.onclick = () => {
      const t = S.tasks.find((x) => x.id === b.dataset.id);
      box.close();
      insertBlock(editor, `[☑ ${t.title.replace(/[[\]]/g, '')}](#/tasks/${t.id})`);
    });
  };
  $('#task-pick-q', box).oninput = list;
  list();
}

// ---- version history

async function showVersions(id, editor) {
  const box = openModal('<div class="modal-head"><h2>Versions</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div><div class="loading">Loading…</div>', { wide: true });
  let versions;
  try {
    versions = await call('docs.versions', { id });
  } catch (err) {
    $('.loading', box).textContent = err.message;
    return;
  }
  $('.loading', box).outerHTML = versions.length ? `
    <div class="versions">
      <div class="version-list">${versions.map((v, i) => `<button class="row-btn ${i === 0 ? 'on' : ''}" data-i="${i}"><b>Version ${v.version}</b><span class="small muted">${esc(fmtStamp(v.savedAt))} · ${esc(person(v.savedBy)?.name || '?')}</span></button>`).join('')}</div>
      <div class="version-preview md" id="version-preview"></div>
    </div>
    ${editor ? '<div class="row end"><button class="btn primary" id="restore">Put this version in the editor</button></div>' : '<p class="small muted">To restore a version, open the doc in Edit, then Versions.</p>'}`
    : '<p class="muted">No earlier versions yet. One is saved each time someone presses Done.</p>';
  let pickedIdx = 0;
  const show = (i) => {
    pickedIdx = i;
    $$('[data-i]', box).forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
    $('#version-preview', box).innerHTML = renderMarkdown(versions[i].body) || '<p class="muted">Empty.</p>';
  };
  if (versions.length) {
    $$('[data-i]', box).forEach((b) => b.onclick = () => show(Number(b.dataset.i)));
    show(0);
  }
  const restore = $('#restore', box);
  if (restore) restore.onclick = () => {
    editor.setMarkdown(versions[pickedIdx].body);
    box.close();
    toast('Version loaded. Press Done to keep it.');
  };
}
