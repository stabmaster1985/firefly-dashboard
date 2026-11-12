// Karte „Falsch zugeordnete Gegenkonten“ (Seite Aufräumen): Buchungen, deren Text auf
// einen anderen Händler zeigt als das Gegenkonto (partycore.js) – mit Vorschlag für den
// richtigen Empfänger. Korrigiert wird über die Automation „Kategorie übernehmen“
// (n8n, typ „gegenkonto_setzen“, ohne IBAN): Firefly ordnet die Buchung dem Konto mit
// diesem Namen zu oder legt es an. Kategorie, Beschreibung und Tags bleiben.

import * as api from './api.js';
import { esc, money, fmtDate, storage, store } from './util.js';
import { wrongParties } from './partycore.js';
import { counterpartyOf } from './rules.js';

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

  /** Kategorien einer Gruppe, z. B. „Tanken 3×, ohne 1×“ – zeigt Widersprüche (Konto ATU, Text Hornbach, Kategorie Tanken). */
  const catSummary = (list) => {
    const m = new Map();
    list.forEach((t) => m.set(t.category_name || '', (m.get(t.category_name || '') || 0) + 1));
    return [...m].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c ? `<b>${esc(c)}</b>` : '<i>ohne</i>'}${list.length > 1 ? ` ${n}×` : ''}`).join(', ');
  };
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
      ${jobLine()}
      ${!results.length ? '<div class="empty">Keine Auffälligkeiten – die Gegenkonten passen zu den Buchungstexten. 🎉</div>' : `
      <div class="pc-list">${results.map((r) => `
        <details class="pc-acc" data-acc="${esc(r.party)}"${openAcc.has(r.party) ? ' open' : ''}>
          <summary><b>${esc(r.party)}</b> <span class="muted">· ${r.wrongCount} von ${r.total} Buchungen passen nicht zum Namen</span></summary>
          ${r.iban ? `<p class="pc-iban">Dieses Konto hat in Firefly die IBAN <code>${esc(r.iban)}</code>. Gehört sie dem Zahlungsdienstleister und nicht dem Geschäft, landen dort weiter fremde Kartenzahlungen – dann die IBAN am Konto in Firefly entfernen (Konten → Ausgabenkonten → bearbeiten).</p>` : ''}
          ${r.groups.map((g) => {
            const p = picks.get(g.id);
            return `<div class="pc-group" data-g="${esc(g.id)}">
              <label class="pc-check"><input type="checkbox" data-pc-on ${p.on ? 'checked' : ''}${busy ? ' disabled' : ''}>
                <span><span class="muted">Im Text:</span> <b>${esc(g.name)}</b> <span class="muted">· ${g.txs.length} Buchung${g.txs.length === 1 ? '' : 'en'} · ${money(g.sum)}</span>
                  <span class="pc-cats">Kategorie: ${catSummary(g.txs)}</span></span></label>
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

  // ---- Übertragen: als Auftrag auf dem Server (wie im CSV-Abgleich) ----
  // n8n antwortet dabei sofort und speichert im Hintergrund; der Server prüft danach jede Buchung
  // in Firefly und schickt Fehlendes erneut. So gibt es keinen Abbruch durch einen Proxy vor n8n
  // („504 Gateway Time-out“), und Handy/PC dürfen zwischendurch aus sein.
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
  let job = null;
  let poll = null;
  const jobLine = () => {
    if (!job) return '';
    const stand = `${job.ok} von ${job.total} umgestellt${job.fehlt ? `, ${job.fehlt} fehlen noch` : ''}`;
    if (job.status === 'laeuft') return `<div class="cm-note">⏳ Läuft auf dem Server: ${stand}. ${esc(job.message || '')} <span class="muted">Das Gerät darf aus sein; Stand und Anhalten auch unter <a href="#/abgleich">CSV-Abgleich</a> („Übertragung auf dem Server“).</span></div>`;
    if (job.status === 'pausiert') return `<div class="cm-note"><span class="bad">Angehalten:</span> ${esc(job.message || '')} – fortsetzen unter <a href="#/abgleich">CSV-Abgleich</a> („Übertragung auf dem Server“).</div>`;
    return '';
  };
  async function refreshJob() {
    const body = await fetch('/local/syncjob', { headers: { 'X-No-Cache': '1' } }).then((r) => r.json()).catch(() => null);
    const was = job?.status;
    job = body?.job || null;
    if (job?.status === 'fertig' && was === 'laeuft') {
      note = job.fehlt
        ? `<span class="bad">${job.ok} umgestellt, ${job.fehlt} nach mehreren Versuchen nicht in Firefly – in n8n unter „Executions“ nachsehen.</span>`
        : `<span class="good">✓ Alle ${job.ok} Empfänger in Firefly umgestellt und geprüft.</span>`;
      api.forget();
    }
    if (job?.status !== 'laeuft' && poll) {
      clearInterval(poll);
      poll = null;
    }
    if (!el.isConnected) {
      clearInterval(poll);
      poll = null;
      return;
    }
    render();
  }
  const watch = () => {
    poll ||= setInterval(refreshJob, 5000);
  };

  async function send() {
    const groups = chosen();
    const list = groups.flatMap((g) => g.txs.map((t) => ({ t, name: picks.get(g.id).name.trim() })));
    if (!list.length || !window.confirm(`Bei ${list.length} Buchung${list.length === 1 ? '' : 'en'} den Empfänger in Firefly ändern?\n\nDas läuft als Auftrag auf dem Server weiter – auch wenn du die Seite schließt.`)) return;
    busy = 'Übergebe den Auftrag an den Server …';
    render();
    const items = list.map(({ t, name }) => ({
      j: t.transaction_journal_id,
      g: t.groupId,
      fp: '', // kein CSV-Fingerabdruck – nur der Empfänger wird umgestellt
      name,
      payload: {
        transaction_group_id: t.groupId,
        transaction_journal_id: t.transaction_journal_id,
        art: t.type,
        datum: String(t.date).slice(0, 10),
        betrag: t.amount,
        name,
        name_alt: counterpartyOf(t) || null,
      },
      check: { party: name, before: counterpartyOf(t) || '' },
    }));
    const res = await fetch('/local/syncjob', { method: 'POST', headers, body: JSON.stringify({ actionId: editAction.id, portion: 10, parallel: 1, items }) });
    const body = await res.json().catch(() => ({}));
    busy = '';
    if (!res.ok) {
      note = `<span class="bad">Nicht gestartet: ${esc(body.message || `HTTP ${res.status}`)}</span>`;
      return render();
    }
    list.forEach(({ t }) => done.add(String(t.transaction_journal_id))); // aus der Liste nehmen – der Server erledigt den Rest
    for (const g of groups) picks.delete(g.id);
    note = '';
    job = body.job;
    analyse();
    render();
    watch();
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

  return api.loadDismissed().then(async (d) => {
    dismissed = d.parties || new Set();
    analyse();
    render();
    await refreshJob(); // läuft schon ein Auftrag? Dann Stand zeigen
    if (job?.status === 'laeuft') watch();
  });
}
