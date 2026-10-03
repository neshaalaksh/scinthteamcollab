import { CONFIG, isDemo } from './config.js';
import { call, initAuth, getSession, setSession, signOut, signInWithGoogle, setAuthLostHandler, setRole, watchChanges, lastRev } from './api.js';
import { S, loadAll, setSpace, can } from './state.js';
import { DEMO_PEOPLE, resetDemo } from './demo.js';
import { $, $$, esc, avatar, isModalOpen, toast } from './util.js';
import home from './views/home.js';
import tasks from './views/tasks.js';
import calendar from './views/calendar.js';
import daily from './views/daily.js';
import history from './views/history.js';
import docs from './views/docs.js';
import sheets from './views/sheets.js';
import team from './views/team.js';

const views = { home, tasks, calendar, daily, history, docs, sheets, team };
let current = null;

function parseHash() {
  const [name = 'home', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: views[name] ? name : 'home', params: rest.map(decodeURIComponent) };
}

export async function render() {
  if (!S.me) return;
  const { name, params } = parseHash();
  const view = views[name];
  if (current?.view !== view) current?.view.leave?.();
  current = { view, name, params };
  $$('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
    a.setAttribute('aria-current', a.dataset.nav === name ? 'page' : 'false');
  });
  $('#sidebar').classList.remove('open');
  $('#page-title').textContent = view.title;
  $('#topbar-slot').innerHTML = '';
  try {
    await view.render($('#view'), params);
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
  }
}

function renderChrome() {
  document.title = CONFIG.workspaceName;
  $('#workspace-name').textContent = CONFIG.workspaceName;
  const select = $('#space-select');
  select.innerHTML = `<option value="all">All spaces</option>${S.spaces.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;
  select.value = S.space;
  $$('[data-admin]').forEach((el) => { el.hidden = !can.admin(); });
  const roleLabel = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' }[S.me.role];
  $('#me').innerHTML = `
    ${avatar(S.me, 32)}
    <div class="me-text"><b>${esc(S.me.name)}</b><span>${roleLabel}${isDemo() ? ' · demo' : ''}</span></div>
    <button class="icon-btn small" id="sign-out" title="Sign out" aria-label="Sign out">⎋</button>`;
  $('#sign-out').onclick = async () => { await signOut(); location.reload(); };
}

$('#space-select').addEventListener('change', (e) => { setSpace(e.target.value); render(); });
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
window.addEventListener('hashchange', render);

// ---- sign-in

function showLogin(message = '') {
  S.me = null;
  $('#app').hidden = true;
  const box = $('#login');
  box.hidden = false;
  box.innerHTML = `
    <div class="login-card">
      <span class="logo big" aria-hidden="true">S</span>
      <h1>${esc(CONFIG.workspaceName)}</h1>
      ${message ? `<p class="login-msg">${esc(message)}</p>` : ''}
      ${isDemo() ? `
        <p>Demo mode: nothing is shared yet. Pick who to be, to see what each role can do.</p>
        <div class="demo-people">
          ${DEMO_PEOPLE.map((p) => `<button class="btn" data-demo="${esc(p.email)}"><b>${esc(p.name)}</b><span>${p.role[0].toUpperCase() + p.role.slice(1)}</span></button>`).join('')}
        </div>
        <button class="link-btn" id="demo-reset">Reset demo data</button>
        <p class="muted small">To go live, follow SETUP.md in the repo.</p>
      ` : `
        <p>Sign in with your work Google account.</p>
        <div id="gsi-button"></div>
      `}
    </div>`;
  if (isDemo()) {
    $$('[data-demo]', box).forEach((b) => b.onclick = () => {
      const p = DEMO_PEOPLE.find((x) => x.email === b.dataset.demo);
      setSession({ mode: 'demo', email: p.email, name: p.name });
      start();
    });
    $('#demo-reset').onclick = () => { resetDemo(); toast('Demo data reset'); };
  } else {
    withGoogle(() => {
      window.google.accounts.id.renderButton($('#gsi-button'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
      window.google.accounts.id.prompt();
    });
  }
}

function withGoogle(fn) {
  const ready = () => {
    window.google.accounts.id.initialize({
      client_id: CONFIG.googleClientId,
      auto_select: true,
      callback: async (resp) => {
        try {
          await signInWithGoogle(resp.credential);
          start();
        } catch (err) {
          showLogin(err.message);
        }
      },
    });
    fn();
  };
  if (window.google?.accounts?.id) return ready();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = ready;
  s.onerror = () => toast("Couldn't load Google sign-in. Check your internet.", 'error');
  document.head.append(s);
}

setAuthLostHandler(() => showLogin('Your sign-in expired. Please sign in again.'));

async function start() {
  try {
    await initAuth();
  } catch (err) {
    $('#login').hidden = false;
    $('#login').innerHTML = `<div class="login-card"><h1>${esc(CONFIG.workspaceName)}</h1><p class="login-msg">${esc(err.message)}</p></div>`;
    return;
  }
  if (!getSession()) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#view').innerHTML = '<div class="loading">Loading…</div>';
  try {
    await loadAll();
  } catch (err) {
    if (err.code === 'AUTH') return;
    await signOut();
    return showLogin(err.message);
  }
  setRole(S.me.role);
  renderChrome();
  watch();
  await render();
}

// ---- keep in sync with teammates

// Reloads everything and redraws, unless the person is in the middle of typing.
async function refresh() {
  if (!S.me) return;
  await loadAll();
  setRole(S.me.role);
  renderChrome();
  const busy = isModalOpen() || current?.view.busy?.() || document.activeElement?.matches('input, textarea, select, [contenteditable]');
  if (!busy) await render();
}

let polling = false;
let live = false;
async function poll() {
  if (polling || !S.me || document.hidden) return;
  polling = true;
  try {
    if (live) {
      await refresh();   // back on the tab: catch up on anything missed while away
    } else {
      const before = lastRev;
      await call('ping');
      if (lastRev !== before) await refresh();
    }
  } catch { /* offline: try again next time */ }
  polling = false;
}

// Live: the database tells us about teammates' changes. Demo: check every so often.
let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  live = watchChanges(() => { if (!document.hidden) refresh().catch(() => {}); });
  if (!live) setInterval(poll, CONFIG.pollSeconds * 1000);
}
document.addEventListener('visibilitychange', poll);

start();
