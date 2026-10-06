// Drive: the team's and clients' files. The files themselves live in Google Drive; the app keeps
// the list (name, space, who uploaded it). Clicking a file opens it in Drive in a new tab.
// Everyone uploads to spaces they can see; guests (clients) see their client space only, and
// anyone can delete what they uploaded (owner and admins can delete anything).

import { S, act, can, inSpace, person, spaceName, defaultSpace } from '../state.js';
import { isDemo } from '../config.js';
import { $, $$, esc, avatar, timeAgo, fmtSize, confirmBox, toast, openModal } from '../util.js';
import { demoFileUrl } from '../demo.js';

let query = '';
let uploading = 0;

const ICONS = [
  [/pdf/, 'PDF', '#B91C1C'], [/image\//, 'IMG', '#7E22CE'], [/sheet|excel|csv/, 'XLS', '#15803D'],
  [/presentation|powerpoint/, 'PPT', '#C2410C'], [/word|document|text\//, 'DOC', '#1D4ED8'],
  [/zip|compressed/, 'ZIP', '#57534E'], [/video\//, 'VID', '#BE185D'], [/audio\//, 'AUD', '#0369A1'],
];
const fileIcon = (mime) => {
  const [, label, color] = ICONS.find(([re]) => re.test(mime || '')) || [null, 'FILE', '#62636D'];
  return `<span class="file-ico" style="--c:${color}" aria-hidden="true">${label}</span>`;
};

// Spaces this person can upload to (guests: their client spaces; members: Scinth and their clients).
const uploadSpaces = () => S.spaces.filter((s) => can.upload(s.id));

export default {
  title: 'Drive',
  async render(el) {
    const spaces = uploadSpaces();
    const pick = spaces.some((s) => s.id === defaultSpace()) ? defaultSpace() : spaces[0]?.id;
    $('#topbar-slot').innerHTML = `
      <input type="search" class="input" id="drive-q" placeholder="Search files…" aria-label="Search files" value="${esc(query)}">
      <span class="grow"></span>
      ${spaces.length > 1 ? `<label class="small muted upload-to">Upload to <select class="input" id="drive-space" aria-label="Upload to space">${spaces.map((s) => `<option value="${esc(s.id)}" ${s.id === pick ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      ${spaces.length ? '<label class="btn primary file-btn">↑ Upload<input type="file" id="drive-file" multiple hidden></label>' : ''}`;

    el.innerHTML = `
      <div class="drive-page" id="drive-drop">
        <div id="drive-list"></div>
        ${spaces.length ? `<p class="small muted drop-hint">Drag files here to upload${isDemo() ? '. Demo mode keeps them in this browser only.' : ' them to Google Drive.'}</p>` : ''}
      </div>`;
    draw();

    $('#drive-q').oninput = (e) => { query = e.target.value; draw(); };
    const targetSpace = () => $('#drive-space')?.value || pick;
    const input = $('#drive-file');
    if (input) input.onchange = () => { upload([...input.files], targetSpace()); input.value = ''; };
    const drop = $('#drive-drop');
    if (spaces.length) {
      drop.ondragover = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('drop'); } };
      drop.ondragleave = (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('drop'); };
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drop'); upload([...e.dataTransfer.files], targetSpace()); };
    }
  },
};

function draw() {
  const box = $('#drive-list');
  if (!box) return;
  const q = query.trim().toLowerCase();
  const files = S.files.filter((f) => (can.guest() || inSpace(f)) && (!q || f.name.toLowerCase().includes(q)))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  const busy = uploading ? `<div class="card upload-busy small">Uploading ${uploading} file${uploading === 1 ? '' : 's'}…</div>` : '';
  if (!files.length) {
    box.innerHTML = busy + `<div class="empty">${q ? 'No files match your search.' : can.guest() ? 'No files yet. Upload documents for the team with <b>↑ Upload</b>.' : 'No files in this space yet. Upload with <b>↑ Upload</b>.'}</div>`;
    return;
  }
  box.innerHTML = `${busy}<section class="card flush"><div class="table-wrap"><table class="table drive-table">
    <thead><tr><th>Name</th>${can.guest() ? '' : '<th>Space</th>'}<th>Uploaded by</th><th>When</th><th class="num">Size</th><th></th></tr></thead>
    <tbody>${files.map((f) => {
      const who = person(f.uploadedBy);
      const demoFile = f.url.startsWith('demo-file:');
      return `<tr>
        <td><a class="file-name" href="${demoFile ? '#' : esc(f.url)}" ${demoFile ? `data-preview="${esc(f.id)}"` : 'target="_blank" rel="noopener"'}>${fileIcon(f.mime)}<span class="trunc">${esc(f.name)}</span></a></td>
        ${can.guest() ? '' : `<td class="muted">${esc(spaceName(f.space))}</td>`}
        <td>${who ? `<span class="row nowrap">${avatar(who, 20)} ${esc(who.email === S.me.email ? 'You' : who.name)}</span>` : ''}</td>
        <td class="muted nowrap">${esc(timeAgo(f.uploadedAt))}</td>
        <td class="muted num">${esc(fmtSize(f.size))}</td>
        <td>${can.removeFile(f) ? `<button class="icon-btn small" data-del="${esc(f.id)}" aria-label="Delete ${esc(f.name)}" title="Delete">✕</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table></div></section>`;

  $$('[data-del]', box).forEach((b) => b.onclick = async () => {
    const f = S.files.find((x) => x.id === b.dataset.del);
    if (!f || !(await confirmBox(`Delete "${f.name}"? It is removed from Google Drive too.`))) return;
    if (await act('drive.delete', { id: f.id })) {
      S.files = S.files.filter((x) => x.id !== f.id);
      draw();
      toast('File deleted');
    }
  });
  $$('[data-preview]', box).forEach((a) => a.onclick = (e) => { e.preventDefault(); preview(S.files.find((x) => x.id === a.dataset.preview)); });
}

async function upload(list, space) {
  if (!list.length) return;
  if (!space || !can.upload(space)) return toast('You cannot upload to that space.', 'error');
  uploading += list.length;
  draw();
  let ok = 0;
  for (const file of list) {
    const saved = await act('drive.upload', { file, space });
    uploading--;
    if (saved) { S.files = [saved, ...S.files.filter((x) => x.id !== saved.id)]; ok++; }
    draw();
  }
  if (ok) toast(ok === 1 ? 'Uploaded' : `Uploaded ${ok} files`);
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
