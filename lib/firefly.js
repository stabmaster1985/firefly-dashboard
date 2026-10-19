// Zugriff auf die Firefly-III-API mit Zwischenspeicher.
//
// Firefly (PHP) braucht pro Abfrage spürbar Zeit und verarbeitet nur wenige
// gleichzeitig. Darum:
//  - abgeschlossene Zeiträume ändern sich praktisch nicht → lange gültig
//  - abgelaufene Einträge werden sofort ausgeliefert und im Hintergrund
//    erneuert (stale-while-revalidate)
//  - gleiche Anfragen, die gleichzeitig eintreffen, laufen nur einmal
//  - höchstens N Anfragen gleichzeitig an Firefly; Seitenaufrufe vor Vorwärmen
//  - Antworten werden einmal komprimiert und so mehrfach ausgeliefert

import zlib from 'node:zlib';

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Parameter sortieren, damit gleiche Abfragen denselben Schlüssel haben. */
export function cacheKey(apiPath, params) {
  const entries = [...new URLSearchParams(params)].sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(entries).toString();
  return qs ? `${apiPath}?${qs}` : apiPath;
}

export function createFirefly({ baseUrl, token, ttl = 60, historyTtl = 12 * 3600, listTtl = 600, concurrency = 4, maxBytes = 256 * 1024 * 1024 }) {
  const cache = new Map(); // key → { status, body, gz, type, at, ttl, stale }
  const inflight = new Map();
  let bytes = 0;
  const stats = { upstream: 0, upstreamMs: 0, recent: [], hits: 0, stale: 0, misses: 0, errors: 0 };

  // Einfache Warteschlange mit zwei Prioritäten
  const queues = { user: [], warm: [] };
  let running = 0;
  const pump = () => {
    while (running < concurrency && (queues.user.length || queues.warm.length)) {
      const job = queues.user.shift() || queues.warm.shift();
      running += 1;
      job.run().finally(() => {
        running -= 1;
        pump();
      });
    }
  };
  const schedule = (key, fn, priority) =>
    new Promise((resolve, reject) => {
      queues[priority].push({ key, run: () => fn().then(resolve, reject) });
      pump();
    });
  /** Wartet eine Seite auf einen Vorwärm-Auftrag, rückt er nach vorne. */
  const promote = (key) => {
    const i = queues.warm.findIndex((j) => j.key === key);
    if (i >= 0) queues.user.push(...queues.warm.splice(i, 1));
  };

  /** Gültigkeit: Vergangenheit lange, Stammdaten mittel, Laufendes kurz. */
  function policy(apiPath, params) {
    const end = new URLSearchParams(params).get('end');
    if (end && end < today() && !/^accounts\/\d+$/.test(apiPath)) return { ttl: historyTtl, stale: 7 * 24 * 3600 };
    if (/^(categories|tags|about|currencies)/.test(apiPath) && !/transactions$/.test(apiPath)) return { ttl: listTtl, stale: 24 * 3600 };
    return { ttl, stale: 30 * 60 };
  }

  function store(key, entry) {
    const old = cache.get(key);
    if (old) {
      bytes -= old.body.length + (old.gz?.length || 0);
      cache.delete(key);
    }
    cache.set(key, entry);
    bytes += entry.body.length + (entry.gz?.length || 0);
    // Älteste Einträge verwerfen, wenn der Speicher voll ist
    for (const [k, v] of cache) {
      if (bytes <= maxBytes) break;
      bytes -= v.body.length + (v.gz?.length || 0);
      cache.delete(k);
    }
  }

  async function fetchUpstream(apiPath, params, priority) {
    const key = cacheKey(apiPath, params);
    if (inflight.has(key)) {
      if (priority === 'user') promote(key);
      return inflight.get(key);
    }
    const job = schedule(key, async () => {
      const started = Date.now();
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`${baseUrl}/api/v1/${apiPath}${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json, application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      const ms = Date.now() - started;
      stats.upstream += 1;
      stats.upstreamMs += ms;
      stats.recent.push({ path: apiPath, ms });
      if (stats.recent.length > 100) stats.recent.shift();
      const entry = {
        status: res.status,
        body,
        gz: body.length > 1024 ? zlib.gzipSync(body, { level: 6 }) : null,
        type: res.headers.get('content-type') || 'application/json',
        at: Date.now(),
        ...policy(apiPath, params),
      };
      if (res.ok) store(key, entry);
      return entry;
    }, priority).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  /**
   * Liefert eine Antwort – aus dem Speicher, wenn möglich.
   * fresh: Speicher umgehen („Neu laden“), priority: 'user' | 'warm'.
   */
  async function get(apiPath, params, { fresh = false, priority = 'user' } = {}) {
    const key = cacheKey(apiPath, params);
    const hit = cache.get(key);
    const age = hit ? (Date.now() - hit.at) / 1000 : Infinity;
    if (!fresh && hit && age < hit.ttl) {
      stats.hits += 1;
      return { ...hit, state: 'HIT' };
    }
    if (!fresh && hit && age < hit.ttl + hit.stale) {
      stats.stale += 1;
      fetchUpstream(apiPath, params, 'warm').catch(() => {});
      return { ...hit, state: 'STALE' };
    }
    stats.misses += 1;
    try {
      return { ...(await fetchUpstream(apiPath, params, priority)), state: 'MISS' };
    } catch (err) {
      stats.errors += 1;
      if (hit) return { ...hit, state: 'STALE' }; // lieber alt als gar nicht
      throw err;
    }
  }

  /** Für die Vorwärmung: nur laden, wenn der Eintrag fehlt oder bald abläuft. */
  async function warm(apiPath, params) {
    const hit = cache.get(cacheKey(apiPath, params));
    if (hit && (Date.now() - hit.at) / 1000 < hit.ttl * 0.8) return hit;
    return fetchUpstream(apiPath, params, 'warm');
  }

  function summary() {
    const recent = stats.recent.map((r) => r.ms).sort((a, b) => a - b);
    const served = stats.hits + stats.stale + stats.misses;
    return {
      upstream: {
        requests: stats.upstream,
        avgMs: stats.upstream ? Math.round(stats.upstreamMs / stats.upstream) : null,
        medianMs: recent.length ? recent[Math.floor(recent.length / 2)] : null,
        slowest: [...stats.recent].sort((a, b) => b.ms - a.ms).slice(0, 5),
        queued: queues.user.length + queues.warm.length,
        running,
        errors: stats.errors,
      },
      cache: {
        entries: cache.size,
        megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10,
        hitRate: served ? Math.round(((stats.hits + stats.stale) / served) * 100) : null,
        hits: stats.hits,
        stale: stats.stale,
        misses: stats.misses,
      },
    };
  }

  return { get, warm, summary };
}
