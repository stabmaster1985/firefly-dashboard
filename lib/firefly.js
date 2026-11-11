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
//  - alle Antworten liegen zusätzlich auf der Platte (persistDir) und überstehen so
//    Neustarts und Updates: Danach kommt sofort der letzte Stand, erneuert wird im Hintergrund
//  - nach Änderungen in Firefly (invalidate) wird nichts gelöscht: Der Stand gilt als überholt,
//    Aktuelles wird frisch geholt, Älteres sofort gezeigt und im Hintergrund erneuert

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

export function createFirefly({ baseUrl, token, ttl = 60, historyTtl = 12 * 3600, listTtl = 600, concurrency = 4, maxBytes = 256 * 1024 * 1024, persistDir = null, log = console.log }) {
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
    // Diagramme sind in Firefly teuer: notfalls den letzten Stand sofort zeigen und im Hintergrund erneuern
    if (/^chart\//.test(apiPath)) return { ttl, stale: 24 * 3600 };
    // Laufendes: nach kurzer Zeit im Hintergrund erneuern, aber lange vorzeigbar (z. B. nach einem Update)
    return { ttl, stale: 12 * 3600 };
  }

  // Änderungen in Firefly (invalidate): Einträge von davor sind überholt.
  //   all:  Zeitpunkt der letzten Änderung, die alles betreffen kann (Import, Regeln, Abgleich)
  //   meta: letzte Änderungen an einzelnen Buchungen (Kategorie, Tags) – betreffen nur Buchungslisten,
  //         mit bekanntem Datum nur den Monat der Buchung: [{ at, day | null }]
  const dirtyFile = persistDir ? path.join(persistDir, '_geaendert') : null;
  let dirty = { all: 0, meta: [] };
  const isTxPath = (apiPath) => /^(transactions|search\/|accounts\/\d+\/transactions|categories|tags)/.test(apiPath);
  const pad = (n) => String(n).padStart(2, '0');
  const recentFrom = () => {
    const d = new Date();
    d.setDate(d.getDate() - 45);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  /**
   * Ist der Eintrag überholt – und wenn ja, muss auf Frisches gewartet werden?
   * Gewartet wird nur, wo die Änderung sichtbar wäre: beim Monat der geänderten Buchung bzw. (Datum unbekannt
   * oder Import) bei den letzten Wochen und Stammdaten. Alles andere wird gezeigt und im Hintergrund erneuert.
   */
  function staleness(apiPath, params, entry) {
    const q = new URLSearchParams(params);
    const start = q.get('start');
    const end = q.get('end');
    // nach Import/Regeln: frisch abwarten bei den letzten Wochen und den Kontoständen – Übriges (Kategorien-, Tag-Listen,
    // ältere Monate) sofort zeigen und im Hintergrund erneuern
    if (entry.at < dirty.all) return { dirty: true, wait: end ? end >= recentFrom() : /^accounts$/.test(apiPath) };
    if (!isTxPath(apiPath)) return { dirty: false, wait: false };
    let hit = false;
    let wait = false;
    for (const m of dirty.meta) {
      if (entry.at >= m.at) continue;
      if (m.day) {
        if (!start || !end) hit = true; // Liste ohne Zeitraum (Kategorien, Tags, Suche): erneuern, nicht warten
        else if (m.day >= start && m.day <= end) hit = wait = true;
      } else {
        hit = true;
        if (end && end >= recentFrom()) wait = true;
      }
    }
    return { dirty: hit, wait };
  }

  // ---- Platte: je Eintrag eine gz-Datei ----
  const fileOf = (key) => path.join(persistDir, `${crypto.createHash('sha1').update(key).digest('hex')}.json.gz`);
  const persistable = (entry) => persistDir && entry.status === 200;
  function persist(key, entry) {
    // Suchen und einzelne Buchungen nicht – beliebig viele verschiedene, selten wieder gebraucht
    if (!persistable(entry) || /^(search\/|transactions\/\d)/.test(key)) return;
    const data = { key, at: entry.at, ttl: entry.ttl, stale: entry.stale, type: entry.type, body: entry.body.toString('utf8') };
    fs.promises.writeFile(fileOf(key), zlib.gzipSync(JSON.stringify(data), { level: 6 })).catch(() => {});
  }
  function restore() {
    if (!persistDir) return;
    try {
      fs.mkdirSync(persistDir, { recursive: true });
    } catch {
      return;
    }
    try {
      const d = JSON.parse(fs.readFileSync(dirtyFile, 'utf8'));
      dirty = { all: Number(d.all) || 0, meta: Array.isArray(d.meta) ? d.meta.filter((m) => Number(m.at)).slice(-50) : [] };
    } catch {
      // noch nie geändert
    }
    let n = 0;
    for (const f of fs.readdirSync(persistDir).filter((x) => x.endsWith('.json.gz'))) {
      const file = path.join(persistDir, f);
      try {
        const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
        // zu alt (auch als „veraltet“ nicht mehr brauchbar) → weg
        if ((Date.now() - d.at) / 1000 > d.ttl + d.stale) {
          fs.rmSync(file, { force: true });
          continue;
        }
        const body = Buffer.from(d.body, 'utf8');
        store(d.key, { status: 200, body, gz: body.length > 1024 ? zlib.gzipSync(body, { level: 6 }) : null, type: d.type, at: d.at, ttl: d.ttl, stale: d.stale }, false);
        n += 1;
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
    if (n) log(`Zwischenspeicher: ${n} Einträge von der Platte geladen`);
  }

  function store(key, entry, toDisk = true) {
    if (toDisk) persist(key, entry);
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
    const old = hit ? staleness(apiPath, params, hit) : { dirty: false, wait: false };
    if (!fresh && hit && !old.dirty && age < hit.ttl) {
      stats.hits += 1;
      return { ...hit, state: 'HIT' };
    }
    if (!fresh && hit && age < hit.ttl + hit.stale && !old.wait) {
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
    if (hit && !staleness(apiPath, params, hit).dirty && (Date.now() - hit.at) / 1000 < hit.ttl * 0.8) return hit;
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

  /**
   * Nach Änderungen in Firefly: Betroffenes gilt als überholt und wird neu geholt (nichts wird gelöscht).
   * Ohne Angabe: alles (Import, Regeln). { scope: 'meta', day }: nur Buchungslisten – eine einzelne Buchung
   * hat eine andere Kategorie oder andere Tags bekommen (day = ihr Datum, falls bekannt).
   */
  function invalidate({ scope = 'all', day = null } = {}) {
    if (scope === 'meta') dirty.meta = [...dirty.meta, { at: Date.now(), day: /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? day : null }].slice(-50);
    else dirty = { all: Date.now(), meta: [] };
    if (dirtyFile) fs.promises.writeFile(dirtyFile, JSON.stringify(dirty)).catch(() => {});
  }

  restore();

  return { get, warm, summary, invalidate };
}
