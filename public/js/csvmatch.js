// CSV-Abgleich: Bank-CSV lesen und ihre Zeilen den vorhandenen Firefly-
// Buchungen zuordnen – um Angaben nachzutragen, die beim Import verloren
// gingen (z. B. „Name Zahlungsbeteiligter“, wenn diese Spalte nicht als
// Gegenkonto zugeordnet war). Rein rechnerisch, ohne DOM – im Browser und
// in Tests nutzbar. Geschrieben wird hier nichts.

import { counterpartyOf, cleanText, isGenericText } from './rules.js';

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
      raw: r, // Originalfelder – für den Import neuer Zeilen
    });
  });
  return { rows: out, hasHeader, cols, header: hasHeader ? rows[0] : null };
}

/**
 * Zeilen aus überlappenden Dateien zusammenführen: eine Zeile so oft, wie sie in einer Datei
 * höchstens vorkommt (zweimal 2,50 € beim Bäcker in derselben Datei bleiben zwei Zeilen).
 */
export function uniqueRows(rows) {
  const keyOf = (r) => [r.date, r.amount, r.name, r.purpose, r.text].join('|');
  const max = new Map();
  for (const f of new Set(rows.map((r) => r.file))) {
    const perFile = new Map();
    rows.filter((r) => r.file === f).forEach((r) => perFile.set(keyOf(r), (perFile.get(keyOf(r)) || 0) + 1));
    perFile.forEach((n, k) => max.set(k, Math.max(max.get(k) || 0, n)));
  }
  return rows.filter((r) => {
    const k = keyOf(r);
    if (!max.get(k)) return false;
    max.set(k, max.get(k) - 1);
    return true;
  });
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const cents = (x) => Math.round(Math.abs(Number(x)) * 100);
const dayNum = (iso) => Math.round(Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`) / 86400000);
/** Steht bei Firefly kein echter Empfänger (leer, „(no name)“, nur „Kartenzahlung“ …)? */
export const hasNoParty = (t) => {
  const p = String(counterpartyOf(t) ?? '').trim();
  return !p || /^\(.*\)$/.test(p) || !/\p{L}/u.test(cleanText(p));
};

/** Status einer Zeile, wenn sie dieser Firefly-Buchung zugeordnet ist. */
export function statusFor(row, t) {
  if (t.type === 'transfer') return { status: 'umbuchung', reason: 'Umbuchung zwischen eigenen Konten – bleibt, wie sie ist' };
  if (!row.name) return { status: 'ohne-name', reason: 'in der CSV steht kein Name' };
  if (hasNoParty(t)) return { status: 'neu', reason: 'Firefly kennt keinen Empfänger' };
  if (norm(counterpartyOf(t)) === norm(row.name)) return { status: 'vorhanden', reason: 'steht schon so in Firefly' };
  return { status: 'abweichend', reason: `Firefly: „${counterpartyOf(t)}“` };
}

/**
 * CSV-Zeilen den Firefly-Buchungen zuordnen. Jede Buchung höchstens einmal.
 * Reihenfolge: gleicher Betrag + Datum (Valuta, sonst Buchungstag) + gleicher
 * Text; dann Betrag + Datum; dann ±3 Tage nur mit gleichem Text.
 * Ergebnis je Zeile: { row, t, status, reason, how, sure, candidates }
 *   status: neu | abweichend | vorhanden | ohne-name | umbuchung | mehrdeutig | nicht-gefunden
 *   how: worüber zugeordnet wurde; sure: Betrag, Datum und Text stimmen überein
 *   candidates: bei „mehrdeutig“/„nicht gefunden“ mögliche Buchungen zum Auswählen
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
  // Zeilen mit eindeutigem Text zuerst – dann bleiben für gleichartige Zeilen die passenden übrig
  const order = rows.map((row, i) => ({ row, i })).sort((a, b) => Number(Boolean(b.row.purpose)) - Number(Boolean(a.row.purpose)));
  const out = new Array(rows.length);
  const fits = (row, t) => ownOk(row, t) && (t.type === 'transfer' || sign(t) === Math.sign(row.amount));
  const near = (row, days) => (byAmount.get(cents(row.amount)) || []).filter((t) => fits(row, t) && Math.abs(dayNum(t.date) - dayNum(row.date)) <= days)
    .sort((x, y) => Math.abs(dayNum(x.date) - dayNum(row.date)) - Math.abs(dayNum(y.date) - dayNum(row.date)));
  for (const { row, i } of order) {
    const pool = (byAmount.get(cents(row.amount)) || []).filter((t) => !used.has(idOf(t)) && fits(row, t));
    const d = dayNum(row.date);
    const b = dayNum(row.book);
    const onDay = pool.filter((t) => [d, b].includes(dayNum(t.date)) || (t.book_date && [d, b].includes(dayNum(t.book_date))));
    let found = onDay.filter((t) => sameText(row, t));
    let how = 'Betrag, Datum und Verwendungszweck gleich';
    if (!found.length && onDay.length === 1) {
      found = onDay;
      how = 'Betrag und Datum gleich, Text weicht ab – bitte prüfen';
    }
    if (!found.length && onDay.length > 1) {
      out[i] = { row, t: null, status: 'mehrdeutig', reason: `${onDay.length} Buchungen mit gleichem Betrag und Datum – bitte wählen`, candidates: onDay };
      continue;
    }
    if (!found.length) {
      found = pool.filter((t) => Math.abs(dayNum(t.date) - d) <= 3 && sameText(row, t));
      how = 'Betrag und Verwendungszweck gleich, Datum bis 3 Tage verschoben';
    }
    if (found.length > 1) {
      // gleiche Buchungen (z. B. zweimal 2,50 € beim Bäcker): in Reihenfolge zuordnen
      const identical = found.every((t) => norm(t.notes) === norm(found[0].notes) && norm(t.description) === norm(found[0].description));
      if (!identical) {
        out[i] = { row, t: null, status: 'mehrdeutig', reason: `${found.length} passende Buchungen – bitte wählen`, candidates: found };
        continue;
      }
      found = [found.sort((x, y) => Number(x.transaction_journal_id) - Number(y.transaction_journal_id))[0]];
      how += ' (gleichartige Buchungen der Reihe nach)';
    }
    const t = found[0];
    if (!t) {
      // Vorschläge zum Auswählen: gleicher Betrag bis 7 Tage daneben
      out[i] = { row, t: null, status: 'nicht-gefunden', reason: 'keine Buchung mit diesem Betrag und Datum', candidates: near(row, 7).slice(0, 5) };
      continue;
    }
    used.add(idOf(t));
    out[i] = { row, t, how, sure: !how.includes('bitte prüfen'), ...statusFor(row, t) };
  }
  // Kandidaten, die inzwischen anderen Zeilen zugeordnet sind, kennzeichnen
  for (const r of out) if (r.candidates) r.candidates = r.candidates.map((t) => ({ t, used: used.has(idOf(t)) }));
  return out;
}

/** CSV-Datei aus Kopfzeile und Originalfeldern bauen (Trennzeichen ;, Anführungszeichen nur wo nötig). */
export function buildCsv(header, rows) {
  const cell = (v) => (/[;"\r\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  return [header, ...rows].filter(Boolean).map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/** Kurzer Hash (cyrb53) – auch ohne crypto.subtle (das fehlt bei http im LAN). */
function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/**
 * Fingerabdruck je Zeile – gleich, egal aus welcher Datei sie stammt. Gleichartige
 * Zeilen (zweimal 2,50 € beim Bäcker) werden durchnummeriert.
 */
export function fingerprints(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const key = [r.date, r.amount.toFixed(2), r.name, r.iban, r.text, r.purpose, r.own].join('|');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return hash(`${key}#${n}`);
  });
}

/** Zahlungsart aus dem Buchungstext („KARTENZAHLUNG girocard“ → „Kartenzahlung“). */
export function paymentKind(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s.trim()) return '';
  if (/karte|girocard|debit|kontaktlos/.test(s)) return 'Kartenzahlung';
  if (/lastschrift|einzug/.test(s)) return 'Lastschrift';
  if (/dauerauftrag/.test(s)) return 'Dauerauftrag';
  if (/gutschrift|lohn|gehalt|rente/.test(s)) return 'Gutschrift';
  if (/überweisung|ueberweisung/.test(s)) return 'Überweisung';
  if (/bargeld|geldautomat|auszahlung/.test(s)) return 'Bargeld';
  if (/entgelt|gebühr|gebuehr|abschluss|zins/.test(s)) return 'Bankentgelt';
  if (/storno|retoure|rückbuchung|rueckbuchung/.test(s)) return 'Rückbuchung';
  return ''; // unbekannt – lieber kein Tag als ein zufälliger
}

/**
 * Aussagekräftigere Beschreibung, wenn die heutige nur ein Bank-Standardtext ist:
 * der bereinigte Verwendungszweck – oder (bei Kartenzahlungen, wo der auch nichts sagt)
 * „Kartenzahlung REWE Markt GmbH“. null = nichts zu ändern.
 */
export function betterDescription(row, t) {
  if (!isGenericText(t.description)) return null;
  const purpose = cleanText(row.purpose);
  const next = !isGenericText(row.purpose) && purpose ? purpose.slice(0, 120)
    : row.name ? `${paymentKind(row.text) || 'Zahlung'} ${row.name}`.slice(0, 120) : null;
  return next && next !== String(t.description).trim() ? next : null;
}

/** Änderung für den n8n-Workflow (typ „gegenkonto_setzen“). */
export const changeFor = ({ row, t }, { iban = true, party = true, description = null, tags = null } = {}) => ({
  transaction_group_id: t.groupId,
  transaction_journal_id: t.transaction_journal_id,
  art: t.type,
  datum: String(t.date).slice(0, 10),
  betrag: t.amount,
  name: row.name,
  ...(party ? {} : { gegenkonto: false }), // nur Beschreibung/Tags ergänzen
  ...(party && iban && row.iban ? { iban: row.iban } : {}),
  ...(party && iban && row.bic ? { bic: row.bic } : {}),
  ...(description ? { beschreibung: description } : {}),
  ...(tags ? { tags } : {}),
  name_alt: counterpartyOf(t) || null,
});
