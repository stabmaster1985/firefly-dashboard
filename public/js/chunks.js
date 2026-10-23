// Lange Zeiträume in Kalendermonate zerlegen – für Buchungslisten über viele Monate.
// Abgeschlossene Monate ändern sich praktisch nie: Der Server hält sie lange (und auf der
// Platte, auch über Neustarts), nur der laufende Monat wird oft neu geholt. Browser, Server
// (Fragen, KI) und Vorwärmen zerlegen gleich – so teilen sie sich die Einträge.
// Rein rechnerisch, ohne DOM.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (v) => (v instanceof Date ? new Date(v.getFullYear(), v.getMonth(), v.getDate()) : new Date(`${String(v).slice(0, 10)}T00:00:00`));

/**
 * [start, end] (Date oder JJJJ-MM-TT) → [[start, end], …] je Kalendermonat, neuester zuerst
 * (wie Firefly sortiert). Liegt alles in einem Monat, bleibt es eine Abfrage.
 */
export function monthChunks(start, end) {
  const s = parse(start);
  const e = parse(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s > e) return [[start, end]];
  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) return [[iso(s), iso(e)]];
  const out = [];
  for (let m = new Date(s.getFullYear(), s.getMonth(), 1); m <= e; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const from = m < s ? s : m;
    const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    out.push([iso(from), iso(last > e ? e : last)]);
  }
  return out.reverse();
}

/** Buchungslisten, die zerlegt werden: /transactions und /accounts/{id}/transactions. */
export const isTxList = (path) => /^(accounts\/\d+\/)?transactions$/.test(path);
