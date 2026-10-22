// „Fragen“: Fragen an die eigenen Finanzdaten. Die Zahlen rechnet immer das
// Dashboard exakt aus den Firefly-Buchungen – eine KI (Ollama) übersetzt
// höchstens die Frage in eine Abfrage. Ohne KI versteht eine einfache Erkennung
// die häufigsten Fragen selbst. Rein rechnerisch, ohne DOM (Server, Browser, Tests).
//
// Abfrage: { auswertung, art, zeitraum, monat?, jahr?, n?, von?, bis?, vergleich?,
//            haendler: [], kategorien: [], tags: [], text?, limit? }

import { monthModel, isoDate } from './util.js';
import { merchantOf, counterpartyOf } from './rules.js';

export const AUSWERTUNGEN = ['summe', 'anzahl', 'liste', 'groesste', 'top_haendler', 'top_kategorien', 'verlauf'];
export const ZEITRAEUME = ['dieser_monat', 'letzter_monat', 'dieses_jahr', 'letztes_jahr', 'letzte_30_tage', 'letzte_n_monate',
  'monat', 'jahr', 'gehaltsmonat', 'letzter_gehaltsmonat', 'benutzerdefiniert', 'alles'];

const lower = (s) => String(s ?? '').toLowerCase();
const fold = (s) => lower(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const MONATE = ['januar', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
const MONATE_KURZ = ['jan', 'feb', 'mrz', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'];

// ---------------------------------------------------------------------------
// Frage verstehen – ohne KI

/**
 * Häufige Fragen ohne KI verstehen. known: { haendler: [], kategorien: [], tags: [] }.
 * Ergebnis: Abfrage + sicher (true, wenn Zeitraum oder Filter klar erkannt wurden).
 */
export function parseQuestion(question, known = {}, now = new Date()) {
  const q = fold(question);
  const has = (re) => re.test(q);
  // ohne Zeitangabe: die letzten 12 Monate (sagt die Antwort dazu)
  const query = { auswertung: 'summe', art: 'ausgaben', zeitraum: 'letzte_n_monate', n: 12, haendler: [], kategorien: [], tags: [] };
  let sure = false;

  // Zeitraum
  const year = now.getFullYear();
  let m;
  if (has(/letzte[nm]? monat|vormonat|vorigen monat|im letzten monat/)) Object.assign(query, { zeitraum: 'letzter_monat' }), sure = true;
  else if (has(/(dies|aktuell)\w* monat|im monat|bisher im monat/)) Object.assign(query, { zeitraum: 'dieser_monat' }), sure = true;
  else if (has(/letzte[nm]? gehaltsmonat/)) Object.assign(query, { zeitraum: 'letzter_gehaltsmonat' }), sure = true;
  else if (has(/gehaltsmonat/)) Object.assign(query, { zeitraum: 'gehaltsmonat' }), sure = true;
  else if ((m = q.match(/letzte[nm]? (\d{1,2}) monat/))) Object.assign(query, { zeitraum: 'letzte_n_monate', n: Number(m[1]) }), sure = true;
  else if (has(/letzte[nm]? (30 tage|vier wochen|4 wochen)/)) Object.assign(query, { zeitraum: 'letzte_30_tage' }), sure = true;
  else if (has(/letzte[nms]? jahr|vorjahr|im vergangenen jahr/) && !has(/vergleich|gegenueber|als im vorjahr|zum vorjahr/)) Object.assign(query, { zeitraum: 'letztes_jahr' }), sure = true;
  else if (has(/dies\w* jahr|im jahr|bisher|seit jahresbeginn|seit januar/)) Object.assign(query, { zeitraum: 'dieses_jahr' }), sure = true;
  else if (has(/insgesamt|ueberhaupt|jemals|alle zeit/)) Object.assign(query, { zeitraum: 'alles' }), sure = true;
  // Monat mit Namen („im März“, „März 2025“)
  const monthIdx = MONATE.findIndex((n, i) => new RegExp(`\\b(${n}|${MONATE_KURZ[i]}\\.?)\\b`).test(q));
  if (monthIdx >= 0 && !has(/seit januar/)) {
    const y = Number((q.match(/\b(20\d\d)\b/) || [])[1]) || (monthIdx > now.getMonth() ? year - 1 : year);
    Object.assign(query, { zeitraum: 'monat', monat: `${y}-${String(monthIdx + 1).padStart(2, '0')}` });
    sure = true;
  } else if ((m = q.match(/\b(20\d\d)\b/))) {
    Object.assign(query, { zeitraum: 'jahr', jahr: Number(m[1]) });
    sure = true;
  }

  // Art und Auswertung
  if (has(/einnahm|verdien|bekommen|eingegangen|gehalt bekommen|gutschrift/)) query.art = 'einnahmen';
  if (has(/groesst|teuerst|hoechst/)) query.auswertung = 'groesste';
  else if (has(/(top|meist|am meisten).*(kategorie)|welche kategorie|kategorien/)) query.auswertung = 'top_kategorien';
  else if (has(/\btop\b|am meisten|wo .* (geld|ausgegeben)|welche[nr]? (haendler|laeden|geschaefte)|bei wem/)) query.auswertung = 'top_haendler';
  else if (has(/verlauf|pro monat|je monat|monatlich|entwicklung|jeden monat/)) query.auswertung = 'verlauf';
  else if (has(/zeig|liste|welche buchungen|alle buchungen|auflisten/)) query.auswertung = 'liste';
  else if (has(/wie oft|wie viele (mal|buchungen|einkaeufe)|anzahl/)) query.auswertung = 'anzahl';
  const top = q.match(/top\s*(\d{1,2})|(\d{1,2})\s*(groesst|teuerst)/);
  if (top) query.limit = Number(top[1] || top[2]);
  if (has(/vergleich|gegenueber|als im vorjahr|zum vorjahr|mehr als|weniger als/)) query.vergleich = has(/vorjahr|letzte[nms]? jahr/) ? 'vorjahr' : 'vorperiode';

  // Namen aus dem Bestand – längste zuerst, als ganzes Wort
  const findNames = (names) => {
    const out = [];
    let rest = q;
    for (const name of [...new Set(names)].filter((n) => n && n.length >= 3).sort((a, b) => b.length - a.length)) {
      const f = fold(name).replace(/[^a-z0-9& ]+/g, ' ').trim();
      if (!f) continue;
      const re = new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^a-z0-9]+')}($|[^a-z0-9])`);
      if (re.test(rest)) {
        out.push(name);
        rest = rest.replace(re, ' ');
      }
    }
    return out;
  };
  query.kategorien = findNames(known.kategorien || []);
  query.tags = findNames(known.tags || []).filter((t) => !query.kategorien.some((c) => lower(c) === lower(t)));
  query.haendler = findNames(known.haendler || []).filter((h) => ![...query.kategorien, ...query.tags].some((c) => lower(c) === lower(h)));
  // „bei/für X“, wenn X nicht bekannt ist → als Textsuche
  if (!query.haendler.length && !query.kategorien.length && !query.tags.length) {
    const free = q.match(/\b(?:beim|bei der|bei|fuer|an|von|vom)\s+([a-z0-9][a-z0-9&.\- ]{1,30}?)(?=\s+(?:im|in|letzt|dies|seit|aus|ausgegeben|bezahlt|gezahlt|gekauft|eingekauft|gelassen|insgesamt|pro|je|$)|[?.!,]|$)/);
    if (free && !/^(mich|uns|was|wen|dem|den|der|die|das|einen?|einkauf|einkaeufe)$/.test(free[1].trim())) query.text = free[1].trim();
  }
  if (query.haendler.length || query.kategorien.length || query.tags.length) sure = true;
  if (query.zeitraum !== 'letzte_n_monate') delete query.n;
  return { query, sure };
}

// ---------------------------------------------------------------------------
// Abfrage prüfen (auch die einer KI) und Zeitraum auflösen

/** KI-Antwort in eine gültige Abfrage verwandeln (unbekannte Werte verwerfen). */
export function cleanQuery(input = {}) {
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
  const q = {
    auswertung: AUSWERTUNGEN.includes(input.auswertung) ? input.auswertung : 'summe',
    art: ['ausgaben', 'einnahmen', 'beides'].includes(input.art) ? input.art : 'ausgaben',
    zeitraum: ZEITRAEUME.includes(input.zeitraum) ? input.zeitraum : 'dieser_monat',
    haendler: arr(input.haendler), kategorien: arr(input.kategorien), tags: arr(input.tags),
  };
  if (/^\d{4}-\d{2}$/.test(input.monat || '')) q.monat = input.monat;
  if (Number(input.jahr) > 1990 && Number(input.jahr) < 2100) q.jahr = Number(input.jahr);
  if (Number(input.n) > 0) q.n = Math.min(60, Math.round(Number(input.n)));
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.von || '')) q.von = input.von;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.bis || '')) q.bis = input.bis;
  if (['vorjahr', 'vorperiode'].includes(input.vergleich)) q.vergleich = input.vergleich;
  if (input.text) q.text = String(input.text).slice(0, 60);
  if (Number(input.limit) > 0) q.limit = Math.min(50, Math.round(Number(input.limit)));
  if (q.zeitraum === 'monat' && !q.monat) q.zeitraum = 'dieser_monat';
  if (q.zeitraum === 'jahr' && !q.jahr) q.zeitraum = 'dieses_jahr';
  if (q.zeitraum === 'benutzerdefiniert' && !(q.von && q.bis)) q.zeitraum = 'dieser_monat';
  return q;
}

const fmt = (d) => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const atDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Zeitraum → { start, end, label } (Gehaltsmonat mit Gehaltstag). */
export function resolvePeriod(q, now = new Date(), payday = 24) {
  const t = atDay(now);
  const y = t.getFullYear();
  const mo = t.getMonth();
  const r = (start, end, label) => ({ start, end, label: `${label} (${fmt(start)} – ${fmt(end)})` });
  const monthName = (d) => d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  switch (q.zeitraum) {
    case 'letzter_monat': return r(new Date(y, mo - 1, 1), new Date(y, mo, 0), monthName(new Date(y, mo - 1, 1)));
    case 'dieses_jahr': return r(new Date(y, 0, 1), t, `${y} bisher`);
    case 'letztes_jahr': return r(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31), String(y - 1));
    case 'letzte_30_tage': return r(new Date(y, mo, t.getDate() - 29), t, 'letzte 30 Tage');
    case 'letzte_n_monate': return r(new Date(y, mo - (q.n || 3), t.getDate() + 1), t, `letzte ${q.n || 3} Monate`);
    case 'monat': {
      const [yy, mm] = q.monat.split('-').map(Number);
      return r(new Date(yy, mm - 1, 1), new Date(yy, mm, 0), monthName(new Date(yy, mm - 1, 1)));
    }
    case 'jahr': return r(new Date(q.jahr, 0, 1), q.jahr === y ? t : new Date(q.jahr, 11, 31), String(q.jahr));
    case 'gehaltsmonat':
    case 'letzter_gehaltsmonat': {
      const model = monthModel(payday);
      const [s, e] = model.range(model.keyOf(t), q.zeitraum === 'letzter_gehaltsmonat' ? -1 : 0);
      return r(s, e > t ? t : e, q.zeitraum === 'letzter_gehaltsmonat' ? 'letzter Gehaltsmonat' : 'aktueller Gehaltsmonat');
    }
    case 'benutzerdefiniert': return r(new Date(`${q.von}T00:00:00`), new Date(`${q.bis}T00:00:00`), 'Zeitraum');
    case 'alles': return r(new Date(2000, 0, 1), t, 'alles');
    default: return r(new Date(y, mo, 1), t, `${monthName(t)} bisher`);
  }
}

/** Vergleichszeitraum: gleich lang davor bzw. ein Jahr früher. */
export function comparePeriod(p, kind) {
  if (kind === 'vorjahr') {
    const s = new Date(p.start.getFullYear() - 1, p.start.getMonth(), p.start.getDate());
    const e = new Date(p.end.getFullYear() - 1, p.end.getMonth(), p.end.getDate());
    return { start: s, end: e, label: `Vorjahr (${fmt(s)} – ${fmt(e)})` };
  }
  const days = Math.round((p.end - p.start) / 86400000) + 1;
  const e = new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() - 1);
  const s = new Date(e.getFullYear(), e.getMonth(), e.getDate() - days + 1);
  return { start: s, end: e, label: `davor (${fmt(s)} – ${fmt(e)})` };
}

// ---------------------------------------------------------------------------
// Rechnen

/** Passt die Buchung zu den Filtern der Abfrage? */
export function matcher(q) {
  const hs = q.haendler.map(fold);
  const cs = q.kategorien.map(lower);
  const ts = q.tags.map(lower);
  const text = q.text ? fold(q.text) : '';
  return (t) => {
    if (q.art === 'ausgaben' && t.type !== 'withdrawal') return false;
    if (q.art === 'einnahmen' && t.type !== 'deposit') return false;
    if (q.art === 'beides' && t.type === 'transfer') return false;
    if (cs.length && !cs.includes(lower(t.category_name))) return false;
    if (ts.length && !(t.tags || []).some((x) => ts.includes(lower(x)))) return false;
    if (hs.length) {
      const hay = fold(`${counterpartyOf(t)} ${merchantOf(t).name}`);
      if (!hs.some((h) => hay.includes(h))) return false;
    }
    if (text && !fold(`${counterpartyOf(t)} ${t.description} ${t.notes || ''} ${t.category_name || ''}`).includes(text)) return false;
    return true;
  };
}

const inPeriod = (p) => (t) => {
  const d = new Date(`${String(t.date).slice(0, 10)}T00:00:00`);
  return d >= p.start && d <= p.end;
};
const total = (list) => Math.round(list.reduce((s, t) => s + Number(t.amount), 0) * 100) / 100;

/** Abfrage ausführen. txs: Buchungen, die mindestens den Zeitraum (und ggf. Vergleich) abdecken. */
export function runQuery(q, txs, period, compare = null) {
  const match = matcher(q);
  const hits = txs.filter((t) => inPeriod(period)(t) && match(t));
  const result = { query: q, period, n: hits.length, sum: total(hits), hits: [...hits].sort((a, b) => String(b.date).localeCompare(String(a.date))) };
  if (compare) {
    const prev = txs.filter((t) => inPeriod(compare)(t) && match(t));
    result.compare = { period: compare, n: prev.length, sum: total(prev) };
  }
  const group = (keyOf) => {
    const m = new Map();
    for (const t of hits) {
      const k = keyOf(t) || '–';
      const g = m.get(k) || { name: k, n: 0, sum: 0 };
      g.n += 1;
      g.sum += Number(t.amount);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, sum: Math.round(g.sum * 100) / 100 })).sort((a, b) => b.sum - a.sum);
  };
  const limit = q.limit || (q.auswertung === 'liste' ? 50 : 10);
  if (q.auswertung === 'top_haendler') result.groups = group((t) => merchantOf(t).name || counterpartyOf(t)).slice(0, limit);
  if (q.auswertung === 'top_kategorien') result.groups = group((t) => t.category_name || 'ohne Kategorie').slice(0, limit);
  if (q.auswertung === 'verlauf') result.months = group((t) => String(t.date).slice(0, 7)).sort((a, b) => a.name.localeCompare(b.name));
  if (q.auswertung === 'groesste') result.hits = [...hits].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, limit);
  if (q.auswertung === 'liste') result.hits = result.hits.slice(0, limit);
  return result;
}

// ---------------------------------------------------------------------------
// Antwort in Worten

const euro = (v) => `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Was gefragt war, in Worten („bei Amazon“, „für Lebensmittel“ …). */
export function describeFilter(q) {
  const parts = [];
  if (q.haendler.length) parts.push(`bei ${q.haendler.join(' oder ')}`);
  if (q.kategorien.length) parts.push(`in ${q.kategorien.length > 1 ? 'den Kategorien' : 'der Kategorie'} ${q.kategorien.join(', ')}`);
  if (q.tags.length) parts.push(`mit Tag ${q.tags.join(', ')}`);
  if (q.text) parts.push(`mit „${q.text}“`);
  return parts.join(' ');
}

export function answerText(r) {
  const q = r.query;
  const what = q.art === 'einnahmen' ? 'Einnahmen' : q.art === 'beides' ? 'Buchungen' : 'Ausgaben';
  const filter = describeFilter(q);
  const when = r.period.label;
  if (!r.n) return `Keine ${what}${filter ? ` ${filter}` : ''} im Zeitraum ${when} gefunden.`;
  const verb = q.art === 'einnahmen' ? 'eingenommen' : 'ausgegeben';
  let text;
  switch (q.auswertung) {
    case 'anzahl':
      text = `${r.n} ${what}${filter ? ` ${filter}` : ''} im Zeitraum ${when}, zusammen ${euro(r.sum)}.`;
      break;
    case 'top_haendler':
    case 'top_kategorien':
      text = `${q.auswertung === 'top_haendler' ? 'Die Händler' : 'Die Kategorien'} mit den meisten ${what}${filter ? ` ${filter}` : ''} im Zeitraum ${when}: `
        + `${r.groups.slice(0, 5).map((g, i) => `${i + 1}. ${g.name} (${euro(g.sum)})`).join(', ')}. Insgesamt ${euro(r.sum)}.`;
      break;
    case 'verlauf':
      text = `${what}${filter ? ` ${filter}` : ''} je Monat im Zeitraum ${when}: im Schnitt ${euro(r.sum / Math.max(1, r.months.length))}, zusammen ${euro(r.sum)}.`;
      break;
    case 'groesste':
      text = `Die größten ${what}${filter ? ` ${filter}` : ''} im Zeitraum ${when}: ${r.hits.slice(0, 3).map((t) => `${euro(t.amount)} ${merchantOf(t).name || t.description} am ${fmt(new Date(`${String(t.date).slice(0, 10)}T00:00:00`))}`).join(', ')}.`;
      break;
    case 'liste':
      text = `${r.n} ${what}${filter ? ` ${filter}` : ''} im Zeitraum ${when}, zusammen ${euro(r.sum)} – die Liste steht unten.`;
      break;
    default:
      text = `Du hast im Zeitraum ${when}${filter ? ` ${filter}` : ''} ${euro(r.sum)} ${verb} (${r.n} Buchung${r.n === 1 ? '' : 'en'}).`;
  }
  if (r.compare) {
    const diff = r.sum - r.compare.sum;
    const pct = r.compare.sum ? Math.round((diff / r.compare.sum) * 100) : null;
    text += ` Im Vergleich: ${r.compare.period.label} waren es ${euro(r.compare.sum)} – also ${euro(Math.abs(diff))} ${diff >= 0 ? 'mehr' : 'weniger'}${pct !== null ? ` (${diff >= 0 ? '+' : '−'}${Math.abs(pct)} %)` : ''}.`;
  }
  return text;
}

export { isoDate };
