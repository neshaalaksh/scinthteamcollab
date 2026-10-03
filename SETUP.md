# Going live: setup checklist

About 20 minutes, one time. You need a Google account, a Supabase account and this GitHub repo.

Until you finish, the site runs in **demo mode**: fake data that stays in your own browser, and you can switch between the roles to try them.

> **Already done for Scinth Team:** Steps 1 to 4 are set up (Supabase project `scinth-teamspace`,
> Owner `neshaa@scinth.co`). Keep this guide for reference or for setting up another workspace.

---

## Step 1: Make the database (5 min)

- [ ] At [supabase.com/dashboard](https://supabase.com/dashboard), click **New project**. Pick the region closest to your team.
- [ ] Open **SQL Editor**. Paste and run each file in [`supabase/migrations`](supabase/migrations), in order (`…01_tables`, `…02_security`, `…03_triggers`, `…04_rpc`).
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

## Step 6: Add your team

- [ ] Open the site and sign in with Google. You're the Owner.
- [ ] Go to **Team & roles → Manage spaces** and create your spaces (e.g. Ops, Marketing, Client A).
- [ ] Go to **Team & roles → + Add person** for each teammate: their Google email, role, and spaces.
- [ ] Send them the link. They sign in with Google, and that's it.

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
