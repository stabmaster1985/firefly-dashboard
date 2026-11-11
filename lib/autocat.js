// Automatische Kategorien: Buchungen ohne Firefly-Kategorie bekommen in den Auswertungen eine –
// aus dem Händler abgeleitet. Firefly bleibt unverändert; angewendet wird beim Ausliefern
// (lib/ledger.js). Reihenfolge, die erste Quelle gewinnt:
//
//   1. deine Zuordnung je Händler (Seite „Zuordnen“)            → quelle „zuordnung“
//   2. deine Regeln aus dem Labor (rules.json)                   → „regel“
//   3. gelernt: derselbe Händler ist sonst eindeutig kategorisiert → „gelernt“
//   4. eingebaute Händlerliste (Aldi, Lidl, Netto → Lebensmittel) → „liste“
//   5. KI-Bewertung aus dem Labor (ab Mindest-Sicherheit)         → „ki“
//
// Gespeichert in DATA_DIR/autocat.json: { enabled, learn, list, ai, aiMin, assign: { händler: { name, category } } }

import fs from 'node:fs';
import path from 'node:path';
import { jsonFile } from './store.js';
import { merchantOf, ruleMatches, listedCategory, ownCategoryName } from '../public/js/rules.js';

const DEFAULTS = { enabled: true, learn: true, list: true, ai: true, aiMin: 80, assign: {} };
const text = (v, n = 80) => String(v ?? '').trim().slice(0, n);

export const QUELLEN = { zuordnung: 'deine Zuordnung', regel: 'deine Regel', gelernt: 'aus deinen Buchungen gelernt', liste: 'Händlerliste', ki: 'KI' };

export function createAutoCat(dataDir, { log = console.log } = {}) {
  const file = jsonFile(path.join(dataDir, 'autocat.json'), DEFAULTS, { snapshots: true, log });
  const rulesPath = path.join(dataDir, 'rules.json');
  const labelsPath = path.join(dataDir, 'ai-labels.json');

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
  let ext = { sig: '', rules: [], labels: {}, decisions: {} };
  function sources() {
    settings ||= file.read();
    const sig = `${mtime(rulesPath)}|${mtime(labelsPath)}`;
    if (sig !== ext.sig) {
      const ai = readJson(labelsPath, {});
      ext = {
        sig,
        rules: (readJson(rulesPath, {}).rules || []).filter((r) => r.enabled !== false && r.setCategory),
        labels: ai.labels || {},
        decisions: ai.decisions?.categories || {},
      };
    }
    return { settings, ...ext };
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
   * ctx.learned: Map Händler → Kategorie (aus deinen kategorisierten Buchungen), ctx.known: Namen der Firefly-Kategorien.
   */
  function categorize(t, ctx) {
    const src = sources();
    const s = src.settings;
    if (!s.enabled || (t.type !== 'withdrawal' && t.type !== 'deposit')) return null;
    const key = merchantOf(t).key;
    const mine = key ? s.assign[key] : null;
    if (mine) return mine.category ? { name: mine.category, quelle: 'zuordnung' } : null; // leer = bewusst ohne Kategorie
    const rule = src.rules.find((r) => ruleMatches(r, t));
    if (rule) return { name: rule.setCategory, quelle: 'regel' };
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
  function configure(input) {
    const s = sources().settings;
    const bool = (k) => (typeof input[k] === 'boolean' ? input[k] : s[k]);
    save({ ...s, enabled: bool('enabled'), learn: bool('learn'), list: bool('list'), ai: bool('ai'), aiMin: [50, 70, 80, 90].includes(Number(input.aiMin)) ? Number(input.aiMin) : s.aiMin });
  }
  const config = () => {
    const { assign: a, ...rest } = sources().settings;
    return { ...rest, assigned: Object.keys(a).length };
  };

  return { categorize, version, assign, configure, config, assignments: () => sources().settings.assign };
}
