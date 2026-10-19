// Detailseite eines Kontos: Kontostand-Verlauf, Ein-/Ausgänge je Monat,
// Verteilung nach Kategorie und alle Buchungen.

import * as api from './api.js';
import { barChart, lineChart, legend, seriesColor } from './charts.js';
import { money, esc, fmtDate, fmtMonth, today, startOfMonth, endOfMonth, addDays, isoDate, parseDate } from './util.js';
import { skeleton, fill, card, stat, sum, counterparty, mainCurrency } from './common.js';
import { shareStrip } from './dist.js';
import { ROLE } from './views.js';

export async function accountDetail(view, { period, id }) {
  const { start, end } = period;
  const t0 = today();
  const histStart = startOfMonth(t0, -11) < start ? startOfMonth(t0, -11) : start;
  const titleEl = document.getElementById('page-title');

  view.innerHTML = `
    <div class="toolbar"><a class="back" href="#/konten">← Alle Konten</a><span class="meta-line" id="a-meta"></span></div>
    <div class="grid">
      <section class="card span-3" id="a-balance"></section>
      <section class="card span-3" id="a-in"></section>
      <section class="card span-3" id="a-out"></section>
      <section class="card span-3" id="a-net"></section>
      ${card('a-chart', 'Kontostand', { span: 'span-7', meta: esc(period.label) })}
      ${card('a-months', 'Ein- und Ausgänge je Monat', { span: 'span-5', meta: 'letzte 12 Monate' })}
      ${card('a-cats', 'Ausgaben nach Kategorie', { meta: esc(period.label) })}
      ${card('a-tx', 'Buchungen', { filter: true, meta: '<span id="a-count"></span>' })}
    </div>`;
  const $ = (sel) => view.querySelector(`#${sel}`);

  const accountP = api.get(`accounts/${encodeURIComponent(id)}`).then((r) => ({ id: r.data.id, ...r.data.attributes }));
  // Alle Buchungen ab Verlaufsbeginn bis heute – daraus lassen sich die Salden rückwärts rechnen
  const txsP = api.getAll(`accounts/${encodeURIComponent(id)}/transactions`, { start: histStart, end: t0 > end ? t0 : end })
    .then((groups) => api.flattenTransactions(groups));

  /** Betrag aus Sicht dieses Kontos: Abgang negativ, Zugang positiv. */
  const signed = (t) => (String(t.source_id) === String(id) ? -t.amount : String(t.destination_id) === String(id) ? t.amount : 0);
  const inPeriod = (t) => {
    const d = parseDate(t.date);
    return d >= start && d <= end;
  };

  accountP.then((a) => {
    if (!view.contains($('a-meta'))) return;
    titleEl.textContent = a.name;
    document.title = `${a.name} · Firefly Dashboard`;
    $('a-meta').textContent = [ROLE[a.account_role] || a.type, a.iban].filter(Boolean).join(' · ');
  }).catch(() => {});

  const both = Promise.all([accountP, txsP]);
  const tile = (sel, render) => fill($(sel), () => both, render, skeleton(2, 22));
  tile('a-balance', (el, [a]) => (el.innerHTML = stat('Kontostand', money(a.current_balance, a.currency_code), `Stand ${fmtDate(a.current_balance_date || t0)}`)));
  tile('a-in', (el, [a, txs]) => {
    const own = txs.filter((t) => inPeriod(t) && signed(t) > 0);
    el.innerHTML = stat('Eingänge', `<span class="pos">${money(sum(own, signed), a.currency_code)}</span>`, `${own.length} Buchungen · ${esc(period.label)}`);
  });
  tile('a-out', (el, [a, txs]) => {
    const own = txs.filter((t) => inPeriod(t) && signed(t) < 0);
    el.innerHTML = stat('Ausgänge', money(-sum(own, signed), a.currency_code), `${own.length} Buchungen · ${esc(period.label)}`);
  });
  tile('a-net', (el, [a, txs]) => {
    const net = sum(txs.filter(inPeriod), signed);
    el.innerHTML = stat('Veränderung', money(net, a.currency_code, { signed: true }), esc(period.label));
  });

  // Täglicher Kontostand: vom aktuellen Saldo aus rückwärts
  fill($('a-chart'), () => both, (el, [a, txs]) => {
    const byDay = new Map();
    txs.forEach((t) => {
      const k = isoDate(parseDate(t.date));
      byDay.set(k, (byDay.get(k) || 0) + signed(t));
    });
    const last = end < t0 ? end : t0;
    let bal = Number(a.current_balance);
    // Buchungen nach dem Ende des Zeitraums herausrechnen
    for (const [k, v] of byDay) if (k > isoDate(last)) bal -= v;
    const points = [];
    for (let d = last; d >= start; d = addDays(d, -1)) {
      points.push([new Date(d), bal]);
      bal -= byDay.get(isoDate(d)) || 0;
    }
    points.reverse();
    const step = Math.max(1, Math.ceil(points.length / 120));
    const shown = points.filter((_, i, arr) => i % step === 0 || i === arr.length - 1);
    el.innerHTML = '<div class="chart-box"><canvas aria-label="Kontostand"></canvas></div>';
    lineChart(el.querySelector('canvas'), {
      labels: shown.map(([d]) => d),
      series: [{ label: a.name, data: shown.map(([, v]) => v), color: seriesColor(0) }],
      currency: a.currency_code,
    });
  }, skeleton(1, 280));

  fill($('a-months'), () => both, (el, [a, txs]) => {
    const months = Array.from({ length: 12 }, (_, i) => [startOfMonth(t0, i - 11), endOfMonth(t0, i - 11)]);
    const inS = months.map(() => 0);
    const outS = months.map(() => 0);
    txs.forEach((t) => {
      const d = parseDate(t.date);
      const i = months.findIndex(([s, e]) => d >= s && d <= e);
      if (i < 0) return;
      const v = signed(t);
      if (v > 0) inS[i] += v;
      else outS[i] -= v;
    });
    const series = [
      { label: 'Eingänge', data: inS, color: seriesColor(0) },
      { label: 'Ausgänge', data: outS, color: seriesColor(1) },
    ];
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Ein- und Ausgänge je Monat"></canvas></div>`;
    barChart(el.querySelector('canvas'), { labels: months.map(([s]) => s), series, currency: a.currency_code });
  }, skeleton(1, 280));

  fill($('a-cats'), () => both, (el, [a, txs]) => {
    const groups = new Map();
    txs.filter((t) => inPeriod(t) && t.type === 'withdrawal' && signed(t) < 0).forEach((t) => {
      const name = t.category_name || 'Ohne Kategorie';
      const g = groups.get(name) || { name, id: t.category_id ?? '0', value: 0 };
      g.value += t.amount;
      groups.set(name, g);
    });
    el.innerHTML = shareStrip([...groups.values()], { code: a.currency_code, hrefFor: (p) => `#/kategorien/${encodeURIComponent(p.id)}` });
  }, skeleton(2, 40));

  fill($('a-tx'), () => both, (el, [a, txs]) => {
    const rows = txs.filter(inPeriod).sort((x, y) => String(y.date).localeCompare(String(x.date)));
    $('a-count').textContent = `${rows.length} im Zeitraum`;
    if (!rows.length) return (el.innerHTML = '<div class="empty">Keine Buchungen im Zeitraum.</div>');
    const ff = window.FFD_CONFIG?.fireflyUrl;
    el.innerHTML = `<div class="table-wrap scroll"><table>
      <thead><tr><th>Datum</th><th>Beschreibung</th><th class="hide-sm">Kategorie</th><th class="num">Betrag</th></tr></thead>
      <tbody>${rows
        .map((t, i) => {
          const v = signed(t);
          return `<tr data-i="${i}">
            <td class="date">${fmtDate(t.date)}</td>
            <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterparty(t))}</div></td>
            <td class="hide-sm">${t.category_name ? `<a class="cat plain" href="#/kategorien/${encodeURIComponent(t.category_id ?? '0')}">${esc(t.category_name)}</a>` : ''}</td>
            <td class="num"><span class="${v > 0 ? 'pos' : t.type === 'transfer' ? 'neutral' : 'neg'}">${money(v, t.currency_code, { signed: v > 0 })}</span></td></tr>`;
        })
        .join('')}</tbody></table></div>`;
    // Klick auf eine Zeile klappt Details auf
    el.querySelector('tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr || e.target.closest('a')) return;
      if (tr.nextElementSibling?.classList.contains('details')) return tr.nextElementSibling.remove();
      const t = rows[Number(tr.dataset.i)];
      const fields = [['Von', t.source_name], ['An', t.destination_name], ['Art', { withdrawal: 'Ausgabe', deposit: 'Einnahme', transfer: 'Umbuchung' }[t.type]],
        ['Budget', t.budget_name], ['Notizen', t.notes]].filter(([, v]) => v);
      const tags = (t.tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('');
      tr.insertAdjacentHTML('afterend', `<tr class="details"><td colspan="4"><dl>
        ${fields.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}${tags ? `<dt>Tags</dt><dd>${tags}</dd>` : ''}
        ${ff ? `<dt></dt><dd><a href="${esc(ff)}/transactions/show/${encodeURIComponent(t.groupId)}" target="_blank" rel="noopener">In Firefly öffnen ↗</a></dd>` : ''}</dl></td></tr>`);
    });
  }, skeleton(6));
}
