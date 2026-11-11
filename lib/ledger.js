// Monatsbuch: Der Server lädt die Ein- und Ausgänge je Kalendermonat einmal aus Firefly und
// beantwortet daraus selbst, wofür die Oberfläche sonst Firefly einzeln fragen müsste:
//
//   - Summen (insight/expense|income/total|category|no-category|tag) für beliebige Zeiträume
//   - Buchungslisten (transactions?type=withdrawal|deposit|transfer|all&start&end) für beliebige Zeiträume
//     („all“ = Ausgaben, Einnahmen und Umbuchungen; Anfangssalden und Abstimmungen zeigt nur Firefly)
//
// Firefly braucht pro Abfrage spürbar Zeit (oft Sekunden) – so kostet ein Monat zwei Abfragen
// statt gut zwanzig, und jeder Zeitraum (Gehaltsmonat, Vorjahr, eigener) ist sofort da, sobald
// seine Monate geladen sind. Dabei werden ausgeblendete Buchungen herausgenommen (lib/excluded.js)
// und Buchungen ohne Kategorie automatisch eingeordnet (lib/autocat.js). Firefly bleibt unverändert.
//
// Alles andere geht wie bisher an Firefly; Listen von dort werden genauso nachbearbeitet.
// Mit „alle“ (X-FFD-Alle: 1) kommen Listen roh: vollständig, Ausgeblendetes nur markiert,
// Kategorien wie in Firefly – für Labor, Abgleich und Pflege. „alle + auto“ (X-FFD-Alle: auto)
// ist dasselbe mit automatischen Kategorien – für die Buchungsliste.
//
//   GET  /local/autocat      Abdeckung, offene und automatisch zugeordnete Händler, Einstellungen
//   GET  /local/autocat?haendler=…  die Buchungen eines Händlers (24 Monate, neueste zuerst)
//   POST /local/autocat      { key, name, category } Händler zuordnen (category null = entfernen)
//                            { journal, category } eine einzelne Buchung zuordnen (category null = entfernen)
//   PUT  /local/autocat      { enabled, learn, list, ai, aiMin }
//   GET  /local/ledger       Stand und Selbstprüfung (Summen gegen Firefly); ?pruefen=1 prüft neu

import zlib from 'node:zlib';
import { merchantOf } from '../public/js/rules.js';
import { QUELLEN } from './autocat.js';

const PAGE = 250; // wie public/js/api.js und lib/warmer.js (gleiche Cache-Einträge)
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const FUTURE = 'zukunft'; // alles nach dem laufenden Monat: ein gemeinsamer Abschnitt (meist leer) statt vieler Monate
const monthRange = (ym) => {
  if (ym === FUTURE) {
    const t = new Date();
    return [isoDay(new Date(t.getFullYear(), t.getMonth() + 1, 1)), isoDay(new Date(t.getFullYear() + 3, t.getMonth() + 1, 0))];
  }
  const [y, m] = ym.split('-').map(Number);
  return [`${ym}-01`, `${ym}-${pad(new Date(y, m, 0).getDate())}`];
};
/** „2026-09-24“ … „2026-11-05“ → ['2026-09', '2026-10', '2026-11']; Monate nach dem laufenden zusammen als „zukunft“ */
function monthsBetween(start, end) {
  const out = [];
  let [y, m] = start.slice(0, 7).split('-').map(Number);
  const last = end.slice(0, 7);
  const now = isoDay(new Date()).slice(0, 7);
  for (let i = 0; i < 600; i++) {
    const ym = `${y}-${pad(m)}`;
    if (ym > last) break;
    if (ym > now) {
      out.push(FUTURE);
      break;
    }
    out.push(ym);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
const round = (n) => Math.round(n * 100) / 100;
const lower = (s) => String(s ?? '').toLowerCase();
const TX_LIST = /^(transactions|search\/transactions|accounts\/\d+\/transactions|categories\/\d+\/transactions|tags\/[^/]+\/transactions)$/;
const INSIGHT = /^insight\/(expense|income)\/(total|category|no-category|tag)$/;
const TYPES = ['withdrawal', 'deposit']; // Ein- und Ausgänge: ausblendbar, automatisch kategorisierbar
const LOADED = [...TYPES, 'transfer']; // je Monat geladen
const typesOf = (type) => (type === 'all' ? LOADED : LOADED.includes(type) ? [type] : null);

export function createLedger({ firefly, excluded, autocat, enabled = true, log = console.log }) {
  // ---- Monate ------------------------------------------------------------------------
  const months = new Map(); // „2026-10|withdrawal“ → { ats, groups: [{ g, day, splits }], loadedAt }
  const loading = new Map();
  let monthsRev = 0; // zählt jede inhaltliche Änderung an den geladenen Monaten

  async function loadMonth(ym, type, opts = {}) {
    const key = `${ym}|${type}`;
    const cur = months.get(key);
    // „Neu laden“ schickt jede Anfrage frisch – denselben Monat aber nur einmal je halbe Minute neu holen
    const fresh = Boolean(opts.fresh) && !(cur && Date.now() - cur.loadedAt < 30_000);
    const flight = `${key}|${fresh}`;
    if (loading.has(flight)) return loading.get(flight);
    const job = (async () => {
      const [start, end] = monthRange(ym);
      const get = async (page) => {
        const r = await firefly.get('transactions', { start, end, type, limit: PAGE, page }, { fresh, priority: opts.priority || 'user' });
        if (r.status !== 200) throw new Error(`Firefly-Buchungen (${ym}): HTTP ${r.status}`);
        return r;
      };
      const first = await get(1);
      let firstJson = null;
      let pages = cur && cur.ats[0] === first.at ? cur.ats.length : null;
      if (pages === null) {
        firstJson = JSON.parse(first.body.toString('utf8'));
        pages = firstJson.meta?.pagination?.total_pages || 1;
      }
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get(i + 2)));
      const ats = [first.at, ...rest.map((r) => r.at)];
      if (cur && cur.ats.length === ats.length && cur.ats.every((a, i) => a === ats[i])) {
        if (fresh) cur.loadedAt = Date.now();
        return cur;
      }
      const jsons = [firstJson || JSON.parse(first.body.toString('utf8')), ...rest.map((r) => JSON.parse(r.body.toString('utf8')))];
      const groups = jsons.flatMap((j) => j.data || []).map((g) => {
        const splits = (g.attributes?.transactions || []).filter((t) => t.type === type);
        return { g, splits, date: String(splits[0]?.date || '') };
      }).filter((x) => x.splits.length);
      const entry = { ats, groups, loadedAt: Date.now() };
      months.set(key, entry);
      monthsRev += 1;
      return entry;
    })().finally(() => loading.delete(flight));
    loading.set(flight, job);
    return job;
  }

  // ---- Stammdaten: Kategorien und Tags aus Firefly (Namen ↔ IDs) ---------------------------
  const master = { categories: { sig: '', rev: 0, list: [], byLower: new Map() }, tags: { sig: '', rev: 0, list: [], byLower: new Map() } };
  async function loadMaster(kind, opts = {}) {
    const m = master[kind];
    const get = (page) => firefly.get(kind, { limit: PAGE, page }, { priority: opts.priority || 'user' });
    const first = await get(1);
    if (first.status !== 200) return m; // ohne Stammdaten geht es weiter (nur IDs fehlen dann)
    let pages = 1;
    let jsons = null;
    if (!m.sig.startsWith(`${first.at},`) && m.sig !== String(first.at)) {
      jsons = [JSON.parse(first.body.toString('utf8'))];
      pages = jsons[0].meta?.pagination?.total_pages || 1;
    } else pages = m.sig.split(',').length;
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get(i + 2)));
    const sig = [first.at, ...rest.map((r) => r.at)].join(',');
    if (sig === m.sig) return m;
    jsons ||= [JSON.parse(first.body.toString('utf8'))];
    jsons.push(...rest.filter((r) => r.status === 200).map((r) => JSON.parse(r.body.toString('utf8'))));
    const list = jsons.flatMap((j) => j.data || []).map((x) => ({ id: String(x.id), name: String(x.attributes?.name ?? x.attributes?.tag ?? '') })).filter((x) => x.name);
    Object.assign(m, { sig, rev: m.rev + 1, list, byLower: new Map(list.map((x) => [lower(x.name), x])) });
    return m;
  }

  // ---- Gelernt: Händler, der sonst eindeutig kategorisiert ist --------------------------------
  let learned = { rev: -1, sig: '', v: 0, map: new Map() };
  function ensureLearned() {
    if (learned.rev === monthsRev) return learned.map;
    const counts = new Map(); // Händler → Map(Kategorie → Anzahl)
    for (const [key, m] of months) {
      if (!key.endsWith('|withdrawal')) continue;
      for (const { splits } of m.groups) {
        for (const t of splits) {
          if (!t.category_name) continue;
          const k = merchantOf(t).key;
          if (!k || k.length < 2 || k === 'text:') continue;
          if (!counts.has(k)) counts.set(k, new Map());
          counts.get(k).set(t.category_name, (counts.get(k).get(t.category_name) || 0) + 1);
        }
      }
    }
    const map = new Map();
    for (const [k, cats] of counts) {
      const total = [...cats.values()].reduce((a, n) => a + n, 0);
      const [top, n] = [...cats].sort((a, b) => b[1] - a[1])[0];
      if (n >= 2 && n / total >= 0.6) map.set(k, top);
    }
    const sig = JSON.stringify([...map].sort());
    learned = { rev: monthsRev, sig, v: sig === learned.sig ? learned.v : learned.v + 1, map };
    return map;
  }

  // ---- Wirksame Einordnung einer Buchung ----------------------------------------------------
  const version = () => `${excluded.version()}|${autocat.version()}|${learned.v}|${master.categories.rev}`;
  const effMemo = new WeakMap();
  /** { ex: ausgeblendet?, cat: { id, name, quelle? } | null } – quelle nur bei automatischer Kategorie. */
  function eff(t, v) {
    const hit = effMemo.get(t);
    if (hit && hit.v === v) return hit;
    let cat = null;
    if (t.category_id || t.category_name) cat = { id: String(t.category_id), name: t.category_name };
    else {
      const auto = autocat.categorize(t, { learned: learned.map, known: master.categories.list.map((c) => c.name), categoryById: (id) => master.categories.list.find((c) => c.id === id)?.name });
      if (auto) {
        const own = master.categories.byLower.get(lower(auto.name));
        cat = { id: own ? own.id : `auto:${auto.name}`, name: own ? own.name : auto.name, quelle: auto.quelle };
      }
    }
    // zusammengeführte Kategorien (Seite „Aufräumen“): unter dem Zielnamen auswerten
    const to = cat ? autocat.mergedName(cat.name) : null;
    if (to) {
      const own = master.categories.byLower.get(lower(to));
      cat = { id: own ? own.id : `auto:${to}`, name: own ? own.name : to, quelle: cat.quelle, merged: true };
    }
    const e = { v, ex: excluded.isExcluded(t), cat };
    effMemo.set(t, e);
    return e;
  }
  /** Buchung so, wie die Auswertungen sie sehen (automatische Kategorie eingetragen) bzw. roh mit Markierung. */
  function shown(t, e, alle, auto = !alle) {
    const base = alle && e.ex ? { ...t, ffd_ausgeblendet: true } : t;
    if (!auto || !(e.cat?.quelle || e.cat?.merged)) return base;
    return { ...base, category_id: e.cat.id, category_name: e.cat.name, ...(e.cat.quelle ? { ffd_auto: e.cat.quelle } : {}), ...(e.cat.merged ? { ffd_merged: t.category_name || true } : {}) };
  }

  async function prepare(start, end, types, opts) {
    await Promise.all([loadMaster('categories', opts), ...monthsBetween(start, end).flatMap((ym) => types.map((type) => loadMonth(ym, type, opts)))]);
    ensureLearned();
  }
  /** Alle geladenen Buchungen einer Art im Zeitraum. */
  function* splitsIn(start, end, type) {
    for (const ym of monthsBetween(start, end)) {
      const m = months.get(`${ym}|${type}`);
      if (!m) continue;
      for (const grp of m.groups) {
        for (const t of grp.splits) {
          const day = String(t.date).slice(0, 10);
          if (day >= start && day <= end) yield t;
        }
      }
    }
  }
  const sigOf = (start, end, types) => monthsBetween(start, end).flatMap((ym) => types.map((type) => months.get(`${ym}|${type}`)?.ats.join('.') || '-')).join('|');

  // ---- Antworten -------------------------------------------------------------------------------
  const memo = new Map();
  function answer(key, build) {
    const hit = memo.get(key);
    if (hit) return { ...hit, state: 'LOCAL' };
    const body = Buffer.from(JSON.stringify(build()));
    const res = { status: 200, body, gz: body.length > 1024 ? zlib.gzipSync(body, { level: 4 }) : null, type: 'application/json', at: Date.now() };
    memo.set(key, res);
    if (memo.size > 3000) memo.delete(memo.keys().next().value);
    return { ...res, state: 'LOCAL' };
  }

  function insight(kind, what, start, end, tagIds) {
    const type = kind === 'expense' ? 'withdrawal' : 'deposit';
    const sign = kind === 'expense' ? -1 : 1;
    const v = version();
    const acc = new Map();
    const add = (key, t, extra) => {
      const cur = acc.get(key);
      if (cur) cur.sum += Number(t.amount) || 0;
      else acc.set(key, { ...extra, sum: Number(t.amount) || 0, currency_id: t.currency_id, currency_code: t.currency_code, currency_symbol: t.currency_symbol, currency_decimal_places: t.currency_decimal_places });
    };
    for (const t of splitsIn(start, end, type)) {
      const e = eff(t, v);
      if (e.ex) continue;
      const code = t.currency_code;
      if (what === 'total') add(code, t, {});
      else if (what === 'category') {
        if (e.cat) add(`${e.cat.id}|${code}`, t, { id: e.cat.id, name: e.cat.name });
      } else if (what === 'no-category') {
        if (!e.cat) add(code, t, {});
      } else if (what === 'tag') {
        for (const tag of t.tags || []) add(`${lower(tag)}|${code}`, t, { id: tagIds.get(lower(tag))?.id || tag, name: tag, tag });
      }
    }
    return [...acc.values()].map(({ sum, ...x }) => ({ ...x, difference: (sign * sum).toFixed(2), difference_float: round(sign * sum) }));
  }

  function list(q, alle, auto) {
    const start = q.get('start');
    const end = q.get('end');
    const types = typesOf(q.get('type'));
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit')) || 50));
    const page = Math.max(1, Number(q.get('page')) || 1);
    const v = version();
    const rows = [];
    for (const ym of monthsBetween(start, end)) for (const type of types) {
      const m = months.get(`${ym}|${type}`);
      if (!m) continue;
      for (const grp of m.groups) {
        const out = [];
        for (const t of grp.splits) {
          const day = String(t.date).slice(0, 10);
          if (day < start || day > end) continue;
          const e = eff(t, v);
          if (e.ex && !alle) continue;
          out.push(shown(t, e, alle, auto));
        }
        if (out.length) rows.push({ date: grp.date, id: Number(grp.g.id) || 0, g: { ...grp.g, attributes: { ...grp.g.attributes, transactions: out } } });
      }
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)); // neueste zuerst, wie Firefly
    const slice = rows.slice((page - 1) * limit, page * limit).map((r) => r.g);
    return { data: slice, meta: { pagination: { total: rows.length, count: slice.length, per_page: limit, current_page: page, total_pages: Math.max(1, Math.ceil(rows.length / limit)) } } };
  }

  /** Namen automatischer Kategorien, die es in Firefly (noch) nicht gibt. */
  let virtualMemo = { key: '', names: [] };
  function virtualNames() {
    const v = version();
    const key = `${v}|${monthsRev}`;
    if (virtualMemo.key === key) return virtualMemo.names;
    const names = new Set();
    for (const m of months.values()) for (const grp of m.groups) for (const t of grp.splits) {
      const e = eff(t, v);
      if ((e.cat?.quelle || e.cat?.merged) && e.cat.id.startsWith('auto:')) names.add(e.cat.name);
    }
    virtualMemo = { key, names: [...names].sort((a, b) => a.localeCompare(b, 'de')) };
    return virtualMemo.names;
  }

  /** Antwort von Firefly (Liste oder einzelne Buchung) nachbearbeiten: automatische Kategorien eintragen. */
  function annotate(result, apiPath, single) {
    const v = version();
    const key = `fx|${apiPath}|${result.at}|${v}|${result.body.length}`;
    return { ...result, ...answer(key, () => {
      const json = JSON.parse(result.body.toString('utf8'));
      const fix = (g) => {
        const txs = g?.attributes?.transactions;
        if (!Array.isArray(txs)) return g;
        return { ...g, attributes: { ...g.attributes, transactions: txs.map((t) => (TYPES.includes(t.type) ? shown(t, eff(t, v), false) : t)) } };
      };
      return single ? { ...json, data: fix(json.data) } : { ...json, data: (json.data || []).map(fix) };
    }), state: result.state };
  }

  /**
   * Wie firefly.get – beantwortet Summen und Listen aus dem Monatsbuch, den Rest über Firefly.
   * opts: fresh, priority, alle (Listen roh, siehe oben), auto (mit alle: automatische Kategorien trotzdem eintragen).
   */
  async function get(apiPath, params, opts = {}) {
    const q = new URLSearchParams(params);
    const start = q.get('start');
    const end = q.get('end');
    const ranged = enabled && /^\d{4}-\d{2}-\d{2}$/.test(start || '') && /^\d{4}-\d{2}-\d{2}$/.test(end || '') && start <= end;
    const ins = apiPath.match(INSIGHT);
    if (ins && ranged) {
      const type = ins[1] === 'expense' ? 'withdrawal' : 'deposit';
      const [, tags] = await Promise.all([prepare(start, end, [type], opts), ins[2] === 'tag' ? loadMaster('tags', opts) : null]);
      return answer(`in|${apiPath}|${start}|${end}|${version()}|${tags?.rev || 0}|${sigOf(start, end, [type])}`, () => insight(ins[1], ins[2], start, end, tags?.byLower || new Map()));
    }
    const types = apiPath === 'transactions' && ranged ? typesOf(q.get('type')) : null;
    if (types) {
      await prepare(start, end, types, opts);
      const auto = !opts.alle || Boolean(opts.auto);
      return answer(`tx|${q.get('type')}|${start}|${end}|${q.get('limit')}|${q.get('page')}|${Boolean(opts.alle)}|${auto}|${version()}|${sigOf(start, end, types)}`, () => list(q, Boolean(opts.alle), auto));
    }
    const auto = apiPath.match(/^categories\/(auto:.+)$/);
    if (auto) {
      const name = decodeURIComponent(auto[1]).slice(5);
      return answer(`cat|${name}`, () => ({ data: { type: 'categories', id: `auto:${name}`, attributes: { name, ffd_auto: true } } }));
    }
    const result = await excluded.get(apiPath, params, opts);
    if (!enabled || result.status !== 200 || (opts.alle && !opts.auto)) return result;
    if (apiPath === 'categories') {
      // automatische Kategorien, die es in Firefly nicht gibt, anhängen (für Ziele, Auswahllisten, Namen)
      if (Number(q.get('page') || 1) !== 1) return result;
      await loadMaster('categories', opts);
      ensureLearned();
      const names = virtualNames();
      if (!names.length) return result;
      return { ...result, ...answer(`cats|${result.at}|${names.join('|')}`, () => {
        const json = JSON.parse(result.body.toString('utf8'));
        const extra = names.map((name) => ({ type: 'categories', id: `auto:${name}`, attributes: { name, ffd_auto: true } }));
        const p = json.meta?.pagination;
        return { ...json, data: [...(json.data || []), ...extra], ...(p ? { meta: { ...json.meta, pagination: { ...p, total: p.total + extra.length, count: p.count + extra.length } } } : {}) };
      }), state: result.state };
    }
    const single = /^transactions\/\d+$/.test(apiPath);
    if (single || TX_LIST.test(apiPath)) {
      await loadMaster('categories', opts).catch(() => {});
      return annotate(result, apiPath, single);
    }
    return result;
  }

  // ---- Vorladen ------------------------------------------------------------------------------
  /** Die letzten n Monate laden bzw. erneuern (neueste zuerst; die Warteschlange begrenzt die Last auf Firefly). */
  async function warm(n = 37) {
    if (!enabled) return;
    const t = new Date();
    const yms = Array.from({ length: n }, (_, i) => isoDay(new Date(t.getFullYear(), t.getMonth() - i, 1)).slice(0, 7));
    await Promise.all([loadMaster('categories', { priority: 'warm' }).catch(() => {}), loadMaster('tags', { priority: 'warm' }).catch(() => {}),
      ...[FUTURE, ...yms].flatMap((ym) => LOADED.map((type) => loadMonth(ym, type, { priority: 'warm' }).catch(() => {})))]);
    ensureLearned();
    if (!lastCheck || Date.now() - Date.parse(lastCheck.at) > 20 * 3600_000) await check().catch((err) => log(`Selbstprüfung: ${err.message}`));
  }

  // ---- Selbstprüfung: eigene Summen gegen Firefly ---------------------------------------------
  let lastCheck = null;
  /** Vergleicht für die letzten zwei abgeschlossenen Monate die eigenen Summen (roh, ohne Ausblenden und Automatik) mit Firefly. */
  async function check() {
    const t = new Date();
    const result = { at: new Date().toISOString(), ok: true, months: [] };
    for (const back of [1, 2]) {
      const ym = isoDay(new Date(t.getFullYear(), t.getMonth() - back, 1)).slice(0, 7);
      const [start, end] = monthRange(ym);
      await Promise.all(TYPES.map((type) => loadMonth(ym, type, { priority: 'warm' })));
      const ff = async (p) => {
        const r = await firefly.get(p, { start, end }, { priority: 'warm' });
        if (r.status !== 200) throw new Error(`Firefly ${p}: HTTP ${r.status}`);
        return JSON.parse(r.body.toString('utf8'));
      };
      const checks = [];
      for (const [kind, type] of [['expense', 'withdrawal'], ['income', 'deposit']]) {
        const own = new Map(); // Währung → Summe
        const ownCats = new Map(); // Kategorie-ID|Währung → Summe
        for (const x of splitsIn(start, end, type)) {
          own.set(x.currency_code, (own.get(x.currency_code) || 0) + Number(x.amount));
          if (x.category_id) ownCats.set(`${x.category_id}|${x.currency_code}`, (ownCats.get(`${x.category_id}|${x.currency_code}`) || 0) + Number(x.amount));
        }
        const [total, cats] = await Promise.all([ff(`insight/${kind}/total`), ff(`insight/${kind}/category`)]);
        // Hauptwährung: die mit der größten eigenen Summe
        const code = [...own].sort((a, b) => b[1] - a[1])[0]?.[0] || total[0]?.currency_code || 'EUR';
        const theirs = Math.abs(Number(total.find((x) => x.currency_code === code)?.difference_float ?? 0));
        const mine = round(own.get(code) || 0);
        const differing = cats.filter((c) => c.currency_code === code && Math.abs(Math.abs(Number(c.difference_float)) - (ownCats.get(`${c.id}|${code}`) || 0)) >= 0.005).length;
        const ok = Math.abs(theirs - mine) < 0.005 && differing === 0;
        if (!ok) result.ok = false;
        checks.push({ art: kind === 'expense' ? 'Ausgaben' : 'Einnahmen', waehrung: code, dashboard: mine, firefly: round(theirs), kategorienAbweichend: differing, ok });
      }
      result.months.push({ monat: ym, checks });
    }
    lastCheck = result;
    log(result.ok ? `Selbstprüfung: eigene Summen stimmen mit Firefly überein (${result.months.map((m) => m.monat).join(', ')})`
      : `Selbstprüfung: ABWEICHUNG zu Firefly – ${JSON.stringify(result.months)}`);
    return result;
  }

  // ---- Übersicht für die Seite „Zuordnen“ --------------------------------------------------------
  async function overview(opts) {
    const t = new Date();
    const start = isoDay(new Date(t.getFullYear(), t.getMonth() - 24, 1));
    const end = isoDay(t);
    await prepare(start, end, ['withdrawal'], opts);
    const v = version();
    const merchants = new Map();
    const totals = { firefly: 0, offen: 0, auto: Object.fromEntries(Object.keys(QUELLEN).map((k) => [k, 0])) };
    let code = 'EUR';
    for (const x of splitsIn(start, end, 'withdrawal')) {
      const e = eff(x, v);
      if (e.ex) continue;
      code = x.currency_code || code;
      const amount = Number(x.amount) || 0;
      const m = merchantOf(x);
      const known = m.key && m.key.length >= 2 && m.key !== 'text:';
      const key = known ? m.key : '';
      let row = merchants.get(key);
      if (!row) merchants.set(key, row = { key, name: known ? m.name : 'Ohne erkennbaren Händler', n: 0, sum: 0, firefly: 0, auto: 0, offen: 0, cats: new Map(), quellen: new Map(), last: '', beispiel: '' });
      row.n += 1;
      row.sum += amount;
      const day = String(x.date).slice(0, 10);
      if (day > row.last) {
        row.last = day;
        row.beispiel = String(x.description || '').slice(0, 80);
        if (known) row.name = m.name;
      }
      if (!e.cat) {
        row.offen += amount;
        totals.offen += amount;
      } else if (e.cat.quelle) {
        row.auto += amount;
        totals.auto[e.cat.quelle] += amount;
        row.cats.set(e.cat.name, (row.cats.get(e.cat.name) || 0) + amount);
        row.quellen.set(e.cat.quelle, (row.quellen.get(e.cat.quelle) || 0) + amount);
      } else {
        row.firefly += amount;
        totals.firefly += amount;
      }
    }
    const top = (map) => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const assigned = autocat.assignments();
    const out = (r) => ({ key: r.key, name: r.name, n: r.n, sum: round(r.sum), offen: round(r.offen), auto: round(r.auto), firefly: round(r.firefly), category: top(r.cats), quelle: top(r.quellen), last: r.last, beispiel: r.beispiel, fest: Boolean(assigned[r.key]) });
    const rows = [...merchants.values()];
    const autoSum = Object.values(totals.auto).reduce((a, n) => a + n, 0);
    return {
      zeitraum: { von: start, bis: end },
      waehrung: code,
      summen: { firefly: round(totals.firefly), automatisch: round(autoSum), offen: round(totals.offen), quellen: Object.fromEntries(Object.entries(totals.auto).map(([k, n]) => [k, round(n)])) },
      offen: rows.filter((r) => r.offen >= 0.005).sort((a, b) => b.offen - a.offen).slice(0, 300).map(out),
      offenAnzahl: rows.filter((r) => r.offen >= 0.005).length,
      automatisch: rows.filter((r) => r.auto >= 0.005).sort((a, b) => b.auto - a.auto).slice(0, 500).map(out),
      kategorien: [...new Set([...master.categories.list.map((c) => c.name), ...virtualNames()])].sort((a, b) => a.localeCompare(b, 'de')),
      quellen: QUELLEN,
      einstellungen: autocat.config(),
      pruefung: lastCheck,
      aktiv: enabled,
    };
  }

  /** Buchungen eines Händlers (Schlüssel wie merchantOf; '' = ohne erkennbaren Händler), wie die Auswertungen sie sehen. */
  async function bookingsOf(key, opts) {
    const t = new Date();
    const start = isoDay(new Date(t.getFullYear(), t.getMonth() - 24, 1));
    const end = isoDay(t);
    await prepare(start, end, ['withdrawal'], opts);
    const v = version();
    const out = [];
    for (const ym of monthsBetween(start, end)) {
      const m = months.get(`${ym}|withdrawal`);
      if (!m) continue;
      for (const grp of m.groups) {
        for (const x of grp.splits) {
          const day = String(x.date).slice(0, 10);
          if (day < start || day > end) continue;
          const mk = merchantOf(x).key;
          const known = mk && mk.length >= 2 && mk !== 'text:';
          if ((known ? mk : '') !== key) continue;
          const e = eff(x, v);
          if (e.ex) continue;
          out.push({ ...shown(x, e, false), groupId: grp.g.id, ffd_quelle: e.cat?.quelle || (e.cat ? 'firefly' : null) });
        }
      }
    }
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { key, anzahl: out.length, buchungen: out.slice(0, 300) };
  }

  /**
   * Kategorien mit Buchungen der letzten 24 Monate (roh, wie in Firefly bzw. automatisch zugeordnet) –
   * für „Kategorien zusammenführen“: Anzahl, Summe je Art, wohin zusammengeführt.
   */
  async function categoryOverview(opts) {
    const t = new Date();
    const start = isoDay(new Date(t.getFullYear(), t.getMonth() - 24, 1));
    const end = isoDay(t);
    await prepare(start, end, TYPES, opts);
    const v = version();
    const rows = new Map();
    for (const type of TYPES) {
      for (const x of splitsIn(start, end, type)) {
        let name = x.category_name;
        let auto = false;
        if (!name) {
          const a = autocat.categorize(x, { learned: learned.map, known: master.categories.list.map((c) => c.name), categoryById: (id) => master.categories.list.find((c) => c.id === id)?.name });
          if (!a) continue;
          name = a.name;
          auto = true;
        }
        const k = lower(name);
        let r = rows.get(k);
        if (!r) rows.set(k, r = { name, n: 0, ausgaben: 0, einnahmen: 0, firefly: false, auto: false });
        r.n += 1;
        r[type === 'withdrawal' ? 'ausgaben' : 'einnahmen'] += Number(x.amount) || 0;
        if (auto) r.auto = true;
        else r.firefly = true;
      }
    }
    void v;
    // auch Firefly-Kategorien ohne Buchungen (leere Hüllen nach dem Zusammenführen)
    for (const c of master.categories.list) if (!rows.has(lower(c.name))) rows.set(lower(c.name), { name: c.name, n: 0, ausgaben: 0, einnahmen: 0, firefly: true, auto: false });
    const merges = autocat.merges();
    // zusammengeführte Kategorien zählen beim Ziel mit (die Quelle bleibt mit „ziel“ in der Liste)
    for (const r of [...rows.values()]) {
      const to = autocat.mergedName(r.name);
      if (!to) continue;
      let t = rows.get(lower(to));
      if (!t) rows.set(lower(to), t = { name: to, n: 0, ausgaben: 0, einnahmen: 0, firefly: false, auto: false });
      t.n += r.n;
      t.ausgaben += r.ausgaben;
      t.einnahmen += r.einnahmen;
    }
    return {
      kategorien: [...rows.values()].map((r) => ({ ...r, ausgaben: round(r.ausgaben), einnahmen: round(r.einnahmen), inFirefly: master.categories.byLower.has(lower(r.name)),
        id: master.categories.byLower.get(lower(r.name))?.id || null, ziel: autocat.mergedName(r.name) }))
        .sort((a, b) => b.ausgaben + b.einnahmen - (a.ausgaben + a.einnahmen)),
      zusammengefuehrt: merges.sort((a, b) => a.to.localeCompare(b.to, 'de') || a.from.localeCompare(b.from, 'de')),
    };
  }

  async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      let raw = '';
      for await (const c of req) {
        raw += c;
        if (raw.length > 20_000) throw new Error('Zu groß.');
      }
      return raw ? JSON.parse(raw) : {};
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    try {
      if (url.pathname === '/local/kategorien') {
        if (req.method === 'POST') {
          const input = await readBody();
          if (input.unmerge) autocat.unmerge(input.unmerge);
          else if (input.sent) autocat.markSent(input.sent);
          else autocat.merge(input.from, input.to, input.firefly);
        }
        return json(200, await categoryOverview({ priority: 'user' }));
      }
      if (url.pathname === '/local/ledger') {
        if (url.searchParams.get('pruefen') === '1') await check();
        return json(200, { aktiv: enabled, monate: [...new Set([...months.keys()].map((k) => k.slice(0, 7)))].sort(), pruefung: lastCheck });
      }
      // Zähler fürs Menü: Händler, deren Ausgaben noch keine Kategorie haben
      if (req.method === 'GET' && url.searchParams.has('anzahl')) {
        const o = await overview({ priority: 'warm' });
        return json(200, { offen: o.offenAnzahl, betrag: o.summen.offen });
      }
      if (req.method === 'GET' && url.searchParams.has('haendler')) return json(200, await bookingsOf(url.searchParams.get('haendler'), { priority: 'user' }));
      if (req.method === 'POST') {
        const input = await readBody();
        if (input.journal !== undefined) autocat.assignTx(input.journal, input.category);
        else autocat.assign(input.key, input.name, input.category);
        if (input.haendler !== undefined) return json(200, { ...(await overview({ priority: 'user' })), buchungen: await bookingsOf(input.haendler, { priority: 'user' }) });
      } else if (req.method === 'PUT') autocat.configure(await readBody());
      else if (req.method !== 'GET') return json(405, { message: 'Nicht erlaubt.' });
      return json(200, await overview({ priority: 'user' }));
    } catch (err) {
      return json(400, { message: err.message });
    }
  }

  return { get, warm, check, handle, overview, warmRaw: firefly.warm, summary: firefly.summary, invalidate: firefly.invalidate, enabled };
}
