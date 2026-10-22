// Analyse für „Daten aufräumen“ – rein rechnerisch, ohne DOM (Browser und Tests):
//  1) Import-Konfiguration des Firefly Data Importers (JSON) auswerten: Spalten-
//     zuordnung prüfen und aus der Übersetzungstabelle „Händler → Kategorie“
//     Regelvorschläge machen (gleichartige Namen zu „enthält …“ zusammengefasst)
//  2) Ähnliche Gegenkonten (Ausgaben-/Einnahmenkonten) zum Zusammenführen finden

const lower = (s) => String(s ?? '').toLowerCase();
const fold = (s) => lower(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

/** Kurzer, stabiler Hash (cyrb53) für Kennungen. */
export function hash(str) {
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

// ---------------------------------------------------------------------------
// 1) Import-Konfiguration

/** Rollen des Data Importers → verständlich. */
export const ROLE_LABELS = {
  _ignore: 'ignoriert',
  'account-iban': 'eigenes Konto (IBAN)', 'account-bic': 'eigenes Konto (BIC)', 'account-name': 'eigenes Konto (Name)', 'account-number': 'eigenes Konto (Nummer)', 'account-id': 'eigenes Konto (ID)',
  'opposing-iban': 'Gegenkonto (IBAN)', 'opposing-bic': 'Gegenkonto (BIC)', 'opposing-name': 'Gegenkonto (Name)', 'opposing-number': 'Gegenkonto (Nummer)', 'opposing-id': 'Gegenkonto (ID)',
  date_transaction: 'Datum', date_book: 'Buchungsdatum', date_process: 'Verarbeitungsdatum', date_interest: 'Zinsdatum', date_due: 'Fälligkeit', date_payment: 'Zahlungsdatum', date_invoice: 'Rechnungsdatum',
  description: 'Beschreibung', note: 'Notizen', amount: 'Betrag', amount_debit: 'Betrag (Soll)', amount_credit: 'Betrag (Haben)', amount_negated: 'Betrag (umgedreht)',
  'currency-symbol': 'Währung (Symbol)', 'currency-code': 'Währung (Code)', 'category-name': 'Kategorie (Name)', 'category-id': 'Kategorie (ID)',
  'budget-name': 'Budget', 'bill-name': 'Vertrag', 'tags-comma': 'Tags (Komma)', 'tags-space': 'Tags (Leerzeichen)',
  sepa_ci: 'Gläubiger-ID', sepa_db: 'Mandatsreferenz', sepa_ct_id: 'End-to-End-ID', sepa_ep: 'SEPA-Zweck', sepa_country: 'SEPA-Land', sepa_cc: 'SEPA-Clearing', internal_reference: 'interne Referenz', external_id: 'externe ID',
};
/** Spalten im CSV-Export der VR-Banken (18 bzw. 19 Spalten) – nur zur Anzeige. */
const VR_HEADERS = ['Bezeichnung Auftragskonto', 'IBAN Auftragskonto', 'BIC Auftragskonto', 'Bankname Auftragskonto', 'Buchungstag', 'Valutadatum',
  'Name Zahlungsbeteiligter', 'IBAN Zahlungsbeteiligter', 'BIC (SWIFT-Code) Zahlungsbeteiligter', 'Buchungstext', 'Verwendungszweck', 'Betrag', 'Waehrung',
  'Saldo nach Buchung', 'Bemerkung', 'Kategorie', 'Steuerrelevant', 'Glaeubiger ID', 'Mandatsreferenz'];

// Füllwörter, die beim Vergleichen von Händlernamen nicht zählen
const NAME_STOP = new Set(('gmbh mbh co kg ag se ohg ug ek e k ev e v gbr kgaa sarl s a r l sca s c a ltd inc bv b v nv n v'
  + ' sagt danke vielen dank dankt fuer für ihren kauf wir sagen und der die das am im in'
  + ' niederlassung zweigniederlassung deutschland germany europe eu').split(' '));
const nameWords = (s) => fold(s).replace(/[0-9]+/g, ' ').replace(/[^a-z& ]+/g, ' ').split(/\s+/).filter((w) => w && !NAME_STOP.has(w));

/**
 * Längster gemeinsamer Textteil aller Namen (Groß/klein egal), in der Schreibweise des
 * kürzesten – nur ganze Wörter (nicht „ckerei Wilhelm“ oder „ERGO V“).
 */
function commonPart(names) {
  const low = names.map(lower);
  const base = names.reduce((a, b) => (a.length <= b.length ? a : b));
  const baseLow = lower(base);
  const letter = (c) => /[a-zäöüß0-9]/.test(c || '');
  for (let len = baseLow.length; len >= 4; len--) {
    for (let i = 0; i + len <= baseLow.length; i++) {
      if (letter(baseLow[i - 1]) || letter(baseLow[i + len])) continue; // Wortgrenzen
      const sub = baseLow.slice(i, i + len);
      if (!/[a-zäöüß]{3}/.test(sub)) continue;
      // auch in den anderen Namen als ganze Wörter
      if (!low.every((n) => {
        let at = n.indexOf(sub);
        while (at >= 0) {
          if (!letter(n[at - 1]) && !letter(n[at + len])) return true;
          at = n.indexOf(sub, at + 1);
        }
        return false;
      })) continue;
      const out = base.slice(i, i + len).replace(/^[\s.,/\-*]+|[\s.,/\-*]+$/g, '');
      if (out.length >= 4) return out;
    }
  }
  return '';
}

/**
 * Import-Konfiguration auswerten.
 * cfg: JSON des Data Importers; categories: [{ id, name }] aus Firefly.
 * Ergebnis: { columns, hints, items: { id: { names, op, value, category, categoryId, suggested } } }
 */
export function analyzeImportConfig(cfg, categories = []) {
  if (!cfg || !Array.isArray(cfg.roles)) throw new Error('Das sieht nicht nach einer Konfiguration des Firefly Data Importers aus (es fehlt „roles“).');
  const roles = cfg.roles;
  const vr = roles.length === 18 || roles.length === 19;
  const columns = roles.map((role, index) => ({
    index, role, label: ROLE_LABELS[role] || role, header: vr ? VR_HEADERS[index] || '' : '',
    mapped: Object.keys(cfg.mapping?.[index] || {}).length,
  }));
  const hints = [];
  const has = (r) => roles.includes(r);
  const catCols = columns.filter((c) => c.role === 'category-name' && c.mapped);
  for (const c of catCols) {
    hints.push(`Spalte ${c.index + 1}${c.header ? ` („${c.header}“)` : ''} ist als Kategorie zugeordnet, mit einer Übersetzungstabelle für ${c.mapped} Werte. `
      + (c.header === 'Name Zahlungsbeteiligter' || c.mapped > 30 ? 'Das sind vermutlich Händlernamen – sie landen so nie als Empfänger in Firefly. Die Tabelle lässt sich unten in Firefly-Regeln umwandeln.' : ''));
  }
  if (!has('opposing-name') && !has('opposing-iban')) hints.push('Kein Gegenkonto zugeordnet (weder Name noch IBAN) – in Firefly fehlen dadurch die Empfänger. Für künftige Importe „Name Zahlungsbeteiligter“ → Gegenkonto (Name) und „IBAN Zahlungsbeteiligter“ → Gegenkonto (IBAN).');
  const desc = columns.find((c) => c.role === 'description');
  if (desc && desc.header === 'Buchungstext') hints.push('Die Beschreibung kommt aus „Buchungstext“ (Kartenzahlung, Basislastschrift …). Aussagekräftiger: „Verwendungszweck“ als Beschreibung, „Buchungstext“ als Tag oder Notiz.');
  if (cfg.duplicate_detection_method === 'classic') hints.push('Dublettenprüfung „classic“: Nach einer geänderten Zuordnung erkennt sie schon importierte Zeilen nicht mehr – alte Dateien nicht erneut importieren.');

  // Übersetzungstabelle(n) Händler → Kategorie
  const byId = new Map(categories.map((c) => [String(c.id), c.name]));
  const perCat = new Map(); // Kategorie-ID → Namen
  for (const c of catCols) {
    for (const [name, id] of Object.entries(cfg.mapping[c.index] || {})) {
      const k = String(id);
      if (!perCat.has(k)) perCat.set(k, []);
      perCat.get(k).push(name);
    }
  }
  const items = {};
  for (const [catId, names] of perCat) {
    const category = byId.get(catId) || '';
    // gleichartige Namen (Filialnummern, Schreibweisen) zusammenfassen
    const byKey = new Map();
    for (const n of names) {
      const w = nameWords(n);
      const key = w[0] && w[0].length >= 3 ? w[0] : w.slice(0, 2).join(' ');
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(n);
    }
    for (const [key, group] of byKey) {
      const part = group.length > 1 && key ? commonPart(group) : '';
      const sets = part ? [[group, 'contains', part]] : group.map((n) => [[n], 'equals', n]);
      for (const [members, op, value] of sets) {
        const id = `i:${hash(`${catId}|${op}|${lower(value)}`)}`;
        items[id] = { names: members.sort((a, b) => a.localeCompare(b, 'de')), op, value, category, categoryId: catId,
          suggested: { op, value, category } };
      }
    }
  }
  return { columns, hints, items, missingCategories: [...perCat.keys()].filter((k) => !byId.has(k)) };
}

// ---------------------------------------------------------------------------
// 2) Ähnliche Gegenkonten

// Erste Wörter, die allein noch keinen Händler ausmachen – dann zählen zwei Wörter
const GENERIC_FIRST = new Set(('apotheke apo baeckerei blumen praxis dr stadt stadtkasse tankstelle restaurant hotel autohaus deutsche'
  + ' familie frau herr kreis landeskasse bundeskasse finanzamt gemeinschaftspraxis').split(' '));

/** Vergleichsschlüssel eines Kontonamens („REWE Markt GmbH 1234“ → „rewe“). */
export function accountKey(name) {
  const w = nameWords(name);
  if (!w.length) return '';
  if (w[0].length < 3 || GENERIC_FIRST.has(w[0])) return w.slice(0, 2).join(' ');
  return w[0];
}

/**
 * Gruppen ähnlicher Konten gleicher Art: gleicher Schlüssel oder gleiche IBAN.
 * accounts: [{ id, name, type, iban }]; counts: Map(name → Anzahl Buchungen)
 * Ergebnis: [{ key, type, accounts: [{ id, name, iban, n }], target }]
 */
export function mergeGroups(accounts, counts = new Map()) {
  const parent = new Map(accounts.map((a) => [a.id, a.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(a), find(b));
  for (const type of ['expense', 'revenue']) {
    const list = accounts.filter((a) => a.type === type);
    const first = new Map();
    for (const a of list) {
      for (const k of [`k:${accountKey(a.name)}`, a.iban ? `i:${String(a.iban).replace(/\s+/g, '').toUpperCase()}` : null]) {
        if (!k || k === 'k:') continue;
        if (first.has(k)) union(a.id, first.get(k));
        else first.set(k, a.id);
      }
    }
  }
  const groups = new Map();
  for (const a of accounts) {
    const root = find(a.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ ...a, n: counts.get(lower(a.name)) || 0 });
  }
  return [...groups.values()].filter((g) => g.length > 1).map((list) => {
    list.sort((a, b) => b.n - a.n || a.name.length - b.name.length);
    const key = `${list[0].type}:${accountKey(list[0].name) || hash(list.map((a) => a.id).sort().join(','))}`;
    return { key, type: list[0].type, accounts: list, target: list[0].id };
  }).sort((a, b) => b.accounts.reduce((s, x) => s + x.n, 0) - a.accounts.reduce((s, x) => s + x.n, 0));
}
