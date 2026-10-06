// Customise your workspace here. Everything in this file is safe to commit.

export const CONFIG = {
  workspaceName: 'Scinth Team',

  // From the setup guide (SETUP.md). Leave any of these empty to run in demo mode.
  // The Supabase key is the publishable one: it is meant to be public, and the
  // database's security rules decide what each person can see and change.
  supabaseUrl: 'https://ypnbhhwopxlczmbthicc.supabase.co',
  supabaseKey: 'sb_publishable_ZJfHQL6KwvaLeN49THsUrw_NSWZWTP1',
  googleClientId: '894888753095-aekfkp71trs1it91dsdird8vb903tkp9.apps.googleusercontent.com',  // …apps.googleusercontent.com

  // Task board columns, in order. Rename, recolour, add or remove freely,
  // but keep the one with id 'done': it is what counts as "completed".
  statuses: [
    { id: 'todo', label: 'To Do', color: '#8B8C96' },
    { id: 'doing', label: 'In Progress', color: '#2563EB' },
    { id: 'review', label: 'Review', color: '#B45309' },
    { id: 'done', label: 'Done', color: '#15803D' },
  ],

  priorities: [
    { id: 'urgent', label: 'Urgent', bg: '#FEE2E2', fg: '#991B1B' },
    { id: 'high', label: 'High', bg: '#FFEDD5', fg: '#9A3412' },
    { id: 'normal', label: 'Normal', bg: '#DBEAFE', fg: '#1E3A8A' },
    { id: 'low', label: 'Low', bg: '#ECEDF0', fg: '#3F404A' },
  ],

  // True only on the hosted demo website, where embeds, printing and downloads can't work:
  // embeds show as links and those menu items are hidden.
  demoSite: false,

  // Demo mode only: how often (seconds) to check for changes. The live app
  // hears about teammates' changes instantly.
  pollSeconds: 30,
};

export const DONE = 'done';
// The main space: the team's own work. Every other space is a client space (clients are guests).
export const MAIN_SPACE = 'scinth';
export const isDemo = () => !CONFIG.supabaseUrl || !CONFIG.supabaseKey || !CONFIG.googleClientId;
