// Einstellungen, Ziele, Monatsabschluss und Warnungen.
//
//   GET/PUT /local/settings   { payday, alertThreshold }
//   GET/PUT /local/goals      { goals: { <kategorieId>: { name, amount } } }
//   GET     /local/alerts     aktuelle Hinweise (auch für die Übersicht)
//
// Der Zeitplan prüft regelmäßig, ob ein (Gehalts-)Monat abgeschlossen ist
// oder es neue Warnungen gibt, und startet die passenden Automationen.
// Für Gehaltsmonate und Abo-Erkennung wird derselbe Code wie in der
// Oberfläche verwendet (public/js), damit beide gleich rechnen.

import fs from 'node:fs';
import path from 'node:path';
import { monthModel, isoDate, fmtDate, parseDate } from '../public/js/util.js';
import { detectRecurring, stepDate } from '../public/js/recurring.js';
import { PAGE_SIZE } from './warmer.js';

const DAY = 86400000;
const DEFAULT_SETTINGS = { payday: 24, alertThreshold: 250 };

function jsonFile(file, fallback) {
  return {
    read() {
      try {
        return { ...structuredClone(fallback), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        return structuredClone(fallback);
      }
    },
    write(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}

const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const round = (n) => Math.round(n * 100) / 100;
const fmtEur = (n) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

export function createAutomation({ dataDir, firefly, actions, log = console.log }) {
  const settingsFile = jsonFile(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  const goalsFile = jsonFile(path.join(dataDir, 'goals.json'), { goals: {} });
  const rulesFile = jsonFile(path.join(dataDir, 'rules.json'), { rules: [], autoTags: ['abo', 'online', 'bargeld'] });
  const stateFile = jsonFile(path.join(dataDir, 'state.json'), { reports: {}, alertsSent: [], alertsInitialized: false });

  // --- Firefly-Daten (über den gemeinsamen Zwischenspeicher) ---------------
  const getJson = async (apiPath, params = {}) => {
    const r = await firefly.get(apiPath, params, { priority: 'warm' });
    if (r.status >= 400) throw new Error(`Firefly ${apiPath}: HTTP ${r.status}`);
    return JSON.parse(r.body.toString('utf8'));
  };
  const getAll = async (apiPath, params) => {
    const first = await getJson(apiPath, { ...params, limit: PAGE_SIZE, page: 1 });
    const pages = first?.meta?.pagination?.total_pages || 1;
    const rest = [];
    for (let p = 2; p <= pages; p++) rest.push(await getJson(apiPath, { ...params, limit: PAGE_SIZE, page: p }));
    return [first, ...rest].flatMap((r) => r?.data || []);
  };
  const flatten = (groups) =>
    groups.flatMap((g) => (g.attributes?.transactions || []).map((t) => ({ groupId: g.id, ...t, amount: Number(t.amount) })));
  const valueOf = (x) => Math.abs(Number(x.difference_float ?? x.difference));
  const total = async (kind, s, e) => {
    const list = await getJson(`insight/${kind}/total`, { start: isoDate(s), end: isoDate(e) });
    return (list || []).filter((x) => x.currency_code === 'EUR' || list.length === 1).reduce((a, x) => a + valueOf(x), 0);
  };
  const categories = async (s, e) => {
    const range = { start: isoDate(s), end: isoDate(e) };
    const [cats, none] = await Promise.all([
      getJson('insight/expense/category', range),
      getJson('insight/expense/no-category', range).catch(() => []),
    ]);
    return [
      ...(cats || []).map((c) => ({ id: String(c.id), name: c.name, value: valueOf(c) })),
      ...(none || []).map((c) => ({ id: '0', name: 'Ohne Kategorie', value: valueOf(c) })),
    ].filter((c) => c.value > 0);
  };

  // --- Monatsabschluss ------------------------------------------------------
  const modelFor = (kind) => monthModel(kind === 'report-salary' ? settingsFile.read().payday : 1);

  /** Bericht über einen abgeschlossenen Monat (Kalender- oder Gehaltsmonat). */
  async function buildReport(trigger, monthOffset = -1) {
    const model = modelFor(trigger);
    const key = model.keyOf(today());
    const [s, e] = model.range(key, monthOffset);
    const [ps, pe] = model.range(key, monthOffset - 1);
    const salary = model.isSalary;
    const label = `${salary ? 'Gehaltsmonat ' : ''}${fmtDate(salary ? e : s, { month: 'long', year: 'numeric' })}`;
    const [inc, out, pinc, pout, cats, pcats, txs] = await Promise.all([
      total('income', s, e), total('expense', s, e), total('income', ps, pe), total('expense', ps, pe),
      categories(s, e), categories(ps, pe),
      getAll('transactions', { start: isoDate(s), end: isoDate(e), type: 'withdrawal' }),
    ]);
    const goals = goalsFile.read().goals;
    const prevById = new Map(pcats.map((c) => [c.id, c.value]));
    const kategorien = cats.sort((a, b) => b.value - a.value).map((c) => {
      const prev = prevById.get(c.id) || 0;
      return {
        name: c.name,
        betrag: round(c.value),
        vormonat: round(prev),
        veraenderung_prozent: prev ? Math.round(((c.value - prev) / prev) * 100) : null,
        ziel: goals[c.id] ? goals[c.id].amount : null,
      };
    });
    const ziele = Object.entries(goals).map(([id, g]) => {
      const ist = cats.find((c) => c.id === id)?.value || 0;
      return { kategorie: g.name, ziel: g.amount, ist: round(ist), eingehalten: ist <= g.amount };
    });
    const auffaellig = kategorien
      .filter((k) => k.vormonat && k.betrag - k.vormonat >= 30 && k.veraenderung_prozent >= 30)
      .map((k) => `${k.name}: ${fmtEur(k.betrag)} (${k.veraenderung_prozent > 0 ? '+' : ''}${k.veraenderung_prozent} % ggü. Vormonat)`);
    const groesste = flatten(txs).sort((a, b) => b.amount - a.amount).slice(0, 5).map((t) => ({
      datum: String(t.date).slice(0, 10), beschreibung: t.description, empfaenger: t.destination_name, kategorie: t.category_name, betrag: round(t.amount),
    }));
    const saldo = inc - out;
    const quote = inc ? Math.round((saldo / inc) * 100) : null;
    const zielText = ziele.length ? ` Ziele: ${ziele.filter((z) => z.eingehalten).length} von ${ziele.length} eingehalten.` : '';
    return {
      typ: 'monatsabschluss',
      modell: salary ? 'gehaltsmonat' : 'kalendermonat',
      zeitraum: { von: isoDate(s), bis: isoDate(e), bezeichnung: label },
      waehrung: 'EUR',
      einnahmen: round(inc),
      ausgaben: round(out),
      saldo: round(saldo),
      sparquote_prozent: quote,
      vormonat: { von: isoDate(ps), bis: isoDate(pe), einnahmen: round(pinc), ausgaben: round(pout), saldo: round(pinc - pout) },
      kategorien,
      ziele,
      groesste_buchungen: groesste,
      auffaellig,
      text: `${label}: Einnahmen ${fmtEur(inc)}, Ausgaben ${fmtEur(out)}, ${saldo >= 0 ? 'gespart' : 'Minus'} ${fmtEur(Math.abs(saldo))}`
        + `${quote !== null ? ` (Sparquote ${quote} %)` : ''}. Größte Kategorie: ${kategorien[0]?.name || '–'}.${zielText}`
        + `${auffaellig.length ? ` Auffällig: ${auffaellig.join('; ')}.` : ''}`,
    };
  }

  // --- Warnungen ------------------------------------------------------------
  let alertCache = { at: 0, alerts: [] };

  async function computeAlerts() {
    if (Date.now() - alertCache.at < 10 * 60 * 1000) return alertCache.alerts;
    const t0 = today();
    const settings = settingsFile.read();
    const from = new Date(t0.getFullYear(), t0.getMonth() - 24, 1); // wie „Wiederkehrend“ → gleicher Cache
    const txs = flatten(await getAll('transactions', { start: isoDate(from), end: isoDate(t0), type: 'withdrawal' }))
      .filter((t) => t.type === 'withdrawal');
    const alerts = [];

    // 1) große Einzelbuchungen der letzten 14 Tage
    for (const t of txs) {
      const d = parseDate(t.date);
      if ((t0 - d) / DAY <= 14 && t.amount >= settings.alertThreshold) {
        alerts.push({
          key: `gross:${t.groupId}:${t.transaction_journal_id}`,
          art: 'grosse_buchung',
          titel: `Große Ausgabe: ${fmtEur(t.amount)}`,
          text: `${t.description} (${t.destination_name || '–'}) am ${fmtDate(d)} – ${fmtEur(t.amount)}`,
          datum: isoDate(d),
          details: { betrag: round(t.amount), beschreibung: t.description, empfaenger: t.destination_name, kategorie: t.category_name, group_id: t.groupId },
        });
      }
    }

    // 2) Abos: Preisänderung oder ausgeblieben
    const { items } = detectRecurring(txs, 'expense', 'normal');
    for (const r of items) {
      if (r.changed && (t0 - r.last) / DAY <= 45) {
        alerts.push({
          key: `preis:${r.name}:${isoDate(r.last)}`,
          art: 'preisaenderung',
          titel: `Neuer Betrag: ${r.name}`,
          text: `${r.name} kostet jetzt ${fmtEur(r.lastAmount)} statt üblich ${fmtEur(r.amount)} (${r.rhythm.label}).`,
          datum: isoDate(r.last),
          details: { name: r.name, bisher: round(r.amount), neu: round(r.lastAmount), rhythmus: r.rhythm.label },
        });
      }
      const expected = stepDate(r.last, r.rhythm, r.anchorDay);
      const overdue = (t0 - expected) / DAY;
      if (r.rhythm.days <= 92 && overdue > r.rhythm.tol && overdue <= r.rhythm.days) {
        alerts.push({
          key: `fehlt:${r.name}:${isoDate(expected)}`,
          art: 'ausgeblieben',
          titel: `Ausgeblieben: ${r.name}`,
          text: `${r.name} (${fmtEur(r.amount)}, ${r.rhythm.label}) wäre um den ${fmtDate(expected)} fällig gewesen – gekündigt oder nur verspätet?`,
          datum: isoDate(expected),
          details: { name: r.name, betrag: round(r.amount), erwartet: isoDate(expected) },
        });
      }
    }
    alerts.sort((a, b) => b.datum.localeCompare(a.datum));
    alertCache = { at: Date.now(), alerts };
    return alerts;
  }

  // --- Zeitplan ---------------------------------------------------------------
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const list = actions.list();
      const state = stateFile.read();
      let dirty = false;

      // Monatsabschluss: einmal pro abgeschlossenem Monat; beim ersten Mal nur merken
      for (const a of list.filter((x) => x.trigger === 'report-calendar' || x.trigger === 'report-salary')) {
        const model = modelFor(a.trigger);
        const lastStart = isoDate(model.range(model.keyOf(today()), -1)[0]);
        const sent = state.reports[a.id];
        if (!sent) {
          state.reports[a.id] = lastStart;
          dirty = true;
        } else if (sent < lastStart) {
          const report = await buildReport(a.trigger);
          const result = await actions.run(a.id, { ...report, daten: report });
          log(`Monatsabschluss an „${a.name}“: ${result.ok ? 'ok' : `Fehler ${result.status}`}`);
          if (result.ok) {
            state.reports[a.id] = lastStart;
            dirty = true;
          }
        }
      }

      // Warnungen: jede nur einmal; beim allerersten Lauf alle bestehenden nur merken
      const alertActions = list.filter((x) => x.trigger === 'alerts');
      if (alertActions.length) {
        alertCache.at = 0;
        const alerts = await computeAlerts();
        const sent = new Set(state.alertsSent);
        const fresh = alerts.filter((x) => !sent.has(x.key));
        if (!state.alertsInitialized) {
          state.alertsInitialized = true;
        } else {
          for (const alert of fresh) {
            const payload = { typ: 'warnung', ...alert };
            for (const a of alertActions) await actions.run(a.id, { ...payload, daten: payload });
          }
          if (fresh.length) log(`${fresh.length} Warnung(en) verschickt`);
        }
        fresh.forEach((x) => sent.add(x.key));
        state.alertsSent = [...sent].slice(-500);
        dirty = true;
      }
      if (dirty) stateFile.write(state);
    } catch (err) {
      log(`Zeitplan: ${err.message}`);
    } finally {
      running = false;
    }
  }

  // Monatsabschluss „jetzt testen“ aus der Oberfläche: letzter Monat als Bericht
  actions.hooks.preview = async (action) => {
    if (action.trigger === 'report-calendar' || action.trigger === 'report-salary') {
      const report = await buildReport(action.trigger);
      return { ...report, daten: report };
    }
    if (action.trigger === 'alerts') {
      const alerts = await computeAlerts();
      const payload = alerts[0]
        ? { typ: 'warnung', test: true, ...alerts[0] }
        : { typ: 'warnung', test: true, art: 'test', titel: 'Testwarnung', text: 'So sieht eine Warnung aus.' };
      return { ...payload, daten: payload };
    }
    if (action.trigger === 'categorize') {
      const payload = { typ: 'kategorie_setzen', test: true, transaction_group_id: '0', transaction_journal_id: '0', kategorie: 'Lebensmittel', beschreibung: 'Testbuchung', betrag: 12.34 };
      return { ...payload, daten: payload };
    }
    if (action.trigger === 'update') return { typ: 'update', test: true };
    if (action.trigger === 'import') {
      const payload = { typ: 'import', test: true, konten_ueberfaellig: [] };
      return { ...payload, daten: payload };
    }
    if (action.trigger === 'tags') {
      const payload = { typ: 'tags_setzen', test: true, transaction_group_id: '0', transaction_journal_id: '0', tags: ['Urlaub', 'Test'], tag_hinzugefuegt: 'Test', tag_entfernt: null, beschreibung: 'Testbuchung', betrag: 12.34 };
      return { ...payload, daten: payload };
    }
    return {};
  };

  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 15 * 60 * 1000).unref();

  // --- HTTP-Endpunkte -----------------------------------------------------------
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('Ungültiges JSON.'));
        }
      });
      req.on('error', reject);
    });

  return async function handle(req, res, url) {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    try {
      if (url.pathname === '/local/settings') {
        if (req.method === 'PUT') {
          const input = await readJson(req);
          const cur = settingsFile.read();
          const payday = Math.round(Number(input.payday ?? cur.payday));
          const threshold = Number(input.alertThreshold ?? cur.alertThreshold);
          settingsFile.write({
            payday: payday >= 2 && payday <= 28 ? payday : cur.payday,
            alertThreshold: threshold > 0 ? threshold : cur.alertThreshold,
          });
          alertCache.at = 0;
        }
        return json(200, settingsFile.read());
      }
      if (url.pathname === '/local/goals') {
        if (req.method === 'PUT') {
          const input = await readJson(req);
          const goals = {};
          for (const [id, g] of Object.entries(input.goals || {})) {
            const amount = Number(g?.amount);
            if (/^[\w-]{1,40}$/.test(id) && amount > 0) goals[id] = { name: String(g.name || '').slice(0, 80), amount: round(amount) };
          }
          goalsFile.write({ goals });
        }
        return json(200, goalsFile.read());
      }
      if (url.pathname === '/local/rules') {
        if (req.method === 'PUT') {
          const input = await readJson(req);
          const text = (v, n = 120) => String(v ?? '').slice(0, n);
          const FIELDS = ['party', 'description', 'amount', 'account', 'category'];
          const OPS = ['contains', 'equals', 'startsWith', 'regex', 'gt', 'lt', 'between'];
          const rules = (Array.isArray(input.rules) ? input.rules : []).slice(0, 500).map((r) => ({
            id: text(r.id, 40) || `r${Math.random().toString(36).slice(2)}`,
            enabled: r.enabled !== false,
            when: (Array.isArray(r.when) ? r.when : []).slice(0, 5)
              .filter((c) => FIELDS.includes(c.field) && OPS.includes(c.op))
              .map((c) => ({ field: c.field, op: c.op, value: text(c.value), value2: text(c.value2, 20) })),
            setCategory: text(r.setCategory, 80),
            addTags: (Array.isArray(r.addTags) ? r.addTags : []).slice(0, 5).map((x) => text(x, 40)).filter(Boolean),
          })).filter((r) => r.when.length);
          const autoTags = (Array.isArray(input.autoTags) ? input.autoTags : []).map((x) => text(x, 20)).slice(0, 10);
          rulesFile.write({ rules, autoTags });
        }
        return json(200, rulesFile.read());
      }
      if (url.pathname === '/local/alerts') {
        return json(200, { alerts: await computeAlerts(), threshold: settingsFile.read().alertThreshold });
      }
      return json(404, { message: 'Unbekannt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}

