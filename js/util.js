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

export function fmtDate(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  return parseDate(iso).toLocaleDateString(undefined, opts);
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

export function dueClass(iso) {
  if (!iso) return '';
  const today = isoDate();
  if (iso < today) return 'overdue';
  if (iso === today) return 'due-today';
  return '';
}

function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function avatar(person, size = 24) {
  if (!person) return '';
  const name = person.name || person.login;
  const initials = name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  return `<span class="avatar" title="${esc(name)}" style="--av:${hue(person.login)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(initials)}</span>`;
}

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 2500);
  setTimeout(() => el.remove(), kind === 'error' ? 6400 : 2900);
}

// Opens a modal. `html` is the body; returns the modal element.
// Resolves `closed` when dismissed.
export function openModal(html, { wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(wrap);
  const modal = $('.modal', wrap);
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    modal.dispatchEvent(new Event('closed'));
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  modal.close = close;
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', close));
  setTimeout(() => $('input, textarea, select', modal)?.focus(), 0);
  return modal;
}

export function isModalOpen() {
  return !!$('.modal-backdrop');
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}
