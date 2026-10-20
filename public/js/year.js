// Jahresrückblick: Sparquote, Monat für Monat, Highlights, Kategorien im
// Vergleich zum Vorjahr und die größten Ausgaben.

import * as api from './api.js';
import { barChart, legend, seriesColor } from './charts.js';
import { money, percent, esc, fmtDate, today } from './util.js';
import { skeleton, fill, card, stat, sum, mainCurrency, counterparty, txAttrs, bindTxDetails } from './common.js';
import { categoryTotals, delta } from './categories.js';
import { loadRecurring } from './recurring.js';
import { shareStrip } from './dist.js';

const totalOf = (kind, start, end) =>
  api.get(`insight/${kind}/total`, { start, end })
    .then((list) => new Map((list || []).map((x) => [x.currency_code, Math.abs(Number(x.difference_float ?? x.difference))])));

export async function yearReview(view, { params }) {
  const t0 = today();
  const year = Number(params.get('jahr')) || t0.getFullYear();
  const running = year === t0.getFullYear();
  const start = new Date(year, 0, 1);
  const end = running ? t0 : new Date(year, 11, 31);
  // Vorjahr bis zum selben Tag – sonst wäre ein laufendes Jahr immer „besser“
  const pStart = new Date(year - 1, 0, 1);
  const pEnd = new Date(year - 1, end.getMonth(), end.getDate());
  const months = Array.from({ length: 12 }, (_, i) => [new Date(year, i, 1), new Date(year, i + 1, 0)]);
  const years = [t0.getFullYear(), t0.getFullYear() - 1, t0.getFullYear() - 2];

  document.getElementById('page-title').textContent = `Jahresrückblick ${year}`;
  view.innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Jahr">${years.map((y) => `<a class="chip" href="#/jahr?jahr=${y}" aria-pressed="${y === year}">${y}</a>`).join('')}</div>
      <span class="meta-line">${running ? `1. Januar bis heute · Vorjahr bis ${fmtDate(pEnd, { day: 'numeric', month: 'long' })}` : `Vergleich mit ${year - 1}`}</span>
    </div>
    <div class="grid">
      <section class="card span-3" id="y-in"></section>
      <section class="card span-3" id="y-out"></section>
      <section class="card span-3" id="y-saved"></section>
      <section class="card span-3" id="y-avg"></section>
      ${card('y-months', 'Monat für Monat', { span: 'span-8', meta: String(year) })}
      ${card('y-high', 'Highlights', { span: 'span-4' })}
      ${card('y-share', 'Wohin das Geld ging', { meta: String(year) })}
      ${card('y-cats', `Kategorien ${year} vs. ${year - 1}`, { filter: true })}
      ${card('y-top', 'Größte Ausgaben', { span: 'span-7', filter: true })}
      ${card('y-subs', 'Abos & Verträge', { span: 'span-5', link: '<a href="#/wiederkehrend">Alle →</a>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  const totals = Promise.all([totalOf('income', start, end), totalOf('expense', start, end), totalOf('income', pStart, pEnd), totalOf('expense', pStart, pEnd)])
    .then(([i, o, pi, po]) => {
      const code = mainCurrency([...i.keys(), ...o.keys()].map((c) => ({ currency_code: c })));
      return { code, inc: i.get(code) || 0, out: o.get(code) || 0, pinc: pi.get(code) || 0, pout: po.get(code) || 0 };
    });
  const monthly = Promise.all(months.map(([s, e]) => Promise.all([totalOf('income', s, e), totalOf('expense', s, e)])));
  const cats = Promise.all([categoryTotals('expense', start, end), categoryTotals('expense', pStart, pEnd)]);
  const txs = api.getAll('transactions', { start, end, type: 'withdrawal' })
    .then((groups) => api.flattenTransactions(groups).filter((t) => t.type === 'withdrawal'));
  const monthsElapsed = running ? t0.getMonth() + t0.getDate() / new Date(year, t0.getMonth() + 1, 0).getDate() : 12;

  const tile = (id, render) => fill($(id), () => totals, render, skeleton(2, 22));
  tile('y-in', (el, d) => (el.innerHTML = stat('Einnahmen', `<span class="pos">${money(d.inc, d.code)}</span>`, `${delta(d.inc, d.pinc, 'income', d.code)} ggü. Vorjahr`)));
  tile('y-out', (el, d) => (el.innerHTML = stat('Ausgaben', money(d.out, d.code), `${delta(d.out, d.pout, 'expense', d.code)} ggü. Vorjahr`)));
  tile('y-saved', (el, d) => {
    const saved = d.inc - d.out;
    const rate = d.inc ? saved / d.inc : null;
    const prate = d.pinc ? (d.pinc - d.pout) / d.pinc : null;
    el.innerHTML = stat('Gespart', money(saved, d.code, { signed: true }),
      rate === null ? '–' : `Sparquote <b>${percent(rate)}</b>${prate !== null ? ` (Vorjahr ${percent(prate)})` : ''}`);
  });
  tile('y-avg', (el, d) => (el.innerHTML = stat('Ø Ausgaben / Monat', money(d.out / monthsElapsed, d.code), `Ø Einnahmen ${money(d.inc / monthsElapsed, d.code)}`)));

  fill($('y-months'), () => Promise.all([monthly, totals]), (el, [list, d]) => {
    const series = [
      { label: 'Einnahmen', data: list.map(([i]) => i.get(d.code) || 0), color: seriesColor(0) },
      { label: 'Ausgaben', data: list.map(([, o]) => o.get(d.code) || 0), color: seriesColor(1) },
    ];
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Einnahmen und Ausgaben ${year}"></canvas></div>`;
    barChart(el.querySelector('canvas'), { labels: months.map(([s]) => s), series, currency: d.code });
  }, skeleton(1, 280));

  fill($('y-high'), () => Promise.all([monthly, totals, cats, txs]), (el, [list, d, [cur, prev], items]) => {
    const rows = [];
    const done = months.map((m, i) => ({ m, inc: list[i][0].get(d.code) || 0, out: list[i][1].get(d.code) || 0 })).filter((x) => x.m[0] <= t0 && (x.inc || x.out));
    if (done.length) {
      const best = [...done].sort((a, b) => (b.inc - b.out) - (a.inc - a.out))[0];
      const priciest = [...done].sort((a, b) => b.out - a.out)[0];
      rows.push(['Bester Sparmonat', `${fmtDate(best.m[0], { month: 'long' })}`, money(best.inc - best.out, d.code, { signed: true })]);
      rows.push(['Teuerster Monat', `${fmtDate(priciest.m[0], { month: 'long' })}`, money(priciest.out, d.code)]);
    }
    const big = [...items].sort((a, b) => b.amount - a.amount)[0];
    if (big) rows.push(['Größte Einzelausgabe', esc(big.description), money(big.amount, big.currency_code)]);
    const prevById = new Map(prev.map((c) => [c.id, c.value]));
    const changes = cur.filter((c) => c.code === d.code && c.id !== '0').map((c) => ({ ...c, diff: c.value - (prevById.get(c.id) || 0) }));
    const up = [...changes].sort((a, b) => b.diff - a.diff)[0];
    const down = [...prev].filter((c) => c.id !== '0').map((c) => ({ ...c, diff: (cur.find((x) => x.id === c.id)?.value || 0) - c.value })).sort((a, b) => a.diff - b.diff)[0];
    if (up && up.diff > 0) rows.push(['Am stärksten gestiegen', esc(up.name), money(up.diff, d.code, { signed: true })]);
    if (down && down.diff < 0) rows.push(['Am stärksten gesunken', esc(down.name), money(down.diff, d.code, { signed: true })]);
    rows.push(['Buchungen', 'Ausgaben insgesamt', String(items.length)]);
    el.innerHTML = `<div class="list">${rows.map(([k, v, n]) => `<div class="row high-row"><div style="min-width:0"><div class="subtitle">${k}</div><div class="title">${v}</div></div><div></div><div class="amount">${n}</div></div>`).join('')}</div>`;
  }, skeleton(5));

  fill($('y-share'), () => Promise.all([cats, totals]), (el, [[cur], d]) =>
    (el.innerHTML = shareStrip(cur.filter((c) => c.code === d.code), { code: d.code, hrefFor: (p) => `#/kategorien/${encodeURIComponent(p.id)}` })), skeleton(2, 40));

  fill($('y-cats'), () => Promise.all([cats, totals]), (el, [[cur, prev], d]) => {
    const byId = new Map();
    cur.filter((c) => c.code === d.code).forEach((c) => byId.set(c.id, { ...c, prev: 0 }));
    prev.filter((c) => c.code === d.code).forEach((c) => (byId.has(c.id) ? (byId.get(c.id).prev = c.value) : byId.set(c.id, { ...c, value: 0, prev: c.value })));
    const rows = [...byId.values()].sort((a, b) => b.value - a.value);
    const total = sum(rows, (r) => r.value);
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Kategorie</th><th class="num">${year}</th><th class="num hide-sm">${year - 1}</th>
      <th class="num">Veränderung</th><th class="num hide-sm">Anteil</th><th class="num hide-sm">Ø / Monat</th></tr></thead><tbody>${rows
      .map((r) => `<tr data-href="#/kategorien/${encodeURIComponent(r.id)}"><td><a class="plain desc" href="#/kategorien/${encodeURIComponent(r.id)}">${esc(r.name)}</a></td>
        <td class="num"><b>${money(r.value, d.code)}</b></td><td class="num hide-sm muted">${money(r.prev, d.code)}</td>
        <td class="num">${delta(r.value, r.prev, 'expense', d.code)}</td><td class="num hide-sm">${percent(total ? r.value / total : 0)}</td>
        <td class="num hide-sm">${money(r.value / monthsElapsed, d.code)}</td></tr>`)
      .join('')}</tbody></table></div>`;
    el.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-href]');
      if (tr && !e.target.closest('a')) location.hash = tr.dataset.href;
    });
  }, skeleton(8));

  // Größte Ausgaben – gleiche Posten (z. B. 12× Miete) zu einer Zeile zusammengefasst
  fill($('y-top'), () => txs, (el, items) => {
    const groups = new Map();
    for (const t of items) {
      const key = `${String(t.description).toLowerCase().replace(/[0-9]+/g, '')}|${counterparty(t)}`;
      const g = groups.get(key) || { t, n: 0, sum: 0, max: 0 };
      g.n += 1;
      g.sum += t.amount;
      if (t.amount > g.max) {
        g.max = t.amount;
        g.t = t;
      }
      groups.set(key, g);
    }
    const top = [...groups.values()].sort((a, b) => b.max - a.max).slice(0, 15);
    el.innerHTML = top.length
      ? `<div class="table-wrap"><table><tbody>${top.map(({ t, n, sum: total }, i) => `<tr ${txAttrs(i)}><td class="date">${n > 1 ? `${n}×` : fmtDate(t.date)}</td>
          <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterparty(t))}${t.category_name ? ` · ${esc(t.category_name)}` : ''}${n > 1 ? ` · zusammen ${money(total, t.currency_code)}` : ''}</div></td>
          <td class="num"><b>${money(t.amount, t.currency_code)}</b></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Keine Ausgaben.</div>';
    bindTxDetails(el, (i) => top[Number(i)]?.t);
  }, skeleton(6));

  fill($('y-subs'), () => loadRecurring('expense'), (el, { items }) => {
    const active = items.filter((r) => r.active);
    if (!active.length) return (el.innerHTML = '<div class="empty">Keine regelmäßigen Zahlungen erkannt.</div>');
    const code = mainCurrency(active, 'code');
    el.innerHTML = `<div class="stat" style="margin-bottom:12px"><span class="label">Hochgerechnet pro Jahr</span>
        <span class="value">${money(sum(active, (r) => r.perYear), code)}</span><span class="sub">${active.length} aktive Abos & Verträge</span></div>
      <div class="list">${active.slice(0, 8).map((r) => `<div class="row"><div class="avatar">${esc(r.name.slice(0, 2).toUpperCase())}</div>
        <div style="min-width:0"><div class="title">${esc(r.name)}</div><div class="subtitle">${esc(r.rhythm.label)} · ${money(r.amount, r.code)}</div></div>
        <div class="amount">${money(r.perYear, r.code)}</div></div>`).join('')}</div>`;
  }, skeleton(5));
}
