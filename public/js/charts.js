// Diagramme mit Chart.js – Farben kommen aus den CSS-Variablen,
// damit Hell- und Dunkelmodus jeweils eigene, geprüfte Töne verwenden.

import { money, fmtDateShort, fmtMonth, esc } from './util.js';

const active = new Set();

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Feste Farbreihenfolge – die Farbe hängt am Objekt, nicht am Rang. */
export const seriesColor = (index) => cssVar(`--series-${(index % 8) + 1}`);

export function destroyCharts() {
  for (const chart of active) {
    try {
      chart.destroy();
    } catch {
      // wurde bereits einzeln zerstört
    }
  }
  active.clear();
}

function baseOptions(currency, format = null) {
  const fmt = format || ((v) => money(v, currency));
  const fmtAxis = format || ((v) => money(v, currency, { compact: true }));
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
          label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
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
          callback: (v) => fmtAxis(v),
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

/**
 * Balken je Monat – gruppiert (Einnahmen vs. Ausgaben) oder gestapelt
 * (Kategorien). Optional mit gestrichelter Durchschnittslinie.
 */
export function barChart(canvas, { labels, series, currency = 'EUR', stacked = false, average = null, goal = null, onClick = null, format = null }) {
  const surface = cssVar('--surface-1');
  const datasets = series.map((s, i) => ({
    label: s.label,
    data: s.data,
    backgroundColor: s.color,
    hoverBackgroundColor: s.color,
    borderRadius: stacked && i < series.length - 1 ? 0 : { topLeft: 4, topRight: 4 },
    borderSkipped: stacked ? false : 'bottom',
    // 2px Fuge in Flächenfarbe zwischen gestapelten Segmenten
    borderWidth: stacked && i > 0 ? { bottom: 2 } : 0,
    borderColor: surface,
    barPercentage: stacked ? 0.7 : 0.82,
    categoryPercentage: stacked ? 0.8 : 0.66,
    maxBarThickness: stacked ? 36 : 22,
    order: 1,
  }));
  if (average !== null) {
    datasets.push({
      type: 'line',
      label: 'Ø',
      stack: 'avg', // nicht auf gestapelte Balken addieren
      data: labels.map(() => average),
      borderColor: cssVar('--text-secondary'),
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      pointHoverRadius: 0,
      order: 0,
    });
  }
  if (goal) {
    datasets.push({
      type: 'line',
      label: 'Ziel',
      stack: 'goal',
      data: labels.map(() => goal),
      borderColor: cssVar('--status-critical'),
      borderWidth: 1.5,
      borderDash: [2, 3],
      pointRadius: 0,
      pointHoverRadius: 0,
      order: 0,
    });
  }
  const options = baseOptions(currency, format);
  if (stacked) {
    options.scales.x.stacked = true;
    options.scales.y.stacked = true;
    options.plugins.tooltip.itemSort = (a, b) => b.datasetIndex - a.datasetIndex;
  }
  if (onClick) {
    // Liefert Monat und – falls ein Segment direkt getroffen wurde – dessen Datenreihe
    options.onClick = (e, elements, chart) => {
      const hit = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false)
        .find((el) => chart.data.datasets[el.datasetIndex].type !== 'line');
      const el = hit || elements[0];
      if (el) onClick(el.index, hit ? hit.datasetIndex : null);
    };
    options.onHover = (e, elements) => (e.native.target.style.cursor = elements.length ? 'pointer' : 'default');
  }
  // Datumswerte als Monat beschriften, Texte (Wochentage, Klassen) unverändert
  const shown = labels.map((l) => (l instanceof Date ? fmtMonth(l) : l));
  return create(canvas, { type: 'bar', data: { labels: shown, datasets }, options });
}

/** Linien für Kontostände über die Zeit. */
export function lineChart(canvas, { labels, series, currency = 'EUR', format = fmtDateShort }) {
  const options = baseOptions(currency);
  options.elements = { point: { radius: 0, hoverRadius: 5, hitRadius: 12, hoverBorderWidth: 2 } };
  options.plugins.tooltip.callbacks.title = (items) => format(labels[items[0].dataIndex]);
  return create(canvas, {
    type: 'line',
    data: {
      labels: labels.map(format),
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
