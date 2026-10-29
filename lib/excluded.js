// Ausgeblendete Buchungen: einzelne Ein- oder Ausgänge (oder alle mit einem Gegenkonto) zählen
// in den Auswertungen nicht mit – z. B. Geld, das über ein Konto nur durchgereicht wird.
// Firefly bleibt unverändert: Der Server nimmt die Buchungen beim Ausliefern aus den Listen
// und rechnet sie aus den Summen (insight/…) heraus. Mit „alle“ (Kopfzeile X-FFD-Alle: 1)
// kommen Listen vollständig, Ausgeblendetes nur markiert (ffd_ausgeblendet) – für die
// Buchungsliste, den CSV-Abgleich, Prüfen und Aufräumen.
//
//   GET    /local/excluded            { rules: […] }
//   POST   /local/excluded            Regel { art: 'buchung', j, info } | { art: 'gegenkonto', name, richtung }
//   DELETE /local/excluded?id=…       Regel entfernen

import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { jsonFile } from './store.js';
import { monthChunks } from '../public/js/chunks.js';

const PAGE_SIZE = 250; // wie public/js/api.js und lib/warmer.js (gleiche Cache-Einträge)
const TX_LIST = /^(transactions|search\/transactions|accounts\/\d+\/transactions|categories\/\d+\/transactions|tags\/[^/]+\/transactions)$/;
const INSIGHT = /^insight\/(expense|income)\/([\w-]+)$/;
const RICHTUNGEN = ['beide', 'eingang', 'ausgang'];
const norm = (s) => String(s ?? '').trim().toLowerCase();
const text = (v, n = 200) => String(v ?? '').slice(0, n);

/** Gegenkonto einer Buchung: bei Eingängen der Absender, sonst der Empfänger. */
export const partnerOf = (t) => (t.type === 'deposit' ? t.source_name : t.destination_name);

export function createExcluded(dataDir, { firefly, log = console.log }) {
  const file = jsonFile(path.join(dataDir, 'excluded.json'), { rules: [] }, { snapshots: true, log });
  let state = null; // { version, journals: Set, partners: Map(name → richtung), rules }
  const load = () => {
    if (state) return state;
    const { rules } = file.read();
    state = {
      version: crypto.randomUUID(),
      rules,
      journals: new Set(rules.filter((r) => r.art === 'buchung').map((r) => String(r.j))),
      partners: new Map(rules.filter((r) => r.art === 'gegenkonto').map((r) => [norm(r.name), r.richtung])),
    };
    return state;
  };
  const active = () => load().rules.length > 0;

  /** Zählt diese Buchung (Split) in den Auswertungen nicht? Nur Ein- und Ausgänge. */
  function isExcluded(t) {
    if (t.type !== 'withdrawal' && t.type !== 'deposit') return false;
    const s = load();
    if (s.journals.has(String(t.transaction_journal_id))) return true;
    const richtung = s.partners.get(norm(partnerOf(t)));
    return richtung === 'beide' || richtung === (t.type === 'deposit' ? 'eingang' : 'ausgang');
  }

  /** Buchungsliste (JSON:API): Ausgeblendetes entfernen – oder mit alle=true nur markieren. */
  function filterList(body, alle) {
    if (!Array.isArray(body?.data)) return body;
    if (alle) {
      for (const g of body.data) for (const t of g.attributes?.transactions || []) if (isExcluded(t)) t.ffd_ausgeblendet = true;
      return body;
    }
    body.data = body.data
      .map((g) => {
        const txs = g.attributes?.transactions;
        if (!txs?.some(isExcluded)) return g;
        return { ...g, attributes: { ...g.attributes, transactions: txs.filter((t) => !isExcluded(t)) } };
      })
      .filter((g) => !g.attributes?.transactions || g.attributes.transactions.length);
    return body;
  }

  /** Alle Buchungen einer Art im Zeitraum, je Kalendermonat (wie Oberfläche und Vorwärmen). */
  async function transactions(start, end, type, opts) {
    const parts = await Promise.all(monthChunks(start, end).map(async ([s, e]) => {
      const out = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const r = await firefly.get('transactions', { start: s, end: e, type, limit: PAGE_SIZE, page }, opts);
        if (r.status !== 200) throw new Error(`Buchungen nicht lesbar (HTTP ${r.status})`);
        const json = JSON.parse(r.body.toString('utf8'));
        pages = json.meta?.pagination?.total_pages || 1;
        out.push(...(json.data || []).flatMap((g) => g.attributes?.transactions || []));
      }
      return out;
    }));
    return parts.flat();
  }

  /** Kann eine Regel den Zeitraum überhaupt betreffen? Spart das Laden der Buchungen. */
  function relevant(kind, start, end) {
    const s = load();
    const richtung = kind === 'expense' ? 'ausgang' : 'eingang';
    if ([...s.partners.values()].some((r) => r === 'beide' || r === richtung)) return true;
    return s.rules.some((r) => r.art === 'buchung' && (!r.info?.date || (r.info.date >= start && r.info.date <= end)));
  }

  /** Summen (insight/…) um ausgeblendete Buchungen bereinigen. */
  async function correctInsight(kind, what, params, list, opts) {
    const start = params.get('start');
    const end = params.get('end');
    if (!Array.isArray(list) || !start || !end || !relevant(kind, start, end)) return list;
    const txs = (await transactions(start, end, kind === 'expense' ? 'withdrawal' : 'deposit', opts)).filter(isExcluded);
    if (!txs.length) return list;
    const sign = kind === 'expense' ? -1 : 1;
    const out = list.map((x) => ({ ...x }));
    const minus = (match, t) => {
      const x = out.find((e) => match(e) && String(e.currency_id ?? '') === String(t.currency_id ?? e.currency_id ?? ''));
      if (!x) return;
      const v = Number(x.difference_float ?? x.difference) || 0;
      const s = v ? Math.sign(v) : sign;
      const rest = Math.max(0, Math.abs(v) - Math.abs(Number(t.amount) || 0));
      x.difference_float = Math.round(s * rest * 100) / 100;
      x.difference = String(x.difference_float);
    };
    const asset = kind === 'expense' ? 'source_id' : 'destination_id';
    const partner = kind === 'expense' ? 'destination_id' : 'source_id';
    for (const t of txs) {
      const id = (field) => (e) => String(e.id) === String(t[field]);
      switch (what) {
        case 'total': minus(() => true, t); break;
        case 'category': if (t.category_id) minus(id('category_id'), t); break;
        case 'no-category': if (!t.category_id) minus(() => true, t); break;
        case 'budget': if (t.budget_id) minus(id('budget_id'), t); break;
        case 'no-budget': if (!t.budget_id) minus(() => true, t); break;
        case 'bill': if (t.bill_id) minus(id('bill_id'), t); break;
        case 'asset': minus(id(asset), t); break;
        case 'expense': case 'revenue': minus(id(partner), t); break;
        case 'tag': for (const tag of t.tags || []) minus((e) => norm(e.name ?? e.tag) === norm(tag), t); break;
        default: break;
      }
    }
    // leer gewordene Einträge weg (die Gesamtsumme bleibt, notfalls mit 0)
    return what === 'total' ? out : out.filter((x) => Math.abs(x.difference_float) >= 0.005);
  }

  // Bereinigte Antworten kurz merken: gleiche Antwort von Firefly + gleiche Regeln → gleiches Ergebnis
  const memo = new Map();
  const remember = (key, value) => {
    memo.set(key, value);
    if (memo.size > 2000) memo.delete(memo.keys().next().value);
    return value;
  };

  /**
   * Wie firefly.get, aber mit ausgeblendeten Buchungen herausgerechnet.
   * alle: Listen vollständig, Ausgeblendetes nur markiert (Summen bleiben bereinigt).
   */
  async function get(apiPath, params, opts = {}) {
    const { alle = false, ...rest } = opts;
    const result = await firefly.get(apiPath, params, rest);
    const single = /^transactions\/\d+$/.test(apiPath);
    const insight = apiPath.match(INSIGHT);
    if (result.status !== 200 || !active() || !(insight || single || TX_LIST.test(apiPath))) return result;
    const q = new URLSearchParams(params);
    const key = `${apiPath}?${q}|${alle || single}|${load().version}|${result.at}`;
    const hit = memo.get(key);
    if (hit && (!insight || Date.now() - hit.made < 60_000)) return { ...result, ...hit };
    const json = JSON.parse(result.body.toString('utf8'));
    let changed;
    if (insight) {
      changed = await correctInsight(insight[1], insight[2], q, json, rest);
    } else if (single) {
      changed = { ...json, data: filterList({ data: [json.data] }, true).data[0] };
    } else {
      changed = filterList(json, alle);
    }
    const body = Buffer.from(JSON.stringify(changed));
    return { ...result, ...remember(key, { body, gz: body.length > 1024 ? zlib.gzipSync(body, { level: 6 }) : null, made: Date.now() }) };
  }

  // ---- Regeln verwalten -----------------------------------------------------------
  const save = (rules) => {
    file.write({ rules });
    state = null;
    memo.clear();
  };

  function clean(input) {
    const id = crypto.randomUUID().slice(0, 12);
    const at = new Date().toISOString();
    if (input?.art === 'buchung') {
      const j = text(input.j, 20);
      if (!/^\d+$/.test(j)) throw new Error('Buchung fehlt.');
      const info = input.info || {};
      return {
        id, at, art: 'buchung', j,
        info: { date: text(info.date, 10), amount: Number(info.amount) || 0, currency: text(info.currency, 3), description: text(info.description), partner: text(info.partner, 120), type: info.type === 'deposit' ? 'deposit' : 'withdrawal' },
        note: text(input.note, 200),
      };
    }
    if (input?.art === 'gegenkonto') {
      const name = text(input.name, 120).trim();
      if (!name) throw new Error('Gegenkonto fehlt.');
      return { id, at, art: 'gegenkonto', name, richtung: RICHTUNGEN.includes(input.richtung) ? input.richtung : 'beide', note: text(input.note, 200) };
    }
    throw new Error('Unbekannte Regel.');
  }

  async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    try {
      if (req.method === 'GET') return json(200, { rules: load().rules });
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) {
          raw += c;
          if (raw.length > 20_000) throw new Error('Zu groß.');
        }
        const rule = clean(raw ? JSON.parse(raw) : {});
        const rules = load().rules.filter((r) => !(r.art === rule.art && (rule.art === 'buchung' ? r.j === rule.j : norm(r.name) === norm(rule.name))));
        if (rules.length >= 2000) throw new Error('Zu viele Regeln.');
        save([...rules, rule]);
        log(`Ausgeblendet: ${rule.art === 'buchung' ? `Buchung ${rule.j}` : `Gegenkonto „${rule.name}“ (${rule.richtung})`}`);
        return json(200, { rules: load().rules, rule });
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        save(load().rules.filter((r) => r.id !== id));
        return json(200, { rules: load().rules });
      }
      return json(405, { message: 'Nicht erlaubt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  }

  return { get, warm: firefly.warm, summary: firefly.summary, invalidate: firefly.invalidate, handle, isExcluded };
}
