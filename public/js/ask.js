// Seite „Fragen“: mit den eigenen Finanzdaten chatten („Wie viel habe ich im letzten
// Monat bei Amazon ausgegeben?“). Die Zahlen rechnet der Dashboard-Server exakt aus
// den Firefly-Buchungen; eine KI (Ollama) übersetzt höchstens die Frage. Jede Antwort
// zeigt, wie die Frage verstanden wurde, und die Buchungen dahinter.

import { money, esc, fmtDate, storage, store } from './util.js';
import { card } from './common.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const EXAMPLES = [
  'Wie viel habe ich im letzten Monat bei Amazon ausgegeben?',
  'Was habe ich dieses Jahr für Lebensmittel ausgegeben im Vergleich zum Vorjahr?',
  'Top 5 Händler der letzten 3 Monate',
  'Zeig mir die größten Ausgaben im letzten Monat',
  'Welche Kategorien kosten im aktuellen Gehaltsmonat am meisten?',
  'Ausgaben für Restaurant pro Monat',
  'Was habe ich im Oktober mehr ausgegeben als im September?',
];
const MODES = [['auto', 'automatisch (KI nur, wenn nötig)'], ['schnell', 'schnell (ohne KI)'], ['ki', 'immer mit KI']];
const HISTORY_KEY = 'ffd-ask-history';

const loadHistory = () => {
  try {
    return JSON.parse(storage(HISTORY_KEY, '[]')) || [];
  } catch {
    return [];
  }
};

export async function askPage(view) {
  let history = loadHistory();
  let mode = MODES.some(([k]) => k === storage('ffd-ask-mode', 'auto')) ? storage('ffd-ask-mode', 'auto') : 'auto';
  let busy = false;
  view.innerHTML = `<div class="grid">${card('q-chat', 'Frag deine Finanzen', { meta: '<span class="muted">Zahlen exakt aus Firefly · nur lesen</span>' })}</div>`;
  const el = view.querySelector('#q-chat');
  el.innerHTML = `
    <div class="ask-log" id="q-log" aria-live="polite"></div>
    <form class="ask-form" id="q-form">
      <input id="q-input" type="text" placeholder="Frag z. B.: Wie viel habe ich im letzten Monat bei Amazon ausgegeben?" autocomplete="off" maxlength="300" aria-label="Frage">
      <button class="btn primary" id="q-send">Fragen</button>
    </form>
    <div class="ask-foot">
      <div class="chips" id="q-examples">${EXAMPLES.map((x) => `<button class="chip small" data-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <label class="sync-set">Verstehen <select id="q-mode">${MODES.map(([k, l]) => `<option value="${k}"${k === mode ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="link-btn" id="q-clear">Verlauf löschen</button>
    </div>`;
  const log = el.querySelector('#q-log');
  const input = el.querySelector('#q-input');

  const filterChips = (a) => {
    const q = a.query || {};
    const chips = [`Zeitraum: ${a.zeitraum}`];
    if (a.vergleich) chips.push(`Vergleich: ${a.vergleich}`);
    if (q.art && q.art !== 'ausgaben') chips.push(q.art === 'einnahmen' ? 'Einnahmen' : 'Ausgaben + Einnahmen');
    for (const h of q.haendler || []) chips.push(`Händler: ${h}`);
    for (const c of q.kategorien || []) chips.push(`Kategorie: ${c}`);
    for (const t of q.tags || []) chips.push(`Tag: ${t}`);
    if (q.text) chips.push(`Text: „${q.text}“`);
    return chips.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ');
  };

  // „Oktober 2026 (01.10.2026 – 31.10.2026)“ → „Oktober 2026“ für Spaltenköpfe
  const short = (label) => String(label || '').replace(/\s*\(.*\)\s*$/, '');
  const details = (a) => {
    const parts = [];
    if (a.diffs?.length) {
      parts.push(`<table class="ask-table"><thead><tr><th>Posten</th><th class="num">${esc(short(a.vergleich) || 'Vergleich')}</th><th class="num">${esc(short(a.zeitraum))}</th><th class="num">Änderung</th></tr></thead>
        <tbody>${a.diffs.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${money(g.prev)}</td><td class="num">${money(g.cur)}</td>
          <td class="num"><b class="${(a.query?.art === 'einnahmen' ? g.diff < 0 : g.diff > 0) ? 'ask-worse' : 'ask-better'}">${g.diff > 0 ? '+' : '−'}${money(Math.abs(g.diff))}</b></td></tr>`).join('')}</tbody></table>`);
    }
    if (a.diffs && (a.same || a.diffsTotal > a.diffs.length)) {
      const bits = [];
      if (a.diffsTotal > a.diffs.length) bits.push(`${a.diffs.length} von ${a.diffsTotal} gezeigt`);
      if (a.same) bits.push(`${a.same} gleich gebliebene Posten ausgeblendet`);
      parts.push(`<div class="muted ask-note">${bits.join(' · ')}</div>`);
    }
    if (a.groups?.length) {
      const max = Math.max(...a.groups.map((g) => g.sum));
      parts.push(`<table class="ask-table"><tbody>${a.groups.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.n}×</td>
        <td><div class="mini-bar"><i style="width:${Math.round((g.sum / max) * 100)}%"></i></div></td><td class="num"><b>${money(g.sum)}</b></td></tr>`).join('')}</tbody></table>`);
    }
    if (a.months?.length) {
      const max = Math.max(...a.months.map((g) => g.sum));
      parts.push(`<table class="ask-table"><tbody>${a.months.map((g) => `<tr><td>${esc(fmtDate(`${g.name}-15`, { month: 'short', year: 'numeric' }))}</td>
        <td><div class="mini-bar"><i style="width:${Math.round((g.sum / max) * 100)}%"></i></div></td><td class="num"><b>${money(g.sum)}</b></td></tr>`).join('')}</tbody></table>`);
    }
    if (a.hits?.length) {
      parts.push(`<details class="ask-hits"${a.query?.auswertung === 'liste' || a.query?.auswertung === 'groesste' ? ' open' : ''}><summary>${a.n > a.hits.length ? `${a.hits.length} von ${a.n}` : a.hits.length} Buchung${a.hits.length === 1 ? '' : 'en'} ansehen</summary>
        <table class="ask-table"><tbody>${a.hits.map((t) => `<tr><td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(t.merchant || t.party || t.description)}</div><div class="flow">${esc(t.description)}${t.category ? ` · ${esc(t.category)}` : ''}</div></td>
          <td class="num">${money(t.type === 'deposit' ? t.amount : -t.amount)}</td></tr>`).join('')}</tbody></table></details>`);
    }
    return parts.join('');
  };

  const render = () => {
    log.innerHTML = history.length ? history.map((m) => (m.role === 'user'
      ? `<div class="ask-msg user">${esc(m.text)}</div>`
      : m.error
        ? `<div class="ask-msg bot error">${esc(m.error)}</div>`
        : `<div class="ask-msg bot"><div class="ask-answer">${esc(m.a.antwort)}</div>
            <div class="ask-meta">${filterChips(m.a)} <span class="muted">· ${m.a.how === 'ki' ? 'mit KI verstanden' : 'ohne KI verstanden'}</span></div>
            ${m.a.note ? `<div class="muted ask-note">${esc(m.a.note)}</div>` : ''}
            ${details(m.a)}</div>`)).join('')
      : `<div class="empty">Stell eine Frage zu deinen Ausgaben und Einnahmen – z. B. nach Händler, Kategorie, Tag, Zeitraum, Top-Listen oder Verlauf.
          Die Zahlen kommen exakt aus Firefly; die KI hilft nur beim Verstehen ungewöhnlicher Fragen.</div>`;
    log.scrollTop = log.scrollHeight;
  };
  const save = () => store(HISTORY_KEY, JSON.stringify(history.slice(-40)));

  async function send(text) {
    const frage = text.trim();
    if (!frage || busy) return;
    busy = true;
    input.value = '';
    history.push({ role: 'user', text: frage });
    render();
    log.insertAdjacentHTML('beforeend', `<div class="ask-msg bot pending">${mode === 'ki' ? 'Frage wird mit der KI verstanden – das kann je nach Modell dauern …' : 'Rechne …'}</div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const res = await fetch('/local/ai/ask', { method: 'POST', headers, body: JSON.stringify({ frage, modus: mode }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      history.push({ role: 'bot', a: body });
    } catch (err) {
      history.push({ role: 'bot', error: `Konnte nicht beantwortet werden: ${err.message}` });
    }
    busy = false;
    save();
    render();
    input.focus();
  }

  el.querySelector('#q-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send(input.value);
  });
  el.querySelector('#q-examples').addEventListener('click', (e) => {
    const ex = e.target.closest('[data-example]');
    if (ex) send(ex.dataset.example);
  });
  el.querySelector('#q-mode').addEventListener('change', (e) => {
    mode = e.target.value;
    store('ffd-ask-mode', mode);
  });
  el.querySelector('#q-clear').addEventListener('click', () => {
    history = [];
    save();
    render();
  });
  render();
  input.focus();
}
