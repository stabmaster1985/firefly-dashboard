// Wiederkehrende Zahlungen automatisch erkennen – ohne dass in Firefly
// Verträge/Rechnungen gepflegt sein müssen.

import * as api from './api.js';
import { money, esc, fmtDate, today, startOfMonth, addDays, isoDate, parseDate, storage, store } from './util.js';
import { skeleton, fill, card, stat, mainCurrency, sum } from './common.js';

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
        found.push({
          name,
          party: last.party,
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

/** Lädt die Buchungen der letzten 24 Monate und erkennt Muster (für Seite und Prognose). */
export async function loadRecurring(kind, levelKey = storage('ffd-recurring-level', 'normal')) {
  const t0 = today();
  const from = startOfMonth(t0, -24);
  const groups = await api.getAll('transactions', { start: from, end: t0, type: kind === 'income' ? 'deposit' : 'withdrawal' });
  const txs = api.flattenTransactions(groups).filter((t) => t.type === (kind === 'income' ? 'deposit' : 'withdrawal'));
  const result = detectRecurring(txs, kind, levelKey);
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
      ${card('r-soon', kind === 'income' ? 'Demnächst erwartet' : 'Demnächst fällig', { filter: true, meta: `<span class="chips small" role="group" aria-label="Zeitraum">${RANGES.map((d) => `<a class="chip" href="${hrefWith({ tage: String(d) })}" aria-pressed="${d === days}">${d} Tage</a>`).join('')}</span>` })}
      ${card('r-table', kind === 'income' ? 'Regelmäßige Einnahmen' : 'Regelmäßige Zahlungen', { filter: true, meta: '<span id="r-meta"></span>' })}
    </div>
    <div class="pick-bar r-pick" id="r-pick" hidden></div>`;
  const $ = (id) => view.querySelector(`#${id}`);

  const data = loadRecurring(kind, levelKey);
  data.then(({ stats, from, oldest }) => {
    $('r-diag').textContent = `${stats.transactions} Buchungen seit ${fmtDate(from)} geprüft${oldest ? ` (älteste: ${fmtDate(oldest)})` : ''} · ${stats.found} Muster gefunden`;
  }).catch((err) => ($('r-diag').textContent = `Analyse fehlgeschlagen: ${err.message}`));

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

  fill($('r-table'), () => data, (el, { items, stats, from }) => {
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
          <td><div class="desc">${esc(r.name)}</div><div class="flow">${esc(r.category || 'ohne Kategorie')}${r.via ? ` · über ${esc(r.via)}` : ''} · ${r.count}× seit ${fmtDate(r.first, { month: 'short', year: 'numeric' })}<span class="show-sm"> · ${esc(r.rhythm.label)}</span></div></td>
          <td class="hide-sm">${esc(r.rhythm.label)}<div class="flow">${r.confidence} % sicher</div></td>
          <td class="num"><b>${money(r.amount, r.code)}</b>${r.changed ? `<div class="flow" title="Letzter Betrag weicht ab">zuletzt ${money(r.lastAmount, r.code)}</div>` : ''}</td>
          <td class="num hide-sm">${money(r.perYear / 12, r.code)}</td>
          <td class="num hide-sm">${money(r.perYear, r.code)}</td>
          <td class="hide-sm date">${fmtDate(r.last)}</td>
          <td>${r.active ? `<span class="date">${fmtDate(r.next)}</span>` : '<span class="badge">beendet?</span>'}</td>
        </tr>`;
        })
        .join('')}</tbody>
      <tfoot><tr class="r-sum"><td></td><td colspan="2"><b>Summe</b> <span class="muted">${activeRows.length} aktive${filterNote ? ` · ${esc(filterNote)}` : ''}</span></td><td class="num"></td>
        <td class="num hide-sm"><b>${money(sum(activeRows, (r) => r.perYear) / 12, code)}</b></td><td class="num hide-sm"><b>${money(sum(activeRows, (r) => r.perYear), code)}</b></td><td class="hide-sm"></td><td></td></tr>
        <tr class="r-sum r-sum-sm"><td></td><td colspan="7"><span class="muted">je Monat</span> <b>${money(sum(activeRows, (r) => r.perYear) / 12, code)}</b> · <span class="muted">je Jahr</span> <b>${money(sum(activeRows, (r) => r.perYear), code)}</b></td></tr></tfoot>
      </table></div>
      <div class="legend" style="margin-top:12px"><span>Erkannt anhand regelmäßiger Abstände und ähnlicher Beträge – auch über PayPal & Co. · Zeile anklicken zeigt alle Buchungen · Häkchen: eigene Summe bilden (z. B. alle Versicherungen)</span></div>`;

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
    el.addEventListener('click', (e) => {
      if (e.target.closest('input, label, .pick-cell')) return;
      const tr = e.target.closest('tr[data-href]');
      if (tr) location.hash = tr.dataset.href;
    });
  }, skeleton(8));
}
