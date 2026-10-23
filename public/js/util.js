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

// Auf dem Handy zweistellige Jahreszahl (spart in Tabellen Platz für den Betrag)
const narrow = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;

// Formatierer wiederverwenden – toLocaleDateString baut bei jedem Aufruf einen neuen (spürbar bei Tausenden Buchungen)
const dateFormats = new Map();
export function fmtDate(value, opts = { day: '2-digit', month: '2-digit', year: narrow?.matches ? '2-digit' : 'numeric' }) {
  const d = parseDate(value);
  if (!d) return '–';
  const key = JSON.stringify(opts);
  let f = dateFormats.get(key);
  if (!f) dateFormats.set(key, (f = new Intl.DateTimeFormat(LOCALE, opts)));
  return f.format(d);
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

// ---------------------------------------------------------------------------
// Monatsmodell: Kalendermonat (ab dem 1.) oder Gehaltsmonat (ab dem Gehaltstag).
// Fällt der Gehaltstag aufs Wochenende, beginnt der Gehaltsmonat am Freitag
// davor – dann kommt das Gehalt in der Regel schon.

const DAY_MS = 86400000;
const dayDiff = (a, b) => Math.round((b - a) / DAY_MS);

export function monthModel(startDay = 1) {
  const day = Math.min(28, Math.max(1, Number(startDay) || 1));
  /** Beginn des Monats y/m (m darf über- oder unterlaufen). */
  const startOf = (y, m) => {
    if (day === 1) return new Date(y, m, 1);
    const d = new Date(y, m, day);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return d;
  };
  /** Schlüssel (Jahr/Monat des Beginns) des Monats, in dem ein Datum liegt. */
  const keyOf = (date) => {
    const y = date.getFullYear();
    const m = date.getMonth();
    if (date < startOf(y, m)) return new Date(y, m - 1, 1);
    if (date >= startOf(y, m + 1)) return new Date(y, m + 1, 1);
    return new Date(y, m, 1);
  };
  /** [Beginn, Ende] des Monats key + offset; .label = Datum für die Beschriftung. */
  const range = (key, offset = 0) => {
    const y = key.getFullYear();
    const m = key.getMonth() + offset;
    const r = [startOf(y, m), addDays(startOf(y, m + 1), -1)];
    // Gehaltsmonat 24.09.–23.10. heißt „Okt.“ – der Monat, für den das Gehalt reicht
    r.label = day === 1 ? r[0] : r[1];
    return r;
  };
  const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
  /** Datum um n Monate verschieben – gleiche Position im (Gehalts-)Monat. */
  const shift = (date, n) => {
    const key = keyOf(date);
    const [s, e] = range(key);
    const [s2, e2] = range(key, n);
    if (dayDiff(date, e) === 0) return e2; // Monatsende bleibt Monatsende
    const moved = addDays(s2, dayDiff(s, date));
    return moved > e2 ? e2 : moved;
  };
  /** Deckt der Zeitraum genau ganze Monate dieses Modells ab? */
  const aligned = ({ start, end }) =>
    dayDiff(range(keyOf(start))[0], start) === 0 && dayDiff(range(keyOf(end))[1], end) === 0;
  return { day, isSalary: day !== 1, startOf, keyOf, range, monthsBetween, shift, aligned };
}

export const CALENDAR = monthModel(1);

/** Gehaltstag (Beginn des Gehaltsmonats), einstellbar in der Zeitraumauswahl. */
export const payday = () => Math.min(28, Math.max(2, Number(storage('ffd-payday', '24')) || 24));

const monthRange = (model, t, from, to) => {
  const key = model.keyOf(t);
  return [model.range(key, from)[0], model.range(key, to)[1]];
};

export const PERIODS = [
  { id: 'this-month', label: 'Dieser Monat', range: (t) => monthRange(CALENDAR, t, 0, 0) },
  { id: 'last-month', label: 'Letzter Monat', range: (t) => monthRange(CALENDAR, t, -1, -1) },
  { id: 'last-3', label: 'Letzte 3 Monate', range: (t) => monthRange(CALENDAR, t, -2, 0) },
  { id: 'last-6', label: 'Letzte 6 Monate', range: (t) => monthRange(CALENDAR, t, -5, 0) },
  { id: 'this-year', label: 'Dieses Jahr', range: (t) => [new Date(t.getFullYear(), 0, 1), new Date(t.getFullYear(), 11, 31)] },
  { id: 'last-year', label: 'Letztes Jahr', range: (t) => [new Date(t.getFullYear() - 1, 0, 1), new Date(t.getFullYear() - 1, 11, 31)] },
  { id: 'last-12', label: 'Letzte 12 Monate', range: (t) => monthRange(CALENDAR, t, -11, 0) },
];

/** Gehaltsmonate – rechnen überall (Matrix, Verläufe, Vergleich) in Gehaltsmonaten. */
export const SALARY_PERIODS = [
  { id: 'sal-this', label: 'Aktueller Gehaltsmonat', from: 0, to: 0 },
  { id: 'sal-last', label: 'Letzter Gehaltsmonat', from: -1, to: -1 },
  { id: 'sal-3', label: 'Letzte 3 Gehaltsmonate', from: -2, to: 0 },
  { id: 'sal-6', label: 'Letzte 6 Gehaltsmonate', from: -5, to: 0 },
  { id: 'sal-12', label: 'Letzte 12 Gehaltsmonate', from: -11, to: 0 },
];

const shortRange = (s, e) => {
  // Jahr nur zeigen, wenn der Zeitraum über einen Jahreswechsel geht
  const opts = s.getFullYear() === e.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' };
  return `${fmtDate(s, opts)}–${fmtDate(e, opts)}`;
};

/** Eigener Zeitraum wird als "custom:JJJJ-MM-TT:JJJJ-MM-TT" gespeichert. */
export const customPeriodId = (start, end) => `custom:${isoDate(start)}:${isoDate(end)}`;

export function periodById(id) {
  const m = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(id || '');
  if (m) {
    const start = parseDate(m[1]);
    const end = parseDate(m[2]);
    if (start <= end) return { id, label: `${fmtDate(start)} – ${fmtDate(end)}`, start, end, custom: true, model: CALENDAR };
  }
  const sal = SALARY_PERIODS.find((x) => x.id === id);
  if (sal) {
    const model = monthModel(payday());
    const [start, end] = monthRange(model, today(), sal.from, sal.to);
    return { ...sal, start, end, model, label: `${sal.label} (${shortRange(start, end)})`, shortLabel: sal.label };
  }
  const p = PERIODS.find((x) => x.id === id) || PERIODS[0];
  const [start, end] = p.range(today());
  return { ...p, start, end, model: CALENDAR };
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
