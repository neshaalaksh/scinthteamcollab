// Talks to the backend: Supabase when configured, or the in-browser demo.
// Also holds the signed-in session.

import { isDemo } from './config.js';
import { demoCall } from './demo.js';
import { connect, supabaseCall, onChanges } from './supabase.js';
import { lsGet, lsSet } from './util.js';

const DEMO_KEY = 'teamspace.session';
let onAuthLost = () => {};
let session = null;      // { mode, email, name }
let role = null;         // the signed-in person's role, once loaded
let signingOut = false;

export function setAuthLostHandler(fn) { onAuthLost = fn; }
export function setRole(r) { role = r; }

const fromSupabase = (s) => (s?.user?.email
  ? { mode: 'supabase', email: s.user.email.toLowerCase(), name: s.user.user_metadata?.full_name || s.user.user_metadata?.name || s.user.email }
  : null);

// Call once before anything else: restores a saved sign-in.
let ready = null;
export function initAuth() {
  ready ??= (async () => {
    if (isDemo()) {
      const s = lsGet(DEMO_KEY, null);
      session = s?.mode === 'demo' ? s : null;
      return;
    }
    const sb = await connect();
    const { data } = await sb.auth.getSession();
    session = fromSupabase(data.session);
    sb.auth.onAuthStateChange((event, s) => {
      session = fromSupabase(s);
      if (event === 'SIGNED_OUT' && !signingOut) onAuthLost();
    });
  })();
  return ready;
}

export function getSession() { return session; }

export function setSession(s) {   // demo mode only
  session = s;
  lsSet(DEMO_KEY, s);
}

// Swaps the Google sign-in token for a Supabase session.
export async function signInWithGoogle(idToken) {
  const sb = await connect();
  const { data, error } = await sb.auth.signInWithIdToken({ provider: 'google', token: idToken });
  if (error) throw Object.assign(new Error(`Sign-in didn't work: ${error.message}`), { code: 'AUTH' });
  session = fromSupabase(data.session);
  signingOut = false;   // a sign-out before this (e.g. "not on the team") is over
}

export async function signOut() {
  signingOut = true;
  if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
  if (isDemo()) setSession(null);
  else {
    session = null;
    await (await connect()).auth.signOut().catch(() => {});
  }
}

export let lastRev = 0;

export async function call(action, data = {}) {
  const s = getSession();
  if (!s) {
    onAuthLost();
    throw Object.assign(new Error('Please sign in.'), { code: 'AUTH' });
  }
  if (s.mode === 'demo') {
    const res = await demoCall(s.email, action, data);
    if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
    lastRev = res.rev;
    return res.data;
  }
  try {
    return await supabaseCall(s.email, action, data, { role });
  } catch (err) {
    if (err.code === 'AUTH') { await signOut(); signingOut = false; onAuthLost(); }
    if (/failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(err.message || '')) {
      throw Object.assign(new Error("Couldn't reach the server. Check your internet and try again."), { code: 'NETWORK', cause: err });
    }
    throw err;
  }
}

// Runs fn whenever a teammate changes something. Returns false in demo mode
// (nothing to listen to; the app polls instead).
export function watchChanges(fn) {
  if (isDemo()) return false;
  onChanges(fn);
  return true;
}
