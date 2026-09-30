// Customise your workspace here. Everything in this file is safe to commit
// (never put a token in here, each person enters their own in Settings).

export const CONFIG = {
  workspaceName: 'Scinth Team',

  // Where the shared data lives. Leave owner/repo empty to start in
  // "browser only" mode, then fill these in so teammates are pre-configured.
  storage: {
    owner: '',        // GitHub user or org that owns the data repo
    repo: '',         // e.g. 'scinthteamcollab-data' (can be private)
    branch: 'main',
    path: 'data',     // folder inside the repo for the JSON files
  },

  // Task board columns, in order. Rename, add or remove freely.
  // Keep one column with done: true so the app knows what "finished" means.
  statuses: [
    { id: 'todo', label: 'To Do', color: '#8b93a7' },
    { id: 'doing', label: 'In Progress', color: '#3b82f6' },
    { id: 'review', label: 'Review', color: '#a855f7' },
    { id: 'done', label: 'Done', color: '#22c55e', done: true },
  ],

  priorities: [
    { id: 'urgent', label: 'Urgent', color: '#ef4444' },
    { id: 'high', label: 'High', color: '#f97316' },
    { id: 'normal', label: 'Normal', color: '#3b82f6' },
    { id: 'low', label: 'Low', color: '#8b93a7' },
  ],

  // Pre-filled text for the daily update box.
  dailyUpdateTemplate: '**Yesterday:** \n**Today:** \n**Blockers:** ',

  // How often (seconds) to pull teammates' changes while the tab is open.
  refreshSeconds: 60,
};
