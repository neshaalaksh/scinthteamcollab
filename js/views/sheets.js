import { S, act, can, inSpace, spaceName, person } from '../state.js';
import { $, $$, esc, openModal, confirmBox, toast, avatar, timeAgo, lsGet, lsSet } from '../util.js';
import { toEmbed, embedHtml } from '../embed.js';

// A sheet link is saved as the normal Google link plus a mode; this turns it
// into the address we show inside the app.
function embedFor(sheet) {
  let url = sheet.url;
  if (sheet.mode === 'view' && !/\/d\/e\//.test(url)) {
    url = url.replace(/\/(edit|htmlview|preview)([?#].*)?$/, '/preview$2');
    if (!/\/preview/.test(url)) url = url.replace(/\/d\/([\w-]+).*$/, '/d/$1/preview');
  }
  return toEmbed(url);
}

const sheetIcon = (size = 20) => `
  <svg class="sheet-ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#188038" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>
    <path fill="#0d652d" d="M14 2l6 6h-4a2 2 0 0 1-2-2z"/>
    <path fill="#fff" d="M7.5 11.5h9v6h-9zm1.2 1.2v1.1h2.3v-1.1zm3.5 0v1.1h3.1v-1.1zm-3.5 2.3v1.3h2.3V15zm3.5 0v1.3h3.1V15z"/>
  </svg>`;

// Big stylised cell grid used as the card "thumbnail", like Drive's file preview.
const thumb = () => `
  <div class="drive-thumb" aria-hidden="true">
    <div class="mini-grid">${'<i></i>'.repeat(24)}</div>
  </div>`;

const viewMode = () => (lsGet('teamspace.sheets.view', 'grid') === 'list' ? 'list' : 'grid');

export default {
  title: 'Sheets',
  async render(el, params) {
    const list = S.sheets.filter(inSpace).sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    const current = params[0] && list.find((s) => s.id === params[0]);
    $('#topbar-slot').innerHTML = `<span class="grow"></span>${can.work() ? '<button class="btn primary" id="add-sheet">+ New</button>' : ''}`;
    if ($('#add-sheet')) $('#add-sheet').onclick = () => editSheet(null, () => this.render(el, params));

    if (current) return this.renderViewer(el, params, current);
    return this.renderBrowser(el, params, list);
  },

  renderBrowser(el, params, list) {
    let query = '';
    let filter = 'all';

    el.innerHTML = `
      <div class="drive">
        <div class="drive-search">
          <span class="drive-search-ico" aria-hidden="true">⌕</span>
          <input class="drive-search-input" type="search" placeholder="Search in Sheets" aria-label="Search sheets" autocomplete="off">
        </div>
        <div class="drive-head">
          <h2 class="drive-title">All sheets</h2>
          <span class="grow"></span>
          <div class="seg" role="group" aria-label="Layout">
            <button data-layout="list" title="List layout" aria-label="List layout">☰</button>
            <button data-layout="grid" title="Grid layout" aria-label="Grid layout">▦</button>
          </div>
        </div>
        <div class="drive-chips" role="group" aria-label="Filter">
          <button class="drive-chip on" data-filter="all">All</button>
          <button class="drive-chip" data-filter="edit">Editable</button>
          <button class="drive-chip" data-filter="view">Read-only</button>
        </div>
        <div id="drive-body"></div>
      </div>`;

    const body = $('#drive-body', el);
    const draw = () => {
      const q = query.trim().toLowerCase();
      const shown = list.filter((s) => (filter === 'all' || (filter === 'view') === (s.mode === 'view'))
        && (!q || s.name.toLowerCase().includes(q) || spaceName(s.space).toLowerCase().includes(q)));
      const layout = viewMode();
      $$('[data-layout]', el).forEach((b) => b.classList.toggle('on', b.dataset.layout === layout));

      if (!list.length) {
        body.innerHTML = `<div class="empty">No sheets in this space yet.${can.work() ? ' Add your team\'s key Google Sheets with <b>+ New</b>.' : ''}</div>`;
        return;
      }
      if (!shown.length) {
        body.innerHTML = '<div class="empty">No sheets match your search.</div>';
        return;
      }

      if (layout === 'list') {
        body.innerHTML = `
          <div class="drive-list" role="table" aria-label="Sheets">
            <div class="drive-row head" role="row">
              <span role="columnheader">Name</span><span role="columnheader">Space</span>
              <span role="columnheader">Owner</span><span role="columnheader">Added</span>
            </div>
            ${shown.map((s) => {
              const who = person(s.addedBy);
              return `
              <a class="drive-row" role="row" href="#/sheets/${esc(s.id)}">
                <span class="drive-name" role="cell">${sheetIcon(20)}<span class="trunc">${esc(s.name)}</span>${s.mode === 'view' ? '<span class="drive-lock" title="Read-only">🔒</span>' : ''}</span>
                <span class="muted" role="cell">${esc(spaceName(s.space))}</span>
                <span class="drive-owner" role="cell">${who ? `${avatar(who, 22)}<span class="trunc">${esc(who.email === S.me?.email ? 'me' : who.name)}</span>` : ''}</span>
                <span class="muted" role="cell">${esc(timeAgo(s.addedAt))}</span>
              </a>`;
            }).join('')}
          </div>`;
      } else {
        body.innerHTML = `
          <div class="drive-grid">
            ${shown.map((s) => `
              <a class="drive-card" href="#/sheets/${esc(s.id)}" title="${esc(s.name)}">
                <div class="drive-card-top">${sheetIcon(18)}<span class="trunc">${esc(s.name)}</span>${s.mode === 'view' ? '<span class="drive-lock" title="Read-only">🔒</span>' : ''}</div>
                ${thumb()}
                <div class="drive-card-foot small muted"><span class="trunc">${esc(spaceName(s.space))}</span><span>${esc(timeAgo(s.addedAt))}</span></div>
              </a>`).join('')}
          </div>`;
      }
    };

    $('.drive-search-input', el).oninput = (e) => { query = e.target.value; draw(); };
    $$('[data-filter]', el).forEach((b) => b.onclick = () => {
      filter = b.dataset.filter;
      $$('[data-filter]', el).forEach((x) => x.classList.toggle('on', x === b));
      draw();
    });
    $$('[data-layout]', el).forEach((b) => b.onclick = () => { lsSet('teamspace.sheets.view', b.dataset.layout); draw(); });
    draw();
  },

  renderViewer(el, params, current) {
    const info = embedFor(current);
    el.innerHTML = `
      <div class="drive-viewer-head">
        <a class="icon-btn" href="#/sheets" aria-label="Back to Sheets" title="Back to Sheets">←</a>
        ${sheetIcon(26)}
        <h1 class="drive-viewer-title trunc">${esc(current.name)}</h1>
        <span class="small muted">${current.mode === 'view' ? '🔒 Read-only' : 'Editable'} · ${esc(spaceName(current.space))}</span>
        <span class="grow"></span>
        ${can.edit(current.space) ? `
          <div class="seg" role="group" aria-label="Show as">
            <button data-mode="edit" class="${current.mode !== 'view' ? 'on' : ''}">Editable</button>
            <button data-mode="view" class="${current.mode === 'view' ? 'on' : ''}">Read-only</button>
          </div>
          <button class="btn" id="edit-sheet">Edit</button>` : ''}
        <a class="btn" href="${esc(current.url)}" target="_blank" rel="noopener">Open in Google Sheets ↗</a>
      </div>
      <div class="sheet-frame">${info ? embedHtml(info, current.height || 'fill') : '<div class="empty">This link can\'t be shown inside the app. Use "Open in Google Sheets".</div>'}</div>
      <p class="small muted">${current.mode === 'view'
        ? 'Read-only view. Anyone with access to the sheet can see it here.'
        : 'Editable: changes save straight to Google. You need to be signed in to Google in this browser. If it asks you to sign in, use "Open in Google Sheets".'}</p>`;

    $$('[data-mode]', el).forEach((b) => b.onclick = async () => {
      const saved = await act('sheets.save', { id: current.id, fields: { mode: b.dataset.mode } });
      if (saved) { Object.assign(current, saved); this.render(el, params); }
    });
    if ($('#edit-sheet')) $('#edit-sheet').onclick = () => editSheet(current, () => this.render(el, params));
  },
};

function editSheet(sheet, done) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${sheet ? 'Edit sheet' : 'Add a Google Sheet'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Name<input class="input" name="name" required value="${esc(sheet?.name)}" placeholder="e.g. Sales tracker"></label>
      <label>Google Sheets link<input class="input" name="url" required value="${esc(sheet?.url)}" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
      <fieldset><legend>Show it as</legend>
        <label class="check"><input type="radio" name="mode" value="edit" ${sheet?.mode !== 'view' ? 'checked' : ''}> Editable (edit inside the app; needs Google sign-in)</label>
        <label class="check"><input type="radio" name="mode" value="view" ${sheet?.mode === 'view' ? 'checked' : ''}> Read-only (works for everyone)</label>
      </fieldset>
      <label>Space<select class="input" name="space">${can.admin() || S.me.spaces === '*' ? '<option value="">General</option>' : ''}${S.spaces.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>Height in pixels (optional)<input class="input" type="number" name="height" min="200" max="3000" value="${sheet?.height || ''}" placeholder="fill the screen"></label>
      <div class="row">
        ${sheet && can.remove(sheet.addedBy, sheet.space) ? '<button type="button" class="btn danger" data-delete>Remove</button>' : ''}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button>
      </div>
    </form>`, { onClose: done });
  const form = $('form', box);
  form.elements.space.value = sheet ? sheet.space : (S.space === 'all' ? (form.elements.space.options[0]?.value ?? '') : S.space);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(f.url.value.trim())) return toast('Paste a Google Sheets link (docs.google.com/spreadsheets/…).', 'error');
    const fields = { name: f.name.value.trim(), url: f.url.value.trim(), mode: f.mode.value, space: f.space.value, height: Number(f.height.value) || 0 };
    const saved = await act('sheets.save', { id: sheet?.id, fields });
    if (!saved) return;
    S.sheets = sheet ? S.sheets.map((s) => (s.id === saved.id ? saved : s)) : [...S.sheets, saved];
    box.close();
    if (!sheet) location.hash = `#/sheets/${saved.id}`;
  };
  const del = $('[data-delete]', box);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Remove "${sheet.name}" from Teamspace? The Google Sheet itself is not touched.`, { ok: 'Remove' }))) return;
    if (await act('sheets.delete', { id: sheet.id })) {
      S.sheets = S.sheets.filter((s) => s.id !== sheet.id);
      box.close();
      location.hash = '#/sheets';
    }
  };
}
