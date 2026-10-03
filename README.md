# Teamspace

Our own ClickUp-style workspace: tasks, daily routines, docs, Google Sheets, calendar and history in one place.

- **Free:** the website runs on GitHub Pages and the data lives in Supabase (free plan).
- **Sign-in:** with Google, using roles: Owner, Admin, Member, Guest.
- **No build step:** plain HTML, CSS and JavaScript.

**Going live:** follow [SETUP.md](SETUP.md), about 20 minutes.
**Trying it first:** open the site before setup and it runs in demo mode.

## What's inside

| Screen | What it does |
|---|---|
| Home | Your routines today, your tasks, the team's progress, what's due this week, and pinned docs and sheets |
| Tasks | Board (drag cards) or list. Assignee, due date, priority, space, checklist, comments. Saves who completed it and when. |
| Calendar | Month or week view of tasks due and done, plus routine ticks per day |
| Daily | Repeating routines with a tick per person (time saved), and everyone's daily update |
| History | Everything done, grouped by day, with charts. Members see their own; Owner and Admins see everyone. |
| Docs | Our own editor, saved as markdown. Type `/` to embed a Google Sheet, Google Doc, task, Slides, YouTube and more. Keeps old versions. |
| Sheets | Your team's key Google Sheets in tabs, each editable or read-only |
| Team & roles | The Owner and Admins add people and set roles and spaces |

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
js/demo.js          demo mode: runs backend/Code.gs in the browser
js/views/*.js       one file per screen
supabase/migrations the database: tables, security rules, History log
backend/Code.gs     the old Google Sheets backend, now only used by demo mode
vendor/             marked, DOMPurify, Toast UI Editor, Supabase (stored here so nothing loads from other sites)
```

## Running it on your computer

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. It starts in demo mode unless `js/config.js` has your Supabase and Google details.
