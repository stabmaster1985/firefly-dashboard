// Home Assistant per MQTT (optional, Standard aus): zusammengefasste Kennzahlen als ein
// retained State-JSON plus Home-Assistant-Discovery – HA legt das Gerät „Firefly Finanzen“
// mit seinen Sensoren selbst an. Nur Summen und Kennzahlen, nie einzelne Buchungen.
//
// Gerechnet wird über dieselben Wege wie die Oberfläche: Summen aus insight/… (mit
// ausgeblendeten Buchungen herausgerechnet), Vergleich und Prognose aus public/js/periods.js,
// Ziele aus public/js/goals.js, wiederkehrende Zahlungen aus public/js/recurring.js.
//
//   GET /local/mqtt   Stand der Verbindung, letztes State-JSON und Discovery (ohne Zugangsdaten);
//                     ?vorschau=1 rechnet neu – auch ohne Broker und bei MQTT_ENABLED=false

import path from 'node:path';
import { monthModel, isoDate, today, addDays, parseDate } from '../public/js/util.js';
import { pastMonthChunks, monthChunks } from '../public/js/chunks.js';
import { previousRange, forecastTotalWith } from '../public/js/periods.js';
import { goalStatus } from '../public/js/goals.js';
import { detectRecurring, upcomingBetween, applyOverrides, contractDeadline } from '../public/js/recurring.js';
import { PAGE_SIZE } from './warmer.js';
import { jsonFile } from './store.js';

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : !/^(0|false|nein|no|off)$/i.test(String(v).trim()));
const round = (n) => Math.round(n * 100) / 100;

/** Einstellungen aus der Umgebung (.env). */
export function readConfig(env = process.env) {
  return {
    enabled: bool(env.MQTT_ENABLED, false),
    url: env.MQTT_URL || '',
    user: env.MQTT_USER || '',
    password: env.MQTT_PASSWORD || '',
    base: (env.MQTT_BASE_TOPIC || 'firefly_dashboard').replace(/\/+$/, ''),
    prefix: (env.MQTT_DISCOVERY_PREFIX || 'homeassistant').replace(/\/+$/, ''),
    interval: Math.max(60, Number(env.MQTT_PUBLISH_INTERVAL) || 1800),
    accounts: String(env.MQTT_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    month: /^gehalt/i.test(env.MQTT_MONTH || '') ? 'gehalt' : 'kalender',
    publicUrl: env.PUBLIC_URL || '',
    send: {
      balances: bool(env.MQTT_SEND_BALANCES, true),
      month: bool(env.MQTT_SEND_MONTH, true),
      budgets: bool(env.MQTT_SEND_BUDGETS, true),
      recurring: bool(env.MQTT_SEND_RECURRING, true),
    },
  };
}

/** Schlüssel für ein Konto im State-JSON: „Girokonto“ → girokonto, „Tagesgeld Bank“ → tagesgeld_bank. */
export function accountKey(name, id) {
  const slug = String(name || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || `konto_${id}`;
}

/** Zeitpunkt mit Zeitzone, z. B. 2026-11-05T10:00:00+01:00 (für device_class timestamp). */
function localIso(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

// Sensoren: Schlüssel im State-JSON → Discovery. Geldwerte ohne state_class (keine HA-Statistik für Kontostände).
const SENSORS = [
  { key: 'nettovermoegen', name: 'Nettovermögen', money: true, icon: 'mdi:bank' },
  { key: 'monat_ausgaben', name: 'Ausgaben diesen Monat', money: true, icon: 'mdi:cart-outline', attrs: { vormonat_bis_heute: 'vormonat_ausgaben_bis_heute', abweichung_pct: 'monat_ausgaben_vs_vormonat_pct', zeitraum: 'monat_zeitraum' } },
  { key: 'monat_einnahmen', name: 'Einnahmen diesen Monat', money: true, icon: 'mdi:cash-plus' },
  { key: 'monat_saldo', name: 'Saldo diesen Monat', money: true, icon: 'mdi:scale-balance' },
  { key: 'prognose_monatsende_saldo', name: 'Prognose Monatsende', money: true, icon: 'mdi:chart-line' },
  { key: 'budget_max_auslastung_pct', name: 'Budget-Auslastung (max.)', unit: '%', icon: 'mdi:gauge', attrs: { budget: 'budget_max_name' } },
  { key: 'budgets_ueberschritten', name: 'Budgets überschritten', icon: 'mdi:alert' },
  { key: 'naechste_wiederkehrende', name: 'Nächste wiederkehrende Zahlung', deviceClass: 'date', icon: 'mdi:calendar-clock', attrs: { titel: 'naechste_wiederkehrende_titel', betrag: 'naechste_wiederkehrende_betrag' } },
  { key: 'naechste_kuendigungsfrist', name: 'Nächste Kündigungsfrist', deviceClass: 'date', icon: 'mdi:file-sign', attrs: { vertrag: 'naechste_kuendigungsfrist_titel' } },
  { key: 'wiederkehrende_7_tage_summe', name: 'Wiederkehrende Zahlungen 7 Tage', money: true, icon: 'mdi:calendar-sync' },
  { key: 'unkategorisiert', name: 'Unkategorisierte Buchungen', icon: 'mdi:tag-off' },
  { key: 'letzte_buchung', name: 'Letzte Buchung', deviceClass: 'date', diagnostic: true, icon: 'mdi:calendar-check' },
  { key: 'stand', name: 'Datenstand', deviceClass: 'timestamp', diagnostic: true },
];

// Felder je Gruppe (MQTT_SEND_…) – schlägt eine Gruppe fehl, bleiben ihre letzten Werte stehen
const GROUPS = {
  balances: ['nettovermoegen', 'konten'],
  month: ['monat_ausgaben', 'monat_einnahmen', 'monat_saldo', 'vormonat_ausgaben_bis_heute', 'monat_ausgaben_vs_vormonat_pct', 'prognose_monatsende_saldo', 'monat_zeitraum', 'unkategorisiert'],
  budgets: ['budget_max_auslastung_pct', 'budget_max_name', 'budgets_ueberschritten'],
  recurring: ['naechste_wiederkehrende', 'naechste_wiederkehrende_titel', 'naechste_wiederkehrende_betrag', 'wiederkehrende_7_tage_summe', 'naechste_kuendigungsfrist', 'naechste_kuendigungsfrist_titel'],
};

/** Discovery-Nachrichten zum State (nur für Felder, die es gibt). accounts: [{ id, name, key }]. */
export function buildDiscovery(state, cfg, accounts = []) {
  const stateTopic = `${cfg.base}/state`;
  const device = {
    identifiers: ['firefly_dashboard'],
    name: 'Firefly Finanzen',
    manufacturer: 'Firefly Dashboard',
    model: 'Firefly III',
    ...(cfg.publicUrl ? { configuration_url: cfg.publicUrl } : {}),
  };
  const config = (object, extra) => ({
    topic: `${cfg.prefix}/sensor/firefly_dashboard/${object}/config`,
    payload: {
      unique_id: `firefly_dashboard_${object}`,
      has_entity_name: true,
      state_topic: stateTopic,
      availability_topic: `${cfg.base}/status`,
      device,
      ...extra,
    },
  });
  const money = { device_class: 'monetary', unit_of_measurement: 'EUR' };
  const out = [];
  for (const s of SENSORS) {
    if (!(s.key in state)) continue;
    out.push(config(s.key, {
      name: s.name,
      value_template: `{{ value_json.get('${s.key}') }}`,
      ...(s.money ? money : {}),
      ...(s.unit ? { unit_of_measurement: s.unit } : {}),
      ...(s.deviceClass ? { device_class: s.deviceClass } : {}),
      ...(s.icon ? { icon: s.icon } : {}),
      ...(s.diagnostic ? { entity_category: 'diagnostic' } : {}),
      ...(s.attrs ? {
        json_attributes_topic: stateTopic,
        json_attributes_template: `{{ { ${Object.entries(s.attrs).map(([k, v]) => `'${k}': value_json.get('${v}')`).join(', ')} } | tojson }}`,
      } : {}),
    }));
  }
  for (const a of accounts) {
    if (!(state.konten && a.key in state.konten)) continue;
    out.push(config(`konto_${a.id}`, {
      name: `Konto ${a.name}`,
      value_template: `{{ value_json.konten.get('${a.key}') }}`,
      ...money,
      icon: 'mdi:bank-outline',
    }));
  }
  return out;
}

export function createMqtt({ dataDir, firefly, config = readConfig(), log = console.log }) {
  const cfg = config;
  const settings = jsonFile(path.join(dataDir, 'settings.json'), { payday: 24 });
  const goalsFile = jsonFile(path.join(dataDir, 'goals.json'), { goals: {} });
  const recurringFile = jsonFile(path.join(dataDir, 'recurring.json'), { hidden: [], manual: [], vertraege: {} });
  const memory = jsonFile(path.join(dataDir, 'mqtt.json'), { topics: [] }); // gesendete Discovery – zum Aufräumen

  // ---- Daten (über den Proxy-Zwischenspeicher, Vorrang hinter der Oberfläche) ----------
  const getJson = async (apiPath, params) => {
    const r = await firefly.get(apiPath, params, { priority: 'warm' });
    if (r.status >= 400) throw new Error(`Firefly ${apiPath}: HTTP ${r.status}`);
    return JSON.parse(r.body.toString('utf8'));
  };
  const getAll = async (apiPath, params) => {
    const pages = async (p) => {
      const first = await getJson(apiPath, { ...p, limit: PAGE_SIZE, page: 1 });
      const n = first?.meta?.pagination?.total_pages || 1;
      const rest = await Promise.all(Array.from({ length: n - 1 }, (_, i) => getJson(apiPath, { ...p, limit: PAGE_SIZE, page: i + 2 })));
      return [first, ...rest].flatMap((r) => r?.data || []);
    };
    if (!params?.start) return pages(params || {});
    // Buchungen je Kalendermonat wie Oberfläche und Vorwärmen (gleiche Cache-Einträge)
    return (await Promise.all(monthChunks(params.start, params.end).map(([start, end]) => pages({ ...params, start, end })))).flat();
  };
  const flatten = (groups) => groups.flatMap((g) => (g.attributes?.transactions || []).map((t) => ({ groupId: g.id, ...t, amount: Number(t.amount) })));
  const value = (x) => Math.abs(Number(x.difference_float ?? x.difference)) || 0;
  /** insight/… über einen Zeitraum, je Monat abgefragt und zusammengezählt (wie public/js/api.js). */
  const insight = async (kind, what, s, e) => {
    const lists = await Promise.all(pastMonthChunks(isoDate(s), isoDate(e)).map(([start, end]) => getJson(`insight/${kind}/${what}`, { start, end })));
    const out = new Map();
    for (const x of lists.flat()) {
      const key = `${x.id ?? ''}|${x.currency_code ?? ''}`;
      const cur = out.get(key);
      if (cur) cur.difference_float += value(x);
      else out.set(key, { ...x, difference_float: value(x) });
    }
    return [...out.values()];
  };
  const eur = (list) => list.filter((x) => x.currency_code === 'EUR' || list.length === 1).reduce((a, x) => a + value(x), 0);

  /** Laufender Monat (Kalender- oder Gehaltsmonat) als Zeitraum wie in der Oberfläche. */
  const currentPeriod = () => {
    const model = cfg.month === 'gehalt' ? monthModel(settings.read().payday || 24) : monthModel(1);
    const [start, end] = model.range(model.keyOf(today()));
    return { start, end, model };
  };

  let accountsSeen = []; // [{ id, name, key }] – für die Discovery der Konto-Sensoren
  const missingLogged = new Set();

  const parts = {
    async balances(state) {
      const t0 = today();
      // Nettovermögen wie die Übersicht: summary/basic über den Stichtag (heute)
      const range = [t0, t0];
      const [summary, accounts] = await Promise.all([
        getJson('summary/basic', { start: isoDate(range[0]), end: isoDate(range[1]) }),
        cfg.accounts.length ? getAll('accounts', { type: 'asset' }) : [],
      ]);
      const nets = Object.entries(summary || {}).filter(([k]) => k.startsWith('net-worth-in-')).map(([, v]) => v);
      const net = nets.find((v) => v.currency_code === 'EUR') || nets.sort((a, b) => Math.abs(b.monetary_value) - Math.abs(a.monetary_value))[0];
      if (net) state.nettovermoegen = round(Number(net.monetary_value));
      if (cfg.accounts.length) {
        state.konten = {};
        const used = new Set();
        accountsSeen = [];
        for (const id of cfg.accounts) {
          const a = accounts.find((x) => String(x.id) === id);
          if (!a) {
            if (!missingLogged.has(id)) log(`MQTT: Konto ${id} aus MQTT_ACCOUNTS nicht gefunden (nur Bestandskonten).`);
            missingLogged.add(id);
            continue;
          }
          let key = accountKey(a.attributes.name, a.id);
          if (used.has(key)) key = `${key}_${a.id}`;
          used.add(key);
          state.konten[key] = round(Number(a.attributes.current_balance));
          accountsSeen.push({ id: a.id, name: a.attributes.name, key });
        }
      }
    },

    async month(state, period) {
      const t0 = today();
      const [ps, pe] = previousRange(period);
      const [inc, out, prevOut, txs] = await Promise.all([
        insight('income', 'total', period.start, period.end).then(eur),
        insight('expense', 'total', period.start, period.end).then(eur),
        insight('expense', 'total', ps, pe).then(eur),
        getAll('transactions', { start: isoDate(period.start), end: isoDate(t0 < period.end ? t0 : period.end), type: 'withdrawal' }).then(flatten),
      ]);
      state.monat_ausgaben = round(out);
      state.monat_einnahmen = round(inc);
      state.monat_saldo = round(inc - out);
      state.vormonat_ausgaben_bis_heute = round(prevOut);
      state.monat_ausgaben_vs_vormonat_pct = prevOut ? Math.round(((out - prevOut) / prevOut) * 1000) / 10 : null;
      state.monat_zeitraum = `${isoDate(period.start)}/${isoDate(period.end)}`;
      // Prognose wie die Übersicht (Schalter „Prognose“): bisher + Ø des Rests in den Vormonaten
      if (t0 < period.end) {
        const totalOf = (kind) => (s, e) => insight(kind, 'total', s, e);
        const [fcIn, fcOut] = await Promise.all([forecastTotalWith(totalOf('income'), period), forecastTotalWith(totalOf('expense'), period)]);
        state.prognose_monatsende_saldo = round(inc - out + fcIn('EUR') - fcOut('EUR'));
      } else {
        state.prognose_monatsende_saldo = state.monat_saldo;
      }
      state.unkategorisiert = txs.filter((t) => t.type === 'withdrawal' && !t.category_id && !t.category_name).length;
    },

    async budgets(state, period) {
      // „Budgets“ sind die Ziele je Kategorie aus dem Dashboard (Monatsbetrag), nicht Firefly-Budgets
      const goals = Object.entries(goalsFile.read().goals || {}).filter(([, g]) => Number(g.amount) > 0);
      if (!goals.length) return;
      const [cats, none] = await Promise.all([
        insight('expense', 'category', period.start, period.end),
        insight('expense', 'no-category', period.start, period.end).catch(() => []),
      ]);
      const spent = new Map(cats.filter((c) => c.currency_code === 'EUR' || cats.length === 1).map((c) => [String(c.id), value(c)]));
      spent.set('0', eur(none));
      const status = goals.map(([id, g]) => ({ name: g.name, ...goalStatus(spent.get(id) || 0, Number(g.amount), period) }));
      const max = status.sort((a, b) => b.used - a.used)[0];
      state.budget_max_auslastung_pct = Math.round(max.used * 100);
      state.budget_max_name = max.name;
      state.budgets_ueberschritten = status.filter((s) => s.used > 1).length;
    },

    async recurring(state) {
      const t0 = today();
      // 24 Monate Ausgaben wie „Wiederkehrend“ und die Warnungen (gleicher, vorgewärmter Cache)
      const from = new Date(t0.getFullYear(), t0.getMonth() - 24, 1);
      const txs = flatten(await getAll('transactions', { start: isoDate(from), end: isoDate(t0), type: 'withdrawal' })).filter((t) => t.type === 'withdrawal');
      const { items } = applyOverrides(detectRecurring(txs, 'expense', 'normal').items, recurringFile.read(), 'expense', t0);
      const euro = items.filter((r) => r.code === 'EUR');
      const next = upcomingBetween(euro, t0, addDays(t0, 400))[0];
      state.naechste_wiederkehrende = next ? isoDate(next.date) : null;
      state.naechste_wiederkehrende_titel = next ? next.name : null;
      state.naechste_wiederkehrende_betrag = next ? round(next.amount) : null;
      // nächste Kündigungsfrist (Vertragsdaten von der Seite „Wiederkehrend“)
      const frist = items.map((r) => ({ r, dl: contractDeadline(r.vertrag, t0) })).filter((x) => x.dl && x.dl.tage >= 0).sort((a, b) => a.dl.frist - b.dl.frist)[0];
      state.naechste_kuendigungsfrist = frist ? isoDate(frist.dl.frist) : null;
      state.naechste_kuendigungsfrist_titel = frist ? frist.r.name : null;
      state.wiederkehrende_7_tage_summe = round(upcomingBetween(euro, t0, addDays(t0, 6)).reduce((a, r) => a + r.amount, 0));
    },
  };

  let last = null; // { state, discovery, at }
  let lastError = null;

  /** State-JSON neu berechnen. Eine fehlerhafte Gruppe behält ihre letzten Werte. */
  async function buildState() {
    const period = currentPeriod();
    const state = {};
    await Promise.all(Object.entries(parts).filter(([group]) => cfg.send[group]).map(async ([group, fn]) => {
      const part = {};
      try {
        await fn(part, period);
        Object.assign(state, part);
      } catch (err) {
        lastError = `${group}: ${err.message}`;
        log(`MQTT: ${group} nicht berechnet (${err.message}) – letzte Werte bleiben.`);
        for (const k of GROUPS[group]) if (last?.state && k in last.state) state[k] = last.state[k];
      }
    }));
    // letzte Buchung (Import vergessen?) – neueste Buchung der letzten 90 Tage
    try {
      const t0 = today();
      const recent = await getJson('transactions', { start: isoDate(addDays(t0, -90)), end: isoDate(t0), type: 'all', limit: 1, page: 1 });
      const date = recent?.data?.[0]?.attributes?.transactions?.[0]?.date;
      state.letzte_buchung = date ? isoDate(parseDate(date)) : null;
    } catch {
      if (last?.state && 'letzte_buchung' in last.state) state.letzte_buchung = last.state.letzte_buchung;
    }
    state.stand = localIso();
    return state;
  }

  // ---- Verbindung -----------------------------------------------------------------
  let client = null;
  let connected = false;
  let backoff = 5000;
  let timer = null;
  let soonTimer = null;
  let building = null;
  let lastLoggedError = '';
  let discoveryKeys = '';

  const publish = (topic, payload) => new Promise((resolve) => {
    if (!client || !connected) return resolve(false);
    client.publish(topic, payload, { retain: true, qos: 1 }, (err) => resolve(!err));
  });

  async function sendDiscovery(discovery) {
    const topics = discovery.map((d) => d.topic);
    for (const d of discovery) await publish(d.topic, JSON.stringify(d.payload));
    // Sensoren, die es nicht mehr gibt (Gruppe abgeschaltet, Konto entfernt): leere Nachricht löscht sie in HA
    const old = memory.read().topics || [];
    for (const t of old.filter((x) => !topics.includes(x) && x.startsWith(`${cfg.prefix}/`))) await publish(t, '');
    memory.write({ topics });
    discoveryKeys = topics.join('|');
  }

  /** Neu rechnen und senden; withDiscovery: Discovery auf jeden Fall erneut senden. */
  function run({ withDiscovery = false } = {}) {
    building ||= (async () => {
      try {
        const state = await buildState();
        const discovery = buildDiscovery(state, cfg, accountsSeen);
        last = { state, discovery, at: new Date().toISOString() };
        if (!connected) return;
        if (withDiscovery || discovery.map((d) => d.topic).join('|') !== discoveryKeys) await sendDiscovery(discovery);
        await publish(`${cfg.base}/state`, JSON.stringify(state));
        lastError = null;
      } catch (err) {
        lastError = err.message;
        log(`MQTT: Senden fehlgeschlagen (${err.message})`);
      } finally {
        building = null;
      }
    })();
    return building;
  }

  /** Nach einem Import oder Abgleich: bald neu senden (gebündelt, Firefly hat dann die neuen Daten). */
  function soon(ms = 20_000) {
    if (!client) return;
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => run(), ms);
    soonTimer.unref?.();
  }

  async function start() {
    if (!cfg.enabled) return;
    if (!cfg.url) return log('MQTT: MQTT_ENABLED ist an, aber MQTT_URL fehlt – keine Verbindung.');
    let mqtt;
    try {
      mqtt = (await import('mqtt')).default;
    } catch (err) {
      return log(`MQTT: Paket „mqtt“ nicht installiert (npm install) – ${err.message}`);
    }
    const status = `${cfg.base}/status`;
    client = mqtt.connect(cfg.url, {
      username: cfg.user || undefined,
      password: cfg.password || undefined,
      clientId: `firefly_dashboard_${Math.random().toString(16).slice(2, 10)}`,
      will: { topic: status, payload: 'offline', retain: true, qos: 1 },
      reconnectPeriod: backoff,
      connectTimeout: 15_000,
    });
    client.on('connect', () => {
      connected = true;
      backoff = 5000;
      client.options.reconnectPeriod = backoff;
      lastLoggedError = '';
      log(`MQTT: verbunden mit ${safeUrl()}`);
      client.publish(status, 'online', { retain: true, qos: 1 });
      client.subscribe(`${cfg.prefix}/status`);
      run({ withDiscovery: true });
    });
    // Home Assistant neu gestartet → Discovery und State erneut senden (leicht verzögert)
    client.on('message', (topic, payload) => {
      if (topic === `${cfg.prefix}/status` && payload.toString() === 'online') setTimeout(() => run({ withDiscovery: true }), 2000 + Math.random() * 3000);
    });
    client.on('close', () => {
      if (connected) log('MQTT: Verbindung getrennt – neuer Versuch folgt.');
      connected = false;
      // Backoff: 5 s, 10 s, 20 s … höchstens 5 min
      client.options.reconnectPeriod = backoff;
      backoff = Math.min(backoff * 2, 300_000);
    });
    client.on('error', (err) => {
      if (err.message === lastLoggedError) return; // dieselbe Meldung nicht bei jedem Versuch
      lastLoggedError = err.message;
      lastError = err.message;
      log(`MQTT: ${err.message}`);
    });
    timer = setInterval(() => run(), cfg.interval * 1000);
    timer.unref();
  }

  /** Beim Beenden „offline“ melden (der Last Will greift sonst erst, wenn der Broker es merkt). */
  async function stop() {
    clearInterval(timer);
    clearTimeout(soonTimer);
    if (!client) return;
    if (connected) await new Promise((r) => client.publish(`${cfg.base}/status`, 'offline', { retain: true, qos: 1 }, r));
    await new Promise((r) => client.end(false, {}, r));
  }

  const safeUrl = () => cfg.url.replace(/\/\/[^@/]*@/, '//');

  async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return json(405, { message: 'Nur lesend.' });
    if (url.searchParams.get('vorschau') === '1' || !last) {
      const state = await buildState();
      last = { state, discovery: buildDiscovery(state, cfg, accountsSeen), at: new Date().toISOString() };
    }
    return json(200, {
      enabled: cfg.enabled,
      url: cfg.url ? safeUrl() : null,
      connected,
      intervalSeconds: cfg.interval,
      month: cfg.month,
      groups: cfg.send,
      lastError,
      at: last.at,
      stateTopic: `${cfg.base}/state`,
      state: last.state,
      discovery: last.discovery,
    });
  }

  start().catch((err) => log(`MQTT: ${err.message}`));
  return { handle, soon, stop, run, buildState };
}
