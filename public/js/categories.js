// Kategorie-Analyse: Vergleich, Monatsmatrix und Detailseite je Kategorie.

import * as api from './api.js';
import { barChart, legend, seriesColor, cssVar } from './charts.js';
import { money, percent, esc, fmtDate, fmtMonth, today, startOfMonth, endOfMonth, isoDate, addDays, storage, store, debounce } from './util.js';
import { skeleton, fill, card, stat, signedAmount, mainCurrency, sum, counterparty, downloadCsv } from './common.js';

export const NO_CATEGORY = '0';

const KINDS = {
  expense: { label: 'Ausgaben', param: 'ausgaben', txType: 'withdrawal', partner: 'Top-Empfänger' },
  income: { label: 'Einnahmen', param: 'einnahmen', txType: 'deposit', partner: 'Top-Quellen' },
};

const kindFrom = (params) => (params.get('art') === 'einnahmen' ? 'income' : 'expense');
const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
const capToday = (d) => (d > today() ? today() : d);

// ---------------------------------------------------------------------------
// Daten

/** Summen je Kategorie für einen Zeitraum (inkl. „Ohne Kategorie“), nur Beträge > 0. */
export async function categoryTotals(kind, start, end) {
  const [cats, none] = await Promise.all([
    api.get(`insight/${kind}/category`, { start, end }),
    api.get(`insight/${kind}/no-category`, { start, end }).catch(() => []),
  ]);
  const value = (x) => Math.abs(Number(x.difference_float ?? x.difference));
  return [
    ...(cats || []).map((c) => ({ id: String(c.id), name: c.name, value: value(c), code: c.currency_code })),
    ...(none || []).map((c) => ({ id: NO_CATEGORY, name: 'Ohne Kategorie', value: value(c), code: c.currency_code })),
  ].filter((c) => c.value > 0);
}

const isMonthAligned = ({ start, end }) => start.getDate() === 1 && end.getDate() === endOfMonth(end).getDate();
const shiftMonths = (d, n) =>
  new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), endOfMonth(d, n).getDate()));

/**
 * Vergleichszeitraum direkt davor, gleich lang. Läuft der aktuelle Zeitraum
 * noch, wird nur bis zum selben Tag verglichen (1.–19. Okt. ↔ 1.–19. Sep.).
 */
export function previousRange(period) {
  const { start, end } = period;
  if (!isMonthAligned(period)) {
    // Eigener Zeitraum: gleich viele Tage direkt davor
    const days = Math.round((capToday(end) - start) / 86400000) + 1;
    return [addDays(start, -days), addDays(start, -1)];
  }
  const n = monthsBetween(start, end) + 1;
  const prevStart = startOfMonth(start, -n);
  const prevEndFull = endOfMonth(start, -1);
  if (end <= today()) return [prevStart, prevEndFull];
  const shifted = shiftMonths(today(), -n);
  return [prevStart, shifted < prevEndFull ? shifted : prevEndFull];
}

/** Derselbe Zeitraum ein Jahr früher (bei laufendem Zeitraum bis zum selben Tag). */
export function yearAgoRange({ start, end }) {
  return [shiftMonths(start, -12), shiftMonths(capToday(end), -12)];
}

/** Vergleich nach Einstellung: Vorperiode (Standard) oder Vorjahr. */
export function compareRange(period) {
  const mode = storage('ffd-compare', 'prev');
  const [s, e] = mode === 'year' ? yearAgoRange(period) : previousRange(period);
  return { start: s, end: e, mode, label: mode === 'year' ? 'Vorjahr' : 'Vorperiode' };
}

/** Monate für Matrix und Verläufe: mindestens 12 bis zum Ende des Zeitraums, bei längeren Zeiträumen alle. */
export function analysisMonths(period) {
  const last = capToday(period.end);
  const count = Math.max(12, monthsBetween(period.start, last) + 1);
  return Array.from({ length: count }, (_, i) => [startOfMonth(last, i - count + 1), endOfMonth(last, i - count + 1)]);
}

function onlyCurrency(list, code) {
  return list.filter((x) => x.code === code);
}

// ---------------------------------------------------------------------------
// Darstellung

const intFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const pctSigned = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });

/** Veränderung ggü. Vorperiode – Pfeil + Zahl, Farbe nur als Zusatz. */
export function delta(cur, prev, kind, code) {
  if (!prev && !cur) return '<span class="delta">–</span>';
  if (!prev) return '<span class="delta">neu</span>';
  const d = cur - prev;
  const rel = d / prev;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '';
  const worse = kind === 'expense' ? d > 0 : d < 0;
  const cls = Math.abs(rel) < 0.05 ? '' : worse ? 'bad' : 'good';
  return `<span class="delta ${cls}" title="${money(d, code, { signed: true })}">${arrow} ${pctSigned.format(rel)}</span>`;
}

function sparkline(values) {
  const max = Math.max(...values, 0) || 1;
  const w = 6;
  const gap = 2;
  const h = 24;
  const bars = values
    .map((v, i) => {
      const bh = v > 0 ? Math.max(2, (v / max) * h) : 1;
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1.5"${v > 0 ? '' : ' class="zero"'}/>`;
    })
    .join('');
  return `<svg class="spark" viewBox="0 0 ${values.length * (w + gap) - gap} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

const kindChips = (kind, base) => `
  <div class="chips" role="group" aria-label="Art">
    ${Object.entries(KINDS)
      .map(([k, v]) => `<a class="chip" href="${base}${k === 'income' ? '?art=einnahmen' : ''}" aria-pressed="${k === kind}">${v.label}</a>`)
      .join('')}
  </div>`;

const detailLink = (id, kind) => `#/kategorien/${encodeURIComponent(id)}${kind === 'income' ? '?art=einnahmen' : ''}`;

// ---------------------------------------------------------------------------
// Seite: alle Kategorien

export async function categories(view, { period, params }) {
  const kind = kindFrom(params);
  const K = KINDS[kind];
  const { start, end } = period;
  const cmp = compareRange(period);
  const months = analysisMonths(period);
  const monthsLabel = `${fmtMonth(months[0][0])} – ${fmtMonth(months.at(-1)[0])}`;
  let filter = params.get('filter') || '';

  view.innerHTML = `
    <div class="toolbar">${kindChips(kind, '#/kategorien')}
      <div class="chips" role="group" aria-label="Vergleich">
        <button class="chip" data-compare="prev" aria-pressed="${cmp.mode === 'prev'}">ggü. Vorperiode</button>
        <button class="chip" data-compare="year" aria-pressed="${cmp.mode === 'year'}">ggü. Vorjahr</button>
      </div>
      <input class="input" id="c-filter" type="search" placeholder="Kategorien filtern … (mehrere mit Komma)" value="${esc(filter)}" aria-label="Kategorien filtern">
      <span class="meta-line">Vergleich mit ${fmtDate(cmp.start)} – ${fmtDate(cmp.end)}</span></div>
    <div class="grid">
      <section class="card span-3" id="c-total"></section>
      <section class="card span-3" id="c-avg"></section>
      <section class="card span-3" id="c-top"></section>
      <section class="card span-3" id="c-none"></section>
      ${card('c-table', 'Kategorien im Vergleich', { link: '<button class="link-btn" data-csv="table">CSV ↓</button>' })}
      ${card('c-stack', 'Top 5 im Monatsverlauf', { meta: monthsLabel })}
      ${card('c-matrix', 'Monatsmatrix', { link: `<span class="meta">${monthsLabel} · <button class="link-btn" data-csv="matrix">CSV ↓</button></span>` })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  view.querySelectorAll('[data-compare]').forEach((btn) =>
    btn.addEventListener('click', () => {
      store('ffd-compare', btn.dataset.compare);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }));

  const data = Promise.all([
    categoryTotals(kind, start, end),
    categoryTotals(kind, cmp.start, cmp.end),
    Promise.all(months.map(([s, e]) => categoryTotals(kind, s, e))),
  ]).then(([cur, prev, matrix]) => {
    const code = mainCurrency([...cur, ...prev, ...matrix.flat()], 'code');
    cur = onlyCurrency(cur, code);
    prev = onlyCurrency(prev, code);
    matrix = matrix.map((m) => onlyCurrency(m, code));
    const byId = new Map();
    const entry = (c) => {
      if (!byId.has(c.id)) byId.set(c.id, { id: c.id, name: c.name, value: 0, prev: 0, months: months.map(() => 0) });
      return byId.get(c.id);
    };
    cur.forEach((c) => (entry(c).value = c.value));
    prev.forEach((c) => (entry(c).prev = c.value));
    matrix.forEach((m, i) => m.forEach((c) => (entry(c).months[i] = c.value)));
    const rows = [...byId.values()];
    rows.forEach((r) => {
      r.total = sum(r.months, (x) => x);
      r.avg = r.total / months.length;
    });
    return { code, rows, total: sum(rows, (r) => r.value), prevTotal: sum(rows, (r) => r.prev) };
  });

  const tile = (id, render) => fill($(id), () => data, render, skeleton(2, 22));
  tile('c-total', (el, d) => {
    el.innerHTML = stat(`${K.label} gesamt`, money(d.total, d.code), `${delta(d.total, d.prevTotal, kind, d.code)} ggü. ${cmp.label} (${money(d.prevTotal, d.code)})`);
  });
  tile('c-avg', (el, d) => {
    const avg = sum(d.rows, (r) => r.avg);
    el.innerHTML = stat('Ø pro Monat', money(avg, d.code), `über ${months.length} Monate`);
  });
  tile('c-top', (el, d) => {
    const top = [...d.rows].filter((r) => r.id !== NO_CATEGORY).sort((a, b) => b.value - a.value)[0];
    el.innerHTML = top
      ? stat('Größte Kategorie', `<a class="plain" href="${detailLink(top.id, kind)}">${esc(top.name)}</a>`, `${money(top.value, d.code)} · ${percent(top.value / d.total)} vom Gesamt`)
      : stat('Größte Kategorie', '–');
  });
  tile('c-none', (el, d) => {
    const none = d.rows.find((r) => r.id === NO_CATEGORY);
    const share = none && d.total ? none.value / d.total : 0;
    el.innerHTML = stat('Ohne Kategorie', none ? `<a class="plain" href="${detailLink(NO_CATEGORY, kind)}">${money(none.value, d.code)}</a>` : money(0, d.code),
      share > 0.05 ? `<span class="down">${percent(share)}</span> noch nicht kategorisiert` : `${percent(share)} – gut kategorisiert`);
  });

  /** Filter: Teilwörter, mehrere durch Komma getrennt (ODER). */
  const matches = (r) => {
    const terms = filter.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    return !terms.length || terms.some((t) => r.name.toLowerCase().includes(t));
  };
  const byTotal = (a, b) => b.total - a.total;

  // Vergleichstabelle, per Klick auf die Spaltenköpfe sortierbar
  let sortKey = 'value';
  let sortDir = -1;
  const cols = [
    ['name', 'Kategorie', ''],
    ['value', 'Betrag', 'num'],
    ['share', 'Anteil', 'hide-sm'],
    ['prev', cmp.label, 'num hide-sm'],
    ['change', 'Veränderung', 'num'],
    ['avg', 'Ø / Monat', 'num hide-sm'],
    [null, 'Verlauf', 'hide-sm'],
  ];
  const keyOf = (r, k) => (k === 'name' ? r.name.toLowerCase() : k === 'change' ? r.value - r.prev : k === 'share' ? r.value : r[k]);

  function renderTable(el, d) {
    const rows = d.rows.filter(matches).sort((a, b) => (keyOf(a, sortKey) > keyOf(b, sortKey) ? 1 : -1) * sortDir);
    const max = Math.max(...rows.map((r) => r.value), 1);
    const fv = sum(rows, (r) => r.value);
    const fp = sum(rows, (r) => r.prev);
    el.innerHTML = rows.length
      ? `<div class="table-wrap"><table class="sortable"><thead><tr>${cols
        .map(([k, label, cls]) => `<th class="${cls}" ${k ? `data-sort="${k}" aria-sort="${k === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'}"` : ''}>${label}${k === sortKey ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`)
        .join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr data-href="${detailLink(r.id, kind)}">
          <td><a class="plain desc" href="${detailLink(r.id, kind)}">${esc(r.name)}</a></td>
          <td class="num"><b>${money(r.value, d.code)}</b></td>
          <td class="hide-sm"><div class="share"><div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div><span>${percent(d.total ? r.value / d.total : 0)}</span></div></td>
          <td class="num hide-sm muted">${money(r.prev, d.code)}</td>
          <td class="num">${delta(r.value, r.prev, kind, d.code)}</td>
          <td class="num hide-sm">${money(r.avg, d.code)}</td>
          <td class="hide-sm" data-tip="${esc(r.months.map((v, i) => `${fmtMonth(months[i][0])}: ${money(v, d.code)}`).join('\n'))}">${sparkline(r.months)}</td>
        </tr>`)
        .join('')}</tbody>${filter ? `<tfoot><tr><td><b>Summe Auswahl (${rows.length})</b></td><td class="num"><b>${money(fv, d.code)}</b></td>
          <td class="hide-sm"><span class="muted">${percent(d.total ? fv / d.total : 0)} vom Gesamt</span></td><td class="num hide-sm muted">${money(fp, d.code)}</td>
          <td class="num">${delta(fv, fp, kind, d.code)}</td><td class="num hide-sm">${money(sum(rows, (r) => r.avg), d.code)}</td><td class="hide-sm"></td></tr></tfoot>` : ''}
        </table></div>`
      : `<div class="empty">${filter ? `Keine Kategorie passt zu „${esc(filter)}“.` : `Keine ${K.label} im Zeitraum.`}</div>`;
  }

  let stackChart = null;
  function renderStack(el, d) {
    stackChart?.destroy();
    stackChart = null;
    const ranked = d.rows.filter(matches).sort(byTotal);
    const top = ranked.slice(0, 5);
    const rest = ranked.slice(5);
    const series = top.map((r, i) => ({ label: r.name, data: r.months, color: seriesColor(i) }));
    if (rest.length) {
      series.push({ label: `Sonstige (${rest.length})`, data: months.map((_, i) => sum(rest, (r) => r.months[i])), color: cssVar('--axis') });
    }
    if (!series.length) return (el.innerHTML = '<div class="empty">Keine Daten.</div>');
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Kategorien je Monat"></canvas></div>`;
    stackChart = barChart(el.querySelector('canvas'), { labels: months.map(([s]) => s), series, currency: d.code, stacked: true });
  }

  /** Link zu den Buchungen einer Kategorie in einem Monat. */
  const drillLink = (r, i) => {
    const q = r.id === NO_CATEGORY ? 'has_no_category:true' : `category_is:"${r.name}"`;
    const [s, e] = months[i];
    return `#/buchungen?q=${encodeURIComponent(q)}&type=${K.txType}&von=${isoDate(s)}&bis=${isoDate(e)}`;
  };

  function renderMatrix(el, d) {
    const rows = d.rows.filter(matches).sort(byTotal);
    if (!rows.length) return (el.innerHTML = '<div class="empty">Keine Daten.</div>');
    const colTotals = months.map((_, i) => sum(rows, (r) => r.months[i]));
    const cell = (r, v, i) => {
      const rowMax = Math.max(...r.months) || 1;
      const t = v / rowMax;
      const tip = `${r.name} · ${fmtMonth(months[i][0])}: ${money(v, d.code)}${r.avg ? ` (${pctSigned.format(v / r.avg - 1)} ggü. Ø)` : ''}\nKlicken für Buchungen`;
      return v
        ? `<td class="heat${t > 0.6 ? ' strong' : ''}" style="--t:${t.toFixed(3)}" data-tip="${esc(tip)}" data-href="${drillLink(r, i)}">${intFmt.format(v)}</td>`
        : '<td class="heat empty-cell">·</td>';
    };
    el.innerHTML = `<div class="table-wrap"><table class="matrix">
      <thead><tr><th>Kategorie</th>${months.map(([s]) => `<th class="num">${fmtMonth(s)}</th>`).join('')}<th class="num">Ø</th><th class="num">Summe</th></tr></thead>
      <tbody>${rows
        .map((r) => `<tr><th scope="row"><a class="plain" href="${detailLink(r.id, kind)}">${esc(r.name)}</a></th>${r.months.map((v, i) => cell(r, v, i)).join('')}
          <td class="num muted">${intFmt.format(r.avg)}</td><td class="num"><b>${intFmt.format(r.total)}</b></td></tr>`)
        .join('')}</tbody>
      <tfoot><tr><th>${filter ? 'Summe Auswahl' : 'Summe'}</th>${colTotals.map((v) => `<td class="num"><b>${intFmt.format(v)}</b></td>`).join('')}
        <td class="num muted">${intFmt.format(sum(colTotals, (x) => x) / months.length)}</td><td class="num"><b>${intFmt.format(sum(colTotals, (x) => x))}</b></td></tr></tfoot>
    </table></div>
    <div class="legend" style="margin-top:12px"><span>Beträge in ${esc(d.code)} · Farbintensität je Zeile relativ zum stärksten Monat der Kategorie · Feld anklicken zeigt die Buchungen</span></div>`;
  }

  fill($('c-table'), () => data, (el, d) => {
    renderTable(el, d);
    el.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        sortDir = k === sortKey ? -sortDir : k === 'name' ? 1 : -1;
        sortKey = k;
        return renderTable(el, d);
      }
      const tr = e.target.closest('tr[data-href]');
      if (tr && !e.target.closest('a')) location.hash = tr.dataset.href;
    });
  }, skeleton(8));
  fill($('c-stack'), () => data, renderStack, skeleton(1, 280));
  fill($('c-matrix'), () => data, (el, d) => {
    renderMatrix(el, d);
    el.addEventListener('click', (e) => {
      const td = e.target.closest('td[data-href]');
      if (td) location.hash = td.dataset.href;
    });
  }, skeleton(8));

  data.then((d) => {
    $('c-filter').addEventListener('input', debounce((e) => {
      filter = e.target.value;
      const qs = new URLSearchParams(params);
      if (filter) qs.set('filter', filter);
      else qs.delete('filter');
      history.replaceState(null, '', `#/kategorien${qs.toString() ? `?${qs}` : ''}`);
      renderTable($('c-table'), d);
      renderStack($('c-stack'), d);
      renderMatrix($('c-matrix'), d);
    }, 200));

    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-csv]');
      if (!btn) return;
      const rows = d.rows.filter(matches).sort(byTotal);
      const stamp = `${isoDate(start)}_${isoDate(end)}`;
      if (btn.dataset.csv === 'table') {
        downloadCsv(`kategorien-${K.param}-${stamp}.csv`, [
          ['Kategorie', `Betrag (${d.code})`, 'Anteil %', `${cmp.label} (${d.code})`, 'Veränderung %', `Ø pro Monat (${d.code})`],
          ...rows.map((r) => [r.name, r.value, d.total ? (r.value / d.total) * 100 : 0, r.prev, r.prev ? ((r.value - r.prev) / r.prev) * 100 : '', r.avg]),
        ]);
      } else {
        downloadCsv(`monatsmatrix-${K.param}-${stamp}.csv`, [
          ['Kategorie', ...months.map(([s]) => isoDate(s).slice(0, 7)), 'Ø', 'Summe'],
          ...rows.map((r) => [r.name, ...r.months, r.avg, r.total]),
        ]);
      }
    });
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Seite: eine Kategorie im Detail

export async function categoryDetail(view, { period, params, id }) {
  const kind = kindFrom(params);
  const K = KINDS[kind];
  const { start, end } = period;
  const cmp = compareRange(period);
  const [prevStart, prevEnd] = [cmp.start, cmp.end];
  const months = analysisMonths(period);
  const titleEl = document.getElementById('page-title');

  view.innerHTML = `
    <div class="toolbar"><a class="back" href="#/kategorien${kind === 'income' ? '?art=einnahmen' : ''}">← Alle Kategorien</a>
      <span class="meta-line">${K.label} · Vergleich mit ${fmtDate(prevStart)} – ${fmtDate(prevEnd)}</span></div>
    <div class="grid">
      <section class="card span-3" id="d-total"></section>
      <section class="card span-3" id="d-avg"></section>
      <section class="card span-3" id="d-count"></section>
      <section class="card span-3" id="d-per"></section>
      ${card('d-chart', 'Monatsverlauf', { meta: `${fmtMonth(months[0][0])} – ${fmtMonth(months.at(-1)[0])}` })}
      ${card('d-partners', K.partner, { span: 'span-5', meta: esc(period.label) })}
      ${card('d-tx', 'Buchungen', { span: 'span-7', meta: '<span id="d-sort"></span>' })}
    </div>`;
  const $ = (sel) => view.querySelector(`#${sel}`);

  const pick = (list) => list.find((c) => c.id === String(id));
  const totals = Promise.all([
    categoryTotals(kind, start, end),
    categoryTotals(kind, prevStart, prevEnd),
    Promise.all(months.map(([s, e]) => categoryTotals(kind, s, e))),
  ]).then(([cur, prev, matrix]) => {
    const all = [...cur, ...prev, ...matrix.flat()];
    const code = mainCurrency(all.filter((c) => c.id === String(id)), 'code');
    const value = (list) => list.find((c) => c.id === String(id) && c.code === code)?.value || 0;
    return { code, name: pick(all)?.name, value: value(cur), prev: value(prev), months: matrix.map(value) };
  });

  const txs = (String(id) === NO_CATEGORY
    ? api.getAll('search/transactions', {
      query: `has_no_category:true type:${K.txType} date_after:${isoDate(start)} date_before:${isoDate(end)}`,
    })
    : api.getAll(`categories/${encodeURIComponent(id)}/transactions`, { start, end, type: K.txType })
  ).then((groups) =>
    api.flattenTransactions(groups).filter((t) =>
      t.type === K.txType &&
      (String(id) === NO_CATEGORY ? !t.category_name : t.category_id == null || String(t.category_id) === String(id))));

  totals.then(async (d) => {
    let name = d.name;
    if (!name && String(id) !== NO_CATEGORY) {
      name = await api.get(`categories/${encodeURIComponent(id)}`).then((r) => r?.data?.attributes?.name).catch(() => null);
    }
    if (titleEl.isConnected && view.contains($('d-total'))) {
      titleEl.textContent = name || 'Kategorie';
      document.title = `${titleEl.textContent} · Firefly Dashboard`;
    }
  }).catch(() => {});

  const tile = (sel, loader, render) => fill($(sel), loader, render, skeleton(2, 22));
  tile('d-total', () => totals, (el, d) =>
    (el.innerHTML = stat(`${K.label} im Zeitraum`, money(d.value, d.code), `${delta(d.value, d.prev, kind, d.code)} ggü. ${cmp.label} (${money(d.prev, d.code)})`)));
  tile('d-avg', () => totals, (el, d) => {
    const avg = sum(d.months, (x) => x) / months.length;
    const max = Math.max(...d.months);
    const maxIdx = d.months.indexOf(max);
    el.innerHTML = stat('Ø pro Monat', money(avg, d.code), max ? `Spitze: ${fmtMonth(months[maxIdx][0])} mit ${money(max, d.code)}` : `über ${months.length} Monate`);
  });
  tile('d-count', () => txs, (el, list) =>
    (el.innerHTML = stat('Buchungen', intFmt.format(list.length), esc(period.label))));
  tile('d-per', () => txs, (el, list) => {
    const code = mainCurrency(list);
    const own = list.filter((t) => t.currency_code === code);
    const biggest = [...own].sort((a, b) => b.amount - a.amount)[0];
    el.innerHTML = stat('Ø pro Buchung', money(own.length ? sum(own, (t) => t.amount) / own.length : 0, code),
      biggest ? `Größte: ${money(biggest.amount, code)} (${fmtDate(biggest.date, { day: 'numeric', month: 'short' })})` : '');
  });

  fill($('d-chart'), () => totals, (el, d) => {
    const avg = sum(d.months, (x) => x) / months.length;
    const base = seriesColor(kind === 'income' ? 2 : 0);
    const inPeriod = months.map(([s, e]) => e >= start && s <= end);
    const series = [{ label: K.label, data: d.months, color: inPeriod.map((p) => (p ? base : `${base}55`)) }];
    el.innerHTML = `<div class="legend"><span><i style="background:${base}"></i>im gewählten Zeitraum</span><span><i style="background:${base}55"></i>davor</span><span>Ø <b>&nbsp;${money(avg, d.code)}</b> pro Monat</span></div>
      <div class="chart-box" style="margin-top:12px"><canvas aria-label="${esc(K.label)} je Monat"></canvas></div>`;
    const q = String(id) === NO_CATEGORY ? 'has_no_category:true' : `category_is:"${d.name || ''}"`;
    barChart(el.querySelector('canvas'), {
      labels: months.map(([s]) => s), series, currency: d.code, average: avg,
      onClick: (i) => (location.hash = `#/buchungen?q=${encodeURIComponent(q)}&type=${K.txType}&von=${isoDate(months[i][0])}&bis=${isoDate(months[i][1])}`),
    });
  }, skeleton(1, 280));

  fill($('d-partners'), () => txs, (el, list) => {
    const code = mainCurrency(list);
    const groups = new Map();
    for (const t of list.filter((x) => x.currency_code === code)) {
      const key = counterparty(t) || '–';
      const g = groups.get(key) || { name: key, value: 0, count: 0 };
      g.value += t.amount;
      g.count += 1;
      groups.set(key, g);
    }
    const items = [...groups.values()].sort((a, b) => b.value - a.value);
    if (!items.length) return (el.innerHTML = '<div class="empty">Keine Buchungen im Zeitraum.</div>');
    const total = sum(items, (x) => x.value);
    const shown = items.slice(0, 10);
    const max = shown[0].value;
    el.innerHTML = `<div class="bars">${shown
      .map((g) => `<div class="bar-row"><a class="name" href="#/buchungen?q=${encodeURIComponent(`"${g.name}"`)}" title="${esc(g.name)}">${esc(g.name)}</a>
        <div class="track"><div class="fill" style="width:${(g.value / max) * 100}%"></div></div>
        <div class="val">${money(g.value, code)}<small>${g.count}× · ${percent(g.value / total)}</small></div></div>`)
      .join('')}</div>${items.length > 10 ? `<div class="legend" style="margin-top:12px"><span>+ ${items.length - 10} weitere</span></div>` : ''}`;
  });

  let order = 'date';
  fill($('d-tx'), () => txs, (el, list) => {
    const render = () => {
      const rows = [...list].sort((a, b) => (order === 'date' ? String(b.date).localeCompare(String(a.date)) : b.amount - a.amount));
      $('d-sort').innerHTML = `<button class="link-btn" data-order="date" aria-pressed="${order === 'date'}">Neueste</button> · <button class="link-btn" data-order="amount" aria-pressed="${order === 'amount'}">Größte</button>`;
      el.innerHTML = rows.length
        ? `<div class="table-wrap"><table><tbody>${rows
          .slice(0, 200)
          .map((t) => `<tr style="cursor:default"><td class="date">${fmtDate(t.date)}</td>
            <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterparty(t))}</div></td>
            <td class="num">${signedAmount(t)}</td></tr>`)
          .join('')}</tbody></table></div>${rows.length > 200 ? `<div class="legend" style="margin-top:12px"><span>Die ersten 200 von ${rows.length} Buchungen</span></div>` : ''}`
        : '<div class="empty">Keine Buchungen im Zeitraum.</div>';
    };
    render();
    view.querySelector('#d-sort').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-order]');
      if (!btn) return;
      order = btn.dataset.order;
      render();
    });
  }, skeleton(6));
}
