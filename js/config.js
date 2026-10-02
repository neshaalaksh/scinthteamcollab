// Customise your workspace here. Everything in this file is safe to commit.

export const CONFIG = {
  workspaceName: 'Scinth Team',

  // From the setup guide (SETUP.md). Leave either empty to run in demo mode.
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbzbP054bRd0GLSTG5ud57ZAxlEEcYKGsnGF2Xpyh-vPkW58Ql53mmdo9Xo379L4051Z/exec',   // https://script.google.com/macros/s/…/exec
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

  // How often (seconds) to check for teammates' changes while the tab is open.
  pollSeconds: 30,
};

export const DONE = 'done';
export const isDemo = () => !CONFIG.appsScriptUrl || !CONFIG.googleClientId;
