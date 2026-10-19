// Ziele je Kategorie (Monatsbetrag) – gespeichert auf dem Dashboard-Server,
// unabhängig von Firefly-Budgets.

import { CALENDAR, today, money, percent, esc } from './util.js';

let cache = null;
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };

export function loadGoals() {
  cache ??= fetch('/local/goals')
    .then((r) => r.json())
    .then((d) => d.goals || {})
    .catch(() => ({}));
  return cache;
}

/** Ziel setzen (amount > 0) oder entfernen (amount leer/0). */
export async function saveGoal(id, name, amount) {
  const goals = { ...(await loadGoals()) };
  if (amount > 0) goals[id] = { name, amount };
  else delete goals[id];
  const res = await fetch('/local/goals', { method: 'PUT', headers, body: JSON.stringify({ goals }) });
  const data = await res.json();
  cache = Promise.resolve(data.goals || {});
  return data.goals || {};
}

/** Wie viele (Gehalts-)Monate umfasst der Zeitraum? Ziele gelten pro Monat. */
export function monthsInPeriod(period) {
  const M = period.model || CALENDAR;
  if (M.aligned(period)) return M.monthsBetween(M.keyOf(period.start), M.keyOf(period.end)) + 1;
  return Math.max(1, Math.round(((period.end - period.start) / 86400000 + 1) / 30.44 * 10) / 10);
}

/** Anteil des Zeitraums, der schon vergangen ist (für „im Plan?“). */
function elapsed(period) {
  const t = today();
  if (t < period.start) return 0;
  if (t > period.end) return 1;
  return (t - period.start + 86400000) / (period.end - period.start + 86400000);
}

/**
 * Bewertung eines Betrags gegen das Ziel im Zeitraum: überschritten,
 * über Plan (schneller als die Zeit) oder im Plan. Text + Klasse, nie nur Farbe.
 */
export function goalStatus(value, goal, period, forecast = null) {
  const limit = goal * monthsInPeriod(period);
  const used = limit ? value / limit : 0;
  const share = elapsed(period);
  if (used > 1) return { cls: 'bad', label: 'Ziel überschritten', limit, used };
  if (forecast !== null && forecast > limit) return { cls: 'warn', label: 'Prognose über Ziel', limit, used };
  if (share < 1 && used > share + 0.1) return { cls: 'warn', label: 'Über Plan', limit, used };
  return { cls: 'good', label: share < 1 ? 'Im Plan' : 'Eingehalten', limit, used };
}

/** Fortschrittsbalken mit Tagesmarkierung. */
export function goalBar(value, goal, period, code, forecast = null) {
  const st = goalStatus(value, goal, period, forecast);
  const share = elapsed(period);
  return `<div class="goal">
    <div class="progress ${st.cls === 'bad' ? 'over' : st.cls === 'warn' ? 'warn' : ''}" title="${percent(st.used)} des Ziels">
      <span style="width:${Math.min(100, st.used * 100)}%"></span>
      ${share > 0 && share < 1 ? `<i class="pace" style="left:${share * 100}%" title="Heute"></i>` : ''}
    </div>
    <div class="goal-foot"><span>${money(value, code)} von ${money(st.limit, code)}${forecast !== null ? ` · ≈ ${money(forecast, code)}` : ''}</span>
      <span class="badge ${st.cls}">${esc(st.label)}</span></div>
  </div>`;
}
