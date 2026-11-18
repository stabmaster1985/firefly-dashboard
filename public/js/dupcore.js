// Doppelte Buchungen finden – rein rechnerisch (Browser: Prüfen · Server: Import-Bericht).

const DAY = 86400000;
const dayOf = (t) => Math.floor(new Date(String(t.date).slice(0, 10)).getTime() / DAY);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const pairKey = (a, b) => [a.transaction_journal_id, b.transaction_journal_id].sort().join('-');


/**
 * Paare gleicher Buchungen (Art, Betrag, Konten, Währung) höchstens 3 Tage
 * auseinander. Stufe: „sicher“ (gleiche Referenz/externe ID), „wahrscheinlich“
 * (gleicher Text am selben Tag), sonst „möglich“.
 */
export function findDuplicates(txs, ok = new Set()) {
  const groups = new Map();
  for (const t of txs) {
    const key = [t.type, Math.abs(t.amount).toFixed(2), t.currency_code, t.source_id ?? t.source_name, t.destination_id ?? t.destination_name].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const pairs = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => dayOf(a) - dayOf(b));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && dayOf(list[j]) - dayOf(list[i]) <= 3; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.groupId === b.groupId || ok.has(pairKey(a, b))) continue;
        const ref = (t) => t.external_id || t.internal_reference || t.sepa_ct_id || '';
        // Umbuchung zwischen eigenen Konten, aus BEIDEN Konto-CSVs importiert: gleiche Konten, gleicher Betrag,
        // gleicher Tag – die Referenzen und Texte der beiden Seiten unterscheiden sich naturgemäß
        // („Dauerauftragsbelast“ / „Dauerauftragsgutschr“)
        const bothSides = a.type === 'transfer' && dayOf(a) === dayOf(b) && norm(a.description) !== norm(b.description);
        // unterschiedliche Bank-Referenzen → zwei echte Buchungen (außer bei beiden Seiten einer Umbuchung)
        if (!bothSides && ref(a) && ref(b) && ref(a) !== ref(b)) continue;
        const level = ref(a) && ref(a) === ref(b) ? 3 : bothSides || (norm(a.description) === norm(b.description) && dayOf(a) === dayOf(b)) ? 2 : 1;
        pairs.push({ a, b, level, key: pairKey(a, b), bothSides });
      }
    }
  }
  return pairs.sort((x, y) => y.level - x.level || String(y.a.date).localeCompare(String(x.a.date)));
}

