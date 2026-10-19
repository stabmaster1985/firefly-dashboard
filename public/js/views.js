// Die einzelnen Seiten des Dashboards.

import * as api from './api.js';
import { barChart, lineChart, legend, seriesColor } from './charts.js';
import {
  money, percent, esc, fmtDate, fmtDateShort, initials, isoDate, today, addDays,
  startOfMonth, endOfMonth, parseDate, elapsedShare, debounce,
} from './util.js';

// ---------------------------------------------------------------------------
// Bausteine

const ICONS = {
  transfer: '<svg viewBox="0 0 24 24"><path d="M7 7h13M7 7l3-3M7 7l3 3M17 17H4m13 0-3-3m3 3-3 3"/></svg>',
};

const skeleton = (lines = 3, height = 18) =>
  Array.from({ length: lines }, () => `<div class="skeleton" style="height:${height}px;margin:10px 0"></div>`).join('');

/** Lädt Daten für einen Bereich und zeigt bis dahin einen Platzhalter. */
async function fill(slot, loader, render, placeholder = skeleton()) {
  if (!slot) return;
  slot.innerHTML = placeholder;
  try {
    const data = await loader();
    if (slot.isConnected) render(slot, data);
  } catch (err) {
    console.error(err);
    if (slot.isConnected) slot.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
  }
}

const card = (id, title, { span = 'span-12', link = '', meta = '' } = {}) => `
  <section class="card ${span}">
    <div class="card-head"><h2>${esc(title)}</h2>${link}${meta ? `<span class="meta">${meta}</span>` : ''}</div>
    <div id="${id}"></div>
  </section>`;

const stat = (label, value, sub = '') => `
  <div class="stat"><span class="label">${esc(label)}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;

function counterparty(t) {
  if (t.type === 'deposit') return t.source_name;
  if (t.type === 'transfer') return `${t.source_name} → ${t.destination_name}`;
  return t.destination_name;
}

function signedAmount(t) {
  const code = t.currency_code;
  if (t.type === 'withdrawal') return `<span class="neg">${money(-t.amount, code)}</span>`;
  if (t.type === 'deposit') return `<span class="pos">${money(t.amount, code, { signed: true })}</span>`;
  return `<span class="neutral">${money(t.amount, code)}</span>`;
}

function txRow(t) {
  const avatar = t.type === 'transfer' ? ICONS.transfer : esc(initials(counterparty(t)));
  const sub = [fmtDateShort(t.date), t.category_name || counterparty(t)].filter(Boolean).map(esc).join(' · ');
  return `<div class="row">
    <div class="avatar">${avatar}</div>
    <div style="min-width:0"><div class="title">${esc(t.description)}</div><div class="subtitle">${sub}</div></div>
    <div class="amount">${signedAmount(t)}</div>
  </div>`;
}

/** Liefert die häufigste Währung einer Liste – für Mehrwährungs-Daten. */
function mainCurrency(items, key = 'currency_code') {
  const counts = new Map();
  for (const it of items) counts.set(it[key], (counts.get(it[key]) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
}

const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);

// ---------------------------------------------------------------------------
// Datenaufbereitung

async function loadBudgets(start, end) {
  const [budgets, limits, spentInsight] = await Promise.all([
    api.getAll('budgets', { start, end }),
    api.getAll('budget-limits', { start, end }),
    api.get('insight/expense/budget', { start, end }),
  ]);
  return budgets
    .filter((b) => b.attributes.active !== false)
    .map((b) => {
      const own = limits.filter((l) => String(l.attributes.budget_id) === String(b.id));
      const spentRows = (spentInsight || []).filter((x) => String(x.id) === String(b.id));
      const code = own[0]?.attributes.currency_code || spentRows[0]?.currency_code || 'EUR';
      return {
        id: b.id,
        name: b.attributes.name,
        order: b.attributes.order ?? 0,
        code,
        limit: sum(own, (l) => Number(l.attributes.amount)),
        spent: Math.abs(sum(spentRows, (x) => Number(x.difference_float ?? x.difference))),
      };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function budgetState(b, share) {
  if (!b.limit) return { cls: '', label: 'Kein Limit', badge: '' };
  const used = b.spent / b.limit;
  if (used > 1) return { cls: 'over', label: 'Überzogen', badge: 'bad' };
  if (share < 1 && used > share + 0.1) return { cls: 'warn', label: 'Über Plan', badge: 'warn' };
  return { cls: '', label: 'Im Plan', badge: 'good' };
}

function budgetBlock(b, share, { detailed = false, start, end } = {}) {
  const st = budgetState(b, share);
  const used = b.limit ? b.spent / b.limit : 0;
  const left = b.limit - b.spent;
  const daysLeft = Math.max(0, Math.round((end - today()) / 86400000) + 1);
  const perDay = detailed && b.limit && left > 0 && share < 1 && share > 0 ? left / daysLeft : null;
  return `<div class="budget">
    <div class="budget-top">
      <span class="title">${esc(b.name)}</span>
      <span class="nums"><b>${money(b.spent, b.code)}</b>${b.limit ? ` von ${money(b.limit, b.code)}` : ''}</span>
    </div>
    <div class="progress ${st.cls}" title="${percent(used)} verbraucht">
      <span style="width:${Math.min(100, used * 100)}%"></span>
      ${b.limit && share > 0 && share < 1 ? `<i class="pace" style="left:${share * 100}%" title="Heute"></i>` : ''}
    </div>
    <div class="budget-foot">
      <span>${b.limit ? (left >= 0 ? `${money(left, b.code)} übrig` : `${money(-left, b.code)} drüber`) : 'Ohne Limit'}${perDay ? ` · ${money(perDay, b.code)} pro Tag` : ''}</span>
      ${st.badge ? `<span class="badge ${st.badge}">${st.label}</span>` : ''}
    </div>
  </div>`;
}

const FREQ = {
  weekly: ['wöchentlich', 52 / 12],
  monthly: ['monatlich', 1],
  quarterly: ['vierteljährlich', 1 / 3],
  'half-year': ['halbjährlich', 1 / 6],
  yearly: ['jährlich', 1 / 12],
};

function billInfo(bill) {
  const a = bill.attributes;
  const amount = (Number(a.amount_min) + Number(a.amount_max)) / 2;
  const [freqLabel, perMonth] = FREQ[a.repeat_freq] || [a.repeat_freq, 1];
  const skip = Number(a.skip || 0) + 1;
  const paid = (a.paid_dates || []).map((p) => parseDate(p.date));
  const isPaid = (d) =>
    paid.some((p) =>
      a.repeat_freq === 'weekly'
        ? Math.abs(p - d) <= 3 * 86400000
        : p.getFullYear() === d.getFullYear() && p.getMonth() === d.getMonth(),
    );
  const due = (a.pay_dates || []).map(parseDate).map((d) => ({ date: d, paid: isPaid(d) }));
  return {
    id: bill.id,
    name: a.name,
    active: a.active !== false,
    code: a.currency_code,
    amount,
    freqLabel: skip > 1 ? `alle ${skip} × ${freqLabel}` : freqLabel,
    monthly: (amount * perMonth) / skip,
    next: parseDate(a.next_expected_match),
    due,
  };
}

// ---------------------------------------------------------------------------
// Übersicht

export async function overview(view, { period }) {
  const { start, end } = period;
  view.innerHTML = `
    <div class="grid">
      <section class="card span-3" id="s-networth"></section>
      <section class="card span-3" id="s-earned"></section>
      <section class="card span-3" id="s-spent"></section>
      <section class="card span-3" id="s-balance"></section>
      ${card('cashflow', 'Einnahmen & Ausgaben', { span: 'span-8', meta: 'letzte 12 Monate' })}
      ${card('accounts', 'Konten', { span: 'span-4', link: '<a href="#/konten">Alle →</a>' })}
      ${card('categories', 'Ausgaben nach Kategorie', { span: 'span-6', meta: esc(period.label) })}
      ${card('budgets', 'Budgets', { span: 'span-6', link: '<a href="#/budgets">Details →</a>' })}
      ${card('recent', 'Letzte Buchungen', { span: 'span-7', link: '<a href="#/buchungen">Alle →</a>' })}
      ${card('upcoming', 'Demnächst fällig', { span: 'span-5', meta: 'nächste 30 Tage' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  const summary = api.get('summary/basic', { start, end });
  const tile = (id, render) => fill($(id), () => summary, render, skeleton(2, 22));
  tile('s-networth', (el, s) => {
    const [main, ...rest] = api.summaryValues(s, 'net-worth');
    el.innerHTML = stat('Nettovermögen', money(main?.value, main?.code), rest.map((r) => money(r.value, r.code)).join(' · ') || `Stand ${fmtDate(end > today() ? today() : end)}`);
  });
  tile('s-earned', (el, s) => {
    const [main] = api.summaryValues(s, 'earned');
    el.innerHTML = stat('Einnahmen', `<span class="pos">${money(main?.value, main?.code)}</span>`, esc(period.label));
  });
  tile('s-spent', (el, s) => {
    const [main] = api.summaryValues(s, 'spent');
    const [left] = api.summaryValues(s, 'left-to-spend');
    el.innerHTML = stat('Ausgaben', money(Math.abs(main?.value || 0), main?.code), left ? `Budget übrig: ${money(left.value, left.code)}` : esc(period.label));
  });
  tile('s-balance', (el, s) => {
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

  fill($('categories'), () => Promise.all([
    api.get('insight/expense/category', { start, end }),
    api.get('insight/expense/no-category', { start, end }).catch(() => []),
  ]), (el, [cats, none]) => {
    const all = [
      ...(cats || []).map((c) => ({ name: c.name, value: Math.abs(Number(c.difference_float ?? c.difference)), code: c.currency_code })),
      ...(none || []).map((c) => ({ name: 'Ohne Kategorie', value: Math.abs(Number(c.difference_float ?? c.difference)), code: c.currency_code, noCat: true })),
    ];
    const code = mainCurrency(all, 'code');
    const items = all.filter((x) => x.code === code && x.value > 0).sort((a, b) => b.value - a.value);
    if (!items.length) return (el.innerHTML = '<div class="empty">Keine Ausgaben im Zeitraum.</div>');
    const total = sum(items, (x) => x.value);
    const shown = items.slice(0, 8);
    const rest = items.slice(8);
    if (rest.length) shown.push({ name: `Weitere (${rest.length})`, value: sum(rest, (x) => x.value), code, none: true });
    const max = Math.max(...shown.map((x) => x.value));
    el.innerHTML = `<div class="bars">${shown
      .map((c) => {
        const op = c.noCat ? 'has_no_category:true' : c.none ? '' : `category_is:"${c.name}"`;
        const q = op ? `#/buchungen?q=${encodeURIComponent(op)}` : '';
        const name = q ? `<a href="${q}" class="name" title="Buchungen anzeigen">${esc(c.name)}</a>` : `<span class="name">${esc(c.name)}</span>`;
        return `<div class="bar-row">${name}
          <div class="track"><div class="fill" style="width:${(c.value / max) * 100}%"></div></div>
          <div class="val">${money(c.value, code)}<small>${percent(c.value / total)}</small></div></div>`;
      })
      .join('')}</div>`;
  });

  const share = elapsedShare(start, end);
  fill($('budgets'), () => loadBudgets(start, end), (el, budgets) => {
    if (!budgets.length) return (el.innerHTML = '<div class="empty">Keine Budgets angelegt.</div>');
    el.innerHTML = budgets.slice(0, 5).map((b) => budgetBlock(b, share)).join('');
  });

  fill($('recent'), () => api.get('transactions', { start, end, type: 'all', limit: 8 }), (el, res) => {
    const rows = api.flattenTransactions(res.data).slice(0, 8);
    el.innerHTML = rows.length ? `<div class="list">${rows.map(txRow).join('')}</div>` : '<div class="empty">Keine Buchungen im Zeitraum.</div>';
  });

  const t = today();
  fill($('upcoming'), () => api.getAll('bills', { start: t, end: addDays(t, 30) }), (el, bills) => {
    const due = bills
      .map(billInfo)
      .filter((b) => b.active)
      .flatMap((b) => b.due.filter((d) => !d.paid && d.date >= t).map((d) => ({ ...b, date: d.date })))
      .sort((a, b) => a.date - b.date);
    if (!due.length) return (el.innerHTML = '<div class="empty">Nichts fällig in den nächsten 30 Tagen.</div>');
    el.innerHTML = `<div class="list">${due
      .map((b) => {
        const days = Math.round((b.date - t) / 86400000);
        const when = days === 0 ? 'heute' : days === 1 ? 'morgen' : `in ${days} Tagen`;
        return `<div class="row"><div class="avatar">${esc(initials(b.name))}</div>
          <div style="min-width:0"><div class="title">${esc(b.name)}</div><div class="subtitle">${fmtDateShort(b.date)} · ${when}</div></div>
          <div class="amount">${money(b.amount, b.code)}</div></div>`;
      })
      .join('')}</div>
      <div class="legend" style="margin-top:12px"><span>Summe <b>&nbsp;${money(sum(due, (b) => b.amount), mainCurrency(due, 'code'))}</b></span></div>`;
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

  view.querySelector('#tx-search').addEventListener('input', debounce((e) => {
    state.q = e.target.value;
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

export async function budgets(view, { period }) {
  const { start, end } = period;
  const share = elapsedShare(start, end);
  view.innerHTML = `
    <div class="grid">
      <section class="card span-4" id="b-total"></section>
      <section class="card span-4" id="b-left"></section>
      <section class="card span-4" id="b-time"></section>
      ${card('b-list', 'Alle Budgets', { meta: esc(period.label) })}
    </div>`;
  const data = loadBudgets(start, end);
  const $ = (id) => view.querySelector(`#${id}`);

  fill($('b-total'), () => data, (el, list) => {
    const code = mainCurrency(list, 'code');
    const limit = sum(list, (b) => b.limit);
    const spent = sum(list, (b) => b.spent);
    el.innerHTML = stat('Ausgegeben', money(spent, code), limit ? `von ${money(limit, code)} (${percent(spent / limit)})` : 'keine Limits');
  }, skeleton(2, 22));
  fill($('b-left'), () => data, (el, list) => {
    const code = mainCurrency(list, 'code');
    const left = sum(list.filter((b) => b.limit), (b) => b.limit - b.spent);
    const over = list.filter((b) => b.limit && b.spent > b.limit).length;
    el.innerHTML = stat('Noch verfügbar', money(left, code), over ? `<span class="down">${over} überzogen</span>` : 'kein Budget überzogen');
  }, skeleton(2, 22));
  $('b-time').innerHTML = stat('Zeitraum vergangen', percent(share), `${fmtDate(start)} – ${fmtDate(end)}`);

  fill($('b-list'), () => data, (el, list) => {
    if (!list.length) return (el.innerHTML = '<div class="empty">Keine Budgets angelegt.</div>');
    el.innerHTML = list.map((b) => budgetBlock(b, share, { detailed: true, start, end })).join('') +
      '<div class="legend" style="margin-top:8px"><span><i style="background:var(--text-secondary);width:2px"></i>Markierung = heutiger Stand im Zeitraum</span></div>';
  }, skeleton(6));
}

// ---------------------------------------------------------------------------
// Sparziele

export async function piggies(view) {
  view.innerHTML = `<div class="grid"><section class="card span-4" id="p-total"></section><section class="card span-4" id="p-target"></section><section class="card span-4" id="p-done"></section><div class="span-12" id="p-list"></div></div>`;
  const data = api.getAll('piggy-banks').then((list) =>
    list.map((p) => {
      const a = p.attributes;
      return {
        name: a.name,
        code: a.currency_code,
        current: Number(a.current_amount || 0),
        target: a.target_amount ? Number(a.target_amount) : null,
        date: parseDate(a.target_date),
        account: a.account_name || (a.accounts || []).map((x) => x.name).join(', '),
        active: a.active !== false,
      };
    }).filter((p) => p.active));
  const $ = (id) => view.querySelector(`#${id}`);

  fill($('p-total'), () => data, (el, list) => {
    const code = mainCurrency(list, 'code');
    el.innerHTML = stat('Gespart', money(sum(list, (p) => p.current), code), `in ${list.length} Sparzielen`);
  }, skeleton(2, 22));
  fill($('p-target'), () => data, (el, list) => {
    const code = mainCurrency(list, 'code');
    const withTarget = list.filter((p) => p.target);
    const left = sum(withTarget, (p) => Math.max(0, p.target - p.current));
    el.innerHTML = stat('Noch zu sparen', money(left, code), `Ziel gesamt ${money(sum(withTarget, (p) => p.target), code)}`);
  }, skeleton(2, 22));
  fill($('p-done'), () => data, (el, list) => {
    const done = list.filter((p) => p.target && p.current >= p.target).length;
    el.innerHTML = stat('Erreicht', `${done} / ${list.filter((p) => p.target).length}`, 'Sparziele komplett');
  }, skeleton(2, 22));

  fill($('p-list'), () => data, (el, list) => {
    if (!list.length) return (el.innerHTML = '<section class="card"><div class="empty">Keine Sparschweine angelegt.</div></section>');
    const t = today();
    el.innerHTML = `<div class="tiles">${list
      .map((p) => {
        const share = p.target ? p.current / p.target : 0;
        const done = p.target && p.current >= p.target;
        const left = p.target ? Math.max(0, p.target - p.current) : 0;
        const months = p.date ? Math.max(1, (p.date.getFullYear() - t.getFullYear()) * 12 + p.date.getMonth() - t.getMonth()) : null;
        const hint = done
          ? '<span class="badge good">Erreicht</span>'
          : p.date && left
            ? `${money(left / months, p.code)} / Monat bis ${fmtDate(p.date, { month: 'short', year: 'numeric' })}`
            : left ? `noch ${money(left, p.code)}` : '';
        return `<section class="card tile">
          <span class="kind">${esc(p.account || 'Sparziel')}</span>
          <span class="name">${esc(p.name)}</span>
          <span class="balance">${money(p.current, p.code)}</span>
          ${p.target ? `<div class="progress ${done ? 'done' : ''}"><span style="width:${Math.min(100, share * 100)}%"></span></div>
          <div class="budget-foot"><span>${percent(share)} von ${money(p.target, p.code)}</span></div>` : ''}
          <div class="budget-foot"><span>${hint}</span></div>
        </section>`;
      })
      .join('')}</div>`;
  }, `<div class="tiles"><section class="card">${skeleton(4)}</section><section class="card">${skeleton(4)}</section></div>`);
}

// ---------------------------------------------------------------------------
// Verträge / Rechnungen

export async function bills(view, { period }) {
  const { start, end } = period;
  view.innerHTML = `
    <div class="grid">
      <section class="card span-4" id="v-month"></section>
      <section class="card span-4" id="v-due"></section>
      <section class="card span-4" id="v-paid"></section>
      ${card('v-list', 'Verträge & wiederkehrende Rechnungen', { meta: esc(period.label) })}
    </div>`;
  const data = api.getAll('bills', { start, end }).then((list) => list.map(billInfo));
  const $ = (id) => view.querySelector(`#${id}`);

  fill($('v-month'), () => data, (el, list) => {
    const active = list.filter((b) => b.active);
    const code = mainCurrency(active, 'code');
    const monthly = sum(active, (b) => b.monthly);
    el.innerHTML = stat('Fixkosten pro Monat', money(monthly, code), `≈ ${money(monthly * 12, code)} pro Jahr`);
  }, skeleton(2, 22));
  fill($('v-due'), () => data, (el, list) => {
    const code = mainCurrency(list, 'code');
    const dues = list.flatMap((b) => b.due.map((d) => ({ ...d, amount: b.amount })));
    el.innerHTML = stat('Fällig im Zeitraum', money(sum(dues, (d) => d.amount), code), `${dues.length} Zahlungen`);
  }, skeleton(2, 22));
  fill($('v-paid'), () => data, (el, list) => {
    const code = mainCurrency(list, 'code');
    const dues = list.flatMap((b) => b.due.map((d) => ({ ...d, amount: b.amount })));
    const open = dues.filter((d) => !d.paid);
    el.innerHTML = stat('Noch offen', money(sum(open, (d) => d.amount), code), `${dues.length - open.length} von ${dues.length} bezahlt`);
  }, skeleton(2, 22));

  fill($('v-list'), () => data, (el, list) => {
    if (!list.length) return (el.innerHTML = '<div class="empty">Keine Verträge angelegt.</div>');
    const t = today();
    const status = (b) => {
      if (!b.active) return '<span class="badge">Inaktiv</span>';
      if (!b.due.length) return '<span class="badge">Nicht fällig</span>';
      const open = b.due.filter((d) => !d.paid);
      if (!open.length) return '<span class="badge good">Bezahlt</span>';
      if (open.some((d) => d.date < t)) return '<span class="badge bad">Überfällig</span>';
      return '<span class="badge warn">Offen</span>';
    };
    const sorted = [...list].sort((a, b) => b.active - a.active || (a.next || Infinity) - (b.next || Infinity));
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Vertrag</th><th class="hide-sm">Rhythmus</th><th class="hide-sm">Nächste Fälligkeit</th><th>Status</th><th class="num">Betrag</th></tr></thead>
      <tbody>${sorted
        .map((b) => `<tr style="cursor:default">
          <td><div class="desc">${esc(b.name)}</div><div class="flow">${money(b.monthly, b.code)} / Monat</div></td>
          <td class="hide-sm">${esc(b.freqLabel)}</td>
          <td class="hide-sm date">${b.next ? fmtDate(b.next) : '–'}</td>
          <td>${status(b)}</td>
          <td class="num">${money(b.amount, b.code)}</td></tr>`)
        .join('')}</tbody></table></div>`;
  }, skeleton(6));
}
