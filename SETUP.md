# Going live: setup checklist

About 20 minutes, one time. You need a Google account, a Supabase account and this GitHub repo.

Until you finish, the site runs in **demo mode**: fake data that stays in your own browser, and you can switch between the roles to try them.

> **Already done for Scinth Team:** Steps 1 to 4 are set up (Supabase project `scinth-teamspace`,
> Owner `neshaa@scinth.co`). Keep this guide for reference or for setting up another workspace.

---

## Step 1: Make the database (5 min)

- [ ] At [supabase.com/dashboard](https://supabase.com/dashboard), click **New project**. Pick the region closest to your team.
- [ ] Open **SQL Editor**. Paste and run each file in [`supabase/migrations`](supabase/migrations), in order (`…01_tables`, `…02_security`, `…03_triggers`, `…04_rpc`, `…05_live_docs`, `…05_sheet_pinned`, `…06_search_and_ticks`, `…01_roles_spaces_drive_calls`, `…02_events_invites_guest_team`, `…01_drive_folders`). `…05_live_docs` turns on live co-editing in Docs; `…01_roles_spaces_drive_calls` sets up the roles, the Scinth space, Drive and calls; `…02_events_invites_guest_team` adds calendar events and call invites; `…01_drive_folders` gives each space its own Drive folder and lets people rename and move files. Already set up? Just run the ones you haven't run yet, in order.
- [ ] Still in the SQL Editor, make yourself the Owner:

  ```sql
  insert into public.team (email, name, role, spaces) values ('you@yourcompany.com', 'Your Name', 'owner', '*');
  ```

## Step 2: Make the Google sign-in key (7 min)

- [ ] Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project called **Teamspace**.
- [ ] Open **APIs & Services → OAuth consent screen**.
  - If your team uses Google Workspace: pick **Internal**.
  - If you use personal Gmail accounts: pick **External**, then **Publish app**. This only asks for name and email, so Google doesn't need to review it.
- [ ] Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
  - Application type: **Web application**
  - Authorized JavaScript origins: add `https://workspace.scinth.co`
    (also add `http://localhost:8000` if you want to test on your computer)
- [ ] Copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

## Step 3: Turn on Google sign-in in Supabase (2 min)

- [ ] In Supabase: **Authentication → Sign In / Providers → Google**.
  - Switch on **Enable Sign in with Google**.
  - **Client IDs**: paste the Client ID from Step 2.
  - Switch on **Skip nonce checks** (the site's Google button doesn't send one).
  - **Save**.
- [ ] **Authentication → URL Configuration**: set **Site URL** to `https://workspace.scinth.co`.

## Step 4: Point the website at it (2 min)

- [ ] In Supabase: **Project Settings → API Keys**. Copy the project URL and the **publishable** key (`sb_publishable_…`).
  Never use the secret key in the website.
- [ ] In this repo, open [`js/config.js`](js/config.js) and fill in:

  ```js
  supabaseUrl: 'https://….supabase.co',
  supabaseKey: 'sb_publishable_…',
  googleClientId: '….apps.googleusercontent.com',
  ```

- [ ] Commit the change.

## Step 5: Turn on GitHub Pages (2 min)

- [ ] In the repo on GitHub: **Settings → Pages**.
- [ ] Source: **Deploy from a branch** → pick the branch with this code, folder **/ (root)** → **Save**.
- [ ] Under **Custom domain**, enter `workspace.scinth.co` and save. (The `CNAME` file in this repo already holds it.)
- [ ] At your DNS host for `scinth.co`, add a record: **CNAME**, name `workspace`, value `neshaalaksh.github.io`. On Cloudflare, set it to **DNS only**.
- [ ] When GitHub's DNS check passes, tick **Enforce HTTPS**. Your site is then at `https://workspace.scinth.co`.

> GitHub Pages is free for **public** repos. A private repo needs a paid GitHub plan.
> Your data is safe either way: it lives in Supabase, not in the repo.

## Step 6: Add your team and clients

- [ ] Open the site and sign in with Google. You're the Owner.
- [ ] **Scinth** is the team's own space and is already there. Go to **Team & roles → Manage spaces** and add a space for each client (e.g. Acme Ltd).
- [ ] Go to **Team & roles → + Add person** for each teammate: their Google email and role. Members always see Scinth; tick any client spaces they also work in.
- [ ] Add each client contact as a **Guest** and pick their client space. Guests see only Drive, Calendar and "Request a call" for their space.
- [ ] Send them the link. They sign in with Google, and that's it.

What each role sees:

| | Owner / Admin | Member | Guest (client) |
|---|---|---|---|
| Pages | All, including History, Calls and Team | Home, Tasks, Calendar, Daily, Docs, Sheets, Drive, Calls (the ones they're invited to) | Drive, Calendar, Request a call |
| Tasks | Everyone's | Assigned to them, or made by them | None |
| Calendar events | All | The ones they made or are invited to | The ones made for them |
| Routines | Everyone's | Their own | None |
| People | Everyone | Everyone | The team, but not other clients |

## Step 7: Turn on Drive uploads (15 min)

Files uploaded in the **Drive** tab go to a Google Drive folder; the site keeps the list. Inside that folder each space gets its own folder (made with the first upload to it), and folders people make in a space become folders inside that:

```
Teamspace files/          ← the folder you pick below
├── Scinth/
├── Acme Ltd/
│   ├── Contracts/
│   └── Brand/
└── Northwind/
```

Renaming or moving a file in the site does the same in Google Drive, and renaming a space renames its folder (with the next upload or move into it). Until this step is done, uploading says "Drive is not set up yet" (everything else works).

**1. Let the server function into Google Drive.** Pick one:

- **Google Workspace (recommended): a service account and a Shared drive.**
  - [ ] In the Google Cloud project from Step 2: **APIs & Services → Library → Google Drive API → Enable**.
  - [ ] **IAM & Admin → Service accounts → Create service account** (no roles needed). Open it, then **Keys → Add key → JSON**. Keep the downloaded file safe; it is a password.
  - [ ] In Google Drive, make a **Shared drive** (e.g. "Teamspace files"), **Manage members**, and add the service account's email as **Content manager**. (A service account has no storage of its own, so it must be a Shared drive, not "My Drive".)
- **A normal Gmail account: upload as that account.**
  - [ ] Enable the **Google Drive API** as above.
  - [ ] **Credentials → Create credentials → OAuth client ID → Web application**, with authorized redirect URI `https://developers.google.com/oauthplayground`. Copy its client ID and secret.
  - [ ] Open [OAuth Playground](https://developers.google.com/oauthplayground), click the gear, tick **Use your own OAuth credentials**, paste them. Authorize the scope `https://www.googleapis.com/auth/drive` with the Google account that should own the files, then **Exchange authorization code for tokens** and copy the **Refresh token**.
  - [ ] The OAuth consent screen must be **In production** (Step 2's **Publish app**); in "Testing" the token stops working after 7 days.

**2. Pick the folder.** Open the folder (or Shared drive) in Google Drive and copy the ID from the address: `drive.google.com/drive/folders/`**`THIS-PART`**.

**3. Deploy the function and give it the secrets.** On your computer, in this repo:

```sh
npx supabase login
npx supabase link --project-ref <your project ref>      # Project Settings → General
npx supabase functions deploy drive
```

Then in Supabase: **Edge Functions → Secrets** (or `npx supabase secrets set NAME=value`), add:

| Secret | Value |
|---|---|
| `DRIVE_FOLDER_ID` | the folder ID from part 2 |
| `GOOGLE_SERVICE_ACCOUNT` | the whole JSON key file (Workspace option) |
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | from part 1 (Gmail option, instead of the one above) |
| `DRIVE_LINK_SHARING` | optional. `anyone` (default): each file can be opened by anyone with its link, so clients can open it without a Google invite. `folder`: files only open for people the folder is shared with. |
| `DRIVE_MAX_MB` | optional, largest upload in MB (default 20) |

**Already had Drive set up before space folders?** Run `…01_drive_folders` in the SQL Editor and deploy the function again (`npx supabase functions deploy drive`). Files uploaded earlier stay loose in the main folder until the owner or an admin opens **Drive** and clicks **Sort into folders**.

Who can see a file **in the site** is still decided by the database (a client only ever sees their own space's files). `DRIVE_LINK_SHARING` only decides who can open a file's Google Drive link.

---

## When you change the database later

Add a new numbered file in `supabase/migrations` and run it in the Supabase SQL Editor.
Never edit a file that has already been run; add a new one instead.

## Customising

All in [`js/config.js`](js/config.js):

- **Workspace name**
- **Task columns:** rename, recolour, add or remove. Keep the one with id `done`, because that's what counts as "completed".
- **Priorities** and their colours

## Good to know

| | |
|---|---|
| Saving | Usually well under a second. |
| Teammates' changes | Show up instantly. |
| Free plan | 500 MB of data, plenty for a team. A project pauses after a week with no visits; un-pause it in the Supabase dashboard. |
| Doc length | Up to about 1,000,000 characters per doc. |
| Editable sheet embeds | Need the viewer signed in to Google. Safari may block them; "Open in Google Sheets" always works. |
| Backups | Supabase **Database → Backups**, or export any table as CSV from the Table Editor. |

## Something's wrong?

| You see | Fix |
|---|---|
| "You are not on this team yet" | Add their email in **Team & roles**. |
| "Sign-in didn't work: … nonce …" | Turn on **Skip nonce checks** (Step 3). |
| "Sign-in didn't work: … audience …" or "… provider is not enabled" | The Client ID in Supabase (Step 3) must match `googleClientId` in `config.js`, and Google must be enabled. |
| Google button doesn't show | Add your site's address to **Authorized JavaScript origins** (Step 2). |
| "Couldn't reach the server" | Check `supabaseUrl` in `config.js`, and that the project isn't paused in Supabase. |
| "Drive is not set up yet" | Do Step 7: deploy the `drive` function and add its secrets. |
| "Google Drive upload failed (403): Service Accounts do not have storage quota" | The folder must be in a **Shared drive** with the service account as a member, or use the Gmail option. |
| "Google Drive sign-in failed" | Check the secrets: the full JSON key, or the refresh token, client ID and secret. |
