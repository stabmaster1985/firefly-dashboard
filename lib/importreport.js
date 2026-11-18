// Import-Bericht: Nach jedem Import prüft der Server, ob die Daten stimmen – ohne dass jemand die
// Oberfläche öffnet. Gedacht für den n8n-Import-Workflow:
//
//   POST /local/importbericht?name=umsaetze.csv   Rohdaten einer Bank-CSV → ins CSV-Archiv, Prüfung geplant
//   POST /local/importbericht                     { pruefen: true, warten?: Sekunden } → Prüfung planen
//   GET  /local/importbericht                     { bericht, laeuft, geplant }
//
// Geprüft wird (Firefly frisch, nicht aus dem Zwischenspeicher):
//   - je Konto mit CSV im Archiv: Kontostand laut Bank („Saldo nach Buchung“) gegen Firefly
//   - doppelte Buchungen der letzten Wochen (auch Umbuchungen aus beiden Konten)
//   - falsch zugeordnete Gegenkonten der letzten Wochen
//   - neue Händler ohne Kategorie
// Das Ergebnis liegt in DATA_DIR/import-report.json, erscheint unter „Aufgaben“ und geht an Automationen mit
// dem Auslöser „Import-Bericht“ – gibt es keine, bei Problemen an die Automation „Warnungen“.

import fs from 'node:fs';
import path from 'node:path';
import { jsonFile } from './store.js';
import { PAGE_SIZE } from './warmer.js';
import { decodeCsv, readRows, saldoCheck, summarizeSaldo } from '../public/js/csvmatch.js';
import { findDuplicates } from '../public/js/dupcore.js';
import { wrongParties } from '../public/js/partycore.js';

const DAY = 86400000;
const WINDOW_DAYS = 45; // „neu seit dem Import“: Buchungen der letzten Wochen
const DEFAULT_WAIT_S = 60; // Data Importer und Firefly-Regeln nach dem Import kurz arbeiten lassen
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayIso = () => isoOf(Date.now() - new Date().getTimezoneOffset() * 60_000);
const fmtDay = (d) => String(d).slice(0, 10).split('-').reverse().join('.');
const fmtEur = (n) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);
const ibanKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

export function createImportReport({ dataDir, firefly, view, archive, actions, log = console.log }) {
  const file = jsonFile(path.join(dataDir, 'import-report.json'), { bericht: null });
  let timer = null;
  let dueAt = null;
  let running = false;

  // --- Firefly frisch lesen (am Zwischenspeicher vorbei – es geht um den Stand direkt nach dem Import) ---
  const getJson = async (apiPath, params = {}) => {
    const r = await firefly.get(apiPath, params, { fresh: true, priority: 'user' });
    if (r.status >= 400) throw new Error(`Firefly ${apiPath}: HTTP ${r.status}`);
    return JSON.parse(r.body.toString('utf8'));
  };
  const getAll = async (apiPath, params = {}) => {
    const out = [];
    for (let page = 1; page < 400; page++) {
      const d = await getJson(apiPath, { ...params, limit: PAGE_SIZE, page });
      out.push(...(d?.data || []));
      if (page >= (d?.meta?.pagination?.total_pages || 1)) break;
    }
    return out;
  };
  const flatten = (groups) => groups.flatMap((g) => (g.attributes?.transactions || []).map((t) => ({ groupId: g.id, ...t, amount: Number(t.amount) })));
  const readDismissed = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'dismissed.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  /** Kontostand-Vergleich je Konto mit CSV im Archiv. */
  async function checkAccounts(assets) {
    const { files, links } = archive.ensureInfos();
    const byIban = new Map();
    for (const f of files) {
      const own = ibanKey(f.info?.own);
      if (!own) continue;
      if (!byIban.has(own)) byIban.set(own, []);
      byIban.get(own).push(f);
    }
    const out = [];
    for (const [iban, list] of byIban) {
      const acc = assets.find((a) => ibanKey(a.attributes?.iban) === iban) || assets.find((a) => String(a.id) === String(links?.[iban]));
      const name = acc?.attributes?.name || iban;
      const bis = list.map((f) => f.info?.to).filter(Boolean).sort().at(-1) || null;
      if (!acc) {
        out.push({ iban, name, ok: null, hinweis: 'kein Firefly-Konto mit dieser IBAN – im CSV-Abgleich zuordnen', bis });
        continue;
      }
      const rows = [];
      for (const f of list) {
        const buf = archive.readFile(f.id);
        if (buf) rows.push(...readRows(decodeCsv(buf), f.name).rows);
      }
      const withSaldo = rows.filter((r) => r.saldo !== null);
      if (!withSaldo.length) {
        out.push({ iban, name, ok: null, hinweis: 'CSV ohne Spalte „Saldo nach Buchung“ – kein Kontostand-Vergleich', bis });
        continue;
      }
      const first = withSaldo.map((r) => r.book).sort()[0];
      const t0 = todayIso();
      const [account, txs] = await Promise.all([
        getJson(`accounts/${acc.id}`).then((r) => r.data.attributes),
        getAll(`accounts/${acc.id}/transactions`, { start: isoOf(Date.parse(`${first}T12:00:00Z`) - 7 * DAY), end: t0 }).then(flatten),
      ]);
      const res = saldoCheck(rows, txs, { accountId: acc.id, current: account.current_balance, today: t0 });
      if (!res) {
        out.push({ iban, name, ok: null, hinweis: 'kein Kontostand in den CSV-Dateien', bis });
        continue;
      }
      const sum = summarizeSaldo(res, rows, acc.id);
      archive.setSaldo(iban, sum); // gleiches Ergebnis wie „Neu prüfen“ im CSV-Abgleich
      out.push({
        iban, name, ok: res.ok, bis, bank: res.bank, firefly: res.firefly, diff: res.diff, last: res.last,
        since: res.since, before: res.before, luecke: sum.luecke,
        doppelt: sum.extra.filter((x) => x.twin).length, fehlt: sum.missingCount, zuviel: sum.extraCount,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async function run(grund = '') {
    if (running) return file.read().bericht;
    running = true;
    const t0 = Date.now();
    log(`Import-Bericht: Prüfung startet${grund ? ` (${grund})` : ''}`);
    try {
      firefly.invalidate?.(); // nach dem Import ist alles Zwischengespeicherte überholt
      const since = isoOf(Date.now() - WINDOW_DAYS * DAY);
      const yearAgo = isoOf(Date.now() - 365 * DAY);
      const today = todayIso();
      const assets = await getAll('accounts', { type: 'asset' });
      const konten = await checkAccounts(assets);
      // Buchungen der letzten Wochen: doppelte (auch Umbuchungen aus beiden Konten)
      const recent = (await Promise.all(['withdrawal', 'deposit', 'transfer'].map((type) => getAll('transactions', { start: since, end: today, type }).then(flatten)))).flat();
      const dismissed = readDismissed();
      const dups = findDuplicates(recent, new Set(dismissed.duplicates || [])).filter((p) => p.level >= 2);
      // Falsch zugeordnete Gegenkonten: Kennwörter brauchen ein Jahr Verlauf, gemeldet wird nur, was neu ist
      const year = flatten(await getAll('transactions', { start: yearAgo, end: today, type: 'withdrawal' }));
      const wrong = wrongParties(year, { dismissed: new Set(dismissed.parties || []) })
        .map((r) => ({ party: r.party, txs: r.groups.flatMap((g) => g.txs.filter((t) => String(t.date).slice(0, 10) >= since).map((t) => ({ t, name: g.name }))) }))
        .filter((r) => r.txs.length);
      // neue Händler ohne Kategorie (letzte Buchung in den letzten Wochen)
      let neu = [];
      try {
        const o = await view.overview({ priority: 'user' });
        neu = (o.offen || []).filter((m) => m.key && String(m.last) >= since).slice(0, 20).map((m) => ({ name: m.name, betrag: m.offen, n: m.n }));
      } catch {
        // Monatsbuch aus – dann ohne diese Angabe
      }
      const probleme = [];
      for (const k of konten) {
        if (k.ok === false) {
          probleme.push(`${k.name}: Kontostand weicht um ${fmtEur(k.diff)} ab (Bank ${fmtEur(k.bank)}, Firefly ${fmtEur(k.firefly)})${k.luecke ? ` – für ${fmtDay(k.luecke.von)}–${fmtDay(k.luecke.bis)} fehlt eine CSV-Datei` : k.since ? `, seit ${fmtDay(k.since)}` : ''}${k.doppelt ? ` – ${k.doppelt} vermutlich doppelt` : ''}`);
        }
      }
      if (dups.length) probleme.push(`${dups.length} mögliche doppelte Buchung${dups.length === 1 ? '' : 'en'}${dups.some((d) => d.bothSides) ? ' (u. a. Umbuchung aus beiden Konten)' : ''}`);
      const nWrong = wrong.reduce((a, r) => a + r.txs.length, 0);
      if (nWrong) probleme.push(`${nWrong} Buchung${nWrong === 1 ? '' : 'en'} bei falschem Gegenkonto (${wrong.slice(0, 3).map((r) => r.party).join(', ')})`);
      const hinweise = neu.length ? [`${neu.length} neue${neu.length === 1 ? 'r' : ''} Händler ohne Kategorie: ${neu.slice(0, 5).map((m) => m.name).join(', ')}`] : [];
      const okKonten = konten.filter((k) => k.ok === true).map((k) => k.name);
      const bericht = {
        at: new Date().toISOString(), dauer: Math.round((Date.now() - t0) / 1000), grund,
        status: probleme.length ? 'warnung' : 'ok',
        titel: probleme.length ? `Import-Prüfung: ${probleme.length} Problem${probleme.length === 1 ? '' : 'e'}` : 'Import-Prüfung: alles in Ordnung ✓',
        text: [
          ...probleme,
          ...(okKonten.length ? [`Kontostand stimmt: ${okKonten.join(', ')}`] : []),
          ...hinweise,
        ].join('\n'),
        konten,
        duplikate: dups.slice(0, 20).map((d) => ({ datum: String(d.a.date).slice(0, 10), betrag: Math.abs(d.a.amount), text: `${d.a.description} · ${d.b.description}`.slice(0, 160), umbuchung: Boolean(d.bothSides), gruppen: [d.a.groupId, d.b.groupId] })),
        falscheKonten: wrong.slice(0, 20).map((r) => ({ konto: r.party, anzahl: r.txs.length, haendler: [...new Set(r.txs.map((x) => x.name))].slice(0, 5) })),
        neueHaendler: neu,
      };
      file.write({ bericht });
      log(`Import-Bericht: ${bericht.titel} (${bericht.dauer} s)`);
      await deliver(bericht);
      return bericht;
    } catch (err) {
      const bericht = { at: new Date().toISOString(), status: 'fehler', titel: 'Import-Prüfung fehlgeschlagen', text: err.message, konten: [], duplikate: [], falscheKonten: [], neueHaendler: [], grund };
      file.write({ bericht });
      log(`Import-Bericht: Fehler – ${err.message}`);
      return bericht;
    } finally {
      running = false;
    }
  }

  /** An Automationen „Import-Bericht“ – gibt es keine, Probleme über „Warnungen“ melden. */
  async function deliver(bericht) {
    const list = actions.list();
    const own = list.filter((a) => a.trigger === 'import-report');
    const payload = { typ: 'import_bericht', ...bericht };
    for (const a of own) await actions.run(a.id, { ...payload, daten: payload }).catch(() => {});
    if (own.length || bericht.status === 'ok') return;
    const warn = { typ: 'warnung', art: 'import_bericht', key: `import:${bericht.at}`, titel: bericht.titel, text: bericht.text, datum: bericht.at.slice(0, 10), details: { konten: bericht.konten } };
    for (const a of list.filter((x) => x.trigger === 'alerts')) await actions.run(a.id, { ...warn, daten: warn }).catch(() => {});
  }

  /** Prüfung planen – mehrere Dateien kurz hintereinander lösen nur eine Prüfung aus. */
  function schedule(waitS = DEFAULT_WAIT_S, grund = '') {
    const ms = Math.max(0, Math.min(3600, Number(waitS) || 0)) * 1000;
    clearTimeout(timer);
    dueAt = new Date(Date.now() + ms).toISOString();
    timer = setTimeout(() => {
      dueAt = null;
      run(grund);
    }, ms);
    timer.unref?.();
    return dueAt;
  }

  const readBody = (req, max) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('Anfrage zu groß.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt (Header X-Requested-With: firefly-dashboard fehlt).' });
    try {
      if (req.method === 'GET') return json(200, { ...file.read(), laeuft: running, geplant: dueAt });
      if (req.method !== 'POST') return json(405, { message: 'Nicht erlaubt.' });
      const type = String(req.headers['content-type'] || '');
      const buf = await readBody(req, 30 * 1024 * 1024);
      // Bank-CSV: ins Archiv, Prüfung planen
      if (!/json/.test(type) && buf.length) {
        const r = archive.addFile(buf, url.searchParams.get('name'), { withInfo: true });
        const geplant = url.searchParams.get('pruefen') === '0' ? null : schedule(url.searchParams.get('warten') ?? DEFAULT_WAIT_S, 'nach Import');
        return json(200, { ok: true, datei: r.file.name, schonImArchiv: r.duplicate, konto: r.file.info?.own || null, zeitraum: r.file.info ? [r.file.info.from, r.file.info.to] : null, geplant });
      }
      const input = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      if (input.pruefen || !buf.length) {
        const geplant = schedule(input.warten ?? (input.jetzt ? 0 : DEFAULT_WAIT_S), input.grund ? String(input.grund).slice(0, 80) : 'angefordert');
        return json(200, { ok: true, geplant });
      }
      return json(400, { message: 'Erwartet: CSV-Datei als Inhalt oder { "pruefen": true }.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  }
  return Object.assign(handle, { run, schedule, last: () => file.read().bericht });
}
