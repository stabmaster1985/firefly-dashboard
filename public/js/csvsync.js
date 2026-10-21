// Seite „CSV-Abgleich“: Bank-CSV-Dateien hochladen, ihre Zeilen den Firefly-
// Buchungen zuordnen und fehlende Empfänger (Name/IBAN des Zahlungs-
// beteiligten) nachtragen. Die Dateien werden nur im Browser gelesen; nach
// Firefly geht erst etwas über die Automation „Kategorie übernehmen“
// (n8n-Workflow, typ „gegenkonto_setzen“). Kategorien bleiben unverändert.

import * as api from './api.js';
import { money, esc, fmtDate, addDays } from './util.js';
import { card, counterparty, fireflyTxUrl } from './common.js';
import { actionFor, runAction } from './txedit.js';
import { decodeCsv, readRows, matchRows, changeFor, statusFor, fingerprints, hasNoParty } from './csvmatch.js';

const STATUS = {
  neu: ['Empfänger fehlt – wird ergänzt', 'good'],
  abweichend: ['anderer Empfänger in Firefly', 'warn'],
  vorhanden: ['schon synchron', ''],
  'ohne-name': ['kein Name in der CSV', ''],
  umbuchung: ['Umbuchung', ''],
  mehrdeutig: ['mehrdeutig', 'warn'],
  'nicht-gefunden': ['nicht in Firefly gefunden', 'bad'],
  erledigt: ['übertragen ✓', 'good'],
  frueher: ['schon erledigt (gemerkt)', ''],
};
// Pakete an n8n: klein anfangen und an die Laufzeit anpassen – n8n antwortet erst,
// wenn das ganze Paket in Firefly gespeichert ist, und nach 5 Minuten bricht die
// Verbindung ab. Ziel: rund eine Minute je Paket.
const CHUNK_START = 20;
const CHUNK_MIN = 3;
const CHUNK_MAX = 60;
const TARGET_MS = 60_000;
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
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
  // Gedächtnis: schon übertragene CSV-Zeilen (Fingerabdruck → Buchung), liegt auf dem Server
  let memory = { count: 0, since: null, rows: {} };
  const memoryCall = (method, body) => fetch('/local/csvsync', { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then((r) => r.json()).then((m) => (m.rows ? (memory = m) : memory)).catch(() => memory);
  const [action] = await Promise.all([actionFor('categorize'), memoryCall('GET')]);
  const renderMemory = () => {
    const el = $('s-mem');
    if (!el) return;
    el.innerHTML = memory.count
      ? `Gemerkt: <b>${memory.count}</b> erledigte CSV-Zeile${memory.count === 1 ? '' : 'n'} (übertragen oder schon synchron${memory.since ? `, seit ${fmtDate(memory.since)}` : ''}) – werden beim erneuten Einlesen übersprungen.
        <button class="link-btn" data-forget>Gedächtnis leeren</button>`
      : '<span class="muted">Noch nichts gemerkt. Übertragene und schon synchrone Zeilen merkt sich das Dashboard, damit sie beim erneuten Einlesen derselben Datei übersprungen werden.</span>';
  };

  $('s-files').innerHTML = `
    <p class="sync-intro">Fehlen in Firefly die Empfänger (z. B. weil „Name Zahlungsbeteiligter“ beim Import nicht als Gegenkonto
      zugeordnet war), lassen sie sich hier aus den Original-CSV-Dateien nachtragen. Das Dashboard ordnet jede CSV-Zeile der
      vorhandenen Buchung zu (Betrag, Datum, Verwendungszweck) und zeigt vorher genau, was sich ändert. Kategorien, Tags und
      Notizen bleiben, wie sie sind.</p>
    <label class="drop" id="s-drop"><input type="file" id="s-input" accept=".csv,text/csv" multiple>
      <b>CSV-Dateien wählen</b> oder hierher ziehen <span class="muted">– mehrere auf einmal möglich (z. B. alle Jahre)</span></label>
    <div id="s-mem" class="sync-mem"></div>
    <div id="s-info" class="sync-info"></div>`;
  renderMemory();

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
    // schon früher übertragene Zeilen nicht noch einmal abgleichen
    const fps = fingerprints(unique);
    const known = [];
    const open = [];
    unique.forEach((row, k) => (memory.rows[fps[k]] ? known : open).push({ row, fp: fps[k] }));
    const dates = open.map((x) => x.row.date).sort();
    let txs = [];
    if (open.length) {
      info.innerHTML = `${notes.join('<br>')}<br><span class="muted">Lade Firefly-Buchungen ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))} …</span>`;
      // frisch aus Firefly (nicht aus dem Zwischenspeicher): so zählt auch, was ein
      // abgebrochener Lauf in n8n im Hintergrund noch gespeichert hat
      api.setFresh(true);
      try {
        txs = api.flattenTransactions(await api.getAll('transactions', {
          start: addDays(new Date(`${dates[0]}T12:00:00`), -4), end: addDays(new Date(`${dates.at(-1)}T12:00:00`), 4),
        }));
      } finally {
        api.setFresh(false);
      }
    }
    const matched = matchRows(open.map((x) => x.row), txs).map((r, k) => ({ ...r, fp: open[k].fp }));
    results = [...matched, ...known.map(({ row, fp }) => {
      const m = memory.rows[fp];
      return { row, fp, t: null, status: 'frueher', reason: `am ${fmtDate(m.at)} erledigt (Buchung Nr. ${m.j}, „${m.name}“)` };
    })];
    picked.clear();
    // vorgewählt nur, was sicher zugeordnet ist (Betrag, Datum und Text gleich)
    results.forEach((r, i) => r.status === 'neu' && r.sure && picked.add(i));
    filter = 'neu';
    info.innerHTML = `${notes.join('<br>')}<br>${unique.length} Zeilen${known.length ? ` · <b>${known.length} schon erledigt</b> (gemerkt, übersprungen)` : ''}${open.length
      ? ` · ${txs.length} Firefly-Buchungen im Zeitraum ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}` : ' · nichts Neues abzugleichen'}`;
    if (!open.length) filter = 'frueher';
    // schon synchron (Firefly hat den Namen aus der CSV) → merken, beim nächsten Mal überspringen
    const synced = matched.filter((r) => r.status === 'vorhanden' && r.t);
    if (synced.length) memoryCall('POST', { items: synced.map((r) => ({ fp: r.fp, j: r.t.transaction_journal_id, name: r.row.name })) }).then(renderMemory);
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
            : r.status === 'frueher' ? `<span class="muted">${esc(r.reason)} – wird nicht noch einmal abgeglichen</span>`
              : '<span class="muted">keine Buchung mit gleichem Betrag in der Nähe – vermutlich nie importiert oder in Firefly geändert</span>'}</td>
        <td class="num">${money(r.row.amount)}</td>
        <td><span class="badge ${STATUS[r.status][1]}" title="${esc(r.reason)}">${STATUS[r.status][0]}</span>
          ${['neu', 'abweichend', 'erledigt'].includes(r.status) && r.row.name ? `<div class="flow">Empfänger ${r.status === 'erledigt' ? 'ist jetzt' : 'wird'}: <b>${esc(r.row.name)}</b></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      ${rows.length > MAX_ROWS ? `<div class="legend" style="margin-top:8px"><span>Die ersten ${MAX_ROWS} von ${rows.length} (Auswahl gilt für alle)</span></div>` : ''}
      <div class="sync-run">
        ${action ? `<button class="btn primary" id="s-run"></button>
          <span class="muted">über „${esc(action.name)}“ – in kleinen Paketen, jedes wird danach in Firefly geprüft</span>`
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

  /** Buchung frisch aus Firefly lesen (am Zwischenspeicher vorbei): Steht der neue Empfänger schon drin? */
  async function isSynced(r) {
    const res = await fetch(`/api/transactions/${encodeURIComponent(r.t.groupId)}`, { headers: { 'X-No-Cache': '1' } }).catch(() => null);
    if (!res?.ok) return false;
    const body = await res.json().catch(() => null);
    const split = (body?.data?.attributes?.transactions || []).find((x) => String(x.transaction_journal_id) === String(r.t.transaction_journal_id));
    if (!split) return false;
    const party = String((split.type === 'deposit' ? split.source_name : split.destination_name) || '').trim();
    // angekommen: Name aus der CSV – oder (bei gleicher IBAN) ein anderes, aber echtes Gegenkonto als vorher
    return party.toLowerCase() === r.row.name.trim().toLowerCase() || (!hasNoParty(split) && party !== String(counterparty(r.t) || '').trim());
  }

  let stopRequested = false;
  async function transfer(btn) {
    const list = [...picked].sort((a, b) => a - b).map((i) => results[i]).filter((r) => r.t && (r.status === 'neu' || (r.status === 'abweichend' && overwrite)));
    if (!list.length) return;
    if (!window.confirm(`Bei ${list.length} Buchungen den Empfänger in Firefly setzen?\n\nFirefly ordnet sie dem Gegenkonto mit diesem Namen${withIban ? ' bzw. dieser IBAN' : ''} zu und legt es an, falls es noch fehlt. Kategorien, Tags und Notizen bleiben unverändert.\n\nEs geht in kleinen Paketen; jedes wird danach in Firefly nachgeprüft. Du kannst jederzeit anhalten.`)) return;
    btn.disabled = true;
    stopRequested = false;
    const out = $('s-out');
    const queue = [...list];
    let size = CHUNK_START;
    let done = 0;
    let failedInARow = 0;
    const started = Date.now();
    const finish = (r) => {
      r.status = 'erledigt';
      picked.delete(results.indexOf(r));
    };
    const progress = (msg) => {
      const left = queue.length;
      const per = done ? (Date.now() - started) / done : 0;
      out.innerHTML = `<div class="progress"><span style="width:${Math.round((done / list.length) * 100)}%"></span></div>
        <span class="muted">${msg} · ${done} von ${list.length} erledigt${per && left ? ` · noch ca. ${Math.max(1, Math.round((per * left) / 60000))} Min.` : ''} · Paketgröße ${size}</span>
        <button class="link-btn" data-stop>Anhalten</button>`;
    };
    while (queue.length && !stopRequested) {
      const part = queue.splice(0, size);
      progress(`Übertrage ${part.length} Buchungen …`);
      const payload = { typ: 'gegenkonto_setzen', aenderungen: part.map((r) => changeFor(r, { iban: withIban })) };
      const t0 = Date.now();
      const res = await runAction(action, { ...payload, daten: payload }).catch((err) => ({ ok: false, response: err.message }));
      const took = Date.now() - t0;
      let ok = part;
      if (!res.ok) {
        // abgebrochen oder Fehler: n8n hat evtl. trotzdem einen Teil gespeichert → in Firefly nachsehen
        progress(`Antwort fehlte (${esc(String(res.response || res.status || '').slice(0, 80))}) – prüfe in Firefly, was angekommen ist …`);
        await new Promise((r) => setTimeout(r, 5000));
        const checks = [];
        for (const r of part) checks.push(await isSynced(r));
        ok = part.filter((_, k) => checks[k]);
        const missing = part.filter((_, k) => !checks[k]);
        queue.unshift(...missing); // Rest noch einmal, mit kleineren Paketen
        size = Math.max(CHUNK_MIN, Math.floor(size / 2));
        failedInARow = ok.length ? 0 : failedInARow + 1;
        if (failedInARow >= 3) {
          ok.forEach(finish);
          done += ok.length;
          out.innerHTML = `<span class="badge bad">Abgebrochen</span> <span class="muted">Dreimal hintereinander kam nichts in Firefly an (${esc(String(res.response || res.status || '').slice(0, 160))}). ${done} sind übertragen; die übrigen bleiben ausgewählt – Automation unter „Automationen“ prüfen und erneut starten.</span>`;
          break;
        }
      } else {
        failedInARow = 0;
        // Paketgröße an die Laufzeit anpassen (Ziel ~1 Minute je Paket)
        const perItem = took / part.length;
        size = Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.round(TARGET_MS / Math.max(perItem, 200))));
      }
      ok.forEach(finish);
      done += ok.length;
      if (ok.length) {
        // merken – bei erneutem Einlesen überspringen
        await memoryCall('POST', { items: ok.map((r) => ({ fp: r.fp, j: r.t.transaction_journal_id, name: r.row.name })) });
        renderMemory();
      }
    }
    api.forget();
    const stopped = stopRequested && queue.length;
    const msg = out.innerHTML.includes('Abgebrochen') ? out.innerHTML : null;
    render();
    $('s-out').innerHTML = msg || `<span class="badge ${stopped ? 'warn' : 'good'}">${done} übertragen${stopped ? ` – angehalten, ${queue.length} offen` : ' ✓'}</span>
      <span class="muted">${stopped ? 'Die offenen bleiben ausgewählt; „übertragen“ macht dort weiter.' : 'Danach im Labor: Regel-Vorschläge nach Empfänger („REWE → Lebensmittel“) und die KI-Analyse werden deutlich besser.'}</span>`;
  }


  const drop = $('s-drop');
  $('s-input').addEventListener('change', (e) => e.target.files.length && load([...e.target.files]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  $('s-files').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-forget]')) return;
    if (!window.confirm(`Gedächtnis leeren? Die ${memory.count} gemerkten Zeilen werden beim nächsten Einlesen wieder abgeglichen (in Firefly ändert sich dadurch nichts).`)) return;
    await memoryCall('DELETE');
    renderMemory();
  });
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
    if (e.target.closest('[data-stop]')) {
      stopRequested = true;
      e.target.textContent = 'hält nach diesem Paket an …';
      return;
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
