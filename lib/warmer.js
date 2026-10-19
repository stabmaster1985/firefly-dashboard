// Lädt im Hintergrund vor, was die Seiten typischerweise brauchen – damit
// der erste Klick nicht auf Firefly warten muss. Die Abfragen entsprechen
// exakt denen der Oberfläche (gleiche Parameter → gleicher Cache-Eintrag).

export const PAGE_SIZE = 250; // muss zu public/js/api.js passen

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfMonth = (d, o = 0) => new Date(d.getFullYear(), d.getMonth() + o, 1);
const endOfMonth = (d, o = 0) => new Date(d.getFullYear(), d.getMonth() + o + 1, 0);

function jobs() {
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

  // Laufender Monat (Standard-Zeitraum) inkl. Vergleich
  const cur = range(startOfMonth(t), endOfMonth(t));
  add('summary/basic', cur);
  add('transactions', { ...cur, type: 'all', limit: 10 });
  const prevEnd = new Date(t.getFullYear(), t.getMonth() - 1, Math.min(t.getDate(), endOfMonth(t, -1).getDate()));
  for (const kind of ['expense', 'income']) add(`insight/${kind}/total`, range(startOfMonth(t, -1), prevEnd));
  for (const kind of ['expense', 'income']) {
    for (const what of ['category', 'no-category']) add(`insight/${kind}/${what}`, range(startOfMonth(t, -1), prevEnd));
  }

  // Monatswerte der letzten 13 Monate (Diagramme, Matrix, Detailseiten)
  for (let i = 0; i <= 12; i++) {
    const m = range(startOfMonth(t, -i), endOfMonth(t, -i));
    for (const kind of ['expense', 'income']) {
      for (const what of ['category', 'no-category', 'total', 'tag']) add(`insight/${kind}/${what}`, m);
    }
  }
  return list;
}

/** Große Listen (24 Monate Buchungen für „Wiederkehrend“) seitenweise vorladen. */
async function warmPaged(firefly, path, params) {
  const first = await firefly.warm(path, { ...params, limit: PAGE_SIZE, page: 1 });
  let pages = 1;
  try {
    pages = JSON.parse(first.body.toString('utf8'))?.meta?.pagination?.total_pages || 1;
  } catch {
    return;
  }
  for (let p = 2; p <= pages; p++) await firefly.warm(path, { ...params, limit: PAGE_SIZE, page: p });
}

export function startWarmer(firefly, { minutes = 10, log = console.log } = {}) {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      await Promise.all(jobs().map(([path, params]) => firefly.warm(path, params).catch(() => {})));
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      const from = iso(startOfMonth(t, -24));
      for (const type of ['withdrawal', 'deposit']) {
        await warmPaged(firefly, 'transactions', { start: from, end: iso(t), type }).catch(() => {});
      }
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
