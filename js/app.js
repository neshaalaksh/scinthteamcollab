import { store, loadSettings } from './store.js';
import { CONFIG } from './config.js';
import { get } from './data.js';
import { $, $$, esc, avatar, toast, isModalOpen } from './util.js';
import home from './views/home.js';
import tasks from './views/tasks.js';
import daily from './views/daily.js';
import docs from './views/docs.js';
import sheets from './views/sheets.js';
import settings from './views/settings.js';

const views = { home, tasks, daily, docs, sheets, settings };
let current = null; // { view, params }

function parseHash() {
  const [name = 'home', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: views[name] ? name : 'home', params: rest.map(decodeURIComponent) };
}

export async function render() {
  const { name, params } = parseHash();
  const view = views[name];
  current = { view, params, name };
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  $('#sidebar').classList.remove('open');
  const el = $('#view');
  $('#page-title').textContent = view.title;
  try {
    await view.render(el, params);
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="empty error-box">
      <h2>Couldn't load data</h2><p>${esc(err.message)}</p>
      <p><a class="btn" href="#/settings">Check settings</a></p></div>`;
  }
  renderSidebarLists();
}

async function renderSidebarLists() {
  try {
    const [docList, sheetList] = await Promise.all([get('docs'), get('sheets')]);
    const { name, params } = parseHash();
    const pinnedDocs = docList.filter((d) => d.pinned).sort((a, b) => a.title.localeCompare(b.title));
    $('#nav-docs').innerHTML = pinnedDocs.map((d) =>
      `<a href="#/docs/${d.id}" class="${name === 'docs' && params[0] === d.id ? 'active' : ''}">${esc(d.icon || '📄')} ${esc(d.title || 'Untitled')}</a>`).join('');
    $('#nav-sheets').innerHTML = sheetList.map((s) =>
      `<a href="#/sheets/${s.id}" class="${name === 'sheets' && params[0] === s.id ? 'active' : ''}">▦ ${esc(s.name)}</a>`).join('');
  } catch { /* shown in main view */ }
}

function setSync(state, text) {
  const el = $('#sync');
  el.dataset.state = state;
  $('.sync-text', el).textContent = text;
}

function describeBackend() {
  return store.isShared() ? `Synced · ${store.backend.label}` : 'Browser only (not shared)';
}

store.onChange((e) => {
  if (e.type === 'saving') setSync('busy', 'Saving…');
  if (e.type === 'idle' && store.pending === 0) setSync(store.isShared() ? 'ok' : 'local', describeBackend());
  if (e.type === 'error') {
    setSync('error', 'Save failed');
    toast(e.error.message, 'error');
  }
  if (e.type === 'saved') renderSidebarLists();
});

// Views can set `busy()` to say "don't re-render me right now" (e.g. mid-edit).
async function pull({ manual = false } = {}) {
  if (store.pending) return;
  try {
    setSync('busy', 'Refreshing…');
    const changed = await store.refreshAll();
    setSync(store.isShared() ? 'ok' : 'local', describeBackend());
    const busy = isModalOpen() || current?.view.busy?.() || document.activeElement?.matches('input, textarea, select');
    if (changed.length && !busy) await render();
    else if (manual) await render();
    if (manual) toast(changed.length ? 'Pulled latest changes' : 'Already up to date');
  } catch (err) {
    setSync('error', 'Offline?');
    if (manual) toast(err.message, 'error');
  }
}

export async function boot() {
  store.settings = loadSettings();
  store.init();
  document.title = CONFIG.workspaceName;
  $('#workspace-name').textContent = CONFIG.workspaceName;
  setSync(store.isShared() ? 'ok' : 'local', describeBackend());
  try {
    const me = await store.whoami();
    $('#me-chip').innerHTML = avatar(me, 30);
  } catch (err) {
    $('#me-chip').innerHTML = '';
    setSync('error', 'Not connected');
    if (location.hash !== '#/settings') location.hash = '#/settings';
    toast(err.message, 'error');
  }
  await render();
}

window.addEventListener('hashchange', render);
$('#refresh-btn').addEventListener('click', () => pull({ manual: true }));
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
setInterval(() => { if (!document.hidden) pull(); }, CONFIG.refreshSeconds * 1000);

boot();
