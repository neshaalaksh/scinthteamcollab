// Demo mode: runs the real backend (backend/Code.gs) inside the browser with
// a pretend Google Sheet kept in localStorage. Lets anyone click around, and
// try each role, before the real Google Sheet is set up.

import { isoDate, addDays } from './util.js';

const DB_KEY = 'teamspace.demo.db';
const PROPS_KEY = 'teamspace.demo.props';

export const DEMO_PEOPLE = [
  { email: 'you@demo.team', name: 'You', role: 'owner' },
  { email: 'alex@demo.team', name: 'Alex', role: 'admin' },
  { email: 'sam@demo.team', name: 'Sam', role: 'member' },
  { email: 'priya@demo.team', name: 'Priya', role: 'member' },
  { email: 'client@demo.team', name: 'Client A contact', role: 'guest' },
];

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

// ---- tiny stand-ins for the Apps Script services Code.gs uses

class FakeRange {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      out.push(Array.from({ length: this.cols }, (_, c) => src[this.col - 1 + c] ?? ''));
    }
    return out;
  }
  setValues(values) {
    values.forEach((vals, r) => {
      const i = this.row - 1 + r;
      while (this.sheet.data.length <= i) this.sheet.data.push([]);
      vals.forEach((v, c) => { this.sheet.data[i][this.col - 1 + c] = cellStore(v); });
    });
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

const cellStore = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);

class FakeSheet {
  constructor(db, name) { this.db = db; this.name = name; }
  get data() { return this.db[this.name]; }
  getDataRange() {
    const width = Math.max(1, ...this.data.map((r) => r.length));
    return new FakeRange(this, 1, 1, Math.max(1, this.data.length), width);
  }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  appendRow(values) { this.data.push(values.map(cellStore)); }
  deleteRow(row) { this.data.splice(row - 1, 1); }
  getLastRow() { return this.data.length; }
  getMaxRows() { return Math.max(1000, this.data.length); }
  setFrozenRows() {}
}

function makeServices(db, props) {
  const sheets = {};
  const sheetFor = (name) => (sheets[name] ??= new FakeSheet(db, name));
  const cache = new Map();
  return {
    DEMO_MODE: true,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => (db[name] ? sheetFor(name) : null),
        insertSheet: (name) => { db[name] = []; return sheetFor(name); },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] ?? null,
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ s, setMimeType() { return this; } }),
    },
    UrlFetchApp: { fetch: () => { throw new Error('No network calls in demo mode'); } },
    Utilities: { getUuid: () => crypto.randomUUID() },
  };
}

let backend = null;

async function boot() {
  if (backend) return backend;
  const source = await (await fetch('backend/Code.gs', { cache: 'no-store' })).text();
  const db = load(DB_KEY, {});
  const props = load(PROPS_KEY, { OWNER_EMAIL: DEMO_PEOPLE[0].email });
  const services = makeServices(db, props);
  const names = Object.keys(services);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${source}\nreturn { handle, ensureSchema, SCHEMA };`);
  const mod = factory(...names.map((n) => services[n]));
  backend = { mod, db, props };
  if (!db.Team || db.Team.length < 2) seed(backend);
  return backend;
}

export async function demoCall(email, action, data) {
  const b = await boot();
  let res;
  try {
    res = b.mod.handle({ idToken: `demo:${email}`, action, data });
  } catch (err) { // same shape doPost sends back
    res = { ok: false, error: String(err?.message || err), code: err?.code || 'ERROR' };
  }
  save(DB_KEY, b.db);
  save(PROPS_KEY, b.props);
  await new Promise((r) => setTimeout(r, 120)); // feel a little like the network
  return JSON.parse(JSON.stringify(res));
}

export function resetDemo() {
  try {
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(PROPS_KEY);
  } catch { /* ignore */ }
  backend = null;
}

// ---- example data, dated around today

function seed({ mod, db }) {
  mod.ensureSchema(true);
  const today = isoDate();
  const at = (day, hh, mm) => {
    const [y, m, d] = addDays(today, day).split('-').map(Number);
    return new Date(y, m - 1, d, hh, mm).toISOString();
  };
  const put = (tab, rows) => {
    const headers = mod.SCHEMA[tab];
    db[tab] = [headers, ...rows.map((r) => headers.map((h) => {
      const v = r[h];
      return v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }))];
  };
  const [you, alex, sam, priya, client] = DEMO_PEOPLE.map((p) => p.email);

  put('Team', DEMO_PEOPLE.map((p) => ({
    ...p, spaces: p.role === 'guest' ? 'client-a' : p.email === priya ? 'ops' : '*', addedAt: at(-30, 9, 0), lastActive: at(0, 9, 0),
  })));
  put('Spaces', [
    { id: 'ops', name: 'Ops', color: '#0F766E' },
    { id: 'marketing', name: 'Marketing', color: '#BE185D' },
    { id: 'client-a', name: 'Client A', color: '#4338CA' },
  ]);

  const task = (id, title, status, assignee, due, priority, space, extra = {}) => ({
    id, title, status, assignee, due: due === '' ? '' : addDays(today, due), priority, space,
    description: '', checklist: [], comments: [], createdAt: at(-6, 10, 0), createdBy: you, updatedAt: at(-1, 10, 0), ...extra,
  });
  put('Tasks', [
    task('t1', 'Send client invoice', 'doing', you, -2, 'urgent', 'client-a', {
      description: 'Invoice for last month. Hours are in the billing sheet.\n\nhttps://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0',
      checklist: [{ id: 'c1', text: 'Confirm hours with Sam', done: true }, { id: 'c2', text: 'Fill invoice template', done: false }, { id: 'c3', text: 'Email to client', done: false }],
      comments: [{ id: 'm1', by: sam, text: 'Hours confirmed: 42.', at: at(0, 8, 40) }],
    }),
    task('t2', 'Draft launch post', 'doing', alex, 0, 'normal', 'marketing', { checklist: [{ id: 'c4', text: 'Outline', done: true }, { id: 'c5', text: 'First draft', done: true }, { id: 'c6', text: 'Photos', done: false }] }),
    task('t3', 'Plan Q4 budget', 'todo', you, 4, 'high', 'ops'),
    task('t4', 'Hire designer: shortlist', 'todo', you, 7, 'normal', ''),
    task('t5', 'Order packaging', 'todo', priya, 10, 'low', 'ops'),
    task('t6', 'Client A proposal', 'review', sam, 6, 'normal', 'client-a'),
    task('t7', 'Update pricing sheet', 'done', sam, -1, 'normal', 'ops', { completedAt: at(-1, 18, 40), completedBy: sam }),
    task('t8', 'Book venue', 'done', alex, -2, 'high', 'marketing', { completedAt: at(-2, 14, 15), completedBy: alex }),
    task('t9', 'Pitch deck v2', 'done', priya, -3, 'normal', 'client-a', { completedAt: at(-2, 9, 48), completedBy: priya }),
  ]);

  put('Routines', [
    { id: 'r1', title: 'Check team inbox', assignees: 'everyone', days: '1,2,3,4,5', active: 'true' },
    { id: 'r2', title: 'Post daily update', assignees: 'everyone', days: '1,2,3,4,5', active: 'true' },
    { id: 'r3', title: "Review yesterday's orders", assignees: [you, priya].join(','), days: '1,2,3,4,5', space: 'ops', active: 'true' },
    { id: 'r4', title: 'Update sales sheet', assignees: 'everyone', days: '1,2,3,4,5', active: 'true' },
    { id: 'r5', title: 'Reply to client messages', assignees: [you, alex, sam].join(','), days: '0,1,2,3,4,5,6', active: 'true' },
  ]);

  const checks = [];
  for (let back = 1; back <= 8; back++) {
    const date = addDays(today, -back);
    const weekday = new Date(...date.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))).getDay();
    if (weekday === 0 || weekday === 6) continue;
    [you, alex, sam, priya].forEach((email, i) => {
      ['r1', 'r2', 'r4'].forEach((rid, j) => {
        if ((back + i + j) % 5 !== 0) checks.push({ date, routineId: rid, email, at: at(-back, 9 + j, 5 * i), by: email });
      });
    });
  }
  checks.push({ date: today, routineId: 'r1', email: you, at: at(0, 8, 55), by: you });
  checks.push({ date: today, routineId: 'r1', email: alex, at: at(0, 9, 1), by: alex });
  checks.push({ date: today, routineId: 'r2', email: alex, at: at(0, 9, 20), by: alex });
  checks.push({ date: today, routineId: 'r1', email: sam, at: at(0, 9, 3), by: sam });
  put('DailyChecks', checks);

  put('Updates', [
    { date: today, email: alex, yesterday: 'Booked the venue', today: 'Launch post, schedule socials', blockers: 'Need brand photos', at: at(0, 9, 20) },
    { date: today, email: sam, yesterday: 'Pricing sheet', today: 'Client A proposal review', blockers: '', at: at(0, 9, 5) },
  ]);

  const doc = (id, title, space, folder, pinned, body) => ({
    id, title, space, folder, pinned: pinned ? 'true' : '', version: 1, updatedAt: at(-2, 15, 0), updatedBy: alex,
    createdAt: at(-20, 10, 0), createdBy: you, body1: body,
  });
  put('Docs', [
    doc('d1', 'Onboarding checklist', 'ops', 'Ops', true,
      '# Day 1\n\n* [x] Get Google account and Teamspace access\n* [ ] Read "How we price"\n* [ ] Meet the team\n\n# Team contacts\n\nhttps://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/preview'),
    doc('d2', 'How we price', 'ops', 'Ops', true, 'Our pricing rules.\n\n| Plan | Price |\n| --- | --- |\n| Basic | [PRICE] |\n| Pro | [PRICE] |'),
    doc('d3', 'Brand voice', 'marketing', 'Marketing', false, 'Warm, short, clear. No jargon.'),
    doc('d4', 'Meeting notes', 'client-a', 'Client A', false, '## Kickoff\n\n* Goals agreed\n* Next call in 2 weeks'),
  ]);
  put('DocVersions', []);

  put('SheetLinks', [
    { id: 's1', name: 'Sales tracker', url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', mode: 'view', space: 'ops', height: 0, pinned: 'true', addedBy: you, addedAt: at(-10, 9, 0), order: 1 },
    { id: 's2', name: 'Billing', url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', mode: 'edit', space: 'client-a', height: 0, addedBy: you, addedAt: at(-10, 9, 0), order: 2 },
  ]);

  const act = (day, hh, mm, email, action, type, itemId, title, space, detail = '') => ({ at: at(day, hh, mm), email, action, type, itemId, title, space, detail });
  const activity = [
    act(-3, 10, 2, you, 'created', 'task', 't3', 'Plan Q4 budget', 'ops'),
    act(-2, 9, 48, priya, 'completed', 'task', 't9', 'Pitch deck v2', 'client-a'),
    act(-2, 14, 15, alex, 'completed', 'task', 't8', 'Book venue', 'marketing'),
    act(-1, 18, 40, sam, 'completed', 'task', 't7', 'Update pricing sheet', 'ops'),
    act(0, 8, 40, sam, 'commented', 'task', 't1', 'Send client invoice', 'client-a', 'Hours confirmed: 42.'),
  ];
  checks.forEach((c) => {
    const title = { r1: 'Check team inbox', r2: 'Post daily update', r4: 'Update sales sheet' }[c.routineId];
    activity.push({ at: c.at, email: c.email, action: 'ticked', type: 'routine', itemId: c.routineId, title, space: '', detail: c.date });
  });
  activity.sort((a, b) => a.at.localeCompare(b.at));
  put('Activity', activity);
}
