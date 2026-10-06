// Demo mode: runs the real backend (backend/Code.gs) inside the browser with
// a pretend Google Sheet kept in localStorage. Lets anyone click around, and
// try each role, before the real Google Sheet is set up.

import { isoDate, addDays } from './util.js';
import { CONFIG } from './config.js';

// v2: Scinth + client spaces, Drive and calls. Older demo data (with "General") starts fresh.
const DB_KEY = 'teamspace.demo.db.v2';
const PROPS_KEY = 'teamspace.demo.props.v2';

export const DEMO_PEOPLE = [
  { email: 'you@demo.team', name: 'You', role: 'owner', spaces: '*' },
  { email: 'alex@demo.team', name: 'Alex', role: 'admin', spaces: '*' },
  { email: 'sam@demo.team', name: 'Sam', role: 'member', spaces: '*' },          // Scinth + every client space
  { email: 'priya@demo.team', name: 'Priya', role: 'member', spaces: '' },       // Scinth only
  { email: 'maya@acme.example', name: 'Maya (Acme)', role: 'guest', spaces: 'acme' },
  { email: 'leo@northwind.example', name: 'Leo (Northwind)', role: 'guest', spaces: 'northwind' },
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

// The backend's source. Normally fetched and run as-is; the hosted demo website can't run code
// that way, so it ships the same file wrapped as a script (built by tools/demo-site.sh).
async function backendFactory(names) {
  if (CONFIG.demoSite) {
    if (!window.TeamspaceBackend) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'backend/code-demo.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error("Couldn't load the demo. Refresh the page."));
        document.head.append(s);
      });
    }
    return window.TeamspaceBackend;
  }
  const source = await (await fetch('backend/Code.gs', { cache: 'no-store' })).text();
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${source}\nreturn { handle, ensureSchema, SCHEMA };`);
}

async function boot() {
  if (backend) return backend;
  const db = load(DB_KEY, {});
  const props = load(PROPS_KEY, { OWNER_EMAIL: DEMO_PEOPLE[0].email });
  const services = makeServices(db, props);
  const names = Object.keys(services);
  const factory = await backendFactory(names);
  const mod = factory(...names.map((n) => services[n]));
  backend = { mod, db, props };
  if (!db.Team || db.Team.length < 2) seed(backend);
  return backend;
}

export async function demoCall(email, action, data) {
  const b = await boot();
  // Drive in demo mode: the file stays in this browser; the backend keeps the list.
  if (action === 'drive.upload') {
    const key = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    try { await filePut(key, data.file); } catch { return { ok: false, error: "This browser couldn't store the file. Try a smaller one.", code: 'ERROR' }; }
    const res = await demoCall(email, 'drive.add', {
      name: data.file.name, mime: data.file.type || 'application/octet-stream', size: data.file.size, space: data.space, url: `demo-file:${key}`,
    });
    if (!res.ok) await fileDel(key).catch(() => {});
    return res;
  }
  let res;
  try {
    res = b.mod.handle({ idToken: `demo:${email}`, action, data });
  } catch (err) { // same shape doPost sends back
    res = { ok: false, error: String(err?.message || err), code: err?.code || 'ERROR' };
  }
  save(DB_KEY, b.db);
  save(PROPS_KEY, b.props);
  if (action === 'drive.delete' && res.ok && String(res.data?.url).startsWith('demo-file:')) {
    await fileDel(res.data.url.slice(10)).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 120)); // feel a little like the network
  return JSON.parse(JSON.stringify(res));
}

export function resetDemo() {
  try {
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(PROPS_KEY);
    indexedDB.deleteDatabase(FILES_DB);
  } catch { /* ignore */ }
  backend = null;
}

// ---- demo Drive: uploaded files kept in this browser (IndexedDB)

const FILES_DB = 'teamspace-demo-files';
function filesDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILES_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function fileOp(mode, fn) {
  const db = await filesDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
const filePut = (key, blob) => fileOp('readwrite', (s) => s.put(blob, key));
const fileDel = (key) => fileOp('readwrite', (s) => s.delete(key));

// A link to a demo file's contents, or null if this browser doesn't have it (e.g. sample files).
export async function demoFileUrl(url) {
  if (!String(url).startsWith('demo-file:')) return null;
  try {
    const blob = await fileOp('readonly', (s) => s.get(url.slice(10)));
    return blob ? URL.createObjectURL(blob) : null;
  } catch { return null; }
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
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }))];
  };
  const [you, alex, sam, priya, maya, leo] = DEMO_PEOPLE.map((p) => p.email);

  put('Team', DEMO_PEOPLE.map((p) => ({ ...p, addedAt: at(-30, 9, 0), lastActive: at(0, 9, 0) })));
  put('Spaces', [
    { id: 'scinth', name: 'Scinth', color: '#0F766E' },
    { id: 'acme', name: 'Acme Ltd', color: '#BE185D' },
    { id: 'northwind', name: 'Northwind', color: '#4338CA' },
  ]);

  const task = (id, title, status, assignee, due, priority, space, createdBy, extra = {}) => ({
    id, title, status, assignee, due: due === '' ? '' : addDays(today, due), priority, space,
    description: '', checklist: [], comments: [], createdAt: at(-6, 10, 0), createdBy, updatedAt: at(-1, 10, 0), ...extra,
  });
  put('Tasks', [
    task('t1', 'Send Acme invoice', 'doing', you, -2, 'urgent', 'acme', you, {
      client: maya,
      description: 'Invoice for last month. Hours are in the billing sheet.\n\nhttps://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0',
      checklist: [{ id: 'c1', text: 'Confirm hours with Sam', done: true }, { id: 'c2', text: 'Fill invoice template', done: false }, { id: 'c3', text: 'Email to client', done: false }],
      comments: [{ id: 'm1', by: sam, text: 'Hours confirmed: 42.', at: at(0, 8, 40) }],
    }),
    task('t2', 'Draft launch post', 'doing', alex, 0, 'normal', 'scinth', alex, { checklist: [{ id: 'c4', text: 'Outline', done: true }, { id: 'c5', text: 'First draft', done: true }, { id: 'c6', text: 'Photos', done: false }] }),
    task('t3', 'Plan Q4 budget', 'todo', you, 4, 'high', 'scinth', you),
    task('t4', 'Hire designer: shortlist', 'todo', priya, 7, 'normal', 'scinth', you),
    task('t5', 'Order packaging', 'todo', priya, 10, 'low', 'scinth', priya),
    task('t6', 'Acme proposal v2', 'review', sam, 6, 'normal', 'acme', alex, { client: maya }),
    task('t7', 'Update pricing sheet', 'done', sam, -1, 'normal', 'scinth', sam, { completedAt: at(-1, 18, 40), completedBy: sam }),
    task('t8', 'Book venue', 'done', alex, -2, 'high', 'scinth', alex, { completedAt: at(-2, 14, 15), completedBy: alex }),
    task('t9', 'Northwind onboarding pack', 'todo', sam, 3, 'high', 'northwind', alex, { client: leo }),
    task('t10', "Review Priya's supplier research", 'todo', alex, 2, 'normal', 'scinth', priya),
    task('t11', 'Northwind kickoff deck', 'done', sam, -3, 'normal', 'northwind', sam, { client: leo, completedAt: at(-3, 16, 5), completedBy: sam }),
  ]);

  // r3 used to be only yours: Priya joined it 3 days ago (past days still count it as yours only).
  // r6 was removed 2 days ago: days before that still count it.
  put('Routines', [
    { id: 'r1', title: 'Check team inbox', assignees: 'everyone', days: '1,2,3,4,5', space: 'scinth', active: 'true', createdAt: at(-30, 9, 0), history: '[]' },
    { id: 'r2', title: "Plan tomorrow's priorities", assignees: 'everyone', days: '1,2,3,4,5', space: 'scinth', active: 'true', createdAt: at(-30, 9, 0), history: '[]' },
    { id: 'r3', title: "Review yesterday's orders", assignees: [you, priya].join(','), days: '1,2,3,4,5', space: 'scinth', active: 'true', createdAt: at(-30, 9, 0),
      history: JSON.stringify([{ until: at(-3, 12, 0), assignees: [you], days: [1, 2, 3, 4, 5], space: 'scinth' }]) },
    { id: 'r4', title: 'Update sales sheet', assignees: 'everyone', days: '1,2,3,4,5', space: 'scinth', active: 'true', createdAt: at(-30, 9, 0), history: '[]' },
    { id: 'r5', title: 'Reply to client messages', assignees: [you, alex, sam].join(','), days: '0,1,2,3,4,5,6', space: 'scinth', active: 'true', createdAt: at(-30, 9, 0), history: '[]' },
    { id: 'r6', title: 'Fill in the old standup sheet', assignees: 'everyone', days: '1,2,3,4,5', space: 'scinth', active: 'false', createdAt: at(-30, 9, 0), removedAt: at(-2, 17, 0), history: '[]' },
  ]);

  const checks = [];
  for (let back = 1; back <= 8; back++) {
    const date = addDays(today, -back);
    const weekday = new Date(...date.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))).getDay();
    if (weekday === 0 || weekday === 6) continue;
    [you, alex, sam, priya].forEach((email, i) => {
      [...['r1', 'r2', 'r4'], ...(back > 2 ? ['r6'] : [])].forEach((rid, j) => {
        if ((back + i + j) % 5 !== 0) checks.push({ date, routineId: rid, email, at: at(-back, 9 + j, 5 * i), by: email });
      });
    });
  }
  checks.push({ date: today, routineId: 'r1', email: you, at: at(0, 8, 55), by: you });
  checks.push({ date: today, routineId: 'r1', email: alex, at: at(0, 9, 1), by: alex });
  checks.push({ date: today, routineId: 'r2', email: alex, at: at(0, 9, 20), by: alex });
  checks.push({ date: today, routineId: 'r1', email: sam, at: at(0, 9, 3), by: sam });
  put('DailyChecks', checks);
  put('Updates', []);

  const doc = (id, title, space, folder, pinned, body) => ({
    id, title, space, folder, pinned: pinned ? 'true' : '', version: 1, updatedAt: at(-2, 15, 0), updatedBy: alex,
    createdAt: at(-20, 10, 0), createdBy: you, body1: body,
  });
  put('Docs', [
    doc('d1', 'Onboarding checklist', 'scinth', 'Team', true,
      '# Day 1\n\n* [x] Get Google account and Teamspace access\n* [ ] Read "How we price"\n* [ ] Meet the team\n\n# Team contacts\n\nhttps://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/preview'),
    doc('d2', 'How we price', 'scinth', 'Team', true, 'Our pricing rules.\n\n| Plan | Price |\n| --- | --- |\n| Basic | [PRICE] |\n| Pro | [PRICE] |'),
    doc('d3', 'Brand voice', 'scinth', 'Marketing', false, 'Warm, short, clear. No jargon.'),
    doc('d4', 'Acme meeting notes', 'acme', 'Acme Ltd', false, '## Kickoff\n\n* Goals agreed\n* Next call in 2 weeks'),
  ]);
  put('DocVersions', []);

  put('SheetLinks', [
    { id: 's1', name: 'Sales tracker', url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', mode: 'view', space: 'scinth', height: 0, pinned: 'true', addedBy: you, addedAt: at(-10, 9, 0), order: 1 },
    { id: 's2', name: 'Acme billing', url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', mode: 'edit', space: 'acme', height: 0, addedBy: you, addedAt: at(-10, 9, 0), order: 2 },
  ]);

  // Sample files (their contents aren't in the demo; uploads you make are).
  put('DriveFiles', [
    { id: 'f1', name: 'Acme brand guidelines.pdf', url: 'demo-file:sample-1', mime: 'application/pdf', size: 2457600, space: 'acme', uploadedBy: maya, uploadedAt: at(-2, 11, 20) },
    { id: 'f2', name: 'Signed contract.pdf', url: 'demo-file:sample-2', mime: 'application/pdf', size: 384000, space: 'acme', uploadedBy: you, uploadedAt: at(-6, 16, 0) },
    { id: 'f3', name: 'Northwind requirements.docx', url: 'demo-file:sample-3', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 91000, space: 'northwind', uploadedBy: leo, uploadedAt: at(-1, 10, 5) },
    { id: 'f4', name: 'Team handbook.pdf', url: 'demo-file:sample-4', mime: 'application/pdf', size: 1200000, space: 'scinth', uploadedBy: alex, uploadedAt: at(-12, 9, 30) },
  ]);

  put('CallRequests', [
    { id: 'c1', email: maya, space: 'acme', topic: 'Walk through the proposal', notes: 'Our finance lead will join.', preferred: 'Thu or Fri afternoon, London time', status: 'requested', createdAt: at(-1, 15, 0), updatedAt: at(-1, 15, 0) },
    { id: 'c2', email: leo, space: 'northwind', topic: 'Kickoff call', notes: '', preferred: 'Any morning next week', status: 'scheduled', meetingAt: at(2, 10, 0), duration: 30, link: 'https://meet.google.com/abc-defg-hij', reply: 'See you then!', handledBy: alex, createdAt: at(-4, 9, 0), updatedAt: at(-3, 10, 0) },
    { id: 'c3', email: maya, space: 'acme', topic: 'Intro call', notes: '', preferred: '', status: 'scheduled', meetingAt: at(-9, 14, 0), duration: 45, link: 'https://meet.google.com/xyz-abcd-efg', reply: '', handledBy: you, createdAt: at(-14, 9, 0), updatedAt: at(-12, 10, 0) },
  ]);

  const act = (day, hh, mm, email, action, type, itemId, title, space, detail = '') => ({ at: at(day, hh, mm), email, action, type, itemId, title, space, detail });
  const activity = [
    act(-3, 10, 2, you, 'created', 'task', 't3', 'Plan Q4 budget', 'scinth'),
    act(-3, 16, 5, sam, 'completed', 'task', 't11', 'Northwind kickoff deck', 'northwind'),
    act(-2, 14, 15, alex, 'completed', 'task', 't8', 'Book venue', 'scinth'),
    act(-2, 11, 20, maya, 'uploaded', 'file', 'f1', 'Acme brand guidelines.pdf', 'acme'),
    act(-1, 18, 40, sam, 'completed', 'task', 't7', 'Update pricing sheet', 'scinth'),
    act(-1, 15, 0, maya, 'requested', 'call', 'c1', 'Walk through the proposal', 'acme'),
    act(0, 8, 40, sam, 'commented', 'task', 't1', 'Send Acme invoice', 'acme', 'Hours confirmed: 42.'),
  ];
  checks.forEach((c) => {
    const title = { r1: 'Check team inbox', r2: "Plan tomorrow's priorities", r4: 'Update sales sheet', r6: 'Fill in the old standup sheet' }[c.routineId];
    activity.push({ at: c.at, email: c.email, action: 'ticked', type: 'routine', itemId: c.routineId, title, space: 'scinth', detail: c.date });
  });
  activity.sort((a, b) => a.at.localeCompare(b.at));
  put('Activity', activity);
}
