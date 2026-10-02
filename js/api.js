// Talks to the backend: the Apps Script web app, or the in-browser demo.
// Also holds the signed-in session.

import { CONFIG, isDemo } from './config.js';
import { demoCall } from './demo.js';
import { lsGet, lsSet } from './util.js';

const SESSION_KEY = 'teamspace.session';
let onAuthLost = () => {};

export function setAuthLostHandler(fn) { onAuthLost = fn; }

export function getSession() {
  const s = lsGet(SESSION_KEY, null);
  if (!s) return null;
  if (isDemo() !== (s.mode === 'demo')) return null;
  if (s.mode === 'google' && s.exp * 1000 < Date.now() + 60000) return null;
  return s;
}

export function setSession(s) { lsSet(SESSION_KEY, s); }

export function signOut() {
  lsSet(SESSION_KEY, null);
  if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
}

// Decodes the payload of a Google ID token (we only read email/name/exp;
// the backend does the real verification).
export function sessionFromCredential(jwt) {
  const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = decodeURIComponent(atob(part).split('').map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  const p = JSON.parse(json);
  return { mode: 'google', token: jwt, email: p.email, name: p.name, exp: p.exp };
}

export let lastRev = 0;

export async function call(action, data = {}) {
  const s = getSession();
  if (!s) {
    onAuthLost();
    throw Object.assign(new Error('Please sign in.'), { code: 'AUTH' });
  }
  let res;
  try {
    if (s.mode === 'demo') {
      res = await demoCall(s.email, action, data);
    } else {
      // No Content-Type header: keeps this a "simple" request Apps Script accepts.
      const r = await fetch(CONFIG.appsScriptUrl, {
        method: 'POST',
        body: JSON.stringify({ idToken: s.token, action, data }),
      });
      res = await r.json();
    }
  } catch (err) {
    throw Object.assign(new Error("Couldn't reach the server. Check your internet and try again."), { code: 'NETWORK', cause: err });
  }
  if (!res.ok) {
    if (res.code === 'AUTH') { signOut(); onAuthLost(); }
    throw Object.assign(new Error(res.error), { code: res.code });
  }
  lastRev = res.rev;
  return res.data;
}
