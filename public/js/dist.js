// Verteilungs-Grafiken: Geldfluss (Sankey), Anteils-Leiste, Wochentage
// und Betragsklassen. Ohne Zusatzbibliothek – Sankey als eigenes SVG.

import { barChart, seriesColor, cssVar } from './charts.js';
import { money, percent, esc, parseDate } from './util.js';
import { sum } from './common.js';

const intFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** Fasst kleine Einträge zu „Sonstige“ zusammen (feste Reihenfolge nach Größe). */
function topWithRest(items, max) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, max);
  const rest = sorted.slice(max);
  if (rest.length) top.push({ name: `Sonstige (${rest.length})`, value: sum(rest, (x) => x.value), rest: true });
  return top;
}

// ---------------------------------------------------------------------------
// Anteils-Leiste: ein 100-%-Balken, darunter die Legende mit Werten

export function shareStrip(items, { code, hrefFor = null, max = 7 } = {}) {
  const parts = topWithRest(items.filter((x) => x.value > 0), max);
  const total = sum(parts, (x) => x.value);
  if (!total) return '<div class="empty">Keine Daten.</div>';
  const color = (p, i) => (p.rest ? cssVar('--axis') : seriesColor(i));
  return `<div class="strip" role="img" aria-label="Anteile">${parts
    .map((p, i) => `<a class="strip-seg" ${hrefFor && !p.rest ? `href="${hrefFor(p)}"` : ''} style="flex:${p.value} 1 0;background:${color(p, i)}"
        data-tip="${esc(`${p.name}: ${money(p.value, code)} (${percent(p.value / total)})`)}"></a>`)
    .join('')}</div>
    <div class="strip-legend">${parts
      .map((p, i) => `<div class="strip-item"><i style="background:${color(p, i)}"></i>
        ${hrefFor && !p.rest ? `<a class="plain" href="${hrefFor(p)}">${esc(p.name)}</a>` : `<span>${esc(p.name)}</span>`}
        <b>${percent(p.value / total)}</b><small>${money(p.value, code)}</small></div>`)
      .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Wochentage & Betragsklassen (aus einzelnen Buchungen)

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const BUCKETS = [10, 25, 50, 100, 250, 500, 1000];
const bucketLabels = ['< 10', '10–25', '25–50', '50–100', '100–250', '250–500', '500–1.000', '> 1.000'];

export function weekdayChart(canvas, txs, code, color = seriesColor(0)) {
  const sums = WEEKDAYS.map(() => 0);
  const counts = WEEKDAYS.map(() => 0);
  for (const t of txs) {
    const d = parseDate(t.date);
    const i = (d.getDay() + 6) % 7;
    sums[i] += t.amount;
    counts[i] += 1;
  }
  const chart = barChart(canvas, { labels: WEEKDAYS, series: [{ label: 'Summe', data: sums, color }], currency: code });
  chart.options.plugins.tooltip.callbacks.afterLabel = (ctx) => ` ${counts[ctx.dataIndex]} Buchungen`;
  chart.update('none');
  return chart;
}

export function sizeChart(canvas, txs, code, color = seriesColor(0)) {
  const counts = bucketLabels.map(() => 0);
  const sums = bucketLabels.map(() => 0);
  for (const t of txs) {
    const i = BUCKETS.findIndex((b) => t.amount < b);
    const k = i === -1 ? BUCKETS.length : i;
    counts[k] += 1;
    sums[k] += t.amount;
  }
  const chart = barChart(canvas, {
    labels: bucketLabels.map((l) => `${l} ${code === 'EUR' ? '€' : code}`),
    series: [{ label: 'Buchungen', data: counts, color }],
    format: (v) => intFmt.format(v),
  });
  chart.options.plugins.tooltip.callbacks.afterLabel = (ctx) => ` zusammen ${money(sums[ctx.dataIndex], code)}`;
  chart.options.scales.y.ticks.precision = 0; // Anzahl: nur ganze Zahlen auf der Achse
  chart.update('none');
  return chart;
}

// ---------------------------------------------------------------------------
// Geldfluss: Einnahmen → Gesamt → Ausgaben (+ Gespart bzw. aus Rücklagen)

export function sankey(host, { incomes, expenses, code, hrefFor = null }) {
  const totalIn = sum(incomes, (x) => x.value);
  const totalOut = sum(expenses, (x) => x.value);
  if (!totalIn && !totalOut) return (host.innerHTML = '<div class="empty">Keine Daten im Zeitraum.</div>');

  const left = topWithRest(incomes, 5).map((x) => ({ ...x, kind: 'in' }));
  const right = topWithRest(expenses, 8).map((x) => ({ ...x, kind: 'out' }));
  if (totalIn > totalOut) right.push({ name: 'Gespart', value: totalIn - totalOut, kind: 'saved' });
  if (totalOut > totalIn) left.push({ name: 'Aus Rücklagen', value: totalOut - totalIn, kind: 'reserve' });
  const total = Math.max(totalIn, totalOut);

  const W = Math.max(640, host.clientWidth || 640);
  const gap = 8;
  const minSlot = 34; // Platz für zwei Zeilen Beschriftung
  const rows = Math.max(left.length, right.length);
  const scale = Math.max(160, rows * 26) / total;
  const labelW = Math.min(190, W * 0.26);
  const nodeW = 12;
  const xL = labelW;
  const xM = W / 2 - nodeW / 2;
  const xR = W - labelW - nodeW;

  // Jeder Eintrag bekommt mindestens minSlot Höhe; der Balken sitzt mittig darin
  const slotsOf = (nodes) => nodes.map((n) => Math.max(minSlot, Math.max(2, n.value * scale)));
  const usedOf = (nodes) => sum(slotsOf(nodes), (h) => h) + gap * (nodes.length - 1);
  const H = Math.max(280, usedOf(left), usedOf(right), total * scale) + 20;
  const layout = (nodes) => {
    const slots = slotsOf(nodes);
    let y = (H - usedOf(nodes)) / 2;
    return nodes.map((n, i) => {
      const h = Math.max(2, n.value * scale);
      const box = { ...n, y: y + (slots[i] - h) / 2, h };
      y += slots[i] + gap;
      return box;
    });
  };
  const L = layout(left);
  const R = layout(right);
  const midH = total * scale;
  const midY = (H - midH) / 2;

  const colorOf = (n, i) => {
    if (n.kind === 'saved') return cssVar('--status-good');
    if (n.kind === 'reserve') return cssVar('--status-warning');
    if (n.rest) return cssVar('--axis');
    return n.kind === 'in' ? seriesColor(2) : seriesColor(i);
  };
  const link = (x0, y0, h0, x1, y1, h1, color, tip) => {
    const xm = (x0 + x1) / 2;
    return `<path class="sk-link" d="M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + h1} C${xm},${y1 + h1} ${xm},${y0 + h0} ${x0},${y0 + h0} Z"
      fill="${color}" data-tip="${esc(tip)}"/>`;
  };

  let svg = '';
  let mid = midY;
  L.forEach((n, i) => {
    const c = colorOf(n, i);
    svg += link(xL + nodeW, n.y, n.h, xM, mid, n.h, c, `${n.name} → Gesamt: ${money(n.value, code)}`);
    svg += `<rect x="${xL}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="3" fill="${c}"/>`;
    svg += `<text x="${xL - 8}" y="${n.y + n.h / 2}" text-anchor="end" dominant-baseline="middle"><tspan class="sk-name">${esc(n.name)}</tspan><tspan x="${xL - 8}" dy="15" class="sk-val">${money(n.value, code)}</tspan></text>`;
    mid += n.h;
  });
  mid = midY;
  R.forEach((n, i) => {
    const c = colorOf(n, i);
    const href = hrefFor && n.kind === 'out' && !n.rest ? hrefFor(n) : null;
    svg += link(xM + nodeW, mid, n.h, xR, n.y, n.h, c, `Gesamt → ${n.name}: ${money(n.value, code)} (${percent(n.value / total)})`);
    const label = `<text x="${xR + nodeW + 8}" y="${n.y + n.h / 2}" dominant-baseline="middle"><tspan class="sk-name">${esc(n.name)}</tspan><tspan x="${xR + nodeW + 8}" dy="15" class="sk-val">${money(n.value, code)} · ${percent(n.value / total)}</tspan></text>`;
    svg += `<rect x="${xR}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="3" fill="${c}"/>`;
    svg += href ? `<a href="${href}" class="sk-target">${label}</a>` : label;
    mid += n.h;
  });
  svg += `<rect x="${xM}" y="${midY}" width="${nodeW}" height="${midH}" rx="3" fill="${cssVar('--text-secondary')}"/>`;

  host.innerHTML = `<div class="table-wrap"><svg class="sankey" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Geldfluss von Einnahmen zu Ausgaben">${svg}</svg></div>
    <div class="legend sankey-hint"><span>← zum Ansehen seitlich wischen →</span></div>`;
}
