// Analyse nach Kategorien bzw. Tags: Vergleich, Monatsmatrix, Prognose
// und Detailseite. Beide Sichten teilen sich denselben Code (DIMS).

import * as api from './api.js';
import { barChart, legend, seriesColor, cssVar } from './charts.js';
import { money, percent, esc, fmtDate, fmtMonth, today, isoDate, addDays, storage, store, debounce, CALENDAR } from './util.js';
import { actionFor, setCategory } from './txedit.js';
import { skeleton, fill, card, stat, signedAmount, mainCurrency, sum, counterparty, downloadCsv, termsMatcher, multiSelect, txAttrs, bindTxDetails } from './common.js';
import { shareStrip, weekdayChart, sizeChart } from './dist.js';
import { loadGoals, saveGoal, goalStatus, goalBar } from './goals.js';

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

/** Vergleich nach Einstellung: Vorperiode (Standard) oder Vorjahr. */
export function compareRange(period) {
  const mode = storage('ffd-compare', 'prev');
  const [s, e] = mode === 'year' ? yearAgoRange(period) : previousRange(period);
  return { start: s, end: e, mode, label: mode === 'year' ? 'Vorjahr' : 'Vorperiode' };
}

/**
 * Monate für Matrix und Verläufe: mindestens 12 bis zum Ende des Zeitraums,
 * bei längeren Zeiträumen alle. Jeder Eintrag: [Beginn, Ende] mit .label.
 */
export function analysisMonths(period) {
  const M = modelOf(period);
  const kLast = M.keyOf(capToday(period.end));
  const count = Math.max(12, M.monthsBetween(M.keyOf(period.start), kLast) + 1);
  return Array.from({ length: count }, (_, i) => M.range(kLast, i - count + 1));
}

/** Ausgeschriebener Monat für Überschriften, z. B. „Oktober 2026 (24.09.–22.10.)“. */
const monthLong = (m) => {
  const name = fmtDate(m.label || m[0], { month: 'long', year: 'numeric' });
  return m.label && m.label === m[1] ? `${name} (${fmtDate(m[0], { day: '2-digit', month: '2-digit' })}–${fmtDate(m[1], { day: '2-digit', month: '2-digit' })})` : name;
};

/** Beschriftung eines Monats; bei Gehaltsmonaten mit Datumsbereich als Hinweis. */
export const monthTitle = (m) => `${fmtMonth(m.label)}${m.label === m[1] ? ` (${fmtDate(m[0], { day: '2-digit', month: '2-digit' })}–${fmtDate(m[1], { day: '2-digit', month: '2-digit' })})` : ''}`;

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
 * Hochrechnung je Eintrag: bisher + Ø dessen, was früher im restlichen Teil
 * des Zeitraums noch dazukam. Fixkosten, die schon gebucht sind (Miete am 3.),
 * werden so nicht doppelt gezählt.
 */
export async function forecastRemainder(dimKey, kind, period) {
  const windows = remainderWindows(period);
  const lists = await Promise.all(windows.map(([s, e]) => dimTotals(dimKey, kind, s, e)));
  const acc = new Map();
  const names = new Map();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.id}|${c.code}`;
      acc.set(key, (acc.get(key) || 0) + c.value / windows.length);
      names.set(key, c.name);
    }
  }
  const get = (id, code) => acc.get(`${id}|${code}`) || 0;
  // Einzelposten für die Prognose im Detail
  get.items = [...acc].map(([key, value]) => {
    const [id, code] = key.split('|');
    return { id, code, name: names.get(key), value };
  });
  return get;
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
// Aufklappbare Buchungsliste unter Diagramm/Matrix

let panelSeq = 0;

/** Gehört eine Buchung zu einem Eintrag (Kategorie bzw. Tag)? */
function belongsTo(dimKey, r) {
  if (dimKey === 'tag') return (t) => (t.tags || []).includes(r.name);
  if (r.id === NO_CATEGORY) return (t) => !t.category_name;
  return (t) => (t.category_id != null ? String(t.category_id) === String(r.id) : t.category_name === r.name);
}

/**
 * Zeigt die Buchungen eines Monats für einen oder mehrere Einträge direkt
 * unter dem angeklickten Diagramm – ohne die Seite zu wechseln.
 */
async function showMonthPanel(panel, { dimKey, kind, rows, month, title, link }) {
  const K = KINDS[kind];
  const [start, end] = month;
  const listId = `mp-${++panelSeq}`;
  const tests = rows.map((r) => belongsTo(dimKey, r));
  panel.hidden = false;
  panel.innerHTML = `
    <div class="mp-head">
      <div><h3>${esc(title)}</h3><span class="mp-sub" id="${listId}-sub">${monthLong(month)} · lädt …</span></div>
      <div class="card-tools">
        <input class="card-filter" type="search" placeholder="Filtern …" aria-label="Buchungen filtern" data-target="${listId}">
        <span class="mp-sort"><button class="link-btn" data-order="amount" aria-pressed="true">Größte</button> · <button class="link-btn" data-order="date" aria-pressed="false">Datum</button></span>
        ${link ? `<a class="link-btn" href="${link}">Auf Buchungsseite ↗</a>` : ''}
        <button class="icon-btn mp-close" aria-label="Liste schließen" title="Schließen">✕</button>
      </div>
    </div>
    <div id="${listId}">${skeleton(4)}</div>`;
  panel.querySelector('.mp-close').addEventListener('click', () => {
    panel.hidden = true;
    panel.innerHTML = '';
  });
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  let list;
  try {
    const groups = await api.getAll('transactions', { start, end, type: K.txType });
    list = api.flattenTransactions(groups).filter((t) => t.type === K.txType && tests.some((test) => test(t)));
  } catch (err) {
    panel.querySelector(`#${listId}`).innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
    return;
  }
  if (!panel.querySelector(`#${listId}`)) return; // inzwischen anderer Balken gewählt

  const code = mainCurrency(list);
  const total = sum(list.filter((t) => t.currency_code === code), (t) => t.amount);
  panel.querySelector(`#${listId}-sub`).textContent =
    `${monthLong(month)} · ${list.length} Buchungen · ${money(total, code)}`;
  const fireflyUrl = window.FFD_CONFIG?.fireflyUrl;
  let order = 'amount';
  const render = () => {
    const rows = [...list].sort((a, b) => (order === 'date' ? String(b.date).localeCompare(String(a.date)) : b.amount - a.amount));
    panel.querySelector(`#${listId}`).innerHTML = rows.length
      ? `<div class="table-wrap scroll"><table><tbody>${rows
        .map((t, i) => `<tr ${txAttrs(i)}>
          <td class="date">${fmtDate(t.date, { day: '2-digit', month: '2-digit' })}</td>
          <td><div class="desc">${esc(t.description)}</div>
            <div class="flow">${esc(counterparty(t))}${t.category_name ? ` · ${esc(t.category_name)}` : ''}${(t.tags || []).map((tag) => ` <span class="tag">${esc(tag)}</span>`).join('')}</div>
            ${t.notes ? `<div class="flow note">${esc(t.notes)}</div>` : ''}</td>
          <td class="num">${signedAmount(t)}${fireflyUrl ? `<div><a class="link-btn" href="${esc(fireflyUrl)}/transactions/show/${encodeURIComponent(t.groupId)}" target="_blank" rel="noopener" title="In Firefly öffnen">↗</a></div>` : ''}</td>
        </tr>`)
        .join('')}</tbody></table></div>
        <div class="legend" style="margin-top:10px"><span>Summe: <b>&nbsp;${money(total, code)}</b>&nbsp;in ${list.length} Buchungen</span></div>`
      : '<div class="empty">Keine Buchungen in diesem Monat.</div>';
    bindTxDetails(panel.querySelector(`#${listId}`), (i) => rows[Number(i)]);
  };
  render();
  panel.querySelector('.mp-sort').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-order]');
    if (!btn) return;
    order = btn.dataset.order;
    panel.querySelectorAll('.mp-sort [data-order]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    render();
  });
}

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
  const monthsLabel = `${fmtMonth(months[0].label)} – ${fmtMonth(months.at(-1).label)}${months[0].label === months[0][1] ? ' · Gehaltsmonate' : ''}`;
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
      ${card('c-dist', 'Verteilung', { meta: esc(period.label) })}
      ${card('c-stack', 'Top 5 im Monatsverlauf', { meta: monthsLabel })}
      ${card('c-matrix', 'Monatsmatrix', { link: `<span class="meta">${monthsLabel} · <button class="link-btn" data-csv="matrix">CSV ↓</button></span>` })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  $('c-stack').insertAdjacentHTML('afterend', '<div class="month-panel" hidden></div>');
  $('c-matrix').insertAdjacentHTML('afterend', '<div class="month-panel" hidden></div>');
  const stackPanel = $('c-stack').nextElementSibling;
  const matrixPanel = $('c-matrix').nextElementSibling;

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
    dimKey === 'category' && kind === 'expense' ? loadGoals() : {},
  ]).then(([cur, prev, matrix, remainder, goals]) => {
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
      r.goal = goals[r.id]?.amount ?? null;
      r.goalSt = r.goal ? goalStatus(r.value, r.goal, period, r.forecast) : null;
    });
    rows.sort((a, b) => b.total - a.total);
    return { code, rows, hasGoals: rows.some((r) => r.goal), total: sum(rows, (r) => r.value), prevTotal: sum(rows, (r) => r.prev) };
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
  const baseCols = [
    ['name', D.singular, ''],
    ['value', 'Betrag', 'num'],
    ...(showForecast ? [['forecast', 'Prognose', 'num']] : []),
    ['share', 'Anteil', 'hide-sm'],
    ['prev', cmp.label, 'num hide-sm'],
    ['change', 'Veränderung', 'num'],
    ['avg', 'Ø / Monat', 'num hide-sm'],
    [null, 'Verlauf', 'hide-sm'],
  ];
  const keyOf = (r, k) => (k === 'name' ? r.name.toLowerCase() : k === 'change' ? r.value - r.prev : k === 'share' ? r.value : k === 'goal' ? (r.goalSt?.used ?? -1) : r[k]);
  const goalCell = (r, code) => (r.goalSt
    ? `<td class="num" title="Ziel ${money(r.goal, code)} pro Monat · ${money(r.goalSt.limit, code)} im Zeitraum"><span class="badge ${r.goalSt.cls}">${percent(r.goalSt.used)}</span></td>`
    : `<td class="num"><a class="link-btn" href="${detailHref(D, r.id, kind)}?ziel=1" title="Monatsziel festlegen">+ Ziel</a></td>`);

  function renderTable(el, d) {
    const cols = d.hasGoals ? [...baseCols.slice(0, showForecast ? 3 : 2), ['goal', 'Ziel', 'num'], ...baseCols.slice(showForecast ? 3 : 2)] : baseCols;
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
          ${d.hasGoals ? goalCell(r, d.code) : ''}
          <td class="hide-sm"><div class="share"><div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div><span>${percent(d.total ? r.value / d.total : 0)}</span></div></td>
          <td class="num hide-sm muted">${money(r.prev, d.code)}</td>
          <td class="num">${delta(r.value, r.prev, kind, d.code)}</td>
          <td class="num hide-sm">${money(r.avg, d.code)}</td>
          <td class="hide-sm" data-tip="${esc(r.months.map((v, i) => `${monthTitle(months[i])}: ${money(v, d.code)}`).join('\n'))}">${sparkline(r.months)}</td>
        </tr>`)
        .join('')}</tbody>${filtered() ? `<tfoot><tr><td><b>Summe Auswahl (${rows.length})</b></td><td class="num"><b>${money(fv, d.code)}</b></td>
          ${showForecast ? `<td class="num forecast">≈ ${money(sum(rows, (r) => r.forecast), d.code)}</td>` : ''}
          ${d.hasGoals ? '<td></td>' : ''}
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
    stackChart = barChart(el.querySelector('canvas'), {
      labels: months.map((m) => m.label), series, currency: d.code, stacked: true,
      onClick: (i, ds) => {
        // Segment getroffen → nur diese Kategorie; daneben geklickt → alle gezeigten
        const picked = ds === null ? ranked : ds < top.length ? [top[ds]] : rest;
        const title = ds === null ? (filtered() ? 'Auswahl' : `Alle ${D.plural}`) : ds < top.length ? top[ds].name : `Sonstige (${rest.length})`;
        showMonthPanel(stackPanel, {
          dimKey, kind, rows: picked, month: months[i], title,
          link: picked.length === 1 ? drillLink(picked[0], i) : null,
        });
      },
    });
    el.insertAdjacentHTML('beforeend', '<div class="legend" style="margin-top:8px"><span>Balken oder Segment anklicken zeigt die Buchungen darunter</span></div>');
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
      const overGoal = r.goal && v > r.goal;
      if (odd) outliers += 1;
      const tip = `${r.name} · ${monthTitle(months[i])}: ${money(v, d.code)}${r.avg ? ` (${pctSigned.format(v / r.avg - 1)} ggü. Ø)` : ''}${odd ? `\n▲ Auffällig: ${pctSigned.format(v / r.typical - 1)} über dem üblichen Monat (${money(r.typical, d.code)})` : ''}${overGoal ? `\n✕ Über dem Ziel von ${money(r.goal, d.code)}` : ''}\nKlicken für Buchungen`;
      return v
        ? `<td class="heat${t > 0.6 ? ' strong' : ''}${odd ? ' outlier' : ''}${overGoal ? ' over-goal' : ''}" style="--t:${t.toFixed(3)}" data-tip="${esc(tip)}" data-row="${esc(r.id)}" data-month="${i}">${intFmt.format(v)}</td>`
        : '<td class="heat empty-cell">·</td>';
    };
    const body = rows
      .map((r) => `<tr><th scope="row"><a class="plain" href="${detailHref(D, r.id, kind)}">${esc(r.name)}</a></th>${r.months.map((v, i) => cell(r, v, i)).join('')}
        <td class="num muted">${intFmt.format(r.avg)}</td><td class="num"><b>${intFmt.format(r.total)}</b></td></tr>`)
      .join('');
    el.innerHTML = `<div class="table-wrap"><table class="matrix">
      <thead><tr><th>${D.singular}</th>${months.map((m) => `<th class="num"${m.label === m[1] ? ` title="${esc(monthTitle(m))}"` : ''}>${fmtMonth(m.label)}${m.label === m[1] ? `<small class="th-range">${m[0].getDate()}.${m[0].getMonth() + 1}.</small>` : ''}</th>`).join('')}<th class="num">Ø</th><th class="num">Summe</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><th>${filtered() ? 'Summe Auswahl' : 'Summe'}</th>${colTotals.map((v) => `<td class="num"><b>${intFmt.format(v)}</b></td>`).join('')}
        <td class="num muted">${intFmt.format(sum(colTotals, (x) => x) / months.length)}</td><td class="num"><b>${intFmt.format(sum(colTotals, (x) => x))}</b></td></tr></tfoot>
    </table></div>
    <div class="legend" style="margin-top:12px"><span>Beträge in ${esc(d.code)} · Farbintensität je Zeile relativ zum stärksten Monat</span>
      ${outliers ? `<span><i class="outlier-key"></i>auffällig hoher Monat (${outliers}×)</span>` : ''}
      ${rows.some((r) => r.goal) ? '<span><i class="goal-key"></i>über dem Monatsziel</span>' : ''}<span>Feld anklicken zeigt die Buchungen darunter</span></div>`;
  }

  // Einzelbuchungen des Zeitraums – für Wochentage und Betragsklassen
  const periodTxs = api.getAll('transactions', { start, end, type: K.txType })
    .then((groups) => api.flattenTransactions(groups).filter((t) => t.type === K.txType));
  let distCharts = [];
  function renderDist(el, d, txs) {
    distCharts.forEach((c) => c.destroy());
    distCharts = [];
    const rows = d.rows.filter(matches);
    const tests = rows.map((r) => belongsTo(dimKey, r));
    const own = txs.filter((t) => t.currency_code === d.code && tests.some((test) => test(t)));
    el.innerHTML = `${shareStrip(rows.map((r) => ({ id: r.id, name: r.name, value: r.value })), { code: d.code, hrefFor: (p) => detailHref(D, p.id, kind) })}
      <div class="dist-grid">
        <div><h3 class="sub-h">Nach Wochentag</h3><div class="chart-box short"><canvas aria-label="${K.label} nach Wochentag"></canvas></div></div>
        <div><h3 class="sub-h">Nach Betragshöhe <span class="muted">(Anzahl Buchungen)</span></h3><div class="chart-box short"><canvas aria-label="Buchungen nach Betragshöhe"></canvas></div></div>
      </div>`;
    const [c1, c2] = el.querySelectorAll('canvas');
    const color = seriesColor(kind === 'income' ? 2 : 0);
    distCharts = [weekdayChart(c1, own, d.code, color), sizeChart(c2, own, d.code, color)];
  }

  const rerender = (d) => {
    periodTxs.then((txs) => renderDist($('c-dist'), d, txs)).catch(() => {});
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
  fill($('c-dist'), () => Promise.all([data, periodTxs]), (el, [d, txs]) => renderDist(el, d, txs), skeleton(3, 60));
  fill($('c-stack'), () => data, renderStack, skeleton(1, 280));
  fill($('c-matrix'), () => data, (el, d) => {
    renderMatrix(el, d);
    el.addEventListener('click', (e) => {
      const td = e.target.closest('td[data-row]');
      if (!td) return;
      const r = d.rows.find((x) => x.id === td.dataset.row);
      const i = Number(td.dataset.month);
      el.querySelectorAll('td.heat.selected').forEach((x) => x.classList.remove('selected'));
      td.classList.add('selected');
      showMonthPanel(matrixPanel, { dimKey, kind, rows: [r], month: months[i], title: r.name, link: drillLink(r, i) });
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
  const withGoals = dimKey === 'category' && kind === 'expense';

  view.innerHTML = `
    <div class="toolbar"><a class="back" href="${D.base}${kind === 'income' ? '?art=einnahmen' : ''}">← Alle ${D.plural}</a>
      ${withGoals ? '<div id="goal-edit" class="goal-edit"></div>' : ''}
      <span class="meta-line">${K.label} · Vergleich mit ${fmtDate(cmp.start)} – ${fmtDate(cmp.end)}</span></div>
    <div class="grid">
      <section class="card span-3" id="d-total"></section>
      <section class="card span-3" id="d-avg"></section>
      <section class="card span-3" id="d-count"></section>
      <section class="card span-3" id="d-per"></section>
      ${card('d-chart', 'Monatsverlauf', { meta: `${fmtMonth(months[0].label)} – ${fmtMonth(months.at(-1).label)}${months[0].label === months[0][1] ? ' · Gehaltsmonate' : ''}` })}
      ${isNone && kind === 'expense' ? card('d-suggest', 'Vorschläge zum Kategorisieren', { filter: true, meta: '<span id="d-suggest-meta"></span>' }) : ''}
      ${card('d-dist', 'Verteilung', { meta: esc(period.label) })}
      ${card('d-partners', K.partner, { span: 'span-5', filter: true })}
      ${card('d-tx', 'Buchungen', { span: 'span-7', filter: true, meta: '<span id="d-sort"></span>' })}
    </div>`;
  const $ = (sel) => view.querySelector(`#${sel}`);
  $('d-chart').insertAdjacentHTML('afterend', '<div class="month-panel" hidden></div>');
  const detailPanel = $('d-chart').nextElementSibling;

  const totals = Promise.all([
    dimTotals(dimKey, kind, start, end),
    dimTotals(dimKey, kind, cmp.start, cmp.end),
    Promise.all(months.map(([s, e]) => dimTotals(dimKey, kind, s, e))),
    showForecast ? forecastRemainder(dimKey, kind, period) : null,
    withGoals ? loadGoals() : {},
  ]).then(([cur, prev, matrix, remainder, goals]) => {
    const all = [...cur, ...prev, ...matrix.flat()];
    const own = all.filter((c) => c.id === String(id));
    const code = mainCurrency(own, 'code');
    const value = (list) => list.find((c) => c.id === String(id) && c.code === code)?.value || 0;
    const v = value(cur);
    const monthsV = matrix.map(value);
    return {
      code, name: own[0]?.name, value: v, prev: value(prev), months: monthsV,
      typical: typicalMonth(monthsV), forecast: remainder ? v + remainder(String(id), code) : null,
      goal: goals[String(id)]?.amount ?? null,
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

  // Monatsziel festlegen / ändern
  if (withGoals) {
    const host = $('goal-edit');
    Promise.all([loadGoals(), nameP, totals]).then(([goals, name, t]) => {
      const goal = goals[String(id)];
      const show = (editing) => {
        host.innerHTML = editing
          ? `<form class="goal-form"><label>Monatsziel <input type="number" min="1" step="1" inputmode="decimal" value="${goal ? goal.amount : Math.round((sum(t.months, (x) => x) / months.length) / 10) * 10 || ''}"> €</label>
              <button class="btn primary">Speichern</button>${goal ? '<button type="button" class="btn" data-remove>Entfernen</button>' : ''}<button type="button" class="btn" data-cancel>Abbrechen</button></form>`
          : `<button class="chip" data-edit>${goal ? `Ziel: ${money(goal.amount, t.code)} / ${period.model?.isSalary ? 'Gehaltsmonat' : 'Monat'} ✎` : '+ Monatsziel festlegen'}</button>`;
        if (editing) host.querySelector('input').select();
      };
      show(params.get('ziel') === '1');
      // nach dem Speichern ohne ?ziel=1 neu anzeigen, sonst öffnet sich der Editor wieder
      const done = () => {
        const qs = new URLSearchParams(params);
        qs.delete('ziel');
        history.replaceState(null, '', `${detailHref(D, id, kind).split('?')[0]}${qs.toString() ? `?${qs}` : ''}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      };
      host.addEventListener('click', async (e) => {
        if (e.target.closest('[data-edit]')) show(true);
        if (e.target.closest('[data-cancel]')) show(false);
        if (e.target.closest('[data-remove]')) {
          await saveGoal(String(id), name, 0);
          done();
        }
      });
      host.addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = Number(host.querySelector('input').value);
        if (amount > 0) {
          await saveGoal(String(id), name, amount);
          done();
        }
      });
    }).catch(() => {});
  }

  // Vorschläge für Buchungen ohne Kategorie: ähnliche, bereits kategorisierte Buchungen
  if (isNone && kind === 'expense') {
    fill($('d-suggest'), () => Promise.all([txs, loadReference(), categorizeAction()]), (el, [list, ref, action]) => {
      const suggestions = suggestCategories(list, ref);
      $('d-suggest-meta').textContent = `${suggestions.filter((x) => x.category).length} von ${list.length} mit Vorschlag`;
      if (!list.length) return (el.innerHTML = '<div class="empty">Alles kategorisiert. 🎉</div>');
      const ff = window.FFD_CONFIG?.fireflyUrl;
      el.innerHTML = `<div class="table-wrap scroll"><table><tbody>${suggestions
        .map((x, i) => `<tr ${txAttrs(i)}>
          <td class="date">${fmtDate(x.t.date)}</td>
          <td><div class="desc">${esc(x.t.description)}</div><div class="flow">${esc(counterparty(x.t))} · ${money(x.t.amount, x.t.currency_code)}</div></td>
          <td>${x.category
            ? `<div><span class="badge ${x.confidence >= 80 ? 'good' : 'warn'}">${esc(x.category)}</span> <span class="muted">${x.confidence} %</span></div><div class="flow">${esc(x.reason)}</div>`
            : '<span class="muted">kein Vorschlag</span>'}</td>
          <td class="num suggest-actions">
            ${x.category && action ? `<button class="btn small" data-apply="${i}">Übernehmen</button>` : ''}
            ${ff ? `<a class="link-btn" href="${esc(ff)}/transactions/edit/${encodeURIComponent(x.t.groupId)}" target="_blank" rel="noopener">In Firefly ↗</a>` : ''}
          </td></tr>`)
        .join('')}</tbody></table></div>
        <div class="legend" style="margin-top:12px"><span>${action
          ? `„Übernehmen“ startet die Automation „${esc(action.name)}“ – sie setzt die Kategorie in Firefly.`
          : 'Tipp: Mit einer Automation „Kategorie übernehmen“ (n8n) lassen sich Vorschläge per Klick in Firefly eintragen.'}
          Für wiederkehrende Fälle lohnt sich eine Firefly-Regel (Empfänger → Kategorie). Zeile anklicken zeigt alle Details.</span></div>`;
      bindTxDetails(el, (i) => suggestions[Number(i)]?.t);
      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-apply]');
        if (!btn) return;
        const x = suggestions[Number(btn.dataset.apply)];
        btn.disabled = true;
        btn.textContent = 'Sende …';
        try {
          const res = await setCategory(action, x.t, x.category, x.categoryId);
          btn.textContent = res.ok ? 'Gesendet ✓' : `Fehler ${res.status || ''}`;
          btn.classList.toggle('done', Boolean(res.ok));
        } catch {
          btn.textContent = 'Fehler';
          btn.disabled = false;
        }
      });
    }, skeleton(5));
  }

  const tile = (sel, loader, render) => fill($(sel), loader, render, skeleton(2, 22));
  tile('d-total', () => totals, (el, d) =>
    (el.innerHTML = stat(`${K.label} im Zeitraum`, money(d.value, d.code),
      `${delta(d.value, d.prev, kind, d.code)} ggü. ${cmp.label} (${money(d.prev, d.code)})${d.forecast !== null ? `<br><span class="forecast">≈ ${money(d.forecast, d.code)} bis ${fmtDate(end, { day: 'numeric', month: 'short' })}</span>` : ''}`)
      + (d.goal ? goalBar(d.value, d.goal, period, d.code, d.forecast) : '')));
  tile('d-avg', () => totals, (el, d) => {
    const avg = sum(d.months, (x) => x) / months.length;
    const odd = d.months.map((v, i) => [v, i]).filter(([v]) => isOutlier(v, d.typical));
    const max = Math.max(...d.months);
    const sub = odd.length
      ? `Auffällig: ${odd.slice(-3).map(([v, i]) => `${fmtMonth(months[i].label)} (${pctSigned.format(v / d.typical - 1)})`).join(', ')}`
      : max ? `Spitze: ${fmtMonth(months[d.months.indexOf(max)].label)} mit ${money(max, d.code)}` : `über ${months.length} Monate`;
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
      ${d.months.some((v) => isOutlier(v, d.typical)) ? '<span><i class="outlier-key"></i>auffälliger Monat</span>' : ''}
      ${d.goal ? `<span><i class="line-key goal"></i>Ziel ${money(d.goal, d.code)}</span>` : ''}<span>Ø <b>&nbsp;${money(avg, d.code)}</b> pro Monat</span></div>
      <div class="chart-box" style="margin-top:12px"><canvas aria-label="${esc(K.label)} je Monat"></canvas></div>
      <div class="legend" style="margin-top:8px"><span>Balken anklicken zeigt die Buchungen des Monats darunter</span></div>`;
    const q = D.query({ id: String(id), name });
    const chart = barChart(el.querySelector('canvas'), {
      labels: months.map((m) => m.label), series, currency: d.code, average: avg, goal: d.goal, stacked: Boolean(extra),
      onClick: (i) => showMonthPanel(detailPanel, {
        dimKey, kind, rows: [{ id: String(id), name }], month: months[i], title: name,
        link: `#/buchungen?q=${encodeURIComponent(q)}&type=${K.txType}&von=${isoDate(months[i][0])}&bis=${isoDate(months[i][1])}`,
      }),
    });
    // Auffällige Monate mit Rahmen in Warnfarbe markieren (zusätzlich zum Text oben)
    const ds = chart.data.datasets[0];
    ds.borderColor = d.months.map((v) => (isOutlier(v, d.typical) ? cssVar('--status-warning') : 'transparent'));
    ds.borderWidth = d.months.map((v) => (isOutlier(v, d.typical) ? 2 : 0));
    ds.borderSkipped = false;
    chart.update('none');
  }, skeleton(1, 280));

  fill($('d-dist'), () => txs, (el, list) => {
    const code = mainCurrency(list);
    const own = list.filter((t) => t.currency_code === code);
    if (!own.length) return (el.innerHTML = '<div class="empty">Keine Buchungen im Zeitraum.</div>');
    el.innerHTML = `<div class="dist-grid">
      <div><h3 class="sub-h">Nach Wochentag</h3><div class="chart-box short"><canvas></canvas></div></div>
      <div><h3 class="sub-h">Nach Betragshöhe <span class="muted">(Anzahl Buchungen)</span></h3><div class="chart-box short"><canvas></canvas></div></div></div>`;
    const [c1, c2] = el.querySelectorAll('canvas');
    const color = seriesColor(kind === 'income' ? 2 : 0);
    weekdayChart(c1, own, code, color);
    sizeChart(c2, own, code, color);
  }, skeleton(1, 200));

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
          .map((t, i) => `<tr ${txAttrs(i)}><td class="date">${fmtDate(t.date)}</td>
            <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterparty(t))}${dimKey === 'tag' && t.category_name ? ` · ${esc(t.category_name)}` : ''}</div></td>
            <td class="num">${signedAmount(t)}</td></tr>`)
          .join('')}</tbody></table></div>${rows.length > 300 ? `<div class="legend" style="margin-top:12px"><span>Die ersten 300 von ${rows.length} Buchungen</span></div>` : ''}`
        : '<div class="empty">Keine Buchungen im Zeitraum.</div>';
      bindTxDetails(el, (i) => rows[Number(i)]);
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

// ---------------------------------------------------------------------------
// Kategorisierungshilfe

/** Kategorisierte Ausgaben der letzten 24 Monate als Vergleichsbasis (gleicher Cache wie „Wiederkehrend“). */
function loadReference() {
  const t0 = today();
  const from = new Date(t0.getFullYear(), t0.getMonth() - 24, 1);
  return api.getAll('transactions', { start: from, end: t0, type: 'withdrawal' })
    .then((groups) => api.flattenTransactions(groups).filter((t) => t.category_name));
}

const categorizeAction = () => actionFor('categorize');

const normName = (s) => String(s || '').toLowerCase().replace(/[0-9]+/g, ' ').replace(/[^\p{L} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Schlägt je Buchung eine Kategorie vor: zuerst nach gleichem Empfänger,
 * sonst nach den ersten Wörtern des Buchungstexts. Sicherheit = Anteil der
 * passenden früheren Buchungen mit dieser Kategorie.
 */
function suggestCategories(list, reference) {
  const index = (keyOf) => {
    const map = new Map();
    for (const t of reference) {
      const key = keyOf(t);
      if (!key) continue;
      const m = map.get(key) || new Map();
      const c = m.get(t.category_name) || { n: 0, id: t.category_id };
      c.n += 1;
      m.set(t.category_name, c);
      map.set(key, m);
    }
    return map;
  };
  const byParty = index((t) => normName(t.destination_name));
  const firstWords = (t) => normName(t.description).split(' ').slice(0, 2).join(' ');
  const byText = index((t) => (firstWords(t).length > 3 ? firstWords(t) : ''));
  const best = (m) => {
    if (!m) return null;
    const total = [...m.values()].reduce((a, c) => a + c.n, 0);
    const [name, c] = [...m].sort((a, b) => b[1].n - a[1].n)[0];
    return { name, id: c.id, n: c.n, total, share: c.n / total };
  };
  return list
    .map((t) => {
      const party = best(byParty.get(normName(t.destination_name)));
      const text = best(byText.get(firstWords(t)));
      const pick = party && party.n >= 2 && party.share >= 0.6 ? { ...party, how: `${party.n}× bei „${t.destination_name}“` }
        : text && text.n >= 2 && text.share >= 0.6 ? { ...text, how: `${text.n}× ähnlicher Text „${firstWords(t)}“` } : null;
      return {
        t,
        category: pick?.name || null,
        categoryId: pick?.id ?? null,
        confidence: pick ? Math.round(pick.share * 100) : 0,
        reason: pick ? `bisher ${pick.how}` : '',
      };
    })
    .sort((a, b) => b.confidence - a.confidence || String(b.t.date).localeCompare(String(a.t.date)));
}
