// Zugriff auf die Firefly-III-API über den lokalen Proxy (/api/...).

import { isoDate } from './util.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let fresh = false;
/** Beim nächsten Rendern den Server-Cache umgehen (Neu-laden-Knopf). */
export function setFresh(value) {
  fresh = value;
}

function query(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, v instanceof Date ? isoDate(v) : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export async function get(path, params) {
  let res;
  try {
    res = await fetch(`/api/${path}${query(params)}`, {
      headers: fresh ? { 'X-No-Cache': '1' } : {},
    });
  } catch (err) {
    throw new ApiError(`Dashboard-Server nicht erreichbar (${err.message})`, 0);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Firefly liefert bei manchen Fehlern HTML
  }
  if (!res.ok) {
    const msg = body?.message || body?.exception || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body;
}

/** Holt alle Seiten eines paginierten Endpunkts. */
export async function getAll(path, params = {}) {
  const first = await get(path, { ...params, limit: 100, page: 1 });
  const pages = first?.meta?.pagination?.total_pages || 1;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => get(path, { ...params, limit: 100, page: i + 2 })),
  );
  return [first, ...rest].flatMap((r) => r?.data || []);
}

/**
 * summary/basic liefert Schlüssel wie "spent-in-EUR". Ergibt eine Liste
 * je Währung, die Hauptwährung (höchster Betrag) zuerst.
 */
export function summaryValues(summary, prefix) {
  return Object.entries(summary || {})
    .filter(([key]) => key.startsWith(`${prefix}-in-`))
    .map(([, v]) => ({ value: Number(v.monetary_value), code: v.currency_code }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/** Zerlegt Transaktionsgruppen in einzelne Buchungen (Splits). */
export function flattenTransactions(groups) {
  return (groups || []).flatMap((g) =>
    (g.attributes?.transactions || []).map((t, i, all) => ({
      groupId: g.id,
      groupTitle: all.length > 1 ? g.attributes.group_title : null,
      ...t,
      amount: Number(t.amount),
    })),
  );
}
