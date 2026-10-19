// Gemeinsame Bausteine für alle Seiten.

import { money, esc, initials, fmtDateShort } from './util.js';

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

export const card = (id, title, { span = 'span-12', link = '', meta = '', filter = false } = {}) => `
  <section class="card ${span}">
    <div class="card-head"><h2>${esc(title)}</h2>
      <div class="card-tools">${filter ? `<input class="card-filter" type="search" placeholder="Filtern …" aria-label="${esc(title)} filtern" data-target="${id}">` : ''}${link}${meta ? `<span class="meta">${meta}</span>` : ''}</div>
    </div>
    <div id="${id}"></div>
  </section>`;

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
    note.textContent = `Nichts gefunden für „${input.value.trim()}“.`;
  } else note?.remove();
}

export const stat = (label, value, sub = '') => `
  <div class="stat"><span class="label">${esc(label)}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;

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

export function txRow(t) {
  const avatar = t.type === 'transfer' ? ICONS.transfer : esc(initials(counterparty(t)));
  const sub = [fmtDateShort(t.date), t.category_name || counterparty(t)].filter(Boolean).map(esc).join(' · ');
  return `<div class="row">
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
