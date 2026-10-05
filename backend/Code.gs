/**
 * Teamspace backend (Google Apps Script).
 *
 * Paste this file into Extensions > Apps Script of your "Teamspace DB"
 * Google Sheet, set the two Script Properties below, then
 * Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties (Project Settings > Script Properties):
 *   CLIENT_ID    the Google OAuth Web client ID the website signs in with
 *   OWNER_EMAIL  your Google email; becomes the Owner on first sign-in
 *
 * Every request carries the user's Google ID token. We verify it with Google,
 * look the email up on the Team tab, and check the role before reading or
 * writing anything. The website itself is never trusted.
 */

var SCHEMA = {
  Team: ['email', 'name', 'role', 'spaces', 'addedAt', 'lastActive'],
  Spaces: ['id', 'name', 'color', 'createdAt'],
  Tasks: ['id', 'title', 'description', 'status', 'assignee', 'due', 'priority', 'space',
    'checklist', 'comments', 'createdAt', 'createdBy', 'updatedAt', 'completedAt', 'completedBy', 'order'],
  Routines: ['id', 'title', 'notes', 'assignees', 'days', 'space', 'active', 'createdAt', 'createdBy'],
  DailyChecks: ['date', 'routineId', 'email', 'at', 'by'],
  Updates: ['date', 'email', 'yesterday', 'today', 'blockers', 'at'],
  Docs: ['id', 'title', 'space', 'folder', 'pinned', 'version', 'updatedAt', 'updatedBy',
    'lockedBy', 'lockedAt', 'createdAt', 'createdBy', 'body1', 'body2', 'body3', 'body4', 'body5'],
  DocVersions: ['docId', 'version', 'title', 'savedAt', 'savedBy', 'body1', 'body2', 'body3', 'body4', 'body5'],
  SheetLinks: ['id', 'name', 'url', 'mode', 'space', 'height', 'addedBy', 'addedAt', 'order'],
  Activity: ['at', 'email', 'action', 'type', 'itemId', 'title', 'space', 'detail'],
};

var ROLE_RANK = { guest: 1, member: 2, admin: 3, owner: 4 };
var DONE_STATUS = 'done';        // the task status id that means "finished"
var CELL_LIMIT = 49000;          // Google Sheets allows 50,000 characters per cell
var BODY_CELLS = 5;              // so a doc can hold about 245,000 characters
var DOC_LOCK_MINUTES = 10;       // an edit lock expires if the editor goes quiet

// ---------------------------------------------------------------- entry points

function doPost(e) {
  var out;
  try {
    out = handle(JSON.parse(e.postData.contents));
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err), code: (err && err.code) || 'ERROR' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'teamspace' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor (select "setup" and press Run) to create the tabs.
function setup() {
  ensureSchema(true);
}

function handle(req) {
  _tables = {};
  ensureSchema(false);
  var email = verifyIdentity(req.idToken);
  var action = ACTIONS[req.action];
  if (!action) fail('Unknown action: ' + req.action);

  var lock = LockService.getScriptLock();
  var needLock = action.write || req.action === 'bootstrap';
  if (needLock) lock.waitLock(20000);
  try {
    var ctx = { email: email, now: new Date().toISOString() };
    ctx.me = findMember(ctx);
    if (!ctx.me) fail('You are not on this team yet. Ask the owner to add ' + email + '.', 'NOT_MEMBER');
    var data = action.fn(ctx, req.data || {});
    if (action.write) bumpRev();
    return { ok: true, data: data, rev: getRev() };
  } finally {
    if (needLock) lock.releaseLock();
  }
}

// ---------------------------------------------------------------- identity

function verifyIdentity(token) {
  if (!token) fail('Please sign in.', 'AUTH');
  if (typeof DEMO_MODE !== 'undefined' && DEMO_MODE && token.indexOf('demo:') === 0) {
    return token.slice(5).toLowerCase();
  }
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + token.slice(-80);
  var hit = cache.get(key);
  if (hit) return hit;

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail('Your sign-in expired. Please sign in again.', 'AUTH');
  var info = JSON.parse(res.getContentText());
  if (info.aud !== prop('CLIENT_ID')) fail('This sign-in was made for a different app.', 'AUTH');
  if (String(info.email_verified) !== 'true') fail('Your Google email is not verified.', 'AUTH');
  var email = String(info.email).toLowerCase();
  var ttl = Math.max(60, Math.min(3000, Number(info.exp) - Math.floor(Date.now() / 1000) - 60));
  cache.put(key, email, ttl);
  return email;
}

function findMember(ctx) {
  var team = table('Team');
  var me = find(team, function (r) { return r.email.toLowerCase() === ctx.email; });
  var ownerEmail = String(prop('OWNER_EMAIL') || '').toLowerCase();
  if (!me && ownerEmail && ctx.email === ownerEmail) {
    me = insert(team, { email: ctx.email, name: ctx.email.split('@')[0], role: 'owner', spaces: '*', addedAt: ctx.now, lastActive: ctx.now });
  }
  return me;
}

// ---------------------------------------------------------------- permissions

function rank(ctx) { return ROLE_RANK[ctx.me.role] || 0; }
function isAdmin(ctx) { return rank(ctx) >= ROLE_RANK.admin; }

function require_(ok, msg) { if (!ok) fail(msg || 'Your role does not allow this.', 'FORBIDDEN'); }

// Spaces this person may see; null means all of them.
function allowedSpaces(ctx) {
  if (isAdmin(ctx)) return null;
  var s = String(ctx.me.spaces || '').trim();
  if ((s === '' || s === '*') && ctx.me.role !== 'guest') return null;
  return s.split(',').map(function (x) { return x.trim(); }).filter(String);
}

function canSee(ctx, space) {
  var allowed = allowedSpaces(ctx);
  if (!allowed) return true;
  if (!space) return ctx.me.role !== 'guest';
  return allowed.indexOf(space) >= 0;
}

function canEdit(ctx, space) { return rank(ctx) >= ROLE_RANK.member && canSee(ctx, space); }

function canDelete(ctx, createdBy, space) {
  return canSee(ctx, space) && (isAdmin(ctx) || (rank(ctx) >= ROLE_RANK.member && createdBy === ctx.email));
}

// ---------------------------------------------------------------- actions

var ACTIONS = {
  ping: { fn: function () { return {}; } },

  bootstrap: { fn: function (ctx) {
    touchLastActive(ctx);
    var spaces = table('Spaces').rows.filter(function (s) { return canSee(ctx, s.id); });
    return {
      me: publicPerson(ctx.me),
      team: table('Team').rows.map(publicPerson),
      spaces: spaces.map(strip),
      tasks: table('Tasks').rows.filter(function (t) { return canSee(ctx, t.space); }).map(taskOut),
      routines: rank(ctx) >= ROLE_RANK.member
        ? table('Routines').rows.filter(function (r) { return r.active !== 'false' && canSee(ctx, r.space); }).map(routineOut)
        : [],
      docs: table('Docs').rows.filter(function (d) { return canSee(ctx, d.space); }).map(docMeta),
      sheets: table('SheetLinks').rows.filter(function (s) { return canSee(ctx, s.space); }).map(sheetOut),
    };
  } },

  // ---- tasks
  'tasks.save': { write: true, fn: function (ctx, d) {
    var t = table('Tasks');
    var fields = pick(d.fields || {}, ['title', 'description', 'status', 'assignee', 'due', 'priority', 'space', 'checklist', 'order']);
    if (fields.checklist !== undefined) fields.checklist = JSON.stringify(fields.checklist || []);
    if (fields.title !== undefined) fields.title = String(fields.title).trim().slice(0, 300);

    if (!d.id) {
      require_(canEdit(ctx, fields.space), 'You cannot add tasks in this space.');
      if (!fields.title) fail('A task needs a name.');
      var task = Object.assign({
        id: newId(), status: 'todo', checklist: '[]', comments: '[]',
        createdAt: ctx.now, createdBy: ctx.email, updatedAt: ctx.now,
      }, fields);
      if (task.status === DONE_STATUS) { task.completedAt = ctx.now; task.completedBy = ctx.email; }
      insert(t, task);
      log(ctx, 'created', 'task', task);
      return taskOut(task);
    }

    var row = byId(t, d.id);
    require_(canEdit(ctx, row.space), 'You cannot edit tasks in this space.');
    if (fields.space !== undefined) require_(canEdit(ctx, fields.space), 'You cannot move tasks into that space.');
    var before = row.status;
    Object.assign(row, fields, { updatedAt: ctx.now });
    var wasDone = before === DONE_STATUS;
    var isDone = row.status === DONE_STATUS;
    if (!wasDone && isDone) {
      row.completedAt = ctx.now;
      row.completedBy = ctx.email;
      log(ctx, 'completed', 'task', row);
    } else if (wasDone && !isDone) {
      row.completedAt = '';
      row.completedBy = '';
      log(ctx, 'reopened', 'task', row);
    } else if (row.status !== before) {
      log(ctx, 'moved', 'task', row, row.status);
    } else if (!(Object.keys(fields).length === 1 && fields.checklist !== undefined)) {
      log(ctx, 'updated', 'task', row);
    }
    update(t, row);
    return taskOut(row);
  } },

  'tasks.delete': { write: true, fn: function (ctx, d) {
    var t = table('Tasks');
    var row = byId(t, d.id);
    require_(canDelete(ctx, row.createdBy, row.space), 'Only admins, or the person who made it, can delete this.');
    remove(t, [row]);
    log(ctx, 'deleted', 'task', row);
    return { id: d.id };
  } },

  'tasks.comment': { write: true, fn: function (ctx, d) {
    var t = table('Tasks');
    var row = byId(t, d.id);
    require_(canSee(ctx, row.space));
    var text = String(d.text || '').trim().slice(0, 5000);
    if (!text) fail('Write something first.');
    var comments = parseJson(row.comments, []);
    comments.push({ id: newId(), by: ctx.email, text: text, at: ctx.now });
    row.comments = JSON.stringify(comments);
    update(t, row);
    log(ctx, 'commented', 'task', row, text.slice(0, 120));
    return taskOut(row);
  } },

  // ---- routines (admins set them up, everyone ticks them)
  'routines.save': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can set up routines.');
    var t = table('Routines');
    var f = pick(d.fields || {}, ['title', 'notes', 'assignees', 'days', 'space']);
    if (Array.isArray(f.days)) f.days = f.days.join(',');
    if (Array.isArray(f.assignees)) f.assignees = f.assignees.join(',');
    var row;
    if (d.id) {
      row = Object.assign(byId(t, d.id), f);
      update(t, row);
    } else {
      if (!f.title) fail('A routine needs a name.');
      row = insert(t, Object.assign({ id: newId(), assignees: 'everyone', days: '1,2,3,4,5', active: 'true', createdAt: ctx.now, createdBy: ctx.email }, f));
    }
    log(ctx, d.id ? 'updated' : 'created', 'routine', row);
    return routineOut(row);
  } },

  'routines.delete': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can remove routines.');
    var t = table('Routines');
    var row = byId(t, d.id);
    row.active = 'false';      // keep it so old ticks still have a name in History
    update(t, row);
    log(ctx, 'deleted', 'routine', row);
    return { id: d.id };
  } },

  // ---- daily ticks and updates
  'daily.get': { fn: function (ctx, d) {
    if (rank(ctx) < ROLE_RANK.member) return { checks: [], updates: [] };
    var inRange = function (r) { return r.date >= d.from && r.date <= d.to; };
    return {
      checks: table('DailyChecks').rows.filter(inRange).map(strip),
      updates: table('Updates').rows.filter(inRange).map(strip),
    };
  } },

  'daily.toggle': { write: true, fn: function (ctx, d) {
    require_(rank(ctx) >= ROLE_RANK.member);
    var who = String(d.email || ctx.email).toLowerCase();
    if (who !== ctx.email) require_(isAdmin(ctx), 'Only admins can tick routines for someone else.');
    var routine = byId(table('Routines'), d.routineId);
    var t = table('DailyChecks');
    // History shows whose routine it was, even when an admin ticked it for them.
    var forPerson = Object.assign({}, ctx, { email: who });
    var existing = t.rows.filter(function (r) { return r.date === d.date && r.routineId === d.routineId && r.email === who; });
    if (d.on) {
      if (!existing.length) insert(t, { date: d.date, routineId: d.routineId, email: who, at: ctx.now, by: ctx.email });
      log(forPerson, 'ticked', 'routine', routine, d.date);
    } else {
      remove(t, existing);
      log(forPerson, 'unticked', 'routine', routine, d.date);
    }
    return { on: !!d.on };
  } },

  'daily.update': { write: true, fn: function (ctx, d) {
    require_(rank(ctx) >= ROLE_RANK.member);
    var t = table('Updates');
    var row = find(t, function (r) { return r.date === d.date && r.email === ctx.email; });
    var f = { yesterday: str(d.yesterday, 2000), today: str(d.today, 2000), blockers: str(d.blockers, 2000), at: ctx.now };
    if (row) update(t, Object.assign(row, f));
    else row = insert(t, Object.assign({ date: d.date, email: ctx.email }, f));
    log(ctx, 'posted update', 'daily', { id: d.date, title: 'Daily update ' + d.date, space: '' });
    return strip(row);
  } },

  // ---- docs
  'docs.get': { fn: function (ctx, d) {
    var row = byId(table('Docs'), d.id);
    require_(canSee(ctx, row.space));
    return docFull(row);
  } },

  'docs.save': { write: true, fn: function (ctx, d) {
    var t = table('Docs');
    var f = pick(d.fields || {}, ['title', 'space', 'folder', 'pinned', 'body']);
    if (f.pinned !== undefined) f.pinned = f.pinned ? 'true' : '';
    var body = f.body;
    delete f.body;

    if (!d.id) {
      require_(canEdit(ctx, f.space), 'You cannot add docs in this space.');
      var doc = Object.assign({ id: newId(), title: 'Untitled', version: 1, createdAt: ctx.now, createdBy: ctx.email,
        updatedAt: ctx.now, updatedBy: ctx.email, lockedBy: d.lock ? ctx.email : '', lockedAt: d.lock ? ctx.now : '' }, f);
      setBody(doc, body || '');
      insert(t, doc);
      log(ctx, 'created', 'doc', doc);
      return docFull(doc);
    }

    var row = byId(t, d.id);
    require_(canEdit(ctx, row.space), 'You cannot edit docs in this space.');
    if (f.space !== undefined) require_(canEdit(ctx, f.space), 'You cannot move docs into that space.');
    var holder = lockHolder(row, ctx);
    if (holder) fail(nameOf(holder) + ' is editing this doc right now.', 'LOCKED');
    if (body !== undefined && d.baseVersion !== undefined && Number(d.baseVersion) !== Number(row.version)) {
      fail('Someone saved a newer version while you were editing.', 'CONFLICT');
    }
    if (body !== undefined && body !== getBody(row)) {
      if (d.final) {
        var v = { docId: row.id, version: row.version, title: row.title, savedAt: row.updatedAt, savedBy: row.updatedBy };
        setBody(v, getBody(row));
        insert(table('DocVersions'), v);
      }
      setBody(row, body);
      row.version = Number(row.version || 1) + 1;
    }
    Object.assign(row, f, { updatedAt: ctx.now, updatedBy: ctx.email });
    if (d.final) { row.lockedBy = ''; row.lockedAt = ''; log(ctx, 'edited', 'doc', row); }
    else if (row.lockedBy === ctx.email) row.lockedAt = ctx.now;   // autosave keeps the lock fresh
    update(t, row);
    return docFull(row);
  } },

  'docs.lock': { write: true, fn: function (ctx, d) {
    var t = table('Docs');
    var row = byId(t, d.id);
    require_(canEdit(ctx, row.space), 'You cannot edit docs in this space.');
    var holder = lockHolder(row, ctx);
    if (d.on) {
      if (holder) fail(nameOf(holder) + ' is editing this doc right now.', 'LOCKED');
      row.lockedBy = ctx.email;
      row.lockedAt = ctx.now;
    } else if (!holder || isAdmin(ctx)) {
      row.lockedBy = '';
      row.lockedAt = '';
    }
    update(t, row);
    return docMeta(row);
  } },

  'docs.delete': { write: true, fn: function (ctx, d) {
    var t = table('Docs');
    var row = byId(t, d.id);
    require_(canDelete(ctx, row.createdBy, row.space), 'Only admins, or the person who made it, can delete this.');
    remove(t, [row]);
    log(ctx, 'deleted', 'doc', row);
    return { id: d.id };
  } },

  'docs.search': { fn: function (ctx, d) {
    var q = String(d.q || '').toLowerCase().trim();
    if (!q) return [];
    return table('Docs').rows
      .filter(function (doc) { return canSee(ctx, doc.space); })
      .map(function (doc) {
        var body = getBody(doc);
        var i = body.toLowerCase().indexOf(q);
        var inTitle = String(doc.title).toLowerCase().indexOf(q) >= 0;
        if (i < 0 && !inTitle) return null;
        var snippet = i < 0 ? '' : body.slice(Math.max(0, i - 40), i + q.length + 60);
        return { id: doc.id, title: doc.title, snippet: snippet };
      })
      .filter(Boolean)
      .slice(0, 50);
  } },

  'docs.versions': { fn: function (ctx, d) {
    var doc = byId(table('Docs'), d.id);
    require_(canSee(ctx, doc.space));
    return table('DocVersions').rows
      .filter(function (v) { return v.docId === d.id; })
      .map(function (v) { return { version: Number(v.version), title: v.title, savedAt: v.savedAt, savedBy: v.savedBy, body: getBody(v) }; })
      .reverse();
  } },

  // ---- sheet links
  'sheets.save': { write: true, fn: function (ctx, d) {
    var t = table('SheetLinks');
    var f = pick(d.fields || {}, ['name', 'url', 'mode', 'space', 'height', 'order']);
    if (f.url !== undefined && !/^https:\/\/docs\.google\.com\//.test(f.url)) fail('That is not a Google Sheets link.');
    if (f.mode !== undefined && f.mode !== 'edit' && f.mode !== 'view') f.mode = 'edit';
    var row;
    if (d.id) {
      row = byId(t, d.id);
      require_(canEdit(ctx, row.space));
      if (f.space !== undefined) require_(canEdit(ctx, f.space));
      update(t, Object.assign(row, f));
    } else {
      require_(canEdit(ctx, f.space), 'You cannot add sheets in this space.');
      if (!f.name || !f.url) fail('A sheet needs a name and a link.');
      row = insert(t, Object.assign({ id: newId(), mode: 'edit', addedBy: ctx.email, addedAt: ctx.now }, f));
      log(ctx, 'added', 'sheet', { id: row.id, title: row.name, space: row.space });
    }
    return sheetOut(row);
  } },

  'sheets.delete': { write: true, fn: function (ctx, d) {
    var t = table('SheetLinks');
    var row = byId(t, d.id);
    require_(canDelete(ctx, row.addedBy, row.space), 'Only admins, or the person who added it, can remove this.');
    remove(t, [row]);
    log(ctx, 'removed', 'sheet', { id: row.id, title: row.name, space: row.space });
    return { id: d.id };
  } },

  // ---- team, roles and spaces
  'team.save': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can manage people.');
    var t = table('Team');
    var email = String(d.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('That email address does not look right.');
    var role = String(d.role || 'member');
    if (!ROLE_RANK[role] || role === 'owner') fail('Pick Admin, Member or Guest.');
    var row = find(t, function (r) { return r.email.toLowerCase() === email; });
    if (ctx.me.role !== 'owner') {
      require_(role !== 'admin', 'Only the owner can make someone an admin.');
      require_(!row || ROLE_RANK[row.role] < ROLE_RANK.admin, 'Only the owner can change an admin.');
      require_(!row || row.role === role, 'Only the owner can change roles.');
    }
    if (row && row.role === 'owner') fail('The owner role cannot be changed here.');
    var spaces = Array.isArray(d.spaces) ? d.spaces.join(',') : String(d.spaces || '');
    if (role === 'guest' && (!spaces || spaces === '*')) fail('Pick the space this guest can see.');
    if (row) {
      var before = row.role;
      Object.assign(row, { name: str(d.name, 100) || row.name, role: role, spaces: spaces || '*' });
      update(t, row);
      log(ctx, before !== role ? 'changed role' : 'updated', 'person', { id: email, title: row.name, space: '' }, before !== role ? before + ' → ' + role : '');
    } else {
      row = insert(t, { email: email, name: str(d.name, 100) || email.split('@')[0], role: role, spaces: spaces || '*', addedAt: ctx.now });
      log(ctx, 'added', 'person', { id: email, title: row.name, space: '' }, role);
    }
    return publicPerson(row);
  } },

  'team.remove': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can remove people.');
    var t = table('Team');
    var email = String(d.email || '').toLowerCase();
    var row = find(t, function (r) { return r.email.toLowerCase() === email; });
    if (!row) fail('That person is not on the team.');
    if (row.role === 'owner') fail('The owner cannot be removed.');
    if (row.role === 'admin') require_(ctx.me.role === 'owner', 'Only the owner can remove an admin.');
    remove(t, [row]);
    log(ctx, 'removed', 'person', { id: email, title: row.name, space: '' });
    return { email: email };
  } },

  'spaces.save': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can manage spaces.');
    var t = table('Spaces');
    var f = pick(d, ['name', 'color']);
    var row;
    if (d.id) {
      row = byId(t, d.id);
      update(t, Object.assign(row, f));
    } else {
      if (!f.name) fail('A space needs a name.');
      row = insert(t, Object.assign({ id: slug(f.name), color: '#0F766E', createdAt: ctx.now }, f));
      log(ctx, 'created', 'space', { id: row.id, title: row.name, space: row.id });
    }
    return strip(row);
  } },

  'spaces.delete': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can manage spaces.');
    var t = table('Spaces');
    var row = byId(t, d.id);
    remove(t, [row]);
    ['Tasks', 'Docs', 'SheetLinks', 'Routines'].forEach(function (name) {
      var tt = table(name);
      tt.rows.forEach(function (r) { if (r.space === row.id) { r.space = ''; update(tt, r); } });
    });
    log(ctx, 'deleted', 'space', { id: row.id, title: row.name, space: '' });
    return { id: d.id };
  } },

  // ---- history
  'history.get': { fn: function (ctx, d) {
    require_(rank(ctx) >= ROLE_RANK.member, 'Guests cannot see History.');
    var own = !isAdmin(ctx);
    return table('Activity').rows
      .filter(function (a) {
        return a.at >= d.from && a.at <= d.to && (!own || a.email === ctx.email) && canSee(ctx, a.space);
      })
      .map(strip)
      .reverse()
      .slice(0, 2000);
  } },
};

// ---------------------------------------------------------------- shaping

function publicPerson(p) {
  return { email: p.email, name: p.name, role: p.role, spaces: p.spaces || '*', lastActive: p.lastActive || '' };
}

function taskOut(t) {
  var o = strip(t);
  o.checklist = parseJson(t.checklist, []);
  o.comments = parseJson(t.comments, []);
  o.order = Number(t.order) || 0;
  return o;
}

function routineOut(r) {
  var o = strip(r);
  o.days = String(r.days || '').split(',').filter(String).map(Number);
  o.assignees = !r.assignees || r.assignees === 'everyone' ? 'everyone' : r.assignees.split(',').filter(String);
  return o;
}

function docMeta(d) {
  return { id: d.id, title: d.title, space: d.space, folder: d.folder, pinned: d.pinned === 'true',
    version: Number(d.version) || 1, updatedAt: d.updatedAt, updatedBy: d.updatedBy,
    lockedBy: d.lockedBy, lockedAt: d.lockedAt, createdBy: d.createdBy };
}

function docFull(d) {
  var o = docMeta(d);
  o.body = getBody(d);
  return o;
}

function sheetOut(s) {
  var o = strip(s);
  o.height = Number(s.height) || 0;
  o.order = Number(s.order) || 0;
  return o;
}

function getBody(row) {
  var s = '';
  for (var i = 1; i <= BODY_CELLS; i++) s += row['body' + i] || '';
  return s;
}

function setBody(row, body) {
  body = String(body || '');
  if (body.length > CELL_LIMIT * BODY_CELLS) fail('This doc is too long. Split it into two docs.');
  for (var i = 1; i <= BODY_CELLS; i++) row['body' + i] = body.slice((i - 1) * CELL_LIMIT, i * CELL_LIMIT);
}

function lockHolder(row, ctx) {
  if (!row.lockedBy || row.lockedBy === ctx.email) return '';
  var age = (Date.now() - new Date(row.lockedAt).getTime()) / 60000;
  return age < DOC_LOCK_MINUTES ? row.lockedBy : '';
}

function nameOf(email) {
  var p = find(table('Team'), function (r) { return r.email === email; });
  return p ? p.name : email;
}

function log(ctx, action, type, item, detail) {
  insert(table('Activity'), {
    at: ctx.now, email: ctx.email, action: action, type: type,
    itemId: item.id || '', title: item.title || item.name || '', space: item.space || '', detail: detail || '',
  });
}

function touchLastActive(ctx) {
  var last = ctx.me.lastActive ? new Date(ctx.me.lastActive).getTime() : 0;
  if (Date.now() - last > 5 * 60000) {
    ctx.me.lastActive = ctx.now;
    update(table('Team'), ctx.me);
  }
}

// ---------------------------------------------------------------- sheet access

var _ss = null;
var _tables = {};

function ss() {
  if (!_ss) _ss = SpreadsheetApp.getActiveSpreadsheet();
  return _ss;
}

function ensureSchema(force) {
  var cache = CacheService.getScriptCache();
  if (!force && cache.get('schema_v1')) return;
  Object.keys(SCHEMA).forEach(function (name) {
    var headers = SCHEMA[name];
    var sh = ss().getSheetByName(name);
    if (!sh) sh = ss().insertSheet(name);
    // Plain text everywhere, so "2026-10-02" stays text instead of becoming a date.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  cache.put('schema_v1', '1', 21600);
}

function table(name) {
  if (_tables[name]) return _tables[name];
  var sh = ss().getSheetByName(name);
  var headers = SCHEMA[name];
  var values = sh.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = {};
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      var v = cellOut(values[i][c]);
      r[headers[c]] = v;
      if (v !== '') empty = false;
    }
    if (empty) continue;
    Object.defineProperty(r, '_row', { value: i + 1, writable: true, enumerable: false });
    rows.push(r);
  }
  _tables[name] = { name: name, sheet: sh, headers: headers, rows: rows };
  return _tables[name];
}

function cellOut(v) {
  if (v instanceof Date) {
    if (v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0) {
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    return v.toISOString();
  }
  if (v === null || v === undefined) return '';
  return String(v);
}

function cellIn(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  v = String(v);
  // A leading ' keeps Sheets from treating text as a formula.
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function toValues(t, obj) {
  return t.headers.map(function (h) { return cellIn(obj[h]); });
}

function insert(t, obj) {
  t.sheet.appendRow(toValues(t, obj));
  Object.defineProperty(obj, '_row', { value: t.sheet.getLastRow(), writable: true, enumerable: false });
  t.rows.push(obj);
  return obj;
}

function update(t, row) {
  t.sheet.getRange(row._row, 1, 1, t.headers.length).setValues([toValues(t, row)]);
}

function remove(t, rows) {
  rows.slice().sort(function (a, b) { return b._row - a._row; }).forEach(function (row) {
    t.sheet.deleteRow(row._row);
    t.rows.forEach(function (r) { if (r._row > row._row) r._row--; });
    t.rows.splice(t.rows.indexOf(row), 1);
  });
}

function find(t, fn) {
  for (var i = 0; i < t.rows.length; i++) if (fn(t.rows[i])) return t.rows[i];
  return null;
}

function byId(t, id) {
  var row = find(t, function (r) { return r.id === id; });
  if (!row) fail('Not found. It may have been deleted.', 'NOT_FOUND');
  return row;
}

// ---------------------------------------------------------------- small helpers

function fail(msg, code) {
  var e = new Error(msg);
  e.code = code || 'ERROR';
  throw e;
}

function prop(key) { return PropertiesService.getScriptProperties().getProperty(key); }

function getRev() { return Number(prop('rev') || 0); }

function bumpRev() { PropertiesService.getScriptProperties().setProperty('rev', String(getRev() + 1)); }

function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

function slug(s) {
  var base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'space';
  return base + '-' + newId().slice(0, 4);
}

function pick(obj, keys) {
  var o = {};
  keys.forEach(function (k) { if (obj[k] !== undefined) o[k] = obj[k]; });
  return o;
}

function strip(row) {
  var o = {};
  Object.keys(row).forEach(function (k) { if (k.indexOf('body') !== 0) o[k] = row[k]; });
  return o;
}

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

function str(v, max) { return String(v || '').slice(0, max); }

function pad2(n) { return (n < 10 ? '0' : '') + n; }
