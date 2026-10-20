// Version des Dashboards und Prüfung auf Updates.
//
// Die laufende Version kommt aus version.json (beim Docker-Build erzeugt)
// oder direkt aus dem .git-Verzeichnis (bei `npm start` aus einem Klon).
// Ob es Neues gibt, fragt der Server höchstens einmal pro Stunde bei GitHub.

import fs from 'node:fs';
import path from 'node:path';

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Commit, Branch und Zeitpunkt des letzten Checkouts/Pulls aus einem .git-Verzeichnis (ohne git-Programm). */
export function readGitVersion(root) {
  const git = path.join(root, '.git');
  const head = read(path.join(git, 'HEAD'))?.trim();
  if (!head) return {};
  let commit = head;
  let branch = null;
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (ref) {
    branch = ref.replace(/^refs\/heads\//, '');
    commit = read(path.join(git, ref))?.trim()
      || read(path.join(git, 'packed-refs'))?.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0]
      || null;
  }
  // letzte Zeile des Reflogs: „alt neu Name <mail> Zeitstempel Zone	Aktion“
  const last = read(path.join(git, 'logs', 'HEAD'))?.trim().split('\n').pop();
  const ts = last && /> (\d+) [+-]\d{4}\t/.exec(last)?.[1];
  return { commit, branch, updatedAt: ts ? new Date(Number(ts) * 1000).toISOString() : null };
}

export function createVersion({ root, repo, enabled = true }) {
  const fromFile = (() => {
    try {
      return JSON.parse(read(path.join(root, 'version.json')) || 'null');
    } catch {
      return null;
    }
  })();
  const current = () => (fromFile?.commit ? fromFile : readGitVersion(root));

  let cached = null;
  let checkedAt = 0;
  let pending = null;

  async function github(apiPath) {
    const res = await fetch(`https://api.github.com/repos/${repo}/${apiPath}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'firefly-dashboard' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(res.status === 404 ? 'Repository nicht gefunden oder privat' : `GitHub: HTTP ${res.status}`);
    return res.json();
  }

  async function check() {
    const cur = current();
    const branch = cur.branch || 'main';
    const latest = await github(`commits/${encodeURIComponent(branch)}`);
    const info = {
      latest: { commit: latest.sha, date: latest.commit?.committer?.date, message: latest.commit?.message?.split('\n')[0] },
      behind: 0,
      commits: [],
      // „update“: GitHub ist weiter · „current“: gleich oder lokal neuer · „unknown“: Stand GitHub unbekannt
      status: cur.commit === latest.sha ? 'current' : 'unknown',
    };
    if (cur.commit && cur.commit !== latest.sha) {
      try {
        const cmp = await github(`compare/${cur.commit}...${latest.sha}`);
        info.behind = cmp.ahead_by ?? 0;
        info.status = cmp.status === 'ahead' || cmp.status === 'diverged' ? 'update' : 'current';
        info.commits = (cmp.commits || []).reverse().slice(0, 20)
          .map((c) => ({ commit: c.sha, date: c.commit?.committer?.date, message: c.commit?.message?.split('\n')[0] }));
      } catch {
        info.behind = null; // eigener Stand, den GitHub nicht kennt (z. B. ungepushte Commits)
      }
    }
    return info;
  }

  /** Stand für die Oberfläche; force = sofort neu bei GitHub nachfragen. */
  async function get({ force = false } = {}) {
    const result = { current: current(), repo, enabled };
    if (!enabled || !repo) return result;
    if (force || !cached || Date.now() - checkedAt > 3600_000) {
      pending ||= check()
        .then((info) => (cached = { ...info, error: null }))
        .catch((err) => (cached = { ...(cached || {}), error: err.message }))
        .finally(() => {
          checkedAt = Date.now();
          pending = null;
        });
      await pending;
    }
    return { ...result, ...cached, checkedAt: new Date(checkedAt).toISOString() };
  }

  return { get, current };
}
