// Analyse nach Kategorien bzw. Tags: Vergleich, Monatsmatrix, Prognose
// und Detailseite. Beide Sichten teilen sich denselben Code (DIMS).

import * as api from './api.js';
import { barChart, legend, seriesColor, cssVar } from './charts.js';
import { money, percent, esc, fmtDate, fmtMonth, today, startOfMonth, endOfMonth, isoDate, addDays, storage, store, debounce } from './util.js';
import { skeleton, fill, card, stat, signedAmount, mainCurrency, sum, counterparty, downloadCsv, termsMatcher, multiSelect } from './common.js';

export const NO_CATEGORY = '0';

const KINDS = {
  expense: { label: 'Ausgaben', param: 'ausgaben', txType: 'withdrawal', partner: 'Top-Empfänger' },
  income: { label: 'Einnahmen', param: 'einnahmen', txType: 'deposit', partner: 'Top-Quellen' },
};

/** Unterschiede zwischen Kategorie- und Tag-Auswertung. */
const DIMS = {
  category: {
    base: '#/kategorien',
    plural: 'Kategorien',
    singular: 'Kategorie',
    insight: 'category',
    noneInsight: 'no-category',
    noneLabel: 'Ohne Kategorie',
    query: (r) => (r.id === NO_CATEGORY ? 'has_no_category:true' : `category_is:"${r.name}"`),
    transactions: (id, params) => api.getAll(`categories/${encodeURIComponent(id)}/transactions`, params),
    belongs: (t, id, name) => (t.category_id == null ? t.category_name === name : String(t.category_id) === String(id)),
    lookupName: (id) => api.get(`categories/${encodeURIComponent(id)}`).then((r) => r?.data?.attributes?.name),
  },
  tag: {
    base: '#/tags',
    plural: 'Tags',
    singular: 'Tag',
    insight: 'tag',
    noneInsight: null, // „ohne Tag“ wäre meist fast alles – weggelassen
    query: (r) => `tag_is:"${r.name}"`,
    transactions: (id, params) => api.getAll(`tags/${encodeURIComponent(id)}/transactions`, params),
    belongs: (t, id, name) => (t.tags || []).includes(name),
    lookupName: (id) => api.get(`tags/${encodeURIComponent(id)}`).then((r) => r?.data?.attributes?.tag),
  },
};

const kindFrom = (params) => (params.get('art') === 'einnahmen' ? 'income' : 'expense');
const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
const capToday = (d) => (d > today() ? today() : d);

// ---------------------------------------------------------------------------
// Daten

/** Summen je Kategorie/Tag für einen Zeitraum, nur Beträge > 0. */
export async function dimTotals(dimKey, kind, start, end) {
  const D = DIMS[dimKey];
  const [items, none] = await Promise.all([
    api.get(`insight/${kind}/${D.insight}`, { start, end }),
    D.noneInsight ? api.get(`insight/${kind}/${D.noneInsight}`, { start, end }).catch(() => []) : [],
  ]);
  const value = (x) => Math.abs(Number(x.difference_float ?? x.difference));
  return [
    ...(items || []).map((c) => ({ id: String(c.id), name: c.name ?? c.tag, value: value(c), code: c.currency_code })),
    ...(none || []).map((c) => ({ id: NO_CATEGORY, name: D.noneLabel, value: value(c), code: c.currency_code })),
  ].filter((c) => c.value > 0);
}

export const categoryTotals = (kind, start, end) => dimTotals('category', kind, start, end);

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
// Prognose (per Schalter oben rechts, standardmäßig aus)

export const forecastEnabled = () => storage('ffd-forecast', '0') === '1';
/** Prognose ist nur sinnvoll, solange vom Zeitraum noch Tage übrig sind. */
export const isRunning = ({ start, end }) => start <= today() && end > today();
export const forecastActive = (period) => forecastEnabled() && isRunning(period);

/**
 * Vergleichsfenster für „den Rest des Zeitraums“: dieselben verbleibenden
 * Tage in früheren Perioden. Monat → die 3 Vormonate, länger → Vorjahr.
 */
function remainderWindows(period) {
  const from = addDays(today(), 1);
  const to = period.end;
  if (!isMonthAligned(period)) {
    const len = Math.round((period.end - period.start) / 86400000) + 1;
    return [1, 2, 3].map((k) => [addDays(from, -k * len), addDays(to, -k * len)]);
  }
  const n = monthsBetween(period.start, period.end) + 1;
  const shifts = n === 1 ? [1, 2, 3] : [12];
  return shifts.map((k) => [shiftMonths(from, -k), shiftMonths(to, -k)]);
}

/**
 * Hochrechnung je Eintrag: bisher + Ø dessen, was früher im restlichen Teil
 * des Zeitraums noch dazukam. Fixkosten, die schon gebucht sind (Miete am 3.),
 * werden so nicht doppelt gezählt.
 */
export async function forecastRemainder(dimKey, kind, period) {
  const windows = remainderWindows(period);
  const lists = await Promise.all(windows.map(([s, e]) => dimTotals(dimKey, kind, s, e)));
  const acc = new Map();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.id}|${c.code}`;
      acc.set(key, (acc.get(key) || 0) + c.value / windows.length);
    }
  }
  return (id, code) => acc.get(`${id}|${code}`) || 0;
}

/** Hochrechnung der Gesamtsumme (Einnahmen oder Ausgaben). */
export async function forecastTotal(kind, period) {
  const windows = remainderWindows(period);
  const lists = await Promise.all(windows.map(([s, e]) => api.get(`insight/${kind}/total`, { start: s, end: e }).catch(() => [])));
  const byCode = new Map();
  for (const list of lists) {
    for (const x of list || []) {
      byCode.set(x.currency_code, (byCode.get(x.currency_code) || 0) + Math.abs(Number(x.difference_float ?? x.difference)) / windows.length);
    }
  }
  return (code) => byCode.get(code) || 0;
}

// ---------------------------------------------------------------------------
// Darstellung

const intFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const pctSigned = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });

/** Veränderung ggü. Vergleichszeitraum – Pfeil + Zahl, Farbe nur als Zusatz. */
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

/** Üblicher Monatswert (Median der Monate mit Buchungen) für die Ausreißer-Erkennung. */
function typicalMonth(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 4) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Auffällig: mindestens 50 % und 20 Einheiten über dem üblichen Monat. */
const isOutlier = (v, typical) => typical !== null && v >= typical * 1.5 && v - typical >= 20;

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

const detailHref = (D, id, kind) => `${D.base}/${encodeURIComponent(id)}${kind === 'income' ? '?art=einnahmen' : ''}`;

// ---------------------------------------------------------------------------
// Seite: alle Kategorien / Tags

export const categories = (view, ctx) => analysis(view, { ...ctx, dimKey: 'category' });
export const tags = (view, ctx) => analysis(view, { ...ctx, dimKey: 'tag' });

async function analysis(view, { period, params, dimKey }) {
  const D = DIMS[dimKey];
  const kind = kindFrom(params);
  const K = KINDS[kind];
  const { start, end } = period;
  const cmp = compareRange(period);
  const months = analysisMonths(period);
  const monthsLabel = `${fmtMonth(months[0][0])} – ${fmtMonth(months.at(-1)[0])}`;
  const showForecast = forecastActive(period);
  let filter = params.get('filter') || '';
  let selection = new Set((params.get('sel') || '').split(',').filter(Boolean));

  view.innerHTML = `
    <div class="toolbar">${kindChips(kind, D.base)}
      <div class="chips" role="group" aria-label="Vergleich">
        <button class="chip" data-compare="prev" aria-pressed="${cmp.mode === 'prev'}">ggü. Vorperiode</button>
        <button class="chip" data-compare="year" aria-pressed="${cmp.mode === 'year'}">ggü. Vorjahr</button>
      </div>
      <div id="c-pick"></div>
      <input class="input" id="c-filter" type="search" placeholder="${D.plural} filtern … (mehrere mit Komma)" value="${esc(filter)}" aria-label="${D.plural} filtern">
      <span class="meta-line">Vergleich mit ${fmtDate(cmp.start)} – ${fmtDate(cmp.end)}</span></div>
    <div class="grid">
      <section class="card span-3" id="c-total"></section>
      <section class="card span-3" id="c-avg"></section>
      <section class="card span-3" id="c-top"></section>
      <section class="card span-3" id="c-none"></section>
      ${card('c-table', `${D.plural} im Vergleich`, { link: '<button class="link-btn" data-csv="table">CSV ↓</button>' })}
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
    dimTotals(dimKey, kind, start, end),
    dimTotals(dimKey, kind, cmp.start, cmp.end),
    Promise.all(months.map(([s, e]) => dimTotals(dimKey, kind, s, e))),
    showForecast ? forecastRemainder(dimKey, kind, period) : null,
  ]).then(([cur, prev, matrix, remainder]) => {
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
      r.typical = typicalMonth(r.months);
      r.forecast = remainder ? r.value + remainder(r.id, code) : null;
    });
    rows.sort((a, b) => b.total - a.total);
    return { code, rows, total: sum(rows, (r) => r.value), prevTotal: sum(rows, (r) => r.prev) };
  });

  const tile = (id, render) => fill($(id), () => data, render, skeleton(2, 22));
  tile('c-total', (el, d) => {
    const fc = showForecast ? sum(d.rows, (r) => r.forecast) : null;
    el.innerHTML = stat(`${K.label} gesamt`, money(d.total, d.code),
      `${delta(d.total, d.prevTotal, kind, d.code)} ggü. ${cmp.label} (${money(d.prevTotal, d.code)})${fc !== null ? `<br><span class="forecast">≈ ${money(fc, d.code)} bis ${fmtDate(end, { day: 'numeric', month: 'short' })}</span>` : ''}`);
  });
  tile('c-avg', (el, d) => {
    const avg = sum(d.rows, (r) => r.avg);
    el.innerHTML = stat('Ø pro Monat', money(avg, d.code), `über ${months.length} Monate`);
  });
  tile('c-top', (el, d) => {
    const top = [...d.rows].filter((r) => r.id !== NO_CATEGORY).sort((a, b) => b.value - a.value)[0];
    el.innerHTML = top
      ? stat(`Größte${dimKey === 'tag' ? 'r Tag' : ' Kategorie'}`, `<a class="plain" href="${detailHref(D, top.id, kind)}">${esc(top.name)}</a>`, `${money(top.value, d.code)} · ${percent(top.value / d.total)} vom Gesamt`)
      : stat(`Größte${dimKey === 'tag' ? 'r Tag' : ' Kategorie'}`, '–');
  });
  tile('c-none', (el, d) => {
    if (dimKey === 'tag') {
      const used = d.rows.filter((r) => r.value > 0).length;
      el.innerHTML = stat('Tags im Zeitraum', intFmt.format(used), `${d.rows.length} Tags in ${months.length} Monaten`);
      return;
    }
    const none = d.rows.find((r) => r.id === NO_CATEGORY);
    const share = none && d.total ? none.value / d.total : 0;
    el.innerHTML = stat('Ohne Kategorie', none ? `<a class="plain" href="${detailHref(D, NO_CATEGORY, kind)}">${money(none.value, d.code)}</a>` : money(0, d.code),
      share > 0.05 ? `<span class="down">${percent(share)}</span> noch nicht kategorisiert` : `${percent(share)} – gut kategorisiert`);
  });

  // Auswahl (Häkchen) und Textfilter wirken auf Tabelle, Diagramm und Matrix
  const matches = (r) => (!selection.size || selection.has(r.id)) && termsMatcher(filter)(r.name);
  const syncHash = () => {
    const qs = new URLSearchParams(params);
    if (filter) qs.set('filter', filter);
    else qs.delete('filter');
    if (selection.size) qs.set('sel', [...selection].join(','));
    else qs.delete('sel');
    history.replaceState(null, '', `${D.base}${qs.toString() ? `?${qs}` : ''}`);
  };
  const filtered = () => Boolean(filter || selection.size);

  // Vergleichstabelle, per Klick auf die Spaltenköpfe sortierbar
  let sortKey = 'value';
  let sortDir = -1;
  const cols = [
    ['name', D.singular, ''],
    ['value', 'Betrag', 'num'],
    ...(showForecast ? [['forecast', 'Prognose', 'num']] : []),
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
    const fc = (r) => `<td class="num forecast" title="Hochrechnung bis ${fmtDate(end)}">≈ ${money(r.forecast, d.code)}</td>`;
    el.innerHTML = rows.length
      ? `<div class="table-wrap"><table class="sortable"><thead><tr>${cols
        .map(([k, label, cls]) => `<th class="${cls}" ${k ? `data-sort="${k}" aria-sort="${k === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'}"` : ''}>${label}${k === sortKey ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`)
        .join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr data-href="${detailHref(D, r.id, kind)}">
          <td><a class="plain desc" href="${detailHref(D, r.id, kind)}">${esc(r.name)}</a></td>
          <td class="num"><b>${money(r.value, d.code)}</b></td>
          ${showForecast ? fc(r) : ''}
          <td class="hide-sm"><div class="share"><div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div><span>${percent(d.total ? r.value / d.total : 0)}</span></div></td>
          <td class="num hide-sm muted">${money(r.prev, d.code)}</td>
          <td class="num">${delta(r.value, r.prev, kind, d.code)}</td>
          <td class="num hide-sm">${money(r.avg, d.code)}</td>
          <td class="hide-sm" data-tip="${esc(r.months.map((v, i) => `${fmtMonth(months[i][0])}: ${money(v, d.code)}`).join('\n'))}">${sparkline(r.months)}</td>
        </tr>`)
        .join('')}</tbody>${filtered() ? `<tfoot><tr><td><b>Summe Auswahl (${rows.length})</b></td><td class="num"><b>${money(fv, d.code)}</b></td>
          ${showForecast ? `<td class="num forecast">≈ ${money(sum(rows, (r) => r.forecast), d.code)}</td>` : ''}
          <td class="hide-sm"><span class="muted">${percent(d.total ? fv / d.total : 0)} vom Gesamt</span></td><td class="num hide-sm muted">${money(fp, d.code)}</td>
          <td class="num">${delta(fv, fp, kind, d.code)}</td><td class="num hide-sm">${money(sum(rows, (r) => r.avg), d.code)}</td><td class="hide-sm"></td></tr></tfoot>` : ''}
        </table></div>`
      : `<div class="empty">${filtered() ? `Keine ${D.plural} passen zur Auswahl.` : `Keine ${K.label} im Zeitraum.`}</div>`;
  }

  let stackChart = null;
  function renderStack(el, d) {
    stackChart?.destroy();
    stackChart = null;
    const ranked = d.rows.filter(matches);
    const top = ranked.slice(0, 5);
    const rest = ranked.slice(5);
    const series = top.map((r, i) => ({ label: r.name, data: r.months, color: seriesColor(i) }));
    if (rest.length) {
      series.push({ label: `Sonstige (${rest.length})`, data: months.map((_, i) => sum(rest, (r) => r.months[i])), color: cssVar('--axis') });
    }
    if (!series.length) return (el.innerHTML = '<div class="empty">Keine Daten.</div>');
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="${D.plural} je Monat"></canvas></div>`;
    stackChart = barChart(el.querySelector('canvas'), { labels: months.map(([s]) => s), series, currency: d.code, stacked: true });
  }

  /** Link zu den Buchungen eines Eintrags in einem Monat. */
  const drillLink = (r, i) => {
    const [s, e] = months[i];
    return `#/buchungen?q=${encodeURIComponent(D.query(r))}&type=${K.txType}&von=${isoDate(s)}&bis=${isoDate(e)}`;
  };

  function renderMatrix(el, d) {
    const rows = d.rows.filter(matches);
    if (!rows.length) return (el.innerHTML = '<div class="empty">Keine Daten für diese Auswahl.</div>');
    const colTotals = months.map((_, i) => sum(rows, (r) => r.months[i]));
    let outliers = 0;
    const cell = (r, v, i) => {
      const rowMax = Math.max(...r.months) || 1;
      const t = v / rowMax;
      const odd = isOutlier(v, r.typical);
      if (odd) outliers += 1;
      const tip = `${r.name} · ${fmtMonth(months[i][0])}: ${money(v, d.code)}${r.avg ? ` (${pctSigned.format(v / r.avg - 1)} ggü. Ø)` : ''}${odd ? `\n▲ Auffällig: ${pctSigned.format(v / r.typical - 1)} über dem üblichen Monat (${money(r.typical, d.code)})` : ''}\nKlicken für Buchungen`;
      return v
        ? `<td class="heat${t > 0.6 ? ' strong' : ''}${odd ? ' outlier' : ''}" style="--t:${t.toFixed(3)}" data-tip="${esc(tip)}" data-href="${drillLink(r, i)}">${intFmt.format(v)}</td>`
        : '<td class="heat empty-cell">·</td>';
    };
    const body = rows
      .map((r) => `<tr><th scope="row"><a class="plain" href="${detailHref(D, r.id, kind)}">${esc(r.name)}</a></th>${r.months.map((v, i) => cell(r, v, i)).join('')}
        <td class="num muted">${intFmt.format(r.avg)}</td><td class="num"><b>${intFmt.format(r.total)}</b></td></tr>`)
      .join('');
    el.innerHTML = `<div class="table-wrap"><table class="matrix">
      <thead><tr><th>${D.singular}</th>${months.map(([s]) => `<th class="num">${fmtMonth(s)}</th>`).join('')}<th class="num">Ø</th><th class="num">Summe</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><th>${filtered() ? 'Summe Auswahl' : 'Summe'}</th>${colTotals.map((v) => `<td class="num"><b>${intFmt.format(v)}</b></td>`).join('')}
        <td class="num muted">${intFmt.format(sum(colTotals, (x) => x) / months.length)}</td><td class="num"><b>${intFmt.format(sum(colTotals, (x) => x))}</b></td></tr></tfoot>
    </table></div>
    <div class="legend" style="margin-top:12px"><span>Beträge in ${esc(d.code)} · Farbintensität je Zeile relativ zum stärksten Monat</span>
      ${outliers ? `<span><i class="outlier-key"></i>auffällig hoher Monat (${outliers}×)</span>` : ''}<span>Feld anklicken zeigt die Buchungen</span></div>`;
  }

  const rerender = (d) => {
    renderTable($('c-table'), d);
    renderStack($('c-stack'), d);
    renderMatrix($('c-matrix'), d);
  };

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
    multiSelect($('c-pick'), {
      label: D.plural,
      items: d.rows.map((r) => ({ id: r.id, name: r.name, hint: intFmt.format(r.total) })),
      selected: selection,
      onChange: (next) => {
        selection = next;
        syncHash();
        rerender(d);
      },
    });

    $('c-filter').addEventListener('input', debounce((e) => {
      filter = e.target.value;
      syncHash();
      rerender(d);
    }, 200));

    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-csv]');
      if (!btn) return;
      const rows = d.rows.filter(matches);
      const stamp = `${isoDate(start)}_${isoDate(end)}`;
      const name = dimKey === 'tag' ? 'tags' : 'kategorien';
      if (btn.dataset.csv === 'table') {
        downloadCsv(`${name}-${K.param}-${stamp}.csv`, [
          [D.singular, `Betrag (${d.code})`, ...(showForecast ? [`Prognose (${d.code})`] : []), 'Anteil %', `${cmp.label} (${d.code})`, 'Veränderung %', `Ø pro Monat (${d.code})`],
          ...rows.map((r) => [r.name, r.value, ...(showForecast ? [r.forecast] : []), d.total ? (r.value / d.total) * 100 : 0, r.prev, r.prev ? ((r.value - r.prev) / r.prev) * 100 : '', r.avg]),
        ]);
      } else {
        downloadCsv(`monatsmatrix-${name}-${K.param}-${stamp}.csv`, [
          [D.singular, ...months.map(([s]) => isoDate(s).slice(0, 7)), 'Ø', 'Summe'],
          ...rows.map((r) => [r.name, ...r.months, r.avg, r.total]),
        ]);
      }
    });
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Seite: eine Kategorie / ein Tag im Detail

export const categoryDetail = (view, ctx) => detail(view, { ...ctx, dimKey: 'category' });
export const tagDetail = (view, ctx) => detail(view, { ...ctx, dimKey: 'tag' });

async function detail(view, { period, params, id, dimKey }) {
  const D = DIMS[dimKey];
  const kind = kindFrom(params);
  const K = KINDS[kind];
  const { start, end } = period;
  const cmp = compareRange(period);
  const months = analysisMonths(period);
  const titleEl = document.getElementById('page-title');
  const showForecast = forecastActive(period);
  const isNone = String(id) === NO_CATEGORY && dimKey === 'category';

  view.innerHTML = `
    <div class="toolbar"><a class="back" href="${D.base}${kind === 'income' ? '?art=einnahmen' : ''}">← Alle ${D.plural}</a>
      <span class="meta-line">${K.label} · Vergleich mit ${fmtDate(cmp.start)} – ${fmtDate(cmp.end)}</span></div>
    <div class="grid">
      <section class="card span-3" id="d-total"></section>
      <section class="card span-3" id="d-avg"></section>
      <section class="card span-3" id="d-count"></section>
      <section class="card span-3" id="d-per"></section>
      ${card('d-chart', 'Monatsverlauf', { meta: `${fmtMonth(months[0][0])} – ${fmtMonth(months.at(-1)[0])}` })}
      ${card('d-partners', K.partner, { span: 'span-5', filter: true })}
      ${card('d-tx', 'Buchungen', { span: 'span-7', filter: true, meta: '<span id="d-sort"></span>' })}
    </div>`;
  const $ = (sel) => view.querySelector(`#${sel}`);

  const totals = Promise.all([
    dimTotals(dimKey, kind, start, end),
    dimTotals(dimKey, kind, cmp.start, cmp.end),
    Promise.all(months.map(([s, e]) => dimTotals(dimKey, kind, s, e))),
    showForecast ? forecastRemainder(dimKey, kind, period) : null,
  ]).then(([cur, prev, matrix, remainder]) => {
    const all = [...cur, ...prev, ...matrix.flat()];
    const own = all.filter((c) => c.id === String(id));
    const code = mainCurrency(own, 'code');
    const value = (list) => list.find((c) => c.id === String(id) && c.code === code)?.value || 0;
    const v = value(cur);
    const monthsV = matrix.map(value);
    return {
      code, name: own[0]?.name, value: v, prev: value(prev), months: monthsV,
      typical: typicalMonth(monthsV), forecast: remainder ? v + remainder(String(id), code) : null,
    };
  });

  // Name früh bestimmen – für Titel und Buchungsfilter
  const nameP = totals.then(async (d) => d.name || (isNone ? 'Ohne Kategorie' : await D.lookupName(id).catch(() => null)) || String(id));

  const txs = nameP.then((name) =>
    (isNone
      ? api.getAll('search/transactions', {
        query: `has_no_category:true type:${K.txType} date_after:${isoDate(start)} date_before:${isoDate(end)}`,
      })
      : D.transactions(id, { start, end, type: K.txType })
    ).then((groups) =>
      api.flattenTransactions(groups).filter((t) => t.type === K.txType && (isNone ? !t.category_name : D.belongs(t, id, name)))));

  nameP.then((name) => {
    if (view.contains($('d-total'))) {
      titleEl.textContent = name;
      document.title = `${name} · Firefly Dashboard`;
    }
  }).catch(() => {});

  const tile = (sel, loader, render) => fill($(sel), loader, render, skeleton(2, 22));
  tile('d-total', () => totals, (el, d) =>
    (el.innerHTML = stat(`${K.label} im Zeitraum`, money(d.value, d.code),
      `${delta(d.value, d.prev, kind, d.code)} ggü. ${cmp.label} (${money(d.prev, d.code)})${d.forecast !== null ? `<br><span class="forecast">≈ ${money(d.forecast, d.code)} bis ${fmtDate(end, { day: 'numeric', month: 'short' })}</span>` : ''}`)));
  tile('d-avg', () => totals, (el, d) => {
    const avg = sum(d.months, (x) => x) / months.length;
    const odd = d.months.map((v, i) => [v, i]).filter(([v]) => isOutlier(v, d.typical));
    const max = Math.max(...d.months);
    const sub = odd.length
      ? `Auffällig: ${odd.slice(-3).map(([v, i]) => `${fmtMonth(months[i][0])} (${pctSigned.format(v / d.typical - 1)})`).join(', ')}`
      : max ? `Spitze: ${fmtMonth(months[d.months.indexOf(max)][0])} mit ${money(max, d.code)}` : `über ${months.length} Monate`;
    el.innerHTML = stat('Ø pro Monat', money(avg, d.code), sub);
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

  fill($('d-chart'), () => Promise.all([totals, nameP]), (el, [d, name]) => {
    const avg = sum(d.months, (x) => x) / months.length;
    const base = seriesColor(kind === 'income' ? 2 : 0);
    const inPeriod = months.map(([s, e]) => e >= start && s <= end);
    const series = [{ label: K.label, data: d.months, color: inPeriod.map((p) => (p ? base : `${base}55`)) }];
    // Prognose als heller Aufsatz auf den laufenden Monat
    const extra = d.forecast !== null ? Math.max(0, d.forecast - d.value) : 0;
    if (extra) series.push({ label: 'Prognose (noch erwartet)', data: months.map((_, i) => (i === months.length - 1 ? extra : 0)), color: `${base}33` });
    el.innerHTML = `<div class="legend"><span><i style="background:${base}"></i>im gewählten Zeitraum</span><span><i style="background:${base}55"></i>davor</span>
      ${extra ? `<span><i style="background:${base}33;outline:1px dashed ${base}"></i>Prognose</span>` : ''}
      ${d.months.some((v) => isOutlier(v, d.typical)) ? '<span><i class="outlier-key"></i>auffälliger Monat</span>' : ''}<span>Ø <b>&nbsp;${money(avg, d.code)}</b> pro Monat</span></div>
      <div class="chart-box" style="margin-top:12px"><canvas aria-label="${esc(K.label)} je Monat"></canvas></div>`;
    const q = D.query({ id: String(id), name });
    const chart = barChart(el.querySelector('canvas'), {
      labels: months.map(([s]) => s), series, currency: d.code, average: avg, stacked: Boolean(extra),
      onClick: (i) => (location.hash = `#/buchungen?q=${encodeURIComponent(q)}&type=${K.txType}&von=${isoDate(months[i][0])}&bis=${isoDate(months[i][1])}`),
    });
    // Auffällige Monate mit Rahmen in Warnfarbe markieren (zusätzlich zum Text oben)
    const ds = chart.data.datasets[0];
    ds.borderColor = d.months.map((v) => (isOutlier(v, d.typical) ? cssVar('--status-warning') : 'transparent'));
    ds.borderWidth = d.months.map((v) => (isOutlier(v, d.typical) ? 2 : 0));
    ds.borderSkipped = false;
    chart.update('none');
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
    const max = items[0].value;
    const op = kind === 'income' ? 'source_account_is' : 'destination_account_is';
    el.innerHTML = `<div class="bars scroll">${items
      .map((g) => `<div class="bar-row"><a class="name" href="#/buchungen?q=${encodeURIComponent(`${op}:"${g.name}"`)}" title="${esc(g.name)}">${esc(g.name)}</a>
        <div class="track"><div class="fill" style="width:${(g.value / max) * 100}%"></div></div>
        <div class="val">${money(g.value, code)}<small>${g.count}× · ${percent(g.value / total)}</small></div></div>`)
      .join('')}</div>`;
  });

  let order = 'date';
  fill($('d-tx'), () => txs, (el, list) => {
    const render = () => {
      const rows = [...list].sort((a, b) => (order === 'date' ? String(b.date).localeCompare(String(a.date)) : b.amount - a.amount));
      $('d-sort').innerHTML = `<button class="link-btn" data-order="date" aria-pressed="${order === 'date'}">Neueste</button> · <button class="link-btn" data-order="amount" aria-pressed="${order === 'amount'}">Größte</button>`;
      el.innerHTML = rows.length
        ? `<div class="table-wrap scroll"><table><tbody>${rows
          .slice(0, 300)
          .map((t) => `<tr style="cursor:default"><td class="date">${fmtDate(t.date)}</td>
            <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterparty(t))}${dimKey === 'tag' && t.category_name ? ` · ${esc(t.category_name)}` : ''}</div></td>
            <td class="num">${signedAmount(t)}</td></tr>`)
          .join('')}</tbody></table></div>${rows.length > 300 ? `<div class="legend" style="margin-top:12px"><span>Die ersten 300 von ${rows.length} Buchungen</span></div>` : ''}`
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
