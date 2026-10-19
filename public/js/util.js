// Formatierung, Zeiträume und kleine DOM-Helfer.

const LOCALE = 'de-DE';
const moneyFormats = new Map();

export function money(value, code = 'EUR', { signed = false, compact = false } = {}) {
  const key = `${code}|${signed}|${compact}`;
  if (!moneyFormats.has(key)) {
    let fmt;
    try {
      fmt = new Intl.NumberFormat(LOCALE, {
        style: 'currency',
        currency: code || 'EUR',
        signDisplay: signed ? 'exceptZero' : 'auto',
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : 2,
      });
    } catch {
      fmt = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    moneyFormats.set(key, fmt);
  }
  return moneyFormats.get(key).format(Number(value) || 0);
}

export function percent(value) {
  return new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 }).format(value || 0);
}

export function parseDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  // Firefly liefert ISO-Zeitstempel; für Anzeige zählt nur der Kalendertag.
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function fmtDate(value, opts = { day: '2-digit', month: '2-digit', year: 'numeric' }) {
  const d = parseDate(value);
  return d ? d.toLocaleDateString(LOCALE, opts) : '–';
}

export const fmtDateShort = (value) => fmtDate(value, { day: 'numeric', month: 'short' });
export const fmtMonth = (value) => fmtDate(value, { month: 'short', year: '2-digit' });

export function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const startOfMonth = (d, offset = 0) => new Date(d.getFullYear(), d.getMonth() + offset, 1);
export const endOfMonth = (d, offset = 0) => new Date(d.getFullYear(), d.getMonth() + offset + 1, 0);

export const PERIODS = [
  { id: 'this-month', label: 'Dieser Monat', range: (t) => [startOfMonth(t), endOfMonth(t)] },
  { id: 'last-month', label: 'Letzter Monat', range: (t) => [startOfMonth(t, -1), endOfMonth(t, -1)] },
  { id: 'last-3', label: 'Letzte 3 Monate', range: (t) => [startOfMonth(t, -2), endOfMonth(t)] },
  { id: 'last-6', label: 'Letzte 6 Monate', range: (t) => [startOfMonth(t, -5), endOfMonth(t)] },
  { id: 'this-year', label: 'Dieses Jahr', range: (t) => [new Date(t.getFullYear(), 0, 1), new Date(t.getFullYear(), 11, 31)] },
  { id: 'last-year', label: 'Letztes Jahr', range: (t) => [new Date(t.getFullYear() - 1, 0, 1), new Date(t.getFullYear() - 1, 11, 31)] },
  { id: 'last-12', label: 'Letzte 12 Monate', range: (t) => [startOfMonth(t, -11), endOfMonth(t)] },
];

export function periodById(id) {
  const p = PERIODS.find((x) => x.id === id) || PERIODS[0];
  const [start, end] = p.range(today());
  return { ...p, start, end };
}

/** Anteil des Zeitraums, der bereits vergangen ist (0..1) */
export function elapsedShare(start, end) {
  const t = today();
  if (t < start) return 0;
  if (t > end) return 1;
  return (t - start + 86400000) / (end - start + 86400000);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function initials(name) {
  const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function storage(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // privates Fenster o. Ä. – Einstellung gilt dann nur für diese Sitzung
  }
}
