// Seite „CSV-Abgleich“: Bank-CSV-Dateien hochladen, ihre Zeilen den Firefly-
// Buchungen zuordnen und fehlende Empfänger (Name/IBAN des Zahlungs-
// beteiligten) nachtragen. Die Dateien werden nur im Browser gelesen; nach
// Firefly geht erst etwas über die Automation „Kategorie übernehmen“
// (n8n-Workflow, typ „gegenkonto_setzen“). Kategorien bleiben unverändert.

import * as api from './api.js';
import { money, esc, fmtDate, addDays, storage, store } from './util.js';
import { card, counterparty, fireflyTxUrl, downloadCsv } from './common.js';
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
const SIZES = ['auto', '10', '25', '50', '100', '200'];
const PARALLEL = ['1', '2', '3', '4'];
const MAX_ROWS = 600;

export async function csvSync(view) {
  view.innerHTML = `
    <div class="grid">
      ${card('s-files', 'Bank-CSV abgleichen', { meta: '<span class="muted">Dateien bleiben in deinem Browser</span>' })}
      ${card('s-open', 'Noch nicht umgestellt: Buchungen ohne Empfänger in Firefly', { meta: '<span id="s-open-meta"></span>' })}
      ${card('s-result', 'Ergebnis', { filter: true, meta: '<span id="s-meta"></span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  let results = [];
  let filter = 'neu';
  let overwrite = false;
  let withIban = true;
  // Paketgröße und parallele Pakete – je Browser gemerkt
  let chunkSetting = SIZES.includes(storage('ffd-sync-size', 'auto')) ? storage('ffd-sync-size', 'auto') : 'auto';
  let parallel = PARALLEL.includes(storage('ffd-sync-parallel', '1')) ? Number(storage('ffd-sync-parallel', '1')) : 1;
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
    if (openScan && !openScan.loading) renderOpen(); // Abgleich mit „noch nicht umgestellt“
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
          <label class="sync-set">Paketgröße <select data-opt="size">${SIZES.map((v) => `<option value="${v}"${v === chunkSetting ? ' selected' : ''}>${v === 'auto' ? 'automatisch (~1 Min. je Paket)' : `${v} Buchungen`}</option>`).join('')}</select></label>
          <label class="sync-set">gleichzeitig <select data-opt="parallel">${PARALLEL.map((v) => `<option value="${v}"${Number(v) === parallel ? ' selected' : ''}>${v} Paket${v === '1' ? '' : 'e'}</option>`).join('')}</select></label>
          <span class="muted">über „${esc(action.name)}“ – jedes Paket wird danach in Firefly geprüft. Mehrere Pakete gleichzeitig sind meist am schnellsten; ein Paket sollte unter 5 Minuten bleiben.</span>`
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
    const fixed = chunkSetting !== 'auto';
    let size = fixed ? Number(chunkSetting) : CHUNK_START;
    let done = 0;
    let failedInARow = 0;
    let aborted = null;
    let running = 0;
    const started = Date.now();
    const finish = (r) => {
      r.status = 'erledigt';
      picked.delete(results.indexOf(r));
    };
    const progress = (msg) => {
      if (aborted) return;
      const left = queue.length;
      const per = done ? (Date.now() - started) / done : 0;
      out.innerHTML = `<div class="progress"><span style="width:${Math.round((done / list.length) * 100)}%"></span></div>
        <span class="muted">${msg} · ${done} von ${list.length} erledigt${per && left ? ` · noch ca. ${Math.max(1, Math.round((per * (left + running)) / 60000))} Min.` : ''} · Paketgröße ${size}${parallel > 1 ? ` · ${parallel} gleichzeitig` : ''}</span>
        <button class="link-btn" data-stop>Anhalten</button>`;
    };
    // mehrere „Arbeiter“ holen sich abwechselnd Pakete aus derselben Warteschlange
    const worker = async () => {
      while (queue.length && !stopRequested && !aborted) {
        const part = queue.splice(0, size);
        running += part.length;
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
          const checks = await Promise.all(part.map(isSynced));
          ok = part.filter((_, k) => checks[k]);
          queue.unshift(...part.filter((_, k) => !checks[k])); // Rest noch einmal, mit kleineren Paketen
          size = Math.max(CHUNK_MIN, Math.floor(size / 2));
          failedInARow = ok.length ? 0 : failedInARow + 1;
          if (failedInARow >= 3 * parallel) {
            aborted = String(res.response || res.status || '').slice(0, 160);
          }
        } else {
          failedInARow = 0;
          // automatisch: Paketgröße an die Laufzeit anpassen (Ziel ~1 Minute je Paket)
          if (!fixed) size = Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.round(TARGET_MS / Math.max(took / part.length, 200))));
        }
        running -= part.length;
        ok.forEach(finish);
        done += ok.length;
        if (ok.length) {
          // merken – bei erneutem Einlesen überspringen
          await memoryCall('POST', { items: ok.map((r) => ({ fp: r.fp, j: r.t.transaction_journal_id, name: r.row.name })) });
          renderMemory();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, Math.ceil(list.length / size)) }, worker));
    if (aborted) {
      out.innerHTML = `<span class="badge bad">Abgebrochen</span> <span class="muted">Mehrmals hintereinander kam nichts in Firefly an (${esc(aborted)}). ${done} sind übertragen; die übrigen bleiben ausgewählt – Automation unter „Automationen“ prüfen, ggf. kleinere Pakete oder weniger gleichzeitig wählen und erneut starten.</span>`;
    }
    api.forget();
    if (openScan && !openScan.loading) scanOpen(); // „noch nicht umgestellt“ aktualisieren
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
    if (e.target.dataset.opt === 'size') {
      chunkSetting = e.target.value;
      store('ffd-sync-size', chunkSetting);
      return;
    }
    if (e.target.dataset.opt === 'parallel') {
      parallel = Number(e.target.value);
      store('ffd-sync-parallel', String(parallel));
      return;
    }
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
  // ---- Noch nicht umgestellt: direkt in Firefly nachsehen (ohne CSV) -----------------
  let openScan = null; // { list, total, from, to }
  let openMonth = null;
  const SCAN_RANGES = [['24', 'letzte 24 Monate'], ['60', 'letzte 5 Jahre'], ['all', 'alles (seit 2000)']];
  let scanRange = '24';
  const monthKey = (t) => String(t.date).slice(0, 7);
  const accountOf = (t) => (t.type === 'deposit' ? t.destination_name : t.source_name) || '–';
  const monthLabel = (k) => fmtDate(`${k}-15`, { month: 'long', year: 'numeric' });

  function renderOpen() {
    const el = $('s-open');
    const head = `<div class="sync-scan">
        <label>Zeitraum <select data-scan-range>${SCAN_RANGES.map(([k, l]) => `<option value="${k}"${k === scanRange ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn" data-scan>${openScan ? 'Neu prüfen' : 'In Firefly prüfen'}</button>
        <span class="muted">liest Ausgaben und Einnahmen frisch aus Firefly und zeigt alle, bei denen kein echter Empfänger steht („(no name)“, leer, nur „Kartenzahlung“ …)</span></div>`;
    if (!openScan) {
      el.innerHTML = head;
      return;
    }
    if (openScan.loading) {
      el.innerHTML = `${head}<div class="muted">Lese Buchungen aus Firefly …</div>`;
      return;
    }
    const { list, total } = openScan;
    $('s-open-meta').textContent = list.length ? `${list.length} offen` : 'alles umgestellt';
    if (!list.length) {
      el.innerHTML = `${head}<div class="empty">Alle ${total} Buchungen im Zeitraum haben einen echten Empfänger. 🎉</div>`;
      return;
    }
    const byMonth = new Map();
    for (const t of list) {
      const k = monthKey(t);
      const g = byMonth.get(k) || { n: 0, sum: 0, accounts: new Map() };
      g.n += 1;
      g.sum += t.amount;
      g.accounts.set(accountOf(t), (g.accounts.get(accountOf(t)) || 0) + 1);
      byMonth.set(k, g);
    }
    const max = Math.max(...[...byMonth.values()].map((g) => g.n));
    // in einer schon eingelesenen CSV enthalten? (dann reicht „übertragen“ unten)
    const inCsv = new Set(results.filter((r) => r.t && ['neu', 'abweichend'].includes(r.status)).map((r) => String(r.t.transaction_journal_id)));
    const covered = list.filter((t) => inCsv.has(String(t.transaction_journal_id))).length;
    const rows = openMonth ? list.filter((t) => monthKey(t) === openMonth).sort((a, b) => String(a.date).localeCompare(String(b.date))) : [];
    el.innerHTML = `${head}
      <p class="sync-top"><b>${list.length}</b> von ${total} Buchungen (${Math.round((list.length / total) * 100)} %) haben noch keinen echten Empfänger
        ${results.length ? ` · davon <b>${covered}</b> in der eingelesenen CSV (unten übertragbar), <b>${list.length - covered}</b> nicht` : ''}
        · <button class="link-btn" data-open-csv>Liste als CSV ↓</button></p>
      <div class="table-wrap scroll"><table class="sync-months"><thead><tr><th>Monat</th><th class="num">offen</th><th class="num hide-sm">Summe</th><th class="hide-sm">Konten</th><th></th></tr></thead><tbody>
      ${[...byMonth].sort((a, b) => b[0].localeCompare(a[0])).map(([k, g]) => `<tr data-month="${k}" class="${k === openMonth ? 'active' : ''}">
        <td>${esc(monthLabel(k))}</td><td class="num"><b>${g.n}</b></td><td class="num hide-sm">${money(g.sum)}</td>
        <td class="hide-sm"><span class="flow">${[...g.accounts].map(([a, n]) => `${esc(a)} (${n})`).join(', ')}</span></td>
        <td><div class="mini-bar"><i style="width:${Math.round((g.n / max) * 100)}%"></i></div></td></tr>
        ${k === openMonth ? `<tr class="sync-month-rows"><td colspan="5"><table><tbody>${rows.map((t) => `<tr style="cursor:default">
          <td class="date">${fmtDate(t.date)}</td>
          <td>${fireflyBoxShort(t)}${inCsv.has(String(t.transaction_journal_id)) ? '<span class="badge good">in der CSV gefunden</span>' : ''}</td>
          <td class="num">${money(t.type === 'deposit' ? t.amount : -t.amount)}</td></tr>`).join('')}</tbody></table></td></tr>` : ''}`).join('')}
      </tbody></table></div>
      <div class="legend" style="margin-top:8px"><span>Monat anklicken zeigt die Buchungen. Für Monate mit offenen Buchungen die CSV-Datei der Bank oben einlesen.</span></div>`;
  }
  const fireflyBoxShort = (t) => {
    const url = fireflyTxUrl(t);
    return `<div class="desc">${esc(t.description || '–')}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener" class="ff-link" title="In Firefly öffnen">↗</a>` : ''}</div>
      <div class="flow">${esc(accountOf(t))} · Empfänger: ${esc(counterparty(t) || '–')} · Kategorie: ${esc(t.category_name || 'ohne')} · Nr. ${esc(t.transaction_journal_id)}</div>
      ${t.notes ? `<div class="flow">Notiz: ${esc(String(t.notes).slice(0, 100))}</div>` : ''}`;
  };

  async function scanOpen() {
    const to = new Date();
    const from = scanRange === 'all' ? new Date(2000, 0, 1) : new Date(to.getFullYear(), to.getMonth() - Number(scanRange), 1);
    openScan = { loading: true };
    renderOpen();
    api.setFresh(true);
    let txs;
    try {
      txs = api.flattenTransactions(await api.getAll('transactions', { start: from, end: to }))
        .filter((t) => t.type === 'withdrawal' || t.type === 'deposit');
    } catch (err) {
      openScan = null;
      $('s-open').innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
      return;
    } finally {
      api.setFresh(false);
    }
    openScan = { list: txs.filter(hasNoParty), total: txs.length, from, to };
    openMonth = null;
    renderOpen();
  }

  $('s-open').addEventListener('click', (e) => {
    if (e.target.closest('[data-scan]')) return scanOpen();
    if (e.target.closest('a')) return;
    if (e.target.closest('[data-open-csv]')) {
      return downloadCsv(`ohne-empfaenger-${new Date().toISOString().slice(0, 10)}.csv`, [
        ['Datum', 'Konto', 'Beschreibung', 'Notizen', 'Betrag', 'Empfänger in Firefly', 'Kategorie', 'Buchungsnummer'],
        ...openScan.list.map((t) => [String(t.date).slice(0, 10), accountOf(t), t.description, t.notes || '', t.type === 'deposit' ? t.amount : -t.amount, counterparty(t) || '', t.category_name || '', t.transaction_journal_id]),
      ]);
    }
    const m = e.target.closest('[data-month]');
    if (m) {
      openMonth = openMonth === m.dataset.month ? null : m.dataset.month;
      renderOpen();
    }
  });
  $('s-open').addEventListener('change', (e) => {
    if (e.target.matches('[data-scan-range]')) scanRange = e.target.value;
  });
  renderOpen();

  render();
}
