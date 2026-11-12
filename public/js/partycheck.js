// Karte „Falsch zugeordnete Gegenkonten“ (Seite Aufräumen): Buchungen, deren Text auf
// einen anderen Händler zeigt als das Gegenkonto (partycore.js) – mit Vorschlag für den
// richtigen Empfänger. Korrigiert wird über die Automation „Kategorie übernehmen“
// (n8n, typ „gegenkonto_setzen“, ohne IBAN): Firefly ordnet die Buchung dem Konto mit
// diesem Namen zu oder legt es an. Kategorie, Beschreibung und Tags bleiben.

import * as api from './api.js';
import { esc, money, fmtDate, storage, store } from './util.js';
import { runAction } from './txedit.js';
import { wrongParties } from './partycore.js';
import { counterpartyOf } from './rules.js';

const CHUNK = 50;
const NAMES_KEY = 'ffd-pc-names'; // eingetippte Empfänger je Gruppe – überstehen ein Neuladen (je Gerät)
const loadNames = () => {
  try {
    return JSON.parse(storage(NAMES_KEY, '{}')) || {};
  } catch {
    return {};
  }
};

export function partyCheckCard(el, metaEl, { txs, editAction }) {
  let dismissed = new Set();
  let results = [];
  const done = new Set(); // korrigierte Journal-IDs
  const picks = new Map(); // Gruppen-Kennung → { on, name }
  const openTx = new Set(); // aufgeklappte Gruppen
  let openAcc = null; // aufgeklappte Konten – bleiben beim Neuzeichnen offen
  let note = '';
  let busy = '';

  const allParties = [...new Set(txs.filter((t) => t.type === 'withdrawal').map(counterpartyOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));

  function analyse() {
    results = wrongParties(txs.filter((t) => !done.has(String(t.transaction_journal_id))), { dismissed })
      .map((r) => ({ ...r, groups: r.groups.map((g) => ({ ...g, id: `${r.party}|${g.key}` })) }));
    const saved = loadNames();
    for (const r of results) for (const g of r.groups) if (!picks.has(g.id)) picks.set(g.id, { on: true, name: saved[g.id] ?? g.suggestion, suggestion: g.suggestion });
  }

  const chosen = () => results.flatMap((r) => r.groups.filter((g) => picks.get(g.id)?.on && picks.get(g.id).name.trim()));

  function render() {
    openAcc ||= new Set(results.length <= 5 ? results.map((r) => r.party) : []);
    const wrong = results.reduce((a, r) => a + r.wrongCount, 0);
    metaEl.textContent = results.length ? `${results.length} Konto${results.length === 1 ? '' : 'en'} · ${wrong} Buchung${wrong === 1 ? '' : 'en'}` : 'nichts gefunden';
    const sel = chosen();
    const nSel = sel.reduce((a, g) => a + g.txs.length, 0);
    el.innerHTML = `
      <p class="muted" style="margin-top:0">Kartenzahlungen, bei denen der Händler im Buchungstext nicht zum Gegenkonto passt – z. B. Tanken bei der Werkstatt.
        Meist liefert die Bank bei Kartenzahlungen die IBAN des Zahlungsdienstleisters, und Firefly ordnet über diese IBAN alles demselben Konto zu.
        Geprüft werden die Ausgaben der letzten 24 Monate.<br><b>So geht’s:</b> „neuer Empfänger“ prüfen oder anpassen, Gruppe angehakt lassen, unten „Empfänger in Firefly korrigieren“.</p>
      ${note ? `<div class="cm-note">${note}</div>` : ''}
      ${!results.length ? '<div class="empty">Keine Auffälligkeiten – die Gegenkonten passen zu den Buchungstexten. 🎉</div>' : `
      <div class="pc-list">${results.map((r) => `
        <details class="pc-acc" data-acc="${esc(r.party)}"${openAcc.has(r.party) ? ' open' : ''}>
          <summary><b>${esc(r.party)}</b> <span class="muted">· ${r.wrongCount} von ${r.total} Buchungen passen nicht zum Namen</span></summary>
          ${r.iban ? `<p class="pc-iban">Dieses Konto hat in Firefly die IBAN <code>${esc(r.iban)}</code>. Gehört sie dem Zahlungsdienstleister und nicht dem Geschäft, landen dort weiter fremde Kartenzahlungen – dann die IBAN am Konto in Firefly entfernen (Konten → Ausgabenkonten → bearbeiten).</p>` : ''}
          ${r.groups.map((g) => {
            const p = picks.get(g.id);
            return `<div class="pc-group" data-g="${esc(g.id)}">
              <label class="pc-check"><input type="checkbox" data-pc-on ${p.on ? 'checked' : ''}${busy ? ' disabled' : ''}>
                <span><span class="muted">Im Text:</span> <b>${esc(g.name)}</b> <span class="muted">· ${g.txs.length} Buchung${g.txs.length === 1 ? '' : 'en'} · ${money(g.sum)}</span></span></label>
              <div class="pc-fix"><span class="muted">neuer Empfänger</span>
                <input class="input" data-pc-name list="pc-parties" value="${esc(p.name)}" aria-label="Neuer Empfänger für ${esc(g.name)}"${busy ? ' disabled' : ''}>
                <button type="button" class="link-btn" data-pc-show>${openTx.has(g.id) ? 'Buchungen ausblenden' : 'Buchungen ansehen'}</button>
                <button type="button" class="link-btn" data-pc-ok title="Kein Fehler: Gruppe wird NICHT korrigiert und nicht mehr angezeigt (gilt auf allen Geräten)">kein Fehler – ausblenden</button></div>
              ${openTx.has(g.id) ? `<div class="table-wrap"><table><tbody>${g.txs.map((t) => `<tr style="cursor:default">
                <td class="date">${fmtDate(t.date)}</td><td><div class="desc">${esc(String(t.description || '').slice(0, 140))}</div>${t.notes ? `<div class="flow">${esc(String(t.notes).slice(0, 140))}</div>` : ''}</td>
                <td>${t.category_name ? esc(t.category_name) : '<span class="muted">ohne Kategorie</span>'}</td><td class="num">${money(-t.amount, t.currency_code)}</td></tr>`).join('')}</tbody></table></div>` : ''}
            </div>`;
          }).join('')}
        </details>`).join('')}</div>
      <datalist id="pc-parties">${allParties.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="pc-actions">
        ${editAction
    ? `<button type="button" class="btn primary" id="pc-send"${nSel && !busy ? '' : ' disabled'}>${nSel} Buchung${nSel === 1 ? '' : 'en'}: Empfänger in Firefly korrigieren</button>
          <span class="muted">Übernimmt bei allen angehakten Gruppen den eingetragenen „neuen Empfänger“ – über „${esc(editAction.name)}“; nur der Empfänger ändert sich (ohne IBAN); Kategorie, Beschreibung und Tags bleiben. Firefly nimmt das Konto mit diesem Namen oder legt es an.</span>`
    : '<span class="muted">Zum Korrigieren eine Automation mit Auslöser „Kategorie übernehmen“ anlegen (Workflow n8n/firefly-buchung-bearbeiten.json).</span>'}
      </div>
      ${busy ? `<p class="muted">${esc(busy)}</p>` : ''}`}`;
  }

  async function send() {
    const groups = chosen();
    const list = groups.flatMap((g) => g.txs.map((t) => ({ t, name: picks.get(g.id).name.trim() })));
    if (!list.length || !window.confirm(`Bei ${list.length} Buchung${list.length === 1 ? '' : 'en'} den Empfänger in Firefly ändern?`)) return;
    let ok = 0;
    let failed = '';
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      busy = `Übertrage ${Math.min(i + CHUNK, list.length)} von ${list.length} …`;
      render();
      const res = await runAction(editAction, {
        typ: 'gegenkonto_setzen',
        aenderungen: part.map(({ t, name }) => ({
          transaction_group_id: t.groupId,
          transaction_journal_id: t.transaction_journal_id,
          art: t.type,
          datum: String(t.date).slice(0, 10),
          betrag: t.amount,
          name,
          name_alt: counterpartyOf(t) || null,
        })),
      }).catch((err) => ({ ok: false, response: err.message }));
      if (!res.ok) {
        failed = `n8n antwortet mit ${res.status || 'Fehler'}: ${String(res.response || '').slice(0, 160)}`;
        break;
      }
      ok += part.length;
      part.forEach(({ t }) => done.add(String(t.transaction_journal_id)));
    }
    busy = '';
    note = failed
      ? `<span class="bad">${ok ? `${ok} von ${list.length} korrigiert, dann Fehler – ` : ''}${esc(failed)}</span>`
      : `<span class="good">✓ ${ok} Buchung${ok === 1 ? '' : 'en'} an Firefly geschickt – die neuen Empfänger stehen dort gleich.</span>`;
    api.forget();
    analyse();
    render();
  }

  // „toggle“ steigt nicht auf – daher in der Capture-Phase
  el.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('details[data-acc]')) return;
    if (d.open) openAcc.add(d.dataset.acc);
    else openAcc.delete(d.dataset.acc);
  }, true);
  el.addEventListener('change', (e) => {
    const g = e.target.closest('[data-g]');
    if (!g) return;
    const p = picks.get(g.dataset.g);
    if (e.target.matches('[data-pc-on]')) p.on = e.target.checked;
    if (e.target.matches('[data-pc-name]')) {
      p.name = e.target.value;
      rememberName(g.dataset.g, p);
    }
    const btn = el.querySelector('#pc-send');
    if (btn) {
      const n = chosen().reduce((a, x) => a + x.txs.length, 0);
      btn.disabled = !n || Boolean(busy);
      btn.textContent = `${n} Buchung${n === 1 ? '' : 'en'}: Empfänger in Firefly korrigieren`;
    }
  });
  el.addEventListener('input', (e) => {
    if (!e.target.matches('[data-pc-name]')) return;
    const id = e.target.closest('[data-g]').dataset.g;
    picks.get(id).name = e.target.value;
    rememberName(id, picks.get(id));
  });
  function rememberName(id, p) {
    const all = loadNames();
    if (p.name.trim() && p.name !== p.suggestion) all[id] = p.name;
    else delete all[id];
    store(NAMES_KEY, JSON.stringify(all));
  }
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'pc-send') return send();
    const g = t.closest('[data-g]');
    if (!g) return;
    const id = g.dataset.g;
    if (t.matches('[data-pc-show]')) {
      if (openTx.has(id)) openTx.delete(id);
      else openTx.add(id);
      return render();
    }
    if (t.matches('[data-pc-ok]')) {
      const group = results.flatMap((r) => r.groups).find((x) => x.id === id);
      if (!group) return;
      if (!window.confirm(`„${group.name}“ bei „${id.split('|')[0]}“ ist kein Fehler?\n\nDie ${group.txs.length} Buchung${group.txs.length === 1 ? '' : 'en'} werden NICHT korrigiert und hier nicht mehr angezeigt. Zum Korrigieren stattdessen angehakt lassen und unten „Empfänger in Firefly korrigieren“.`)) return;
      dismissed.add(group.key);
      await api.dismiss('parties', group.key);
      analyse();
      render();
    }
  });

  return api.loadDismissed().then((d) => {
    dismissed = d.parties || new Set();
    analyse();
    render();
  });
}
