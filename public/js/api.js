// Zugriff auf die Firefly-III-API über den lokalen Proxy (/api/...).

import { isoDate } from './util.js';
import { pastMonthChunks, isTxList } from './chunks.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let fresh = false;
let monthStart = 1;
/** Gehaltstag an den Server melden, damit er Gehaltsmonate mit vorlädt. */
export function setMonthStart(day) {
  monthStart = day;
}
/** Beim nächsten Rendern den Server-Cache umgehen (Neu-laden-Knopf). */
export function setFresh(value) {
  fresh = value;
  if (value) {
    memo.clear();
    dismissedP = null; // auch Ausgeblendetes von anderen Geräten neu holen
  }
}

/** Nach einer Änderung in Firefly: Browser-Zwischenspeicher verwerfen. */
export function forget() {
  memo.clear();
}

function query(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === '_alle') continue;
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, v instanceof Date ? isoDate(v) : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// Kurzzeit-Speicher im Browser: Hin- und Herwechseln zwischen Seiten ohne
// erneute Anfragen; gleiche gleichzeitige Anfragen laufen nur einmal.
const memo = new Map();
const MEMO_MS = 3 * 60 * 1000;

/** Summen-Abfragen (insight/…) über mehrere Monate: je Monat holen und addieren – Firefly rechnet
 *  Summen bei jeder Abfrage über alle Buchungen des Zeitraums neu, Monatssummen hält der Server lange. */
function mergeInsight(lists) {
  const out = new Map();
  for (const list of lists) {
    for (const x of Array.isArray(list) ? list : []) {
      const key = `${x.id ?? x.name ?? x.tag ?? ''}|${x.currency_code ?? ''}`;
      const v = Number(x.difference_float ?? x.difference) || 0;
      const cur = out.get(key);
      if (cur) cur.difference_float += v;
      else out.set(key, { ...x, difference_float: v });
    }
  }
  return [...out.values()].map((x) => ({ ...x, difference: String(Math.round(x.difference_float * 100) / 100) }));
}

/**
 * GET über den Proxy. Ausgeblendete Buchungen fehlen in Listen und Summen; mit params._alle
 * kommen Listen vollständig, Ausgeblendetes markiert (t.ffd_ausgeblendet) – für Abgleich & Pflege.
 */
export function get(path, params) {
  if (/^insight\//.test(path) && params?.start && params?.end) {
    const chunks = pastMonthChunks(params.start, params.end);
    if (chunks.length > 1) {
      const url = `/api/${path}${query(params)}#monate`;
      const hit = memo.get(url);
      if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
      const promise = Promise.all(chunks.map(([start, end]) => get(path, { ...params, start, end }))).then(mergeInsight);
      memo.set(url, { promise, at: Date.now() });
      promise.catch(() => memo.delete(url));
      return promise;
    }
  }
  const url = `/api/${path}${query(params)}`;
  const key = params?._alle ? `${url}#alle` : url;
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
  const promise = load(url, { alle: Boolean(params?._alle) });
  memo.set(key, { promise, at: Date.now() });
  promise.catch(() => memo.delete(key));
  if (memo.size > 800) memo.delete(memo.keys().next().value);
  return promise;
}

async function load(url, { alle = false } = {}) {
  let res;
  try {
    const headers = {};
    if (fresh) headers['X-No-Cache'] = '1';
    if (alle) headers['X-FFD-Alle'] = '1';
    if (monthStart > 1) headers['X-Month-Start'] = String(monthStart);
    res = await fetch(url, { headers });
  } catch (err) {
    throw new ApiError(`Dashboard-Server nicht erreichbar (${err.message})`, 0);
  }
  // vom Service Worker aus dem Speicher geliefert → Offline-Hinweis zeigen
  if (res.headers.get('X-FFD-Offline')) window.dispatchEvent(new Event('ffd-offline'));
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

/** Seitengröße für Listen – muss zu lib/warmer.js passen (gleicher Cache-Eintrag). */
const PAGE_SIZE = 250;

/** Holt alle Seiten eines paginierten Endpunkts. */
export async function getAll(path, params = {}) {
  // Buchungen über mehrere Monate: je Monat einzeln – abgeschlossene Monate hält der Server lange
  if (isTxList(path) && params.start && params.end) {
    const chunks = pastMonthChunks(params.start, params.end);
    if (chunks.length > 1) {
      const parts = await Promise.all(chunks.map(([start, end]) => getAllPages(path, { ...params, start, end })));
      return parts.flat();
    }
  }
  return getAllPages(path, params);
}

async function getAllPages(path, params) {
  const first = await get(path, { ...params, limit: PAGE_SIZE, page: 1 });
  const pages = first?.meta?.pagination?.total_pages || 1;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => get(path, { ...params, limit: PAGE_SIZE, page: i + 2 })),
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

// ---------------------------------------------------------------------------
// Ausgeblendete Vorschläge (auf dem Server, damit sie auf allen Geräten gelten)

let dismissedP = null;
const OLD_KEYS = { duplicates: 'ffd-dup-ok', structure: 'ffd-struct-ignore' };

const postDismissed = (body) => fetch('/local/dismissed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' },
  body: JSON.stringify(body),
}).then((r) => r.json());

/** { duplicates: Set, structure: Set } – übernimmt einmalig, was früher nur im Browser lag. */
export function loadDismissed() {
  dismissedP ||= (async () => {
    const data = await fetch('/local/dismissed').then((r) => r.json()).catch(() => ({ duplicates: [], structure: [] }));
    for (const [list, key] of Object.entries(OLD_KEYS)) {
      let old = [];
      try {
        old = JSON.parse(localStorage.getItem(key) || '[]');
      } catch {
        // kein localStorage – nichts zu übernehmen
      }
      if (!old.length) continue;
      const merged = await postDismissed({ list, add: old }).catch(() => null);
      if (merged) {
        data[list] = merged[list];
        try {
          localStorage.removeItem(key);
        } catch {
          // egal – beim nächsten Mal wird nur erneut zusammengeführt
        }
      }
    }
    return { duplicates: new Set(data.duplicates || []), structure: new Set(data.structure || []), reviewed: new Set(data.reviewed || []) };
  })();
  return dismissedP;
}

/** Vorschlag ausblenden (Liste „duplicates“, „structure“ oder „reviewed“); key auch als Liste. */
export async function dismiss(list, key) {
  const sets = await loadDismissed();
  const keys = Array.isArray(key) ? key : [key];
  keys.forEach((k) => sets[list].add(k));
  await postDismissed({ list, add: keys }).catch(() => {});
}

/** Wieder einblenden bzw. „passt so“ zurücknehmen. */
export async function undismiss(list, key) {
  const sets = await loadDismissed();
  const keys = Array.isArray(key) ? key : [key];
  keys.forEach((k) => sets[list].delete(k));
  await postDismissed({ list, remove: keys }).catch(() => {});
}
