# Teamspace

Our own ClickUp-style workspace: tasks, daily routines, docs, Google Sheets, a shared Drive, client calls, calendar and history in one place.

- **Free:** the website runs on GitHub Pages and the data lives in Supabase (free plan).
- **Sign-in:** with Google, using roles: Owner, Admin, Member, Guest.
- **No build step:** plain HTML, CSS and JavaScript.

**Going live:** follow [SETUP.md](SETUP.md), about 20 minutes.
**Trying it first:** open the site before setup and it runs in demo mode.

## What's inside

| Screen | What it does |
|---|---|
| Home | Your routines today, your tasks, what's due this week, pinned docs and sheets, and (owner and admins) the team's progress |
| Tasks | Board (drag cards between and within columns) or list. Assignee, due date, priority, space, checklist, comments. Saves who completed it and when. Owner and admins see every task; members see theirs and the ones they gave out. |
| Calendar | Month or week view of tasks due and done, routine ticks per day, scheduled client calls, and events and deadlines (anyone on the team adds them, for a client and/or inviting teammates). Clients see only their own calls and the events made for them. |
| Daily | Repeating routines with a tick per person (time saved). Members see their own; owner and admins everyone's. |
| History | Everything done, grouped by day, with charts. Owner and admins only. |
| Docs | A Google Docs style editor: several people type in the same doc at once and see each other's cursors. Fonts, sizes, colours, alignment, lists, checklists, tables, images, find & replace, print/PDF. Type `/` for blocks and to embed a Google Sheet, Google Doc, task, Slides, YouTube and more. Keeps old versions. |
| Sheets | Your team's key Google Sheets in tabs, each editable or read-only |
| Drive | Files for the team and clients, stored in Google Drive with a folder per space (and folders inside a space). Each file shows who uploaded it and when; the uploader, owner and admins can rename, move or delete it. Clients upload too. |
| Calls | Clients ask for a call; the owner and admins schedule it, inviting teammates (it lands on everyone's calendar), or decline it. Invited members see their calls here. |
| Team & roles | The Owner and Admins add people and set roles and spaces |

**Spaces:** **Scinth** is the team's own space; every other space is for one client. Clients are **guests**: they see only Drive, Calendar and "Request a call" for their space.

## How it fits together

```
Browser ──> GitHub Pages (this repo) ──> Supabase (Postgres database)
              the screens                  Google sign-in, plus security rules that check
                                           each person's role on every read and write
```

Teammates' changes show up instantly (Supabase sends them to every open tab).

## Files

```
index.html          the page
css/style.css       the look
js/config.js        settings you can change (name, columns, priorities, URLs)
js/app.js           sign-in, menu, page switching, syncing with teammates
js/api.js           sign-in, and sends each action to Supabase or the demo
js/supabase.js      every action (save task, tick routine…) done with Supabase
js/state.js         loaded data and permission checks for showing buttons
js/demo.js          demo mode: runs backend/Code.gs in the browser (uploads stay in the browser)
js/views/*.js       one file per screen
js/collab.js        live co-editing: shares each doc's changes and cursors with everyone who has it open
js/doc-tools.js     the doc editor's toolbar, "/" menu, find & replace and dialogs
tools/editor        source for vendor/editor.bundle.js (only needed to change the editor: `npm install && npm run build`)
supabase/migrations the database: tables, security rules, History log
supabase/functions  the "drive" server function: puts uploaded files in Google Drive (SETUP.md, Step 7)
backend/Code.gs     the old Google Sheets backend, now only used by demo mode (same rules as the database)
tools/demo-site.sh  builds the hosted demo website (demo mode, embeds as links) into ./demo-site
vendor/             marked, DOMPurify, the doc editor (Tiptap + Yjs, built from tools/editor), Supabase (stored here so nothing loads from other sites)
```

## Running it on your computer

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. It starts in demo mode unless `js/config.js` has your Supabase and Google details.
