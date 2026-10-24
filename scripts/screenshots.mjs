#!/usr/bin/env node
// Screenshots für die README neu erzeugen:  npm run screenshots
//
// Startet die Demo auf eigenen Ports mit frischem Datenverzeichnis (Stand aus mock/demo-data:
// Automationen, KI-Bewertungen), erzeugt Beispiel-CSV-Dateien aus den Demo-Buchungen und nimmt
// die Seiten auf – nach docs/screenshots. Nur Demo-Daten, nie echte Finanzen.
//
// Braucht Playwright mit Chromium (nicht Teil der Abhängigkeiten): global installiert oder über
// PLAYWRIGHT_MODULE=/pfad/zu/playwright/index.mjs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = Number(process.env.SHOT_PORT || 8188);
const MOCK_PORT = Number(process.env.SHOT_MOCK_PORT || 8198);
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${MOCK_PORT}/api/v1`;
const GIRO_IBAN = 'DE89 3704 0044 0532 0130 00';
const TAGESGELD_IBAN = 'DE12 5001 0517 5407 3249 31';

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => {
  console.error('Playwright nicht gefunden – installieren oder PLAYWRIGHT_MODULE setzen.');
  process.exit(1);
});

// ---- Demo starten -------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffd-shots-'));
for (const f of fs.readdirSync(path.join(ROOT, 'mock', 'demo-data'))) {
  const text = fs.readFileSync(path.join(ROOT, 'mock', 'demo-data', f), 'utf8').replaceAll('localhost:8090', `localhost:${MOCK_PORT}`);
  fs.writeFileSync(path.join(dataDir, f), text);
}
const demo = spawn(process.execPath, ['mock/demo.js'], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), MOCK_PORT: String(MOCK_PORT), DATA_DIR: dataDir, UPDATE_CHECK: '0', WARM_MINUTES: '0', DASHBOARD_PASSWORD: '' },
});
const stop = () => {
  demo.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', stop);
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    console.error(err);
    process.exit(1); // „exit“ räumt die Demo auf
  });
}
for (let i = 0; ; i++) {
  if (await fetch(`${BASE}/config.json`).then((r) => r.ok).catch(() => false)) break;
  if (i > 100) throw new Error('Demo startet nicht.');
  await new Promise((r) => setTimeout(r, 200));
}

// ---- Beispiel-CSV (VR-Bank-Format) aus den Demo-Buchungen ------------------------
const iso = (d) => d.toISOString().slice(0, 10);
const month = (offset, end = false) => {
  const t = new Date();
  return new Date(Date.UTC(t.getFullYear(), t.getMonth() + offset + (end ? 1 : 0), end ? 0 : 1));
};
async function withdrawals(start, end) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${API}/transactions?type=withdrawal&start=${iso(start)}&end=${iso(end)}&limit=250&page=${page}`, { headers: { Authorization: 'Bearer demo' } }).then((x) => x.json());
    out.push(...r.data.flatMap((g) => g.attributes.transactions));
    if (page >= r.meta.pagination.total_pages) return out.filter((t) => t.source_name === 'Girokonto');
  }
}
const de = (iso10) => iso10.slice(0, 10).split('-').reverse().join('.');
const csvRow = (t, { konto = 'Girokonto', iban = GIRO_IBAN } = {}) => {
  const name = /^\(.*\)$/.test(t.destination_name) ? String(t.notes || '').split('//')[0] : t.destination_name;
  const purpose = String(t.notes || t.description).replaceAll('"', '');
  return [konto, iban, 'GENODEM1DOR', 'Dortmunder Volksbank', de(t.date), de(t.date), name, 'DE99 1111 2222 3333', '', t.description, `"${purpose}"`,
    `-${Number(t.amount).toFixed(2).replace('.', ',')}`, 'EUR', '', '', '', '', '', ''].join(';');
};
const HEADER = 'Bezeichnung Auftragskonto;IBAN Auftragskonto;BIC Auftragskonto;Bankname Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;BIC (SWIFT-Code) Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung;Bemerkung;Kategorie;Steuerrelevant;Glaeubiger ID;Mandatsreferenz';
const csvDir = path.join(dataDir, 'csv');
fs.mkdirSync(path.join(csvDir, 'alt'), { recursive: true });
const recent = await withdrawals(month(-2), new Date());
const older = await withdrawals(month(-6), month(-4, true)); // Lücke im Monat dazwischen
const write = (file, rows) => fs.writeFileSync(path.join(csvDir, file), `${[HEADER, ...rows].join('\n')}\n`);
write('Umsaetze.csv', recent.map((t) => csvRow(t)));
write('alt/Umsaetze.csv', older.map((t) => csvRow(t)));
// Datei mit drei Buchungen, die es in Firefly nicht gibt
const fake = (amount, i) => csvRow({ ...recent[0], amount, description: 'Einkauf Testladen', destination_name: `Testladen ${i}`, notes: null });
write('fehlt.csv', [...recent.slice(0, 9).map((t) => csvRow(t)), fake(12.34, 1), fake(56.78, 2), fake(9.99, 3)]);
write('tagesgeld.csv', recent.slice(0, 5).map((t) => csvRow(t, { konto: 'Tagesgeld', iban: TAGESGELD_IBAN })));

// ---- Aufnahmen ----------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const desk = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'light' })).newPage();
desk.on('pageerror', (e) => errors.push(e.message));
desk.on('dialog', (d) => d.accept());
const ready = async (p = desk) => {
  for (let i = 0; i < 300; i++) {
    await p.waitForTimeout(100);
    if (await p.evaluate(() => document.querySelector('.page') && !document.querySelector('.page .skeleton'))) break;
  }
  await p.waitForTimeout(700);
};
const shot = (name, p = desk) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
const open = async (route) => {
  await desk.goto(`${BASE}/#/${route}`);
  await ready();
};

await open('');
await shot('uebersicht');
await open('kategorien');
await shot('kategorien');
await open('empfaenger');
await shot('haendler');
await open('jahr');
await shot('jahresrueckblick');

await open('fragen');
for (const q of ['Top 5 Händler der letzten 3 Monate', 'Was habe ich diesen Monat mehr ausgegeben als letzten Monat?']) {
  await desk.fill('#q-input', q);
  await desk.click('#q-send');
  await desk.waitForTimeout(2500);
}
await desk.evaluate(() => (document.querySelector('#q-log').scrollTop = 0));
await shot('fragen');

await open('labor?tab=uebersicht');
await shot('labor');
await open('labor?tab=ki');
const firstGroup = desk.locator('[data-ai-who^="categories:"]').first();
if (await firstGroup.count()) await firstGroup.click();
await desk.waitForTimeout(500);
await desk.evaluate(() => {
  document.querySelector('.ai-new')?.scrollIntoView({ block: 'start' });
  scrollBy(0, -140);
});
await shot('labor-ki');

await open('abgleich');
await desk.setInputFiles('#a-input', ['Umsaetze.csv', 'alt/Umsaetze.csv', 'fehlt.csv', 'tagesgeld.csv'].map((f) => path.join(csvDir, f)));
await desk.waitForSelector('.arch-note');
const giro = GIRO_IBAN.replaceAll(' ', '');
await desk.click(`[data-acc="${giro}"]`);
await desk.click('#a-check-sel');
await desk.waitForFunction(() => !document.querySelector('.arch-busy') && document.querySelector('.arch-status')?.textContent.includes('in Firefly'), null, { timeout: 120000 });
await desk.click(`[data-open="${giro}"]`);
await desk.waitForTimeout(300);
await shot('csv-abgleich');

await open('aufraeumen');
await desk.click('[data-fold="a-import"] .card-fold').catch(() => {});
await desk.waitForTimeout(300);
await desk.evaluate(() => scrollTo(0, 0));
await shot('aufraeumen');

// Handy: hell (Übersicht) und dunkel (Labor), nebeneinander
const phone = [];
for (const [scheme, route] of [['light', ''], ['dark', 'labor?tab=uebersicht']]) {
  const p = await (await browser.newContext({ ...devices['iPhone 13'], colorScheme: scheme })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/#/${route}`);
  await ready(p);
  phone.push((await p.screenshot()).toString('base64'));
}
const pair = await (await browser.newContext({ viewport: { width: 1230, height: 1266 } })).newPage();
await pair.setContent(`<body style="margin:0;background:#f6f6f3;display:flex;gap:60px">${phone.map((b) => `<img src="data:image/png;base64,${b}" style="width:585px;height:1266px">`).join('')}</body>`);
await shot('handy', pair);

await browser.close();
if (errors.length) {
  console.error('Fehler auf den Seiten:', errors);
  process.exitCode = 1;
}
console.log(`Screenshots aktualisiert: ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} Bilder in docs/screenshots`);
process.exit(); // beendet auch die Demo (siehe „exit“)
