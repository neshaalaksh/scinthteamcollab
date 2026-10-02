import { S, act, can, inSpace, spaceName } from '../state.js';
import { $, $$, esc, openModal, confirmBox, toast } from '../util.js';
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

export default {
  title: 'Sheets',
  async render(el, params) {
    const list = S.sheets.filter(inSpace).sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    const current = list.find((s) => s.id === params[0]) || list[0];
    $('#topbar-slot').innerHTML = `<span class="grow"></span>${can.work() ? '<button class="btn primary" id="add-sheet">+ Add sheet</button>' : ''}`;
    if ($('#add-sheet')) $('#add-sheet').onclick = () => editSheet(null, () => this.render(el, params));

    if (!current) {
      el.innerHTML = `<div class="empty">No sheets in this space yet.${can.work() ? ' Add your team\'s key Google Sheets with <b>+ Add sheet</b>.' : ''}</div>`;
      return;
    }
    const info = embedFor(current);
    el.innerHTML = `
      <div class="sheet-tabs" role="tablist">
        ${list.map((s) => `<a role="tab" aria-selected="${s.id === current.id}" class="${s.id === current.id ? 'on' : ''}" href="#/sheets/${esc(s.id)}">${esc(s.name)}</a>`).join('')}
      </div>
      <div class="sheet-bar">
        <span class="small muted">Space: ${esc(spaceName(current.space))}</span>
        <span class="grow"></span>
        ${can.edit(current.space) ? `
          <span class="small muted">Show as</span>
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
