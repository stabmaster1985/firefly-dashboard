// Diagramme mit Chart.js – Farben kommen aus den CSS-Variablen,
// damit Hell- und Dunkelmodus jeweils eigene, geprüfte Töne verwenden.

import { money, fmtDateShort, fmtMonth, esc } from './util.js';

const active = new Set();

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Feste Farbreihenfolge – die Farbe hängt am Objekt, nicht am Rang. */
export const seriesColor = (index) => cssVar(`--series-${(index % 8) + 1}`);

export function destroyCharts() {
  for (const chart of active) chart.destroy();
  active.clear();
}

function baseOptions(currency) {
  const muted = cssVar('--text-muted');
  const grid = cssVar('--grid');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 350 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar('--text-primary'),
        titleColor: cssVar('--surface-1'),
        bodyColor: cssVar('--surface-1'),
        padding: 10,
        cornerRadius: 8,
        boxPadding: 4,
        usePointStyle: true,
        callbacks: {
          label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.parsed.y, currency)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: cssVar('--axis') },
        ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16, font: { size: 12 } },
      },
      y: {
        grid: { color: grid, drawTicks: false },
        border: { display: false },
        ticks: {
          color: muted,
          padding: 8,
          font: { size: 12 },
          callback: (v) => money(v, currency, { compact: true }),
        },
      },
    },
  };
}

function create(canvas, config) {
  Chart.defaults.font.family = cssVar('--font') || 'system-ui';
  const chart = new Chart(canvas, config);
  active.add(chart);
  return chart;
}

/** Gruppierte Balken, z. B. Einnahmen vs. Ausgaben je Monat. */
export function barChart(canvas, { labels, series, currency = 'EUR' }) {
  return create(canvas, {
    type: 'bar',
    data: {
      labels: labels.map(fmtMonth),
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.color,
        hoverBackgroundColor: s.color,
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: 'bottom',
        borderWidth: 0,
        barPercentage: 0.82,
        categoryPercentage: 0.66,
        maxBarThickness: 22,
      })),
    },
    options: baseOptions(currency),
  });
}

/** Linien für Kontostände über die Zeit. */
export function lineChart(canvas, { labels, series, currency = 'EUR' }) {
  const options = baseOptions(currency);
  options.elements = { point: { radius: 0, hoverRadius: 5, hitRadius: 12, hoverBorderWidth: 2 } };
  options.plugins.tooltip.callbacks.title = (items) => fmtDateShort(labels[items[0].dataIndex]);
  return create(canvas, {
    type: 'line',
    data: {
      labels: labels.map(fmtDateShort),
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color,
        backgroundColor: s.color,
        pointHoverBorderColor: cssVar('--surface-1'),
        borderWidth: 2,
        tension: 0.25,
        fill: false,
      })),
    },
    options,
  });
}

export function legend(series) {
  return `<div class="legend">${series
    .map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`)
    .join('')}</div>`;
}
