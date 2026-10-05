// The live backend: each action the screens use, done with Supabase.
// Permissions are enforced by the database (supabase/migrations); this file
// only turns rows into the shapes the screens expect, and back.

import { CONFIG } from './config.js';

let sb = null;

export async function connect() {
  if (sb) return sb;
  if (!window.supabase) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/supabase.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the app. Check your internet and refresh."));
      document.head.append(s);
    });
  }
  sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'teamspace.auth' },
  });
  return sb;
}

// ---- rows <-> app shapes (the screens use '' for "none", the database uses null)

const blank = (v) => (v === '' || v === undefined ? null : v);
const str = (v) => v ?? '';

const personOut = (p) => ({ email: p.email, name: p.name, role: p.role, spaces: p.spaces || '*', lastActive: str(p.last_active) });
const spaceOut = (s) => ({ id: s.id, name: s.name, color: s.color, createdAt: s.created_at });

const taskOut = (t) => ({
  id: t.id, title: t.title, description: t.description, status: t.status,
  assignee: str(t.assignee), due: str(t.due), priority: str(t.priority), space: str(t.space),
  checklist: t.checklist || [], comments: t.comments || [], order: t.sort_order || 0,
  createdAt: t.created_at, createdBy: str(t.created_by), updatedAt: t.updated_at,
  completedAt: str(t.completed_at), completedBy: str(t.completed_by),
});

const routineOut = (r) => ({
  id: r.id, title: r.title, notes: r.notes, assignees: r.assignees ?? 'everyone', days: r.days || [],
  space: str(r.space), active: r.active, createdAt: r.created_at, createdBy: str(r.created_by),
});

const DOC_META = 'id,title,space,folder,pinned,version,updated_at,updated_by,locked_by,locked_at,created_by';
const docOut = (d) => {
  const o = {
    id: d.id, title: d.title, space: str(d.space), folder: d.folder, pinned: d.pinned, version: d.version,
    updatedAt: d.updated_at, updatedBy: str(d.updated_by), lockedBy: str(d.locked_by), lockedAt: str(d.locked_at),
    createdBy: str(d.created_by),
  };
  if (d.body !== undefined) o.body = d.body;
  if (d.ydoc !== undefined) o.ydoc = d.ydoc ?? '';
  return o;
};

const sheetOut = (s) => ({
  id: s.id, name: s.name, url: s.url, mode: s.mode, space: str(s.space), height: s.height || 0,
  pinned: !!s.pinned, order: s.sort_order || 0, addedBy: str(s.added_by), addedAt: s.added_at,
});

const checkOut = (c) => ({ date: c.date, routineId: c.routine_id, email: c.email, at: c.at, by: str(c.ticked_by) });
const updateOut = (u) => ({ date: u.date, email: u.email, yesterday: u.yesterday, today: u.today, blockers: u.blockers, at: u.at });
const activityOut = (a) => ({
  at: a.at, email: a.email, action: a.action, type: a.type, itemId: str(a.item_id),
  title: str(a.title), space: str(a.space), detail: str(a.detail),
});

// Columns where the screens send '' for "none".
const NULLABLE = new Set(['assignee', 'due', 'priority', 'space']);

// Copies only the given keys, renaming app names to column names.
function columns(fields, map) {
  const out = {};
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) out[col] = NULLABLE.has(col) ? blank(fields[key]) : fields[key];
  }
  return out;
}

function fail(message, code = 'ERROR') {
  throw Object.assign(new Error(message), { code });
}

// Unwraps a Supabase result, turning database errors into readable messages.
function check({ data, error }, emptyMessage) {
  if (error) {
    const m = error.message || '';
    if (/row-level security|permission denied/i.test(m)) fail('Your role does not allow this.', 'FORBIDDEN');
    if (/JWT|not authenticated/i.test(m)) fail('Your sign-in expired. Please sign in again.', 'AUTH');
    if (/violates check constraint/i.test(m)) fail("Something in that isn't valid. Check the fields and try again.");
    if (/duplicate key/i.test(m)) fail('That already exists.');
    if (error.code === 'P0001') fail(m);   // our own messages from the database
    fail(m || 'Something went wrong.');
  }
  if (emptyMessage && (data == null || (Array.isArray(data) && !data.length))) fail(emptyMessage, 'FORBIDDEN');
  return data;
}

const one = (rows) => (Array.isArray(rows) ? rows[0] : rows);

function slug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'space';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---- actions (same names and shapes as backend/Code.gs)

const ACTIONS = {
  async bootstrap(me) {
    const meRow = check(await sb.from('team').select('*').eq('email', me).maybeSingle());
    if (!meRow) fail(`You are not on this team yet. Ask the owner to add ${me}.`, 'NOT_MEMBER');
    sb.rpc('touch_last_active').then(() => {}, () => {});
    const [team, spaces, tasks, routines, docs, sheets] = await Promise.all([
      sb.from('team').select('*').order('name'),
      sb.from('spaces').select('*').order('name'),
      sb.from('tasks').select('*'),
      sb.from('routines').select('*').eq('active', true).order('created_at'),
      sb.from('docs').select(DOC_META),
      sb.from('sheet_links').select('*').order('sort_order'),
    ]);
    return {
      me: personOut(meRow),
      team: check(team).map(personOut),
      spaces: check(spaces).map(spaceOut),
      tasks: check(tasks).map(taskOut),
      routines: check(routines).map(routineOut),
      docs: check(docs).map(docOut),
      sheets: check(sheets).map(sheetOut),
    };
  },

  async ping() { return {}; },

  // ---- tasks
  async 'tasks.save'(me, d) {
    const row = columns(d.fields || {}, {
      title: 'title', description: 'description', status: 'status', assignee: 'assignee', due: 'due',
      priority: 'priority', space: 'space', checklist: 'checklist', order: 'sort_order',
    });
    if (row.title !== undefined) row.title = String(row.title).trim().slice(0, 300);
    if (!d.id) {
      if (!row.title) fail('A task needs a name.');
      return taskOut(one(check(await sb.from('tasks').insert(row).select())));
    }
    return taskOut(one(check(await sb.from('tasks').update(row).eq('id', d.id).select(), 'You cannot edit tasks in this space.')));
  },

  async 'tasks.delete'(me, d) {
    check(await sb.from('tasks').delete().eq('id', d.id).select('id'), 'Only admins, or the person who made it, can delete this.');
    return { id: d.id };
  },

  async 'tasks.comment'(me, d) {
    return taskOut(one(check(await sb.rpc('add_task_comment', { p_task_id: d.id, p_text: d.text }))));
  },

  // ---- routines
  async 'routines.save'(me, d) {
    const f = d.fields || {};
    const row = columns(f, { title: 'title', notes: 'notes', days: 'days', space: 'space' });
    if (f.assignees !== undefined) row.assignees = f.assignees === 'everyone' ? null : f.assignees;
    if (!d.id) {
      if (!row.title) fail('A routine needs a name.');
      return routineOut(one(check(await sb.from('routines').insert(row).select())));
    }
    return routineOut(one(check(await sb.from('routines').update(row).eq('id', d.id).select(), 'Only the owner and admins can set up routines.')));
  },

  async 'routines.delete'(me, d) {
    // Kept (inactive) so old ticks still have a name in History.
    check(await sb.from('routines').update({ active: false }).eq('id', d.id).select('id'), 'Only the owner and admins can remove routines.');
    return { id: d.id };
  },

  // ---- daily
  async 'daily.get'(me, d, ctx) {
    if (ctx.role === 'guest') return { checks: [], updates: [] };
    const [checks, updates] = await Promise.all([
      sb.from('daily_checks').select('*').gte('date', d.from).lte('date', d.to),
      sb.from('updates').select('*').gte('date', d.from).lte('date', d.to),
    ]);
    return { checks: check(checks).map(checkOut), updates: check(updates).map(updateOut) };
  },

  async 'daily.toggle'(me, d) {
    const email = String(d.email || me).toLowerCase();
    if (d.on) {
      check(await sb.from('daily_checks').upsert({ date: d.date, routine_id: d.routineId, email }, { onConflict: 'date,routine_id,email', ignoreDuplicates: true }));
    } else {
      check(await sb.from('daily_checks').delete().match({ date: d.date, routine_id: d.routineId, email }));
    }
    return { on: !!d.on };
  },

  async 'daily.update'(me, d) {
    const row = { date: d.date, email: me, yesterday: str(d.yesterday).slice(0, 2000), today: str(d.today).slice(0, 2000), blockers: str(d.blockers).slice(0, 2000) };
    return updateOut(one(check(await sb.from('updates').upsert(row, { onConflict: 'date,email' }).select())));
  },

  // ---- docs
  async 'docs.get'(me, d) {
    const row = check(await sb.from('docs').select('*').eq('id', d.id).maybeSingle());
    if (!row) fail('That doc is gone. It may have been deleted.');
    return docOut(row);
  },

  async 'docs.save'(me, d) {
    const row = columns(d.fields || {}, { title: 'title', space: 'space', folder: 'folder', pinned: 'pinned', body: 'body', ydoc: 'ydoc' });
    if (row.title !== undefined) row.title = String(row.title).trim() || 'Untitled';
    if (!d.id) {
      return docOut(one(check(await sb.from('docs').insert(row).select())));
    }
    // Several people edit at once and the editor merges their changes (see js/collab.js),
    // so there is no lock and no version check: the newest merged copy wins.
    const rows = check(await sb.from('docs').update(row).eq('id', d.id).select(DOC_META));
    if (!rows.length) fail('You cannot edit docs in this space.', 'FORBIDDEN');
    return docOut(rows[0]);
  },

  async 'docs.lock'(me, d) {
    const rows = check(await sb.from('docs').update({ locked_by: d.on ? me : null }).eq('id', d.id).select(DOC_META), 'You cannot edit docs in this space.');
    return docOut(rows[0]);
  },

  async 'docs.delete'(me, d) {
    check(await sb.from('docs').delete().eq('id', d.id).select('id'), 'Only admins, or the person who made it, can delete this.');
    return { id: d.id };
  },

  async 'docs.search'(me, d) {
    const q = String(d.q || '').trim();
    if (!q) return [];
    return check(await sb.rpc('search_docs', { q }));
  },

  async 'docs.versions'(me, d) {
    const rows = check(await sb.from('doc_versions').select('*').eq('doc_id', d.id).order('version', { ascending: false }));
    return rows.map((v) => ({ version: v.version, title: v.title, savedAt: v.saved_at, savedBy: str(v.saved_by), body: v.body }));
  },

  // ---- sheet links
  async 'sheets.save'(me, d) {
    const f = d.fields || {};
    if (f.url !== undefined && !/^https:\/\/docs\.google\.com\//.test(f.url)) fail('That is not a Google Sheets link.');
    const row = columns(f, { name: 'name', url: 'url', mode: 'mode', space: 'space', height: 'height', pinned: 'pinned', order: 'sort_order' });
    if (row.mode !== undefined && row.mode !== 'edit' && row.mode !== 'view') row.mode = 'edit';
    if (row.height !== undefined) row.height = Number(row.height) || 0;
    if (!d.id) {
      if (!row.name || !row.url) fail('A sheet needs a name and a link.');
      return sheetOut(one(check(await sb.from('sheet_links').insert(row).select())));
    }
    return sheetOut(one(check(await sb.from('sheet_links').update(row).eq('id', d.id).select(), 'You cannot edit sheets in this space.')));
  },

  async 'sheets.delete'(me, d) {
    check(await sb.from('sheet_links').delete().eq('id', d.id).select('id'), 'Only admins, or the person who added it, can remove this.');
    return { id: d.id };
  },

  // ---- team and spaces
  async 'team.save'(me, d) {
    const email = String(d.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('That email address does not look right.');
    const spaces = Array.isArray(d.spaces) ? d.spaces.join(',') : String(d.spaces || '') || '*';
    const name = String(d.name || '').trim().slice(0, 100);
    const existing = check(await sb.from('team').select('name').eq('email', email).maybeSingle());
    const row = { name: name || existing?.name || email.split('@')[0], role: d.role || 'member', spaces };
    const res = existing
      ? await sb.from('team').update(row).eq('email', email).select()
      : await sb.from('team').insert({ email, ...row }).select();
    return personOut(one(check(res, 'Only the owner and admins can manage people.')));
  },

  async 'team.remove'(me, d) {
    const email = String(d.email || '').toLowerCase();
    check(await sb.from('team').delete().eq('email', email).select('email'), 'Only the owner and admins can remove people.');
    return { email };
  },

  async 'spaces.save'(me, d) {
    const row = columns(d, { name: 'name', color: 'color' });
    if (!d.id) {
      if (!row.name) fail('A space needs a name.');
      return spaceOut(one(check(await sb.from('spaces').insert({ id: slug(row.name), ...row }).select())));
    }
    return spaceOut(one(check(await sb.from('spaces').update(row).eq('id', d.id).select(), 'Only the owner and admins can manage spaces.')));
  },

  async 'spaces.delete'(me, d) {
    check(await sb.from('spaces').delete().eq('id', d.id).select('id'), 'Only the owner and admins can manage spaces.');
    return { id: d.id };
  },

  // ---- history (newest first; the database limits it to what you may see)
  async 'history.get'(me, d) {
    const rows = check(await sb.from('activity').select('*').gte('at', d.from).lte('at', d.to).order('at', { ascending: false }).limit(2000));
    return rows.map(activityOut);
  },
};

// ctx.role is the signed-in person's role, when known.
export async function supabaseCall(email, action, data, ctx = {}) {
  const fn = ACTIONS[action];
  if (!fn) fail(`Unknown action: ${action}`);
  return fn(email, data, ctx);
}

// A private broadcast channel for one doc's live edits (the database checks who may join).
export async function docChannel(docId) {
  const client = await connect();
  const { data } = await client.auth.getSession();
  if (data.session) client.realtime.setAuth(data.session.access_token);
  return client.channel(`doc:${docId}`, { config: { private: true, broadcast: { self: false, ack: false } } });
}

// Calls fn (at most every half second) whenever a teammate changes something.
export function onChanges(fn) {
  let timer = null;
  const fire = () => { clearTimeout(timer); timer = setTimeout(fn, 500); };
  // Doc edits save every few seconds while people type; they are already live in the editor,
  // so the rest of the app only needs to catch up now and then.
  let slow = null;
  const fireSlow = () => { slow ??= setTimeout(() => { slow = null; fn(); }, 15000); };
  sb.channel('teamspace')
    .on('postgres_changes', { event: '*', schema: 'public' }, (p) => (p.table === 'docs' && p.eventType === 'UPDATE' ? fireSlow() : fire()))
    .subscribe();
}
