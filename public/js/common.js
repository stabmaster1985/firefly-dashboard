// Gemeinsame Bausteine für alle Seiten.

import { money, esc, initials, fmtDate, fmtDateShort, storage, store } from './util.js';
import { enhanceTxEdit } from './txedit.js';
import { enhanceExclude } from './excluded.js';
import { CARDS } from './help.js';

// ---------------------------------------------------------------------------
// Bausteine

export const ICONS = {
  transfer: '<svg viewBox="0 0 24 24"><path d="M7 7h13M7 7l3-3M7 7l3 3M17 17H4m13 0-3-3m3 3-3 3"/></svg>',
};

export const skeleton = (lines = 3, height = 18) =>
  Array.from({ length: lines }, () => `<div class="skeleton" style="height:${height}px;margin:10px 0"></div>`).join('');

/** Lädt Daten für einen Bereich und zeigt bis dahin einen Platzhalter. */
export async function fill(slot, loader, render, placeholder = skeleton()) {
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

// Eingeklappte Karten – je Seite und Gerät gemerkt (Schlüssel: Seite ohne Parameter + Karten-ID)
const FOLD_KEY = 'ffd-folded';
const foldedSet = () => {
  try {
    return new Set(JSON.parse(storage(FOLD_KEY, '[]')));
  } catch {
    return new Set();
  }
};
export const foldKey = (id) => `${(location.hash || '#/').split('?')[0].replace(/\/\d+$/, '/:id')}|${id}`;
export function setFolded(section, folded) {
  const id = section.dataset.fold;
  if (!id) return;
  section.classList.toggle('folded', folded);
  section.querySelector('.card-fold')?.setAttribute('aria-expanded', String(!folded));
  const set = foldedSet();
  if (folded) set.add(foldKey(id));
  else set.delete(foldKey(id));
  store(FOLD_KEY, JSON.stringify([...set].slice(-300)));
}

export const card = (id, title, { span = 'span-12', link = '', meta = '', filter = false } = {}) => {
  const folded = foldedSet().has(foldKey(id));
  return `
  <section class="card ${span}${folded ? ' folded' : ''}" data-fold="${esc(id)}">
    <div class="card-head"><h2><button type="button" class="card-fold" aria-expanded="${!folded}" aria-controls="${esc(id)}" title="Ein-/ausklappen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg><span>${esc(title)}</span></button></h2>
      <div class="card-tools">${filter ? `<input class="card-filter" type="search" placeholder="Filtern …" aria-label="${esc(title)} filtern" data-target="${id}">` : ''}${link}${meta ? `<span class="meta">${meta}</span>` : ''}${CARDS[id] ? `<button class="help-btn" data-help="card:${id}" aria-label="Hilfe zu „${esc(title)}“" title="Was ist das?">?</button>` : ''}</div>
    </div>
    <div id="${id}"></div>
  </section>`;
};

/** Suchbegriffe: mehrere durch Komma getrennt, ein Treffer reicht (ODER). */
export function termsMatcher(text) {
  const terms = String(text || '').toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  return (value) => !terms.length || terms.some((t) => String(value).toLowerCase().includes(t));
}

const FILTERABLE = 'tbody > tr:not(.details), .list > .row, .bars > .bar-row, .tiles > .tile';

/** Blendet Zeilen einer Karte aus, die nicht zum Filterfeld passen. */
export function applyCardFilter(input) {
  const target = document.getElementById(input.dataset.target);
  if (!target) return;
  const match = termsMatcher(input.value);
  let shown = 0;
  let total = 0;
  target.querySelectorAll(FILTERABLE).forEach((el) => {
    total += 1;
    const ok = match(el.textContent);
    el.hidden = !ok;
    if (ok) shown += 1;
    // aufgeklappte Details gehören zur Zeile darüber
    if (el.nextElementSibling?.classList.contains('details')) el.nextElementSibling.hidden = !ok;
  });
  let note = target.querySelector(':scope > .filter-empty');
  if (input.value.trim() && total && !shown) {
    if (!note) target.insertAdjacentHTML('beforeend', '<div class="empty filter-empty"></div>');
    note = target.querySelector(':scope > .filter-empty');
    const text = `Nichts gefunden für „${input.value.trim()}“.`;
    // nur bei Änderung schreiben – sonst würde der MutationObserver endlos neu filtern
    if (note.textContent !== text) note.textContent = text;
  } else note?.remove();
}

// Kennzahl-Kacheln: Symbol und Bedeutungsfarbe ergeben sich aus der Beschriftung – überall gleich
const STAT_KINDS = [
  [/einnahm|eingäng|eingang/i, 'income', '<path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'],
  [/vermögen|gespart|kontostand/i, 'wealth', '<path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 9l2-4h12l2 4M15 14h2"/>'],
  [/ausgab|ausgäng|verzichtbar/i, 'expense', '<path d="M12 15V4m0 0L8 8m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'],
  [/saldo|veränder/i, 'balance', '<path d="M12 4v16M5 8h14M5 8l-2 6a3 3 0 0 0 4 0zm14 0-2 6a3 3 0 0 0 4 0z"/>'],
  [/ohne kategorie|offen/i, 'warn', '<path d="M12 9v4m0 3h.01"/><path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/>'],
  [/kategorisiert|getaggt|tags|erkannt/i, 'tag', '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>'],
  [/händler|top/i, 'merchant', '<path d="M4 9l1.5-5h13L20 9M4 9h16M4 9v1a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0V9M5 12v8h14v-8"/>'],
  [/monat|jahr|tage|zuletzt|neu/i, 'time', '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4m6-4v4"/>'],
  [/./, 'count', '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'],
];
export const stat = (label, value, sub = '') => {
  const [, kind, icon] = STAT_KINDS.find(([re]) => re.test(label));
  return `<div class="stat stat-${kind}"><span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></span><span class="label">${esc(label)}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;
};

export function counterparty(t) {
  if (t.type === 'deposit') return t.source_name;
  if (t.type === 'transfer') return `${t.source_name} → ${t.destination_name}`;
  return t.destination_name;
}

export function signedAmount(t) {
  const code = t.currency_code;
  if (t.type === 'withdrawal') return `<span class="neg">${money(-t.amount, code)}</span>`;
  if (t.type === 'deposit') return `<span class="pos">${money(t.amount, code, { signed: true })}</span>`;
  return `<span class="neutral">${money(t.amount, code)}</span>`;
}

// ---------------------------------------------------------------------------
// Buchungsdetails – überall gleich: Zeile mit data-tx anklicken klappt sie auf

const TX_TYPES = { withdrawal: 'Ausgabe', deposit: 'Einnahme', transfer: 'Umbuchung', 'opening balance': 'Eröffnungssaldo', reconciliation: 'Abgleich' };
const OWN_ACCOUNT = /^(Asset account|Loan|Debt|Mortgage)$/;

/** Link zu einer Buchung in Firefly (show oder edit), leer ohne bekannte Firefly-Adresse. */
export function fireflyTxUrl(t, mode = 'show') {
  const ff = window.FFD_CONFIG?.fireflyUrl;
  return ff && t.groupId ? `${ff}/transactions/${mode}/${encodeURIComponent(t.groupId)}` : '';
}

/** Detailliste einer Buchung (alle vorhandenen Felder) mit Links in Firefly. */
export function txDetails(t) {
  const account = (name, id, type) => {
    if (!name) return null;
    // eigene Konten → Kontoseite, sonst die Seite des Empfängers/Zahlers
    const href = id && OWN_ACCOUNT.test(type || '') ? `#/konten/${encodeURIComponent(id)}` : `#/empfaenger/${encodeURIComponent(name)}`;
    return `<a class="plain" href="${href}">${esc(name)}</a>`;
  };
  const iban = (v) => (v ? ` <span class="muted">${esc(v)}</span>` : '');
  const time = /T(\d{2}:\d{2})/.exec(String(t.date))?.[1];
  const extraDates = [['Buchungsdatum', t.book_date], ['Wertstellung', t.process_date], ['Zinsdatum', t.interest_date],
    ['Zahlungsdatum', t.payment_date], ['Rechnungsdatum', t.invoice_date], ['Fällig', t.due_date]];
  const fields = [
    ['Beschreibung', t.description && `<span class="pre">${esc(t.description)}</span>`],
    ['Datum', `${esc(fmtDate(t.date))}${time && time !== '00:00' ? ` ${time}` : ''}`],
    ['Art', esc(TX_TYPES[t.type] || t.type)],
    ['Betrag', `${signedAmount(t)}${t.foreign_amount && Number(t.foreign_amount) ? ` <span class="muted">(${money(Math.abs(Number(t.foreign_amount)), t.foreign_currency_code)})</span>` : ''}`],
    ['Von', t.source_name && `${account(t.source_name, t.source_id, t.source_type)}${iban(t.source_iban)}`],
    ['An', t.destination_name && `${account(t.destination_name, t.destination_id, t.destination_type)}${iban(t.destination_iban)}`],
    ['Kategorie', t.category_name
      ? `<a class="plain" href="#/kategorien/${encodeURIComponent(t.category_id ?? '0')}">${esc(t.category_name)}</a>`
      : t.type === 'withdrawal' ? '<a class="plain" href="#/kategorien/0">Ohne Kategorie</a>' : null],
    ['Budget', t.budget_name && esc(t.budget_name)],
    ['Rechnung', t.bill_name && esc(t.bill_name)],
    ['Tags', (t.tags || []).length ? t.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('') : null],
    ['Notizen', t.notes && `<span class="pre">${esc(t.notes)}</span>`],
    ['Gruppe', t.groupTitle && esc(t.groupTitle)],
    ...extraDates.map(([k, v]) => [k, v && esc(fmtDate(v))]),
    ['Referenz', t.internal_reference && esc(t.internal_reference)],
    ['Externe ID', t.external_id && esc(t.external_id)],
    ['SEPA', [t.sepa_ct_id && `End-to-End ${t.sepa_ct_id}`, t.sepa_ep && `Zweck ${t.sepa_ep}`, t.sepa_ci && `Gläubiger-ID ${t.sepa_ci}`, t.sepa_db && `Mandat ${t.sepa_db}`]
      .filter(Boolean).map(esc).join(' · ') || null],
    ['Herkunft', t.original_source && esc(t.original_source)],
    ['ID', esc(`Buchung ${t.groupId ?? '–'}${t.transaction_journal_id && t.transaction_journal_id !== t.groupId ? ` · Journal ${t.transaction_journal_id}` : ''}`)],
  ].filter(([, v]) => v);
  const show = fireflyTxUrl(t);
  const links = show
    ? `<div class="tx-links"><a class="btn small" href="${esc(show)}" target="_blank" rel="noopener">In Firefly öffnen ↗</a>
       <a class="btn small" href="${esc(fireflyTxUrl(t, 'edit'))}" target="_blank" rel="noopener">In Firefly bearbeiten ↗</a></div>`
    : '';
  return `<dl>${fields.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl><div class="tx-edit"></div><div class="tx-edit tx-exclude"></div>${links}`;
}

/**
 * Macht Buchungszeilen in host aufklappbar: Zeilen tragen data-tx="<Schlüssel>",
 * getTx(schlüssel) liefert die Buchung. Darf bei jedem Neuzeichnen erneut
 * aufgerufen werden – es bleibt bei einem Listener, getTx wird ersetzt.
 */
export function bindTxDetails(host, getTx) {
  if (!host) return;
  const bound = Boolean(host.txGet);
  host.txGet = getTx;
  if (bound) return;
  const toggle = (row) => {
    const next = row.nextElementSibling;
    if (next?.classList.contains('details')) {
      next.remove();
      return row.setAttribute('aria-expanded', 'false');
    }
    const t = host.txGet(row.dataset.tx);
    if (!t) return;
    row.insertAdjacentHTML('afterend', row.tagName === 'TR'
      ? `<tr class="details"><td colspan="${row.cells.length}"></td></tr>`
      : '<div class="details"></div>');
    const box = row.tagName === 'TR' ? row.nextElementSibling.firstElementChild : row.nextElementSibling;
    // nach einer Änderung per n8n neu zeichnen, mit Bestätigung
    const draw = (note) => {
      box.innerHTML = txDetails(t);
      if (note) box.querySelector('.tx-edit').insertAdjacentHTML('beforebegin', `<p class="tx-edit-status good">${note}</p>`);
      enhanceTxEdit(box.querySelector('.tx-edit'), t, () => draw('✓ In Firefly geändert – Listen zeigen es nach dem nächsten Laden.'));
      enhanceExclude(box.querySelector('.tx-exclude'), t);
    };
    draw();
    row.setAttribute('aria-expanded', 'true');
  };
  host.addEventListener('click', (e) => {
    const row = e.target.closest('[data-tx]');
    if (!row || !host.contains(row) || e.target.closest('a, button, input, select, label')) return;
    toggle(row);
  });
  host.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('[data-tx]');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle(row);
    }
  });
}

/** Attribute für eine aufklappbare Buchungszeile. */
export const txAttrs = (key) => `data-tx="${esc(String(key))}" tabindex="0" aria-expanded="false"`;

export function txRow(t, i) {
  const avatar = t.type === 'transfer' ? ICONS.transfer : esc(initials(counterparty(t)));
  const sub = [fmtDateShort(t.date), t.category_name || counterparty(t)].filter(Boolean).map(esc).join(' · ');
  return `<div class="row"${i === undefined ? '' : ` ${txAttrs(i)}`}>
    <div class="avatar">${avatar}</div>
    <div style="min-width:0"><div class="title">${esc(t.description)}</div><div class="subtitle">${sub}</div></div>
    <div class="amount">${signedAmount(t)}</div>
  </div>`;
}

/** Liefert die häufigste Währung einer Liste – für Mehrwährungs-Daten. */
export function mainCurrency(items, key = 'currency_code') {
  const counts = new Map();
  for (const it of items) counts.set(it[key], (counts.get(it[key]) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
}

export const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);

/** Lädt eine CSV-Datei herunter – Semikolon + Dezimalkomma, damit Excel sie direkt öffnet. */
export function downloadCsv(filename, rows) {
  const cell = (v) => (typeof v === 'number' ? v.toFixed(2).replace('.', ',') : `"${String(v ?? '').replace(/"/g, '""')}"`);
  const text = `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Auswahlliste mit Häkchen und Suchfeld (z. B. „welche Kategorien?“).
 * items: [{ id, name, hint }], selected: Set der IDs (leer = alle).
 */
export function multiSelect(host, { label, items, selected, onChange }) {
  const sel = new Set(selected);
  const summary = () => (sel.size ? `${label}: ${sel.size} gewählt` : `${label}: alle`);
  host.innerHTML = `<div class="ms">
    <button type="button" class="chip ms-btn" aria-haspopup="true" aria-expanded="false" aria-pressed="${sel.size > 0}">${esc(summary())} ▾</button>
    <div class="ms-pop" hidden>
      <input type="search" class="ms-search" placeholder="Suchen …" aria-label="${esc(label)} suchen">
      <div class="ms-actions"><button type="button" class="link-btn" data-ms="all">Alle</button> · <button type="button" class="link-btn" data-ms="top">Top 10</button> · <button type="button" class="link-btn" data-ms="none">Zurücksetzen</button></div>
      <div class="ms-list">${items
        .map((it) => `<label class="ms-item"><input type="checkbox" value="${esc(it.id)}"${sel.has(it.id) ? ' checked' : ''}><span>${esc(it.name)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</label>`)
        .join('')}</div>
    </div></div>`;
  const btn = host.querySelector('.ms-btn');
  const pop = host.querySelector('.ms-pop');
  const boxes = [...host.querySelectorAll('.ms-item input')];
  const update = () => {
    btn.textContent = `${summary()} ▾`;
    btn.setAttribute('aria-pressed', String(sel.size > 0));
    onChange(new Set(sel));
  };
  const setAll = (ids) => {
    sel.clear();
    ids.forEach((id) => sel.add(id));
    boxes.forEach((b) => (b.checked = sel.has(b.value)));
    update();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) host.querySelector('.ms-search').focus();
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  host.querySelector('.ms-search').addEventListener('input', (e) => {
    const match = termsMatcher(e.target.value);
    host.querySelectorAll('.ms-item').forEach((el) => (el.hidden = !match(el.textContent)));
  });
  host.querySelector('.ms-actions').addEventListener('click', (e) => {
    const action = e.target.dataset.ms;
    if (action === 'none') setAll([]);
    else if (action === 'top') setAll(items.slice(0, 10).map((it) => it.id));
    else if (action === 'all') setAll(boxes.filter((b) => !b.closest('.ms-item').hidden).map((b) => b.value));
  });
  boxes.forEach((b) => b.addEventListener('change', () => {
    if (b.checked) sel.add(b.value);
    else sel.delete(b.value);
    update();
  }));
  const close = () => {
    if (!host.isConnected) return document.removeEventListener('click', close);
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('click', close);
}
