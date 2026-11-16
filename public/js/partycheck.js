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
  const picks = new Map(); // Gruppen-Kennung → { on, name, suggestion }
  const off = new Set(); // einzeln abgewählte Buchungen (Journal-ID) in angehakten Gruppen
  const txName = new Map(); // Journal-ID → eigener Empfänger für genau diese Buchung
  const openTx = new Set(); // Gruppen mit sichtbaren Buchungen
  const closedTx = new Set(); // beim Suchen von Hand wieder zugeklappt
  let openAcc = null; // aufgeklappte Konten – bleiben beim Neuzeichnen offen
  let query = '';
  let note = '';
  let busy = '';

  const allParties = [...new Set(txs.filter((t) => t.type === 'withdrawal').map(counterpartyOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const jid = (t) => String(t.transaction_journal_id);

  function analyse() {
    results = wrongParties(txs.filter((t) => !done.has(jid(t))), { dismissed })
      .map((r) => ({ ...r, groups: r.groups.map((g) => ({ ...g, id: `${r.party}|${g.key}` })) }));
    const saved = loadNames();
    for (const r of results) for (const g of r.groups) if (!picks.has(g.id)) picks.set(g.id, { on: !g.unnamed, name: saved[g.id] ?? g.suggestion, suggestion: g.suggestion }); // ohne Händlernamen: nur Vermutung → nicht vorab angehakt
  }

  /** Ausgewählte Buchungen mit ihrem neuen Empfänger. */
  const selected = () => results.flatMap((r) => r.groups.flatMap((g) => {
    const p = picks.get(g.id);
    if (!p?.on) return [];
    return g.txs.filter((t) => !off.has(jid(t))).map((t) => ({ t, name: (txName.get(jid(t)) || p.name).trim() })).filter((x) => x.name);
  }));

  /** Kategorien einer Gruppe, z. B. „Tanken 3×, ohne 1×“ – zeigt Widersprüche (Konto ATU, Text Hornbach, Kategorie Tanken). */
  const catSummary = (list) => {
    const m = new Map();
    list.forEach((t) => m.set(t.category_name || '', (m.get(t.category_name || '') || 0) + 1));
    return [...m].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c ? `<b>${esc(c)}</b>` : '<i>ohne</i>'}${list.length > 1 ? ` ${n}×` : ''}`).join(', ');
  };
  const low = (x) => String(x ?? '').toLowerCase();
  const words = () => low(query).split(/\s+/).filter(Boolean);
  const txHay = (t) => low(`${t.description} ${t.notes || ''} ${t.category_name || ''} ${fmtDate(t.date)}`);
  /** Treffer der Suche: Konto, Händler im Text, Vorschlag, Buchungstexte, Kategorien. */
  const groupHits = (r, g) => {
    const w = words();
    if (!w.length) return true;
    const hay = low(`${r.party} ${g.name} ${picks.get(g.id)?.name || ''} ${g.txs.map(txHay).join(' ')}`);
    return w.every((x) => hay.includes(x));
  };

  // Gerüst: Erklärung, Schritte und Suche bleiben stehen; nur die Liste wird neu gezeichnet (Suche behält den Fokus)
  el.innerHTML = `
    <p class="muted" style="margin-top:0">Buchungen, bei denen der Händler im Buchungstext (Beschreibung oder Notiz) nicht zum Gegenkonto passt – z. B. Tanken bei der Werkstatt.
      Meist liefert die Bank bei Kartenzahlungen die IBAN eines Zahlungsdienstleisters, und Firefly ordnet darüber alles demselben Konto zu. Geprüft: Ausgaben der letzten 24 Monate.</p>
    <ol class="pc-steps">
      <li><b>Prüfen:</b> Konto aufklappen, „Buchungen ansehen“ zeigt jede einzelne.</li>
      <li><b>Richtigen Empfänger</b> eintragen – für die ganze Gruppe oder je Buchung („anderer Empfänger“).</li>
      <li><b>Auswählen:</b> Häkchen an der Gruppe (alle) oder an einzelnen Buchungen.</li>
      <li>Unten <b>„Empfänger korrigieren“</b>. Fehlalarm? „kein Fehler“ – an der Gruppe oder an einer Buchung.</li>
    </ol>
    <div class="pc-tools">
      <input class="input" type="search" data-pc-search placeholder="Suchen: Konto, Händler, Text, Kategorie …" aria-label="Falsch zugeordnete Gegenkonten durchsuchen">
      <button type="button" class="link-btn" data-pc-openall>alle aufklappen</button>
      <button type="button" class="link-btn" data-pc-closeall>alle zuklappen</button>
    </div>
    <div data-pc-body></div>
    <datalist id="pc-parties">${allParties.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
  const body = el.querySelector('[data-pc-body]');

  function render() {
    openAcc ||= new Set(results.length <= 5 ? results.map((r) => r.party) : []);
    const wrong = results.reduce((a, r) => a + r.wrongCount, 0);
    metaEl.textContent = results.length ? `${results.length} ${results.length === 1 ? 'Konto' : 'Konten'} · ${wrong} Buchung${wrong === 1 ? '' : 'en'}` : 'nichts gefunden';
    const nSel = selected().length;
    const searching = words().length > 0;
    const shown = results.map((r) => ({ r, groups: r.groups.filter((g) => groupHits(r, g)) })).filter((x) => x.groups.length);
    body.innerHTML = `
      ${note ? `<div class="cm-note">${note}</div>` : ''}
      ${jobLine()}
      ${!results.length ? '<div class="empty">Keine Auffälligkeiten – die Gegenkonten passen zu den Buchungstexten. 🎉</div>' : !shown.length ? `<div class="empty">Nichts gefunden für „${esc(query)}“.</div>` : `
      <div class="pc-list">${shown.map(({ r, groups }) => `
        <details class="pc-acc" data-acc="${esc(r.party)}"${openAcc.has(r.party) || searching ? ' open' : ''}>
          <summary><b>${esc(r.party)}</b> <span class="muted">· ${r.wrongCount} von ${r.total} Buchungen passen nicht zum Namen</span></summary>
          ${r.iban ? `<p class="pc-iban">Dieses Konto hat in Firefly die IBAN <code>${esc(r.iban)}</code>. Gehört sie dem Zahlungsdienstleister und nicht dem Geschäft, landen dort weiter fremde Kartenzahlungen – dann die IBAN am Konto in Firefly entfernen (Konten → Ausgabenkonten → bearbeiten).</p>` : ''}
          ${groups.map((g) => groupHtml(g, searching)).join('')}
        </details>`).join('')}</div>
      <div class="pc-actions">
        ${editAction
    ? `<button type="button" class="btn primary" id="pc-send"${nSel && !busy ? '' : ' disabled'}>${nSel} Buchung${nSel === 1 ? '' : 'en'}: Empfänger korrigieren</button>
          <span class="muted">Jede ausgewählte Buchung bekommt den eingetragenen Empfänger – als Auftrag auf dem Server über „${esc(editAction.name)}“, ohne IBAN; Kategorie, Beschreibung und Tags bleiben. Firefly nimmt das Konto mit diesem Namen oder legt es an.</span>`
    : '<span class="muted">Zum Korrigieren eine Automation mit Auslöser „Kategorie übernehmen“ anlegen (Workflow n8n/firefly-buchung-bearbeiten.json).</span>'}
      </div>
      ${busy ? `<p class="muted">${esc(busy)}</p>` : ''}`}`;
    body.querySelectorAll('[data-pc-on]').forEach((box) => {
      const g = results.flatMap((r) => r.groups).find((x) => x.id === box.closest('[data-g]').dataset.g);
      const n = g.txs.filter((t) => !off.has(jid(t))).length;
      box.indeterminate = box.checked && n > 0 && n < g.txs.length;
    });
  }

  function groupHtml(g, searching) {
    const p = picks.get(g.id);
    const nOn = p.on ? g.txs.filter((t) => !off.has(jid(t))).length : 0;
    const showTx = openTx.has(g.id) || (searching && g.txs.length > 1 && !closedTx.has(g.id));
    const w = words();
    return `<div class="pc-group" data-g="${esc(g.id)}">
      <label class="pc-check"><input type="checkbox" data-pc-on ${p.on && nOn ? 'checked' : ''}${busy ? ' disabled' : ''} aria-label="Ganze Gruppe auswählen">
        <span>${g.unnamed
    ? `<b>Kein Händler im Text</b> <span class="muted">(nur Nummern und IBAN des Zahlungsdienstleisters) · ${g.txs.length} Buchung${g.txs.length === 1 ? '' : 'en'} · ${money(g.sum)}</span>
          <span class="pc-cats">Kategorie <b>${esc(g.category)}</b> passt nicht zum Konto (sonst meist „${esc(g.usual || '–')}“). Vorschlag aus der Kategorie – nur eine Vermutung. Den echten Namen zeigt die Bank-CSV im <a href="#/abgleich">CSV-Abgleich</a>.</span>`
    : `<span class="muted">Im Text:</span> <b>${esc(g.name)}</b> <span class="muted">· ${g.txs.length} Buchung${g.txs.length === 1 ? '' : 'en'} · ${money(g.sum)}${p.on && nOn < g.txs.length ? ` · ${nOn} ausgewählt` : ''}</span>`}
          <span class="pc-cats">${g.unnamed ? '' : `Kategorie: ${catSummary(g.txs)}`}${g.via ? ` · abgewickelt über <b>${esc(g.via)}</b> – dessen IBAN/Gläubiger-ID führt Firefly zum falschen Konto` : ''}</span></span></label>
      <div class="pc-fix"><span class="muted">neuer Empfänger</span>
        <input class="input" data-pc-name list="pc-parties" value="${esc(p.name)}" aria-label="Neuer Empfänger für ${esc(g.name)}"${busy ? ' disabled' : ''}>
        <button type="button" class="link-btn" data-pc-show>${showTx ? 'Buchungen ausblenden' : `${g.txs.length === 1 ? 'Buchung' : `${g.txs.length} Buchungen`} ansehen`}</button>
        <button type="button" class="link-btn" data-pc-ok title="Fehlalarm: Gruppe wird NICHT korrigiert und nicht mehr angezeigt (gilt auf allen Geräten)">kein Fehler</button></div>
      ${showTx ? `<div class="table-wrap pc-txs"><table><tbody>${g.txs.map((t) => {
        const on = p.on && !off.has(jid(t));
        const own = txName.get(jid(t));
        const hit = !w.length || w.every((x) => txHay(t).includes(x) || low(g.name).includes(x) || low(p.name).includes(x));
        return `<tr data-tx="${esc(jid(t))}" class="${hit ? '' : 'pc-miss'}" style="cursor:default">
          <td class="pick-cell"><input type="checkbox" data-pc-tx ${on ? 'checked' : ''}${busy ? ' disabled' : ''} aria-label="Diese Buchung korrigieren"></td>
          <td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(String(t.description || '').slice(0, 140))}</div>${t.notes ? `<div class="flow">${esc(String(t.notes).slice(0, 160))}</div>` : ''}
            <div class="pc-tx-acts">${on ? `→ <b>${esc(own || p.name || '–')}</b>${own ? ' <span class="muted">(eigener)</span>' : ''} · ` : ''}<button type="button" class="link-btn" data-pc-txname>${own ? 'Empfänger ändern' : 'anderer Empfänger'}</button>${own ? ` · <button type="button" class="link-btn" data-pc-txreset>wie Gruppe</button>` : ''} · <button type="button" class="link-btn" data-pc-txok title="Diese Buchung ist richtig – nicht mehr anzeigen">kein Fehler</button></div></td>
          <td>${t.category_name ? esc(t.category_name) : '<span class="muted">ohne Kategorie</span>'}</td><td class="num">${money(-t.amount, t.currency_code)}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
    </div>`;
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
    const list = selected();
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
    list.forEach(({ t }) => {
      done.add(jid(t)); // aus der Liste nehmen – der Server erledigt den Rest
      off.delete(jid(t));
      txName.delete(jid(t));
    });
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
  const groupOf = (id) => results.flatMap((r) => r.groups).find((x) => x.id === id);
  let searchTimer;
  el.addEventListener('input', (e) => {
    if (e.target.matches('[data-pc-search]')) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = e.target.value;
        closedTx.clear();
        render();
      }, 180);
      return;
    }
    if (!e.target.matches('[data-pc-name]')) return;
    const id = e.target.closest('[data-g]').dataset.g;
    picks.get(id).name = e.target.value;
    rememberName(id, picks.get(id));
  });
  el.addEventListener('change', (e) => {
    const box = e.target.closest('[data-g]');
    if (!box) return;
    const g = groupOf(box.dataset.g);
    const p = picks.get(g.id);
    if (e.target.matches('[data-pc-on]')) {
      p.on = e.target.checked;
      g.txs.forEach((t) => off.delete(jid(t))); // ganze Gruppe an bzw. aus
      return render();
    }
    if (e.target.matches('[data-pc-tx]')) {
      const j = e.target.closest('[data-tx]').dataset.tx;
      if (e.target.checked) {
        if (!p.on) { // Gruppe war aus: nur diese Buchung an
          p.on = true;
          g.txs.forEach((t) => off.add(jid(t)));
        }
        off.delete(j);
      } else {
        off.add(j);
        if (g.txs.every((t) => off.has(jid(t)))) {
          p.on = false;
          g.txs.forEach((t) => off.delete(jid(t)));
        }
      }
      return render();
    }
    if (e.target.matches('[data-pc-name]')) {
      p.name = e.target.value;
      rememberName(g.id, p);
      render();
    }
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
    if (t.matches('[data-pc-openall], [data-pc-closeall]')) {
      const open = t.matches('[data-pc-openall]');
      results.forEach((r) => (open ? openAcc.add(r.party) : openAcc.delete(r.party)));
      return render();
    }
    const g = t.closest('[data-g]');
    if (!g) return;
    const id = g.dataset.g;
    const group = groupOf(id);
    if (t.matches('[data-pc-show]')) {
      const shown = openTx.has(id) || (words().length && group.txs.length > 1 && !closedTx.has(id));
      if (shown) {
        openTx.delete(id);
        closedTx.add(id);
      } else {
        openTx.add(id);
        closedTx.delete(id);
      }
      return render();
    }
    const row = t.closest('[data-tx]');
    if (row) {
      const j = row.dataset.tx;
      if (t.matches('[data-pc-txname]')) {
        const name = window.prompt('Empfänger nur für diese Buchung:', txName.get(j) || picks.get(id).name);
        if (name === null) return;
        if (name.trim()) txName.set(j, name.trim());
        else txName.delete(j);
        off.delete(j);
        picks.get(id).on = true;
        return render();
      }
      if (t.matches('[data-pc-txreset]')) {
        txName.delete(j);
        return render();
      }
      if (t.matches('[data-pc-txok]')) {
        if (!window.confirm('Diese Buchung ist richtig zugeordnet? Sie wird nicht korrigiert und hier nicht mehr angezeigt.')) return;
        dismissed.add(`j:${j}`);
        await api.dismiss('parties', `j:${j}`);
        off.delete(j);
        txName.delete(j);
        analyse();
        return render();
      }
    }
    if (t.matches('[data-pc-ok]')) {
      if (!window.confirm(`„${group.name}“ bei „${id.split('|')[0]}“ ist kein Fehler?\n\nDie ${group.txs.length} Buchung${group.txs.length === 1 ? '' : 'en'} werden NICHT korrigiert und hier nicht mehr angezeigt. Einzelne Buchungen kannst du auch je Buchung als „kein Fehler“ markieren.`)) return;
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
