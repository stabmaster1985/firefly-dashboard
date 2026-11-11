// Automatische Kategorien: Buchungen ohne Firefly-Kategorie bekommen in den Auswertungen eine –
// aus dem Händler abgeleitet. Firefly bleibt unverändert; angewendet wird beim Ausliefern
// (lib/ledger.js). Reihenfolge, die erste Quelle gewinnt:
//
//   0. deine Zuordnung dieser einen Buchung (Seite „Zuordnen“)      → quelle „buchung“
//   1. deine Zuordnung je Händler (Seite „Zuordnen“)                → „zuordnung“
//   2. deine Regeln aus dem Labor (rules.json)                       → „regel“
//   3. deine Import-Zuordnung (Übersetzungstabelle Händler → Kategorie aus der
//      Data-Importer-Konfiguration, Seite „Aufräumen“)              → „import“
//   4. gelernt: derselbe Händler ist sonst eindeutig kategorisiert   → „gelernt“
//   5. eingebaute Händlerliste (Aldi, Lidl, Netto → Lebensmittel)     → „liste“
//   6. KI-Bewertung aus dem Labor (ab Mindest-Sicherheit)             → „ki“
//
// Gespeichert in DATA_DIR/autocat.json:
//   { enabled, learn, list, ai, aiMin, assign: { händler: { name, category } }, tx: { journal: { category } } }

import fs from 'node:fs';
import path from 'node:path';
import { jsonFile } from './store.js';
import { merchantOf, ruleMatches, listedCategory, ownCategoryName, counterpartyOf } from '../public/js/rules.js';

const DEFAULTS = { enabled: true, learn: true, list: true, ai: true, aiMin: 80, assign: {}, tx: {}, merge: {}, ff: {} };
const text = (v, n = 80) => String(v ?? '').trim().slice(0, n);

export const QUELLEN = { buchung: 'einzeln zugeordnet', zuordnung: 'deine Zuordnung', regel: 'deine Regel', import: 'deine Import-Zuordnung', gelernt: 'aus deinen Buchungen gelernt', liste: 'Händlerliste', ki: 'KI' };

export function createAutoCat(dataDir, { log = console.log } = {}) {
  const file = jsonFile(path.join(dataDir, 'autocat.json'), DEFAULTS, { snapshots: true, log });
  const rulesPath = path.join(dataDir, 'rules.json');
  const labelsPath = path.join(dataDir, 'ai-labels.json');
  const importPath = path.join(dataDir, 'cleanup-import.json'); // aufbereitet (Seite „Aufräumen“)
  const configPath = path.join(dataDir, 'import-config.json'); // Rohfassung (für „Neue Zeilen importieren“ hinterlegt)

  // Eigene Datei im Speicher; Regeln und KI-Bewertungen gehören anderen Modulen → bei Änderung (mtime) neu lesen
  let settings = null;
  let own = 0; // zählt eigene Änderungen
  const mtime = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  const readJson = (f, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return fallback;
    }
  };
  let ext = { sig: '', rules: [], imports: [], labels: {}, decisions: {} };
  function sources() {
    settings ||= file.read();
    const sig = `${mtime(rulesPath)}|${mtime(labelsPath)}|${mtime(importPath)}|${mtime(configPath)}`;
    if (sig !== ext.sig) {
      const ai = readJson(labelsPath, {});
      ext = {
        sig,
        rules: (readJson(rulesPath, {}).rules || []).filter((r) => r.enabled !== false && r.setCategory),
        // Übersetzungstabelle aus der Import-Konfiguration: Name Zahlungsbeteiligter → Kategorie (nur aktive Einträge)
        imports: importTable(),
        labels: ai.labels || {},
        decisions: ai.decisions?.categories || {},
      };
    }
    return { settings, ...ext };
  }
  /**
   * Übersetzungstabelle Name Zahlungsbeteiligter → Kategorie aus der Data-Importer-Konfiguration:
   * aufbereitet und angepasst von der Seite „Aufräumen“ – sonst direkt aus der hinterlegten Konfiguration
   * (dort mit Kategorie-IDs; die Namen kennt erst das Monatsbuch).
   */
  function importTable() {
    const plan = Object.values(readJson(importPath, {}).items || {});
    let list;
    if (plan.length) {
      list = plan.filter((i) => i && i.enabled !== false && i.value && i.category && ['equals', 'contains'].includes(i.op))
        .map((i) => ({ op: i.op, value: String(i.value), category: i.category }));
    } else {
      const cfg = readJson(configPath, {}).config;
      const roles = Array.isArray(cfg?.roles) ? cfg.roles : [];
      list = roles.flatMap((role, index) => (role === 'category-name' ? Object.entries(cfg.mapping?.[index] || {}) : []))
        .map(([name, id]) => ({ op: 'equals', value: String(name), categoryId: String(id) }));
    }
    return list.map((i) => ({ ...i, value: i.value.toLowerCase().trim() })).filter((i) => i.value.length >= 2)
      .sort((a, b) => (a.op === 'equals' ? 0 : 1) - (b.op === 'equals' ? 0 : 1) || b.value.length - a.value.length);
  }

  /** Ändert sich, sobald sich an Einstellungen, Zuordnungen, Regeln oder KI-Bewertungen etwas ändert. */
  const version = () => `${own}|${sources().sig}`;

  /** KI-Bewertung eines Händlers, falls sie greift (wie im Labor: angenommen/korrigiert immer, abgelehnt nie). */
  function aiCategory(key, { labels, decisions, settings: s }) {
    const l = labels[key];
    if (!l || l.status === 'nein') return null;
    if (!(l.status === 'ok' || l.manual !== undefined || Number(l.sicherheit) >= s.aiMin)) return null;
    const name = (l.manual !== undefined ? l.manual : l.kategorie) || '';
    if (!name) return null;
    return Object.hasOwn(decisions, name) ? decisions[name] : name; // umbenannt/zusammengelegt (null = ignoriert)
  }

  /**
   * Kategorie für eine Buchung ohne Firefly-Kategorie: { name, quelle } oder null.
   * ctx.learned: Map Händler → Kategorie (aus deinen kategorisierten Buchungen), ctx.known: Namen der Firefly-Kategorien,
   * ctx.categoryById: Firefly-Kategorie-ID → Name (für die Import-Konfiguration).
   */
  function categorize(t, ctx) {
    const src = sources();
    const s = src.settings;
    if (!s.enabled || (t.type !== 'withdrawal' && t.type !== 'deposit')) return null;
    const one = s.tx?.[String(t.transaction_journal_id)];
    if (one) return one.category ? { name: one.category, quelle: 'buchung' } : null;
    const m = merchantOf(t);
    const key = m.key;
    const mine = key ? s.assign[key] : null;
    if (mine) return mine.category ? { name: mine.category, quelle: 'zuordnung' } : null; // leer = bewusst ohne Kategorie
    const rule = src.rules.find((r) => ruleMatches(r, t));
    if (rule) return { name: rule.setCategory, quelle: 'regel' };
    if (src.imports.length) {
      // gegen den Empfänger und den erkannten Händler (z. B. hinter PayPal) – wie beim Import gegen „Name Zahlungsbeteiligter“
      const names = [counterpartyOf(t), m.name].map((x) => String(x || '').toLowerCase().trim()).filter(Boolean);
      const hit = src.imports.find((i) => names.some((n) => (i.op === 'equals' ? n === i.value : n.includes(i.value))));
      const name = hit && (hit.category || ctx.categoryById?.(hit.categoryId));
      if (name) return { name, quelle: 'import' };
    }
    if (t.type !== 'withdrawal' || !key) return null; // Händlerwissen gilt für Ausgaben
    if (s.learn && ctx.learned?.has(key)) return { name: ctx.learned.get(key), quelle: 'gelernt' };
    if (s.list) {
      const listed = listedCategory(t);
      if (listed) return { name: ownCategoryName(listed, ctx.known || []), quelle: 'liste' };
    }
    if (s.ai) {
      const name = aiCategory(key, src);
      if (name) return { name, quelle: 'ki' };
    }
    return null;
  }

  function save(next) {
    settings = next;
    file.write(next);
    own += 1;
  }
  /** Händler fest zuordnen (category '' = bewusst ohne Kategorie, null = Zuordnung entfernen). */
  function assign(key, name, category) {
    const k = text(key, 200);
    if (!k) throw new Error('Händler fehlt.');
    const s = sources().settings;
    const next = { ...s, assign: { ...s.assign } };
    if (category === null || category === undefined) delete next.assign[k];
    else next.assign[k] = { name: text(name, 120), category: text(category, 80) };
    if (Object.keys(next.assign).length > 5000) throw new Error('Zu viele Zuordnungen.');
    save(next);
  }
  // ---- Kategorien zusammenführen: { quelle (klein): { from, to, firefly, sentAt } } -------------
  const low = (x) => String(x ?? '').trim().toLowerCase();
  /** Zielkategorie, falls diese Kategorie zusammengeführt wurde (auch über mehrere Stufen), sonst null. */
  function mergedName(name) {
    const m = sources().settings.merge || {};
    let to = null;
    let cur = low(name);
    for (let i = 0; i < 10 && m[cur]; i++) {
      to = m[cur].to;
      cur = low(to);
    }
    return to && low(to) !== low(name) ? to : null;
  }
  /** Kategorien in eine zusammenführen (firefly: zusätzlich per n8n-Regel in Firefly). */
  function merge(fromList, to, firefly = false) {
    const target = text(to, 80);
    if (!target) throw new Error('Zielkategorie fehlt.');
    const froms = (Array.isArray(fromList) ? fromList : [fromList]).map((x) => text(x, 80)).filter((x) => x && low(x) !== low(target));
    if (!froms.length) throw new Error('Keine Kategorie zum Zusammenführen gewählt.');
    const s = sources().settings;
    const next = { ...s, merge: { ...(s.merge || {}) } };
    for (const f of froms) next.merge[low(f)] = { from: f, to: target, firefly: Boolean(firefly), sentAt: next.merge[low(f)]?.sentAt || null };
    delete next.merge[low(target)]; // das Ziel selbst wird nicht weitergeleitet (keine Schleife)
    if (Object.keys(next.merge).length > 1000) throw new Error('Zu viele Zusammenführungen.');
    save(next);
  }
  function unmerge(from) {
    const s = sources().settings;
    const next = { ...s, merge: { ...(s.merge || {}) } };
    delete next.merge[low(from)];
    save(next);
  }
  /** In Firefly übertragen (n8n hat die Regeln angelegt und angewendet). */
  function markSent(froms) {
    const s = sources().settings;
    const next = { ...s, merge: { ...(s.merge || {}) } };
    const at = new Date().toISOString();
    for (const f of froms) if (next.merge[low(f)]) next.merge[low(f)] = { ...next.merge[low(f)], firefly: true, sentAt: at };
    save(next);
  }

  // ---- Als Firefly-Regeln übernommen: { händler: { key, name, category, cond, sentAt } } -----------
  /** Händler für Firefly vormerken bzw. aktualisieren (cond: Bedingung wie merchantOf). */
  function ffSet(list) {
    const s = sources().settings;
    const next = { ...s, ff: { ...(s.ff || {}) } };
    for (const x of Array.isArray(list) ? list : []) {
      const key = text(x.key, 200);
      const category = text(x.category, 80);
      const c = x.cond || {};
      if (!key || !category || !['party', 'description', 'notes'].includes(c.field) || !['equals', 'contains'].includes(c.op) || !String(c.value || '').trim()) continue;
      const old = next.ff[key];
      const cond = { field: c.field, op: c.op, value: text(c.value, 200) };
      const same = old && old.category === category && JSON.stringify(old.cond) === JSON.stringify(cond);
      next.ff[key] = { key, name: text(x.name, 120), category, cond, sentAt: same ? old.sentAt : null };
    }
    if (Object.keys(next.ff).length > 3000) throw new Error('Zu viele Regeln.');
    save(next);
  }
  function ffRemove(keys) {
    const s = sources().settings;
    const next = { ...s, ff: { ...(s.ff || {}) } };
    for (const k of keys || []) delete next.ff[k];
    save(next);
  }
  function ffSent() {
    const s = sources().settings;
    const at = new Date().toISOString();
    save({ ...s, ff: Object.fromEntries(Object.entries(s.ff || {}).map(([k, v]) => [k, { ...v, sentAt: v.sentAt || at }])) });
  }

  /** Eine einzelne Buchung zuordnen (category null = Zuordnung entfernen). */
  function assignTx(journal, category) {
    const j = text(journal, 20);
    if (!/^\d+$/.test(j)) throw new Error('Buchung fehlt.');
    const s = sources().settings;
    const next = { ...s, tx: { ...(s.tx || {}) } };
    if (category === null || category === undefined) delete next.tx[j];
    else next.tx[j] = { category: text(category, 80) };
    if (Object.keys(next.tx).length > 20000) throw new Error('Zu viele Einzelzuordnungen.');
    save(next);
  }
  function configure(input) {
    const s = sources().settings;
    const bool = (k) => (typeof input[k] === 'boolean' ? input[k] : s[k]);
    save({ ...s, enabled: bool('enabled'), learn: bool('learn'), list: bool('list'), ai: bool('ai'), aiMin: [50, 70, 80, 90].includes(Number(input.aiMin)) ? Number(input.aiMin) : s.aiMin });
  }
  const config = () => {
    const { assign: a, tx, merge: _m, ff: _f, ...rest } = sources().settings;
    return { ...rest, assigned: Object.keys(a).length, assignedTx: Object.keys(tx || {}).length, importRules: sources().imports.length };
  };

  return { categorize, version, assign, assignTx, configure, config, assignments: () => sources().settings.assign,
    mergedName, merge, unmerge, markSent, merges: () => Object.values(sources().settings.merge || {}),
    ffSet, ffRemove, ffSent, ffList: () => Object.values(sources().settings.ff || {}), txAssignments: () => sources().settings.tx || {} };
}
