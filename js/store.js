// Data layer. Each "collection" is one JSON file. In GitHub mode the files
// live in a repo and are read/written through the GitHub contents API; in
// local mode they live in this browser's localStorage.
//
// Writes are done as "mutations": fetch the latest file, apply a change
// function to it, and save with the file's sha. If a teammate saved in the
// meantime GitHub rejects the stale sha, so we re-fetch and re-apply.

import { CONFIG } from './config.js';

const SETTINGS_KEY = 'teamspace.settings';
const DATA_PREFIX = 'teamspace.data.';

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export function loadSettings() {
  const defaults = {
    ...CONFIG.storage,
    mode: CONFIG.storage.owner && CONFIG.storage.repo ? 'github' : 'local',
    token: '',
    localName: 'me',
  };
  try {
    return { ...defaults, ...JSON.parse(lsGet(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  lsSet(SETTINGS_KEY, JSON.stringify(settings));
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

class ConflictError extends Error {}

class LocalBackend {
  label = 'Browser only';
  async read(name) {
    const raw = lsGet(DATA_PREFIX + name);
    return { data: raw ? JSON.parse(raw) : null, sha: null };
  }
  async write(name, data) {
    lsSet(DATA_PREFIX + name, JSON.stringify(data));
    return { sha: null };
  }
  async list() {
    const names = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(DATA_PREFIX)) names.push(k.slice(DATA_PREFIX.length));
      }
    } catch { /* storage unavailable */ }
    return names;
  }
  async whoami(settings) {
    return { login: settings.localName || 'me', name: settings.localName || 'me' };
  }
}

class GitHubBackend {
  constructor({ owner, repo, branch, path, token }) {
    Object.assign(this, { owner, repo, branch, path, token });
    this.label = `${owner}/${repo}`;
  }

  headers(accept = 'application/vnd.github+json') {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  fileUrl(name) {
    const parts = [this.path, `${name}.json`].filter(Boolean).join('/');
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${parts}`;
  }

  async read(name) {
    const url = `${this.fileUrl(name)}?ref=${encodeURIComponent(this.branch)}`;
    const res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error(await describeError(res));
    const json = await res.json();
    let text;
    if (json.content) {
      text = b64decode(json.content);
    } else {
      // Files over 1MB come back without inline content.
      const raw = await fetch(url, { headers: this.headers('application/vnd.github.raw+json'), cache: 'no-store' });
      if (!raw.ok) throw new Error(await describeError(raw));
      text = await raw.text();
    }
    return { data: text.trim() ? JSON.parse(text) : null, sha: json.sha };
  }

  async write(name, data, sha, message) {
    const body = {
      message,
      content: b64encode(JSON.stringify(data, null, 2) + '\n'),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.fileUrl(name), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) throw new ConflictError(await describeError(res));
    if (!res.ok) throw new Error(await describeError(res));
    const json = await res.json();
    return { sha: json.content.sha };
  }

  async list() {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.path}?ref=${encodeURIComponent(this.branch)}`;
    const res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(await describeError(res));
    return (await res.json())
      .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
      .map((f) => f.name.slice(0, -5));
  }

  async whoami() {
    const res = await fetch('https://api.github.com/user', { headers: this.headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(await describeError(res));
    const u = await res.json();
    return { login: u.login, name: u.name || u.login };
  }

  async checkRepo() {
    const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await describeError(res));
    const repo = await res.json();
    if (repo.permissions && !repo.permissions.push) {
      throw new Error('Your token can read this repo but cannot write to it.');
    }
    return repo;
  }
}

async function describeError(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* not json */ }
  const hints = {
    401: 'Token is invalid or expired.',
    403: 'Token lacks permission (needs Contents: read & write) or rate limited.',
    404: 'Repo not found, or the token has no access to it.',
  };
  return `GitHub ${res.status}: ${hints[res.status] || detail || res.statusText}`;
}

const listeners = new Set();

export const store = {
  settings: loadSettings(),
  backend: null,
  cache: new Map(), // name -> { data, sha }
  me: null,
  pending: 0,

  init() {
    const s = this.settings;
    this.backend = s.mode === 'github' && s.owner && s.repo && s.token
      ? new GitHubBackend(s)
      : new LocalBackend();
    this.cache.clear();
    this.me = null;
  },

  isShared() {
    return this.backend instanceof GitHubBackend;
  },

  makeBackend(settings) {
    return new GitHubBackend(settings);
  },

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  emit(event) {
    listeners.forEach((fn) => fn(event));
  },

  async whoami() {
    if (!this.me) this.me = await this.backend.whoami(this.settings);
    return this.me;
  },

  // Returns cached data, loading it on first use.
  async get(name, fallback) {
    if (!this.cache.has(name)) await this.refresh(name);
    const entry = this.cache.get(name);
    return entry.data ?? structuredClone(fallback);
  },

  // Re-reads a file; returns true if it changed.
  async refresh(name) {
    const fresh = await this.backend.read(name);
    const old = this.cache.get(name);
    this.cache.set(name, fresh);
    return !old || JSON.stringify(old.data) !== JSON.stringify(fresh.data);
  },

  async refreshAll() {
    const names = [...this.cache.keys()];
    const results = await Promise.all(names.map((n) => this.refresh(n)));
    return names.filter((_, i) => results[i]);
  },

  async mutate(name, fallback, change, message) {
    this.pending++;
    this.emit({ type: 'saving' });
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, sha } = await this.backend.read(name);
        const current = data ?? structuredClone(fallback);
        const next = change(current) ?? current;
        try {
          const who = (await this.whoami()).login;
          const res = await this.backend.write(name, next, sha, `${message} (by ${who})`);
          this.cache.set(name, { data: next, sha: res.sha });
          this.emit({ type: 'saved', name });
          return next;
        } catch (err) {
          if (!(err instanceof ConflictError) || attempt === 4) throw err;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    } catch (err) {
      this.emit({ type: 'error', error: err });
      throw err;
    } finally {
      this.pending--;
      this.emit({ type: 'idle' });
    }
  },

  // Export / import everything, handy for moving from browser mode to GitHub.
  async exportAll() {
    const out = {};
    for (const n of await this.backend.list()) out[n] = (await this.backend.read(n)).data;
    return out;
  },

  async importAll(dump) {
    for (const [name, data] of Object.entries(dump)) {
      if (data == null) continue;
      await this.mutate(name, null, () => data, `import ${name}`);
    }
  },
};
