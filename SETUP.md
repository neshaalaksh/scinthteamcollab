# Going live: setup checklist

About 20 minutes, one time. You need your Google account and this GitHub repo.

Until you finish, the site runs in **demo mode**: fake data that stays in your own browser, and you can switch between the roles to try them.

---

## Step 1: Make the database sheet (3 min)

- [ ] Go to [sheets.new](https://sheets.new) and name the sheet **Teamspace DB**.
- [ ] Click **Extensions → Apps Script**.
- [ ] Delete the code that's there. Paste in everything from [`backend/Code.gs`](backend/Code.gs).
- [ ] Click **Save** (the disk icon).
- [ ] In the function dropdown at the top, pick **setup**, then press **Run**.
  - Google asks for permission. Click through: **Advanced → Go to project → Allow**.
  - The sheet now has tabs: Team, Spaces, Tasks, Routines, and the rest.

## Step 2: Make the Google sign-in key (7 min)

- [ ] Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project called **Teamspace**.
- [ ] Open **APIs & Services → OAuth consent screen**.
  - If your team uses Google Workspace: pick **Internal**.
  - If you use personal Gmail accounts: pick **External**, then **Publish app**. This only asks for name and email, so Google doesn't need to review it.
- [ ] Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
  - Application type: **Web application**
  - Authorized JavaScript origins: add `https://neshaalaksh.github.io`
    (also add `http://localhost:8000` if you want to test on your computer)
- [ ] Copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

## Step 3: Connect the sheet to sign-in (3 min)

Back in Apps Script:

- [ ] Click **Project Settings** (gear icon) → **Script Properties** → **Add script property**:

  | Property | Value |
  |---|---|
  | `CLIENT_ID` | the Client ID from Step 2 |
  | `OWNER_EMAIL` | your Google email (you become the Owner) |

- [ ] Click **Deploy → New deployment**, then the gear icon → **Web app**:
  - Execute as: **Me**
  - Who has access: **Anyone**
    (The app still checks every request: only people on your Team tab get in.)
- [ ] Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

## Step 4: Point the website at it (2 min)

- [ ] In this repo, open [`js/config.js`](js/config.js) and fill in:

  ```js
  appsScriptUrl: 'https://script.google.com/macros/s/…/exec',
  googleClientId: '….apps.googleusercontent.com',
  ```

- [ ] Commit the change.

## Step 5: Turn on GitHub Pages (2 min)

- [ ] In the repo on GitHub: **Settings → Pages**.
- [ ] Source: **Deploy from a branch** → branch **main**, folder **/ (root)** → **Save**.
- [ ] After about a minute your site is at `https://neshaalaksh.github.io/scinthteamcollab/`.

> GitHub Pages is free for **public** repos. A private repo needs a paid GitHub plan.
> Your data is safe either way: it lives in your Google Sheet, not in the repo.

## Step 6: Add your team

- [ ] Open the site and sign in with Google. You're the Owner.
- [ ] Go to **Team & roles → Manage spaces** and create your spaces (e.g. Ops, Marketing, Client A).
- [ ] Go to **Team & roles → + Add person** for each teammate: their Google email, role, and spaces.
- [ ] Send them the link. They sign in with Google, and that's it.

---

## When you change the backend later

If `backend/Code.gs` changes, paste the new version into Apps Script, then
**Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**.
The URL stays the same.

## Customising

All in [`js/config.js`](js/config.js):

- **Workspace name**
- **Task columns:** rename, recolour, add or remove. Keep the one with id `done`, because that's what counts as "completed".
- **Priorities** and their colours
- **How often** the app checks for teammates' changes (default every 30 seconds)

## Good to know

| | |
|---|---|
| Saving | Takes 1 to 2 seconds. The screen updates right away. |
| Teammates' changes | Show up within about 30 seconds. |
| Team size | Works well for up to about 20 people. |
| Doc length | Up to about 245,000 characters per doc. |
| Editable sheet embeds | Need the viewer signed in to Google. Safari may block them; "Open in Google Sheets" always works. |
| Backups | Your data is a normal Google Sheet. **File → Make a copy** any time. |

## Something's wrong?

| You see | Fix |
|---|---|
| "You are not on this team yet" | Add their email in **Team & roles**. The Owner email comes from `OWNER_EMAIL`. |
| "This sign-in was made for a different app" | `CLIENT_ID` in Script Properties doesn't match `googleClientId` in `config.js`. |
| Google button doesn't show | Add your site's address to **Authorized JavaScript origins** (Step 2). |
| "Couldn't reach the server" | Check `appsScriptUrl`. It must end in `/exec`, and the deployment must be set to **Anyone**. |
