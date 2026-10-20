// Struktur-Vorschläge für das Kategorien-Labor – rein lokal, ohne KI:
//  - Tags aus wiederkehrenden Wörtern im Verwendungszweck (quer über Empfänger)
//  - Reisen: Häufung neuer Händler in einem kurzen Zeitraum
//  - Kategorien zusammenfassen (ähnliche Namen, gemeinsame Empfänger, sehr klein)
//  - Kategorien aufteilen (klar erkennbare Händlergruppen in einer Kategorie)
// Jeder Vorschlag besteht aus normalen Labor-Regeln und lässt sich vorher ansehen.

import { counterpartyOf, normParty } from './rules.js';

const lower = (s) => String(s ?? '').toLowerCase();
const fold = (s) => lower(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (t) => String(t.date).slice(0, 10);
const dayNo = (t) => Math.floor(new Date(`${iso(t)}T12:00:00Z`).getTime() / 86400000);
let seq = 0;
const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

// Wörter, die in Verwendungszwecken ständig vorkommen und nichts aussagen
const STOP = new Set(`
  sepa lastschrift ueberweisung überweisung gutschrift dauerauftrag kartenzahlung karte kartennr girocard maestro visa mastercard debit
  kreditkarte ecommerce lastschr einzug abbuchung buchung zahlung zahlungen payment purchase online shop store pos termin terminal
  folgenr folgenummer verfalld ende end ref referenz mandat mandatsref mandatsreferenz glaeubiger gläubiger glaeubigerid creditor
  kunde kunden kundennr kundennummer vertrag vertragsnr vertragsnummer rechnungsnr belegnr beleg auftrag auftragsnr bestellnr bestellung
  datum uhr zeit euro eur betrag summe originalbetrag wechselkurs gebuehr gebühr entgelt
  gmbh mbh kg ohg ag co ug se ltd inc sarl s.a.r.l europe deutschland germany berlin
  und der die das dem den des ein eine einer fuer für vom von zum zur mit bei aus auf nach im in an am ihr ihre ihren sie wir unser
  januar februar maerz märz april mai juni juli august september oktober november dezember jan feb mar apr jun jul aug sep sept okt nov dez
  montag dienstag mittwoch donnerstag freitag samstag sonntag
  paypal klarna sumup stripe adyen apple google amazon payments
  nr no nummer id txn trx transaktion transaction info text verwendungszweck awv
`.split(/\s+/).filter(Boolean));

/** Wörter eines Verwendungszwecks ohne Zahlen, Füllwörter und Wörter des Empfängernamens. */
export function words(t) {
  const party = new Set(normParty(counterpartyOf(t)).split(' '));
  return [...new Set(lower(`${t.description || ''} ${t.notes || ''}`)
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L} ]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP.has(w) && !STOP.has(fold(w)) && !party.has(w)))];
}

// ---------------------------------------------------------------------------
// Tags

/**
 * Wörter, die in mehreren Buchungen bei verschiedenen Empfängern vorkommen
 * (z. B. „kita“, „urlaub“, „reparatur“) – also eher ein Thema als ein Händler.
 */
export function suggestWordTags(txs, existingRules = []) {
  const tagged = (t, tag) => (t.tags || []).some((x) => lower(x) === lower(tag))
    || existingRules.some((r) => (r.addTags || []).some((x) => lower(x) === lower(tag)));
  const stats = new Map();
  for (const t of txs) {
    for (const w of words(t)) {
      const s = stats.get(w) || { list: [], parties: new Set(), cats: new Set() };
      s.list.push(t);
      s.parties.add(normParty(counterpartyOf(t)));
      s.cats.add(t.category_name || '–');
      stats.set(w, s);
    }
  }
  const categories = new Set(txs.map((t) => lower(t.category_name)).filter(Boolean));
  const out = [];
  for (const [w, s] of stats) {
    const n = s.list.length;
    if (n < 3 || s.parties.size < 2 || n > txs.length * 0.3) continue;
    if (categories.has(w)) continue; // ist schon eine Kategorie
    // steckt fast nur in einer Kategorie → das sagt die Kategorie schon (z. B. „Einkauf“ bei Lebensmitteln)
    const perCat = new Map();
    s.list.forEach((t) => perCat.set(t.category_name, (perCat.get(t.category_name) || 0) + 1));
    if (Math.max(...perCat.values()) / n >= 0.9) continue;
    const tag = cap(w);
    const open = s.list.filter((t) => !tagged(t, tag));
    if (open.length < 3) continue;
    out.push({
      id: newId(),
      kind: 'wort',
      title: `Tag „${tag}“`,
      reason: `„${w}“ steht im Verwendungszweck von ${n} Buchungen bei ${s.parties.size} Empfängern in ${s.cats.size} Kategorie${s.cats.size === 1 ? '' : 'n'}`,
      score: n * s.parties.size * Math.max(1, s.cats.size),
      hits: open,
      rules: [{ id: newId(), enabled: true, when: [{ field: 'description', op: 'contains', value: w }], setCategory: '', addTags: [tag] }],
    });
  }
  // Wörter, die fast immer zusammen auftreten, nur einmal vorschlagen
  out.sort((a, b) => b.score - a.score);
  const seen = [];
  return out.filter((s) => {
    const ids = new Set(s.hits.map((t) => t.transaction_journal_id));
    const dup = seen.some((o) => {
      const shared = s.hits.filter((t) => o.has(t.transaction_journal_id)).length;
      return shared / Math.min(ids.size, o.size) >= 0.8;
    });
    if (!dup) seen.push(ids);
    return !dup;
  });
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * Reisen/Ausflüge: mehrere Ausgaben bei Händlern, die es sonst (fast) nie gibt,
 * innerhalb weniger Tage. Vorschlag: Tag für genau diese Buchungen.
 */
export function suggestTrips(txs) {
  const expenses = txs.filter((t) => t.type === 'withdrawal');
  const byParty = new Map();
  for (const t of expenses) {
    const key = normParty(counterpartyOf(t));
    if (!byParty.has(key)) byParty.set(key, []);
    byParty.get(key).push(t);
  }
  // „fremd“: Händler mit höchstens 4 Buchungen, alle innerhalb von 21 Tagen
  const foreign = expenses.filter((t) => {
    const list = byParty.get(normParty(counterpartyOf(t)));
    if (list.length > 4) return false;
    const days = list.map(dayNo);
    return Math.max(...days) - Math.min(...days) <= 21;
  }).sort((a, b) => dayNo(a) - dayNo(b));

  const clusters = [];
  for (const t of foreign) {
    const last = clusters[clusters.length - 1];
    if (last && dayNo(t) - dayNo(last[last.length - 1]) <= 2) last.push(t);
    else clusters.push([t]);
  }
  const out = [];
  for (const c of clusters) {
    const parties = new Set(c.map((t) => normParty(counterpartyOf(t))));
    const total = c.reduce((a, t) => a + t.amount, 0);
    const span = dayNo(c[c.length - 1]) - dayNo(c[0]) + 1;
    if (c.length < 4 || parties.size < 3 || span < 2 || span > 30 || total < 100) continue;
    // gemeinsames Wort (oft der Ort) als Name, sonst Monat + Jahr
    const counts = new Map();
    c.forEach((t) => words(t).forEach((w) => counts.set(w, (counts.get(w) || 0) + 1)));
    const place = [...counts].filter(([, n]) => n >= Math.max(2, c.length * 0.4)).sort((a, b) => b[1] - a[1])[0]?.[0];
    const first = new Date(`${iso(c[0])}T12:00:00`);
    const tag = place ? `Reise ${cap(place)} ${first.getFullYear()}` : `Reise ${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
    const names = [...new Set(c.map((t) => counterpartyOf(t)))].slice(0, 20);
    out.push({
      id: newId(),
      kind: 'reise',
      title: `Tag „${tag}“`,
      reason: `${c.length} Ausgaben bei ${parties.size} sonst unbekannten Händlern vom ${iso(c[0])} bis ${iso(c[c.length - 1])} – einmalig, am besten per „Änderungen an n8n übergeben“ setzen`,
      score: c.length * parties.size * 10,
      hits: c,
      rules: [{
        id: newId(),
        enabled: true,
        when: [
          { field: 'date', op: 'between', value: iso(c[0]), value2: iso(c[c.length - 1]) },
          { field: 'party', op: 'regex', value: `^(${names.map(escRe).join('|')})$` },
        ],
        setCategory: '',
        addTags: [tag],
      }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kategorien

/** Feinere Händlergruppen – nur zum Aufteilen großer Sammelkategorien. */
const SUBGROUPS = [
  ['Elektronik', ['mediamarkt', 'media markt', 'saturn', 'cyberport', 'alternate', 'notebooksbilliger', 'conrad', 'apple store', 'gravis', 'galaxus']],
  ['Kleidung & Schuhe', ['zalando', 'h&m', 'h m', 'zara', 'about you', 'c&a', 'primark', 'kik', 'deichmann', 'snipes', 'tk maxx', 'esprit', 'jack jones', 'bonprix']],
  ['Wohnen & Baumarkt', ['ikea', 'xxxlutz', 'höffner', 'poco', 'jysk', 'depot', 'obi', 'hornbach', 'bauhaus', 'toom', 'hagebau', 'dehner', 'roller', 'home24']],
  ['Bücher & Medien', ['thalia', 'hugendubel', 'weltbild', 'audible', 'kindle', 'buchhandlung']],
  ['Sport', ['decathlon', 'sportscheck', 'intersport', 'kletterhalle', 'fitness', 'mcfit', 'urban sports']],
  ['Tanken', ['aral', 'shell', 'esso', 'jet', 'totalenergies', 'total ', 'agip', 'avia', 'tankstelle', 'star ']],
  ['Bahn & ÖPNV', ['deutsche bahn', 'db vertrieb', 'db fernverkehr', 'bvg', 'mvv', 'hvv', 'vrr', 'kvb', 'flixbus', 'deutschlandticket']],
  ['Lieferdienste', ['lieferando', 'wolt', 'uber eats', 'flink', 'gorillas', 'picnic']],
  ['Drogerie', ['dm-drogerie', 'dm drogerie', 'rossmann', 'müller', 'budni']],
  ['Apotheke', ['apotheke', 'docmorris', 'shop-apotheke', 'medpex']],
  ['Streaming', ['netflix', 'spotify', 'disney', 'dazn', 'sky', 'prime video', 'youtube', 'apple music', 'deezer']],
];
const subgroupOf = (party) => SUBGROUPS.find(([, words]) => words.some((w) => lower(party).includes(w)))?.[0] || null;

/** Wortnähe zweier Kategorienamen (gleich nach Normalisierung, enthalten, Tippfehler). */
function similarNames(a, b) {
  const x = fold(a).replace(/[^a-z]/g, '');
  const y = fold(b).replace(/[^a-z]/g, '');
  if (!x || !y || x === y) return x === y;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  // Levenshtein ≤ 2 bei längeren Namen
  if (Math.min(x.length, y.length) < 6) return false;
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  }
  return d[x.length][y.length] <= 2;
}
// Begriffe, die oft dasselbe meinen
const SAME = [['auto', 'kfz', 'pkw', 'fahrzeug'], ['essen gehen', 'restaurant', 'gastro', 'ausgehen'], ['lebensmittel', 'supermarkt', 'einkauf'],
  ['abo', 'abos', 'abonnement', 'abonnements', 'streaming'], ['handy', 'telefon', 'mobilfunk', 'internet'], ['geschenk', 'geschenke'],
  ['kleidung', 'klamotten', 'mode'], ['haushalt', 'wohnen', 'einrichtung'], ['gesundheit', 'arzt', 'medizin'], ['sport', 'fitness']];
const sameMeaning = (a, b) => SAME.some((g) => g.some((w) => fold(a).includes(fold(w))) && g.some((w) => fold(b).includes(fold(w))));

const mergeRule = (from, to) => ({ id: newId(), enabled: true, when: [{ field: 'category', op: 'equals', value: from }], setCategory: to, addTags: [] });

/**
 * Vorschläge zum Zusammenfassen und Aufteilen von Kategorien.
 * txs: Buchungen einer Art (Ausgaben oder Einnahmen).
 */
export function suggestCategoryStructure(txs) {
  const cats = new Map();
  for (const t of txs.filter((x) => x.category_name)) {
    const c = cats.get(t.category_name) || { name: t.category_name, list: [], parties: new Map(), sum: 0 };
    c.list.push(t);
    c.sum += t.amount;
    const p = normParty(counterpartyOf(t));
    c.parties.set(p, (c.parties.get(p) || 0) + 1);
    cats.set(t.category_name, c);
  }
  const list = [...cats.values()].sort((a, b) => b.sum - a.sum);
  const total = list.reduce((a, c) => a + c.sum, 0) || 1;
  const out = [];
  const merged = new Set();
  const merge = (small, big, kind, reason) => {
    if (merged.has(small.name) || merged.has(big.name) || small === big) return;
    // Ziel ist die Kategorie mit mehr Buchungen – die ist meist die „richtige“
    if (kind !== 'klein' && small.list.length > big.list.length) [small, big] = [big, small];
    merged.add(small.name);
    out.push({ id: newId(), kind, title: `„${small.name}“ → „${big.name}“`, reason: `${reason} – ${small.list.length} Buchungen wandern nach „${big.name}“`, score: 100 + small.list.length, hits: small.list, rules: [mergeRule(small.name, big.name)] });
  };

  // 1) ähnliche Namen / gleiche Bedeutung
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]]; // a ist die größere
      const why = similarNames(a.name, b.name) ? 'ähnliche Namen' : sameMeaning(a.name, b.name) ? 'meinen vermutlich dasselbe' : null;
      if (why) merge(b, a, 'name', `${why} („${a.name}“: ${a.list.length}, „${b.name}“: ${b.list.length} Buchungen)`);
    }
  }
  // 2) gemeinsame Empfänger
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      if (a.parties.size < 2 || b.parties.size < 2) continue;
      const shared = [...b.parties.keys()].filter((p) => a.parties.has(p));
      if (shared.length >= 2 && shared.length / Math.min(a.parties.size, b.parties.size) >= 0.5) {
        merge(b, a, 'ueberschneidung', `teilen sich ${shared.length} Empfänger (z. B. ${shared.slice(0, 3).join(', ')})`);
      }
    }
  }
  // 3) sehr kleine Kategorien → in die Kategorie, mit der sie die meisten Wörter teilt
  for (const c of list) {
    if (merged.has(c.name) || c.list.length >= 4 || c.sum / total >= 0.01 || list.length < 6) continue;
    const mine = new Set(c.list.flatMap(words).concat([...c.parties.keys()]));
    let best = null;
    let bestScore = 0;
    for (const o of list) {
      if (o === c || merged.has(o.name)) continue;
      const theirs = new Set(o.list.flatMap(words).concat([...o.parties.keys()]));
      const score = [...mine].filter((w) => theirs.has(w)).length;
      if (score > bestScore) [best, bestScore] = [o, score];
    }
    if (best) merge(c, best, 'klein', `sehr klein (${(Math.round((c.sum / total) * 1000) / 10).toLocaleString('de-DE')} % der Summe), passt inhaltlich zu „${best.name}“`);
  }
  // 4) Aufteilen: große Kategorie mit klar erkennbaren Händlergruppen
  for (const c of list) {
    if (merged.has(c.name) || c.list.length < 12 || c.parties.size < 5) continue;
    const groups = new Map();
    for (const t of c.list) {
      const g = subgroupOf(counterpartyOf(t));
      if (!g || fold(g) === fold(c.name)) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const strong = [...groups].filter(([, l]) => l.length >= 3 && l.length / c.list.length >= 0.1);
    const covered = strong.reduce((a, [, l]) => a + l.length, 0);
    if (strong.length < 2 || covered / c.list.length < 0.4) continue;
    const rules = strong.flatMap(([g, l]) => [...new Set(l.map((t) => counterpartyOf(t)))].slice(0, 12)
      .map((p) => ({ id: newId(), enabled: true, when: [{ field: 'category', op: 'equals', value: c.name }, { field: 'party', op: 'equals', value: p }], setCategory: g, addTags: [] })));
    out.push({
      id: newId(),
      kind: 'aufteilen',
      title: `„${c.name}“ aufteilen`,
      reason: `${strong.map(([g, l]) => `${g} (${l.length})`).join(', ')} – zusammen ${covered} von ${c.list.length} Buchungen; der Rest bleibt in „${c.name}“`,
      score: 50 + covered,
      hits: strong.flatMap(([, l]) => l),
      rules,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Alle Tag-Vorschläge: Reisen zuerst, Wörter ohne die, die nur eine Reise beschreiben. */
export function suggestTags(txs, existingRules = []) {
  const trips = suggestTrips(txs);
  const tripIds = trips.map((s) => new Set(s.hits.map((t) => t.transaction_journal_id)));
  const wordTags = suggestWordTags(txs, existingRules)
    .filter((s) => !tripIds.some((ids) => s.hits.filter((t) => ids.has(t.transaction_journal_id)).length / s.hits.length >= 0.8));
  return [...trips, ...wordTags];
}
