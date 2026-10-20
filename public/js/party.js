// Händler-/Empfänger-Seite: alles zu einem Gegenüber (z. B. „Amazon“) –
// Verlauf, Summe pro Jahr, Kategorien und alle Buchungen der letzten 24 Monate.

import { barChart, legend, seriesColor } from './charts.js';
import { money, esc, fmtDate, fmtMonth, today, startOfMonth, endOfMonth } from './util.js';
import { skeleton, fill, card, stat, sum, mainCurrency, signedAmount, txAttrs, bindTxDetails } from './common.js';
import { shareStrip } from './dist.js';
import { loadHistory } from './check.js';
import { NO_CATEGORY } from './categories.js';

const isParty = (name) => (t) =>
  (t.type === 'withdrawal' && t.destination_name === name) || (t.type === 'deposit' && t.source_name === name);

export async function partyDetail(view, { id: name }) {
  document.getElementById('page-title').textContent = name;
  const t0 = today();
  const months = Array.from({ length: 24 }, (_, i) => [startOfMonth(t0, i - 23), endOfMonth(t0, i - 23)]);
  const yearAgo = startOfMonth(t0, -11);
  const twoYearsAgo = startOfMonth(t0, -23);
  const ff = window.FFD_CONFIG?.fireflyUrl;

  view.innerHTML = `
    <div class="toolbar">
      <a class="chip" href="#/buchungen?q=${encodeURIComponent(`account_is:"${name}"`)}">Alle Buchungen (auch älter) →</a>
      <span class="meta-line" id="p-meta">letzte 24 Monate</span>
    </div>
    <div class="grid">
      <section class="card span-3" id="p-12"></section>
      <section class="card span-3" id="p-avg"></section>
      <section class="card span-3" id="p-count"></section>
      <section class="card span-3" id="p-span"></section>
      ${card('p-months', 'Monatsverlauf', { span: 'span-8', meta: 'letzte 24 Monate' })}
      ${card('p-years', 'Pro Jahr', { span: 'span-4' })}
      ${card('p-cats', 'Kategorien', { meta: 'letzte 24 Monate' })}
      ${card('p-tx', 'Buchungen', { filter: true, meta: '<span id="p-sort"></span>' })}
    </div>`;
  const $ = (sel) => view.querySelector(`#${sel}`);

  const data = loadHistory().then((all) => {
    const txs = all.filter(isParty(name)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const code = mainCurrency(txs);
    const own = txs.filter((t) => t.currency_code === code);
    const out = own.filter((t) => t.type === 'withdrawal');
    const back = own.filter((t) => t.type === 'deposit');
    const inRange = (s, e) => (t) => { const d = new Date(t.date); return d >= s && d <= new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59); };
    return { txs, code, out, back, inRange };
  });

  const tile = (sel, render) => fill($(sel), () => data, render, skeleton(2, 22));
  tile('p-12', (el, d) => {
    const cur = sum(d.out.filter((t) => new Date(t.date) >= yearAgo), (t) => t.amount);
    const prev = sum(d.out.filter((t) => new Date(t.date) >= twoYearsAgo && new Date(t.date) < yearAgo), (t) => t.amount);
    const diff = prev ? (cur - prev) / prev : null;
    el.innerHTML = stat('Ausgaben (12 Monate)', money(cur, d.code), prev
      ? `<span class="${diff > 0 ? 'down' : 'up'}">${diff > 0 ? '+' : ''}${Math.round(diff * 100)} %</span> ggü. den 12 Monaten davor (${money(prev, d.code)})`
      : 'davor keine Ausgaben');
  });
  tile('p-avg', (el, d) => {
    const cur = sum(d.out.filter((t) => new Date(t.date) >= yearAgo), (t) => t.amount);
    const backSum = sum(d.back, (t) => t.amount);
    el.innerHTML = stat('Ø pro Monat', money(cur / 12, d.code), backSum ? `Erstattungen/Einnahmen (24 M.): <span class="pos">${money(backSum, d.code)}</span>` : 'über die letzten 12 Monate');
  });
  tile('p-count', (el, d) => {
    el.innerHTML = stat('Buchungen', String(d.txs.length), d.out.length ? `Ø ${money(sum(d.out, (t) => t.amount) / d.out.length, d.code)} pro Ausgabe` : '');
  });
  tile('p-span', (el, d) => {
    const last = d.txs[0];
    const first = d.txs[d.txs.length - 1];
    const accountId = last && (last.type === 'withdrawal' ? last.destination_id : last.source_id);
    el.innerHTML = stat('Zuletzt', last ? fmtDate(last.date) : '–', `${first ? `erste Buchung ${fmtDate(first.date)}` : ''}${ff && accountId ? `<br><a href="${esc(ff)}/accounts/show/${encodeURIComponent(accountId)}" target="_blank" rel="noopener">Konto in Firefly ↗</a>` : ''}`);
  });

  fill($('p-months'), () => data, (el, d) => {
    if (!d.txs.length) return (el.innerHTML = `<div class="empty">Keine Buchungen mit „${esc(name)}“ in den letzten 24 Monaten.</div>`);
    const series = [{ label: 'Ausgaben', data: months.map(([s, e]) => sum(d.out.filter(d.inRange(s, e)), (t) => t.amount)), color: seriesColor(0) }];
    if (d.back.length) series.push({ label: 'Erstattungen/Einnahmen', data: months.map(([s, e]) => sum(d.back.filter(d.inRange(s, e)), (t) => t.amount)), color: seriesColor(1) });
    const avg = sum(series[0].data, (x) => x) / months.length;
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Ausgaben je Monat bei ${esc(name)}"></canvas></div>`;
    barChart(el.querySelector('canvas'), { labels: months.map(([s]) => fmtMonth(s)), series, currency: d.code, average: avg });
  }, skeleton(1, 260));

  fill($('p-years'), () => data, (el, d) => {
    const years = [...new Set(d.txs.map((t) => new Date(t.date).getFullYear()))].sort((a, b) => b - a);
    if (!years.length) return (el.innerHTML = '<div class="empty">–</div>');
    const ofYear = (list, y) => list.filter((t) => new Date(t.date).getFullYear() === y);
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Jahr</th><th class="num">Ausgaben</th><th class="num">Anzahl</th></tr></thead><tbody>${years
      .map((y) => `<tr style="cursor:default"><td>${y}${y === t0.getFullYear() ? ' <span class="muted">(bis heute)</span>' : y === twoYearsAgo.getFullYear() ? ` <span class="muted">(ab ${fmtDate(twoYearsAgo, { month: 'short' })})</span>` : ''}</td>
        <td class="num">${money(sum(ofYear(d.out, y), (t) => t.amount), d.code)}${ofYear(d.back, y).length ? `<div class="flow pos">+${money(sum(ofYear(d.back, y), (t) => t.amount), d.code)}</div>` : ''}</td>
        <td class="num">${ofYear(d.txs, y).length}</td></tr>`).join('')}</tbody></table></div>`;
  });

  fill($('p-cats'), () => data, (el, d) => {
    const groups = new Map();
    for (const t of d.out) {
      const key = t.category_id ?? NO_CATEGORY;
      const g = groups.get(key) || { id: key, name: t.category_name || 'Ohne Kategorie', value: 0 };
      g.value += t.amount;
      groups.set(key, g);
    }
    el.innerHTML = shareStrip([...groups.values()].sort((a, b) => b.value - a.value), { code: d.code, hrefFor: (p) => `#/kategorien/${encodeURIComponent(p.id)}` });
  });

  let order = 'date';
  fill($('p-tx'), () => data, (el, d) => {
    const render = () => {
      const rows = [...d.txs].sort((a, b) => (order === 'date' ? String(b.date).localeCompare(String(a.date)) : b.amount - a.amount));
      $('p-sort').innerHTML = `<button class="link-btn" data-order="date" aria-pressed="${order === 'date'}">Neueste</button> · <button class="link-btn" data-order="amount" aria-pressed="${order === 'amount'}">Größte</button>`;
      el.innerHTML = rows.length
        ? `<div class="table-wrap scroll"><table><tbody>${rows.map((t, i) => `<tr ${txAttrs(i)}>
            <td class="date">${fmtDate(t.date)}</td>
            <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(t.category_name || 'Ohne Kategorie')}${(t.tags || []).map((x) => ` <span class="tag">${esc(x)}</span>`).join('')}</div></td>
            <td class="num">${signedAmount(t)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">Keine Buchungen.</div>';
      bindTxDetails(el, (i) => rows[Number(i)]);
    };
    render();
    $('p-sort').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-order]');
      if (!btn) return;
      order = btn.dataset.order;
      render();
    });
  }, skeleton(6));
}

