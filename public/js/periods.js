// Zeiträume für Vergleich und Prognose – rein rechnerisch, ohne DOM. Oberfläche (categories.js)
// und Server (MQTT, lib/mqtt.js) rechnen damit gleich.

import { CALENDAR, today, addDays } from './util.js';

const capToday = (d) => (d > today() ? today() : d);
/** Monatsmodell des Zeitraums: Kalendermonat oder Gehaltsmonat. */
const modelOf = (period) => period.model || CALENDAR;

/**
 * Vergleichszeitraum direkt davor, gleich lang. Läuft der aktuelle Zeitraum
 * noch, wird nur bis zur selben Stelle verglichen (1.–19. Okt. ↔ 1.–19. Sep.;
 * im Gehaltsmonat entsprechend ab dem Gehaltstag).
 */
export function previousRange(period) {
  const { start, end } = period;
  const M = modelOf(period);
  if (!M.aligned(period)) {
    // Eigener Zeitraum: gleich viele Tage direkt davor
    const days = Math.round((capToday(end) - start) / 86400000) + 1;
    return [addDays(start, -days), addDays(start, -1)];
  }
  const kS = M.keyOf(start);
  const n = M.monthsBetween(kS, M.keyOf(end)) + 1;
  const prevStart = M.range(kS, -n)[0];
  const prevEndFull = M.range(kS, -1)[1];
  if (end <= today()) return [prevStart, prevEndFull];
  const shifted = M.shift(today(), -n);
  return [prevStart, shifted < prevEndFull ? shifted : prevEndFull];
}

/** Derselbe Zeitraum ein Jahr früher (bei laufendem Zeitraum bis zur selben Stelle). */
export function yearAgoRange(period) {
  const M = modelOf(period);
  return [M.shift(period.start, -12), M.shift(capToday(period.end), -12)];
}

/**
 * Vergleichsfenster für „den Rest des Zeitraums“: dieselben verbleibenden
 * Tage in früheren Perioden. Monat → die 3 Vormonate, länger → Vorjahr.
 */
export function remainderWindows(period) {
  const from = addDays(today(), 1);
  const to = period.end;
  const M = modelOf(period);
  if (!M.aligned(period)) {
    const len = Math.round((period.end - period.start) / 86400000) + 1;
    return [1, 2, 3].map((k) => [addDays(from, -k * len), addDays(to, -k * len)]);
  }
  const n = M.monthsBetween(M.keyOf(period.start), M.keyOf(period.end)) + 1;
  const shifts = n === 1 ? [1, 2, 3] : [12];
  return shifts.map((k) => [M.shift(from, -k), M.shift(to, -k)]);
}

/**
 * Hochrechnung der Gesamtsumme bis Periodenende: Ø dessen, was in den Vergleichsfenstern noch dazukam.
 * getTotal(start, end) liefert insight/<art>/total – im Browser über api.get, auf dem Server über den Proxy.
 */
export async function forecastTotalWith(getTotal, period) {
  const windows = remainderWindows(period);
  const lists = await Promise.all(windows.map(([s, e]) => getTotal(s, e).catch(() => [])));
  const byCode = new Map();
  for (const list of lists) {
    for (const x of list || []) {
      byCode.set(x.currency_code, (byCode.get(x.currency_code) || 0) + Math.abs(Number(x.difference_float ?? x.difference)) / windows.length);
    }
  }
  return (code) => byCode.get(code) || 0;
}

