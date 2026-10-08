// Drive: the team's and clients' files. The files themselves live in Google Drive, where each
// space has its own folder (and each folder made in a space is a folder inside it); the app
// keeps the list (name, space, folder, who uploaded it).
//
//   #/drive                  every space you can see, as folders, plus the latest uploads
//   #/drive/<space>          a space's folders and files
//   #/drive/<space>/<folder> one folder's files
//
// Everyone uploads to spaces they can see; guests (clients) see their client space only.
// The uploader, the owner and admins can rename, move and delete a file.

import { S, act, can, inSpace, person, spaceName, spaceById, defaultSpace, loadAll } from '../state.js';
import { isDemo } from '../config.js';
import { $, $$, esc, avatar, timeAgo, fmtSize, fmtStamp, confirmBox, toast, openModal, openLink } from '../util.js';
import { demoFileUrl } from '../demo.js';

let query = '';
let uploading = 0;
let here = { space: '', folder: '' };   // where you are ('' = all spaces)
let rerender = () => {};

const TYPES = [
  [/pdf/, 'PDF', 'PDF', '#B91C1C'], [/image\//, 'IMG', 'Image', '#7E22CE'], [/sheet|excel|csv/, 'XLS', 'Spreadsheet', '#15803D'],
  [/presentation|powerpoint/, 'PPT', 'Slides', '#C2410C'], [/word|document|text\//, 'DOC', 'Document', '#1D4ED8'],
  [/zip|compressed/, 'ZIP', 'Archive', '#57534E'], [/video\//, 'VID', 'Video', '#BE185D'], [/audio\//, 'AUD', 'Audio', '#0369A1'],
];
const typeOf = (mime) => TYPES.find(([re]) => re.test(mime || '')) || [null, 'FILE', 'File', '#62636D'];
const fileIcon = (mime) => {
  const [, label, , color] = typeOf(mime);
  return `<span class="file-ico" style="--c:${color}" aria-hidden="true">${label}</span>`;
};
const folderIcon = (color = 'var(--muted)') => `
  <svg class="folder-ico" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" style="color:${esc(color)}">
    <path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>
  </svg>`;

const href = (space, folder) => `#/drive${space ? `/${encodeURIComponent(space)}` : ''}${folder ? `/${encodeURIComponent(folder)}` : ''}`;
const place = (f) => `${spaceName(f.space)}${f.folder ? ` / ${f.folder}` : ''}`;
const byNewest = (a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt));

// Spaces shown on the Drive page: the one picked in the sidebar, or all you can see.
const shownSpaces = () => S.spaces.filter((s) => S.space === 'all' || s.id === S.space);
const visibleFiles = () => S.files.filter((f) => can.guest() || inSpace(f));
const filesIn = (space, folder) => S.files.filter((f) => f.space === space && (folder === undefined || f.folder === folder));
const foldersIn = (space) => [...new Set(filesIn(space).map((f) => f.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const sum = (files) => files.reduce((n, f) => n + (f.size || 0), 0);

export default {
  title: 'Drive',
  busy: () => uploading > 0,
  async render(el, params = []) {
    const spaces = shownSpaces();
    let [space = '', folder = ''] = params;
    // Only one space to show (a client, or a space picked in the sidebar): open it straight away.
    if (!space && spaces.length === 1) space = spaces[0].id;
    if (space && !spaces.some((s) => s.id === space)) {
      el.innerHTML = `<div class="empty">That space isn't available. <a href="${href()}">Back to Drive</a></div>`;
      return;
    }
    here = { space, folder };
    rerender = () => this.render(el, params);
    const target = uploadTarget();

    $('#topbar-slot').innerHTML = `
      <input type="search" class="input" id="drive-q" placeholder="Search files…" aria-label="Search files" value="${esc(query)}">
      <span class="grow"></span>
      ${space && !folder && can.upload(space) ? '<button class="btn" id="new-folder">+ Folder</button>' : ''}
      ${!space && uploadSpaces().length > 1 ? `<label class="small muted upload-to">Upload to <select class="input" id="drive-space" aria-label="Upload to space">${uploadSpaces().map((s) => `<option value="${esc(s.id)}" ${s.id === target.space ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      ${target.space ? '<label class="btn primary file-btn">↑ Upload<input type="file" id="drive-file" multiple hidden></label>' : ''}`;

    el.innerHTML = `
      <div class="drive-page" id="drive-drop">
        <nav class="crumbs" id="drive-crumbs" aria-label="Folder path"></nav>
        <div id="drive-banner"></div>
        <div id="drive-body"></div>
        ${target.space ? `<p class="small muted drop-hint" id="drive-hint"></p>` : ''}
      </div>`;
    draw();

    $('#drive-q').oninput = (e) => { query = e.target.value; draw(); };
    if ($('#drive-space')) $('#drive-space').onchange = () => drawHint();
    if ($('#new-folder')) $('#new-folder').onclick = newFolder;
    const input = $('#drive-file');
    if (input) input.onchange = () => { upload([...input.files], uploadTarget()); input.value = ''; };

    // Drop files anywhere on the page to upload them here, or onto a folder to upload into it.
    const drop = $('#drive-drop');
    if (target.space) {
      drop.ondragover = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('drop'); } };
      drop.ondragleave = (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('drop'); };
      drop.ondrop = (e) => {
        e.preventDefault();
        drop.classList.remove('drop');
        const card = e.target.closest('[data-drop-space]');
        const to = card ? { space: card.dataset.dropSpace, folder: card.dataset.dropFolder || '' } : uploadTarget();
        upload([...e.dataTransfer.files], to);
      };
    }
  },
};

// Spaces this person can upload to (guests: their client spaces; members: Scinth and their clients).
const uploadSpaces = () => shownSpaces().filter((s) => can.upload(s.id));

// Where an upload goes: the space and folder you are in, or the space picked next to Upload.
function uploadTarget() {
  if (here.space) return can.upload(here.space) ? { ...here } : { space: '', folder: '' };
  const spaces = uploadSpaces();
  const picked = $('#drive-space')?.value;
  const space = spaces.some((s) => s.id === picked) ? picked
    : spaces.some((s) => s.id === defaultSpace()) ? defaultSpace() : spaces[0]?.id || '';
  return { space, folder: '' };
}

function drawHint() {
  const hint = $('#drive-hint');
  if (!hint) return;
  const t = uploadTarget();
  hint.innerHTML = `Drag files here to upload them to <b>${esc(place(t))}</b>${isDemo() ? '. Demo mode keeps them in this browser only.' : ' in Google Drive.'}`;
}

function draw() {
  const body = $('#drive-body');
  if (!body) return;
  drawCrumbs();
  drawBanner();
  drawHint();
  const busy = uploading ? `<div class="card upload-busy small">Uploading ${uploading} file${uploading === 1 ? '' : 's'}…</div>` : '';
  const q = query.trim().toLowerCase();

  // Searching: every match in what you are looking at, with where each one is.
  if (q) {
    const scope = here.space ? filesIn(here.space, here.folder || undefined) : visibleFiles();
    const hits = scope.filter((f) => f.name.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q)).sort(byNewest);
    body.innerHTML = busy + (hits.length ? fileTable(hits, { where: true }) : '<div class="empty">No files match your search.</div>');
    return wire(body);
  }

  if (!here.space) {
    // All spaces: one folder per space, then the latest uploads so new files are easy to find.
    const spaces = shownSpaces();
    const recent = visibleFiles().sort(byNewest).slice(0, 10);
    body.innerHTML = `${busy}
      <h2 class="section-title">Spaces</h2>
      <div class="folder-grid">${spaces.map((s) => folderCard({ space: s.id, name: s.name, color: s.color, files: filesIn(s.id) })).join('')}</div>
      <h2 class="section-title">Latest uploads</h2>
      ${recent.length ? fileTable(recent, { where: true }) : '<div class="empty">No files yet. Upload with <b>↑ Upload</b>, or open a space first.</div>'}`;
    return wire(body);
  }

  const sp = spaceById(here.space);
  if (!here.folder) {
    const folders = foldersIn(here.space);
    const loose = filesIn(here.space, '').sort(byNewest);
    body.innerHTML = `${busy}
      ${folders.length ? `<h2 class="section-title">Folders</h2><div class="folder-grid">${folders.map((name) => folderCard({ space: here.space, folder: name, name, color: sp?.color, files: filesIn(here.space, name) })).join('')}</div>` : ''}
      ${folders.length && loose.length ? '<h2 class="section-title">Files</h2>' : ''}
      ${loose.length ? fileTable(loose) : folders.length ? '' : `<div class="empty">No files in ${esc(sp?.name || 'this space')} yet.${can.upload(here.space) ? ' Upload with <b>↑ Upload</b>, or make a <b>+ Folder</b> first.' : ''}</div>`}`;
    return wire(body);
  }

  const files = filesIn(here.space, here.folder).sort(byNewest);
  body.innerHTML = busy + (files.length ? fileTable(files)
    : `<div class="empty">This folder is empty.${can.upload(here.space) ? ' Upload files into it with <b>↑ Upload</b>. A folder is kept once it has a file in it.' : ''}</div>`);
  wire(body);
}

function drawCrumbs() {
  const box = $('#drive-crumbs');
  if (!box) return;
  const parts = [];
  if (shownSpaces().length > 1) parts.push([href(), 'Drive']);
  if (here.space) parts.push([href(here.space), spaceName(here.space)]);
  if (here.folder) parts.push([href(here.space, here.folder), here.folder]);
  box.innerHTML = parts.map(([link, label], i) => (i === parts.length - 1
    ? `<b aria-current="page">${esc(label)}</b>` : `<a href="${link}">${esc(label)}</a><span class="muted" aria-hidden="true">›</span>`)).join('');
  box.hidden = !here.space;
}

// Owner and admins: files uploaded before each space had its own Google Drive folder.
function drawBanner() {
  const box = $('#drive-banner');
  if (!box) return;
  const loose = can.admin() && !isDemo() ? S.files.filter((f) => !f.sorted).length : 0;
  box.innerHTML = loose ? `<div class="card row drive-banner small">
      <span class="grow">${loose} file${loose === 1 ? ' is' : 's are'} still loose in the main Google Drive folder (uploaded before each space had its own folder).</span>
      <button class="btn small" id="drive-sort">Sort into folders</button></div>` : '';
  if (loose) $('#drive-sort').onclick = organize;
}

function folderCard({ space, folder = '', name, color, files }) {
  const last = files.slice().sort(byNewest)[0];
  return `<a class="folder-card" href="${href(space, folder)}" data-drop-space="${esc(space)}" data-drop-folder="${esc(folder)}">
    ${folderIcon(color)}
    <span class="folder-text"><b class="trunc">${esc(name)}</b>
      <span class="small muted trunc">${files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${esc(fmtSize(sum(files)))}${last ? ` · ${esc(timeAgo(last.uploadedAt))}` : ''}` : 'Empty'}</span></span>
  </a>`;
}

function fileTable(files, { where = false } = {}) {
  return `<section class="card flush"><div class="table-wrap"><table class="table drive-table">
    <thead><tr><th>Name</th>${where ? '<th>Location</th>' : ''}<th>Uploaded by</th><th>Uploaded</th><th class="num">Size</th><th></th></tr></thead>
    <tbody>${files.map((f) => {
      const who = person(f.uploadedBy);
      return `<tr>
        <td><a class="file-name" href="${isDemo() ? '#' : esc(f.url)}" data-open="${esc(f.id)}" ${isDemo() ? '' : 'target="_blank" rel="noopener"'}>${fileIcon(f.mime)}<span class="trunc">${esc(f.name)}</span></a></td>
        ${where ? `<td><a class="muted" href="${href(f.space, f.folder)}">${esc(place(f))}</a></td>` : ''}
        <td>${who ? `<span class="row nowrap">${avatar(who, 20)} ${esc(who.email === S.me.email ? 'You' : who.name)}</span>` : ''}</td>
        <td class="muted nowrap" title="${esc(fmtStamp(f.uploadedAt))}">${esc(timeAgo(f.uploadedAt))}</td>
        <td class="muted num">${esc(fmtSize(f.size))}</td>
        <td><button class="icon-btn small" data-info="${esc(f.id)}" aria-label="Details for ${esc(f.name)}" title="Details${can.editFile(f) ? ', rename, move' : ''}">⋮</button></td>
      </tr>`;
    }).join('')}</tbody></table></div></section>`;
}

function wire(box) {
  $$('[data-info]', box).forEach((b) => b.onclick = () => details(S.files.find((x) => x.id === b.dataset.info)));
  if (isDemo()) $$('[data-open]', box).forEach((a) => a.onclick = (e) => { e.preventDefault(); preview(S.files.find((x) => x.id === a.dataset.open)); });
}

// ---- details: everything about a file, and renaming, moving and deleting it

function details(f) {
  if (!f) return;
  const edit = can.editFile(f);
  const who = person(f.uploadedBy);
  const changer = f.updatedAt ? person(f.updatedBy) : null;
  const [, , kind] = typeOf(f.mime);
  const spaces = S.spaces.filter((s) => can.upload(s.id) || s.id === f.space);
  const box = openModal(`
    <form class="stack file-details">
      <div class="modal-head"><h2 class="row">${fileIcon(f.mime)}<span class="trunc">${esc(f.name)}</span></h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      ${edit ? `<label>Name<input class="input" name="name" required maxlength="255" value="${esc(f.name)}"></label>` : ''}
      <dl class="facts">
        <dt>Type</dt><dd>${esc(kind)}${f.mime ? ` <span class="muted small">(${esc(f.mime)})</span>` : ''}</dd>
        <dt>Size</dt><dd>${esc(fmtSize(f.size) || '–')}</dd>
        <dt>Location</dt><dd>${esc(place(f))}</dd>
        <dt>Uploaded by</dt><dd>${who ? `<span class="row nowrap">${avatar(who, 20)} ${esc(who.name)} <span class="muted small trunc">${esc(who.email)}</span></span>` : '–'}</dd>
        <dt>Uploaded</dt><dd>${esc(fmtStamp(f.uploadedAt))}</dd>
        ${changer ? `<dt>Last changed</dt><dd>${esc(fmtStamp(f.updatedAt))} by ${esc(changer.name)}</dd>` : ''}
      </dl>
      ${edit ? `
        <fieldset class="stack move-box">
          <legend>Move</legend>
          <div class="row wrap">
            <label class="grow">Space<select class="input" name="space">${spaces.map((s) => `<option value="${esc(s.id)}" ${s.id === f.space ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
            <label class="grow">Folder<input class="input" name="folder" maxlength="100" list="folder-names" value="${esc(f.folder)}" placeholder="none, straight in the space"></label>
            <datalist id="folder-names"></datalist>
          </div>
        </fieldset>` : ''}
      <div class="row wrap">
        ${can.removeFile(f) ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-open>${isDemo() ? 'Preview' : 'Open in Google Drive'}</button>
        ${edit ? '<button class="btn primary">Save</button>' : ''}
      </div>
    </form>`);
  const form = $('form', box);
  const els = form.elements;
  $('[data-open]', box).onclick = () => (isDemo() ? preview(f) : openLink(f.url));

  if (edit) {
    const fillFolders = () => { $('#folder-names', box).innerHTML = foldersIn(els.space.value).map((n) => `<option value="${esc(n)}">`).join(''); };
    els.space.onchange = fillFolders;
    fillFolders();
    // Select the name without its extension, ready to type over.
    const dot = f.name.lastIndexOf('.');
    setTimeout(() => els.name.setSelectionRange(0, dot > 0 ? dot : f.name.length), 0);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fields = {};
      const name = els.name.value.trim();
      const folder = els.folder.value.replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim();
      if (!name) return toast('A file needs a name.', 'error');
      if (name !== f.name) fields.name = name;
      if (els.space.value !== f.space) fields.space = els.space.value;
      if (folder !== f.folder) fields.folder = folder;
      if (!Object.keys(fields).length) return box.close();
      const btn = $('button.primary', form);
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const saved = await act('drive.update', { id: f.id, fields });
      btn.disabled = false;
      btn.textContent = 'Save';
      if (!saved) return;
      S.files = S.files.map((x) => (x.id === saved.id ? saved : x));
      box.close();
      toast(fields.space || fields.folder !== undefined ? `Moved to ${place(saved)}` : 'Renamed');
      rerender();
    };
  }

  const del = $('[data-delete]', box);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Delete "${f.name}"? It is removed from Google Drive too.`))) return;
    if (await act('drive.delete', { id: f.id })) {
      S.files = S.files.filter((x) => x.id !== f.id);
      box.close();
      toast('File deleted');
      draw();
    }
  };
}

// ---- folders, uploads and sorting

function newFolder() {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>New folder in ${esc(spaceName(here.space))}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Name<input class="input" name="name" required maxlength="100" placeholder="e.g. Contracts"></label>
      <p class="small muted">Upload files into it next. It shows up in Google Drive with the first file.</p>
      <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create</button></div>
    </form>`);
  $('form', box).onsubmit = (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.replace(/[/\\]+/g, '-').replace(/\s+/g, ' ').trim();
    if (!name) return;
    box.close();
    location.hash = href(here.space, name);
  };
}

async function upload(list, to) {
  if (!list.length) return;
  if (!to.space || !can.upload(to.space)) return toast('You cannot upload to that space.', 'error');
  uploading += list.length;
  draw();
  let ok = 0;
  for (const file of list) {
    const saved = await act('drive.upload', { file, space: to.space, folder: to.folder });
    uploading--;
    if (saved) { S.files = [saved, ...S.files.filter((x) => x.id !== saved.id)]; ok++; }
    draw();
  }
  if (ok) toast(`${ok === 1 ? 'Uploaded' : `Uploaded ${ok} files`} to ${place(to)}`);
}

async function organize() {
  const btn = $('#drive-sort');
  btn.disabled = true;
  btn.textContent = 'Sorting…';
  let sorted = 0;
  let failed = 0;
  for (;;) {
    const res = await act('drive.organize');
    if (!res) break;
    sorted += res.sorted;
    failed = res.failed.length;
    if (!res.sorted || !res.left) break;
  }
  if (sorted) toast(`Sorted ${sorted} file${sorted === 1 ? '' : 's'} into space folders`);
  if (failed) toast(`${failed} file${failed === 1 ? '' : 's'} couldn't be moved (missing from Google Drive?).`, 'error');
  await loadAll().catch(() => {});
  draw();
}

// Demo mode: files stay in this browser, so show them here instead of opening Google Drive.
async function preview(f) {
  if (!f) return;
  const url = await demoFileUrl(f.url);
  const body = !url ? `<p class="muted">${f.url.startsWith('demo-file:sample-') ? 'This is a sample file: in the demo, only files you upload have contents.' : 'This file is no longer in this browser (demo data was reset).'} On the real site, clicking a file opens it in Google Drive.</p>`
    : /^image\//.test(f.mime) ? `<img class="file-preview" src="${url}" alt="${esc(f.name)}">`
      : /^text\/|json|csv/.test(f.mime) ? `<pre class="file-preview">${esc(await (await fetch(url)).text())}</pre>`
        : '<p class="muted">Demo mode keeps files in this browser. On the real site this opens the file in Google Drive.</p>';
  openModal(`<div class="modal-head"><h2>${esc(f.name)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>${body}
    <p class="small muted">${esc(fmtSize(f.size))} · uploaded ${esc(timeAgo(f.uploadedAt))} by ${esc(person(f.uploadedBy)?.name || '')}</p>`, { wide: true });
}

