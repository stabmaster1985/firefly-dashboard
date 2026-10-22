#!/usr/bin/env node
// Simuliert die benötigten Teile der Firefly-III-API mit erfundenen Demodaten.
// Gedacht zum Ausprobieren des Dashboards ohne eigene Firefly-Instanz:
//   node mock/firefly-mock.js   (lauscht auf Port 8090)

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8090);

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const between = (min, max) => Math.round((min + rand() * (max - min)) * 100) / 100;
const pick = (list) => list[Math.floor(rand() * list.length)];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const ACCOUNTS = [
  { id: '1', name: 'Girokonto', role: 'defaultAsset', iban: 'DE89 3704 0044 0532 0130 00', start: 2450 },
  { id: '2', name: 'Tagesgeld', role: 'savingAsset', iban: 'DE12 5001 0517 5407 3249 31', start: 8200 },
  { id: '3', name: 'Kreditkarte', role: 'ccAsset', iban: '', start: 0 },
  { id: '4', name: 'Bargeld', role: 'cashWalletAsset', iban: '', start: 120 },
];

const BUDGETS = [
  { id: '1', name: 'Lebensmittel', limit: 520 },
  { id: '2', name: 'Freizeit', limit: 220 },
  { id: '3', name: 'Shopping', limit: 250 },
  { id: '4', name: 'Mobilität', limit: 180 },
];

const BILLS = [
  { id: '1', name: 'Miete', amount: 1150, day: 3, freq: 'monthly', account: 'Hausverwaltung Schmidt', category: 'Wohnen' },
  { id: '2', name: 'Strom', amount: 86, day: 15, freq: 'monthly', account: 'Stadtwerke', category: 'Nebenkosten' },
  { id: '3', name: 'Internet', amount: 39.99, day: 8, freq: 'monthly', account: 'Telekom', category: 'Nebenkosten' },
  { id: '4', name: 'Netflix', amount: 13.99, day: 12, freq: 'monthly', account: 'Netflix', category: 'Abos' },
  { id: '5', name: 'Spotify', amount: 10.99, day: 20, freq: 'monthly', account: 'Spotify', category: 'Abos' },
  { id: '6', name: 'Handyvertrag', amount: 24.99, day: 25, freq: 'monthly', account: 'Vodafone', category: 'Nebenkosten' },
  { id: '7', name: 'Hausratversicherung', amount: 96.4, day: 1, freq: 'yearly', month: 2, account: 'HUK-Coburg', category: 'Versicherung' },
  { id: '8', name: 'Kfz-Versicherung', amount: 412.8, day: 1, freq: 'yearly', month: 0, account: 'HUK-Coburg', category: 'Versicherung' },
];

const PIGGIES = [
  { id: '1', name: 'Urlaub Portugal', target: 2500, current: 1840, targetDate: '2027-05-01', account: 'Tagesgeld' },
  { id: '2', name: 'Notgroschen', target: 10000, current: 7250, targetDate: null, account: 'Tagesgeld' },
  { id: '3', name: 'Neues Fahrrad', target: 1800, current: 410, targetDate: '2027-03-15', account: 'Tagesgeld' },
  { id: '4', name: 'Weihnachten', target: 600, current: 600, targetDate: '2026-12-01', account: 'Girokonto' },
];

// --- Buchungen erzeugen ----------------------------------------------------
const today = new Date();
today.setHours(0, 0, 0, 0);
const firstDay = new Date(today.getFullYear(), today.getMonth() - 17, 1);
const journals = [];
let nextId = 1;

function add(date, type, amount, description, source, destination, extra = {}) {
  if (date > today) return;
  journals.push({
    id: String(nextId++),
    date,
    type,
    amount: Math.round(amount * 100) / 100,
    description,
    source,
    destination,
    category: extra.category ?? null,
    budget: extra.budget ?? null,
    tags: extra.tags ?? [],
    notes: extra.notes ?? null,
  });
}

// Gegenkonten (Ausgaben-/Einnahmenkonten) mit festen Kennungen – wie in Firefly
const extIds = new Map(); // "type|name" → id
const extById = new Map(); // id → { type, name }
function extId(type, name) {
  const k = `${type}|${name}`;
  if (!extIds.has(k)) {
    const id = String(1000 + extIds.size);
    extIds.set(k, id);
    extById.set(id, { type, name });
  }
  return extIds.get(k);
}
const extJournals = (e) => journals.filter((j) => (e.type === 'expense' ? j.type === 'withdrawal' && j.destination.name === e.name : j.type === 'deposit' && j.source.name === e.name));

const giro = ACCOUNTS[0];
const tagesgeld = ACCOUNTS[1];
const kk = ACCOUNTS[2];
const cash = ACCOUNTS[3];
const ext = (name) => ({ id: null, name });

for (let m = new Date(firstDay); m <= today; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
  const y = m.getFullYear();
  const mo = m.getMonth();
  const day = (d) => new Date(y, mo, d);

  // Gehalt am 24., fällt der auf ein Wochenende, schon am Freitag davor
  const payday = day(24);
  while (payday.getDay() === 0 || payday.getDay() === 6) payday.setDate(payday.getDate() - 1);
  add(payday, 'deposit', 3850, 'Gehalt', ext('Muster Software GmbH'), giro, { category: 'Gehalt' });
  if (mo === 10) add(day(28), 'deposit', 1925, 'Weihnachtsgeld', ext('Muster Software GmbH'), giro, { category: 'Gehalt' });
  if (rand() < 0.35) add(day(18), 'deposit', between(40, 260), pick(['Kleinanzeigen Verkauf', 'Erstattung Krankenkasse', 'Rückzahlung Paul']), ext(pick(['Kleinanzeigen', 'TK Krankenkasse', 'Paul Weber'])), giro, { category: 'Sonstige Einnahmen' });

  for (const bill of BILLS) {
    if (bill.freq === 'yearly' && bill.month !== mo) continue;
    const amount = bill.name === 'Strom' ? between(78, 94) : bill.amount;
    add(day(bill.day), 'withdrawal', amount, bill.name, giro, ext(bill.account), { category: bill.category, tags: ['Fixkosten'] });
  }

  add(day(2), 'transfer', 400, 'Sparrate', giro, tagesgeld);
  add(day(27), 'transfer', between(180, 420), 'Kreditkartenabrechnung', giro, kk);
  add(day(5), 'withdrawal', 100, 'Bargeldabhebung', giro, ext('Geldautomat'), {});
  add(day(5), 'transfer', 100, 'Bargeld', giro, cash);

  const shops = ['REWE', 'EDEKA', 'Aldi Süd', 'Lidl', 'dm-Drogerie', 'Wochenmarkt'];
  for (let i = 0; i < 9; i++) {
    const shop = pick(shops);
    add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(14, 96), `Einkauf ${shop}`, shop === 'Wochenmarkt' ? cash : giro, ext(shop), { category: 'Lebensmittel', budget: 'Lebensmittel' });
  }
  for (let i = 0; i < 3; i++) {
    const place = pick(['Pizzeria Bella', 'Sushi Bar Koi', 'Café Central', 'Biergarten am See', 'Thai Orchid']);
    add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(18, 74), place, kk, ext(place), { category: 'Restaurant', budget: 'Freizeit' });
  }
  for (let i = 0; i < 2; i++) {
    const what = pick(['Kino', 'Konzertkarten', 'Kletterhalle', 'Museum', 'Schwimmbad']);
    add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(9, 65), what, kk, ext(what), { category: 'Freizeit', budget: 'Freizeit' });
  }
  for (let i = 0; i < 2; i++) {
    add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(48, 82), 'Tanken', giro, ext(pick(['Aral', 'Shell', 'JET'])), { category: 'Mobilität', budget: 'Mobilität' });
  }
  // Zahlungen über PayPal: ein Abo zwischen zufälligen Einkäufen (testet die Erkennung)
  add(day(9 + Math.floor(rand() * 3)), 'withdrawal', 9.99, `PayPal *DisneyPlus ${100000 + Math.floor(rand() * 899999)}`, giro, ext('PayPal Europe S.a.r.l.'), { category: 'Abos' });
  if (rand() < 0.6) add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(12, 140), `PayPal *${pick(['Etsy', 'eBay', 'Steam', 'Vinted'])} ${100000 + Math.floor(rand() * 899999)}`, giro, ext('PayPal Europe S.a.r.l.'), { category: 'Shopping' });
  add(day(1), 'withdrawal', 49, 'Deutschlandticket', giro, ext('Deutsche Bahn'), { category: 'Mobilität', budget: 'Mobilität', tags: ['Fixkosten'] });
  const shoppingCount = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < shoppingCount; i++) {
    const what = pick(['Amazon', 'Zalando', 'IKEA', 'MediaMarkt', 'Thalia']);
    add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(15, 160), `Bestellung ${what}`, kk, ext(what), { category: 'Shopping', budget: 'Shopping' });
  }
  if (rand() < 0.4) add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(10, 90), pick(['Apotheke', 'Zahnarzt Zuzahlung', 'Physiotherapie']), giro, ext('Praxis / Apotheke'), { category: 'Gesundheit' });
  if (mo === 6) add(day(14), 'withdrawal', 1240, 'Sommerurlaub Ostsee', kk, ext('Booking.com'), { category: 'Urlaub', tags: ['Urlaub'] });
  if (rand() < 0.3) add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(20, 60), 'Geschenk', kk, ext(pick(['Thalia', 'Blumen Meyer', 'Amazon'])), { category: 'Geschenke' });
  // Schreibvarianten desselben Händlers (für „Gegenkonten zusammenführen“)
  if (rand() < 0.5) add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(12, 60), 'Einkauf REWE', giro, ext(pick(['REWE SAGT DANKE 4711', 'REWE Markt GmbH'])), { category: 'Lebensmittel' });
  if (rand() < 0.4) add(day(1 + Math.floor(rand() * 28)), 'withdrawal', between(9, 40), 'Einkauf Lidl', giro, ext('LIDL SAGT DANKE'), { category: 'Lebensmittel' });
  // Import ohne „Name Zahlungsbeteiligter“: kein Empfänger, Beschreibung nur Bank-Standardtext,
  // der Händler steht nur in den Notizen (Verwendungszweck) – für die Händlererkennung
  for (let i = 0; i < 3; i++) {
    const d = day(1 + Math.floor(rand() * 28));
    const [shop, city, cat] = pick([['NETTO MARKEN-DISCOUNT', 'MUENCHEN', 'Lebensmittel'], ['BAECKEREI RIEDMAIER', 'MUENCHEN', 'Lebensmittel'],
      ['ROSSMANN 2231', 'PASING', null], ['HORNBACH BAUMARKT', 'GERMERING', null], ['TANKSTELLE ESSO', 'MUENCHEN', 'Mobilität']]);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${10 + Math.floor(rand() * 9)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`;
    add(d, 'withdrawal', between(6, 85), pick(['Kartenzahlung girocard', 'KARTENZAHLUNG']), giro, ext('(no name)'),
      { category: rand() < 0.5 ? cat : null, notes: `${shop}//${city}/DE ${stamp} Folgenr. 0${Math.floor(rand() * 9)} Verfalld. 2027-12 girocard` });
  }
  if (mo % 2 === 1) add(day(12), 'withdrawal', 39.99, 'Basislastschrift', giro, ext('(no name)'),
    { category: 'Nebenkosten', notes: `EREF+INV${100000 + mo} MREF+VF-88812 CRED+DE11ZZZ00000012345 SVWZ+Vodafone Kabel Deutschland Rechnung ${mo + 1}/${y}` });
  // Kita: dasselbe Thema bei verschiedenen Empfängern (für Tag-Vorschläge)
  add(day(3), 'withdrawal', 62, 'Essensgeld Kita Sonnenschein', giro, ext('Stadt Musterstadt'), { category: 'Kinder' });
  if (mo % 3 === 0) add(day(15), 'withdrawal', 30, 'Beitrag Förderverein Kita Sonnenschein', giro, ext('Förderverein Sonnenschein e.V.'), { category: 'Spenden' });
  if (mo === 4 || mo === 9) add(day(20), 'withdrawal', 18, 'Kita Ausflug Tierpark', giro, ext('Busreisen Meyer'), { category: 'Freizeit' });
  // zwei Kategorien für dasselbe (für „zusammenfassen“)
  if (mo === 3) add(day(12), 'withdrawal', 389, 'Inspektion', giro, ext('Autohaus Becker'), { category: 'KFZ' });
  if (mo === 8) add(day(7), 'withdrawal', 141, 'Hauptuntersuchung', giro, ext('TÜV Süd'), { category: 'KFZ' });
  if (mo % 2 === 0) add(day(22), 'withdrawal', between(8, 15), 'Autowäsche', giro, ext('Waschpark Nord'), { category: 'Auto' });
}
// Eine alte Buchung (vor 30 Monaten) – außerhalb der 24 Monate des Labors, nur über die Suche zu finden
journals.push({ id: String(nextId++), date: new Date(today.getFullYear(), today.getMonth() - 30, 12), type: 'withdrawal', amount: 45, description: 'Sommerfest Kita Sonnenschein', source: ACCOUNTS[0], destination: { id: null, name: 'Förderverein Sonnenschein e.V.' }, category: null, budget: null, tags: [], notes: 'Spende Kuchenbasar' });
// Ein Kurzurlaub mit lauter fremden Händlern (für die Reise-Erkennung)
{
  const s = addDays(today, -60);
  const trip = [[0, 'Hotel Lago Riva del Garda', 'Hotel Lago', 412, 'Urlaub'], [0, 'Pizzeria Da Mario Riva del Garda', 'Da Mario', 46.5, 'Restaurant'],
    [1, 'Gelateria Riva del Garda', 'Gelateria Fiore', 9.8, 'Restaurant'], [1, 'Fähre Gardasee Riva', 'Navigazione Laghi', 38, 'Freizeit'],
    [2, 'Supermercato Conad Riva', 'Conad', 54.2, 'Lebensmittel'], [3, 'Ristorante Al Porto Riva del Garda', 'Al Porto', 71, 'Restaurant']];
  for (const [d, desc, party, amount, category] of trip) add(addDays(s, d), 'withdrawal', amount, desc, kk, ext(party), { category });
}
// Eine aktuelle große Ausgabe (für die Warnungen)
add(addDays(today, -4), 'withdrawal', 649, 'Neue Waschmaschine', kk, ext('MediaMarkt'), { category: 'Shopping' });
// Eine doppelt importierte Buchung (für die Dubletten-Erkennung)
{
  const orig = journals.find((j) => j.description.startsWith('Einkauf ') && j.date >= addDays(today, -20));
  if (orig) journals.push({ ...orig, id: String(nextId++), tags: [...orig.tags] });
}
// Bargeld-Konto zuletzt nicht gepflegt (für den Import-Status)
for (let i = journals.length - 1; i >= 0; i--) {
  const j = journals[i];
  if ((j.source === cash || j.destination === cash) && j.date > addDays(today, -26)) journals.splice(i, 1);
}
journals.sort((a, b) => b.date - a.date || Number(b.id) - Number(a.id));
// Ein paar jüngere Buchungen ohne Kategorie (für die Kategorisierungshilfe)
journals.filter((j) => /^Einkauf (REWE|EDEKA)$|^Tanken$|^Netflix$/.test(j.description)).slice(0, 5).forEach((j) => {
  j.category = null;
  j.budget = null;
});

// Zusätzliche Tags für die Tag-Auswertung
for (const j of journals) {
  const add = (tag) => !j.tags.includes(tag) && (j.tags = [...j.tags, tag]);
  if (/Tanken|Kfz/.test(j.description)) add('Auto');
  if (/Bestellung (Amazon|Zalando|MediaMarkt|Thalia)/.test(j.description)) add('Online');
  if (j.category === 'Restaurant' || /Kino|Konzert/.test(j.description)) add('Ausgehen');
  if (j.category === 'Urlaub' || (j.date.getMonth() === 6 && j.category === 'Restaurant')) add(`Urlaub ${j.date.getFullYear()}`);
  if (j.category === 'Geschenke') add('Familie');
}

// Kategorien bekommen feste IDs in alphabetischer Reihenfolge
const CATEGORIES = [...new Set(journals.map((j) => j.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
const categoryId = (name) => String(CATEGORIES.indexOf(name) + 1);
const categoryName = (id) => CATEGORIES[Number(id) - 1];
const TAGS = [...new Set(journals.flatMap((j) => j.tags))].sort((a, b) => a.localeCompare(b, 'de'));
const tagId = (name) => String(TAGS.indexOf(name) + 1);
const tagName = (id) => TAGS[Number(id) - 1] ?? (TAGS.includes(decodeURIComponent(id)) ? decodeURIComponent(id) : undefined);

// --- Hilfsfunktionen für Antworten ------------------------------------------
const fmt = (n) => n.toFixed(2);
const inRange = (j, start, end) => j.date >= start && j.date <= end;
const parseDate = (s, fallback) => {
  if (!s) return fallback;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const dateTime = (d) => `${iso(d)}T00:00:00+02:00`;

function balanceAt(account, date) {
  let bal = account.start;
  for (const j of journals) {
    if (j.date > date) continue;
    if (j.source.id === account.id) bal -= j.amount;
    if (j.destination.id === account.id) bal += j.amount;
  }
  return Math.round(bal * 100) / 100;
}

function eur() {
  return { currency_id: '1', currency_code: 'EUR', currency_symbol: '€', currency_decimal_places: 2 };
}

function journalJson(j) {
  return {
    type: 'transactions',
    id: j.id,
    attributes: {
      created_at: dateTime(j.date),
      updated_at: dateTime(j.date),
      group_title: null,
      transactions: [
        {
          transaction_journal_id: j.id,
          type: j.type,
          date: dateTime(j.date),
          amount: fmt(j.amount),
          description: j.description,
          ...eur(),
          foreign_amount: null,
          source_id: j.source.id,
          source_name: j.source.name,
          source_type: j.source.id ? 'Asset account' : 'Revenue account',
          destination_id: j.destination.id,
          destination_name: j.destination.name,
          destination_type: j.destination.id ? 'Asset account' : 'Expense account',
          category_id: j.category ? categoryId(j.category) : null,
          category_name: j.category,
          budget_name: j.budget,
          tags: j.tags,
          notes: j.notes,
          reconciled: false,
        },
      ],
    },
  };
}

function paginate(items, query, map) {
  const limit = Math.max(1, Math.min(500, Number(query.get('limit') || 50)));
  const page = Math.max(1, Number(query.get('page') || 1));
  const slice = items.slice((page - 1) * limit, page * limit);
  return {
    data: slice.map(map),
    meta: {
      pagination: {
        total: items.length,
        count: slice.length,
        per_page: limit,
        current_page: page,
        total_pages: Math.max(1, Math.ceil(items.length / limit)),
      },
    },
  };
}

function range(query) {
  const start = parseDate(query.get('start'), new Date(today.getFullYear(), today.getMonth(), 1));
  const end = parseDate(query.get('end'), today);
  return [start, end];
}

const isAsset = (side) => side.id !== null;
const spent = (list) => list.filter((j) => j.type === 'withdrawal').reduce((s, j) => s + j.amount, 0);
const earned = (list) => list.filter((j) => j.type === 'deposit').reduce((s, j) => s + j.amount, 0);

function billDates(bill, start, end) {
  const dates = [];
  for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    if (bill.freq === 'yearly' && m.getMonth() !== bill.month) continue;
    const d = new Date(m.getFullYear(), m.getMonth(), bill.day);
    if (d >= start && d <= end) dates.push(d);
  }
  return dates;
}

function tagInsight(q, type, sign) {
  const [start, end] = range(q);
  const sums = new Map();
  for (const j of journals) {
    if (j.type !== type || !inRange(j, start, end)) continue;
    for (const tag of j.tags) sums.set(tag, (sums.get(tag) || 0) + j.amount);
  }
  return [...sums].map(([name, sum]) => ({ id: tagId(name), name, tag: name, difference: fmt(sign * sum), difference_float: sign * sum, ...eur() }));
}

function categoryInsight(q, type, sign) {
  const [start, end] = range(q);
  const sums = new Map();
  for (const j of journals) {
    if (j.type !== type || !inRange(j, start, end) || !j.category) continue;
    sums.set(j.category, (sums.get(j.category) || 0) + j.amount);
  }
  return [...sums].map(([name, sum]) => ({ id: categoryId(name), name, difference: fmt(sign * sum), difference_float: sign * sum, ...eur() }));
}

// --- Routen ----------------------------------------------------------------
const routes = {
  about: () => ({ data: { version: '6.4.0-demo', api_version: '6.4.0', php_version: '8.4', os: 'Linux', driver: 'mysql' } }),
  'about/user': () => ({ data: { type: 'users', id: '1', attributes: { email: 'demo@example.com', role: 'owner' } } }),

  'summary/basic': (q) => {
    const [start, end] = range(q);
    const list = journals.filter((j) => inRange(j, start, end));
    const out = spent(list);
    const inc = earned(list);
    const netWorth = ACCOUNTS.reduce((s, a) => s + balanceAt(a, end), 0);
    const bills = BILLS.flatMap((b) => billDates(b, start, end).map((d) => ({ b, d })));
    const paid = bills.filter(({ d }) => d <= today).reduce((s, { b }) => s + b.amount, 0);
    const unpaid = bills.filter(({ d }) => d > today).reduce((s, { b }) => s + b.amount, 0);
    const budgetTotal = BUDGETS.reduce((s, b) => s + b.limit, 0);
    const budgetSpent = list.filter((j) => j.budget).reduce((s, j) => s + j.amount, 0);
    const entry = (key, title, value) => ({
      key: `${key}-in-EUR`,
      title,
      monetary_value: fmt(value),
      ...eur(),
      value_parsed: `${fmt(value)} €`,
      local_icon: 'balance-scale',
      sub_title: '',
    });
    return {
      'balance-in-EUR': entry('balance', 'Saldo (EUR)', inc - out),
      'spent-in-EUR': entry('spent', 'Ausgegeben (EUR)', -out),
      'earned-in-EUR': entry('earned', 'Eingenommen (EUR)', inc),
      'bills-paid-in-EUR': entry('bills-paid', 'Bezahlte Rechnungen (EUR)', -paid),
      'bills-unpaid-in-EUR': entry('bills-unpaid', 'Offene Rechnungen (EUR)', -unpaid),
      'left-to-spend-in-EUR': entry('left-to-spend', 'Verbleibend (EUR)', budgetTotal - budgetSpent),
      'net-worth-in-EUR': entry('net-worth', 'Nettovermögen (EUR)', netWorth),
    };
  },

  accounts: (q) => {
    const type = q.get('type') || 'all';
    if (type === 'expense' || type === 'revenue') {
      const want = type === 'expense' ? 'withdrawal' : 'deposit';
      // wie Firefly: leere Konten bleiben bestehen, bis sie gelöscht werden
      const names = [...new Set([...journals.filter((j) => j.type === want).map((j) => (want === 'withdrawal' ? j.destination.name : j.source.name)),
        ...[...extById.values()].filter((e) => e.type === type && !e.deleted).map((e) => e.name)])].sort();
      return paginate(names, q, (name) => ({ type: 'accounts', id: extId(type, name), attributes: { name, type, active: true, iban: null } }));
    }
    const list = ['asset', 'all'].includes(type) ? ACCOUNTS : [];
    return paginate(list, q, (a) => ({
      type: 'accounts',
      id: a.id,
      attributes: {
        name: a.name,
        type: 'asset',
        account_role: a.role,
        active: true,
        include_net_worth: true,
        iban: a.iban || null,
        current_balance: fmt(balanceAt(a, today)),
        current_balance_date: dateTime(today),
        ...eur(),
      },
    }));
  },

  transactions: (q) => {
    const [start, end] = q.get('start') ? range(q) : [new Date(0), today];
    const type = q.get('type') || 'all';
    const list = journals.filter((j) => inRange(j, start, end) && (type === 'all' || j.type === type));
    return paginate(list, q, journalJson);
  },

  'search/transactions': (q) => {
    // Nur die Operatoren, die das Dashboard selbst verwendet, plus Freitext
    const tokens = (q.get('query') || '').match(/(\w+:"[^"]*"|\S+)/g) || [];
    const filters = tokens.map((tok) => {
      const m = tok.match(/^(\w+):"?([^"]*)"?$/);
      const [op, val] = m ? [m[1], m[2]] : ['text', tok];
      const v = val.toLowerCase();
      switch (op) {
        case 'date_after': return (j) => j.date >= parseDate(val);
        case 'date_before': return (j) => j.date <= parseDate(val);
        case 'type': return (j) => j.type === v;
        case 'category_is': return (j) => (j.category || '').toLowerCase() === v;
        case 'has_no_category': return (j) => !j.category;
        case 'tag_is': return (j) => j.tags.some((t) => t.toLowerCase() === v);
        case 'account_is': return (j) => j.source.name.toLowerCase() === v || j.destination.name.toLowerCase() === v;
        case 'destination_account_is': return (j) => j.destination.name.toLowerCase() === v;
        case 'source_account_is': return (j) => j.source.name.toLowerCase() === v;
        case 'amount_more': return (j) => j.amount > Number(val);
        case 'amount_less': return (j) => j.amount < Number(val);
        case 'amount_exactly': return (j) => Math.abs(j.amount - Number(val)) < 0.005;
        case 'description_contains': return (j) => j.description.toLowerCase().includes(v);
        case 'notes_contains': return (j) => (j.notes || '').toLowerCase().includes(v);
        case 'has_no_tag': return (j) => !j.tags.length;
        default: return (j) => [j.description, j.source.name, j.destination.name, j.category, j.budget, ...j.tags].join(' ').toLowerCase().includes(tok.replace(/"/g, '').toLowerCase());
      }
    });
    return paginate(journals.filter((j) => filters.every((f) => f(j))), q, journalJson);
  },

  'insight/expense/category': (q) => categoryInsight(q, 'withdrawal', -1),
  'insight/income/category': (q) => categoryInsight(q, 'deposit', 1),
  'insight/expense/tag': (q) => tagInsight(q, 'withdrawal', -1),
  'insight/income/tag': (q) => tagInsight(q, 'deposit', 1),
  tags: (q) => paginate(TAGS, q, (tag) => ({ type: 'tags', id: tagId(tag), attributes: { tag } })),
  'insight/income/no-category': (q) => {
    const [start, end] = range(q);
    const sum = journals.filter((j) => j.type === 'deposit' && inRange(j, start, end) && !j.category).reduce((s, j) => s + j.amount, 0);
    return sum ? [{ difference: fmt(sum), difference_float: sum, ...eur() }] : [];
  },
  categories: (q) =>
    paginate(CATEGORIES, q, (name) => ({ type: 'categories', id: categoryId(name), attributes: { name, notes: null } })),
  'insight/expense/budget': (q) => {
    const [start, end] = range(q);
    return BUDGETS.map((b) => {
      const sum = journals.filter((j) => j.budget === b.name && inRange(j, start, end)).reduce((s, j) => s + j.amount, 0);
      return { id: b.id, name: b.name, difference: fmt(-sum), difference_float: -sum, ...eur() };
    }).filter((x) => x.difference_float !== 0);
  },
  'insight/expense/no-category': (q) => {
    const [start, end] = range(q);
    const sum = journals.filter((j) => j.type === 'withdrawal' && inRange(j, start, end) && !j.category).reduce((s, j) => s + j.amount, 0);
    return sum ? [{ difference: fmt(-sum), difference_float: -sum, ...eur() }] : [];
  },
  'insight/expense/total': (q) => {
    const [start, end] = range(q);
    const sum = spent(journals.filter((j) => inRange(j, start, end)));
    return [{ difference: fmt(-sum), difference_float: -sum, ...eur() }];
  },
  'insight/income/total': (q) => {
    const [start, end] = range(q);
    const sum = earned(journals.filter((j) => inRange(j, start, end)));
    return [{ difference: fmt(sum), difference_float: sum, ...eur() }];
  },

  'chart/account/overview': (q) => {
    const [start, end] = range(q);
    return ACCOUNTS.map((a) => {
      const entries = {};
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) entries[dateTime(d)] = fmt(balanceAt(a, d));
      return { label: a.name, ...eur(), start_date: dateTime(start), end_date: dateTime(end), type: 'line', yAxisID: 0, entries };
    });
  },

  budgets: (q) => {
    const [start, end] = range(q);
    return paginate(BUDGETS, q, (b) => {
      const sum = journals.filter((j) => j.budget === b.name && inRange(j, start, end)).reduce((s, j) => s + j.amount, 0);
      return { type: 'budgets', id: b.id, attributes: { name: b.name, active: true, order: Number(b.id), spent: [{ sum: fmt(-sum), ...eur() }] } };
    });
  },

  'budget-limits': (q) => {
    const [start, end] = range(q);
    const out = [];
    for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const mEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0);
      for (const b of BUDGETS) {
        out.push({ type: 'budget_limits', id: `${b.id}-${iso(m)}`, attributes: { budget_id: b.id, start: dateTime(m), end: dateTime(mEnd), amount: fmt(b.limit), ...eur() } });
      }
    }
    return paginate(out, q, (x) => x);
  },

  'piggy-banks': (q) =>
    paginate(PIGGIES, q, (p) => ({
      type: 'piggy_banks',
      id: p.id,
      attributes: {
        name: p.name,
        account_name: p.account,
        target_amount: fmt(p.target),
        current_amount: fmt(p.current),
        left_to_save: fmt(Math.max(0, p.target - p.current)),
        percentage: Math.round((p.current / p.target) * 100),
        target_date: p.targetDate ? dateTime(parseDate(p.targetDate)) : null,
        active: true,
        ...eur(),
      },
    })),

  bills: (q) => {
    const [start, end] = range(q);
    return paginate(BILLS, q, (b) => {
      const pay = billDates(b, start, end);
      const next = billDates(b, addDays(today, 1), addDays(today, 400))[0];
      return {
        type: 'bills',
        id: b.id,
        attributes: {
          name: b.name,
          amount_min: fmt(b.amount * 0.95),
          amount_max: fmt(b.amount * 1.05),
          ...eur(),
          repeat_freq: b.freq,
          active: true,
          next_expected_match: next ? dateTime(next) : null,
          pay_dates: pay.map(dateTime),
          paid_dates: pay.filter((d) => d <= today).map((d) => ({ transaction_group_id: '0', date: dateTime(d) })),
        },
      };
    });
  },
};

// Nachgebautes Ollama für die KI-Analyse im Labor (Stichwort-Tabelle statt Modell)
const FAKE_AI = [
  [/rewe|edeka|aldi|lidl|wochenmarkt|einkauf/i, 'Lebensmittel', [], 'notwendig'],
  [/dm-drogerie|rossmann/i, 'Drogerie', ['Haushalt'], 'notwendig'],
  [/shell|aral|jet|esso|tanken/i, 'Auto & Tanken', ['Auto'], 'notwendig'],
  [/bahn|deutschlandticket/i, 'Mobilität', ['Pendeln'], 'notwendig'],
  [/hausverwaltung|miete/i, 'Wohnen', ['Fixkosten'], 'notwendig'],
  [/stadtwerke|strom|telekom|vodafone/i, 'Nebenkosten', ['Fixkosten'], 'notwendig'],
  [/netflix|spotify|disney/i, 'Streaming', ['Abo', 'Online'], 'verzichtbar'],
  [/huk|versicherung/i, 'Versicherungen', ['Fixkosten'], 'notwendig'],
  [/pizzeria|sushi|café|cafe|biergarten|thai/i, 'Essen gehen', ['Ausgehen'], 'verzichtbar'],
  [/kino|konzert|kletter|museum|schwimm/i, 'Freizeit', ['Hobby'], 'sinnvoll'],
  [/amazon|zalando|ikea|mediamarkt|thalia|etsy|ebay|steam|vinted/i, 'Shopping', ['Online'], 'sinnvoll'],
  [/booking/i, 'Urlaub', ['Reisen'], 'sinnvoll'],
  [/apotheke|praxis|zahnarzt/i, 'Gesundheit', [], 'notwendig'],
  [/netto|baeckerei/i, 'Lebensmittel', [], 'notwendig'],
  [/hornbach|baumarkt/i, 'Haus & Garten', ['Haushalt'], 'sinnvoll'],
  [/geldautomat|bargeld/i, 'Bargeld', [], 'sinnvoll'],
  [/geschenk|blumen/i, 'Geschenke', ['Familie'], 'sinnvoll'],
];
function fakeOllama(req, res, url) {
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname.endsWith('/api/tags')) return send({ models: [{ name: 'demo-llama:8b', size: 4.7e9, details: { family: 'llama' } }, { name: 'qwen2.5:7b', size: 4.4e9, details: { family: 'qwen2' } }] });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const prompt = JSON.parse(body).messages.at(-1).content;
    let content;
    if (prompt.includes('Kategoriesystem')) {
      content = { kategorien: [...new Set(FAKE_AI.map((x) => x[1]))].map((name) => ({ name, beschreibung: `Alles rund um ${name}` })) };
    } else {
      const lines = prompt.split('\n').filter((l) => /^\d+\. /.test(l));
      content = { ergebnisse: lines.map((l) => {
        const nr = Number(l.split('.')[0]);
        const hit = FAKE_AI.find(([re]) => re.test(l));
        return hit
          ? { nr, kategorie: hit[1], neu: false, tags: hit[2], bedarf: hit[3], sicherheit: 85, grund: 'Anhand von Name und Buchungstext' }
          : { nr, kategorie: 'Sonstiges', neu: true, tags: [], bedarf: 'sinnvoll', sicherheit: 40, grund: 'Unklarer Empfänger' };
      }) };
    }
    // wie Ollama: gestreamt (eine JSON-Zeile je Stück), erstes Stück nach MOCK_OLLAMA_DELAY ms
    const text = JSON.stringify(content);
    const pieces = text.match(/.{1,40}/gs) || [''];
    const delay = Number(process.env.MOCK_OLLAMA_DELAY || 150);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    let i = 0;
    const next = () => {
      if (i < pieces.length) {
        res.write(`${JSON.stringify({ model: 'demo-llama:8b', message: { role: 'assistant', content: pieces[i++] }, done: false })}\n`);
        return setTimeout(next, 5);
      }
      res.end(`${JSON.stringify({ model: 'demo-llama:8b', done: true, load_duration: 2.1e9, prompt_eval_count: 900, prompt_eval_duration: 9e9, eval_count: pieces.length * 10, eval_duration: pieces.length * 1e9 })}\n`);
    };
    setTimeout(next, delay * Math.max(1, (prompt.match(/^\d+\. /gm) || []).length / 4));
  });
}

// MOCK_WORKERS begrenzt wie PHP-FPM, wie viele Abfragen gleichzeitig laufen
const queue = [];
let busy = 0;
function worker(delay, done) {
  queue.push([delay, done]);
  const next = () => {
    if (busy >= Number(process.env.MOCK_WORKERS || 1000) || !queue.length) return;
    const [d, fn] = queue.shift();
    busy += 1;
    setTimeout(() => {
      fn();
      busy -= 1;
      next();
    }, d);
  };
  next();
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = url.pathname.replace(/^\/api\/v1\//, '');
    let handler = routes[key];
    const cat = key.match(/^categories\/(\d+)(\/transactions)?$/);
    const accRoute = key.match(/^accounts\/(\d+)(\/transactions)?$/);
    const acc = accRoute && ACCOUNTS.find((a) => a.id === accRoute[1]);
    const ext = accRoute && !acc && !extById.get(accRoute[1])?.deleted && extById.get(accRoute[1]);
    if (ext) {
      handler = accRoute[2]
        ? (q) => paginate(extJournals(ext), q, journalJson)
        : () => ({ data: { type: 'accounts', id: accRoute[1], attributes: { name: ext.name, type: ext.type, active: true } } });
    }
    if (acc) {
      handler = accRoute[2]
        ? (q) => {
          const [start, end] = q.get('start') ? range(q) : [new Date(0), today];
          return paginate(journals.filter((j) => (j.source.id === acc.id || j.destination.id === acc.id) && inRange(j, start, end)), q, journalJson);
        }
        : (q) => ({ data: routes.accounts(new URLSearchParams('type=asset&limit=100')).data.find((a) => a.id === acc.id) });
    }
    // einzelne Transaktion (GET /transactions/{id})
    const txRoute = key.match(/^transactions\/(\d+)$/);
    if (txRoute) {
      const j = journals.find((x) => x.id === txRoute[1]);
      handler = () => (j ? { data: journalJson(j) } : null);
    }
    const tagRoute = key.match(/^tags\/([^/]+)(\/transactions)?$/);
    if (tagRoute && tagName(tagRoute[1])) {
      const name = tagName(tagRoute[1]);
      handler = tagRoute[2]
        ? (q) => {
          const [start, end] = q.get('start') ? range(q) : [new Date(0), today];
          const type = q.get('type') || 'all';
          return paginate(journals.filter((j) => j.tags.includes(name) && inRange(j, start, end) && (type === 'all' || j.type === type)), q, journalJson);
        }
        : () => ({ data: { type: 'tags', id: tagId(name), attributes: { tag: name } } });
    }
    if (cat && categoryName(cat[1])) {
      const name = categoryName(cat[1]);
      handler = cat[2]
        ? (q) => {
          const [start, end] = q.get('start') ? range(q) : [new Date(0), today];
          const type = q.get('type') || 'all';
          const list = journals.filter((j) => j.category === name && inRange(j, start, end) && (type === 'all' || j.type === type));
          return paginate(list, q, journalJson);
        }
        : () => ({ data: { type: 'categories', id: cat[1], attributes: { name } } });
    }
    if (url.pathname.startsWith('/ollama/')) return fakeOllama(req, res, url);
    if (url.pathname.startsWith('/webhook/')) {
      // Nachgebauter n8n-Webhook: antwortet mit dem, was ankam
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // wie der Workflow firefly-buchung-bearbeiten: Gegenkonto wirklich setzen (für den CSV-Abgleich).
        // /webhook/teilweise speichert nur die erste Hälfte und antwortet dann mit 504 (wie ein Abbruch)
        const data = body ? JSON.parse(body) : {};
        if (data.typ === 'konten_zusammenfuehren' || data.typ === 'konten_loeschen') {
          // wie der Zweig „Konten?“: Buchungen verschieben (Bulk), umbenennen, leere Konten löschen
          const rename = (e, to) => {
            for (const j of extJournals(e)) {
              if (e.type === 'expense') j.destination = { id: null, name: to };
              else j.source = { id: null, name: to };
            }
          };
          for (const p of data.paare || []) {
            const from = extById.get(String(p.von));
            const to = extById.get(String(p.nach));
            if (from && to && from.type === to.type) rename(from, to.name);
          }
          for (const r of data.umbenennen || []) {
            const e = extById.get(String(r.id));
            if (!e) continue;
            rename(e, r.name);
            extIds.delete(`${e.type}|${e.name}`);
            e.name = r.name;
            extIds.set(`${e.type}|${e.name}`, String(r.id));
          }
          for (const id of data.ids || []) {
            const e = extById.get(String(id));
            if (e && !extJournals(e).length) e.deleted = true;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, anzahl: (data.paare || data.ids || []).length }));
        }
        if (data.typ === 'gegenkonto_setzen') {
          const list = data.aenderungen || [];
          const apply = (a) => {
            const j = journals.find((x) => x.id === String(a.transaction_journal_id));
            if (!j) return;
            if (a.art === 'deposit') j.source = { id: null, name: a.name };
            else j.destination = { id: null, name: a.name };
          };
          if (data.hintergrund) {
            // wie der Zweig „Hintergrund?“: sofort antworten, dann nacheinander speichern
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, hintergrund: true, angenommen: list.length }));
            const step = Number(process.env.MOCK_N8N_MS || 50);
            // MOCK_N8N_LIMIT_MS: n8n bricht die Ausführung nach dieser Zeit ab (wie EXECUTIONS_TIMEOUT)
            const limit = Number(process.env.MOCK_N8N_LIMIT_MS || 0);
            list.forEach((a, k) => (!limit || step * (k + 1) <= limit) && setTimeout(() => apply(a), step * (k + 1)));
            return;
          }
          const partial = url.pathname.endsWith('/teilweise');
          for (const a of partial ? list.slice(0, Math.ceil(list.length / 2)) : list) {
            const j = journals.find((x) => x.id === String(a.transaction_journal_id));
            if (!j) continue;
            if (a.art === 'deposit') j.source = { id: null, name: a.name };
            else j.destination = { id: null, name: a.name };
          }
          if (partial) {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'Gateway Timeout' }));
          }
          // MOCK_N8N_MS: so lange braucht „n8n“ je Buchung (wie eine Firefly-Anfrage je Buchung)
          const wait = Number(process.env.MOCK_N8N_MS || 0) * list.length;
          if (wait) {
            setTimeout(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, anzahl: list.length }));
            }, wait);
            return;
          }
        }
        const fail = url.pathname.endsWith('/fehler');
        res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fail ? { message: 'Workflow could not be started' } : { ok: true, workflow: url.pathname.split('/').pop(), empfangen: body ? JSON.parse(body) : Object.fromEntries(url.searchParams) }));
      });
      return;
    }
    if (req.headers.authorization !== 'Bearer demo') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Unauthenticated.' }));
    }
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: `Not mocked: ${key}` }));
    }
    // MOCK_DELAY simuliert eine echte Firefly-Instanz (PHP braucht pro Abfrage Zeit)
    const delay = Number(process.env.MOCK_DELAY || 0) * (key === 'summary/basic' ? 4 : 1);
    worker(delay, () => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.api+json' });
      res.end(JSON.stringify(handler(url.searchParams)));
    });
  })
  .listen(PORT, () => console.log(`Firefly-III-Demo-API auf http://localhost:${PORT} (Token: demo)`));
