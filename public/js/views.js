// Übersicht, Buchungen und Konten.

import * as api from './api.js';
import { barChart, lineChart, legend, seriesColor } from './charts.js';
import { money, percent, esc, fmtDate, initials, isoDate, today, startOfMonth, endOfMonth, debounce } from './util.js';
import { skeleton, fill, card, stat, signedAmount, txRow, mainCurrency, sum } from './common.js';
import { categoryTotals, previousRange, delta } from './categories.js';

export async function overview(view, { period }) {
  const { start, end } = period;
  const [prevStart, prevEnd] = previousRange(period);
  view.innerHTML = `
    <div class="grid">
      <section class="card span-3" id="s-networth"></section>
      <section class="card span-3" id="s-earned"></section>
      <section class="card span-3" id="s-spent"></section>
      <section class="card span-3" id="s-balance"></section>
      ${card('cashflow', 'Einnahmen & Ausgaben', { span: 'span-8', meta: 'letzte 12 Monate' })}
      ${card('accounts', 'Konten', { span: 'span-4', link: '<a href="#/konten">Alle →</a>' })}
      ${card('categories', 'Ausgaben nach Kategorie', { span: 'span-6', link: '<a href="#/kategorien">Analyse →</a>' })}
      ${card('changes', 'Größte Veränderungen', { span: 'span-6', meta: `ggü. ${fmtDate(prevStart, { day: 'numeric', month: 'short' })} – ${fmtDate(prevEnd, { day: 'numeric', month: 'short' })}` })}
      ${card('recent', 'Letzte Buchungen', { span: 'span-12', link: '<a href="#/buchungen">Alle →</a>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  const summary = api.get('summary/basic', { start, end });
  const prevSummary = api.get('summary/basic', { start: prevStart, end: prevEnd }).catch(() => null);
  const both = Promise.all([summary, prevSummary]);
  const tile = (id, render) => fill($(id), () => both, render, skeleton(2, 22));
  const prevOf = (prev, key, code) => (prev ? api.summaryValues(prev, key).find((v) => v.code === code)?.value || 0 : 0);

  tile('s-networth', (el, [s]) => {
    const [main, ...rest] = api.summaryValues(s, 'net-worth');
    el.innerHTML = stat('Nettovermögen', money(main?.value, main?.code), rest.map((r) => money(r.value, r.code)).join(' · ') || `Stand ${fmtDate(end > today() ? today() : end)}`);
  });
  tile('s-earned', (el, [s, prev]) => {
    const [main] = api.summaryValues(s, 'earned');
    const cur = main?.value || 0;
    el.innerHTML = stat('Einnahmen', `<span class="pos">${money(cur, main?.code)}</span>`, `${delta(cur, prevOf(prev, 'earned', main?.code), 'income', main?.code)} ggü. Vorperiode`);
  });
  tile('s-spent', (el, [s, prev]) => {
    const [main] = api.summaryValues(s, 'spent');
    const cur = Math.abs(main?.value || 0);
    el.innerHTML = stat('Ausgaben', money(cur, main?.code), `${delta(cur, Math.abs(prevOf(prev, 'spent', main?.code)), 'expense', main?.code)} ggü. Vorperiode`);
  });
  tile('s-balance', (el, [s]) => {
    const [bal] = api.summaryValues(s, 'balance');
    const [earned] = api.summaryValues(s, 'earned');
    const rate = earned?.value > 0 ? bal.value / earned.value : null;
    const cls = (bal?.value || 0) >= 0 ? 'up' : 'down';
    el.innerHTML = stat('Saldo', money(bal?.value, bal?.code, { signed: true }),
      rate === null ? 'Einnahmen − Ausgaben' : `Sparquote <span class="${cls}">${percent(rate)}</span>`);
  });

  // Cashflow der letzten 12 Monate (bis zum Ende des gewählten Zeitraums)
  const ref = end > today() ? today() : end;
  const months = Array.from({ length: 12 }, (_, i) => [startOfMonth(ref, i - 11), endOfMonth(ref, i - 11)]);
  fill($('cashflow'), () => Promise.all(months.map(([s, e]) => api.get('summary/basic', { start: s, end: e }))), (el, sums) => {
    const code = api.summaryValues(sums.at(-1), 'earned')[0]?.code || api.summaryValues(sums.at(-1), 'spent')[0]?.code || 'EUR';
    const pick = (s, p) => api.summaryValues(s, p).find((v) => v.code === code)?.value || 0;
    const series = [
      { label: 'Einnahmen', data: sums.map((s) => pick(s, 'earned')), color: seriesColor(0) },
      { label: 'Ausgaben', data: sums.map((s) => Math.abs(pick(s, 'spent'))), color: seriesColor(1) },
    ];
    const totalIn = sum(series[0].data, (x) => x);
    const totalOut = sum(series[1].data, (x) => x);
    el.innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Einnahmen und Ausgaben je Monat"></canvas></div>
      <div class="legend" style="margin-top:12px">
        <span>Ø Einnahmen <b>&nbsp;${money(totalIn / 12, code)}</b></span>
        <span>Ø Ausgaben <b>&nbsp;${money(totalOut / 12, code)}</b></span>
        <span>Ø Sparquote <b>&nbsp;${totalIn ? percent((totalIn - totalOut) / totalIn) : '–'}</b></span>
      </div>`;
    barChart(el.querySelector('canvas'), { labels: months.map(([s]) => s), series, currency: code });
  }, skeleton(1, 280));

  fill($('accounts'), () => api.getAll('accounts', { type: 'asset' }), (el, accounts) => {
    const list = accounts.filter((a) => a.attributes.active !== false);
    if (!list.length) return (el.innerHTML = '<div class="empty">Keine Konten gefunden.</div>');
    el.innerHTML = `<div class="list">${list
      .map((a) => {
        const at = a.attributes;
        return `<div class="row"><div class="avatar">${esc(initials(at.name))}</div>
          <div style="min-width:0"><div class="title">${esc(at.name)}</div><div class="subtitle">${esc(ROLE[at.account_role] || 'Konto')}</div></div>
          <div class="amount">${money(at.current_balance, at.currency_code)}</div></div>`;
      })
      .join('')}</div>`;
  });

  const cats = Promise.all([categoryTotals('expense', start, end), categoryTotals('expense', prevStart, prevEnd)]).then(([cur, prev]) => {
    const code = mainCurrency(cur.length ? cur : prev, 'code');
    return { code, cur: cur.filter((c) => c.code === code), prev: prev.filter((c) => c.code === code) };
  });

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

  fill($('recent'), () => api.get('transactions', { start, end, type: 'all', limit: 10 }), (el, res) => {
    const rows = api.flattenTransactions(res.data).slice(0, 10);
    el.innerHTML = rows.length ? `<div class="list two-col">${rows.map(txRow).join('')}</div>` : '<div class="empty">Keine Buchungen im Zeitraum.</div>';
  });
}

// ---------------------------------------------------------------------------
// Buchungen

export async function transactions(view, { period, params }) {
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
      .map((t, i) => `<tr data-i="${i}">
        <td class="date">${fmtDate(t.date)}</td>
        <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(t.source_name)} → ${esc(t.destination_name)}</div></td>
        <td class="hide-sm">${t.category_name ? `<span class="cat">${esc(t.category_name)}</span>` : ''}</td>
        <td class="num">${signedAmount(t)}</td></tr>`)
      .join('');
    more.innerHTML = hasMore ? '<button class="btn" id="tx-load">Mehr laden</button>' : '';
  }

  function details(t) {
    const fields = [
      ['Von', t.source_name],
      ['An', t.destination_name],
      ['Budget', t.budget_name],
      ['Kategorie', t.category_name],
      ['Rechnung', t.bill_name],
      ['Fremdwährung', t.foreign_amount ? money(t.foreign_amount, t.foreign_currency_code) : null],
      ['Notizen', t.notes],
      ['Gruppe', t.groupTitle],
    ].filter(([, v]) => v);
    const tags = (t.tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('');
    const link = window.FFD_CONFIG?.fireflyUrl
      ? `<a href="${esc(window.FFD_CONFIG.fireflyUrl)}/transactions/show/${encodeURIComponent(t.groupId)}" target="_blank" rel="noopener">In Firefly öffnen ↗</a>`
      : '';
    return `<tr class="details"><td colspan="4"><dl>
      ${fields.map(([k, v]) => `<dt>${k}</dt><dd>${k === 'Fremdwährung' ? v : esc(v)}</dd>`).join('')}
      ${tags ? `<dt>Tags</dt><dd>${tags}</dd>` : ''}
      ${link ? `<dt></dt><dd>${link}</dd>` : ''}
    </dl></td></tr>`;
  }

  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr || e.target.closest('a')) return;
    if (tr.nextElementSibling?.classList.contains('details')) return tr.nextElementSibling.remove();
    tr.insertAdjacentHTML('afterend', details(state.rows[Number(tr.dataset.i)]));
  });

  more.addEventListener('click', (e) => {
    if (e.target.id !== 'tx-load') return;
    state.page += 1;
    e.target.disabled = true;
    e.target.textContent = 'Lade …';
    load(false);
  });

  const syncHash = () => {
    const qs = new URLSearchParams();
    if (state.q) qs.set('q', state.q);
    if (state.type !== 'all') qs.set('type', state.type);
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

const ROLE = {
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
        return `<section class="card tile">
          <span class="kind"><i class="swatch" style="background:${seriesColor(i)}"></i>${esc(ROLE[at.account_role] || 'Konto')}</span>
          <span class="name">${esc(at.name)}</span>
          <span class="balance">${money(at.current_balance, at.currency_code)}</span>
          <span class="iban">${esc(at.iban || at.account_number || '')}</span>
        </section>`;
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
        return `<section class="card tile"><span class="kind">${esc(LIABILITY[at.liability_type] || 'Verbindlichkeit')}</span>
          <span class="name">${esc(at.name)}</span><span class="balance">${money(at.current_balance, at.currency_code)}</span>
          <span class="iban">${at.interest ? `${esc(at.interest)} % Zinsen` : ''}</span></section>`;
      })
      .join('')}</div>`;
  }, '');
}

// ---------------------------------------------------------------------------
// Budgets

