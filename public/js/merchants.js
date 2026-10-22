// Seite „Händler“: Wo kaufst du ein, wie oft, wird es teurer, was ist neu –
// und (mit KI-Bewertung aus dem Labor) wie viel geht für Verzichtbares drauf.
// Grundlage: Ausgaben der letzten 24 Monate; Händler wie im Labor erkannt
// (Empfänger, bei „Kartenzahlung“/PayPal & Co. aus Beschreibung bzw. Notizen).

import { barChart, legend, seriesColor } from './charts.js';
import { money, esc, fmtDate, fmtMonth, today, startOfMonth, endOfMonth } from './util.js';
import { card, stat, sum, mainCurrency } from './common.js';
import { loadHistory } from './check.js';
import { merchantOf } from './rules.js';

const DAY = 86400000;
const NEEDS = [['notwendig', 'Notwendig'], ['sinnvoll', 'Sinnvoll'], ['verzichtbar', 'Verzichtbar']];

export async function merchants(view) {
  const t0 = today();
  const yearAgo = startOfMonth(t0, -11);
  const twoYearsAgo = startOfMonth(t0, -23);
  const halfAgo = startOfMonth(t0, -5);
  view.innerHTML = `
    <div class="grid">
      <section class="card span-3" id="m-count"></section>
      <section class="card span-3" id="m-top"></section>
      <section class="card span-3" id="m-new"></section>
      <section class="card span-3" id="m-avoid"></section>
      ${card('m-list', 'Händler', { filter: true, meta: '<span class="chips small" id="m-sort" role="group" aria-label="Sortierung"></span>' })}
      ${card('m-price', 'Preisentwicklung', { span: 'span-6', meta: 'Ø Betrag: letzte 6 Monate ggü. den 6 davor' })}
      ${card('m-fresh', 'Neue Händler', { span: 'span-6', meta: 'erste Buchung in den letzten 60 Tagen' })}
      ${card('m-needs', 'Sparpotenzial: Wofür geht das Geld?', { meta: '<span id="m-needs-meta">Einordnung der KI aus dem Labor</span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  ['m-count', 'm-top', 'm-new', 'm-avoid'].forEach((id) => ($(id).innerHTML = '<div class="skeleton" style="height:44px"></div>'));

  const [all, ai] = await Promise.all([
    loadHistory(),
    fetch('/local/ai/status').then((r) => r.json()).catch(() => ({ labels: {}, decisions: {} })),
  ]);
  if (!view.isConnected) return;
  const out = all.filter((t) => t.type === 'withdrawal');
  const code = mainCurrency(out);
  const own = out.filter((t) => t.currency_code === code);

  // Händler bilden
  const byKey = new Map();
  for (const t of own) {
    const m = merchantOf(t);
    if (!m.key) continue;
    const g = byKey.get(m.key) || { key: m.key, name: m.name, linkable: m.cond.field === 'party', list: [], cats: new Map() };
    g.list.push(t);
    if (t.category_name) g.cats.set(t.category_name, (g.cats.get(t.category_name) || 0) + 1);
    byKey.set(m.key, g);
  }
  const d = (t) => new Date(String(t.date).slice(0, 10));
  const list = [...byKey.values()].map((g) => {
    const cur = g.list.filter((t) => d(t) >= yearAgo);
    const prev = g.list.filter((t) => d(t) >= twoYearsAgo && d(t) < yearAgo);
    const dates = g.list.map((t) => d(t).getTime()).sort((a, b) => a - b);
    const recent = g.list.filter((t) => d(t) >= halfAgo);
    const before = g.list.filter((t) => d(t) < halfAgo && d(t) >= startOfMonth(t0, -11));
    return {
      ...g,
      sum12: sum(cur, (t) => t.amount),
      prev12: sum(prev, (t) => t.amount),
      n12: cur.length,
      n: g.list.length,
      first: dates[0],
      last: dates.at(-1),
      avg: g.list.length ? sum(g.list, (t) => t.amount) / g.list.length : 0,
      avgRecent: recent.length ? sum(recent, (t) => t.amount) / recent.length : 0,
      avgBefore: before.length ? sum(before, (t) => t.amount) / before.length : 0,
      nRecent: recent.length,
      nBefore: before.length,
      topCat: [...g.cats].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    };
  });
  const total12 = sum(list, (m) => m.sum12);
  const active = list.filter((m) => m.n12);
  const top10 = [...active].sort((a, b) => b.sum12 - a.sum12).slice(0, 10);
  const fresh = list.filter((m) => m.first >= t0.getTime() - 60 * DAY).sort((a, b) => b.first - a.first);

  /** Häufigkeit in Worten. */
  const freq = (m) => {
    if (m.n12 < 2) return m.n12 ? 'einmal' : '–';
    const perMonth = m.n12 / 12;
    if (perMonth >= 4) return `${(perMonth / 4.33).toFixed(1).replace('.', ',')}× pro Woche`;
    if (perMonth >= 0.9) return `${perMonth.toFixed(1).replace('.', ',')}× pro Monat`;
    return `${m.n12}× im Jahr`;
  };
  const link = (m) => (m.linkable ? `<a class="plain" href="#/empfaenger/${encodeURIComponent(m.name)}">${esc(m.name)}</a>` : esc(m.name));
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const delta = (a, b) => {
    const p = pct(a, b);
    return p === null ? '<span class="muted">neu</span>' : `<span class="${p > 0 ? 'down' : p < 0 ? 'up' : 'muted'}">${p > 0 ? '+' : ''}${p} %</span>`;
  };

  $('m-count').innerHTML = stat('Händler (12 Monate)', String(active.length), `${list.length} in 24 Monaten`);
  $('m-top').innerHTML = stat('Top 10 machen', `${total12 ? Math.round((sum(top10, (m) => m.sum12) / total12) * 100) : 0} %`, `der Ausgaben aus (${money(sum(top10, (m) => m.sum12), code)})`);
  $('m-new').innerHTML = stat('Neu (60 Tage)', String(fresh.length), fresh.length ? `zuletzt ${esc(fresh[0].name)}` : 'keine neuen Händler');

  // ---- Liste --------------------------------------------------------------
  const SORTS = { sum: ['Summe', (a, b) => b.sum12 - a.sum12], n: ['Häufigkeit', (a, b) => b.n12 - a.n12], up: ['Gestiegen', (a, b) => (b.sum12 - b.prev12) - (a.sum12 - a.prev12)], last: ['Zuletzt', (a, b) => b.last - a.last] };
  let sort = 'sum';
  const renderList = () => {
    $('m-sort').innerHTML = Object.entries(SORTS).map(([k, [l]]) => `<button class="chip" data-m-sort="${k}" aria-pressed="${k === sort}">${l}</button>`).join('');
    const rows = [...active].sort(SORTS[sort][1]).slice(0, 300);
    $('m-list').innerHTML = rows.length ? `<div class="table-wrap scroll"><table><thead><tr><th>Händler</th><th class="num">12 Monate</th><th class="num hide-sm">Vorjahr</th><th class="num">Änderung</th><th class="hide-sm">Häufigkeit</th><th class="num hide-sm">Ø Betrag</th><th class="hide-sm">Kategorie</th><th class="hide-sm">Zuletzt</th></tr></thead><tbody>
      ${rows.map((m) => `<tr style="cursor:default"><td>${link(m)}</td><td class="num"><b>${money(m.sum12, code)}</b></td><td class="num hide-sm muted">${m.prev12 ? money(m.prev12, code) : '–'}</td>
        <td class="num">${delta(m.sum12, m.prev12)}</td><td class="hide-sm">${freq(m)}</td><td class="num hide-sm">${money(m.avg, code)}</td>
        <td class="hide-sm">${esc(m.topCat || 'ohne')}</td><td class="hide-sm date">${fmtDate(new Date(m.last))}</td></tr>`).join('')}</tbody></table></div>
      ${active.length > 300 ? `<div class="legend" style="margin-top:8px"><span>Die ersten 300 von ${active.length}</span></div>` : ''}
      <div class="legend" style="margin-top:8px"><span>Händler wie im Labor erkannt – bei „Kartenzahlung“ ohne Empfänger aus Beschreibung bzw. Notizen. Name anklicken öffnet die Händler-Seite.</span></div>`
      : '<div class="empty">Keine Ausgaben in den letzten 12 Monaten.</div>';
  };
  $('m-list').addEventListener('click', (e) => {
    const s = e.target.closest('[data-m-sort]');
    if (!s) return;
    sort = s.dataset.mSort;
    renderList();
  });
  $('m-sort').addEventListener('click', (e) => {
    const s = e.target.closest('[data-m-sort]');
    if (!s) return;
    sort = s.dataset.mSort;
    renderList();
  });
  renderList();

  // ---- Preisentwicklung (häufige Händler) ----------------------------------
  const priced = list.filter((m) => m.nRecent >= 4 && m.nBefore >= 4).map((m) => ({ ...m, change: pct(m.avgRecent, m.avgBefore) }))
    .filter((m) => m.change !== null).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 15);
  $('m-price').innerHTML = priced.length ? `<div class="table-wrap"><table><thead><tr><th>Händler</th><th class="num">vorher Ø</th><th class="num">jetzt Ø</th><th class="num">Änderung</th></tr></thead><tbody>
    ${priced.map((m) => `<tr style="cursor:default"><td>${link(m)}<div class="flow">${m.nBefore} → ${m.nRecent} Einkäufe</div></td><td class="num muted">${money(m.avgBefore, code)}</td>
      <td class="num">${money(m.avgRecent, code)}</td><td class="num">${delta(m.avgRecent, m.avgBefore)}</td></tr>`).join('')}</tbody></table></div>
    <div class="legend" style="margin-top:8px"><span>Nur Händler mit mindestens 4 Einkäufen in beiden Halbjahren. Ein höherer Ø kann auch an größeren Einkäufen liegen, nicht nur an Preisen.</span></div>`
    : '<div class="empty">Noch zu wenige wiederholte Einkäufe für einen Vergleich.</div>';

  // ---- Neue Händler ------------------------------------------------------------
  $('m-fresh').innerHTML = fresh.length ? `<div class="list">${fresh.slice(0, 15).map((m) => `<div class="row"><div class="avatar">+</div>
      <div style="min-width:0"><div class="title">${link(m)}</div><div class="subtitle">seit ${fmtDate(new Date(m.first))} · ${m.n}× · ${esc(m.topCat || 'ohne Kategorie')}</div></div>
      <div class="amount">${money(sum(m.list, (t) => t.amount), code)}</div></div>`).join('')}</div>`
    : '<div class="empty">Keine neuen Händler in den letzten 60 Tagen.</div>';

  // ---- Sparpotenzial aus der KI-Bewertung -----------------------------------
  const labels = ai?.labels || {};
  const decisions = ai?.decisions?.categories || {};
  const needOf = (t) => {
    const l = labels[merchantOf(t).key];
    return l && l.status !== 'nein' && (decisions[l.kategorie] !== null) ? l.bedarf : null;
  };
  const months = Array.from({ length: 12 }, (_, i) => [startOfMonth(t0, i - 11), endOfMonth(t0, i - 11)]);
  const inMonth = (s, e) => (t) => d(t) >= s && d(t) <= e;
  const rated = own.filter((t) => d(t) >= yearAgo && needOf(t));
  if (!Object.keys(labels).length || !rated.length) {
    $('m-avoid').innerHTML = stat('Verzichtbar (12 Monate)', '–', 'KI-Analyse im Labor laufen lassen');
    $('m-needs').innerHTML = `<div class="empty">Noch keine KI-Bewertung. Im <a href="#/labor">Labor</a> unter „KI-Analyse mit Ollama“ die Händler bewerten lassen –
      dann zeigt diese Karte je Monat, wie viel auf notwendig, sinnvoll und verzichtbar entfällt, und wo am meisten Verzichtbares anfällt.</div>`;
    return;
  }
  const avoid = rated.filter((t) => needOf(t) === 'verzichtbar');
  const avoidSum = sum(avoid, (t) => t.amount);
  const ratedSum = sum(rated, (t) => t.amount);
  $('m-avoid').innerHTML = stat('Verzichtbar (12 Monate)', money(avoidSum, code), `${ratedSum ? Math.round((avoidSum / ratedSum) * 100) : 0} % der bewerteten Ausgaben · Ø ${money(avoidSum / 12, code)} im Monat`);
  const series = NEEDS.map(([k, l], i) => ({ label: l, data: months.map(([s, e]) => sum(rated.filter((t) => needOf(t) === k && inMonth(s, e)(t)), (t) => t.amount)), color: seriesColor(i) }));
  const topAvoid = [...new Map(avoid.map((t) => [merchantOf(t).key, null])).keys()]
    .map((key) => ({ key, m: byKey.get(key), s: sum(avoid.filter((t) => merchantOf(t).key === key), (t) => t.amount) }))
    .filter((x) => x.m).sort((a, b) => b.s - a.s).slice(0, 8);
  $('m-needs-meta').textContent = `${Math.round((ratedSum / (sum(own.filter((t) => d(t) >= yearAgo), (t) => t.amount) || 1)) * 100)} % der Ausgaben bewertet`;
  $('m-needs').innerHTML = `${legend(series)}<div class="chart-box" style="margin-top:12px"><canvas aria-label="Ausgaben je Monat nach Bedarf"></canvas></div>
    ${topAvoid.length ? `<h3 class="sub-h" style="margin-top:16px">Am meisten Verzichtbares (12 Monate)</h3><div class="list">${topAvoid.map((x) => `<div class="row"><div class="avatar">€</div>
      <div style="min-width:0"><div class="title">${link(x.m)}</div><div class="subtitle">${esc(labels[x.key]?.grund || '')}</div></div><div class="amount">${money(x.s, code)}</div></div>`).join('')}</div>` : ''}
    <div class="legend" style="margin-top:8px"><span>Einordnung der KI je Händler (abgelehnte Bewertungen zählen nicht). Anpassen im Labor unter „KI-Analyse“.</span></div>`;
  barChart($('m-needs').querySelector('canvas'), { labels: months.map(([s]) => fmtMonth(s)), series, currency: code, stacked: true });
}
