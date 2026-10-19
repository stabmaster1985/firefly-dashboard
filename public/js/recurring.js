// Wiederkehrende Zahlungen automatisch erkennen – ohne dass in Firefly
// Verträge/Rechnungen gepflegt sein müssen.

import * as api from './api.js';
import { money, esc, fmtDate, today, startOfMonth, addDays, isoDate, parseDate } from './util.js';
import { skeleton, fill, card, stat, mainCurrency, sum } from './common.js';

const RHYTHMS = [
  { days: 7, label: 'wöchentlich', tol: 2, min: 4 },
  { days: 14, label: 'alle 2 Wochen', tol: 3, min: 4 },
  { days: 30.44, label: 'monatlich', tol: 6, min: 3 },
  { days: 61, label: 'alle 2 Monate', tol: 10, min: 3 },
  { days: 91.3, label: 'vierteljährlich', tol: 15, min: 3 },
  { days: 182.6, label: 'halbjährlich', tol: 25, min: 2 },
  { days: 365.25, label: 'jährlich', tol: 30, min: 2 },
];

const median = (list) => {
  const v = [...list].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const DAY = 86400000;

/**
 * Gruppiert nach Gegenkonto und prüft, ob Abstände und Beträge regelmäßig
 * sind: ≥ 70 % der Abstände passen zum Rhythmus, ≥ 70 % der Beträge liegen
 * innerhalb ±25 % des typischen Betrags.
 */
export function detectRecurring(transactions, kind) {
  const groups = new Map();
  for (const t of transactions) {
    const name = kind === 'income' ? t.source_name : t.destination_name;
    if (!name) continue;
    const key = name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, items: [] });
    groups.get(key).items.push(t);
  }
  const t0 = today();
  const found = [];
  for (const { name, items } of groups.values()) {
    if (items.length < 2) continue;
    const code = mainCurrency(items);
    const list = items.filter((t) => t.currency_code === code)
      .map((t) => ({ ...t, day: parseDate(t.date) }))
      .sort((a, b) => a.day - b.day);
    const gaps = list.slice(1).map((t, i) => (t.day - list[i].day) / DAY).filter((g) => g > 0);
    if (!gaps.length) continue;
    const gap = median(gaps);
    const rhythm = RHYTHMS.find((r) => Math.abs(gap - r.days) <= r.tol);
    if (!rhythm || list.length < rhythm.min) continue;
    const regular = gaps.filter((g) => Math.abs(g - rhythm.days) <= rhythm.tol).length / gaps.length;
    const amount = median(list.map((t) => t.amount));
    const stable = list.filter((t) => Math.abs(t.amount - amount) <= amount * 0.25).length / list.length;
    if (regular < 0.7 || stable < 0.7) continue;
    const last = list.at(-1);
    const daysSince = (t0 - last.day) / DAY;
    const active = daysSince <= rhythm.days * 1.5 + rhythm.tol;
    let next = addDays(last.day, Math.round(rhythm.days));
    while (active && next < t0) next = addDays(next, Math.round(rhythm.days));
    const cats = new Map();
    list.forEach((t) => t.category_name && cats.set(t.category_name, (cats.get(t.category_name) || 0) + 1));
    found.push({
      name,
      code,
      rhythm,
      amount,
      count: list.length,
      first: list[0].day,
      last: last.day,
      lastAmount: last.amount,
      next: active ? next : null,
      active,
      perYear: (amount * 365.25) / rhythm.days,
      category: [...cats].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      changed: Math.abs(last.amount - amount) > Math.max(1, amount * 0.05),
    });
  }
  return found.sort((a, b) => b.perYear - a.perYear);
}

export async function recurring(view, { params }) {
  const kind = params.get('art') === 'einnahmen' ? 'income' : 'expense';
  const showAll = params.get('alle') === '1';
  const t0 = today();
  const from = startOfMonth(t0, -24);
  const hrefWith = (changes) => {
    const qs = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? qs.set(k, v) : qs.delete(k)));
    return `#/wiederkehrend${qs.toString() ? `?${qs}` : ''}`;
  };

  view.innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Art">
        <a class="chip" href="${hrefWith({ art: '' })}" aria-pressed="${kind === 'expense'}">Ausgaben</a>
        <a class="chip" href="${hrefWith({ art: 'einnahmen' })}" aria-pressed="${kind === 'income'}">Einnahmen</a>
      </div>
      <div class="chips" role="group" aria-label="Status">
        <a class="chip" href="${hrefWith({ alle: '' })}" aria-pressed="${!showAll}">Aktive</a>
        <a class="chip" href="${hrefWith({ alle: '1' })}" aria-pressed="${showAll}">Inkl. beendete</a>
      </div>
      <span class="meta-line">Automatisch erkannt aus den Buchungen seit ${fmtDate(from)}</span>
    </div>
    <div class="grid">
      <section class="card span-3" id="r-month"></section>
      <section class="card span-3" id="r-year"></section>
      <section class="card span-3" id="r-count"></section>
      <section class="card span-3" id="r-next"></section>
      ${card('r-table', kind === 'income' ? 'Regelmäßige Einnahmen' : 'Regelmäßige Zahlungen', { filter: true, meta: '<span id="r-meta"></span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  const data = api.getAll('transactions', { start: from, end: t0, type: kind === 'income' ? 'deposit' : 'withdrawal' })
    .then((groups) => detectRecurring(api.flattenTransactions(groups), kind));
  const visible = (list) => list.filter((r) => showAll || r.active);
  const tile = (id, render) => fill($(id), () => data, render, skeleton(2, 22));

  tile('r-month', (el, list) => {
    const active = list.filter((r) => r.active);
    const code = mainCurrency(active, 'code');
    el.innerHTML = stat('Pro Monat', money(sum(active, (r) => r.perYear) / 12, code), 'aktive, umgerechnet');
  });
  tile('r-year', (el, list) => {
    const active = list.filter((r) => r.active);
    const code = mainCurrency(active, 'code');
    el.innerHTML = stat('Pro Jahr', money(sum(active, (r) => r.perYear), code), 'aktive, hochgerechnet');
  });
  tile('r-count', (el, list) => {
    const active = list.filter((r) => r.active).length;
    el.innerHTML = stat('Erkannt', String(active), `${list.length - active} vermutlich beendet`);
  });
  tile('r-next', (el, list) => {
    const soon = list.filter((r) => r.next && r.next <= addDays(t0, 30));
    const code = mainCurrency(soon, 'code');
    el.innerHTML = stat('Nächste 30 Tage', money(sum(soon, (r) => r.amount), code), `${soon.length} erwartete ${kind === 'income' ? 'Eingänge' : 'Zahlungen'}`);
  });

  fill($('r-table'), () => data, (el, list) => {
    const rows = visible(list);
    $('r-meta').textContent = `${rows.length} Einträge`;
    if (!rows.length) return (el.innerHTML = '<div class="empty">Nichts Regelmäßiges gefunden.</div>');
    const op = kind === 'income' ? 'source_account_is' : 'destination_account_is';
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>${kind === 'income' ? 'Von' : 'Empfänger'}</th><th class="hide-sm">Rhythmus</th><th class="num">Betrag</th>
        <th class="num hide-sm">Pro Jahr</th><th class="hide-sm">Zuletzt</th><th>Nächste</th></tr></thead>
      <tbody>${rows
        .map((r) => `<tr data-href="#/buchungen?q=${encodeURIComponent(`${op}:"${r.name}"`)}&von=${isoDate(from)}&bis=${isoDate(t0)}"${r.active ? '' : ' class="inactive"'}>
          <td><div class="desc">${esc(r.name)}</div><div class="flow">${esc(r.category || 'ohne Kategorie')} · ${r.count}× seit ${fmtDate(r.first, { month: 'short', year: 'numeric' })}</div></td>
          <td class="hide-sm">${esc(r.rhythm.label)}</td>
          <td class="num"><b>${money(r.amount, r.code)}</b>${r.changed ? `<div class="flow" title="Letzter Betrag weicht ab">zuletzt ${money(r.lastAmount, r.code)}</div>` : ''}</td>
          <td class="num hide-sm">${money(r.perYear, r.code)}</td>
          <td class="hide-sm date">${fmtDate(r.last)}</td>
          <td>${r.active ? `<span class="date">${fmtDate(r.next)}</span>` : '<span class="badge">beendet?</span>'}</td>
        </tr>`)
        .join('')}</tbody></table></div>
      <div class="legend" style="margin-top:12px"><span>Erkannt, wenn Abstände und Beträge regelmäßig sind · Zeile anklicken zeigt alle Buchungen</span></div>`;
    el.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-href]');
      if (tr) location.hash = tr.dataset.href;
    });
  }, skeleton(8));
}
