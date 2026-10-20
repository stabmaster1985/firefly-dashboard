// Übersicht, Buchungen und Konten.

import * as api from './api.js';
import { barChart, lineChart, legend, seriesColor } from './charts.js';
import { money, percent, esc, fmtDate, initials, isoDate, today, debounce, parseDate, addDays, CALENDAR } from './util.js';
import { skeleton, fill, card, stat, signedAmount, txRow, txAttrs, bindTxDetails, mainCurrency, sum } from './common.js';
import { categoryTotals, compareRange, delta, forecastActive, forecastTotal, forecastRemainder } from './categories.js';
import { loadRecurring, upcomingBetween } from './recurring.js';
import { sankey } from './dist.js';
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

  // summary/basic ist Fireflys teuerste Abfrage – nur noch einmal für den Zeitraum
  // (Nettovermögen); Vergleich und Monatsverlauf über die leichten Summen-Endpunkte.
  const summary = api.get('summary/basic', { start, end });
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
      .map((a) => {
        const at = a.attributes;
        return `<a class="row plain" href="#/konten/${encodeURIComponent(a.id)}"><div class="avatar">${esc(initials(at.name))}</div>
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
  fill($('hints'), () => Promise.all([fetch('/local/alerts').then((r) => r.json()).catch(() => ({ alerts: [] })), cats]), (el, [res, { code, cur }]) => {
    const ICON = { grosse_buchung: '€', preisaenderung: '±', ausgeblieben: '?' };
    const rows = (res.alerts || []).slice(0, 5).map((a) => `<div class="row">
      <div class="avatar hint-${esc(a.art)}">${ICON[a.art] || '!'}</div>
      <div style="min-width:0"><div class="title">${esc(a.titel)}</div><div class="subtitle">${esc(a.text)}</div></div><div></div></div>`);
    const none = cur.find((c) => c.id === '0');
    if (none) {
      rows.push(`<a class="row plain" href="#/kategorien/0"><div class="avatar hint-kategorie">?</div>
        <div style="min-width:0"><div class="title">${money(none.value, code)} ohne Kategorie</div><div class="subtitle">Vorschläge zum Kategorisieren ansehen →</div></div><div></div></a>`);
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
        <div class="avatar">${esc(initials(c.name))}</div>
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
      hrefFor: (n) => `#/kategorien/${encodeURIComponent(n.id)}`,
    });
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
              <div class="avatar">${esc(initials(v.name))}</div>
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
        <input class="input" id="tx-search" type="search" placeholder="Suchen … (z. B. REWE, category_is:&quot;Lebensmittel&quot;, amount_more:100)" value="${esc(state.q)}" aria-label="Buchungen durchsuchen">
        <select class="input select" id="tx-cat" aria-label="Kategorie"><option value="">Alle Kategorien</option></select>
        <div class="chips" role="group" aria-label="Buchungsart">
          ${TYPES.map(([id, label]) => `<button class="chip" data-type="${id}" aria-pressed="${id === state.type}">${label}</button>`).join('')}
        </div>
      </div>
      ${own ? `<div class="toolbar"><span class="chip" aria-pressed="true">Zeitraum ${esc(period.label)}<button class="chip-x" id="tx-range-x" aria-label="Zeitraum entfernen">✕</button></span></div>` : ''}
      <div class="legend" id="tx-summary" style="margin-bottom:12px"></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Datum</th><th>Beschreibung</th><th class="hide-sm">Kategorie</th><th class="num">Betrag</th></tr></thead>
          <tbody id="tx-body"></tbody>
        </table>
      </div>
      <div class="more" id="tx-more"></div>
    </section>`;

  const body = view.querySelector('#tx-body');
  const more = view.querySelector('#tx-more');
  const summaryEl = view.querySelector('#tx-summary');
  let token = 0;

  async function load(reset) {
    const my = ++token;
    if (reset) {
      state.page = 1;
      state.rows = [];
      body.innerHTML = `<tr><td colspan="4">${skeleton(6)}</td></tr>`;
    }
    more.innerHTML = '';
    try {
      let res;
      if (state.q.trim()) {
        const parts = [state.q.trim(), `date_after:${isoDate(start)}`, `date_before:${isoDate(end)}`];
        if (state.type !== 'all') parts.push(`type:${state.type}`);
        res = await api.get('search/transactions', { query: parts.join(' '), page: state.page, limit: 50 });
      } else {
        res = await api.get('transactions', { start, end, type: state.type, page: state.page, limit: 50 });
      }
      if (my !== token || !body.isConnected) return;
      const pag = res.meta?.pagination || {};
      state.total = pag.total ?? res.data.length;
      state.rows.push(...api.flattenTransactions(res.data));
      render(pag.current_page < pag.total_pages);
    } catch (err) {
      if (my === token) body.innerHTML = `<tr><td colspan="4"><div class="empty">Fehler: ${esc(err.message)}</div></td></tr>`;
    }
  }

  function render(hasMore) {
    if (!state.rows.length) {
      body.innerHTML = '<tr><td colspan="4"><div class="empty">Keine Buchungen gefunden.</div></td></tr>';
      summaryEl.innerHTML = '';
      return;
    }
    const code = mainCurrency(state.rows);
    const out = sum(state.rows.filter((r) => r.type === 'withdrawal' && r.currency_code === code), (r) => r.amount);
    const inc = sum(state.rows.filter((r) => r.type === 'deposit' && r.currency_code === code), (r) => r.amount);
    summaryEl.innerHTML = `<span><b>${state.total}</b>&nbsp;Buchungen · ${esc(period.label)}</span>
      ${inc ? `<span>Einnahmen <b class="pos">&nbsp;${money(inc, code)}</b></span>` : ''}
      ${out ? `<span>Ausgaben <b>&nbsp;${money(out, code)}</b></span>` : ''}
      ${hasMore ? `<span>(Summen der ${state.rows.length} geladenen)</span>` : ''}`;
    body.innerHTML = state.rows
      .map((t, i) => `<tr ${txAttrs(i)}>
        <td class="date">${fmtDate(t.date)}</td>
        <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(t.source_name)} → ${esc(t.destination_name)}</div></td>
        <td class="hide-sm">${t.category_name ? `<span class="cat">${esc(t.category_name)}</span>` : ''}</td>
        <td class="num">${signedAmount(t)}</td></tr>`)
      .join('');
    more.innerHTML = hasMore ? '<button class="btn" id="tx-load">Mehr laden</button>' : '';
  }

  bindTxDetails(body, (i) => state.rows[Number(i)]);

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

// ---------------------------------------------------------------------------
// Budgets

