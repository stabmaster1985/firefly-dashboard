// CSV-Abgleich: Bank-CSV lesen und ihre Zeilen den vorhandenen Firefly-
// Buchungen zuordnen – um Angaben nachzutragen, die beim Import verloren
// gingen (z. B. „Name Zahlungsbeteiligter“, wenn diese Spalte nicht als
// Gegenkonto zugeordnet war). Rein rechnerisch, ohne DOM – im Browser und
// in Tests nutzbar. Geschrieben wird hier nichts.

import { counterpartyOf, cleanText } from './rules.js';

/** Bytes → Text: UTF-8, sonst Windows-1252 (viele Bank-Exporte). */
export function decodeCsv(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** CSV (Trennzeichen ; oder ,) mit Anführungszeichen und Zeilenumbrüchen in Feldern. */
export function parseCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const fold = (s) => String(s ?? '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Spaltennamen verschiedener Banken (VR-Banken, Sparkassen, …) → Bedeutung. */
const COLUMNS = {
  book: ['buchungstag', 'buchungsdatum'],
  valuta: ['valutadatum', 'valuta', 'wertstellung'],
  name: ['name zahlungsbeteiligter', 'beguenstigter zahlungspflichtiger', 'zahlungsempfaenger', 'auftraggeber empfaenger', 'empfaenger', 'auftraggeber', 'name'],
  iban: ['iban zahlungsbeteiligter', 'kontonummer iban', 'iban gegenkonto', 'iban'],
  bic: ['bic swift code zahlungsbeteiligter', 'bic swift code', 'bic'],
  text: ['buchungstext', 'umsatzart'],
  purpose: ['verwendungszweck'],
  amount: ['betrag', 'umsatz', 'betrag eur'],
  own: ['iban auftragskonto', 'auftragskonto'],
  ci: ['glaeubiger id', 'glaeubiger identifikation'],
  mref: ['mandatsreferenz'],
};
/** Spaltenpositionen im Standard-Export der VR-Banken (falls die Kopfzeile fehlt). */
const VR_POSITIONS = { own: 1, book: 4, valuta: 5, name: 6, iban: 7, bic: 8, text: 9, purpose: 10, amount: 11, ci: 17, mref: 18 };

/** Kopfzeile → { feld: index }; fehlt eine Kopfzeile, die VR-Positionen. */
export function detectColumns(header) {
  const names = header.map(fold);
  const cols = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    for (const alias of aliases) {
      const i = names.findIndex((n, idx) => n === alias && !Object.values(cols).includes(idx));
      if (i >= 0) {
        cols[key] = i;
        break;
      }
    }
  }
  const hasHeader = cols.amount !== undefined && (cols.book !== undefined || cols.valuta !== undefined);
  return hasHeader ? { cols, hasHeader } : { cols: { ...VR_POSITIONS }, hasHeader: false };
}

/** „-1.234,56“ → -1234.56 */
export const parseAmount = (s) => {
  const x = String(s ?? '').replace(/\s|€|EUR/gi, '');
  if (!x) return NaN;
  return Number(/,\d{1,2}$/.test(x) ? x.replace(/\./g, '').replace(',', '.') : x.replace(/,/g, ''));
};
/** „03.10.2026“ / „03.10.26“ / „2026-10-03“ → „2026-10-03“ */
export const parseDay = (s) => {
  const v = String(s ?? '').trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(v);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

/** Datei(en) → einheitliche Zeilen { file, line, date, book, amount, name, iban, bic, text, purpose, own }. */
export function readRows(text, file = '') {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], hasHeader: false, cols: {} };
  const { cols, hasHeader } = detectColumns(rows[0]);
  const get = (r, k) => (cols[k] === undefined ? '' : String(r[cols[k]] ?? '').trim());
  const out = [];
  rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
    const amount = parseAmount(get(r, 'amount'));
    const date = parseDay(get(r, 'valuta')) || parseDay(get(r, 'book'));
    if (!date || !Number.isFinite(amount) || amount === 0) return;
    out.push({
      file, line: i + (hasHeader ? 2 : 1), date, book: parseDay(get(r, 'book')) || date, amount,
      name: get(r, 'name'), iban: get(r, 'iban').replace(/\s+/g, ''), bic: get(r, 'bic'),
      text: get(r, 'text'), purpose: get(r, 'purpose'), own: get(r, 'own').replace(/\s+/g, ''),
    });
  });
  return { rows: out, hasHeader, cols };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const cents = (x) => Math.round(Math.abs(Number(x)) * 100);
const dayNum = (iso) => Math.round(Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`) / 86400000);
/** Steht bei Firefly kein echter Empfänger (leer, „(no name)“, nur „Kartenzahlung“ …)? */
export const hasNoParty = (t) => {
  const p = String(counterpartyOf(t) ?? '').trim();
  return !p || /^\(.*\)$/.test(p) || !/\p{L}/u.test(cleanText(p));
};

/**
 * CSV-Zeilen den Firefly-Buchungen zuordnen. Jede Buchung höchstens einmal.
 * Reihenfolge: gleicher Betrag + Datum (Valuta, sonst Buchungstag) + gleicher
 * Text; dann Betrag + Datum; dann ±3 Tage nur mit gleichem Text.
 * Ergebnis je Zeile: { row, t, status, reason }
 *   status: neu | abweichend | vorhanden | ohne-name | umbuchung | mehrdeutig | nicht-gefunden
 */
export function matchRows(rows, txs) {
  const byAmount = new Map();
  for (const t of txs) {
    const k = cents(t.amount);
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(t);
  }
  const used = new Set();
  const idOf = (t) => String(t.transaction_journal_id);
  const sign = (t) => (t.type === 'deposit' ? 1 : -1);
  const sameText = (row, t) => {
    const a = norm(row.purpose);
    const b = norm(t.notes);
    const c = norm(row.text);
    const d = norm(t.description);
    return (a && (a === b || a === d)) || (c && c === d && (!a || !b || a === b));
  };
  const ownOk = (row, t) => {
    if (!row.own) return true;
    const own = String((t.type === 'deposit' ? t.destination_iban : t.source_iban) || '').replace(/\s+/g, '');
    return !own || own === row.own;
  };
  const results = [];
  // Zeilen mit eindeutigem Text zuerst – dann bleiben für gleichartige Zeilen die passenden übrig
  const order = rows.map((row, i) => ({ row, i })).sort((a, b) => Number(Boolean(b.row.purpose)) - Number(Boolean(a.row.purpose)));
  const out = new Array(rows.length);
  for (const { row, i } of order) {
    const pool = (byAmount.get(cents(row.amount)) || []).filter((t) => !used.has(idOf(t)) && ownOk(row, t)
      && (t.type === 'transfer' || sign(t) === Math.sign(row.amount)));
    const d = dayNum(row.date);
    const b = dayNum(row.book);
    const onDay = pool.filter((t) => [d, b].includes(dayNum(t.date)) || (t.book_date && [d, b].includes(dayNum(t.book_date))));
    let found = onDay.filter((t) => sameText(row, t));
    if (!found.length) found = onDay.length === 1 ? onDay : [];
    if (!found.length && onDay.length > 1) {
      out[i] = { row, t: null, status: 'mehrdeutig', reason: `${onDay.length} Buchungen mit gleichem Betrag und Datum` };
      continue;
    }
    if (!found.length) found = pool.filter((t) => Math.abs(dayNum(t.date) - d) <= 3 && sameText(row, t));
    if (found.length > 1) {
      // gleiche Buchungen (z. B. zweimal 2,50 € beim Bäcker): in Reihenfolge zuordnen
      const identical = found.every((t) => norm(t.notes) === norm(found[0].notes) && norm(t.description) === norm(found[0].description));
      if (!identical) {
        out[i] = { row, t: null, status: 'mehrdeutig', reason: `${found.length} passende Buchungen` };
        continue;
      }
      found = [found.sort((x, y) => Number(x.transaction_journal_id) - Number(y.transaction_journal_id))[0]];
    }
    const t = found[0];
    if (!t) {
      out[i] = { row, t: null, status: 'nicht-gefunden', reason: 'keine Buchung mit diesem Betrag und Datum' };
      continue;
    }
    used.add(idOf(t));
    if (t.type === 'transfer') out[i] = { row, t, status: 'umbuchung', reason: 'Umbuchung zwischen eigenen Konten – bleibt, wie sie ist' };
    else if (!row.name) out[i] = { row, t, status: 'ohne-name', reason: 'in der CSV steht kein Name' };
    else if (hasNoParty(t)) out[i] = { row, t, status: 'neu', reason: 'Firefly kennt keinen Empfänger' };
    else if (norm(counterpartyOf(t)) === norm(row.name)) out[i] = { row, t, status: 'vorhanden', reason: 'steht schon so in Firefly' };
    else out[i] = { row, t, status: 'abweichend', reason: `Firefly: „${counterpartyOf(t)}“` };
  }
  return out;
}

/** Änderung für den n8n-Workflow (typ „gegenkonto_setzen“). */
export const changeFor = ({ row, t }, { iban = true } = {}) => ({
  transaction_group_id: t.groupId,
  transaction_journal_id: t.transaction_journal_id,
  art: t.type,
  datum: String(t.date).slice(0, 10),
  betrag: t.amount,
  name: row.name,
  ...(iban && row.iban ? { iban: row.iban } : {}),
  ...(iban && row.bic ? { bic: row.bic } : {}),
  name_alt: counterpartyOf(t) || null,
});
