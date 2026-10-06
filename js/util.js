export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the wall clock).
export function isoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// Start of a local day, as an ISO timestamp (for comparing with stored times).
export function dayStartIso(iso) {
  return parseDate(iso).toISOString();
}

export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  return parseDate(iso.slice(0, 10)).toLocaleDateString(undefined, opts);
}

export function fmtDay(iso) {
  const today = isoDate();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  return parseDate(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

export function fmtStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${fmtDay(isoDate(d))}, ${fmtTime(ts)}`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function dueLabel(iso) {
  if (!iso) return { text: '', cls: '' };
  const today = isoDate();
  if (iso < today) return { text: `Overdue · ${fmtDate(iso)}`, cls: 'overdue' };
  if (iso === today) return { text: 'Today', cls: 'due-today' };
  return { text: fmtDate(iso), cls: '' };
}

function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function initials(name) {
  // First letter (or digit) of the first two words, skipping things like "(" in "Maya (Acme)".
  return String(name || '?').split(/[\s._-]+/).map((p) => p.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean)
    .slice(0, 2).map((c) => c.toUpperCase()).join('') || '?';
}

export function avatar(person, size = 26) {
  if (!person) return '';
  return `<span class="avatar" title="${esc(person.name)}" style="--h:${hue(person.email)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px">${esc(initials(person.name))}</span>`;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  $('#toasts').append(el);
  const life = kind === 'error' ? 6000 : 2500;
  setTimeout(() => el.classList.add('out'), life);
  setTimeout(() => el.remove(), life + 400);
}

// Opens a modal or side panel. Returns the panel element, which has .close().
export function openModal(html, { panel = false, wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `backdrop ${panel ? 'as-panel' : ''}`;
  wrap.innerHTML = `<div class="${panel ? 'panel' : 'modal'} ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(wrap);
  const box = wrap.firstElementChild;
  const close = () => {
    if (!wrap.isConnected) return;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.activeElement?.tagName === 'TEXTAREA') return;
    if ($$('.backdrop').pop() === wrap) close();   // only the top one, not the dialogs under it
  };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  box.close = close;
  $$('[data-close]', box).forEach((b) => b.addEventListener('click', close));
  setTimeout(() => $('[autofocus], input:not([type=checkbox]), textarea, select', box)?.focus(), 0);
  return box;
}

export const isModalOpen = () => !!$('.backdrop');

// In-page confirm (the browser's confirm() is easy to miss).
export function confirmBox(message, { ok = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const box = openModal(`
      <div class="confirm">
        <p>${esc(message)}</p>
        <div class="row end">
          <button class="btn" data-close>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>
        </div>
      </div>`, { onClose: () => { if (!answered) resolve(false); } });
    $('[data-ok]', box).onclick = () => { answered = true; box.close(); resolve(true); };
  });
}

// Opens a web address in a new tab with a real link click (some hosts block window.open).
export function openLink(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
