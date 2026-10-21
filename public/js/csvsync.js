// Seite „CSV-Abgleich“: Bank-CSV-Dateien hochladen, ihre Zeilen den Firefly-
// Buchungen zuordnen und fehlende Empfänger (Name/IBAN des Zahlungs-
// beteiligten) nachtragen. Die Dateien werden nur im Browser gelesen; nach
// Firefly geht erst etwas über die Automation „Kategorie übernehmen“
// (n8n-Workflow, typ „gegenkonto_setzen“). Kategorien bleiben unverändert.

import * as api from './api.js';
import { money, esc, fmtDate, addDays } from './util.js';
import { card, counterparty, fireflyTxUrl } from './common.js';
import { actionFor, runAction } from './txedit.js';
import { decodeCsv, readRows, matchRows, changeFor, statusFor } from './csvmatch.js';

const STATUS = {
  neu: ['Empfänger fehlt – wird ergänzt', 'good'],
  abweichend: ['anderer Empfänger in Firefly', 'warn'],
  vorhanden: ['schon richtig', ''],
  'ohne-name': ['kein Name in der CSV', ''],
  umbuchung: ['Umbuchung', ''],
  mehrdeutig: ['mehrdeutig', 'warn'],
  'nicht-gefunden': ['nicht in Firefly gefunden', 'bad'],
  erledigt: ['übertragen ✓', 'good'],
};
const CHUNK = 100;
const MAX_ROWS = 600;

export async function csvSync(view) {
  view.innerHTML = `
    <div class="grid">
      ${card('s-files', 'Bank-CSV abgleichen', { meta: '<span class="muted">Dateien bleiben in deinem Browser</span>' })}
      ${card('s-result', 'Ergebnis', { filter: true, meta: '<span id="s-meta"></span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  let results = [];
  let filter = 'neu';
  let overwrite = false;
  let withIban = true;
  const picked = new Set(); // Zeilen-Indizes für die Übertragung
  const action = await actionFor('categorize');

  $('s-files').innerHTML = `
    <p class="sync-intro">Fehlen in Firefly die Empfänger (z. B. weil „Name Zahlungsbeteiligter“ beim Import nicht als Gegenkonto
      zugeordnet war), lassen sie sich hier aus den Original-CSV-Dateien nachtragen. Das Dashboard ordnet jede CSV-Zeile der
      vorhandenen Buchung zu (Betrag, Datum, Verwendungszweck) und zeigt vorher genau, was sich ändert. Kategorien, Tags und
      Notizen bleiben, wie sie sind.</p>
    <label class="drop" id="s-drop"><input type="file" id="s-input" accept=".csv,text/csv" multiple>
      <b>CSV-Dateien wählen</b> oder hierher ziehen <span class="muted">– mehrere auf einmal möglich (z. B. alle Jahre)</span></label>
    <div id="s-info" class="sync-info"></div>`;

  const load = async (files) => {
    const info = $('s-info');
    info.innerHTML = '<span class="muted">Lese Dateien …</span>';
    const rows = [];
    const notes = [];
    for (const f of files) {
      const parsed = readRows(decodeCsv(await f.arrayBuffer()), f.name);
      rows.push(...parsed.rows);
      notes.push(`${esc(f.name)}: ${parsed.rows.length} Zeilen${parsed.hasHeader ? '' : ' (ohne erkannte Kopfzeile – Spalten wie im VR-Bank-Export angenommen)'}${parsed.cols.name === undefined ? ' · <b>keine Spalte mit Namen gefunden</b>' : ''}`);
    }
    if (!rows.length) {
      info.innerHTML = `<div class="empty">Keine Buchungszeilen gefunden.</div>${notes.join('<br>')}`;
      return;
    }
    // überlappende Dateien: eine Zeile so oft, wie sie in einer Datei höchstens vorkommt
    // (zweimal 2,50 € beim Bäcker in derselben Datei bleiben zwei Zeilen)
    const keyOf = (r) => [r.date, r.amount, r.name, r.purpose, r.text].join('|');
    const max = new Map();
    for (const f of new Set(rows.map((r) => r.file))) {
      const perFile = new Map();
      rows.filter((r) => r.file === f).forEach((r) => perFile.set(keyOf(r), (perFile.get(keyOf(r)) || 0) + 1));
      perFile.forEach((n, k) => max.set(k, Math.max(max.get(k) || 0, n)));
    }
    const unique = rows.filter((r) => {
      const k = keyOf(r);
      if (!max.get(k)) return false;
      max.set(k, max.get(k) - 1);
      return true;
    });
    const dates = unique.map((r) => r.date).sort();
    info.innerHTML = `${notes.join('<br>')}<br><span class="muted">Lade Firefly-Buchungen ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))} …</span>`;
    const txs = api.flattenTransactions(await api.getAll('transactions', {
      start: addDays(new Date(`${dates[0]}T12:00:00`), -4), end: addDays(new Date(`${dates.at(-1)}T12:00:00`), 4),
    }));
    results = matchRows(unique, txs);
    picked.clear();
    // vorgewählt nur, was sicher zugeordnet ist (Betrag, Datum und Text gleich)
    results.forEach((r, i) => r.status === 'neu' && r.sure && picked.add(i));
    filter = 'neu';
    info.innerHTML = `${notes.join('<br>')}<br>${unique.length} Zeilen · ${txs.length} Firefly-Buchungen im Zeitraum ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}`;
    render();
  };

  const count = (s) => results.filter((r) => r.status === s).length;
  /** Kurzansicht einer Firefly-Buchung: so steht sie heute dort. */
  const fireflyBox = (t) => {
    const url = fireflyTxUrl(t);
    return `<div class="ff-box"><div><span class="sync-date">${fmtDate(t.date)}</span> ${esc(t.description || '–')}
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="ff-link" title="In Firefly öffnen">↗</a>` : ''}</div>
      <div class="flow">Empfänger bisher: <b>${esc(counterparty(t) || '–')}</b> · Kategorie: ${esc(t.category_name || 'ohne')} · Nr. ${esc(t.transaction_journal_id)}</div>
      ${t.notes ? `<div class="flow">Notiz: ${esc(String(t.notes).slice(0, 90))}</div>` : ''}</div>`;
  };
  function render() {
    const el = $('s-result');
    if (!results.length) {
      el.innerHTML = '<div class="empty">Noch keine Datei gewählt.</div>';
      return;
    }
    const rows = visible();
    // Scrollposition merken – nach dem Neuzeichnen geht es an derselben Stelle weiter
    const wrap = el.querySelector('.table-wrap');
    const scroll = { inner: wrap?.scrollTop || 0, page: window.scrollY };
    el.innerHTML = `
      <div class="chips sync-chips" role="group" aria-label="Filter">${[...Object.keys(STATUS), 'alle'].filter((s) => s === 'alle' || count(s))
        .map((s) => `<button class="chip small" data-filter="${s}" aria-pressed="${s === filter}">${s === 'alle' ? 'Alle' : STATUS[s][0]} <span class="muted">${s === 'alle' ? results.length : count(s)}</span></button>`).join('')}</div>
      <p class="sync-top" id="s-top"></p>
      <div class="sync-opts">
        <label class="check"><input type="checkbox" data-opt="iban" ${withIban ? 'checked' : ''}> IBAN/BIC des Gegenkontos mitgeben</label>
        ${count('abweichend') ? `<label class="check"><input type="checkbox" data-opt="overwrite" ${overwrite ? 'checked' : ''}> auch abweichende Empfänger überschreiben (${count('abweichend')})</label>` : ''}
        ${rows.some(selectable) ? `<span><button class="link-btn" data-pick="all">alle${filter === 'alle' ? '' : ' angezeigten'} auswählen</button> · <button class="link-btn" data-pick="none">keine</button></span>` : ''}
      </div>
      <div class="table-wrap scroll"><table class="sync-table"><thead><tr><th>${rows.some(selectable) ? '<input type="checkbox" id="s-all" aria-label="alle angezeigten auswählen">' : ''}</th><th>Laut CSV</th><th>Firefly-Buchung, die geändert würde</th><th class="num">Betrag</th><th>Ergebnis</th></tr></thead><tbody>
      ${rows.slice(0, MAX_ROWS).map((r) => `<tr style="cursor:default" class="${r.t && !r.sure && r.status !== 'erledigt' ? 'check-me' : ''}">
        <td>${selectable(r) ? `<input type="checkbox" data-row="${r.i}" ${picked.has(r.i) ? 'checked' : ''} aria-label="übertragen">` : ''}</td>
        <td><div class="sync-date">${fmtDate(r.row.date)}</div><b>${esc(r.row.name || '–')}</b>${r.row.iban ? `<div class="flow">${esc(r.row.iban)}</div>` : ''}
          <div class="flow">${esc(r.row.text)}${r.row.purpose ? ` · ${esc(r.row.purpose.slice(0, 90))}` : ''}</div><div class="flow">${esc(r.row.file)}:${r.row.line}</div></td>
        <td>${r.t ? `${fireflyBox(r.t)}<div class="sync-how ${r.sure ? 'sure' : 'unsure'}">${r.sure ? '✓' : '⚠'} ${esc(r.how || '')}</div>`
          : r.candidates?.length ? `<div class="sync-cands"><div class="muted">${r.status === 'mehrdeutig' ? 'Welche dieser Buchungen ist es?' : 'Mögliche Buchungen mit gleichem Betrag (bis 7 Tage daneben):'}</div>
              ${r.candidates.map((c, k) => `<div class="sync-cand">${fireflyBox(c.t)}${c.used ? '<div class="flow">schon einer anderen CSV-Zeile zugeordnet</div>'
                : `<button class="btn small" data-choose="${r.i}:${k}">diese nehmen</button>`}</div>`).join('')}</div>`
            : '<span class="muted">keine Buchung mit gleichem Betrag in der Nähe – vermutlich nie importiert oder in Firefly geändert</span>'}</td>
        <td class="num">${money(r.row.amount)}</td>
        <td><span class="badge ${STATUS[r.status][1]}" title="${esc(r.reason)}">${STATUS[r.status][0]}</span>
          ${['neu', 'abweichend', 'erledigt'].includes(r.status) && r.row.name ? `<div class="flow">Empfänger ${r.status === 'erledigt' ? 'ist jetzt' : 'wird'}: <b>${esc(r.row.name)}</b></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      ${rows.length > MAX_ROWS ? `<div class="legend" style="margin-top:8px"><span>Die ersten ${MAX_ROWS} von ${rows.length} (Auswahl gilt für alle)</span></div>` : ''}
      <div class="sync-run">
        ${action ? `<button class="btn primary" id="s-run"></button>
          <span class="muted">über „${esc(action.name)}“ – in Paketen zu ${CHUNK}</span>`
        : '<span class="muted">Zum Übertragen eine Automation mit Auslöser „Kategorie übernehmen“ anlegen (Workflow n8n/firefly-buchung-bearbeiten.json, Version mit „gegenkonto_setzen“).</span>'}
        <div class="run-out" id="s-out"></div>
      </div>`;
    updateSelection();
    const w = el.querySelector('.table-wrap');
    if (w) w.scrollTop = scroll.inner;
    window.scrollTo(0, scroll.page);
  }

  const selectable = (r) => Boolean(r.t) && ['neu', 'abweichend'].includes(r.status);
  const visible = () => results.map((r, i) => ({ ...r, i })).filter((r) => filter === 'alle' || r.status === filter);
  /** Nur Zähler, Überblick und Knöpfe aktualisieren – die Tabelle bleibt stehen (kein Sprung nach oben). */
  function updateSelection() {
    const el = $('s-result');
    const names = new Map();
    results.forEach((r, i) => picked.has(i) && names.set(r.row.name, (names.get(r.row.name) || 0) + 1));
    $('s-meta').textContent = `${picked.size} zum Übertragen ausgewählt`;
    const top = el.querySelector('#s-top');
    if (top) {
      top.hidden = !names.size;
      top.innerHTML = names.size ? `<b>${names.size} Empfänger</b> werden ergänzt, am häufigsten: ${[...names].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([n, c]) => `${esc(n)} <span class="muted">(${c}×)</span>`).join(', ')}` : '';
    }
    const run = el.querySelector('#s-run');
    if (run) {
      run.disabled = !picked.size;
      run.textContent = `${picked.size} Empfänger nach Firefly übertragen`;
    }
    const ow = el.querySelector('[data-opt="overwrite"]');
    if (ow) ow.checked = overwrite;
    // Kopf-Häkchen: alle / einige / keine der angezeigten
    const all = el.querySelector('#s-all');
    if (all) {
      const sel = visible().filter(selectable);
      const n = sel.filter((r) => picked.has(r.i)).length;
      all.checked = n > 0 && n === sel.length;
      all.indeterminate = n > 0 && n < sel.length;
    }
  }
  /** Alle bzw. keine der angezeigten Zeilen wählen (auch jenseits der ersten 600). */
  function pickVisible(on) {
    for (const r of visible().filter(selectable)) {
      if (on) picked.add(r.i);
      else picked.delete(r.i);
      if (on && r.status === 'abweichend') overwrite = true;
    }
    $('s-result').querySelectorAll('[data-row]').forEach((box) => (box.checked = picked.has(Number(box.dataset.row))));
    updateSelection();
  }

  async function transfer(btn) {
    const list = [...picked].sort((a, b) => a - b).map((i) => results[i]).filter((r) => r.t && (r.status === 'neu' || (r.status === 'abweichend' && overwrite)));
    if (!list.length) return;
    if (!window.confirm(`Bei ${list.length} Buchungen den Empfänger in Firefly setzen?\n\nFirefly ordnet sie dem Gegenkonto mit diesem Namen${withIban ? ' bzw. dieser IBAN' : ''} zu und legt es an, falls es noch fehlt. Kategorien, Tags und Notizen bleiben unverändert.`)) return;
    btn.disabled = true;
    const out = $('s-out');
    let done = 0;
    for (let k = 0; k < list.length; k += CHUNK) {
      const part = list.slice(k, k + CHUNK);
      out.innerHTML = `<span class="muted">Übertrage ${k + 1}–${k + part.length} von ${list.length} …</span>`;
      const payload = { typ: 'gegenkonto_setzen', aenderungen: part.map((r) => changeFor(r, { iban: withIban })) };
      const res = await runAction(action, { ...payload, daten: payload }).catch((err) => ({ ok: false, response: err.message }));
      if (!res.ok) {
        out.innerHTML = `<span class="badge bad">Fehler ${esc(res.status || '')}</span> <span class="muted">nach ${done} übertragenen: ${esc(String(res.response || '').slice(0, 200))}</span>`;
        render();
        return;
      }
      part.forEach((r) => {
        r.status = 'erledigt';
        picked.delete(results.indexOf(r));
      });
      done += part.length;
    }
    api.forget();
    render();
    $('s-out').innerHTML = `<span class="badge good">${done} übertragen ✓</span> <span class="muted">Danach im Labor: Regel-Vorschläge nach Empfänger („REWE → Lebensmittel“) und die KI-Analyse werden deutlich besser.</span>`;
  }

  const drop = $('s-drop');
  $('s-input').addEventListener('change', (e) => e.target.files.length && load([...e.target.files]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) load([...e.dataTransfer.files]);
  });
  $('s-result').addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) {
      filter = f.dataset.filter;
      return render();
    }
    const p = e.target.closest('[data-pick]');
    if (p) return pickVisible(p.dataset.pick === 'all');
    const choose = e.target.closest('[data-choose]');
    if (choose) {
      // von Hand zugeordnet: Kandidat übernehmen, für andere Zeilen sperren
      const [i, k] = choose.dataset.choose.split(':').map(Number);
      const r = results[i];
      const t = r.candidates[k].t;
      Object.assign(r, { t, how: 'von dir ausgewählt', sure: true, candidates: null }, statusFor(r.row, t));
      results.forEach((x) => x.candidates?.forEach((c) => c.t === t && (c.used = true)));
      if (r.status === 'neu') picked.add(i);
      return render();
    }
    if (e.target.id === 's-run') transfer(e.target);
  });
  $('s-result').addEventListener('change', (e) => {
    const row = e.target.closest('[data-row]');
    if (row) {
      const i = Number(row.dataset.row);
      if (row.checked) picked.add(i);
      else picked.delete(i);
      if (row.checked && results[i].status === 'abweichend') overwrite = true;
      return updateSelection(); // Tabelle nicht neu aufbauen
    }
    if (e.target.id === 's-all') return pickVisible(e.target.checked);
    if (e.target.dataset.opt === 'iban') {
      withIban = e.target.checked;
      return;
    }
    if (e.target.dataset.opt === 'overwrite') {
      overwrite = e.target.checked;
      results.forEach((r, i) => r.status === 'abweichend' && (overwrite ? picked.add(i) : picked.delete(i)));
      $('s-result').querySelectorAll('[data-row]').forEach((box) => (box.checked = picked.has(Number(box.dataset.row))));
      updateSelection();
    }
  });
  render();
}
