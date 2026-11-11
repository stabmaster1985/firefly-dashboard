// Wiederkehrende Zahlungen automatisch erkennen – ohne dass in Firefly
// Verträge/Rechnungen gepflegt sein müssen.

import * as api from './api.js';
import { money, esc, fmtDate, today, startOfMonth, addDays, isoDate, parseDate, storage, store } from './util.js';
import { skeleton, fill, card, stat, mainCurrency, sum } from './common.js';
import { lineChart, seriesColor } from './charts.js';

const RHYTHMS = [
  { days: 7, label: 'wöchentlich', tol: 2, min: 4 },
  { days: 14, label: 'alle 2 Wochen', tol: 3, min: 4 },
  { days: 30.44, months: 1, label: 'monatlich', tol: 7, min: 3 },
  { days: 61, months: 2, label: 'alle 2 Monate', tol: 12, min: 3 },
  { days: 91.3, months: 3, label: 'vierteljährlich', tol: 18, min: 3 },
  { days: 182.6, months: 6, label: 'halbjährlich', tol: 30, min: 2 },
  { days: 365.25, months: 12, label: 'jährlich', tol: 35, min: 2 },
];

/** Empfindlichkeit: Anteil regelmäßiger Abstände / stabiler Beträge und erlaubte Betragsschwankung. */
const LEVELS = {
  streng: { label: 'Streng', regular: 0.8, stable: 0.8, spread: 0.15 },
  normal: { label: 'Normal', regular: 0.6, stable: 0.6, spread: 0.25 },
  locker: { label: 'Locker', regular: 0.45, stable: 0.5, spread: 0.4 },
};

const DAY = 86400000;

/** Nächster Termin: Monatsrhythmen bleiben auf ihrem Kalendertag (1. bleibt 1.). */
export function stepDate(d, rhythm, anchorDay) {
  if (!rhythm.months) return addDays(d, rhythm.days);
  const y = d.getFullYear();
  const m = d.getMonth() + rhythm.months;
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(anchorDay, lastDay));
}
const median = (list) => {
  const v = [...list].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Namen vergleichbar machen: Ziffern, Rechtsformen und Sonderzeichen weg. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b(gmbh|ag|se|kg|ohg|e\.?v|sarl|s\.a\.r\.l|ltd|inc|llc|bv|nv|co|europe|deutschland|germany)\b\.?/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Gruppe nach Betrag in Teilgruppen aufteilen – z. B. mehrere Abos über PayPal. */
function amountClusters(items, spread) {
  const sorted = [...items].sort((a, b) => a.amount - b.amount);
  const clusters = [];
  for (const t of sorted) {
    const c = clusters.at(-1);
    if (c && t.amount <= median(c.map((x) => x.amount)) * (1 + spread * 2)) c.push(t);
    else clusters.push([t]);
  }
  return clusters;
}

/**
 * Prüft eine Buchungsfolge auf Regelmäßigkeit; liefert Ergebnis oder null.
 * „tight“: nur ein Teil der Buchungen eines Empfängers oder nur zwei Termine –
 * dann müssen die Beträge nahezu gleich sein, sonst wären zufällig ähnlich
 * große Einkäufe (Supermarkt, Tanken) schnell ein „Abo“.
 */
function evaluate(list, level, tight = false) {
  if (list.length < 2) return null;
  list.sort((a, b) => a.day - b.day);
  // mehrere Buchungen am selben Tag zählen als eine
  const days = list.filter((t, i) => i === 0 || t.day - list[i - 1].day > DAY / 2);
  const gaps = days.slice(1).map((t, i) => (t.day - days[i].day) / DAY);
  if (!gaps.length) return null;
  const base = median(gaps);
  const rhythm = RHYTHMS.find((r) => Math.abs(base - r.days) <= r.tol);
  if (!rhythm || days.length < rhythm.min) return null;
  // ein ausgelassener Termin (doppelter Abstand) gilt noch als regelmäßig
  const fits = (g) => [1, 2].some((k) => Math.abs(g - k * rhythm.days) <= rhythm.tol * k);
  const regular = gaps.filter(fits).length / gaps.length;
  const amount = median(list.map((t) => t.amount));
  const strict = tight || days.length <= 2;
  const spread = strict ? 0.03 : level.spread;
  const stable = list.filter((t) => Math.abs(t.amount - amount) <= Math.max(0.5, amount * spread)).length / list.length;
  if (regular < level.regular || stable < (strict ? 0.8 : level.stable)) return null;
  return { rhythm, amount, regular, stable, list };
}

/**
 * Sucht regelmäßige Zahlungen in zwei Durchgängen: nach Gegenkonto und nach
 * Buchungstext (für Zahlungen über Zwischenhändler wie PayPal). Innerhalb
 * einer Gruppe wird zusätzlich nach Betrag getrennt.
 */
export function detectRecurring(transactions, kind, levelKey = 'normal') {
  const level = LEVELS[levelKey] || LEVELS.normal;
  const t0 = today();
  const prepared = transactions
    .filter((t) => t.amount > 0)
    .map((t) => ({ ...t, day: parseDate(t.date), party: kind === 'income' ? t.source_name : t.destination_name }));

  const passes = [
    (t) => normalize(t.party),
    (t) => normalize(t.description),
  ];
  const used = new Set();
  const found = [];
  const stats = { transactions: prepared.length, groups: 0 };

  for (const keyOf of passes) {
    const groups = new Map();
    for (const t of prepared) {
      const key = keyOf(t);
      if (!key || key.length < 2) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    stats.groups = Math.max(stats.groups, groups.size);
    for (const items of groups.values()) {
      const code = mainCurrency(items);
      const own = items.filter((t) => t.currency_code === code);
      for (const cluster of amountClusters(own, level.spread)) {
        const fresh = cluster.filter((t) => !used.has(`${t.groupId}|${t.transaction_journal_id}`));
        if (fresh.length < cluster.length / 2) continue; // schon im ersten Durchgang gefunden
        const hit = evaluate(fresh, level, cluster.length < own.length);
        if (!hit) continue;
        hit.list.forEach((t) => used.add(`${t.groupId}|${t.transaction_journal_id}`));
        const last = hit.list.at(-1);
        const active = (t0 - last.day) / DAY <= hit.rhythm.days * 1.5 + hit.rhythm.tol;
        // typischer Tag im Monat (Median), damit Wochenend-Verschiebungen nicht wandern
        const anchorDay = Math.round(median(hit.list.map((t) => t.day.getDate())));
        let next = stepDate(last.day, hit.rhythm, anchorDay);
        while (active && next < t0) next = stepDate(next, hit.rhythm, anchorDay);
        const cats = new Map();
        hit.list.forEach((t) => t.category_name && cats.set(t.category_name, (cats.get(t.category_name) || 0) + 1));
        // Anzeigename: Gegenkonto – außer bei Zwischenhändlern (PayPal & Co.),
        // dort der gemeinsame Buchungstext ohne Nummern
        const partyNames = new Set(hit.list.map((t) => normalize(t.party)));
        const descNames = new Set(hit.list.map((t) => normalize(t.description)));
        const intermediary = cluster.length < own.length || keyOf === passes[1];
        const cleanDesc = last.description.replace(/\s*[#*]?\d{4,}\S*/g, '').replace(/\s+/g, ' ').trim();
        const name = intermediary && descNames.size === 1 && cleanDesc ? cleanDesc : last.party || last.description;
        // Konto, von dem gezahlt (bzw. auf das eingezahlt) wird – für die Kontostand-Vorschau
        const accs = new Map();
        hit.list.forEach((t) => {
          const id = kind === 'income' ? t.destination_id : t.source_id;
          if (id) accs.set(String(id), { id: String(id), name: kind === 'income' ? t.destination_name : t.source_name, n: (accs.get(String(id))?.n || 0) + 1 });
        });
        const acc = [...accs.values()].sort((a, b) => b.n - a.n)[0];
        found.push({
          name,
          party: last.party,
          account: acc ? { id: acc.id, name: acc.name } : null,
          via: name !== last.party && partyNames.size === 1 ? last.party : null,
          code,
          rhythm: hit.rhythm,
          amount: hit.amount,
          count: hit.list.length,
          first: hit.list[0].day,
          last: last.day,
          lastAmount: last.amount,
          next: active ? next : null,
          anchorDay,
          active,
          perYear: (hit.amount * 365.25) / hit.rhythm.days,
          category: [...cats].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
          changed: Math.abs(last.amount - hit.amount) > Math.max(1, hit.amount * 0.05),
          confidence: Math.round(((hit.regular + hit.stable) / 2) * 100),
        });
      }
    }
  }
  stats.found = found.length;
  return { items: found.sort((a, b) => b.perYear - a.perYear), stats };
}

// ---------------------------------------------------------------------------
// Eigene Angaben (DATA_DIR/recurring.json, lib/automation.js): ausgeblendete Fehlerkennungen,
// von Hand angelegte Verträge und Vertragsdaten (Ende, Kündigungsfrist, Verlängerung, Notiz).
// Oberfläche, Warnungen und MQTT wenden sie gleich an.

export const RHYTHM_LABELS = RHYTHMS.map((r) => r.label);
/** Feste Kennung eines Eintrags (Art, Name, Rhythmus) – für Ausblenden und Vertragsdaten. */
export const recurringId = (kind, r) => `${kind}|${normalize(r.name) || normalize(r.party) || String(r.name).toLowerCase()}|${r.rhythm.label}`;
const addMonths = (d, n) => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
};

/**
 * Nächste Kündigungsfrist eines Vertrags: { ende, frist, tage } (Daten) oder null.
 * Verlängert sich der Vertrag automatisch, rollt das Ende weiter, bis die Frist in der Zukunft liegt.
 */
export function contractDeadline(v, t0 = today()) {
  if (!v?.ende) return null;
  let ende = parseDate(v.ende);
  if (Number.isNaN(ende.getTime())) return null;
  const frist = Math.max(0, Number(v.frist) || 0);
  const ext = Math.max(0, Number(v.verlaengerung) || 0);
  let dl = addMonths(ende, -frist);
  for (let i = 0; dl < t0 && ext > 0 && i < 200; i++) {
    ende = addMonths(ende, ext);
    dl = addMonths(ende, -frist);
  }
  return { ende, frist: dl, tage: Math.round((dl - t0) / DAY) };
}

/**
 * Erkannte Einträge mit den eigenen Angaben zusammenführen: Kennung und Vertragsdaten anhängen,
 * von Hand angelegte Verträge ergänzen. Ausgeblendete kommen getrennt zurück (hidden).
 */
export function applyOverrides(items, cfg, kind, t0 = today()) {
  const hiddenIds = new Set(cfg?.hidden || []);
  const vertraege = cfg?.vertraege || {};
  const all = items.map((r) => {
    const id = recurringId(kind, r);
    return { ...r, id, vertrag: vertraege[id] || null };
  });
  for (const m of cfg?.manual || []) {
    if ((m.kind || 'expense') !== kind) continue;
    const rhythm = RHYTHMS.find((x) => x.label === m.rhythm);
    const start = parseDate(m.next);
    if (!rhythm || Number.isNaN(start.getTime()) || !(Number(m.amount) > 0)) continue;
    const anchorDay = start.getDate();
    let next = start;
    for (let i = 0; next < t0 && i < 2000; i++) next = stepDate(next, rhythm, anchorDay);
    const amount = Number(m.amount);
    all.push({
      id: m.id, manual: true, name: m.name, party: m.name, via: null, code: m.code || 'EUR', rhythm, amount, count: 0, first: null, last: null,
      lastAmount: amount, next, anchorDay, active: true, perYear: (amount * 365.25) / rhythm.days, category: m.category || '', changed: false,
      confidence: 100, account: m.account || null, vertrag: vertraege[m.id] || null,
    });
  }
  return { items: all.filter((r) => !hiddenIds.has(r.id)).sort((a, b) => b.perYear - a.perYear), hidden: all.filter((r) => hiddenIds.has(r.id)) };
}

let cfgPromise = null;
/** Eigene Angaben vom Server (einmal je Seitenaufruf). */
export function loadRecurringConfig(force = false) {
  if (force || !cfgPromise) cfgPromise = fetch('/local/recurring').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return cfgPromise;
}
/** Eigene Angabe ändern: { action: 'hide' | 'vertrag' | 'add' | 'remove', … } → neue Angaben. */
export async function changeRecurring(body) {
  const r = await fetch('/local/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
  cfgPromise = Promise.resolve(data);
  return data;
}

/** Lädt die Buchungen der letzten 24 Monate und erkennt Muster (für Seite und Prognose). Ausgeblendete fehlen in items. */
export async function loadRecurring(kind, levelKey = storage('ffd-recurring-level', 'normal')) {
  const t0 = today();
  const from = startOfMonth(t0, -24);
  const [groups, cfg] = await Promise.all([
    api.getAll('transactions', { start: from, end: t0, type: kind === 'income' ? 'deposit' : 'withdrawal' }),
    loadRecurringConfig(),
  ]);
  const txs = api.flattenTransactions(groups).filter((t) => t.type === (kind === 'income' ? 'deposit' : 'withdrawal'));
  const result = detectRecurring(txs, kind, levelKey);
  Object.assign(result, applyOverrides(result.items, cfg, kind, t0));
  result.from = from;
  result.oldest = txs.length ? txs.reduce((m, t) => (String(t.date) < m ? String(t.date) : m), String(txs[0].date)) : null;
  return result;
}

/** Erwartete Termine zwischen zwei Daten (für die Prognose im Detail). */
export function upcomingBetween(items, from, to) {
  const out = [];
  for (const r of items) {
    if (!r.active || !r.next) continue;
    for (let d = r.next; d <= to; d = stepDate(d, r.rhythm, r.anchorDay)) {
      if (d >= from) out.push({ ...r, date: d });
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

/** Rhythmus → kurzer Schlüssel für die Adresse (Filter). */
const RHYTHM_KEYS = { wöchentlich: 'woche', 'alle 2 Wochen': '2wochen', monatlich: 'monat', 'alle 2 Monate': '2monate', vierteljährlich: 'quartal', halbjährlich: 'halbjahr', jährlich: 'jahr' };
const RANGES = [14, 30, 60, 90];

export async function recurring(view, { params }) {
  const kind = params.get('art') === 'einnahmen' ? 'income' : 'expense';
  const showAll = params.get('alle') === '1';
  const levelKey = LEVELS[params.get('stufe')] ? params.get('stufe') : storage('ffd-recurring-level', 'normal');
  store('ffd-recurring-level', levelKey);
  const rhythms = new Set((params.get('rhythmus') || '').split(',').filter((k) => Object.values(RHYTHM_KEYS).includes(k)));
  const days = RANGES.includes(Number(params.get('tage'))) ? Number(params.get('tage')) : Number(storage('ffd-recurring-days', '30')) || 30;
  store('ffd-recurring-days', String(days));
  const t0 = today();
  const hrefWith = (changes) => {
    const qs = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? qs.set(k, v) : qs.delete(k)));
    return `#/wiederkehrend${qs.toString() ? `?${qs}` : ''}`;
  };
  const toggleRhythm = (key) => {
    const next = new Set(rhythms);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return hrefWith({ rhythmus: [...next].join(',') });
  };
  const word = kind === 'income' ? 'Eingänge' : 'Zahlungen';

  view.innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Art">
        <a class="chip" href="${hrefWith({ art: '' })}" aria-pressed="${kind === 'expense'}">Ausgaben</a>
        <a class="chip" href="${hrefWith({ art: 'einnahmen' })}" aria-pressed="${kind === 'income'}">Einnahmen</a>
      </div>
      <div class="chips" role="group" aria-label="Status">
        <a class="chip" href="${hrefWith({ alle: '' })}" aria-pressed="${!showAll}">Aktive</a>
        <a class="chip" href="${hrefWith({ alle: '1' })}" aria-pressed="${showAll}">Inkl. beendete</a>
      </div>
      <div class="chips" role="group" aria-label="Empfindlichkeit" title="Wie streng die Erkennung Regelmäßigkeit verlangt">
        ${Object.entries(LEVELS).map(([k, l]) => `<a class="chip" href="${hrefWith({ stufe: k })}" aria-pressed="${k === levelKey}">${l.label}</a>`).join('')}
      </div>
      <span class="meta-line" id="r-diag">Analysiere die Buchungen der letzten 24 Monate …</span>
    </div>
    <div class="toolbar r-rhythms" id="r-rhythms" role="group" aria-label="Rhythmus"></div>
    <div class="grid">
      <section class="card span-3" id="r-month"></section>
      <section class="card span-3" id="r-year"></section>
      <section class="card span-3" id="r-count"></section>
      <section class="card span-3" id="r-next"></section>
      ${card('r-forecast', 'Kontostand-Vorschau', { meta: '<span id="r-forecast-meta"></span>' })}
      ${card('r-soon', kind === 'income' ? 'Demnächst erwartet' : 'Demnächst fällig', { filter: true, meta: `<span class="chips small" role="group" aria-label="Zeitraum">${RANGES.map((d) => `<a class="chip" href="${hrefWith({ tage: String(d) })}" aria-pressed="${d === days}">${d} Tage</a>`).join('')}</span>` })}
      ${card('r-table', kind === 'income' ? 'Regelmäßige Einnahmen' : 'Regelmäßige Zahlungen', { filter: true, meta: '<span id="r-meta"></span>' })}
      ${card('r-contracts', 'Verträge & Kündigungsfristen', { span: kind === 'expense' ? 'span-6' : 'span-12', meta: '<span id="r-contracts-meta"></span>' })}
      ${kind === 'expense' ? card('r-reserve', 'Rücklage für seltene Zahlungen', { span: 'span-6', meta: 'vierteljährlich und seltener' }) : ''}
      ${card('r-add', 'Vertrag von Hand anlegen', { meta: 'z. B. Jahresbeiträge, die noch nicht erkannt werden' })}
    </div>
    <div class="pick-bar r-pick" id="r-pick" hidden></div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  const data = loadRecurring(kind, levelKey);
  data.then(({ stats, from, oldest }) => {
    $('r-diag').textContent = `${stats.transactions} Buchungen seit ${fmtDate(from)} geprüft${oldest ? ` (älteste: ${fmtDate(oldest)})` : ''} · ${stats.found} Muster gefunden`;
  }).catch((err) => ($('r-diag').textContent = `Analyse fehlgeschlagen: ${err.message}`));

  const editing = new Set(); // aufgeklappte Bearbeiten-Zeilen
  /** Eigene Angabe speichern und die Seite neu zeichnen (Summen, Fristen, Vorschau ändern sich). */
  const save = (body) => changeRecurring(body).then(() => window.dispatchEvent(new Event('ffd-rerender'))).catch((err) => alert(err.message));
  const deadlineBadge = (r) => {
    const dl = contractDeadline(r.vertrag, t0);
    if (!dl) return '';
    const cls = dl.tage <= 30 ? 'bad' : dl.tage <= 90 ? 'warn' : '';
    return ` <span class="badge ${cls}" title="Kündigungsfrist">kündigen bis ${fmtDate(dl.frist)}</span>`;
  };
  const editRow = (r) => {
    const v = r.vertrag || {};
    return `<tr class="r-edit"><td colspan="8"><form class="r-edit-form" data-contract="${esc(r.id)}">
      <label>Vertragsende<input class="input" type="date" name="ende" value="${esc(v.ende || '')}"></label>
      <label>Kündigungsfrist<select class="input select" name="frist">${[0, 1, 2, 3, 6, 12].map((n) => `<option value="${n}"${Number(v.frist ?? 1) === n ? ' selected' : ''}>${n ? `${n} Monat${n === 1 ? '' : 'e'}` : 'keine'}</option>`).join('')}</select></label>
      <label>verlängert sich um<select class="input select" name="verlaengerung">${[0, 1, 3, 6, 12, 24].map((n) => `<option value="${n}"${Number(v.verlaengerung ?? 12) === n ? ' selected' : ''}>${n ? `${n} Monat${n === 1 ? '' : 'e'}` : 'endet'}</option>`).join('')}</select></label>
      <label class="r-note">Notiz<input class="input" name="notiz" value="${esc(v.notiz || '')}" placeholder="z. B. Kundennummer, Kündigung per Mail"></label>
      <div class="r-edit-actions"><button class="btn primary small" type="submit">Speichern</button>
        ${r.vertrag ? `<button class="link-btn" type="button" data-clear="${esc(r.id)}">Vertragsdaten löschen</button>` : ''}
        ${r.manual ? `<button class="link-btn" type="button" data-remove="${esc(r.id)}">Eintrag löschen</button>`
    : `<button class="link-btn" type="button" data-hide="${esc(r.id)}" title="Kein echter Vertrag (z. B. regelmäßig Tanken) – zählt dann nirgends mehr mit">kein Vertrag – ausblenden</button>`}</div>
    </form></td></tr>`;
  };
  const rKey = (r) => RHYTHM_KEYS[r.rhythm.label] || r.rhythm.label;
  const statusOk = (r) => showAll || r.active;
  const inFilter = (r) => statusOk(r) && (!rhythms.size || rhythms.has(rKey(r)));
  const filterNote = rhythms.size ? Object.entries(RHYTHM_KEYS).filter(([, k]) => rhythms.has(k)).map(([l]) => l).join(', ') : '';

  // Rhythmus-Filter mit Anzahl je Rhythmus (nur die, die vorkommen)
  data.then(({ items }) => {
    const counts = new Map();
    items.filter(statusOk).forEach((r) => counts.set(rKey(r), (counts.get(rKey(r)) || 0) + 1));
    const total = items.filter(statusOk).length;
    $('r-rhythms').innerHTML = `<span class="muted">Rhythmus:</span>
      <a class="chip" href="${hrefWith({ rhythmus: '' })}" aria-pressed="${!rhythms.size}">Alle <span class="count">${total}</span></a>
      ${Object.entries(RHYTHM_KEYS).filter(([, k]) => counts.has(k) || rhythms.has(k))
    .map(([label, k]) => `<a class="chip" href="${toggleRhythm(k)}" aria-pressed="${rhythms.has(k)}">${esc(label)} <span class="count">${counts.get(k) || 0}</span></a>`).join('')}
      ${rhythms.size ? '<span class="muted">mehrere wählbar</span>' : ''}`;
  }).catch(() => {});

  const filtered = data.then((d) => d.items.filter(inFilter));
  const tile = (id, render) => fill($(id), () => filtered, render, skeleton(2, 22));
  const sub = (txt) => `${txt}${filterNote ? ` · ${filterNote}` : ''}`;
  tile('r-month', (el, list) => {
    const active = list.filter((r) => r.active);
    el.innerHTML = stat('Pro Monat', money(sum(active, (r) => r.perYear) / 12, mainCurrency(active, 'code')), sub('aktive, umgerechnet'));
  });
  tile('r-year', (el, list) => {
    const active = list.filter((r) => r.active);
    el.innerHTML = stat('Pro Jahr', money(sum(active, (r) => r.perYear), mainCurrency(active, 'code')), sub('aktive, hochgerechnet'));
  });
  tile('r-count', (el, list) => {
    const active = list.filter((r) => r.active).length;
    el.innerHTML = stat('Erkannt', String(active), sub(`${list.length - active} vermutlich beendet`));
  });
  tile('r-next', (el, list) => {
    const soon = upcomingBetween(list, t0, addDays(t0, days - 1));
    el.innerHTML = stat(`Nächste ${days} Tage`, money(sum(soon, (r) => r.amount), mainCurrency(soon, 'code')), sub(`${soon.length} erwartete ${word}`));
  });

  // ---- Demnächst fällig: Termine nach Datum, Zwischensumme je Monat, laufende Summe ----
  fill($('r-soon'), () => filtered, (el, list) => {
    const soon = upcomingBetween(list, t0, addDays(t0, days - 1));
    if (!soon.length) return (el.innerHTML = `<div class="empty">In den nächsten ${days} Tagen keine erwarteten ${word}${filterNote ? ` (${esc(filterNote)})` : ''}.</div>`);
    const code = mainCurrency(soon, 'code');
    const months = new Map();
    for (const r of soon) {
      const k = `${r.date.getFullYear()}-${r.date.getMonth()}`;
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(r);
    }
    let running = 0;
    const rel = (d) => {
      const n = Math.round((d - t0) / DAY);
      return n === 0 ? 'heute' : n === 1 ? 'morgen' : `in ${n} Tagen`;
    };
    el.innerHTML = `<div class="r-soon-total"><b>${money(sum(soon, (r) => r.amount), code)}</b> <span class="muted">in den nächsten ${days} Tagen · ${soon.length} ${word}</span></div>
      <div class="table-wrap"><table class="r-soon"><tbody>${[...months.values()].map((list2) => {
        const head = `<tr class="r-month-head"><td colspan="5"><span>${esc(fmtDate(list2[0].date, { month: 'long', year: 'numeric' }))}</span><span>${money(sum(list2, (r) => r.amount), code)}</span></td></tr>`;
        return head + list2.map((r) => {
          running += r.amount;
          return `<tr>
            <td class="date">${fmtDate(r.date, { weekday: 'short', day: '2-digit', month: '2-digit' })}<div class="flow">${rel(r.date)}</div></td>
            <td><div class="desc">${esc(r.name)}</div><div class="flow">${esc(r.category || 'ohne Kategorie')}${r.via ? ` · über ${esc(r.via)}` : ''}</div></td>
            <td class="hide-sm">${esc(r.rhythm.label)}</td>
            <td class="num"><b>${money(r.amount, r.code)}</b>${r.changed ? `<div class="flow" title="Letzter Betrag weicht ab">zuletzt ${money(r.lastAmount, r.code)}</div>` : ''}</td>
            <td class="num hide-sm muted" title="Summe bis hier">Σ ${money(running, code)}</td></tr>`;
        }).join('');
      }).join('')}</tbody></table></div>
      <div class="legend" style="margin-top:12px"><span>Erwartet aus dem bisherigen Rhythmus und dem üblichen Betrag – tatsächliche Termine können sich um ein paar Tage verschieben.</span></div>`;
  }, skeleton(5));

  // ---- Tabelle mit Auswahl und Summen ----
  const PICK_KEY = `ffd-recurring-pick-${kind}`;
  const idOf = (r) => `${r.name}|${r.rhythm.label}`;
  let picked;
  try {
    picked = new Set(JSON.parse(storage(PICK_KEY, '[]')));
  } catch {
    picked = new Set();
  }
  const savePicked = () => store(PICK_KEY, JSON.stringify([...picked]));

  fill($('r-table'), () => data, (el, { items, stats, from, hidden }) => {
    const rows = items.filter(inFilter);
    $('r-meta').textContent = `${rows.length} Einträge`;
    if (!rows.length) {
      el.innerHTML = `<div class="empty">
        ${stats.transactions === 0
          ? `Seit ${fmtDate(from)} wurden keine ${kind === 'income' ? 'Einnahmen' : 'Ausgaben'} gefunden – stimmt der Zugriff auf alle Konten?`
          : rhythms.size ? `Nichts mit diesem Rhythmus. <a href="${hrefWith({ rhythmus: '' })}">Alle zeigen →</a>` : `In ${stats.transactions} Buchungen nichts Regelmäßiges gefunden.`}
        ${levelKey !== 'locker' && stats.transactions && !rhythms.size ? `<br><a href="${hrefWith({ stufe: 'locker' })}">Mit lockerer Erkennung versuchen →</a>` : ''}
        ${!showAll && items.length && !rhythms.size ? `<br><a href="${hrefWith({ alle: '1' })}">${items.length} beendete anzeigen →</a>` : ''}</div>`;
      return;
    }
    const code = mainCurrency(rows, 'code');
    const activeRows = rows.filter((r) => r.active);
    const op = kind === 'income' ? 'source_account_is' : 'destination_account_is';
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th class="pick-cell"><input type="checkbox" id="r-pick-all" aria-label="alle angezeigten auswählen"></th><th>${kind === 'income' ? 'Von' : 'Empfänger'}</th><th class="hide-sm">Rhythmus</th><th class="num">Betrag</th>
        <th class="num hide-sm">Pro Monat</th><th class="num hide-sm">Pro Jahr</th><th class="hide-sm">Zuletzt</th><th>Nächste</th></tr></thead>
      <tbody>${rows
        .map((r) => {
          const q = r.via ? `"${r.name}"` : `${op}:"${r.party || r.name}"`;
          return `<tr data-href="#/buchungen?q=${encodeURIComponent(q)}&von=${isoDate(from)}&bis=${isoDate(t0)}"${r.active ? '' : ' class="inactive"'}>
          <td class="pick-cell"><input type="checkbox" data-pick="${esc(idOf(r))}" ${picked.has(idOf(r)) ? 'checked' : ''} aria-label="${esc(r.name)} auswählen"></td>
          <td><div class="desc">${esc(r.name)}${r.manual ? ' <span class="badge">von Hand</span>' : ''}${deadlineBadge(r)}</div><div class="flow">${esc(r.category || 'ohne Kategorie')}${r.via ? ` · über ${esc(r.via)}` : ''} · ${r.manual ? 'eigener Eintrag' : `${r.count}× seit ${fmtDate(r.first, { month: 'short', year: 'numeric' })}`}<span class="show-sm"> · ${esc(r.rhythm.label)}</span></div></td>
          <td class="hide-sm">${esc(r.rhythm.label)}<div class="flow">${r.manual ? 'von dir' : `${r.confidence} % sicher`}</div></td>
          <td class="num"><b>${money(r.amount, r.code)}</b>${r.changed ? `<div class="flow" title="Letzter Betrag weicht ab">zuletzt ${money(r.lastAmount, r.code)}</div>` : ''}</td>
          <td class="num hide-sm">${money(r.perYear / 12, r.code)}</td>
          <td class="num hide-sm">${money(r.perYear, r.code)}</td>
          <td class="hide-sm date">${r.last ? fmtDate(r.last) : '–'}</td>
          <td class="r-next-cell">${r.active ? `<span class="date">${fmtDate(r.next)}</span>` : '<span class="badge">beendet?</span>'}
            <button class="link-btn r-edit-btn" type="button" data-edit="${esc(r.id)}" title="Vertragsdaten, ausblenden …" aria-label="${esc(r.name)} bearbeiten">✎</button></td>
        </tr>${editing.has(r.id) ? editRow(r) : ''}`;
        })
        .join('')}</tbody>
      <tfoot><tr class="r-sum"><td></td><td colspan="2"><b>Summe</b> <span class="muted">${activeRows.length} aktive${filterNote ? ` · ${esc(filterNote)}` : ''}</span></td><td class="num"></td>
        <td class="num hide-sm"><b>${money(sum(activeRows, (r) => r.perYear) / 12, code)}</b></td><td class="num hide-sm"><b>${money(sum(activeRows, (r) => r.perYear), code)}</b></td><td class="hide-sm"></td><td></td></tr>
        <tr class="r-sum r-sum-sm"><td></td><td colspan="7"><span class="muted">je Monat</span> <b>${money(sum(activeRows, (r) => r.perYear) / 12, code)}</b> · <span class="muted">je Jahr</span> <b>${money(sum(activeRows, (r) => r.perYear), code)}</b></td></tr></tfoot>
      </table></div>
      <div class="legend" style="margin-top:12px"><span>Erkannt anhand regelmäßiger Abstände und ähnlicher Beträge – auch über PayPal & Co. · Zeile anklicken zeigt alle Buchungen · Häkchen: eigene Summe bilden (z. B. alle Versicherungen) · ✎: Vertragsdaten oder ausblenden</span></div>
      ${hidden?.length ? `<details class="r-hidden"><summary>${hidden.length} ausgeblendet (keine echten Verträge)</summary>
        <ul>${hidden.map((r) => `<li>${esc(r.name)} <span class="muted">· ${esc(r.rhythm.label)} · ${money(r.amount, r.code)}</span> <button class="link-btn" type="button" data-unhide="${esc(r.id)}">wieder einblenden</button></li>`).join('')}</ul></details>` : ''}`;

    // Summenleiste für die Auswahl
    const byId = new Map(items.map((r) => [idOf(r), r]));
    const updatePick = () => {
      const list = [...picked].map((id) => byId.get(id)).filter(Boolean);
      const bar = $('r-pick');
      const all = el.querySelector('#r-pick-all');
      const shownIds = rows.map(idOf);
      all.checked = shownIds.length > 0 && shownIds.every((id) => picked.has(id));
      all.indeterminate = !all.checked && shownIds.some((id) => picked.has(id));
      if (!list.length) {
        bar.hidden = true;
        return;
      }
      const active = list.filter((r) => r.active);
      const c = mainCurrency(list, 'code');
      const soon = upcomingBetween(active, t0, addDays(t0, days - 1));
      bar.hidden = false;
      bar.innerHTML = `<span><b>${list.length}</b> ausgewählt</span>
        <span>je Monat <b>${money(sum(active, (r) => r.perYear) / 12, c)}</b></span>
        <span>je Jahr <b>${money(sum(active, (r) => r.perYear), c)}</b></span>
        <span>nächste ${days} Tage <b>${money(sum(soon, (r) => r.amount), c)}</b></span>
        <button class="link-btn" id="r-pick-clear">Auswahl aufheben</button>`;
    };
    updatePick();
    el.addEventListener('change', (e) => {
      if (e.target.id === 'r-pick-all') {
        rows.forEach((r) => (e.target.checked ? picked.add(idOf(r)) : picked.delete(idOf(r))));
        el.querySelectorAll('[data-pick]').forEach((box) => (box.checked = e.target.checked));
      } else if (e.target.dataset.pick) {
        if (e.target.checked) picked.add(e.target.dataset.pick);
        else picked.delete(e.target.dataset.pick);
      } else return;
      savePicked();
      updatePick();
    });
    $('r-pick').addEventListener('click', (e) => {
      if (e.target.id !== 'r-pick-clear') return;
      picked.clear();
      savePicked();
      el.querySelectorAll('[data-pick]').forEach((box) => (box.checked = false));
      updatePick();
    });
    el.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const id = edit.dataset.edit;
        const tr = edit.closest('tr');
        if (tr.nextElementSibling?.classList.contains('r-edit')) {
          tr.nextElementSibling.remove();
          editing.delete(id);
        } else {
          editing.add(id);
          tr.insertAdjacentHTML('afterend', editRow(items.find((x) => x.id === id)));
        }
        return;
      }
      const btn = e.target.closest('[data-unhide], [data-hide], [data-remove], [data-clear]');
      if (btn) {
        btn.disabled = true;
        if (btn.dataset.unhide) return save({ action: 'hide', id: btn.dataset.unhide, hidden: false });
        if (btn.dataset.hide) return save({ action: 'hide', id: btn.dataset.hide, hidden: true });
        if (btn.dataset.remove && window.confirm('Diesen von Hand angelegten Vertrag löschen?')) return save({ action: 'remove', id: btn.dataset.remove });
        if (btn.dataset.clear) return save({ action: 'vertrag', id: btn.dataset.clear, vertrag: null });
        btn.disabled = false;
        return;
      }
      if (e.target.closest('input, label, .pick-cell, .r-edit, button, summary, details')) return;
      const tr = e.target.closest('tr[data-href]');
      if (tr) location.hash = tr.dataset.href;
    });
    el.addEventListener('submit', (e) => {
      const form = e.target.closest('[data-contract]');
      if (!form) return;
      e.preventDefault();
      const f = new FormData(form);
      form.querySelector('button[type=submit]').disabled = true;
      save({ action: 'vertrag', id: form.dataset.contract, vertrag: { ende: f.get('ende') || null, frist: f.get('frist'), verlaengerung: f.get('verlaengerung'), notiz: f.get('notiz') } });
    });
  }, skeleton(8));

  // ---- Verträge & Kündigungsfristen ----
  fill($('r-contracts'), () => data, (el, { items }) => {
    const list = items.filter((r) => r.vertrag).map((r) => ({ r, dl: contractDeadline(r.vertrag, t0) }))
      .sort((a, b) => (a.dl?.frist || Infinity) - (b.dl?.frist || Infinity));
    $('r-contracts-meta').textContent = list.length ? `${list.length} mit Vertragsdaten` : '';
    if (!list.length) {
      el.innerHTML = `<div class="empty">Noch keine Vertragsdaten. In der Tabelle oben bei einem Vertrag auf ✎ tippen und Vertragsende und
        Kündigungsfrist eintragen – das Dashboard erinnert dann 30 Tage vorher (Hinweise in der Übersicht, per n8n-Automation „Warnungen“ und MQTT).</div>`;
      return;
    }
    el.innerHTML = `<div class="list">${list.map(({ r, dl }) => `<div class="row" style="cursor:default">
      <div style="min-width:0"><div class="title">${esc(r.name)} ${deadlineBadge(r)}</div>
        <div class="subtitle">${money(r.amount, r.code)} ${esc(r.rhythm.label)}${dl ? ` · Vertragsende ${fmtDate(dl.ende)}${r.vertrag.verlaengerung ? `, verlängert sich um ${r.vertrag.verlaengerung} Monate` : ''}` : ''}${r.vertrag.notiz ? ` · ${esc(r.vertrag.notiz)}` : ''}</div></div>
      <div class="amount">${dl ? `<span class="date">${fmtDate(dl.frist)}</span><div class="flow">kündigen bis</div>` : ''}</div></div>`).join('')}</div>`;
  }, skeleton(3));

  // ---- Rücklage für seltene Zahlungen (vierteljährlich und seltener) ----
  if (kind === 'expense') {
    fill($('r-reserve'), () => data, (el, { items }) => {
      const rare = items.filter((r) => r.active && r.next && r.rhythm.days >= 89).sort((a, b) => a.next - b.next);
      if (!rare.length) return (el.innerHTML = '<div class="empty">Keine vierteljährlichen, halbjährlichen oder jährlichen Zahlungen erkannt. Fehlt etwas? Unten von Hand anlegen.</div>');
      const code = mainCurrency(rare, 'code');
      const monthsUntil = (d) => Math.max(1, Math.ceil((d - t0) / DAY / 30.44));
      const steady = sum(rare, (r) => r.perYear / 12);
      const catchUp = sum(rare.filter((r) => (r.next - t0) / DAY <= 366), (r) => r.amount / monthsUntil(r.next));
      el.innerHTML = `<div class="r-reserve-sum">
          <div><span class="muted">dauerhaft je Monat</span><b>${money(steady, code)}</b></div>
          <div><span class="muted">ab jetzt bis zu den nächsten Terminen</span><b>${money(catchUp, code)}</b></div>
        </div>
        <div class="table-wrap"><table><tbody>${rare.map((r) => `<tr style="cursor:default">
          <td><div class="desc">${esc(r.name)}</div><div class="flow">${esc(r.rhythm.label)} · ${money(r.amount, r.code)}</div></td>
          <td class="date">${fmtDate(r.next)}<div class="flow">in ${monthsUntil(r.next)} Monat${monthsUntil(r.next) === 1 ? '' : 'en'}</div></td>
          <td class="num"><b>${money(r.perYear / 12, r.code)}</b><div class="flow">je Monat</div></td>
          <td class="num hide-sm">${money(r.amount / monthsUntil(r.next), r.code)}<div class="flow">bis zum Termin</div></td></tr>`).join('')}</tbody></table></div>
        <div class="legend" style="margin-top:10px"><span>„Dauerhaft“: Betrag je Jahr ÷ 12 – reicht auf Dauer für alle diese Zahlungen. „Ab jetzt“: was bis zum jeweils nächsten Termin noch fehlt, wenn noch nichts zurückgelegt ist.</span></div>`;
    }, skeleton(3));
  }

  // ---- Vertrag von Hand anlegen ----
  fill($('r-add'), () => api.getAll('accounts', { type: 'asset' }).catch(() => []), (el, accounts) => {
    const active = accounts.filter((a) => a.attributes?.active !== false);
    el.innerHTML = `<form class="r-add-form" id="r-add-form">
      <label>Name<input class="input" name="name" required placeholder="z. B. Kfz-Versicherung"></label>
      <label>Betrag<input class="input" name="amount" required inputmode="decimal" placeholder="0,00"></label>
      <label>Rhythmus<select class="input select" name="rhythm">${RHYTHM_LABELS.map((l) => `<option${l === 'jährlich' ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Nächster Termin<input class="input" type="date" name="next" required></label>
      <label>Kategorie<input class="input" name="category" placeholder="optional"></label>
      <label>Konto<select class="input select" name="account"><option value="">–</option>${active.map((a) => `<option value="${esc(a.id)}">${esc(a.attributes.name)}</option>`).join('')}</select></label>
      <label>Art<select class="input select" name="kind"><option value="expense"${kind === 'expense' ? ' selected' : ''}>Ausgabe</option><option value="income"${kind === 'income' ? ' selected' : ''}>Einnahme</option></select></label>
      <button class="btn primary" type="submit">Anlegen</button>
    </form>
    <p class="muted small-text">Für Zahlungen, die die Erkennung (noch) nicht findet – etwa einen Jahresbeitrag, der erst einmal gebucht wurde. Sie zählen in Summen, „Demnächst fällig“, Rücklage und Kontostand-Vorschau mit.</p>`;
    el.querySelector('#r-add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const acc = active.find((a) => a.id === f.get('account'));
      e.target.querySelector('button').disabled = true;
      save({ action: 'add', manual: { name: f.get('name'), amount: f.get('amount'), rhythm: f.get('rhythm'), next: f.get('next'), category: f.get('category'), kind: f.get('kind'),
        account: acc ? { id: acc.id, name: acc.attributes.name } : null } });
    });
  }, skeleton(2));

  forecastCard($('r-forecast'), $('r-forecast-meta'), t0);
}

// ---------------------------------------------------------------------------
// Kontostand-Vorschau: heutiger Kontostand, dann Tag für Tag die erwarteten regelmäßigen Ein- und
// Ausgänge des Kontos – optional dazu der Durchschnitt der übrigen Ausgaben (Einkäufe, Tanken …).

const FC_RANGES = [['gehalt', 'bis zum Gehalt'], ['30', '30 Tage'], ['60', '60 Tage'], ['90', '90 Tage']];

async function forecastCard(el, meta, t0) {
  el.innerHTML = skeleton(3);
  let exp;
  let inc;
  let accounts;
  let recent;
  try {
    [exp, inc, accounts, recent] = await Promise.all([
      loadRecurring('expense'), loadRecurring('income'),
      api.getAll('accounts', { type: 'asset' }),
      api.getAll('transactions', { start: addDays(t0, -90), end: t0, type: 'withdrawal' }).then(api.flattenTransactions),
    ]);
  } catch (err) {
    el.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
    return;
  }
  const active = accounts.filter((a) => a.attributes?.active !== false);
  if (!active.length) return (el.innerHTML = '<div class="empty">Keine Konten gefunden.</div>');
  // Standard: das Konto mit den meisten regelmäßigen Zahlungen
  const counts = new Map();
  exp.items.forEach((r) => r.active && r.account && counts.set(r.account.id, (counts.get(r.account.id) || 0) + 1));
  const fallback = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || active[0].id;
  let accId = active.some((a) => a.id === storage('ffd-fc-account', '')) ? storage('ffd-fc-account', '') : fallback;
  let range = FC_RANGES.some(([k]) => k === storage('ffd-fc-range', 'gehalt')) ? storage('ffd-fc-range', 'gehalt') : 'gehalt';
  let variable = storage('ffd-fc-variable', '1') === '1';

  const draw = () => {
    if (!el.isConnected) return;
    const acc = active.find((a) => a.id === accId);
    const code = acc.attributes.currency_code || 'EUR';
    const onAcc = (r) => r.active && (r.account ? r.account.id === accId : accId === fallback);
    const expenses = exp.items.filter(onAcc);
    const incomes = inc.items.filter(onAcc);
    // Ende: bis zum nächsten größten Eingang („Gehalt“) bzw. feste Tage
    const salary = [...incomes].sort((a, b) => b.amount - a.amount)[0];
    const end = range === 'gehalt' ? (salary?.next || addDays(t0, 30)) : addDays(t0, Number(range) - 1);
    const events = [
      ...upcomingBetween(expenses, t0, end).map((r) => ({ date: r.date, name: r.name, amount: -r.amount, r })),
      ...upcomingBetween(incomes, t0, end).map((r) => ({ date: r.date, name: r.name, amount: r.amount, r })),
    ].sort((a, b) => a.date - b.date || a.amount - b.amount);
    // übrige Ausgaben: was in den letzten 90 Tagen vom Konto ging, abzüglich der regelmäßigen (hochgerechnet)
    const spent90 = sum(recent.filter((t) => String(t.source_id) === accId && t.type === 'withdrawal'), (t) => t.amount);
    const recurring90 = sum(expenses, (r) => (r.perYear * 90) / 365.25);
    const perDay = Math.max(0, spent90 - recurring90) / 90;
    // Verlauf Tag für Tag
    const start = Number(acc.attributes.current_balance) || 0;
    let bal = start;
    const points = [];
    let low = { value: start, date: t0 };
    const byDay = new Map();
    events.forEach((e) => byDay.set(isoDate(e.date), [...(byDay.get(isoDate(e.date)) || []), e]));
    const salaryDay = range === 'gehalt' && salary?.next ? isoDate(salary.next) : null;
    for (let d = t0; d <= end; d = addDays(d, 1)) {
      if (variable && d > t0) bal -= perDay;
      for (const e of byDay.get(isoDate(d)) || []) bal += e.amount;
      points.push([new Date(d), bal]);
      // tiefster Stand vor dem Gehalt (am Gehaltstag selbst kommt es ja an)
      if (bal < low.value && isoDate(d) !== salaryDay) low = { value: bal, date: new Date(d) };
    }
    const endBal = points.at(-1)[1];
    const cls = low.value < 0 ? 'bad' : low.value < Math.max(100, perDay * 7) ? 'warn' : 'good';
    const verdict = low.value < 0
      ? `Das Konto rutscht voraussichtlich ins Minus: <b>${money(low.value, code)}</b> am ${fmtDate(low.date)}.`
      : cls === 'warn' ? `Es wird knapp: tiefster Stand <b>${money(low.value, code)}</b> am ${fmtDate(low.date)}.`
        : `Reicht: tiefster Stand <b>${money(low.value, code)}</b>${low.date > t0 ? ` am ${fmtDate(low.date)}` : ''}.`;
    meta.textContent = acc.attributes.name;
    el.innerHTML = `
      <div class="r-fc-tools">
        <label>Konto <select class="input select" data-fc-acc>${active.map((a) => `<option value="${esc(a.id)}"${a.id === accId ? ' selected' : ''}>${esc(a.attributes.name)}</option>`).join('')}</select></label>
        <span class="chips small" role="group" aria-label="Zeitraum">${FC_RANGES.map(([k, l]) => `<button type="button" class="chip" data-fc-range="${k}" aria-pressed="${k === range}"${k === 'gehalt' && !salary ? ' disabled title="Kein regelmäßiger Eingang auf diesem Konto erkannt"' : ''}>${l}</button>`).join('')}</span>
        <label class="check"><input type="checkbox" data-fc-var ${variable ? 'checked' : ''}> übrige Ausgaben einrechnen (Ø ${money(perDay, code)}/Tag)</label>
      </div>
      <div class="r-fc-head">
        <div><span class="muted">heute</span><b>${money(start, code)}</b></div>
        <div><span class="muted">${range === 'gehalt' && salary ? `am ${fmtDate(end)} (mit ${esc(salary.name)})` : `am ${fmtDate(end)}`}</span><b>${money(endBal, code)}</b></div>
        <div class="r-fc-verdict ${cls}">${verdict}</div>
      </div>
      <div class="chart-box"><canvas aria-label="Kontostand-Vorschau"></canvas></div>
      <details class="r-fc-events"><summary>${events.length} erwartete Buchungen bis ${fmtDate(end)}${variable ? ` + ca. ${money(perDay * Math.max(0, points.length - 1), code)} übrige Ausgaben` : ''}</summary>
        <div class="table-wrap"><table><tbody>${events.map((e) => `<tr style="cursor:default"><td class="date">${fmtDate(e.date, { weekday: 'short', day: '2-digit', month: '2-digit' })}</td>
          <td>${esc(e.name)}<div class="flow">${esc(e.r.rhythm.label)}</div></td><td class="num ${e.amount > 0 ? 'pos' : ''}">${money(e.amount, code, { signed: true })}</td></tr>`).join('') || '<tr><td>keine</td></tr>'}</tbody></table></div>
      </details>
      <div class="legend" style="margin-top:10px"><span>Grundlage: aktueller Kontostand in Firefly und die erkannten bzw. von dir angelegten regelmäßigen Buchungen dieses Kontos${variable ? ', dazu der Tagesdurchschnitt der übrigen Ausgaben der letzten 90 Tage' : ''}. Umbuchungen zwischen eigenen Konten sind nicht enthalten; was heute fällig ist, kann schon gebucht sein.</span></div>`;
    const step = Math.max(1, Math.ceil(points.length / 90));
    const shown = points.filter((_, i, arr) => i % step === 0 || i === arr.length - 1);
    lineChart(el.querySelector('canvas'), { labels: shown.map(([d]) => d), series: [{ label: acc.attributes.name, data: shown.map(([, v]) => Math.round(v * 100) / 100), color: seriesColor(low.value < 0 ? 1 : 0) }], currency: code });
  };
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-fc-acc]')) {
      accId = e.target.value;
      store('ffd-fc-account', accId);
    } else if (e.target.matches('[data-fc-var]')) {
      variable = e.target.checked;
      store('ffd-fc-variable', variable ? '1' : '0');
    } else return;
    draw();
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fc-range]');
    if (!b || b.disabled) return;
    range = b.dataset.fcRange;
    store('ffd-fc-range', range);
    draw();
  });
  draw();
}
