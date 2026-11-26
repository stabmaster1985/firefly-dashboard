// Aufräumen, zweiter Teil: Was zeigt noch auf alte (zusammengeführte oder gelöschte) Kategorien, was ist leer?
// Alles frisch bei Firefly gefragt, über alle Jahre; Ergebnisse 10 Minuten zwischengespeichert (?frisch=1 erneuert).
//
//   GET  /local/bezuege?art=stand        je Zusammenführung: Buchungen, die in Firefly noch unter dem alten Namen stehen
//   GET  /local/bezuege?art=regeln       Firefly-Regeln, die eine alte Kategorie setzen (+ eigene Zuordnungen, Labor-Regeln, Import-Plan)
//   GET  /local/bezuege?art=import       hinterlegte Import-Konfiguration: Übersetzungen auf alte Kategorien
//   POST /local/bezuege?art=import       { config } – eine andere Konfigurationsdatei prüfen (wird nicht gespeichert)
//   GET  /local/bezuege?art=leer         Gegenkonten und Tags ohne eine einzige Buchung
//   POST /local/bezuege                  { umbenennen: { alt: neu } } – im Dashboard (Zuordnungen, Labor-Regeln, Import-Plan)
//                                        { geloescht: [{ id, name }] } – gelöschte Kategorien merken
//                                        { vergessen: true } – Zwischenspeicher leeren (nach Änderungen per n8n)

import path from 'node:path';
import { jsonFile } from './store.js';

const PAGE = 250;
const CACHE_MS = 10 * 60_000;
const low = (s) => String(s ?? '').trim().toLowerCase();
const isoDay = (d) => d.toISOString().slice(0, 10);
// Regelgruppen, die das Dashboard selbst schreibt – dort beim nächsten Übertragen aus dem Dashboard überschrieben
const MANAGED = (title) => /^Dashboard:/.test(title || '') || title === 'Firefly Dashboard (Labor)';

export function createRefs({ dataDir, firefly, autocat, log = console.log }) {
  const rulesFile = jsonFile(path.join(dataDir, 'rules.json'), { rev: 0, rules: [], autoTags: ['abo', 'online', 'bargeld'] }, { snapshots: true, log });
  const importPlan = jsonFile(path.join(dataDir, 'cleanup-import.json'), { plan: null, items: {} }, { snapshots: true, log });
  const configFile = jsonFile(path.join(dataDir, 'import-config.json'), { file: '', at: null, config: null }, { snapshots: true, log });
  const cache = new Map();

  async function cached(key, fresh, fn) {
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, stand: new Date(hit.at).toISOString() };
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return { ...value, stand: new Date().toISOString() };
  }
  async function all(kind, query = {}) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const r = await firefly.get(kind, { ...query, limit: PAGE, page }, { fresh: true, priority: 'user' });
      if (r.status !== 200) throw new Error(`Firefly antwortet bei „${kind}“ mit HTTP ${r.status}`);
      const j = JSON.parse(r.body.toString('utf8'));
      out.push(...(j.data || []));
      if (page >= (j.meta?.pagination?.total_pages || 1)) break;
    }
    return out;
  }
  /** Anzahl Buchungen über alle Jahre (null = unklar). */
  async function total(p) {
    const r = await firefly.get(p, { start: '1900-01-01', end: isoDay(new Date()), limit: 1, page: 1 }, { fresh: true, priority: 'user' }).catch(() => null);
    if (!r || r.status !== 200) return null;
    const t = JSON.parse(r.body.toString('utf8'))?.meta?.pagination?.total;
    return Number.isFinite(t) ? t : null;
  }
  async function pool(list, fn, n = 4) {
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (next < list.length) {
        const i = next++;
        await fn(list[i], i);
      }
    }));
  }
  const categories = async () => (await all('categories')).map((x) => ({ id: String(x.id), name: String(x.attributes?.name || '') }));
  /** Wohin gehört eine alte Kategorie heute? Zusammengeführt → Ziel; gelöscht (vom Dashboard) → ggf. dessen Ziel. */
  function targets() {
    const merged = new Map(autocat.merges().map((m) => [low(m.from), m.to]));
    const deleted = new Map(autocat.deletedCategories().map((c) => [low(c.name), c]));
    return { merged, deleted };
  }

  // ---- Stand je Zusammenführung -------------------------------------------------------------
  async function mergeStand() {
    const merges = autocat.merges();
    const cats = new Map((await categories()).map((c) => [low(c.name), c]));
    const out = [];
    await pool(merges, async (m) => {
      const c = cats.get(low(m.from));
      out.push({ von: m.from, nach: m.to, gibtEs: Boolean(c), buchungen: c ? await total(`categories/${c.id}/transactions`) : 0 });
    });
    return { zusammenfuehrungen: out };
  }

  // ---- Firefly-Regeln und Dashboard-Einstellungen, die alte Kategorien setzen --------------------
  async function rulesCheck() {
    const { merged, deleted } = targets();
    const cats = await categories();
    const exists = new Set(cats.map((c) => low(c.name)));
    const rules = await all('rules');
    const funde = [];
    for (const r of rules) {
      const a = r.attributes || {};
      const actions = a.actions || [];
      const hits = [];
      actions.forEach((x, i) => {
        if (x.type !== 'set_category' || !x.value) return;
        const v = low(x.value);
        if (merged.has(v)) hits.push({ index: i, alt: x.value, neu: merged.get(v), grund: 'zusammengeführt' });
        // gelöscht (vom Dashboard gemerkt) und nicht wieder da – andere fehlende Kategorien legt Firefly absichtlich an
        else if (!exists.has(v) && deleted.has(v)) hits.push({ index: i, alt: x.value, neu: '', grund: 'gelöscht' });
      });
      if (hits.length) {
        funde.push({ id: String(r.id), titel: a.title || `Regel ${r.id}`, gruppe: a.rule_group_title || '', aktiv: a.active !== false,
          dashboard: MANAGED(a.rule_group_title), actions: actions.map((x) => ({ type: x.type, value: x.value, order: x.order, active: x.active, stop_processing: x.stop_processing })), funde: hits });
      }
    }
    // im Dashboard: eigene Zuordnungen, Labor-Regeln, Import-Plan (werden beim nächsten Übertragen zu Firefly-Regeln)
    const old = (c) => c && (merged.has(low(c)) || (!exists.has(low(c)) && deleted.has(low(c))));
    const dash = new Map();
    const note = (wo, c) => {
      if (!old(c)) return;
      const k = `${wo}|${low(c)}`;
      const e = dash.get(k) || { wo, alt: c, neu: merged.get(low(c)) || '', n: 0 };
      e.n += 1;
      dash.set(k, e);
    };
    for (const a of Object.values(autocat.assignments() || {})) {
      note('Zuordnungen (Zuordnen)', a.category);
      for (const x of a.split || []) note('Zuordnungen (Zuordnen)', x.category);
    }
    for (const r of rulesFile.read().rules || []) note('Labor-Regeln', r.setCategory);
    for (const it of Object.values(importPlan.read().items || {})) note('Regeln aus der Import-Konfiguration (Aufräumen)', it.category ?? it.suggested?.category);
    return { geprueft: rules.length, regeln: funde, dashboard: [...dash.values()] };
  }

  // ---- Import-Konfiguration (Data Importer): Übersetzungen Wert → Kategorie-ID ---------------------
  async function importCheck(cfg) {
    if (!cfg || !Array.isArray(cfg.roles)) return { config: false };
    const { merged, deleted } = targets();
    const cats = await categories();
    const byId = new Map(cats.map((c) => [c.id, c]));
    const byName = new Map(cats.map((c) => [low(c.name), c]));
    const deletedById = new Map(autocat.deletedCategories().filter((c) => c.id).map((c) => [String(c.id), c]));
    const groups = new Map();
    cfg.roles.forEach((role, col) => {
      if (role !== 'category-name' && role !== 'category-id') return;
      for (const [wert, id] of Object.entries(cfg.mapping?.[col] || {})) {
        const sid = String(id);
        const c = byId.get(sid);
        let alt = null;
        let grund = '';
        if (c && merged.has(low(c.name))) {
          alt = c.name;
          grund = 'zusammengeführt';
        } else if (!c) {
          alt = deletedById.get(sid)?.name || null;
          grund = alt ? 'gelöscht' : 'unbekannte ID';
        }
        if (!grund) continue;
        const k = `${sid}`;
        const neuName = alt ? merged.get(low(alt)) || '' : '';
        const g = groups.get(k) || { id: sid, alt, grund, neu: neuName, neuId: neuName ? byName.get(low(neuName))?.id || null : null, werte: [] };
        g.werte.push(wert);
        groups.set(k, g);
      }
    });
    return { config: true, kategorien: cats, funde: [...groups.values()].sort((a, b) => b.werte.length - a.werte.length), geloeschtBekannt: deleted.size };
  }

  // ---- Leere Gegenkonten und Tags -----------------------------------------------------------
  async function emptyAccountsTags() {
    const accounts = [...(await all('accounts', { type: 'expense' })), ...(await all('accounts', { type: 'revenue' }))]
      .map((x) => ({ id: String(x.id), name: String(x.attributes?.name || ''), art: x.attributes?.type === 'revenue' ? 'Einnahmen' : 'Ausgaben' }));
    const tags = (await all('tags')).map((x) => ({ id: String(x.id), name: String(x.attributes?.tag || '') }));
    const konten = [];
    const leereTags = [];
    await pool(accounts, async (a) => {
      if ((await total(`accounts/${a.id}/transactions`)) === 0) konten.push(a);
    }, 6);
    await pool(tags, async (t) => {
      if ((await total(`tags/${t.id}/transactions`)) === 0) leereTags.push(t);
    }, 6);
    const by = (a, b) => a.name.localeCompare(b.name, 'de');
    return { gepruefteKonten: accounts.length, gepruefteTags: tags.length, konten: konten.sort(by), tags: leereTags.sort(by) };
  }

  // ---- Im Dashboard umbenennen ----------------------------------------------------------------
  function rename(map) {
    const m = new Map(Object.entries(map || {}).map(([a, b]) => [low(a), String(b || '').trim().slice(0, 80)]).filter(([a, b]) => a && b));
    let n = autocat.renameCategories(Object.fromEntries(m));
    const rules = rulesFile.read();
    let changed = false;
    const next = (rules.rules || []).map((r) => {
      const to = r.setCategory && m.get(low(r.setCategory));
      if (!to) return r;
      changed = true;
      n += 1;
      return { ...r, setCategory: to };
    });
    if (changed) rulesFile.write({ ...rules, rev: Number(rules.rev || 0) + 1, rules: next });
    const plan = importPlan.read();
    let planChanged = false;
    for (const it of Object.values(plan.items || {})) {
      const to = it.category && m.get(low(it.category));
      if (to) {
        it.category = to;
        planChanged = true;
        n += 1;
      }
    }
    if (planChanged) importPlan.write(plan);
    cache.clear();
    return n;
  }

  return async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    const fresh = url.searchParams.get('frisch') === '1';
    const art = url.searchParams.get('art');
    try {
      if (req.method === 'GET') {
        if (art === 'stand') return json(200, await cached('stand', fresh, mergeStand));
        if (art === 'regeln') return json(200, await cached('regeln', fresh, rulesCheck));
        if (art === 'leer') return json(200, await cached('leer', fresh, emptyAccountsTags));
        if (art === 'import') {
          const stored = configFile.read();
          return json(200, { datei: stored.file || '', hinterlegt: stored.at, ...(await importCheck(stored.config)) });
        }
        return json(400, { message: 'art fehlt' });
      }
      if (req.method !== 'POST') return json(405, { message: 'Nicht erlaubt.' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (art === 'import') return json(200, await importCheck(input.config));
      if (input.umbenennen) return json(200, { ok: true, geaendert: rename(input.umbenennen) });
      if (input.geloescht) {
        autocat.noteDeleted(input.geloescht);
        cache.clear();
        return json(200, { ok: true });
      }
      if (input.vergessen) {
        cache.clear();
        return json(200, { ok: true });
      }
      return json(400, { message: 'Unbekannte Anfrage.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}
