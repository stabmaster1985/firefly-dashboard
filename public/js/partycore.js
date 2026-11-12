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

const CARD = /\b(kartenzahlung|kartenumsatz|girocard|debitk\w*|visa|mastercard|maestro|apple ?pay|google ?pay)\b/i;
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

/** Händler laut Buchungstext (Beschreibung, sonst Notizen) – nur bei Kartenzahlungen, sonst ''. */
export function textMerchant(t) {
  for (const field of ['description', 'notes']) {
    const name = merchantFromCardText(t[field]);
    if (name) return name;
  }
  // Beschreibung ist nur „Kartenzahlung …“, der Händler steht in den Notizen (VR-Banken)
  if (CARD.test(String(t.description ?? ''))) {
    const name = pick(t.notes);
    if (usable(name)) return name;
  }
  return '';
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
export function wrongParties(txs, { dismissed = new Set() } = {}) {
  const byParty = new Map(); // Konto → { total, wrong: Map(name → txs) }
  const partyNames = new Map(); // erstes Wort → { Name: Anzahl } – vorhandene Konten für den Vorschlag
  for (const t of txs) {
    if (t.type !== 'withdrawal') continue;
    const party = counterpartyOf(t);
    if (!party || /^\(.*\)$/.test(party.trim()) || isIntermediary(party)) continue;
    const first = significant(party)[0];
    if (first) {
      const m = partyNames.get(first) || new Map();
      m.set(party, (m.get(party) || 0) + 1);
      partyNames.set(first, m);
    }
    let row = byParty.get(party);
    if (!row) byParty.set(party, (row = { party, total: 0, iban: '', wrong: new Map() }));
    row.total += 1;
    const name = textMerchant(t);
    if (!name || sameMerchant(party, name)) continue;
    if (dismissed.has(pairKey(party, name)) || dismissed.has(`j:${t.transaction_journal_id}`)) continue;
    const key = squeeze(significant(name).slice(0, 2).join(' '));
    const g = row.wrong.get(key) || { name, key: pairKey(party, name), txs: [] };
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
  return [...byParty.values()]
    .filter((r) => r.wrong.size)
    .map((r) => ({
      party: r.party,
      iban: r.iban,
      total: r.total,
      groups: [...r.wrong.values()]
        .map((g) => ({ ...g, suggestion: suggest(g.name, r.party), sum: g.txs.reduce((a, t) => a + (Number(t.amount) || 0), 0) }))
        .sort((a, b) => b.txs.length - a.txs.length),
    }))
    .map((r) => ({ ...r, wrongCount: r.groups.reduce((a, g) => a + g.txs.length, 0) }))
    .sort((a, b) => b.wrongCount - a.wrongCount);
}
