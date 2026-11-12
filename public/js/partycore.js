// Falsch zugeordnete Gegenkonten finden – rein rechnerisch, ohne DOM (Browser und Tests).
//
// Typischer Fall: Kartenzahlungen verschiedener Geschäfte landen beim Import auf
// demselben Gegenkonto (z. B. weil der Zahlungsdienstleister dieselbe IBAN liefert
// und Firefly Konten über die IBAN zuordnet). Dann steht „Tanken“ plötzlich bei der
// Werkstatt. Erkennbar ist das am Buchungstext: Dort steht der echte Händler
// („Kartenzahlung girocard - ARAL Tankstelle …“), der nicht zum Kontonamen passt.

import { counterpartyOf, isIntermediary } from './rules.js';

const fold = (s) => String(s ?? '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => fold(s).replace(/[^a-z0-9&]+/g, ' ').split(' ').filter((w) => w && !/^\d+$/.test(w));
const squeeze = (s) => fold(s).replace(/[^a-z0-9]+/g, '');

// Wörter, die keinen Händler bezeichnen (Rechtsform, Füllwörter)
const STOP = new Set(['die', 'der', 'das', 'the', 'und', 'gmbh', 'mbh', 'ag', 'kg', 'co', 'ohg', 'ug', 'ek', 'e', 'k', 'se', 'inc', 'ltd', 'fa', 'firma', 'filiale', 'fil', 'markt', 'de', 'sagt', 'danke']);
const significant = (s) => words(s).filter((w) => !STOP.has(w) && w.length >= 2);

// Kartenzahlung – auch als ELV/OLV-Lastschrift („JET OLV 0609… ELV70142802 …“: Händler steht davor)
const CARD = /\b(kartenzahlung|kartenumsatz|girocard|debitk\w*|visa|mastercard|maestro|apple ?pay|google ?pay|[eo]lv(?=\s*\d))/i;
const CARD_TAIL = /^[\s\-–:/.,]*(girocard|kontaktlos|contactless)?[\s\-–:/.,]*/i;

/** Händlername aus einem Kartenzahlungs-Text, z. B. „Kartenzahlung girocard - Takko Fashion 2245/Oer-…“ → „Takko Fashion“. */
const TRAIL = /(\s+(fil|filiale|nr|str|sagt danke)\.?)+$/i;
const pick = (part) => String(part ?? '')
    .split(/\/|\s{2,}|\s[-–]\s|,/)[0] // bis zum ersten Trenner (Ort, Land, Referenzen)
    .replace(/\b\d{3,}\b.*$/, '') // ab Filial-/Terminalnummer
    .replace(/[^\p{L}\d&.' -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .replace(TRAIL, '')
    .trim();
const usable = (name) => (name.match(/\p{L}/gu) || []).length >= 3 && significant(name).length > 0;
function merchantFromCardText(text) {
  const s = String(text ?? '');
  const m = CARD.exec(s);
  if (!m) return '';
  const after = s.slice(m.index + m[0].length).replace(CARD_TAIL, '');
  const before = s.slice(0, m.index);
  for (const part of [after, before]) {
    const name = pick(part);
    if (usable(name)) return name;
  }
  return '';
}

// Händler-Angabe der VR-Banken im Verwendungszweck: „HORNBACH BAUMARKT//GERMERING/DE 2026-…“ (auch ohne „Kartenzahlung“)
const SHOP_LINE = /^\s*([^/\n]{3,60}?)\s*\/\/\s*[^/\n]+\/[A-Z]{2}\b/;

/**
 * Alle Händler-Angaben im Buchungstext – Beschreibung und Notizen getrennt (bei Kartenzahlungen und
 * bei Notizen im Format „HÄNDLER//ORT/DE“). Leere Liste, wenn nichts Verwertbares drinsteht.
 */
export function textMerchants(t) {
  const out = [];
  const add = (name) => {
    if (name && usable(name) && !out.some((x) => squeeze(x) === squeeze(name))) out.push(name);
  };
  const desc = String(t.description ?? '');
  const notes = String(t.notes ?? '');
  add(merchantFromCardText(desc));
  add(merchantFromCardText(notes));
  const shop = SHOP_LINE.exec(notes) || SHOP_LINE.exec(desc);
  if (shop) add(pick(shop[1]));
  // Beschreibung ist nur „Kartenzahlung …“, der Händler steht vorn in den Notizen
  if (CARD.test(desc) && !out.length) add(pick(notes));
  return out;
}
/** Erste Händler-Angabe aus dem Buchungstext (siehe textMerchants) oder ''. */
export const textMerchant = (t) => textMerchants(t)[0] || '';

/** Lastschrift über einen Zahlungsdienstleister ohne Händlernamen: ELV/OLV-Kennung oder „im Namen und auf Rechnung“. */
export const anonymousDebit = (t) => /\b[EO]LV\s*\d{5,}/i.test(`${t.notes ?? ''} ${t.description ?? ''}`) || Boolean(processorOf(t));

/** Zahlungsdienstleister laut Text, z. B. „Der Einzug erfolgt im Namen und auf Rechnung der PAYONE GmbH“ → „PAYONE GmbH“. */
export function processorOf(t) {
  const m = /im Namen und (?:auf|für) Rechnung (?:der|des|von)\s+([^.,;:]{2,40}?)(?=\s+(?:EREF|MREF|CRED|IBAN|BIC)\b|[.,;:]|$)/i.exec(`${t.notes ?? ''} ${t.description ?? ''}`);
  return m ? m[1].trim() : '';
}

/** Passt der Händler aus dem Text zum Kontonamen? (gleiches erstes Wort, abgeschnittene Wörter erlaubt) */
export function sameMerchant(party, text) {
  const p = significant(party);
  const tw = significant(text);
  if (!p.length || !tw.length) return true; // nicht beurteilbar → nicht melden
  const near = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  // erstes Wort des Kontos kommt im Text vor – oder erstes Wort des Texts im Konto
  if (tw.some((w) => near(w, p[0])) || p.some((w) => near(w, tw[0]))) return true;
  // zusammengeschrieben („DM-Drogerie“ / „dm drogerie markt“)
  const ps = squeeze(p.slice(0, 2).join(''));
  const ts = squeeze(tw.join(''));
  return ps.length >= 4 && (ts.includes(ps) || ps.includes(squeeze(tw.slice(0, 2).join(''))));
}

/** Kennung für „passt so“: Konto + Händler aus dem Text. */
export const pairKey = (party, name) => `p:${squeeze(party)}|${squeeze(name)}`.slice(0, 300);

/**
 * Konten mit Buchungen, deren Text auf einen anderen Händler zeigt.
 * Ergebnis: [{ party, iban, total, groups: [{ name, key, suggestion, txs }] }] – meiste falsche zuerst.
 */
// Erste Wörter, die keinen bestimmten Händler bezeichnen – nicht als „anderes Konto im Text“ werten
const GENERIC_FIRST = new Set(['kartenzahlung', 'lastschrift', 'einkauf', 'rechnung', 'zahlung', 'deutsche', 'stadt', 'gemeinde', 'kreis',
  'autohaus', 'apotheke', 'praxis', 'tankstelle', 'baeckerei', 'backerei', 'restaurant', 'hotel', 'markt', 'bank', 'sparkasse', 'volksbank',
  'raiffeisenbank', 'paypal', 'klarna', 'online', 'shop', 'service', 'verein', 'gmbh', 'firma', 'herr', 'frau', 'familie', 'dr', 'zahnarzt',
  'kartenumsatz', 'girocard', 'debitk', 'visa', 'mastercard', 'gutschrift', 'dauerauftrag', 'ueberweisung', 'sepa', 'basislastschrift',
  // Branchenwörter („Pizzeria Bella“ ≠ jede Pizzeria)
  'pizzeria', 'ristorante', 'trattoria', 'gelateria', 'cafe', 'caffe', 'bistro', 'imbiss', 'grill', 'doener', 'kebab', 'sushi', 'gasthaus', 'gasthof',
  'metzgerei', 'fleischerei', 'konditorei', 'friseur', 'kiosk', 'getraenke', 'blumen', 'buchhandlung', 'optik', 'optiker', 'reisebuero', 'pension',
  'physiotherapie', 'tierarzt', 'tierklinik', 'kosmetik', 'reinigung', 'waschanlage', 'waschpark', 'parkhaus', 'parken', 'taxi', 'fahrschule',
  'schuhhaus', 'modehaus', 'kaufhaus', 'baumarkt', 'supermarkt', 'drogerie', 'buchladen', 'kino', 'theater', 'museum', 'schwimmbad', 'fitness',
  'studio', 'zentrum', 'center', 'station', 'store']);

export function wrongParties(txs, { dismissed = new Set() } = {}) {
  const byParty = new Map(); // Konto → { total, wrong: Map(name → txs) }
  const partyNames = new Map(); // erstes Wort → { Name: Anzahl } – vorhandene Konten für den Vorschlag
  const list = [];
  const catParties = new Map(); // Kategorie → { Konto: Anzahl } – für den Vorschlag bei Buchungen ohne Händlernamen
  for (const t of txs) {
    if (t.type !== 'withdrawal') continue;
    const party = counterpartyOf(t);
    if (!party || /^\(.*\)$/.test(party.trim()) || isIntermediary(party)) continue;
    list.push([t, party]);
    const first = significant(party)[0];
    if (first) {
      const m = partyNames.get(first) || new Map();
      m.set(party, (m.get(party) || 0) + 1);
      partyNames.set(first, m);
    }
  }
  // Kennwörter vorhandener Konten (z. B. „hornbach“ → „HORNBACH Baumarkt“) – mind. 2 Buchungen, 4 Buchstaben
  const known = new Map();
  for (const [word, m] of partyNames) {
    if (word.length < 4 || GENERIC_FIRST.has(word) || /\d/.test(word)) continue;
    const [name, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) known.set(word, name);
  }
  /** Nennt der Text (Beschreibung oder Notizen) irgendwo ein anderes vorhandenes Konto? */
  const otherAccount = (t, party) => {
    const own = new Set(significant(party));
    for (const w of new Set(words(`${t.description ?? ''} ${t.notes ?? ''}`))) {
      if (w.length < 4 || own.has(w)) continue;
      const name = known.get(w);
      if (name && name !== party && !sameMerchant(party, name)) return name;
    }
    return '';
  };
  for (const [t, party] of list) {
    let row = byParty.get(party);
    if (!row) byParty.set(party, (row = { party, total: 0, iban: '', wrong: new Map(), cats: new Map(), unnamed: [] }));
    row.total += 1;
    const cat = t.category_name || '';
    row.cats.set(cat, (row.cats.get(cat) || 0) + 1);
    if (cat) {
      const m = catParties.get(cat) || new Map();
      m.set(party, (m.get(party) || 0) + 1);
      catParties.set(cat, m);
    }
    // jede Angabe im Text zählt – steht in der Beschreibung „ATU“, in den Notizen aber „Hornbach“, ist das verdächtig;
    // sonst: nennt der Text ein anderes Konto, das es schon gibt?
    const name = textMerchants(t).find((n) => !sameMerchant(party, n)) || otherAccount(t, party);
    if (!name) {
      // nur Nummern und die IBAN eines Zahlungsdienstleisters, kein Händlername („3009… ELV70142803 30.09 08:22 ME1 EREF …“)
      if (!textMerchants(t).length && anonymousDebit(t) && !dismissed.has(`j:${t.transaction_journal_id}`)) row.unnamed.push(t);
      continue;
    }
    if (dismissed.has(pairKey(party, name)) || dismissed.has(`j:${t.transaction_journal_id}`)) continue;
    const key = squeeze(significant(name).slice(0, 2).join(' '));
    const g = row.wrong.get(key) || { name, key: pairKey(party, name), txs: [], via: '' };
    g.via ||= processorOf(t);
    g.txs.push(t);
    row.wrong.set(key, g);
    if (t.destination_iban) row.iban = String(t.destination_iban);
  }
  /** Vorschlag: vorhandenes Konto mit gleichem ersten Wort (häufigstes), sonst der Name aus dem Text. */
  const suggest = (name, party) => {
    const first = significant(name)[0];
    const m = partyNames.get(first);
    if (m) {
      const best = [...m].filter(([n]) => n !== party).sort((a, b) => b[1] - a[1])[0];
      if (best) return best[0];
    }
    return name;
  };
  // Ohne Händlernamen: Hinweis gibt nur die Kategorie. Verdächtig sind Buchungen, deren Kategorie nicht die übliche des
  // Kontos ist (A.T.U.: „Auto“ üblich, „Tanken“ auffällig). Vorschlag: das Konto, das in dieser Kategorie am häufigsten
  // vorkommt – nur als Vorschlag, nicht vorab angehakt.
  for (const r of byParty.values()) {
    if (!r.unnamed.length || r.cats.size < 2) continue;
    const usual = [...r.cats].filter(([c]) => c).sort((a, b) => b[1] - a[1])[0]?.[0];
    const byCat = new Map();
    for (const t of r.unnamed) {
      const cat = t.category_name || '';
      if (!cat || cat === usual) continue;
      byCat.set(cat, [...(byCat.get(cat) || []), t]);
    }
    for (const [cat, txsOfCat] of byCat) {
      const key = pairKey(r.party, `kategorie:${cat}`);
      if (dismissed.has(key)) continue;
      const others = [...(catParties.get(cat) || [])].filter(([n]) => n !== r.party).sort((a, b) => b[1] - a[1]);
      const total = others.reduce((a, [, n]) => a + n, 0);
      const best = others[0] && others[0][1] / total >= 0.5 ? others[0] : null; // nur, wenn ein Konto die Kategorie klar prägt
      r.wrong.set(`kategorie:${cat}`, { name: `ohne Händlernamen – Kategorie „${cat}“`, key, txs: txsOfCat, via: processorOf(txsOfCat[0]), unnamed: true, category: cat, usual, guess: best ? best[0] : '' });
    }
  }
  return [...byParty.values()]
    .filter((r) => r.wrong.size)
    .map((r) => ({
      party: r.party,
      iban: r.iban,
      total: r.total,
      groups: [...r.wrong.values()]
        .map((g) => ({ ...g, suggestion: g.unnamed ? g.guess : suggest(g.name, r.party), sum: g.txs.reduce((a, t) => a + (Number(t.amount) || 0), 0) }))
        .sort((a, b) => Number(Boolean(a.unnamed)) - Number(Boolean(b.unnamed)) || b.txs.length - a.txs.length),
    }))
    .map((r) => ({ ...r, wrongCount: r.groups.reduce((a, g) => a + g.txs.length, 0) }))
    .sort((a, b) => b.wrongCount - a.wrongCount);
}
