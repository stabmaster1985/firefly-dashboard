// Lädt im Hintergrund vor, was die Seiten typischerweise brauchen – damit
// der erste Klick nicht auf Firefly warten muss. Die Abfragen entsprechen
// exakt denen der Oberfläche (gleiche Parameter → gleicher Cache-Eintrag).

import { monthModel } from '../public/js/util.js';

export const PAGE_SIZE = 250; // muss zu public/js/api.js passen

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfMonth = (d, o = 0) => new Date(d.getFullYear(), d.getMonth() + o, 1);

function jobs(paydays = []) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const list = [];
  const add = (path, params = {}) => list.push([path, params]);
  const range = (s, e) => ({ start: iso(s), end: iso(e) });

  // Stammdaten
  add('about');
  add('about/user');
  add('accounts', { type: 'asset', limit: PAGE_SIZE, page: 1 });
  add('categories', { limit: PAGE_SIZE, page: 1 });
  add('tags', { limit: PAGE_SIZE, page: 1 });
  add('accounts', { type: 'liabilities', limit: PAGE_SIZE, page: 1 });
  // Seite „Konten“: Kontostände im laufenden Monat und Vermögensverlauf (Standard 2 Jahre)
  add('chart/account/overview', { start: iso(startOfMonth(t)), end: iso(t), period: '1D' });
  add('chart/account/overview', { start: iso(new Date(t.getFullYear() - 2, t.getMonth() + 1, 1)), end: iso(t), period: '1M' });

  add('summary/basic', range(t, t)); // Nettovermögen heute (Übersicht, MQTT)
  // Nettovermögen zu den Monatsenden der letzten 13 Monate (Übersicht für „Letzter Monat“, „Letztes Jahr“ …)
  for (let i = 1; i <= 13; i++) {
    const end = new Date(t.getFullYear(), t.getMonth() - i + 1, 0);
    add('summary/basic', range(end, end));
  }
  // … und zu den Enden der letzten Gehaltsmonate (Gehaltstag meldet der Browser)
  for (const day of paydays) {
    const model = monthModel(day);
    for (let i = 1; i <= 3; i++) {
      const end = model.range(model.keyOf(t), -i)[1];
      add('summary/basic', range(end, end));
    }
  }
  // Summen und Buchungslisten kommen aus dem Monatsbuch (lib/ledger.js) – das lädt je Monat nur die
  // Buchungen und rechnet selbst; hier bleibt, was nur Firefly liefern kann.
  return list;
}

export function startWarmer(firefly, { minutes = 10, log = console.log, ledger = null, paydays = () => [] } = {}) {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const done = await Promise.all(jobs(paydays()).map(([path, params]) => firefly.warm(path, params).then((r) => [path, params, r]).catch(() => null)));
      // letzte Buchung je Konto (Hinweis „Import vergessen?“ in der Übersicht)
      const accounts = done.find((d) => d && d[0] === 'accounts' && d[1].type === 'asset')?.[2];
      try {
        const ids = JSON.parse(accounts.body.toString('utf8')).data.filter((a) => a.attributes?.active !== false).map((a) => a.id).slice(0, 30);
        await Promise.all(ids.map((id) => firefly.warm(`accounts/${id}/transactions`, { limit: 1, page: 1 }).catch(() => {})));
      } catch {
        // Kontenliste nicht lesbar – beim nächsten Lauf
      }
      // Buchungen der letzten 37 Monate (3 Jahre: reicht für „Letztes Jahr“ samt Vorjahresvergleich)
      if (ledger) await ledger.warm(37);
      log(`Cache vorgewärmt in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } finally {
      running = false;
    }
  }
  setTimeout(run, 2000);
  const timer = setInterval(run, minutes * 60 * 1000);
  timer.unref();
  return run;
}
