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
  Routines: ['id', 'title', 'notes', 'assignees', 'days', 'space', 'active', 'createdAt', 'createdBy', 'removedAt', 'history'],
  DailyChecks: ['date', 'routineId', 'email', 'at', 'by'],
  Updates: ['date', 'email', 'yesterday', 'today', 'blockers', 'at'],
  Docs: ['id', 'title', 'space', 'folder', 'pinned', 'version', 'updatedAt', 'updatedBy',
    'lockedBy', 'lockedAt', 'createdAt', 'createdBy', 'body1', 'body2', 'body3', 'body4', 'body5'],
  DocVersions: ['docId', 'version', 'title', 'savedAt', 'savedBy', 'body1', 'body2', 'body3', 'body4', 'body5'],
  SheetLinks: ['id', 'name', 'url', 'mode', 'space', 'height', 'addedBy', 'addedAt', 'order', 'pinned'],
  Activity: ['at', 'email', 'action', 'type', 'itemId', 'title', 'space', 'detail'],
  DriveFiles: ['id', 'name', 'driveId', 'url', 'mime', 'size', 'space', 'uploadedBy', 'uploadedAt', 'folder', 'updatedBy', 'updatedAt'],
  CallRequests: ['id', 'email', 'space', 'topic', 'notes', 'preferred', 'status', 'meetingAt', 'duration',
    'link', 'reply', 'handledBy', 'createdAt', 'updatedAt', 'attendees'],
  Events: ['id', 'title', 'kind', 'date', 'time', 'duration', 'notes', 'client', 'attendees', 'space', 'createdBy', 'createdAt', 'updatedAt'],
};

var ROLE_RANK = { guest: 1, member: 2, admin: 3, owner: 4 };
var DONE_STATUS = 'done';        // the task status id that means "finished"
var MAIN_SPACE = 'scinth';       // the team's own space; every other space is a client space
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
// The same rules as the Supabase database (supabase/migrations).

function rank(ctx) { return ROLE_RANK[ctx.me.role] || 0; }
function isAdmin(ctx) { return rank(ctx) >= ROLE_RANK.admin; }
function isMember(ctx) { return rank(ctx) >= ROLE_RANK.member; }

function require_(ok, msg) { if (!ok) fail(msg || 'Your role does not allow this.', 'FORBIDDEN'); }

function listOf(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(String); }

// team.spaces lists the client spaces someone sees ('*' = all); members always see the main space, guests never.
function canSee(ctx, space) {
  if (isAdmin(ctx)) return true;
  var sp = space || MAIN_SPACE;
  if (sp === MAIN_SPACE) return ctx.me.role !== 'guest';
  var s = String(ctx.me.spaces || '').trim();
  if (s === '*' && ctx.me.role !== 'guest') return true;
  return listOf(s).indexOf(sp) >= 0;
}

function canEdit(ctx, space) { return isMember(ctx) && canSee(ctx, space); }

function canDelete(ctx, createdBy, space) {
  return canSee(ctx, space) && (isAdmin(ctx) || (isMember(ctx) && createdBy === ctx.email));
}

// Owner and admins see every task; members the ones assigned to them or made by them; guests none.
function taskVisible(ctx, t) {
  return isAdmin(ctx) || (isMember(ctx) && canSee(ctx, t.space) && (t.assignee === ctx.email || t.createdBy === ctx.email));
}

// Calls: owner and admins see all; the guest who asked sees theirs; invited members see theirs.
function callVisible(ctx, c) {
  return isAdmin(ctx) || c.email === ctx.email || (isMember(ctx) && listOf(c.attendees).indexOf(ctx.email) >= 0);
}

// Events: owner and admins see all; members the ones they made or are invited to; guests the ones for them.
function eventVisible(ctx, e) {
  if (isAdmin(ctx)) return true;
  if (isMember(ctx)) return e.createdBy === ctx.email || listOf(e.attendees).indexOf(ctx.email) >= 0;
  return e.client === ctx.email;
}

// Invited people must be on the team and not guests.
function checkAttendees(list) {
  var team = table('Team');
  var emails = (Array.isArray(list) ? list : listOf(list)).map(function (x) { return String(x).trim().toLowerCase(); }).filter(String);
  var bad = emails.filter(function (e) { return !find(team, function (p) { return p.email === e && p.role !== 'guest'; }); });
  if (bad.length) fail('Only people on the team can be invited (not ' + bad.join(', ') + ').');
  return emails.filter(function (e, i) { return emails.indexOf(e) === i; }).join(',');
}

// Is (or was) this routine for me? Past assignments count, so old ticks keep their routine.
function routineMine(ctx, r) {
  if (!r.assignees || r.assignees === 'everyone' || listOf(r.assignees).indexOf(ctx.email) >= 0) return true;
  return parseJson(r.history, []).some(function (h) { return !h.assignees || h.assignees.indexOf(ctx.email) >= 0; });
}

function routineVisible(ctx, r) {
  return isAdmin(ctx) || (isMember(ctx) && canSee(ctx, r.space) && routineMine(ctx, r));
}

// ---------------------------------------------------------------- actions

var ACTIONS = {
  ping: { fn: function () { return {}; } },

  bootstrap: { fn: function (ctx) {
    touchLastActive(ctx);
    var guest = ctx.me.role === 'guest';
    return {
      me: publicPerson(ctx.me),
      // Guests see the team and themselves, but not other guests (one client never sees another).
      team: table('Team').rows.filter(function (p) {
        return !guest || p.email === ctx.email || p.role !== 'guest';
      }).map(publicPerson),
      spaces: table('Spaces').rows.filter(function (s) { return canSee(ctx, s.id); }).map(strip),
      tasks: table('Tasks').rows.filter(function (t) { return taskVisible(ctx, t); }).map(taskOut),
      routines: table('Routines').rows.filter(function (r) { return routineVisible(ctx, r); }).map(routineOut),
      docs: isMember(ctx) ? table('Docs').rows.filter(function (d) { return canSee(ctx, d.space); }).map(docMeta) : [],
      sheets: isMember(ctx) ? table('SheetLinks').rows.filter(function (s) { return canSee(ctx, s.space); }).map(sheetOut) : [],
      files: table('DriveFiles').rows.filter(function (f) { return canSee(ctx, f.space); }).map(fileOut),
      calls: table('CallRequests').rows.filter(function (c) { return callVisible(ctx, c); }).map(callOut),
      events: table('Events').rows.filter(function (e) { return eventVisible(ctx, e); }).map(eventOut),
    };
  } },

  // ---- tasks
  'tasks.save': { write: true, fn: function (ctx, d) {
    var t = table('Tasks');
    var fields = pick(d.fields || {}, ['title', 'description', 'status', 'assignee', 'due', 'priority', 'space', 'checklist', 'order']);
    if (fields.checklist !== undefined) fields.checklist = JSON.stringify(fields.checklist || []);
    if (fields.title !== undefined) fields.title = String(fields.title).trim().slice(0, 300);
    if (fields.space !== undefined) fields.space = fields.space || MAIN_SPACE;

    if (!d.id) {
      var space = fields.space || MAIN_SPACE;
      require_(canEdit(ctx, space), 'You cannot add tasks in this space.');
      if (!fields.title) fail('A task needs a name.');
      var task = Object.assign({
        id: newId(), status: 'todo', checklist: '[]', comments: '[]',
        createdAt: ctx.now, createdBy: ctx.email, updatedAt: ctx.now,
      }, fields, { space: space });
      if (task.status === DONE_STATUS) { task.completedAt = ctx.now; task.completedBy = ctx.email; }
      insert(t, task);
      log(ctx, 'created', 'task', task);
      return taskOut(task);
    }

    var row = byId(t, d.id);
    require_(taskVisible(ctx, row) && canEdit(ctx, row.space), 'You cannot edit this task.');
    if (fields.space !== undefined) require_(canEdit(ctx, fields.space), 'You cannot move tasks into that space.');
    var after = Object.assign({}, row, fields);
    require_(taskVisible(ctx, after), 'Only an admin or whoever gave you this task can give it to someone else.');
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
    } else if (!Object.keys(fields).every(function (k) { return k === 'checklist' || k === 'order'; })) {
      log(ctx, 'updated', 'task', row);
    }
    update(t, row);
    return taskOut(row);
  } },

  'tasks.delete': { write: true, fn: function (ctx, d) {
    var t = table('Tasks');
    var row = byId(t, d.id);
    require_(taskVisible(ctx, row) && canDelete(ctx, row.createdBy, row.space), 'Only admins, or the person who made it, can delete this.');
    remove(t, [row]);
    log(ctx, 'deleted', 'task', row);
    return { id: d.id };
  } },

  'tasks.comment': { write: true, fn: function (ctx, d) {
    var t = table('Tasks');
    var row = byId(t, d.id);
    require_(taskVisible(ctx, row), 'That task is gone. It may have been deleted.');
    var text = String(d.text || '').trim().slice(0, 5000);
    if (!text) fail('Write something first.');
    var comments = parseJson(row.comments, []);
    comments.push({ id: newId(), by: ctx.email, text: text, at: ctx.now });
    row.comments = JSON.stringify(comments);
    update(t, row);
    log(ctx, 'commented', 'task', row, text.slice(0, 120));
    return taskOut(row);
  } },

  // ---- routines (admins set them up; each person ticks their own)
  'routines.save': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can set up routines.');
    var t = table('Routines');
    var f = pick(d.fields || {}, ['title', 'notes', 'assignees', 'days', 'space']);
    if (Array.isArray(f.days)) f.days = f.days.join(',');
    if (Array.isArray(f.assignees)) f.assignees = f.assignees.join(',');
    if (f.space !== undefined) f.space = f.space || MAIN_SPACE;
    var row;
    if (d.id) {
      row = byId(t, d.id);
      // Remember how it was set up until now, so past days keep being counted that way.
      var changed = ['assignees', 'days', 'space'].some(function (k) { return f[k] !== undefined && String(f[k]) !== String(row[k] || ''); });
      if (changed) {
        var history = parseJson(row.history, []);
        history.push({
          until: ctx.now,
          assignees: !row.assignees || row.assignees === 'everyone' ? null : listOf(row.assignees),
          days: String(row.days || '').split(',').filter(String).map(Number),
          space: row.space || MAIN_SPACE,
        });
        row.history = JSON.stringify(history);
      }
      Object.assign(row, f);
      update(t, row);
    } else {
      if (!f.title) fail('A routine needs a name.');
      row = insert(t, Object.assign({ id: newId(), assignees: 'everyone', days: '1,2,3,4,5', space: MAIN_SPACE, active: 'true', createdAt: ctx.now, createdBy: ctx.email, history: '[]' }, f));
    }
    log(ctx, d.id ? 'updated' : 'created', 'routine', row);
    return routineOut(row);
  } },

  'routines.delete': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can remove routines.');
    var t = table('Routines');
    var row = byId(t, d.id);
    row.active = 'false';      // keep it so old ticks still have a name in History
    row.removedAt = ctx.now;   // and so past days still count it
    update(t, row);
    log(ctx, 'deleted', 'routine', row);
    return { id: d.id };
  } },

  // ---- daily ticks
  'daily.get': { fn: function (ctx, d) {
    if (!isMember(ctx)) return { checks: [] };
    var routines = table('Routines');
    var inRange = function (r) { return r.date >= d.from && r.date <= d.to; };
    return {
      // Members get only their own ticks; owner and admins everyone's.
      checks: table('DailyChecks').rows.filter(function (c) {
        if (!inRange(c)) return false;
        if (isAdmin(ctx)) return true;
        var r = find(routines, function (x) { return x.id === c.routineId; });
        return c.email === ctx.email && r && routineVisible(ctx, r);
      }).map(strip),
    };
  } },

  'daily.toggle': { write: true, fn: function (ctx, d) {
    require_(isMember(ctx));
    var who = String(d.email || ctx.email).toLowerCase();
    if (who !== ctx.email) require_(isAdmin(ctx), 'Only admins can tick routines for someone else.');
    var routine = byId(table('Routines'), d.routineId);
    require_(routineVisible(ctx, routine), 'Your role does not allow this.');
    var forMe = !routine.assignees || routine.assignees === 'everyone' || listOf(routine.assignees).indexOf(who) >= 0;
    require_(forMe, 'This routine is not for that person.');
    var tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    require_(d.date <= tomorrow, 'You cannot tick a routine for a future day.');
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

  // ---- docs (team only)
  'docs.get': { fn: function (ctx, d) {
    var row = byId(table('Docs'), d.id);
    require_(isMember(ctx) && canSee(ctx, row.space));
    return docFull(row);
  } },

  'docs.save': { write: true, fn: function (ctx, d) {
    var t = table('Docs');
    var f = pick(d.fields || {}, ['title', 'space', 'folder', 'pinned', 'body']);
    if (f.pinned !== undefined) f.pinned = f.pinned ? 'true' : '';
    if (f.space !== undefined) f.space = f.space || MAIN_SPACE;
    var body = f.body;
    delete f.body;

    if (!d.id) {
      var space = f.space || MAIN_SPACE;
      require_(canEdit(ctx, space), 'You cannot add docs in this space.');
      var doc = Object.assign({ id: newId(), title: 'Untitled', version: 1, createdAt: ctx.now, createdBy: ctx.email,
        updatedAt: ctx.now, updatedBy: ctx.email, lockedBy: '', lockedAt: '' }, f, { space: space });
      setBody(doc, body || '');
      insert(t, doc);
      log(ctx, 'created', 'doc', doc);
      return docFull(doc);
    }

    var row = byId(t, d.id);
    require_(canEdit(ctx, row.space), 'You cannot edit docs in this space.');
    if (f.space !== undefined) require_(canEdit(ctx, f.space), 'You cannot move docs into that space.');
    if (body !== undefined && body !== getBody(row)) {
      if (d.final) {
        var v = { docId: row.id, version: row.version, title: row.title, savedAt: row.updatedAt, savedBy: row.updatedBy };
        setBody(v, getBody(row));
        insert(table('DocVersions'), v);
      }
      setBody(row, body);
      row.version = Number(row.version || 1) + 1;
    }
    Object.assign(row, f, { updatedAt: ctx.now, updatedBy: ctx.email, lockedBy: '', lockedAt: '' });
    if (d.final) log(ctx, 'edited', 'doc', row);
    update(t, row);
    return docFull(row);
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
    if (!q || !isMember(ctx)) return [];
    return table('Docs').rows
      .filter(function (doc) { return canSee(ctx, doc.space); })
      .map(function (doc) {
        // Search the words, not the HTML tags.
        var body = getBody(doc).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
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
    require_(isMember(ctx) && canSee(ctx, doc.space));
    return table('DocVersions').rows
      .filter(function (v) { return v.docId === d.id; })
      .map(function (v) { return { version: Number(v.version), title: v.title, savedAt: v.savedAt, savedBy: v.savedBy, body: getBody(v) }; })
      .reverse();
  } },

  // ---- sheet links (team only)
  'sheets.save': { write: true, fn: function (ctx, d) {
    var t = table('SheetLinks');
    var f = pick(d.fields || {}, ['name', 'url', 'mode', 'space', 'height', 'order', 'pinned']);
    if (f.pinned !== undefined) f.pinned = f.pinned ? 'true' : '';
    if (f.space !== undefined) f.space = f.space || MAIN_SPACE;
    if (f.url !== undefined && !/^https:\/\/docs\.google\.com\//.test(f.url)) fail('That is not a Google Sheets link.');
    if (f.mode !== undefined && f.mode !== 'edit' && f.mode !== 'view') f.mode = 'edit';
    var row;
    if (d.id) {
      row = byId(t, d.id);
      require_(canEdit(ctx, row.space));
      if (f.space !== undefined) require_(canEdit(ctx, f.space));
      update(t, Object.assign(row, f));
    } else {
      var space = f.space || MAIN_SPACE;
      require_(canEdit(ctx, space), 'You cannot add sheets in this space.');
      if (!f.name || !f.url) fail('A sheet needs a name and a link.');
      row = insert(t, Object.assign({ id: newId(), mode: 'edit', addedBy: ctx.email, addedAt: ctx.now }, f, { space: space }));
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

  // ---- Drive (demo mode: the file itself stays in the browser; the real site uses Google Drive)
  'drive.add': { write: true, fn: function (ctx, d) {
    var space = d.space || MAIN_SPACE;
    require_(canSee(ctx, space), 'You cannot upload to that space.');
    var name = String(d.name || '').slice(0, 255);
    if (!name) fail('Pick a file to upload.');
    var row = insert(table('DriveFiles'), {
      id: newId(), name: name, driveId: String(d.driveId || ''), url: String(d.url || ''), mime: String(d.mime || ''),
      size: Number(d.size) || 0, space: space, folder: cleanFolder(d.folder), uploadedBy: ctx.email, uploadedAt: ctx.now,
    });
    log(ctx, 'uploaded', 'file', { id: row.id, title: row.name, space: row.space });
    return fileOut(row);
  } },

  // Rename and/or move to another space or folder: the uploader, or the owner and admins.
  'drive.update': { write: true, fn: function (ctx, d) {
    var t = table('DriveFiles');
    var row = byId(t, d.id);
    var f = d.fields || {};
    require_(canSee(ctx, row.space) && (isAdmin(ctx) || row.uploadedBy === ctx.email), 'Only admins, or the person who uploaded it, can rename or move this.');
    var name = f.name === undefined ? row.name : String(f.name).trim().slice(0, 255);
    if (!name) fail('A file needs a name.');
    var space = f.space === undefined ? row.space : (f.space || MAIN_SPACE);
    require_(canSee(ctx, space) && !!find(table('Spaces'), function (s) { return s.id === space; }), 'You cannot move files to that space.');
    var folder = f.folder === undefined ? (row.folder || '') : cleanFolder(f.folder);
    var renamed = name !== row.name;
    var moved = space !== row.space || folder !== (row.folder || '');
    if (!renamed && !moved) return fileOut(row);
    var oldName = row.name;
    row.name = name; row.space = space; row.folder = folder; row.updatedBy = ctx.email; row.updatedAt = ctx.now;
    update(t, row);
    if (renamed) log(ctx, 'renamed', 'file', row, oldName);
    if (moved) {
      var sp = find(table('Spaces'), function (s) { return s.id === space; });
      log(ctx, 'moved', 'file', row, (sp ? sp.name : space) + (folder ? ' / ' + folder : ''));
    }
    return fileOut(row);
  } },

  // Demo files aren't in Google Drive, so there is nothing to sort.
  'drive.organize': { fn: function (ctx) {
    require_(isAdmin(ctx), 'Only the owner and admins can sort the Drive folder.');
    return { sorted: 0, failed: [], left: 0 };
  } },

  'drive.delete': { write: true, fn: function (ctx, d) {
    var t = table('DriveFiles');
    var row = byId(t, d.id);
    require_(canSee(ctx, row.space) && (isAdmin(ctx) || row.uploadedBy === ctx.email), 'Only admins, or the person who uploaded it, can delete this.');
    remove(t, [row]);
    log(ctx, 'deleted', 'file', { id: row.id, title: row.name, space: row.space });
    return { id: d.id, url: row.url };
  } },

  // ---- calls: guests ask, owner and admins schedule or decline
  'calls.request': { write: true, fn: function (ctx, d) {
    require_(ctx.me.role === 'guest', 'Calls are requested by clients.');
    var space = d.space || listOf(ctx.me.spaces)[0];
    require_(canSee(ctx, space), 'You cannot request a call for that space.');
    var topic = String(d.topic || '').trim().slice(0, 200);
    if (!topic) fail('Say what the call is about.');
    var row = insert(table('CallRequests'), {
      id: newId(), email: ctx.email, space: space, topic: topic, notes: str(d.notes, 2000).trim(), preferred: str(d.preferred, 500).trim(),
      status: 'requested', createdAt: ctx.now, updatedAt: ctx.now,
    });
    log(ctx, 'requested', 'call', { id: row.id, title: row.topic, space: row.space });
    return callOut(row);
  } },

  'calls.update': { write: true, fn: function (ctx, d) {
    var t = table('CallRequests');
    var row = byId(t, d.id);
    var f = d.fields || {};
    if (!isAdmin(ctx)) {
      require_(row.email === ctx.email, 'You cannot change this call.');
      var onlyStatus = Object.keys(f).every(function (k) { return k === 'status'; });
      require_(onlyStatus && f.status === 'cancelled' && (row.status === 'requested' || row.status === 'scheduled'), 'You can only cancel your own request.');
    }
    var next = Object.assign({}, row);
    if (f.status !== undefined) next.status = f.status;
    if (f.meetingAt !== undefined) next.meetingAt = f.meetingAt || '';
    if (f.duration !== undefined) next.duration = Number(f.duration) || '';
    if (f.link !== undefined) next.link = String(f.link || '').trim();
    if (f.reply !== undefined) next.reply = str(f.reply, 1000).trim();
    if (f.attendees !== undefined) next.attendees = checkAttendees(f.attendees);
    if (['requested', 'scheduled', 'declined', 'cancelled'].indexOf(next.status) < 0) fail('That is not a call status.');
    if (next.link && !/^https:\/\//.test(next.link)) fail('The meeting link must start with https://');
    if (next.status === 'scheduled' && (!next.meetingAt || !next.duration)) fail('Pick a date, time and length for the call.');
    var changed = next.status !== row.status || next.meetingAt !== row.meetingAt;
    if (next.status !== row.status) next.handledBy = ctx.email;
    next.updatedAt = ctx.now;
    Object.assign(row, next);
    update(t, row);
    if (changed) log(ctx, next.status === 'requested' ? 'updated' : next.status, 'call', { id: row.id, title: row.topic, space: row.space });
    return callOut(row);
  } },

  // ---- calendar events and deadlines
  'events.save': { write: true, fn: function (ctx, d) {
    var t = table('Events');
    var f = d.fields || {};
    var row = d.id ? byId(t, d.id) : null;
    if (row) require_(isAdmin(ctx) || row.createdBy === ctx.email, 'Only the person who added it, or an admin, can change this.');
    var next = Object.assign({}, row || { id: newId(), kind: 'event', notes: '', client: '', attendees: '', space: MAIN_SPACE, createdBy: ctx.email, createdAt: ctx.now });
    if (f.title !== undefined) next.title = String(f.title || '').trim().slice(0, 200);
    if (f.kind !== undefined) next.kind = f.kind === 'deadline' ? 'deadline' : 'event';
    if (f.date !== undefined) next.date = String(f.date || '');
    if (f.time !== undefined) next.time = String(f.time || '');
    if (f.duration !== undefined) next.duration = Number(f.duration) || '';
    if (f.notes !== undefined) next.notes = str(f.notes, 2000);
    if (f.space !== undefined) next.space = f.space || MAIN_SPACE;
    if (f.attendees !== undefined) next.attendees = checkAttendees(f.attendees);
    if (f.client !== undefined) {
      next.client = String(f.client || '').trim().toLowerCase();
      if (next.client && !find(table('Team'), function (p) { return p.email === next.client && p.role === 'guest'; })) {
        fail('Pick the client from the list (clients are guests on the team).');
      }
    }
    if (!next.title) fail('Give it a name.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date)) fail('Pick a date.');
    if (!next.time) next.duration = '';
    require_(canEdit(ctx, next.space), 'You cannot add events in that space.');
    next.updatedAt = ctx.now;
    if (row) { Object.assign(row, next); update(t, row); } else row = insert(t, next);
    log(ctx, d.id ? 'updated' : 'added', 'event', { id: row.id, title: row.title, space: row.space }, row.date);
    return eventOut(row);
  } },

  'events.delete': { write: true, fn: function (ctx, d) {
    var t = table('Events');
    var row = byId(t, d.id);
    require_(isAdmin(ctx) || row.createdBy === ctx.email, 'Only the person who added it, or an admin, can delete this.');
    remove(t, [row]);
    log(ctx, 'deleted', 'event', { id: row.id, title: row.title, space: row.space }, row.date);
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
    var spaces = (Array.isArray(d.spaces) ? d.spaces.join(',') : String(d.spaces == null ? '' : d.spaces)).trim();
    if (role === 'admin') spaces = '*';
    if (role === 'guest') {
      if (!spaces || spaces === '*') fail('Pick the client space this guest belongs to.');
      if (listOf(spaces).indexOf(MAIN_SPACE) >= 0) fail('Guests are clients: pick a client space, not Scinth.');
    }
    if (row) {
      var before = row.role;
      Object.assign(row, { name: str(d.name, 100) || row.name, role: role, spaces: spaces });
      update(t, row);
      log(ctx, before !== role ? 'changed role' : 'updated', 'person', { id: email, title: row.name, space: '' }, before !== role ? before + ' → ' + role : '');
    } else {
      row = insert(t, { email: email, name: str(d.name, 100) || email.split('@')[0], role: role, spaces: spaces, addedAt: ctx.now });
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

  // A client space's items move to the main space; Scinth itself can't be deleted, and a
  // space can't be deleted while it is some guest's only space.
  'spaces.delete': { write: true, fn: function (ctx, d) {
    require_(isAdmin(ctx), 'Only the owner and admins can manage spaces.');
    if (d.id === MAIN_SPACE) fail('Scinth is the main space and cannot be deleted.');
    var t = table('Spaces');
    var row = byId(t, d.id);
    var team = table('Team');
    var stuck = team.rows.filter(function (p) {
      return p.role === 'guest' && listOf(p.spaces).indexOf(row.id) >= 0 && listOf(p.spaces).every(function (x) { return x === row.id; });
    });
    if (stuck.length) {
      fail(stuck.map(function (p) { return p.name; }).join(', ') + ' only belong(s) to this space. Move them to another client space or remove them first.');
    }
    remove(t, [row]);
    ['Tasks', 'Docs', 'SheetLinks', 'Routines', 'DriveFiles', 'CallRequests', 'Events'].forEach(function (name) {
      var tt = table(name);
      tt.rows.forEach(function (r) { if (r.space === row.id) { r.space = MAIN_SPACE; update(tt, r); } });
    });
    team.rows.forEach(function (p) {
      if ((p.role === 'member' || p.role === 'guest') && listOf(p.spaces).indexOf(row.id) >= 0) {
        p.spaces = listOf(p.spaces).filter(function (x) { return x !== row.id; }).join(',');
        update(team, p);
      }
    });
    log(ctx, 'deleted', 'space', { id: row.id, title: row.name, space: '' });
    return { id: d.id };
  } },

  // ---- history: owner and admins
  'history.get': { fn: function (ctx, d) {
    require_(isAdmin(ctx), 'History is for the owner and admins.');
    return table('Activity').rows
      .filter(function (a) { return a.at >= d.from && a.at <= d.to; })
      .map(strip)
      .reverse()
      .slice(0, 2000);
  } },
};

// ---------------------------------------------------------------- shaping

function publicPerson(p) {
  return { email: p.email, name: p.name, role: p.role, spaces: String(p.spaces == null ? '' : p.spaces), lastActive: p.lastActive || '' };
}

function taskOut(t) {
  var o = strip(t);
  o.space = t.space || MAIN_SPACE;
  o.checklist = parseJson(t.checklist, []);
  o.comments = parseJson(t.comments, []);
  o.order = Number(t.order) || 0;
  return o;
}

function routineOut(r) {
  var o = strip(r);
  o.space = r.space || MAIN_SPACE;
  o.active = r.active !== 'false';
  o.days = String(r.days || '').split(',').filter(String).map(Number);
  o.assignees = !r.assignees || r.assignees === 'everyone' ? 'everyone' : listOf(r.assignees);
  o.history = parseJson(r.history, []);
  return o;
}

function docMeta(d) {
  return { id: d.id, title: d.title, space: d.space || MAIN_SPACE, folder: d.folder, pinned: d.pinned === 'true',
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
  o.space = s.space || MAIN_SPACE;
  o.height = Number(s.height) || 0;
  o.pinned = s.pinned === 'true';
  o.order = Number(s.order) || 0;
  return o;
}

function fileOut(f) {
  return { id: f.id, name: f.name, url: f.url, mime: f.mime, size: Number(f.size) || 0, space: f.space || MAIN_SPACE,
    folder: f.folder || '', sorted: true, uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt,
    updatedBy: f.updatedBy || '', updatedAt: f.updatedAt || '' };
}

// A Drive folder name: one level, so no slashes. '' = straight in the space.
function cleanFolder(v) {
  return String(v || '').replace(/[\/\\]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function callOut(c) {
  return { id: c.id, email: c.email, space: c.space || MAIN_SPACE, topic: c.topic, notes: c.notes, preferred: c.preferred,
    status: c.status, meetingAt: c.meetingAt || '', duration: Number(c.duration) || 0, link: c.link || '', reply: c.reply || '',
    handledBy: c.handledBy || '', attendees: listOf(c.attendees), createdAt: c.createdAt, updatedAt: c.updatedAt };
}

function eventOut(e) {
  return { id: e.id, title: e.title, kind: e.kind || 'event', date: e.date, time: e.time || '', duration: Number(e.duration) || 0,
    notes: e.notes || '', client: e.client || '', attendees: listOf(e.attendees), space: e.space || MAIN_SPACE,
    createdBy: e.createdBy, createdAt: e.createdAt };
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
  if (!force && cache.get('schema_v5')) return;   // bump when SCHEMA changes so headers get rewritten
  Object.keys(SCHEMA).forEach(function (name) {
    var headers = SCHEMA[name];
    var sh = ss().getSheetByName(name);
    if (!sh) sh = ss().insertSheet(name);
    // Plain text everywhere, so "2026-10-02" stays text instead of becoming a date.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  cache.put('schema_v5', '1', 21600);
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
