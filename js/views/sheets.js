import { S, act, can, inSpace, spaceName, person } from '../state.js';
import { $, $$, esc, openModal, confirmBox, toast, avatar, timeAgo, lsGet, lsSet } from '../util.js';

const sheetIcon = (size = 20) => `
  <svg class="sheet-ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#188038" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>
    <path fill="#0d652d" d="M14 2l6 6h-4a2 2 0 0 1-2-2z"/>
    <path fill="#fff" d="M7.5 11.5h9v6h-9zm1.2 1.2v1.1h2.3v-1.1zm3.5 0v1.1h3.1v-1.1zm-3.5 2.3v1.3h2.3V15zm3.5 0v1.3h3.1V15z"/>
  </svg>`;

const starIcon = (filled = false) => `
  <svg class="star-ico" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style="color: ${filled ? '#FFC107' : '#9E9E9E'}">
    <path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
  </svg>`;

// Big stylised cell grid used as the card "thumbnail", like Drive's file preview.
const thumb = () => `
  <div class="drive-thumb" aria-hidden="true">
    <div class="mini-grid">${'<i></i>'.repeat(24)}</div>
  </div>`;

const getFavorites = () => {
  const fav = lsGet('teamspace.sheets.favorites', '');
  return fav ? new Set(fav.split(',')) : new Set();
};

const setFavorites = (favSet) => {
  lsSet('teamspace.sheets.favorites', Array.from(favSet).join(','));
};

const isFavorite = (sheetId) => getFavorites().has(sheetId);

const editBtn = (s) => (can.edit(s.space)
  ? `<button class="icon-btn drive-more" data-edit="${esc(s.id)}" aria-label="Edit ${esc(s.name)}" title="Edit">⋮</button>` : '');

const starBtn = (s) => `<button class="icon-btn sheet-star" data-star="${esc(s.id)}" aria-label="${isFavorite(s.id) ? 'Remove from' : 'Add to'} favorites" title="${isFavorite(s.id) ? 'Remove from' : 'Add to'} favorites">${starIcon(isFavorite(s.id))}</button>`;

const viewMode = () => (lsGet('teamspace.sheets.view', 'grid') === 'list' ? 'list' : 'grid');

export default {
  title: 'Sheets',
  async render(el, params) {
    const favorites = getFavorites();
    const list = S.sheets.filter(inSpace).sort((a, b) => {
      const aFav = favorites.has(a.id);
      const bFav = favorites.has(b.id);
      if (aFav !== bFav) return bFav ? 1 : -1;
      return (a.order - b.order) || a.name.localeCompare(b.name);
    });
    $('#topbar-slot').innerHTML = `<span class="grow"></span>${can.work() ? '<button class="btn primary" id="add-sheet">+ New</button>' : ''}`;
    if ($('#add-sheet')) $('#add-sheet').onclick = () => editSheet(null, () => this.render(el, params));

    return this.renderBrowser(el, params, list);
  },

  renderBrowser(el, params, list) {
    let query = '';

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
        <div id="drive-body"></div>
      </div>`;

    const body = $('#drive-body', el);
    const draw = () => {
      const q = query.trim().toLowerCase();
      const shown = list.filter((s) => (!q || s.name.toLowerCase().includes(q) || spaceName(s.space).toLowerCase().includes(q)));
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
              <span role="columnheader"></span>
            </div>
            ${shown.map((s) => {
              const who = person(s.addedBy);
              return `
              <div class="drive-row link" role="row" data-open="${esc(s.id)}">
                <span class="drive-name" role="cell">${sheetIcon(20)}<span class="trunc">${esc(s.name)}</span></span>
                <span class="muted" role="cell">${esc(spaceName(s.space))}</span>
                <span class="drive-owner" role="cell">${who ? `${avatar(who, 22)}<span class="trunc">${esc(who.email === S.me?.email ? 'me' : who.name)}</span>` : ''}</span>
                <span class="drive-end" role="cell"><span class="muted">${esc(timeAgo(s.addedAt))}</span>${starBtn(s)}${editBtn(s)}</span>
              </div>`;
            }).join('')}
          </div>`;
      } else {
        body.innerHTML = `
          <div class="drive-grid">
            ${shown.map((s) => `
              <div class="drive-card link" data-open="${esc(s.id)}" title="${esc(s.name)}">
                <div class="drive-card-top">${sheetIcon(18)}<span class="trunc grow">${esc(s.name)}</span>${starBtn(s)}${editBtn(s)}</div>
                ${thumb()}
                <div class="drive-card-foot small muted"><span class="trunc">${esc(spaceName(s.space))}</span><span>${esc(timeAgo(s.addedAt))}</span></div>
              </div>`).join('')}
          </div>`;
      }
    };

    // Open the Google Sheet in a new tab; the ⋮ button edits the link instead.
    body.onclick = (e) => {
      const star = e.target.closest('[data-star]');
      if (star) {
        e.preventDefault();
        e.stopPropagation();
        const sheetId = star.dataset.star;
        const favorites = getFavorites();
        if (favorites.has(sheetId)) {
          favorites.delete(sheetId);
        } else {
          favorites.add(sheetId);
        }
        setFavorites(favorites);
        draw();
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        e.preventDefault();
        return editSheet(list.find((x) => x.id === edit.dataset.edit), () => this.render(el, params));
      }
      const open = e.target.closest('[data-open]');
      const sheet = open && list.find((x) => x.id === open.dataset.open);
      if (sheet) window.open(sheet.url, '_blank', 'noopener');
    };
    $('.drive-search-input', el).oninput = (e) => { query = e.target.value; draw(); };
    $$('[data-layout]', el).forEach((b) => b.onclick = () => { lsSet('teamspace.sheets.view', b.dataset.layout); draw(); });
    draw();
  },
};

function editSheet(sheet, done) {
  const box = openModal(`
    <form class="stack">
      <div class="modal-head"><h2>${sheet ? 'Edit sheet' : 'Add a Google Sheet'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <label>Name<input class="input" name="name" required value="${esc(sheet?.name)}" placeholder="e.g. Sales tracker"></label>
      <label>Google Sheets link<input class="input" name="url" required value="${esc(sheet?.url)}" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
      <label>Space<select class="input" name="space">${can.admin() || S.me.spaces === '*' ? '<option value="">General</option>' : ''}${S.spaces.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
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
    const fields = { name: f.name.value.trim(), url: f.url.value.trim(), mode: sheet?.mode || 'edit', space: f.space.value, height: sheet?.height || 0 };
    const saved = await act('sheets.save', { id: sheet?.id, fields });
    if (!saved) return;
    S.sheets = sheet ? S.sheets.map((s) => (s.id === saved.id ? saved : s)) : [...S.sheets, saved];
    box.close();
  };
  const del = $('[data-delete]', box);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Remove "${sheet.name}" from Teamspace? The Google Sheet itself is not touched.`, { ok: 'Remove' }))) return;
    if (await act('sheets.delete', { id: sheet.id })) {
      S.sheets = S.sheets.filter((s) => s.id !== sheet.id);
      box.close();
    }
  };
}
