import { S, act, can, inSpace, person, spaceName, defaultSpace } from '../state.js';
import { call } from '../api.js';
import { isDemo, CONFIG } from '../config.js';
import { $, $$, esc, timeAgo, fmtStamp, openModal, confirmBox, toast, debounce, initials, lsGet, lsSet, openLink } from '../util.js';
import { renderMarkdown, renderDoc, isHtmlBody } from '../markdown.js';
import { joinDoc, toB64, fromB64, REMOTE } from '../collab.js';
import { mountToolbar, mountFindBar, attachSlash, openLinkDialog, popup } from '../doc-tools.js';
import { mountReview, userColor } from '../doc-review.js';

// The open doc: { id, editor, ydoc, awareness, collab, canWrite, dirty, saving, timer, due, touched, ... }
let editing = null;
let rootEl = null;

export default {
  title: 'Docs',
  busy: () => !!editing,
  leave: () => { if (editing) closeDoc(); },

  async render(el, params) {
    rootEl = el;
    const [id] = params;
    if (editing && editing.id !== id) await closeDoc();
    if (editing && el.contains($('#editor'))) return;   // already open: don't rebuild the page under the cursor

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
    return openDoc(main, id);
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
  const list = $('#doc-list');
  if (!list) return;
  list.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, items]) => `
    <div class="tree-group">${esc(g)}</div>
    ${items.map((d) => `<a class="doc-link ${d.id === activeId ? 'active' : ''}" href="#/docs/${esc(d.id)}">${d.pinned ? '<span class="pin-dot" title="Pinned"></span>' : ''}${esc(d.title || 'Untitled')}</a>`).join('')}
  `).join('') || '<p class="muted small">No docs in this space.</p>';
}

async function newDoc() {
  const saved = await act('docs.save', { fields: { title: 'Untitled', space: defaultSpace(), body: '' } });
  if (!saved) return;
  S.docs.push({ ...saved, body: undefined });
  location.hash = `#/docs/${saved.id}`;
}

// ---- the editor

let editorLib = null;
function loadEditorLib() {
  if (window.TeamEditor) return Promise.resolve();
  editorLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/editor.bundle.js';
    s.onload = resolve;
    s.onerror = () => { editorLib = null; reject(new Error("Couldn't load the editor. Check your internet and refresh.")); };
    document.head.append(s);
  });
  return editorLib;
}

let reviewOpen = false;   // whether the comments panel is showing (kept while you move between docs)

async function openDoc(main, id) {
  if (editing?.id === id) return; // already open (a re-render while editing)
  main.innerHTML = '<div class="loading">Opening…</div>';
  let doc;
  try {
    [doc] = await Promise.all([call('docs.get', { id }), loadEditorLib()]);
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if ($('#doc-main') !== main) return; // navigated away while loading
  const { Y, awarenessProtocol } = window.TeamEditor;
  const canWrite = can.edit(doc.space);

  // The doc as shared data: what's saved, or (for older docs) built from the saved text.
  const ydoc = new Y.Doc();
  // Demo mode keeps the shared data (comments and so on) in this browser, as long as the text hasn't changed since.
  const demoKey = `teamspace.demo.ydoc.${id}`;
  const demoSaved = isDemo() ? lsGet(demoKey, null) : null;
  if (doc.ydoc) Y.applyUpdate(ydoc, fromB64(doc.ydoc));
  else if (demoSaved && demoSaved.version === doc.version) Y.applyUpdate(ydoc, fromB64(demoSaved.ydoc));
  else if (doc.body) {
    const html = isHtmlBody(doc.body) ? doc.body : renderMarkdown(doc.body, { embeds: 'node' });
    Y.applyUpdate(ydoc, window.TeamEditor.seedUpdate(html));
  }
  const meta = ydoc.getMap('meta');
  const awareness = new awarenessProtocol.Awareness(ydoc);

  const space = S.spaces.find((s) => s.id === doc.space);
  main.innerHTML = `
    <div class="doc-bar">
      <input class="doc-title-input" id="doc-title" value="${esc(meta.get('title') ?? doc.title)}" aria-label="Doc title" placeholder="Untitled" ${canWrite ? '' : 'readonly'}>
      <span class="small muted" id="save-state"></span>
      <span class="grow"></span>
      ${canWrite ? '' : '<span class="badge info">View only</span>'}
      ${canWrite ? '<button class="btn small mode-btn" id="mode-btn" aria-haspopup="menu"></button>' : ''}
      <button class="btn small" id="review-toggle" aria-label="Comments and suggestions">💬 <span id="review-count">0</span></button>
      <div class="presence" id="presence" aria-label="People in this doc"></div>
      <span class="conn" id="conn"></span>
      <button class="btn small" id="versions">Versions</button>
      <button class="btn small" id="doc-menu" aria-label="More">⋯</button>
    </div>
    <div class="doc-subbar small muted">${esc(space?.name || spaceName(doc.space))}${doc.folder ? ` · ${esc(doc.folder)}` : ''} · last saved ${esc(timeAgo(doc.updatedAt))} by ${esc(person(doc.updatedBy)?.name || '?')}</div>
    ${canWrite ? '<div class="doc-toolbar" id="doc-toolbar" role="toolbar" aria-label="Formatting"></div>' : ''}
    <div class="find-bar" id="find-bar" hidden></div>
    <div class="doc-body">
      <div class="doc-canvas" id="doc-canvas">
        <div class="doc-page"><div id="editor"></div></div>
      </div>
      <aside class="review-panel" id="review-panel" aria-label="Comments and suggestions" hidden></aside>
    </div>
    <div class="doc-status small muted"><span id="wc"></span><span class="grow"></span><span>${canWrite ? 'Type <b>/</b> on an empty line to add headings, tables, embeds…' : ''}</span></div>`;

  const user = { name: S.me.name, color: userColor(S.me.email), email: S.me.email };
  const e = {
    id, ydoc, awareness, canWrite, hasYdoc: !isDemo() && doc.ydoc !== undefined, space: doc.space, folder: doc.folder, pinned: doc.pinned, createdBy: doc.createdBy,
    dirty: false, saving: false, timer: null, due: 0, touched: false, listeners: [],
  };
  editing = e;

  const status = (t) => { const el = $('#save-state'); if (el) el.textContent = t; };
  const updateWords = () => {
    const cc = e.editor?.storage.characterCount;
    const el = $('#wc');
    if (cc && el) el.textContent = `${cc.words().toLocaleString()} words · ${cc.characters().toLocaleString()} characters`;
  };

  let toolbar = null;
  e.editor = window.TeamEditor.createEditor({
    el: $('#editor'),
    ydoc,
    awareness,
    user,
    editable: canWrite,
    placeholder: canWrite ? 'Start writing…' : '',
    onTransaction: () => { toolbar?.sync(); updateWords(); },
  });
  const editor = e.editor;
  editor.storage.review.user = user;
  const panel = $('#review-panel');
  const showPanel = (on) => { reviewOpen = on; panel.hidden = !on; $('#review-toggle').classList.toggle('on', on); };
  e.review = mountReview({
    host: panel, editor, ydoc, me: user, canWrite, isAdmin: can.admin(),
    onCount: (n) => { const c = $('#review-count'); if (c) c.textContent = n; },
  });
  panel.addEventListener('rv-open', () => showPanel(true));
  panel.addEventListener('rv-close', () => showPanel(false));
  $('#review-toggle').onclick = () => showPanel(panel.hidden);
  showPanel(reviewOpen);
  const addComment = () => { if (e.review.startComment()) showPanel(true); };

  // Editing / Suggesting / Viewing
  e.mode = 'edit';
  const MODES = { edit: ['✎ Editing', 'Edit the doc directly'], suggest: ['✎ Suggesting', 'Your edits become suggestions others can accept or reject'], view: ['👁 Viewing', 'Read without changing anything'] };
  const setMode = (mode) => {
    e.mode = mode;
    editor.storage.review.mode = mode;
    editor.setEditable(mode !== 'view');
    $('#doc-toolbar')?.classList.toggle('off', mode === 'view');
    $('.doc-page')?.classList.toggle('suggesting', mode === 'suggest');
    const b = $('#mode-btn');
    if (b) { b.textContent = `${MODES[mode][0]} ▾`; b.className = `btn small mode-btn ${mode}`; }
    e.review.refresh();
    toolbar?.sync();
  };
  if (canWrite) {
    $('#mode-btn').onclick = (ev) => popup(ev.currentTarget, Object.entries(MODES).map(([k, [label, hint]]) =>
      `<button type="button" class="pop-item mode-item ${e.mode === k ? 'on' : ''}" data-pick="${k}"><b>${label}</b><span class="small muted">${hint}</span></button>`).join(''), { onPick: setMode });
    setMode('edit');
  }

  if (canWrite) {
    toolbar = mountToolbar($('#doc-toolbar'), editor, { onFind: () => find.open(), onComment: addComment });
    e.detachSlash = attachSlash(editor);
  }
  const find = mountFindBar($('#find-bar'), editor);
  toolbar?.sync();
  updateWords();

  // ---- saving: the database keeps the newest merged copy
  const schedule = (ms) => {
    if (e.timer && e.due <= Date.now() + ms) return;
    clearTimeout(e.timer);
    e.due = Date.now() + ms;
    e.timer = setTimeout(() => { e.timer = null; save(false); }, ms);
  };
  e.save = save;
  // Resolves true when everything is saved. e.inflight is the save in progress, if any.
  function save(flush) {
    if (e.paused || !e.canWrite || !e.touched) return Promise.resolve(true);
    if (e.saving) { e.again = true; return Promise.resolve(false); }
    if (!e.dirty && !flush) return Promise.resolve(true);
    e.saving = true;
    e.dirty = false;
    e.inflight = saveNow(flush).finally(() => { e.inflight = null; });
    return e.inflight;
  }
  async function saveNow(flush) {
    status('Saving…');
    try {
      const fields = { title: $('#doc-title')?.value.trim() || meta.get('title') || 'Untitled', body: editor.getHTML() };
      if (e.hasYdoc) {
        // Fold in whatever teammates have saved since we opened, then save the merged copy.
        const row = await call('docs.get', { id });
        if (row.ydoc) Y.applyUpdate(ydoc, fromB64(row.ydoc), REMOTE);
        fields.ydoc = toB64(Y.encodeStateAsUpdate(ydoc));
        fields.body = editor.getHTML();
      }
      const saved = await act('docs.save', { id, fields, final: !!flush });
      if (!saved) { e.dirty = true; if (editing === e) { status('Not saved. Retrying…'); schedule(8000); } return false; }
      const m = S.docs.find((d) => d.id === id);
      if (m) Object.assign(m, { ...saved, body: undefined, ydoc: undefined });
      if (isDemo()) lsSet(demoKey, { version: saved.version, ydoc: toB64(Y.encodeStateAsUpdate(ydoc)) });
      if (editing === e) {
        status(`Saved ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
        if (!$('#doc-search')?.value) renderTree(id);
      }
      e.collab?.saved();
      return true;
    } catch {
      // e.g. the network dropped while fetching teammates' changes: keep the edits marked unsaved and retry.
      e.dirty = true;
      if (editing === e) { status('Not saved. Retrying…'); schedule(8000); }
      return false;
    } finally {
      e.saving = false;
      if (e.again && !e.paused) { e.again = false; schedule(300); }
    }
  }

  ydoc.on('update', (_u, origin) => {
    if (!canWrite) return;
    if (origin === REMOTE) { e.dirty = true; e.touched = true; schedule(12000); return; }   // backup in case the sender can't save
    e.dirty = true; e.touched = true;
    status('Editing…');
    schedule(3000);
  });

  // ---- title, shared with everyone
  const titleEl = $('#doc-title');
  titleEl.oninput = () => ydoc.transact(() => meta.set('title', titleEl.value));
  meta.observe(() => {
    const t = meta.get('title');
    if (t !== undefined && t !== titleEl.value && document.activeElement !== titleEl) titleEl.value = t;
  });
  titleEl.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); editor.commands.focus('start'); } };

  // ---- who else is here
  const renderPresence = () => {
    const seen = new Map();
    awareness.getStates().forEach((st, cid) => {
      if (cid === ydoc.clientID || !st.user?.email) return;
      seen.set(st.user.email, st.user);
    });
    const people = [...seen.values()];
    const el = $('#presence');
    if (!el) return;
    el.innerHTML = people.slice(0, 5).map((p) => `<span class="pres-chip" style="--c:${esc(p.color)}" title="${esc(p.name)} is here">${esc(initials(p.name))}</span>`).join('')
      + (people.length > 5 ? `<span class="pres-chip more">+${people.length - 5}</span>` : '');
  };
  awareness.on('change', renderPresence);

  // ---- going live
  const setConn = (state) => {
    const el = $('#conn');
    if (!el) return;
    const label = { live: isDemo() ? 'Live (this browser)' : 'Live', connecting: 'Connecting…', offline: 'Offline: changes stay here until you reconnect' }[state];
    el.className = `conn ${state}`;
    el.innerHTML = `<span class="live-dot"></span><span class="conn-text">${label}</span>`;
  };
  setConn('connecting');
  joinDoc({
    docId: id, ydoc, awareness, canWrite,
    onStatus: setConn,
    reloadFromDb: async () => {
      const row = await call('docs.get', { id }).catch(() => null);
      if (row?.ydoc && editing === e) Y.applyUpdate(ydoc, fromB64(row.ydoc), REMOTE);
    },
  }).then((collab) => {
    if (editing === e) e.collab = collab; else collab.close();
  }).catch(() => setConn('offline'));

  // ---- page behaviour
  const onKeyDown = (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const k = ev.key.toLowerCase();
    if (k === 's') { ev.preventDefault(); e.touched = true; e.dirty = true; save(true); }
    else if (k === 'f' && canWrite) { ev.preventDefault(); find.open(); }
    else if (k === 'm' && ev.altKey && canWrite) { ev.preventDefault(); addComment(); }
    else if (k === 'k' && canWrite && editor.isFocused) { ev.preventDefault(); openLinkDialog(editor); }
  };
  const onVisibility = () => { if (document.hidden) save(false); };
  const onBeforeUnload = (ev) => { if (e.dirty || e.saving) { save(false); ev.preventDefault(); ev.returnValue = ''; } };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', onBeforeUnload);
  e.listeners = [
    () => document.removeEventListener('keydown', onKeyDown),
    () => document.removeEventListener('visibilitychange', onVisibility),
    () => window.removeEventListener('beforeunload', onBeforeUnload),
  ];

  // Links: Ctrl/Cmd+click while editing, plain click when reading.
  editor.view.dom.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href]');
    if (!a) return;
    if (canWrite && !(ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); return; }
    ev.preventDefault();
    const href = a.getAttribute('href');
    if (href.startsWith('#')) location.hash = href; else openLink(href);
  });

  $('#versions').onclick = () => showVersions(id, canWrite ? editor : null);
  $('#doc-menu').onclick = (ev) => docMenu(ev.currentTarget, e, editor, titleEl);

  if (canWrite && !doc.body && !editor.getText() && titleEl.value === 'Untitled') { titleEl.focus(); titleEl.select(); }
}

function docMenu(anchor, e, editor, titleEl) {
  const item = (id, label, cls = '') => `<button type="button" class="pop-item ${cls}" data-pick="${id}">${label}</button>`;
  const doc = S.docs.find((d) => d.id === e.id);
  const canDelete = doc && can.remove(doc.createdBy, doc.space);
  popup(anchor, `
    ${e.canWrite ? item('pin', doc?.pinned ? 'Unpin from Home' : 'Pin to Home') + item('details', 'Space and folder…') : ''}
    ${CONFIG.demoSite ? '' : item('link', 'Copy link') + item('html', 'Download as web page (.html)') + item('print', 'Print or save as PDF')}
    ${item('wide', $('#doc-canvas')?.classList.contains('wide') ? 'Use page width' : 'Use full width')}
    ${canDelete ? `<div class="pop-sep"></div>${item('delete', 'Delete this doc', 'danger')}` : ''}`, {
    onPick: async (v) => {
      if (v === 'pin') {
        const saved = await act('docs.save', { id: e.id, fields: { pinned: !doc.pinned } });
        if (saved) { Object.assign(doc, { pinned: saved.pinned }); renderTree(e.id); toast(saved.pinned ? 'Pinned to Home' : 'Unpinned'); }
      } else if (v === 'details') editDetails(e, doc);
      else if (v === 'link') {
        const url = `${location.origin}${location.pathname}#/docs/${e.id}`;
        try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
      } else if (v === 'html') downloadHtml(titleEl.value || 'Untitled', editor.getHTML());
      else if (v === 'print') window.print();
      else if (v === 'wide') $('#doc-canvas')?.classList.toggle('wide');
      else if (v === 'delete') {
        if (!(await confirmBox(`Delete "${doc.title}"? This can't be undone.`))) return;
        // Stop autosave while deleting, but keep the editor (and unsaved edits) until the delete goes through.
        e.paused = true;
        clearTimeout(e.timer);
        if (e.inflight) await e.inflight;
        if (await act('docs.delete', { id: e.id })) {
          await closeDoc(true);
          S.docs = S.docs.filter((d) => d.id !== e.id);
          toast('Doc deleted');
          location.hash = '#/docs';
        } else {
          e.paused = false;
          if (e.dirty) e.save(true);
        }
      }
    },
  });
}

function editDetails(e, doc) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>Space and folder</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Space <select class="input" name="space">${S.spaces.filter((s) => can.edit(s.id) || s.id === doc.space).map((s) => `<option value="${esc(s.id)}" ${doc.space === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label>Folder <input class="input" name="folder" value="${esc(doc.folder || '')}" placeholder="optional"></label>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
  const form = $('form', box);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const saved = await act('docs.save', { id: e.id, fields: { space: form.elements.space.value, folder: form.elements.folder.value.trim() } });
    if (!saved) return;
    Object.assign(doc, { ...saved, body: undefined, ydoc: undefined });
    box.close();
    renderTree(e.id);
    toast('Saved');
  };
}

function downloadHtml(title, body) {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1f2328}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:14px;color:#555}pre{background:#f3f4f6;padding:12px;border-radius:6px}img{max-width:100%}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([page], { type: 'text/html' }));
  a.download = `${title.replace(/[^\w -]+/g, '').trim() || 'doc'}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Saves, leaves the live channel, and tears the editor down.
async function closeDoc(skipSave) {
  const e = editing;
  if (!e) return;
  if (!skipSave) {
    // Let a save that is already running finish, then save whatever was typed since.
    if (e.inflight) await e.inflight;
    clearTimeout(e.timer);
    const ok = await e.save(true);
    if (!ok && e.dirty) toast("Your last changes to this doc couldn't be saved. Check your internet.", 'error');
  }
  if (editing !== e) return;
  e.paused = true;   // no autosave after this point
  clearTimeout(e.timer);
  editing = null;
  e.collab?.close();
  e.detachSlash?.();
  e.review?.destroy();
  e.listeners.forEach((off) => off());
  e.editor.destroy();
  e.awareness.destroy();
  e.ydoc.destroy();
  if (rootEl && $('#doc-list')) renderTree();
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
    ${editor ? '<div class="row end"><button class="btn primary" id="restore">Restore this version</button></div>' : ''}`
    : '<p class="muted">No earlier versions yet. A version is kept each time someone starts editing after a break.</p>';
  let pickedIdx = 0;
  const show = (i) => {
    pickedIdx = i;
    $$('[data-i]', box).forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
    $('#version-preview', box).innerHTML = renderDoc(versions[i].body) || '<p class="muted">Empty.</p>';
  };
  if (versions.length) {
    $$('[data-i]', box).forEach((b) => b.onclick = () => show(Number(b.dataset.i)));
    show(0);
  }
  const restore = $('#restore', box);
  if (restore) restore.onclick = () => {
    const body = versions[pickedIdx].body;
    editor.commands.setContent(isHtmlBody(body) ? body : renderMarkdown(body, { embeds: 'node' }));
    box.close();
    toast('Version restored. Everyone in the doc sees it.');
  };
}
