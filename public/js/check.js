// Prüfen: mögliche doppelte Buchungen und Import-Status je Konto –
// hilft, Fehler beim (CSV-)Import früh zu bemerken.

import * as api from './api.js';
import { money, esc, fmtDate, today, addDays, startOfMonth } from './util.js';
import { skeleton, fill, card, txAttrs, bindTxDetails, signedAmount, counterparty } from './common.js';
import { actionFor, runAction } from './txedit.js';

const DAY = 86400000;

/** Ausgaben und Einnahmen der letzten 24 Monate (gleicher, vorgewärmter Cache wie „Wiederkehrend“). */
export function loadHistory() {
  const t0 = today();
  const from = startOfMonth(t0, -24);
  return Promise.all(['withdrawal', 'deposit'].map((type) =>
    api.getAll('transactions', { start: from, end: t0, type })
      .then((groups) => api.flattenTransactions(groups).filter((t) => t.type === type))))
    .then((lists) => lists.flat());
}

// ---------------------------------------------------------------------------
// Doppelte Buchungen

const dayOf = (t) => Math.floor(new Date(String(t.date).slice(0, 10)).getTime() / DAY);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const pairKey = (a, b) => [a.transaction_journal_id, b.transaction_journal_id].sort().join('-');


/**
 * Paare gleicher Buchungen (Art, Betrag, Konten, Währung) höchstens 3 Tage
 * auseinander. Stufe: „sicher“ (gleiche Referenz/externe ID), „wahrscheinlich“
 * (gleicher Text am selben Tag), sonst „möglich“.
 */
export function findDuplicates(txs, ok = new Set()) {
  const groups = new Map();
  for (const t of txs) {
    const key = [t.type, Math.abs(t.amount).toFixed(2), t.currency_code, t.source_id ?? t.source_name, t.destination_id ?? t.destination_name].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const pairs = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => dayOf(a) - dayOf(b));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && dayOf(list[j]) - dayOf(list[i]) <= 3; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.groupId === b.groupId || ok.has(pairKey(a, b))) continue;
        const ref = (t) => t.external_id || t.internal_reference || t.sepa_ct_id || '';
        // unterschiedliche Bank-Referenzen → zwei echte Buchungen
        if (ref(a) && ref(b) && ref(a) !== ref(b)) continue;
        const level = ref(a) && ref(a) === ref(b) ? 3 : norm(a.description) === norm(b.description) && dayOf(a) === dayOf(b) ? 2 : 1;
        pairs.push({ a, b, level, key: pairKey(a, b) });
      }
    }
  }
  return pairs.sort((x, y) => y.level - x.level || String(y.a.date).localeCompare(String(x.a.date)));
}

const LEVEL = { 3: ['sicher', 'bad'], 2: ['wahrscheinlich', 'warn'], 1: ['möglich', ''] };

// ---------------------------------------------------------------------------
// Import-Status

/**
 * Letzte Buchung je aktivem Konto und ob sie überfällig wirkt: länger her als
 * das Dreifache des üblichen Abstands zwischen Buchungstagen (mind. 7, max. 60 Tage).
 */
export async function importStatus(history) {
  const accounts = (await api.getAll('accounts', { type: 'asset' })).filter((a) => a.attributes.active !== false);
  const t0 = today();
  const since = addDays(t0, -180);
  return Promise.all(accounts.map(async (a) => {
    const res = await api.get(`accounts/${a.id}/transactions`, { limit: 1, page: 1 }).catch(() => null);
    const last = res?.data?.[0]?.attributes?.transactions?.[0]?.date || null;
    const days = [...new Set(history
      .filter((t) => (String(t.source_id) === a.id || String(t.destination_id) === a.id) && new Date(t.date) >= since)
      .map(dayOf))].sort((x, y) => x - y);
    const gaps = days.slice(1).map((d, i) => d - days[i]).sort((x, y) => x - y);
    const typical = gaps.length >= 4 ? gaps[Math.floor(gaps.length / 2)] : null;
    const limit = typical === null ? 60 : Math.min(60, Math.max(7, typical * 3));
    const ago = last ? Math.round((t0 - new Date(String(last).slice(0, 10))) / DAY) : null;
    return {
      id: a.id,
      name: a.attributes.name,
      last,
      ago,
      typical,
      count: days.length,
      overdue: ago === null ? false : ago > limit,
      limit,
    };
  }));
}

// ---------------------------------------------------------------------------
// Hinweise für die Übersicht

export async function checkHints() {
  const [history, dismissed] = await Promise.all([loadHistory(), api.loadDismissed()]);
  const [dups, status] = await Promise.all([findDuplicates(history, dismissed.duplicates), importStatus(history)]);
  const rows = [];
  const serious = dups.filter((d) => d.level >= 2).length;
  if (dups.length) {
    rows.push({ icon: '2×', cls: 'hint-dup', title: `${dups.length} mögliche doppelte Buchung${dups.length === 1 ? '' : 'en'}`, sub: serious ? `${serious} davon wahrscheinlich – prüfen →` : 'Prüfen →' });
  }
  for (const s of status.filter((x) => x.overdue)) {
    rows.push({ icon: '⟳', cls: 'hint-import', title: `${s.name}: seit ${s.ago} Tagen keine Buchung`, sub: 'Import vergessen? Prüfen →' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Seite

export async function check(view) {
  view.innerHTML = `
    <div class="grid">
      ${card('c-import', 'Import-Status je Konto', { meta: '<span id="c-import-meta"></span>' })}
      ${card('c-dup', 'Mögliche doppelte Buchungen', { filter: true, meta: '<span id="c-dup-meta">letzte 24 Monate · Ausgaben & Einnahmen</span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  const history = loadHistory();

  fill($('c-import'), () => Promise.all([history.then(importStatus), actionFor('import')]), (el, [status, action]) => {
    const overdue = status.filter((s) => s.overdue);
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Konto</th><th>Letzte Buchung</th><th class="hide-sm">Üblicher Abstand</th><th>Status</th></tr></thead>
      <tbody>${status.map((s) => `<tr data-href="#/konten/${encodeURIComponent(s.id)}">
        <td><a class="plain" href="#/konten/${encodeURIComponent(s.id)}"><b>${esc(s.name)}</b></a></td>
        <td class="date">${s.last ? `${fmtDate(s.last)} <span class="muted">(${s.ago === 0 ? 'heute' : `vor ${s.ago} Tag${s.ago === 1 ? '' : 'en'}`})</span>` : '–'}</td>
        <td class="hide-sm">${s.typical === null ? '<span class="muted">selten genutzt</span>' : `alle ${s.typical} Tag${s.typical === 1 ? '' : 'e'}`}</td>
        <td>${s.last === null ? '<span class="badge">keine Buchungen</span>' : s.overdue ? `<span class="badge bad">überfällig</span>` : '<span class="badge good">aktuell</span>'}</td>
      </tr>`).join('')}</tbody></table></div>
      <div class="legend" style="margin-top:12px"><span>„Überfällig“: länger keine Buchung als das Dreifache des üblichen Abstands (mind. 7, höchstens 60 Tage).</span></div>
      <div class="import-run">${action
        ? `<button class="btn primary" id="c-import-run">▶ ${esc(action.name)}</button><span class="muted">Automation „Import starten“</span><div class="run-out" id="c-import-out"></div>`
        : '<span class="muted">Tipp: Eine Automation mit Auslöser „Import starten“ (z. B. dein n8n-Workflow für die Bank-CSV) erscheint hier als Knopf.</span>'}</div>`;
    $('c-import-meta').textContent = overdue.length ? `${overdue.length} überfällig` : 'alles aktuell';
    el.querySelector('tbody').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-href]');
      if (tr) location.hash = tr.dataset.href;
    });
    el.querySelector('#c-import-run')?.addEventListener('click', async (e) => {
      const btn = e.target;
      const out = el.querySelector('#c-import-out');
      btn.disabled = true;
      out.textContent = 'Läuft …';
      const res = await runAction(action, { typ: 'import', konten_ueberfaellig: overdue.map((s) => s.name) })
        .catch((err) => ({ ok: false, response: err.message }));
      btn.disabled = false;
      out.innerHTML = res.ok
        ? '<span class="badge good">Gestartet ✓</span> <span class="muted">Neue Buchungen erscheinen nach dem Import (ggf. „Neu laden“).</span>'
        : `<span class="badge bad">Fehler ${esc(res.status || '')}</span> <span class="muted">${esc(String(res.response || '').slice(0, 200))}</span>`;
    });
  }, skeleton(4));

  fill($('c-dup'), () => Promise.all([history, api.loadDismissed()]), (el, [txs, dismissed]) => {
    const render = () => {
      const pairs = findDuplicates(txs, dismissed.duplicates);
      $('c-dup-meta').textContent = `${pairs.length} Treffer · letzte 24 Monate`;
      if (!pairs.length) return (el.innerHTML = '<div class="empty">Keine doppelten Buchungen gefunden. 🎉</div>');
      const flat = pairs.flatMap((p) => [p.a, p.b]);
      el.innerHTML = `<div class="table-wrap"><table><tbody>${pairs.map((p, i) => {
        const [label, cls] = LEVEL[p.level];
        const row = (t, k) => `<tr ${txAttrs(k)} class="dup-row">
          <td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterparty(t))} · Buchung ${esc(t.groupId)}</div></td>
          <td class="num">${signedAmount(t)}</td></tr>`;
        return `<tr class="dup-head"><td colspan="3"><span class="badge ${cls}">${label}</span>
            <span class="muted">${esc(money(Math.abs(p.a.amount), p.a.currency_code))} · ${esc(counterparty(p.a))}</span>
            <button class="link-btn" data-ok="${esc(p.key)}">Kein Duplikat</button></td></tr>
          ${row(p.a, i * 2)}${row(p.b, i * 2 + 1)}`;
      }).join('')}</tbody></table></div>
      <div class="legend" style="margin-top:12px"><span>Zeile anklicken → Details mit „In Firefly öffnen“, dort die überzählige Buchung löschen.
        „Kein Duplikat“ blendet ein Paar dauerhaft aus (auf allen Geräten).</span></div>`;
      bindTxDetails(el, (k) => flat[Number(k)]);
    };
    render();
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ok]');
      if (!btn) return;
      btn.disabled = true;
      api.dismiss('duplicates', btn.dataset.ok).then(render);
    });
  }, skeleton(6));
}
