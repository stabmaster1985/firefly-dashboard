// Übersicht, Buchungen und Konten.

import * as api from './api.js';
import { barChart, lineChart, legend, seriesColor, cssVar } from './charts.js';

/** Feste Farbe je Name (Kategorie-Kürzel): gleicher Name → gleiche Farbe auf allen Seiten. */
const nameColor = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return seriesColor(h % 8);
};
import { money, percent, esc, fmtDate, fmtMonth, initials, isoDate, today, debounce, parseDate, addDays, CALENDAR, storage, store } from './util.js';
import { skeleton, fill, card, stat, signedAmount, txRow, txAttrs, bindTxDetails, mainCurrency, sum } from './common.js';
import { categoryTotals, compareRange, delta, forecastActive, forecastTotal, forecastRemainder } from './categories.js';
import { loadRecurring, upcomingBetween } from './recurring.js';
import { sankey } from './dist.js';
import { checkHints } from './check.js';
import { actionFor, runAction } from './txedit.js';
import { loadGoals, goalBar, goalStatus } from './goals.js';

/** Summe aller Einnahmen bzw. Ausgaben je Währung (Map Währung → Betrag). */
const totalsOf = (kind, start, end) =>
  api.get(`insight/${kind}/total`, { start, end })
    .then((list) => new Map((list || []).map((x) => [x.currency_code, Math.abs(Number(x.difference_float ?? x.difference))])));

export async function overview(view, { period }) {
  const { start, end } = period;
  const cmp = compareRange(period);
  const [prevStart, prevEnd] = [cmp.start, cmp.end];
  view.innerHTML = `
    <div class="grid">
      <section class="card span-3" id="s-networth"></section>
      <section class="card span-3" id="s-earned"></section>
      <section class="card span-3" id="s-spent"></section>
      <section class="card span-3" id="s-balance"></section>
      ${card('hints', 'Hinweise', { span: 'span-6', link: '<a href="#/automationen">Per n8n melden →</a>' })}
      ${card('goals', 'Ziele', { span: 'span-6', meta: esc(period.label) })}
      ${card('cashflow', 'Einnahmen & Ausgaben', { span: 'span-8', meta: period.model?.isSalary ? 'letzte 12 Gehaltsmonate' : 'letzte 12 Monate' })}
      ${card('accounts', 'Konten', { span: 'span-4', link: '<a href="#/konten">Alle →</a>' })}
      ${card('flow', 'Geldfluss', { meta: `${esc(period.label)} · Einnahmen → Ausgaben` })}
      ${forecastActive(period) ? card('expected', `Erwartet bis ${fmtDate(end, { day: 'numeric', month: 'long' })}`, { filter: true, meta: 'Prognose im Detail' }) : ''}
      ${card('categories', 'Ausgaben nach Kategorie', { span: 'span-6', filter: true, link: '<a href="#/kategorien">Analyse →</a>' })}
      ${card('changes', 'Größte Veränderungen', { span: 'span-6', filter: true, meta: `ggü. ${fmtDate(prevStart, { day: 'numeric', month: 'short' })} – ${fmtDate(prevEnd, { day: 'numeric', month: 'short' })}` })}
      ${card('recent', 'Letzte Buchungen', { span: 'span-12', filter: true, link: '<a href="#/buchungen">Alle →</a>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  // summary/basic ist Fireflys teuerste Abfrage (rechnet über den ganzen Zeitraum) – nur noch für das
  // Nettovermögen, und das ist ein Stand am Ende: also nur über dessen Monat. Einnahmen, Ausgaben und
  // Saldo kommen aus den Summen je Monat (lange zwischengespeichert), wie schon der Vergleich.
  const endRef = end > today() ? today() : end;
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  const netRange = sameMonth ? { start, end } : { start: new Date(endRef.getFullYear(), endRef.getMonth(), 1), end: new Date(endRef.getFullYear(), endRef.getMonth() + 1, 0) };
  const summary = Promise.all([api.get('summary/basic', netRange), totalsOf('income', start, end), totalsOf('expense', start, end)]).then(([net, inc, exp]) => {
    const s = Object.fromEntries(Object.entries(net || {}).filter(([k]) => k.startsWith('net-worth-in-')));
    for (const code of new Set([...inc.keys(), ...exp.keys()])) {
      const i = inc.get(code) || 0;
      const o = exp.get(code) || 0;
      s[`earned-in-${code}`] = { monetary_value: i, currency_code: code };
      s[`spent-in-${code}`] = { monetary_value: -o, currency_code: code };
      s[`balance-in-${code}`] = { monetary_value: i - o, currency_code: code };
    }
    return s;
  });
  const prevSummary = Promise.all([totalsOf('income', prevStart, prevEnd), totalsOf('expense', prevStart, prevEnd)]).catch(() => null);
  const showForecast = forecastActive(period);
  const both = Promise.all([
    summary,
    prevSummary,
    showForecast ? forecastTotal('income', period) : null,
    showForecast ? forecastTotal('expense', period) : null,
  ]);
  const until = fmtDate(end, { day: 'numeric', month: 'short' });
  const fcLine = (value, code) => `<br><span class="forecast">≈ ${money(value, code)} bis ${until}</span>`;
  const tile = (id, render) => fill($(id), () => both, render, skeleton(2, 22));
  const prevOf = (prev, key, code) => (prev ? prev[key === 'earned' ? 0 : 1].get(code) || 0 : 0);

  tile('s-networth', (el, [s]) => {
    const [main, ...rest] = api.summaryValues(s, 'net-worth');
    el.innerHTML = stat('Nettovermögen', money(main?.value, main?.code), rest.map((r) => money(r.value, r.code)).join(' · ') || `Stand ${fmtDate(end > today() ? today() : end)}`);
  });
  tile('s-earned', (el, [s, prev, fcIn]) => {
    const [main] = api.summaryValues(s, 'earned');
    const cur = main?.value || 0;
    el.innerHTML = stat('Einnahmen', `<span class="pos">${money(cur, main?.code)}</span>`,
      `${delta(cur, prevOf(prev, 'earned', main?.code), 'income', main?.code)} ggü. ${cmp.label}${fcIn ? fcLine(cur + fcIn(main?.code), main?.code) : ''}`);
  });
  tile('s-spent', (el, [s, prev, , fcOut]) => {
    const [main] = api.summaryValues(s, 'spent');
    const cur = Math.abs(main?.value || 0);
    el.innerHTML = stat('Ausgaben', money(cur, main?.code),
      `${delta(cur, Math.abs(prevOf(prev, 'spent', main?.code)), 'expense', main?.code)} ggü. ${cmp.label}${fcOut ? fcLine(cur + fcOut(main?.code), main?.code) : ''}`);
  });
  tile('s-balance', (el, [s, , fcIn, fcOut]) => {
    const [bal] = api.summaryValues(s, 'balance');
    const [earned] = api.summaryValues(s, 'earned');
    const rate = earned?.value > 0 ? bal.value / earned.value : null;
    const cls = (bal?.value || 0) >= 0 ? 'up' : 'down';
    const fc = fcIn && fcOut ? fcLine((bal?.value || 0) + fcIn(bal?.code) - fcOut(bal?.code), bal?.code) : '';
    el.innerHTML = stat('Saldo', money(bal?.value, bal?.code, { signed: true }),
      `${rate === null ? 'Einnahmen − Ausgaben' : `Sparquote <span class="${cls}">${percent(rate)}</span>`}${fc}`);
  });

  // Cashflow der letzten 12 Monate (bis zum Ende des gewählten Zeitraums)
  const ref = end > today() ? today() : end;
  const M = period.model || CALENDAR;
  const months = Array.from({ length: 12 }, (_, i) => M.range(M.keyOf(ref), i - 11));
  fill($('cashflow'), () => Promise.all(months.map(([s, e]) => Promise.all([totalsOf('income', s, e), totalsOf('expense', s, e)]))), (el, sums) => {
    const codes = sums.flatMap(([i, o]) => [...i.keys(), ...o.keys()]);
    const code = mainCurrency(codes.map((c) => ({ currency_code: c })));
    const series = [
      { label: 'Einnahmen', data: sums.map(([i]) => i.get(code) || 0), color: seriesColor(0) },
      { label: 'Ausgaben', data: sums.map(([, o]) => o.get(code) || 0), color: seriesColor(1) },
    ];
    const totalIn = sum(series[0].data, (x) => x);
    const totalOut = sum(series[1].data, (x) => x);
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Einnahmen und Ausgaben je Monat"></canvas></div>
      <div class="legend" style="margin-top:12px">
        <span>Ø Einnahmen <b>&nbsp;${money(totalIn / 12, code)}</b></span>
        <span>Ø Ausgaben <b>&nbsp;${money(totalOut / 12, code)}</b></span>
        <span>Ø Sparquote <b>&nbsp;${totalIn ? percent((totalIn - totalOut) / totalIn) : '–'}</b></span>
      </div>`;
    barChart(el.querySelector('canvas'), { labels: months.map((m) => m.label), series, currency: code });
  }, skeleton(1, 280));

  fill($('accounts'), () => api.getAll('accounts', { type: 'asset' }), (el, accounts) => {
    const list = accounts.filter((a) => a.attributes.active !== false);
    if (!list.length) return (el.innerHTML = '<div class="empty">Keine Konten gefunden.</div>');
    el.innerHTML = `<div class="list">${list
      .map((a, i) => {
        const at = a.attributes;
        return `<a class="row plain" href="#/konten/${encodeURIComponent(a.id)}"><div class="avatar" style="--av:${seriesColor(i)}">${esc(initials(at.name))}</div>
          <div style="min-width:0"><div class="title">${esc(at.name)}</div><div class="subtitle">${esc(ROLE[at.account_role] || 'Konto')}</div></div>
          <div class="amount">${money(at.current_balance, at.currency_code)}</div></a>`;
      })
      .join('')}</div>`;
  });

  const cats = Promise.all([categoryTotals('expense', start, end), categoryTotals('expense', prevStart, prevEnd)]).then(([cur, prev]) => {
    const code = mainCurrency(cur.length ? cur : prev, 'code');
    return { code, cur: cur.filter((c) => c.code === code), prev: prev.filter((c) => c.code === code) };
  });

  // Hinweise: Warnungen des Servers + Buchungen ohne Kategorie
  fill($('hints'), () => Promise.all([fetch('/local/alerts').then((r) => r.json()).catch(() => ({ alerts: [] })), cats, checkHints().catch(() => [])]), (el, [res, { code, cur }, checks]) => {
    const ICON = { grosse_buchung: '€', preisaenderung: '±', ausgeblieben: '?' };
    const rows = (res.alerts || []).slice(0, 5).map((a) => `<div class="row">
      <div class="avatar hint-${esc(a.art)}">${ICON[a.art] || '!'}</div>
      <div style="min-width:0"><div class="title">${esc(a.titel)}</div><div class="subtitle">${esc(a.text)}</div></div><div></div></div>`);
    const none = cur.find((c) => c.id === '0');
    if (none) {
      rows.push(`<a class="row plain" href="#/kategorien/0"><div class="avatar hint-kategorie">?</div>
        <div style="min-width:0"><div class="title">${money(none.value, code)} ohne Kategorie</div><div class="subtitle">Vorschläge zum Kategorisieren ansehen →</div></div><div></div></a>`);
    }
    for (const c of checks) {
      rows.push(`<a class="row plain" href="#/pruefen"><div class="avatar ${c.cls}">${esc(c.icon)}</div>
        <div style="min-width:0"><div class="title">${esc(c.title)}</div><div class="subtitle">${esc(c.sub)}</div></div><div></div></a>`);
    }
    if (!rows.length) {
      el.closest('.card').hidden = true;
      return;
    }
    el.innerHTML = `<div class="list">${rows.join('')}</div>`;
  }, skeleton(2));

  // Ziele je Kategorie (eigene Monatsbeträge, unabhängig von Firefly-Budgets)
  fill($('goals'), () => Promise.all([loadGoals(), cats, showForecast ? forecastRemainder('category', 'expense', period) : null]), (el, [goals, { code, cur }, remainder]) => {
    const entries = Object.entries(goals);
    if (!entries.length) {
      el.innerHTML = `<div class="empty">Noch keine Ziele. Lege auf der Seite einer Kategorie ein Monatsziel fest,
        z. B. <a href="#/kategorien">„Lebensmittel max. 500 €“</a>.</div>`;
      return;
    }
    const rows = entries.map(([id, g]) => {
      const value = cur.find((c) => c.id === id)?.value || 0;
      const fc = remainder ? value + remainder(id, code) : null;
      return { id, g, value, fc, st: goalStatus(value, g.amount, period, fc) };
    }).sort((a, b) => b.st.used - a.st.used);
    el.innerHTML = rows.map((r) => `<div class="goal-row"><a class="plain title" href="#/kategorien/${encodeURIComponent(r.id)}">${esc(r.g.name)}</a>
      <span class="muted goal-per">${money(r.g.amount, code)} / Monat</span>${goalBar(r.value, r.g.amount, period, code, r.fc)}</div>`).join('');
  }, skeleton(3));

  fill($('categories'), () => cats, (el, { code, cur }) => {
    const items = [...cur].sort((a, b) => b.value - a.value);
    if (!items.length) return (el.innerHTML = '<div class="empty">Keine Ausgaben im Zeitraum.</div>');
    const total = sum(items, (x) => x.value);
    const shown = items.slice(0, 8);
    const rest = items.slice(8);
    if (rest.length) shown.push({ name: `Weitere (${rest.length})`, value: sum(rest, (x) => x.value), rest: true });
    const max = Math.max(...shown.map((x) => x.value));
    el.innerHTML = `<div class="bars">${shown
      .map((c) => {
        const name = c.rest
          ? `<a href="#/kategorien" class="name">${esc(c.name)}</a>`
          : `<a href="#/kategorien/${encodeURIComponent(c.id)}" class="name" title="Kategorie analysieren">${esc(c.name)}</a>`;
        return `<div class="bar-row">${name}
          <div class="track"><div class="fill" style="width:${(c.value / max) * 100}%"></div></div>
          <div class="val">${money(c.value, code)}<small>${percent(c.value / total)}</small></div></div>`;
      })
      .join('')}</div>`;
  });

  fill($('changes'), () => cats, (el, { code, cur, prev }) => {
    const byId = new Map();
    cur.forEach((c) => byId.set(c.id, { ...c, prev: 0 }));
    prev.forEach((c) => (byId.has(c.id) ? (byId.get(c.id).prev = c.value) : byId.set(c.id, { ...c, value: 0, prev: c.value })));
    const items = [...byId.values()].filter((c) => c.value !== c.prev)
      .sort((a, b) => Math.abs(b.value - b.prev) - Math.abs(a.value - a.prev)).slice(0, 7);
    if (!items.length) return (el.innerHTML = '<div class="empty">Keine Vergleichsdaten.</div>');
    el.innerHTML = `<div class="list">${items
      .map((c) => `<a class="row plain" href="#/kategorien/${encodeURIComponent(c.id)}">
        <div class="avatar" style="--av:${nameColor(c.name)}">${esc(initials(c.name))}</div>
        <div style="min-width:0"><div class="title">${esc(c.name)}</div><div class="subtitle">${money(c.value, code)} statt ${money(c.prev, code)}</div></div>
        <div class="amount">${money(c.value - c.prev, code, { signed: true })}<div>${delta(c.value, c.prev, 'expense', code)}</div></div></a>`)
      .join('')}</div>`;
  });

  fill($('flow'), () => Promise.all([categoryTotals('income', start, end), categoryTotals('expense', start, end)]), (el, [inc, out]) => {
    const code = mainCurrency([...inc, ...out], 'code');
    sankey(el, {
      incomes: inc.filter((c) => c.code === code),
      expenses: out.filter((c) => c.code === code),
      code,
      onSelect: (n) => flowTransactions(panel, n, { start, end, code }),
    });
    el.insertAdjacentHTML('beforeend', '<div class="flow-tx"></div><div class="legend" style="margin-top:8px"><span>Block, Band oder Name anklicken zeigt die Buchungen dazu.</span></div>');
    const panel = el.querySelector('.flow-tx');
  }, skeleton(1, 300));

  if (showForecast) {
    const t1 = addDays(today(), 1);
    fill($('expected'), () => Promise.all([
      loadRecurring('expense'),
      loadRecurring('income'),
      forecastRemainder('category', 'expense', period),
    ]), (el, [rOut, rIn, remainder]) => {
      const fixedOut = upcomingBetween(rOut.items, t1, end);
      const fixedIn = upcomingBetween(rIn.items, t1, end);
      const code = mainCurrency([...fixedOut, ...remainder.items], 'code');
      // Variable Ausgaben = typischer Rest je Kategorie minus bereits erwartete Fixposten
      const fixedByCat = new Map();
      fixedOut.forEach((f) => fixedByCat.set(f.category, (fixedByCat.get(f.category) || 0) + f.amount));
      const variable = remainder.items
        .filter((c) => c.code === code)
        .map((c) => ({ ...c, value: Math.max(0, c.value - (fixedByCat.get(c.name) || 0)) }))
        .filter((c) => c.value >= 1)
        .sort((a, b) => b.value - a.value);
      const rows = [
        ...fixedIn.map((f) => ({ date: f.date, name: f.name, sub: `${f.rhythm.label} · ${f.category || 'Einnahme'}`, amount: f.amount, sign: 1, kind: 'wiederkehrend' })),
        ...fixedOut.map((f) => ({ date: f.date, name: f.name, sub: `${f.rhythm.label} · ${f.category || 'ohne Kategorie'}`, amount: f.amount, sign: -1, kind: 'wiederkehrend' })),
      ].sort((a, b) => a.date - b.date);
      const sumIn = sum(fixedIn, (f) => f.amount);
      const sumOut = sum(fixedOut, (f) => f.amount) + sum(variable, (v) => v.value);
      el.innerHTML = `
        <div class="legend" style="margin-bottom:10px"><span>Erwartete Einnahmen <b class="pos">&nbsp;${money(sumIn, code)}</b></span>
          <span>Erwartete Ausgaben <b>&nbsp;${money(sumOut, code)}</b></span><span>Saldo <b>&nbsp;${money(sumIn - sumOut, code, { signed: true })}</b></span></div>
        <div class="dist-grid">
          <div><h3 class="sub-h">Feste Termine <span class="muted">(aus wiederkehrenden Zahlungen)</span></h3>
            ${rows.length ? `<div class="list">${rows.map((r) => `<div class="row">
              <div class="avatar date-badge"><b>${r.date.getDate()}.</b><small>${r.date.toLocaleDateString('de-DE', { month: 'short' })}</small></div>
              <div style="min-width:0"><div class="title">${esc(r.name)}</div><div class="subtitle">${esc(r.sub)}</div></div>
              <div class="amount ${r.sign > 0 ? 'pos' : ''}">${money(r.sign * r.amount, code, { signed: r.sign > 0 })}</div></div>`).join('')}</div>`
              : '<div class="empty">Keine festen Termine mehr im Zeitraum.</div>'}</div>
          <div><h3 class="sub-h">Geschätzte weitere Ausgaben <span class="muted">(typischer Rest je Kategorie)</span></h3>
            ${variable.length ? `<div class="list">${variable.map((v) => `<a class="row plain" href="#/kategorien/${encodeURIComponent(v.id)}">
              <div class="avatar" style="--av:${nameColor(v.name)}">${esc(initials(v.name))}</div>
              <div style="min-width:0"><div class="title">${esc(v.name)}</div><div class="subtitle">Ø der letzten Perioden im selben Zeitraum</div></div>
              <div class="amount forecast">≈ ${money(-v.value, code)}</div></a>`).join('')}</div>`
              : '<div class="empty">Keine weiteren Ausgaben zu erwarten.</div>'}</div>
        </div>`;
    }, skeleton(5));
  }

  fill($('recent'), () => api.get('transactions', { start, end, type: 'all', limit: 10 }), (el, res) => {
    const rows = api.flattenTransactions(res.data).slice(0, 10);
    el.innerHTML = rows.length ? `<div class="list two-col">${rows.map(txRow).join('')}</div>` : '<div class="empty">Keine Buchungen im Zeitraum.</div>';
    bindTxDetails(el, (i) => rows[Number(i)]);
  });
}

// ---------------------------------------------------------------------------
// Buchungen

export async function transactions(view, { period, params }) {
  // von/bis in der Adresse (z. B. aus der Monatsmatrix) übersteuern den globalen Zeitraum
  const von = parseDate(params.get('von'));
  const bis = parseDate(params.get('bis'));
  const own = von && bis && von <= bis;
  if (own) period = { label: `${fmtDate(von)} – ${fmtDate(bis)}`, start: von, end: bis };
  const { start, end } = period;
  const state = { q: params.get('q') || '', type: params.get('type') || 'all', page: 1, rows: [], total: 0 };
  const TYPES = [
    ['all', 'Alle'],
    ['withdrawal', 'Ausgaben'],
    ['deposit', 'Einnahmen'],
    ['transfer', 'Umbuchungen'],
  ];

  view.innerHTML = `
    <section class="card">
      <div class="toolbar">
        <input class="input" id="tx-search" type="search" placeholder="Suchen … (z. B. REWE, amount_more:100)" value="${esc(state.q)}" aria-label="Buchungen durchsuchen">
        <select class="input select" id="tx-cat" aria-label="Kategorie"><option value="">Alle Kategorien</option></select>
        <div class="chips" role="group" aria-label="Buchungsart">
          ${TYPES.map(([id, label]) => `<button class="chip" data-type="${id}" aria-pressed="${id === state.type}">${label}</button>`).join('')}
        </div>
      </div>
      ${own ? `<div class="toolbar"><span class="chip" aria-pressed="true">Zeitraum ${esc(period.label)}<button class="chip-x" id="tx-range-x" aria-label="Zeitraum entfernen">✕</button></span></div>` : ''}
      <div class="legend" id="tx-summary" style="margin-bottom:12px"></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th class="pick-cell"><input type="checkbox" id="tx-pick-all" aria-label="Alle angezeigten auswählen" title="Alle angezeigten auswählen"></th><th class="hide-sm">Datum</th><th>Beschreibung</th><th class="hide-sm">Kategorie</th><th class="num">Betrag</th></tr></thead>
          <tbody id="tx-body"></tbody>
        </table>
      </div>
      <div class="more" id="tx-more"></div>
    </section>
    <div class="pick-bar" id="tx-pickbar" hidden></div>
    <div class="toast" id="tx-toast" role="status" hidden></div>`;

  const body = view.querySelector('#tx-body');
  const more = view.querySelector('#tx-more');
  const summaryEl = view.querySelector('#tx-summary');
  let token = 0;

  async function load(reset) {
    const my = ++token;
    if (reset) {
      state.page = 1;
      state.rows = [];
      body.innerHTML = `<tr><td colspan="5">${skeleton(6)}</td></tr>`;
    }
    more.innerHTML = '';
    try {
      let res;
      if (state.q.trim()) {
        const parts = [state.q.trim(), `date_after:${isoDate(start)}`, `date_before:${isoDate(end)}`];
        if (state.type !== 'all') parts.push(`type:${state.type}`);
        res = await api.get('search/transactions', { query: parts.join(' '), page: state.page, limit: 50, _alle: true });
      } else {
        res = await api.get('transactions', { start, end, type: state.type, page: state.page, limit: 50, _alle: true });
      }
      if (my !== token || !body.isConnected) return;
      const pag = res.meta?.pagination || {};
      state.total = pag.total ?? res.data.length;
      state.rows.push(...api.flattenTransactions(res.data));
      render(pag.current_page < pag.total_pages);
    } catch (err) {
      if (my === token) body.innerHTML = `<tr><td colspan="5"><div class="empty">Fehler: ${esc(err.message)}</div></td></tr>`;
    }
  }

  function render(hasMore) {
    if (!state.rows.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty">Keine Buchungen gefunden.</div></td></tr>';
      summaryEl.innerHTML = '';
      return;
    }
    const code = mainCurrency(state.rows);
    // ausgeblendete Buchungen stehen in der Liste (markiert), zählen aber nicht mit
    const counted = state.rows.filter((r) => !r.ffd_ausgeblendet && r.currency_code === code);
    const out = sum(counted.filter((r) => r.type === 'withdrawal'), (r) => r.amount);
    const inc = sum(counted.filter((r) => r.type === 'deposit'), (r) => r.amount);
    const hidden = state.rows.filter((r) => r.ffd_ausgeblendet).length;
    summaryEl.innerHTML = `<span><b>${state.total}</b>&nbsp;Buchungen · ${esc(period.label)}</span>
      ${inc ? `<span>Einnahmen <b class="pos">&nbsp;${money(inc, code)}</b></span>` : ''}
      ${out ? `<span>Ausgaben <b>&nbsp;${money(out, code)}</b></span>` : ''}
      ${hasMore ? `<span>(Summen der ${state.rows.length} geladenen)</span>` : ''}
      ${hidden ? `<span class="muted">${hidden} ausgeblendet (zählen nicht mit)</span>` : ''}`;
    body.innerHTML = state.rows
      .map((t, i) => `<tr ${txAttrs(i)}${t.ffd_ausgeblendet ? ' class="tx-hidden" title="Ausgeblendet – zählt nicht in Auswertungen"' : ''}>
        <td class="pick-cell"><input type="checkbox" data-txpick="${i}" ${picked.has(jid(t)) ? 'checked' : ''} aria-label="auswählen"></td>
        <td class="date hide-sm">${fmtDate(t.date)}</td>
        <td><div class="desc">${esc(t.description)}${t.ffd_ausgeblendet ? ' <span class="badge warn">ausgeblendet</span>' : ''}</div><div class="flow"><span class="show-sm">${fmtDate(t.date)} · </span>${esc(t.source_name)} → ${esc(t.destination_name)}</div>${t.notes ? `<div class="flow note">${esc(t.notes)}</div>` : ''}</td>
        <td class="hide-sm">${t.category_name ? `<span class="cat">${esc(t.category_name)}</span>` : ''}${(t.tags || []).map((x) => ` <span class="tag">${esc(x)}</span>`).join('')}</td>
        <td class="num">${signedAmount(t)}</td></tr>`)
      .join('');
    more.innerHTML = hasMore ? '<button class="btn" id="tx-load">Mehr laden</button>' : '';
    syncPickAll();
  }

  bindTxDetails(body, (i) => state.rows[Number(i)]);

  // ---- Auswahl und Sammelaktionen (Kategorie, Tag, Gruppe) ----------------------
  const jid = (t) => String(t.transaction_journal_id);
  const picked = new Map(); // Journal-ID → Buchung (bleibt bei „Mehr laden“ erhalten)
  const bar = view.querySelector('#tx-pickbar');
  const pickAll = view.querySelector('#tx-pick-all');
  let toastTimer;
  const toast = (msg) => {
    const el = view.querySelector('#tx-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  };
  const lists = Promise.all([
    api.getAll('categories').then((l) => l.map((c) => c.attributes.name)).catch(() => []),
    api.getAll('tags').then((l) => l.map((x) => x.attributes.tag)).catch(() => []),
  ]);
  function syncPickAll() {
    const shown = state.rows.length;
    const on = state.rows.filter((t) => picked.has(jid(t))).length;
    pickAll.checked = shown > 0 && on === shown;
    pickAll.indeterminate = on > 0 && on < shown;
  }
  async function renderBar() {
    syncPickAll();
    if (!picked.size) {
      bar.hidden = true;
      return;
    }
    const sel = [...picked.values()];
    const code = mainCurrency(sel);
    const [cats, tagList] = await lists;
    bar.hidden = false;
    bar.innerHTML = `<span><b>${picked.size}</b> ausgewählt · ${money(sum(sel.filter((t) => t.currency_code === code), (t) => t.amount), code)}</span>
      <form class="bar-form" data-bulk="cat"><input name="v" list="tx-bulk-cats" placeholder="Kategorie …" aria-label="Kategorie setzen" autocomplete="off"><button class="btn small">Setzen</button></form>
      <form class="bar-form" data-bulk="tag"><input name="v" list="tx-bulk-tags" placeholder="Tag …" aria-label="Tag hinzufügen" autocomplete="off"><button class="btn small">Hinzufügen</button></form>
      <button class="btn small primary" data-bulk-group>Als Gruppe ins Labor …</button>
      <button class="link-btn" data-bulk-clear>Auswahl aufheben</button>
      <datalist id="tx-bulk-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="tx-bulk-tags">${tagList.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
  }
  const clear = () => {
    picked.clear();
    body.querySelectorAll('[data-txpick]').forEach((x) => (x.checked = false));
    renderBar();
  };
  body.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-txpick]');
    if (!cb) return;
    const t = state.rows[Number(cb.dataset.txpick)];
    if (cb.checked) picked.set(jid(t), t);
    else picked.delete(jid(t));
    renderBar();
  });
  pickAll.addEventListener('change', () => {
    state.rows.forEach((t) => (pickAll.checked ? picked.set(jid(t), t) : picked.delete(jid(t))));
    body.querySelectorAll('[data-txpick]').forEach((x) => (x.checked = pickAll.checked));
    renderBar();
  });

  /** Kategorie setzen bzw. Tag hinzufügen – über die Automation „Kategorie übernehmen“ (n8n). */
  async function bulkSet(kind, value) {
    const action = await actionFor('categorize');
    if (!action) {
      toast('Dafür fehlt die Automation „Kategorie übernehmen“ (n8n-Vorlage firefly-buchung-bearbeiten.json) – siehe Automationen.');
      return;
    }
    const sel = [...picked.values()];
    const what = kind === 'cat' ? `die Kategorie „${value}“ setzen` : `den Tag „${value}“ hinzufügen`;
    if (!window.confirm(`Bei ${sel.length} Buchung${sel.length === 1 ? '' : 'en'} ${what}?\n\nDas ändert Daten in Firefly (über n8n).`)) return;
    toast(`Sende ${sel.length} Änderung${sel.length === 1 ? '' : 'en'} an n8n …`);
    const res = await runAction(action, {
      typ: 'kategorien_uebernehmen',
      aenderungen: sel.map((t) => ({
        transaction_group_id: t.groupId, transaction_journal_id: t.transaction_journal_id, datum: String(t.date).slice(0, 10),
        beschreibung: t.description, betrag: t.amount, kategorie_alt: t.category_name || null,
        ...(kind === 'cat' ? { kategorie: value } : { kategorie: null, tags: [...new Set([...(t.tags || []), value])] }),
      })),
    }).catch((err) => ({ ok: false, response: err.message }));
    if (!res.ok) {
      toast(`Fehler: ${res.status ? `HTTP ${res.status}` : res.response || 'fehlgeschlagen'}`);
      return;
    }
    // Anzeige gleich nachziehen
    sel.forEach((t) => {
      if (kind === 'cat') t.category_name = value;
      else t.tags = [...new Set([...(t.tags || []), value])];
    });
    clear();
    render(more.querySelector('#tx-load') !== null);
    toast(`Erledigt: ${sel.length} Buchung${sel.length === 1 ? '' : 'en'} in Firefly geändert.`);
  }

  /** Auswahl als Gruppe ins Labor – mit Verweisen, damit auch ältere Buchungen übertragbar bleiben. */
  async function bulkGroup() {
    const sel = [...picked.values()];
    const name = window.prompt('Name der Gruppe (Kategorie oder Tag – im Labor änderbar):', state.q.replace(/\w+_\w+:("[^"]*"|\S+)/g, '').trim().slice(0, 60));
    if (name === null) return;
    const basis = sel.every((t) => t.type === 'deposit') ? 'einnahmen' : 'ausgaben';
    const res = await fetch('/local/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' },
      body: JSON.stringify({
        name: name.trim() || 'Neue Gruppe',
        kind: 'category',
        include: sel.map(jid),
        refs: Object.fromEntries(sel.map((t) => [jid(t), String(t.groupId)])),
        source: `Suche „${state.q || 'alle Buchungen'}“ · ${period.label}`,
        basis,
      }),
    }).then((r) => r.json()).catch(() => null);
    if (!res?.id) {
      toast('Gruppe konnte nicht angelegt werden.');
      return;
    }
    location.hash = `#/labor?${new URLSearchParams({ ...(basis === 'einnahmen' ? { basis } : {}), gruppe: res.id })}`;
  }

  bar.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target.closest('[data-bulk]');
    const value = form?.v.value.trim();
    if (value) bulkSet(form.dataset.bulk, value);
  });
  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-bulk-clear]')) clear();
    else if (e.target.closest('[data-bulk-group]')) bulkGroup();
  });

  more.addEventListener('click', (e) => {
    if (e.target.id !== 'tx-load') return;
    state.page += 1;
    e.target.disabled = true;
    e.target.textContent = 'Lade …';
    load(false);
  });

  view.querySelector('#tx-range-x')?.addEventListener('click', () => {
    const qs = new URLSearchParams();
    if (state.q) qs.set('q', state.q);
    if (state.type !== 'all') qs.set('type', state.type);
    location.hash = `#/buchungen${qs.toString() ? `?${qs}` : ''}`;
  });

  const syncHash = () => {
    const qs = new URLSearchParams();
    if (state.q) qs.set('q', state.q);
    if (state.type !== 'all') qs.set('type', state.type);
    if (own) {
      qs.set('von', isoDate(von));
      qs.set('bis', isoDate(bis));
    }
    const hash = `#/buchungen${qs.toString() ? `?${qs}` : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  };

  // Kategorie-Auswahl setzt einfach den passenden Suchbefehl
  const catSelect = view.querySelector('#tx-cat');
  const searchInput = view.querySelector('#tx-search');
  const catQuery = (name) => (name === NO_CAT ? 'has_no_category:true' : `category_is:"${name}"`);
  const NO_CAT = '__ohne__';
  const syncSelect = () => {
    const match = [...catSelect.options].find((o) => o.value && catQuery(o.value) === state.q.trim());
    catSelect.value = match ? match.value : '';
  };
  api.getAll('categories').then((list) => {
    const names = list.map((c) => c.attributes.name).sort((a, b) => a.localeCompare(b, 'de'));
    catSelect.insertAdjacentHTML('beforeend',
      `<option value="${NO_CAT}">Ohne Kategorie</option>${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`);
    syncSelect();
  }).catch(() => catSelect.remove());
  catSelect.addEventListener('change', () => {
    state.q = catSelect.value ? catQuery(catSelect.value) : '';
    searchInput.value = state.q;
    syncHash();
    load(true);
  });

  searchInput.addEventListener('input', debounce((e) => {
    state.q = e.target.value;
    syncSelect();
    syncHash();
    load(true);
  }, 350));

  view.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.type = chip.dataset.type;
      view.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      syncHash();
      load(true);
    }));

  load(true);
}

// ---------------------------------------------------------------------------
// Konten

export const ROLE = {
  defaultAsset: 'Girokonto',
  sharedAsset: 'Gemeinschaftskonto',
  savingAsset: 'Sparkonto',
  ccAsset: 'Kreditkarte',
  cashWalletAsset: 'Bargeld',
};

const LIABILITY = { loan: 'Kredit', debt: 'Schulden', mortgage: 'Hypothek' };

export async function accounts(view, { period }) {
  const { start, end } = period;
  view.innerHTML = `
    <div class="grid">
      ${card('acc-chart', 'Kontostand-Verlauf', { meta: esc(period.label) })}
      <div class="span-12" id="acc-tiles"></div>
      ${card('acc-worth', 'Vermögensverlauf', { meta: '<span class="chips small" id="acc-worth-range" role="group" aria-label="Zeitraum"></span>' })}
      <div class="span-12" id="acc-liab"></div>
    </div>`;

  const accountsP = api.getAll('accounts', { type: 'asset' });
  const order = new Map();

  await fill(view.querySelector('#acc-tiles'), () => accountsP, (el, list) => {
    const active = list.filter((a) => a.attributes.active !== false);
    active.forEach((a, i) => order.set(a.attributes.name, i));
    const code = mainCurrency(active.map((a) => a.attributes));
    const total = sum(active.filter((a) => a.attributes.currency_code === code), (a) => Number(a.attributes.current_balance));
    el.innerHTML = `<div class="tiles">
      <section class="card tile"><span class="kind">Summe aller Konten</span><span class="balance">${money(total, code)}</span><span class="iban">${active.length} aktive Konten</span></section>
      ${active.map((a, i) => {
        const at = a.attributes;
        return `<a class="card tile link-tile" href="#/konten/${encodeURIComponent(a.id)}">
          <span class="kind"><i class="swatch" style="background:${seriesColor(i)}"></i>${esc(ROLE[at.account_role] || 'Konto')}</span>
          <span class="name">${esc(at.name)}</span>
          <span class="balance">${money(at.current_balance, at.currency_code)}</span>
          <span class="iban">${esc(at.iban || at.account_number || '')}</span>
          <span class="tile-go">Buchungen →</span>
        </a>`;
      }).join('')}
    </div>`;
  }, `<div class="tiles"><section class="card tile">${skeleton(3)}</section></div>`);

  const chartEnd = end > today() ? today() : end;
  fill(view.querySelector('#acc-chart'), () => api.get('chart/account/overview', { start, end: chartEnd, period: '1D' }), (el, sets) => {
    const datasets = (Array.isArray(sets) ? sets : []).filter((s) => s.entries);
    if (!datasets.length) return (el.innerHTML = '<div class="empty">Keine Verlaufsdaten.</div>');
    const entries = (s) =>
      Array.isArray(s.entries) ? s.entries.map((e) => [e.key ?? e.date, e.value]) : Object.entries(s.entries);
    let labels = entries(datasets[0]).map(([k]) => k);
    // Für lange Zeiträume ausdünnen, damit die Linie ruhig bleibt
    const step = Math.max(1, Math.ceil(labels.length / 120));
    const keep = (_, i, arr) => i % step === 0 || i === arr.length - 1;
    labels = labels.filter(keep);
    const series = datasets.map((s, i) => ({
      label: s.label,
      data: entries(s).filter(keep).map(([, v]) => Number(v)),
      color: seriesColor(order.has(s.label) ? order.get(s.label) : i),
    }));
    el.innerHTML = `${legend(series)}<div class="chart-box tall" style="margin-top:12px"><canvas aria-label="Kontostände über die Zeit"></canvas></div>`;
    lineChart(el.querySelector('canvas'), { labels, series, currency: datasets[0].currency_code || 'EUR' });
  }, skeleton(1, 340));

  netWorth(view.querySelector('#acc-worth'), order);

  fill(view.querySelector('#acc-liab'), () => api.getAll('accounts', { type: 'liabilities' }).catch(() => []), (el, list) => {
    const active = list.filter((a) => a.attributes.active !== false);
    if (!active.length) return (el.innerHTML = '');
    el.innerHTML = `<h2 style="font-size:15px;margin:8px 0 12px">Verbindlichkeiten</h2><div class="tiles">${active
      .map((a) => {
        const at = a.attributes;
        return `<a class="card tile link-tile" href="#/konten/${encodeURIComponent(a.id)}"><span class="kind">${esc(LIABILITY[at.liability_type] || 'Verbindlichkeit')}</span>
          <span class="name">${esc(at.name)}</span><span class="balance">${money(at.current_balance, at.currency_code)}</span>
          <span class="iban">${at.interest ? `${esc(at.interest)} % Zinsen` : ''}</span></a>`;
      })
      .join('')}</div>`;
  }, '');
}

/**
 * Buchungen zu einem Block des Geldflusses (Einnahme- oder Ausgabenkategorie,
 * „Sonstige“) – mit Details, Sortierung und Sprüngen zur Analyse und ins Labor.
 */
async function flowTransactions(panel, n, { start, end, code }) {
  if (!n) return (panel.innerHTML = '');
  if (n.kind === 'saved' || n.kind === 'reserve') {
    panel.innerHTML = `<div class="flow-panel"><h3>${esc(n.name)} · ${money(n.value, code)}</h3>
      <p class="muted small-text">${n.kind === 'saved' ? 'Was von den Einnahmen übrig blieb (Einnahmen − Ausgaben)' : 'Was mehr ausgegeben als eingenommen wurde'} – das ist ein Saldo, keine einzelne Buchung.
      Umbuchungen aufs Sparkonto siehst du unter <a href="#/konten">Konten</a>.</p></div>`;
    return;
  }
  const type = n.kind === 'in' ? 'deposit' : 'withdrawal';
  const ids = new Set((n.rest ? n.items : [n]).map((x) => String(x.id)));
  panel.innerHTML = `<div class="flow-panel">${skeleton(3)}</div>`;
  let list;
  try {
    list = api.flattenTransactions(await api.getAll('transactions', { start, end, type }))
      .filter((t) => t.type === type && ids.has(t.category_id ? String(t.category_id) : '0'));
  } catch (err) {
    panel.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
    return;
  }
  if (!panel.isConnected) return;
  const total = sum(list.filter((t) => t.currency_code === code), (t) => t.amount);
  const basis = n.kind === 'in' ? 'einnahmen' : 'ausgaben';
  const lab = `#/labor?${new URLSearchParams({ basis, von: isoDate(start), bis: isoDate(end > today() ? today() : end), ...(n.rest ? {} : { kategorie: n.name }) })}`;
  const analysis = !n.rest ? `#/kategorien/${encodeURIComponent(n.id)}${n.kind === 'in' ? '?art=einnahmen' : ''}` : null;
  let order = 'amount';
  const draw = () => {
    const rows = [...list].sort((a, b) => (order === 'date' ? String(b.date).localeCompare(String(a.date)) : b.amount - a.amount));
    panel.innerHTML = `<div class="flow-panel">
      <div class="flow-panel-head"><h3>${esc(n.name)} · ${list.length} Buchung${list.length === 1 ? '' : 'en'} · ${money(total, code)}</h3>
        <span class="links"><button class="link-btn" data-order="amount" aria-pressed="${order === 'amount'}">Größte</button> · <button class="link-btn" data-order="date" aria-pressed="${order === 'date'}">Neueste</button>
        ${analysis ? ` · <a href="${analysis}">Kategorie-Analyse →</a>` : ''} · <a href="${lab}">Im Labor bearbeiten →</a></span></div>
      ${rows.length ? `<div class="table-wrap scroll"><table><tbody>${rows.map((t, i) => `<tr ${txAttrs(i)}>
          <td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(n.kind === 'in' ? t.source_name : t.destination_name)}${n.rest ? ` · ${esc(t.category_name || 'Ohne Kategorie')}` : ''}</div></td>
          <td class="num">${signedAmount(t)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Keine einzelnen Buchungen gefunden.</div>'}
    </div>`;
    bindTxDetails(panel, (i) => rows[Number(i)]);
  };
  panel.onclick = (e) => {
    const b = e.target.closest('[data-order]');
    if (!b) return;
    order = b.dataset.order;
    draw();
  };
  draw();
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Vermögensverlauf: Summe aller Konten über Jahre (Monatsendstände)

const WORTH_RANGES = [['1', '1 Jahr'], ['2', '2 Jahre'], ['5', '5 Jahre'], ['10', '10 Jahre']];

function netWorth(el, order) {
  if (!el) return;
  const rangeEl = el.closest('.card').querySelector('#acc-worth-range');
  let years = storage('ffd-worth-range', '2');
  const draw = () => {
    rangeEl.innerHTML = WORTH_RANGES.map(([k, l]) => `<button class="chip" data-y="${k}" aria-pressed="${k === years}">${l}</button>`).join('');
    const end = today();
    const start = new Date(end.getFullYear() - Number(years), end.getMonth() + 1, 1);
    fill(el, () => api.get('chart/account/overview', { start, end, period: '1M' }), (box, sets) => {
      const datasets = (Array.isArray(sets) ? sets : []).filter((s) => s.entries);
      if (!datasets.length) return (box.innerHTML = '<div class="empty">Keine Verlaufsdaten.</div>');
      const entries = (s) => (Array.isArray(s.entries) ? s.entries.map((e) => [e.key ?? e.date, e.value]) : Object.entries(s.entries));
      // je Monat der letzte Stand – egal ob Firefly Tages- oder Monatswerte liefert
      const monthly = (s) => {
        const m = new Map();
        for (const [k, v] of entries(s)) m.set(String(k).slice(0, 7), Number(v));
        return m;
      };
      const perAccount = datasets.map(monthly);
      const keys = [...new Set(perAccount.flatMap((m) => [...m.keys()]))].sort();
      const value = (m, k) => {
        // fehlende Monate mit dem letzten bekannten Stand füllen
        let v = 0;
        for (const key of keys) {
          if (m.has(key)) v = m.get(key);
          if (key === k) return v;
        }
        return v;
      };
      const totals = keys.map((k) => sum(perAccount, (m) => value(m, k)));
      // Monate ohne Bewegung am Anfang abschneiden (vor dem ersten Konto/der ersten Buchung)
      const moved = totals.findIndex((v, i) => i + 1 < totals.length && v !== totals[i + 1]);
      const firstIdx = Math.max(0, moved);
      const ks = keys.slice(firstIdx);
      const tot = totals.slice(firstIdx);
      const code = datasets[0].currency_code || 'EUR';
      const label = (k) => fmtMonth(new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1));
      const series = [
        { label: 'Gesamt', data: tot, color: cssVar('--text-primary') },
        ...datasets.map((s, i) => ({ label: s.label, data: ks.map((k) => value(perAccount[i], k)), color: seriesColor(order.has(s.label) ? order.get(s.label) : i) })),
      ];
      const change = tot.length ? tot[tot.length - 1] - tot[0] : 0;
      const months = Math.max(1, tot.length - 1);
      const max = Math.max(...tot);
      box.innerHTML = `<div class="legend worth-stats">
          <span>Heute <b>&nbsp;${money(tot[tot.length - 1] ?? 0, code)}</b></span>
          <span>Veränderung <b class="${change >= 0 ? 'pos' : 'neg'}">&nbsp;${money(change, code, { signed: true })}</b>&nbsp;seit ${esc(label(ks[0] || ''))}</span>
          <span>Ø pro Monat <b>&nbsp;${money(change / months, code, { signed: true })}</b></span>
          <span>Höchststand <b>&nbsp;${money(max, code)}</b>&nbsp;(${esc(label(ks[tot.indexOf(max)] || ''))})</span>
        </div>
        ${legend(series)}<div class="chart-box tall" style="margin-top:12px"><canvas aria-label="Vermögen über die Zeit"></canvas></div>
        <div class="legend" style="margin-top:8px"><span>Monatsendstände aller Konten, die Firefly in der Kontenübersicht zeigt; Verbindlichkeiten nicht abgezogen.</span></div>`;
      lineChart(box.querySelector('canvas'), { labels: ks.map((k) => `${k}-01`), series, currency: code, format: fmtMonth });
    }, skeleton(1, 340));
  };
  rangeEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-y]');
    if (!btn) return;
    years = btn.dataset.y;
    store('ffd-worth-range', years);
    draw();
  });
  draw();
}

// ---------------------------------------------------------------------------
// Budgets

