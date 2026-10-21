// Lernen an Beispielen – ohne KI: Aus den Buchungen einer Gruppe (Beispiele)
// und den als „gehört nicht dazu“ markierten (Gegenbeispiele) werden ähnliche
// Buchungen gesucht und am Ende möglichst allgemeine Regeln gebildet.
//
// Merkmale: Empfänger (bei PayPal & Co. der Buchungstext), seltene Wörter im
// Verwendungszweck (gewichtet nach Seltenheit), Betrag, bisherige Kategorie.

import { partyKey, ruleMatches, merchantOf, wordConds } from './rules.js';
import { words } from './structure.js';

const idOf = (t) => String(t.transaction_journal_id);

/** Merkmale aller Buchungen einmal berechnen (für viele Suchen wiederverwendbar). */
export function buildIndex(txs) {
  const items = txs.map((t) => ({ t, id: idOf(t), party: partyKey(t), words: words(t) }));
  const df = new Map();
  for (const it of items) for (const w of it.words) df.set(w, (df.get(w) || 0) + 1);
  const n = items.length;
  return {
    items,
    byId: new Map(items.map((it) => [it.id, it])),
    // seltene Wörter zählen mehr (wie „Sonnenschein“), häufige kaum (wie „Einkauf“)
    idf: (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1)),
  };
}

/** Kennzahlen einer Menge von Buchungen (Beispiele oder Gegenbeispiele). */
function profile(index, list) {
  const parties = new Map();
  const wordCount = new Map();
  const cats = new Map();
  for (const it of list) {
    parties.set(it.party, (parties.get(it.party) || 0) + 1);
    for (const w of it.words) wordCount.set(w, (wordCount.get(w) || 0) + 1);
    if (it.t.category_name) cats.set(it.t.category_name, (cats.get(it.t.category_name) || 0) + 1);
  }
  const weight = new Map();
  for (const [w, c] of wordCount) {
    const idf = index.idf(w);
    // nur seltenere Wörter (in weniger als ~20 % aller Buchungen) zählen
    if (idf > 1.6) weight.set(w, (c / list.length) * idf);
  }
  const amounts = list.map((it) => it.t.amount).sort((a, b) => a - b);
  const topCat = [...cats].sort((a, b) => b[1] - a[1])[0];
  return { size: list.length, parties, weight, amounts, topCat: topCat && topCat[1] / list.length >= 0.6 ? topCat[0] : null };
}

const nameOf = (it) => merchantOf(it.t).name;

/**
 * Ähnliche Buchungen zu den Beispielen. Ergebnis: [{ t, score, sure, reasons }]
 * – „sure“ (sehr ähnlich) wird in der Oberfläche schon angehakt.
 */
export function findSimilar(index, includeIds, excludeIds = [], { limit = 150 } = {}) {
  const inc = new Set(includeIds);
  const exc = new Set(excludeIds);
  const pos = [...inc].map((id) => index.byId.get(id)).filter(Boolean);
  if (!pos.length) return [];
  const neg = [...exc].map((id) => index.byId.get(id)).filter(Boolean);
  const P = profile(index, pos);
  const N = neg.length ? profile(index, neg) : null;
  const tight = P.amounts.length >= 2 && (P.amounts[P.amounts.length - 1] - P.amounts[0]) / (P.amounts[Math.floor(P.amounts.length / 2)] || 1) < 0.5;

  const out = [];
  for (const it of index.items) {
    if (inc.has(it.id) || exc.has(it.id)) continue;
    let score = 0;
    const reasons = [];
    const pc = P.parties.get(it.party);
    if (pc) {
      score += 4 + Math.min(2, (pc - 1) * 0.5);
      reasons.push(`gleicher Empfänger wie ${pc} Beispiel${pc === 1 ? '' : 'e'} („${nameOf(it)}“)`);
    }
    const shared = it.words.filter((w) => P.weight.has(w)).sort((a, b) => P.weight.get(b) - P.weight.get(a));
    const wordScore = Math.min(5, shared.reduce((a, w) => a + P.weight.get(w), 0));
    if (wordScore > 0.3) {
      score += wordScore;
      reasons.push(`${shared.length === 1 ? 'Wort' : 'Wörter'} ${shared.slice(0, 3).map((w) => `„${w}“`).join(', ')}`);
    }
    const a = it.t.amount;
    if (tight && a >= P.amounts[0] * 0.9 && a <= P.amounts[P.amounts.length - 1] * 1.1) {
      score += 0.75;
      reasons.push('ähnlicher Betrag');
    } else if (P.amounts.length === 1 && Math.abs(a - P.amounts[0]) <= P.amounts[0] * 0.03) {
      score += 0.5;
      reasons.push('gleicher Betrag');
    }
    if (P.topCat && it.t.category_name === P.topCat && score > 0) {
      score += 0.5;
      reasons.push(`auch „${P.topCat}“`);
    }
    // Gegenbeispiele ziehen ab
    if (N) {
      if (N.parties.get(it.party)) {
        score -= 4;
        reasons.push('Empfänger auch bei „gehört nicht dazu“');
      }
      const against = Math.min(4, it.words.filter((w) => N.weight.has(w)).reduce((s, w) => s + N.weight.get(w), 0));
      if (against > 0.5) score -= against;
    }
    // Betrag und Kategorie allein reichen nicht – es braucht Empfänger oder Wörter
    const strong = pc || wordScore >= 1.2;
    if (strong && score >= 1.5) out.push({ t: it.t, id: it.id, score: Math.round(score * 10) / 10, sure: score >= 4, reasons });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Stabile Regel-ID aus Gruppe + Bedingung – so wird eine Regel beim erneuten Übertragen aktualisiert statt neu angelegt. */
const stableId = (groupId, when) => {
  let h = 5381;
  for (const ch of `${groupId}|${JSON.stringify(when)}`) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `g${h.toString(36)}`;
};

/**
 * Möglichst wenige, möglichst allgemeine Regeln für genau diese Gruppe:
 * Eine Regel wird nur genommen, wenn sie keine Buchung außerhalb der Gruppe
 * trifft (also auch kein Gegenbeispiel). Was übrig bleibt, wird als
 * „einzelne Buchungen“ gesetzt (einmalig, nicht als Firefly-Regel).
 */
export function proposeRules(index, includeIds, { kind, name, groupId }) {
  const inc = new Set(includeIds.filter((id) => index.byId.has(id)));
  const action = kind === 'tag' ? { setCategory: '', addTags: [name] } : { setCategory: name, addTags: [] };
  const make = (when, label) => ({ id: stableId(groupId, when.map((c) => (c.field === 'journal' ? { field: 'journal' } : c))), enabled: true, when, ...action, groupId, label });

  const candidates = [];
  const seen = new Set();
  for (const id of inc) {
    const it = index.byId.get(id);
    // Empfänger (bei Zahlungsdiensten/„Kartenzahlung“: Kennwort in Beschreibung oder Notizen)
    const pc = merchantOf(it.t).cond;
    const pKey = `${pc.field}:${String(pc.value).toLowerCase()}`;
    if (pc.value && !seen.has(pKey)) {
      seen.add(pKey);
      candidates.push({ rule: make([pc], pc.field === 'party' ? `Empfänger „${pc.value}“` : `${pc.field === 'notes' ? 'Notiz' : 'Text'} enthält „${pc.value}“`), prio: 2 });
    }
    for (const w of it.words) {
      const wKey = `w:${w}`;
      if (seen.has(wKey)) continue;
      seen.add(wKey);
      const [wc] = wordConds(w, [it.t]); // das Wort steht in der Beschreibung oder in den Notizen
      candidates.push({ rule: make([wc], `${wc.field === 'notes' ? 'Notiz' : 'Text'} enthält „${w}“`), prio: 1, word: true });
    }
  }
  // Treffer jeder Kandidaten-Regel
  for (const c of candidates) {
    const hits = index.items.filter((it) => ruleMatches(c.rule, it.t));
    c.covers = new Set(hits.filter((it) => inc.has(it.id)).map((it) => it.id));
    c.outside = hits.length - c.covers.size;
  }
  const usable = candidates.filter((c) => c.outside === 0 && c.covers.size > 0 && (!c.word || c.covers.size >= 2));

  // gierig: jeweils die Regel, die die meisten noch offenen Buchungen abdeckt
  const open = new Set(inc);
  const rules = [];
  while (open.size) {
    let best = null;
    let bestGain = 0;
    for (const c of usable) {
      const gain = [...c.covers].filter((id) => open.has(id)).length;
      if (gain > bestGain || (gain === bestGain && gain > 0 && best && c.prio > best.prio)) [best, bestGain] = [c, gain];
    }
    if (!best) break;
    rules.push({ ...best.rule, count: bestGain });
    best.covers.forEach((id) => open.delete(id));
  }
  const rest = [...open];
  if (rest.length) {
    rules.push({ ...make([{ field: 'journal', op: 'in', value: rest.join(',') }], `${rest.length} einzelne Buchung${rest.length === 1 ? '' : 'en'}`), count: rest.length, oneOff: true });
  }
  return { rules, permanent: rules.filter((r) => !r.oneOff).length, oneOff: rest.length };
}
