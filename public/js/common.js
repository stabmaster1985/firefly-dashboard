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

export const card = (id, title, { span = 'span-12', link = '', meta = '' } = {}) => `
  <section class="card ${span}">
    <div class="card-head"><h2>${esc(title)}</h2>${link}${meta ? `<span class="meta">${meta}</span>` : ''}</div>
    <div id="${id}"></div>
  </section>`;

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
