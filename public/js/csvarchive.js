// CSV-Archiv (Stufe vor dem Abgleich): alle Bank-CSV-Dateien einmal hochladen – sie bleiben
// auf dem Server. Das Archiv sortiert sie nach Konto (IBAN des Auftragskontos), zeigt je Konto
// Zeitraum, Lücken und – auf Knopfdruck – was davon schon in Firefly ist. Ausgewählte Konten
// oder Dateien gehen dann in den bekannten Abgleich darunter.

import * as api from './api.js';
import { esc, fmtDate } from './util.js';
import { decodeCsv, readRows, uniqueRows, matchRows, fingerprints } from './csvmatch.js';

const headers = { 'X-Requested-With': 'firefly-dashboard' };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
const UNKNOWN = 'unbekannt';
const DAY = 86400000;
const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const rowKey = (r) => [r.date, r.amount, r.name, r.purpose, r.text].join('|');
const fmtIban = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();

/** Zeitraum-Lücken zwischen den Dateien eines Kontos (mehr als 5 Tage ohne Datei). */
function gapsOf(files) {
  const spans = files.filter((f) => f.info?.from && f.info?.to).map((f) => [day(f.info.from), day(f.info.to)]).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let end = null;
  for (const [s, e] of spans) {
    if (end !== null && s - end > 5 * DAY) gaps.push([isoOf(end + DAY), isoOf(s - DAY)]);
    end = end === null ? e : Math.max(end, e);
  }
  return gaps;
}

export function csvArchive(el, { load, memory }) {
  let data = { files: [], status: {} };
  let accounts = []; // Firefly-Bestandskonten { id, name, iban }
  const fileCache = new Map(); // id → ArrayBuffer
  const selected = new Set(); // Datei-IDs
  const open = new Set(); // aufgeklappte Konten
  let busy = '';
  let note = '';

  const call = (path, opts = {}) => fetch(`/local/csvarchive${path}`, opts).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
    return body;
  });
  const bytesOf = async (f) => {
    if (!fileCache.has(f.id)) {
      const r = await fetch(`/local/csvarchive/file/${f.id}`);
      if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status}`);
      fileCache.set(f.id, await r.arrayBuffer());
    }
    return fileCache.get(f.id);
  };
  /** Eckdaten einer Datei: Konto, Zeitraum, Zeilen. */
  const infoOf = (buf) => {
    try {
      const parsed = readRows(decodeCsv(buf));
      const dates = parsed.rows.map((r) => r.date).sort();
      const owns = new Map();
      parsed.rows.forEach((r) => r.own && owns.set(r.own.toUpperCase(), (owns.get(r.own.toUpperCase()) || 0) + 1));
      const own = [...owns].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { own, from: dates[0] || '', to: dates.at(-1) || '', rows: parsed.rows.length, ...(parsed.rows.length ? {} : { error: 'keine Buchungszeilen erkannt' }) };
    } catch (err) {
      return { own: '', from: '', to: '', rows: 0, error: err.message };
    }
  };
  /** Fehlende Eckdaten nachtragen (ältere Uploads, andere Geräte). */
  async function ensureInfos() {
    const missing = data.files.filter((f) => !f.info);
    if (!missing.length) return;
    const infos = {};
    for (const [k, f] of missing.entries()) {
      busy = `Lese Dateien … ${k + 1} von ${missing.length}`;
      render();
      infos[f.id] = infoOf(await bytesOf(f));
    }
    data = await call('/info', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ infos }) });
    busy = '';
  }

  const accountFor = (iban) => accounts.find((a) => a.iban === iban);
  /** Dateien nach Konto gruppieren. */
  const groups = () => {
    const map = new Map();
    for (const f of data.files) {
      const key = f.info?.own || UNKNOWN;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
    return [...map].map(([key, files]) => {
      files.sort((a, b) => String(a.info?.from || '').localeCompare(String(b.info?.from || '')));
      const acc = key === UNKNOWN ? null : accountFor(key);
      const froms = files.map((f) => f.info?.from).filter(Boolean).sort();
      const tos = files.map((f) => f.info?.to).filter(Boolean).sort();
      const sig = files.map((f) => f.id).sort().join(',');
      const status = data.status[key];
      return {
        key, files, acc, from: froms[0], to: tos.at(-1), sig, gaps: gapsOf(files),
        rows: files.reduce((n, f) => n + (f.info?.rows || 0), 0),
        status, stale: status && status.files !== sig,
        label: key === UNKNOWN ? 'Konto nicht erkannt' : acc?.name || 'nicht in Firefly gefunden',
      };
    }).sort((a, b) => (a.key === UNKNOWN) - (b.key === UNKNOWN) || a.label.localeCompare(b.label, 'de'));
  };

  /** Dateien als File-ähnliche Objekte (eindeutige Namen – Bank-Exporte heißen oft gleich). */
  const asFiles = async (files) => {
    const seen = new Map();
    const out = [];
    for (const f of files) {
      const n = (seen.get(f.name) || 0) + 1;
      seen.set(f.name, n);
      const buf = await bytesOf(f);
      out.push({ id: f.id, name: n > 1 ? f.name.replace(/(\.csv)?$/i, ` (${n})$1`) : f.name, arrayBuffer: async () => buf });
    }
    return out;
  };

  /** Konto mit Firefly abgleichen: wie viele Zeilen sind dort, wie viele ohne Empfänger, welche fehlen. */
  async function checkGroup(g) {
    busy = `${g.label}: lese ${g.files.length} Datei${g.files.length === 1 ? '' : 'en'} …`;
    render();
    const rows = [];
    const idOf = new Map(); // eindeutiger Dateiname → Archiv-ID
    for (const f of await asFiles(g.files)) {
      idOf.set(f.name, f.id);
      rows.push(...readRows(decodeCsv(await f.arrayBuffer()), f.name).rows);
    }
    const unique = uniqueRows(rows);
    const fps = fingerprints(unique);
    const mem = memory();
    const fresh = unique.filter((_, k) => !mem.rows?.[fps[k]]);
    const counts = { frueher: unique.length - fresh.length };
    const byKey = new Map(); // Zeile → Ergebnisse (für die Zuordnung zu jeder Datei, die sie enthält)
    if (fresh.length) {
      const dates = fresh.map((r) => r.date).sort();
      const start = isoOf(day(dates[0]) - 4 * DAY);
      const end = isoOf(day(dates.at(-1)) + 4 * DAY);
      busy = `${g.label}: lade Firefly-Buchungen ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))} …`;
      render();
      const groupsData = g.acc ? await api.getAll(`accounts/${g.acc.id}/transactions`, { start, end, _alle: true }) : await api.getAll('transactions', { start, end, _alle: true });
      const txs = api.flattenTransactions(groupsData);
      for (const r of matchRows(fresh, txs)) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        const k = rowKey(r.row);
        if (!byKey.has(k)) byKey.set(k, { 'nicht-gefunden': 0, neu: 0, abweichend: 0 });
        if (r.status in byKey.get(k)) byKey.get(k)[r.status] += 1;
      }
    }
    // je Datei: auch überlappende Dateien zeigen die Zeilen, die in Firefly fehlen
    const perFile = {};
    for (const f of new Set(rows.map((r) => r.file))) {
      const inFile = new Map();
      rows.filter((r) => r.file === f).forEach((r) => inFile.set(rowKey(r), (inFile.get(rowKey(r)) || 0) + 1));
      const c = { missing: 0, neu: 0, abweichend: 0 };
      inFile.forEach((n, k) => {
        const res = byKey.get(k);
        if (!res) return;
        c.missing += Math.min(n, res['nicht-gefunden']);
        c.neu += Math.min(n, res.neu);
        c.abweichend += Math.min(n, res.abweichend);
      });
      perFile[idOf.get(f)] = c;
    }
    data = await call('/status', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ status: { [g.key]: { counts, perFile, rows: unique.length, from: g.from, to: g.to, files: g.sig } } }) });
  }

  async function upload(list) {
    const files = [...list].filter((f) => /\.csv$/i.test(f.name) || f.type === 'text/csv');
    if (!files.length) {
      note = 'Keine CSV-Dateien dabei.';
      return render();
    }
    let added = 0;
    let dup = 0;
    const errors = [];
    const infos = {};
    for (const [k, f] of files.entries()) {
      busy = `Lade hoch … ${k + 1} von ${files.length}: ${f.name}`;
      render();
      try {
        const buf = await f.arrayBuffer();
        const res = await call(`?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/csv' }, body: buf });
        fileCache.set(res.file.id, buf);
        if (res.duplicate) dup += 1;
        else {
          added += 1;
          infos[res.file.id] = infoOf(buf);
        }
      } catch (err) {
        errors.push(`${f.name}: ${err.message}`);
      }
    }
    data = Object.keys(infos).length ? await call('/info', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ infos }) }) : await call('');
    busy = '';
    note = `${added} Datei${added === 1 ? '' : 'en'} ins Archiv übernommen${dup ? ` · ${dup} schon vorhanden (gleicher Inhalt)` : ''}${errors.length ? ` · <span class="bad">${errors.map(esc).join('; ')}</span>` : ''}`;
    render();
  }

  const statusLine = (g) => {
    const s = g.status;
    if (!s) return '<span class="muted">noch nicht mit Firefly abgeglichen</span>';
    const c = s.counts || {};
    const inFirefly = (c.neu || 0) + (c.abweichend || 0) + (c.vorhanden || 0) + (c.frueher || 0) + (c.mehrdeutig || 0) + (c['ohne-name'] || 0) + (c.umbuchung || 0);
    const parts = [
      `<b>${inFirefly}</b> von ${s.rows} in Firefly`,
      c.neu ? `<span class="badge good">${c.neu} ohne Empfänger</span>` : '',
      c.abweichend ? `<span class="badge warn">${c.abweichend} anderer Empfänger</span>` : '',
      c['nicht-gefunden'] ? `<span class="badge bad">${c['nicht-gefunden']} fehlen in Firefly</span>` : '',
      (c.vorhanden || 0) + (c.frueher || 0) ? `${(c.vorhanden || 0) + (c.frueher || 0)} synchron` : '',
      c.mehrdeutig ? `${c.mehrdeutig} mehrdeutig` : '',
    ].filter(Boolean);
    return `${parts.join(' · ')} <span class="muted">· geprüft ${fmtDate(s.at)}${g.stale ? ' – <b>Dateien seitdem geändert</b>' : ''}</span>`;
  };

  /** Ergebnis des letzten Firefly-Abgleichs für eine Datei (leer, wenn nie geprüft). */
  const fileState = (g, f) => (g.status?.perFile || {})[f.id] || {};
  const fileBadges = (g, f) => {
    if (!g.status) return '';
    const c = (g.status.perFile || {})[f.id];
    if (!c) return '<span class="muted">· nach der Prüfung hinzugekommen</span>';
    return [
      c.missing ? `<span class="badge bad" title="Diese Zeilen fanden sich in Firefly nicht – über „Neue Zeilen importieren“ nachholen">${c.missing} fehlen in Firefly</span>` : '',
      c.neu ? `<span class="badge good">${c.neu} ohne Empfänger</span>` : '',
      c.abweichend ? `<span class="badge warn">${c.abweichend} anderer Empfänger</span>` : '',
      !c.missing && !c.neu && !c.abweichend ? '<span class="badge">alles in Firefly ✓</span>' : '',
    ].join(' ');
  };

  function render() {
    const gs = groups();
    const total = data.files.length;
    const sel = data.files.filter((f) => selected.has(f.id));
    el.innerHTML = `
      <p class="sync-intro">Alle Bank-CSV-Dateien einmal hier ablegen – auch viele auf einmal oder einen ganzen Ordner. Sie bleiben auf dem
        Server (auf allen Geräten, auch nach Updates), werden nach Konto sortiert, und du wählst aus, was in den Abgleich darunter geht.
        Gleiche Dateien landen nur einmal im Archiv.</p>
      <div class="arch-drop">
        <label class="drop" id="a-drop"><input type="file" id="a-input" accept=".csv,text/csv" multiple><b>Dateien ins Archiv</b> wählen oder hierher ziehen</label>
        <label class="btn small"><input type="file" id="a-dir" webkitdirectory multiple hidden>Ordner wählen</label>
      </div>
      ${busy ? `<div class="muted arch-busy">${esc(busy)}</div>` : note ? `<div class="arch-note">${note}</div>` : ''}
      ${total ? `
      <div class="arch-list">${gs.map((g) => {
        const ids = g.files.map((f) => f.id);
        const nSel = ids.filter((id) => selected.has(id)).length;
        return `<div class="arch-acc" data-key="${esc(g.key)}">
          <div class="arch-head">
            <input type="checkbox" data-acc="${esc(g.key)}" ${nSel === ids.length ? 'checked' : ''} ${nSel && nSel < ids.length ? 'data-partial="1"' : ''} aria-label="Konto auswählen">
            <button class="arch-toggle" data-open="${esc(g.key)}" aria-expanded="${open.has(g.key)}">
              <b>${esc(g.label)}</b> ${g.key !== UNKNOWN ? `<span class="muted">${esc(fmtIban(g.key))}</span>` : ''}
            </button>
            <span class="arch-meta">${g.files.length} Datei${g.files.length === 1 ? '' : 'en'} · ${g.from ? `${fmtDate(g.from)} – ${fmtDate(g.to)}` : '–'} · ${g.rows} Zeilen</span>
            <button class="btn small" data-check="${esc(g.key)}"${busy ? ' disabled' : ''}>${g.status ? 'Neu prüfen' : 'Mit Firefly abgleichen'}</button>
          </div>
          <div class="arch-status">${statusLine(g)}</div>
          ${(() => {
            const miss = g.files.filter((f) => fileState(g, f).missing);
            return miss.length ? `<div class="arch-miss">Fehlende Einträge in ${miss.length} Datei${miss.length === 1 ? '' : 'en'}: ${miss.slice(0, 5).map((f) => `<b>${esc(f.name)}</b> ${f.info?.from ? `(${fmtDate(f.info.from)} – ${fmtDate(f.info.to)})` : ''}: ${fileState(g, f).missing}`).join(' · ')}${miss.length > 5 ? ` · +${miss.length - 5} weitere` : ''}
              <button class="link-btn" data-pick-missing="${esc(g.key)}">nur diese auswählen</button></div>` : '';
          })()}
          ${g.gaps.length ? `<div class="arch-gaps">Lücken ohne CSV: ${g.gaps.slice(0, 6).map(([a, b]) => `${fmtDate(a)} – ${fmtDate(b)}`).join(' · ')}${g.gaps.length > 6 ? ` · +${g.gaps.length - 6} weitere` : ''}</div>` : ''}
          ${g.key !== UNKNOWN && !g.acc && accounts.length ? '<div class="arch-gaps">Kein Bestandskonto mit dieser IBAN in Firefly – abgeglichen wird gegen alle Buchungen.</div>' : ''}
          ${open.has(g.key) ? `<table class="arch-files"><tbody>${g.files.map((f) => `<tr${fileState(g, f).missing ? ' class="arch-missing"' : ''}>
            <td><input type="checkbox" data-file="${f.id}" ${selected.has(f.id) ? 'checked' : ''} aria-label="Datei auswählen"></td>
            <td>${esc(f.name)}${f.info?.error ? ` <span class="bad">(${esc(f.info.error)})</span>` : ''} ${fileBadges(g, f)}</td>
            <td>${f.info?.from ? `${fmtDate(f.info.from)} – ${fmtDate(f.info.to)}` : '–'}</td>
            <td class="num">${f.info?.rows ?? '–'} Zeilen</td>
            <td class="muted">hochgeladen ${fmtDate(f.at)}</td>
            <td><button class="link-btn" data-del="${f.id}" title="Aus dem Archiv löschen">löschen</button></td></tr>`).join('')}</tbody></table>` : ''}
        </div>`;
      }).join('')}</div>
      <div class="arch-actions">
        <button class="btn primary" id="a-load"${sel.length && !busy ? '' : ' disabled'}>Ausgewählte abgleichen${sel.length ? ` (${sel.length} Datei${sel.length === 1 ? '' : 'en'})` : ''}</button>
        <button class="btn" id="a-check-sel"${sel.length && !busy ? '' : ' disabled'}>Ausgewählte Konten mit Firefly abgleichen</button>
        <span class="muted">„Abgleichen“ lädt die Zeilen unten in „Bank-CSV abgleichen“ – dort wählst du wie gewohnt, was nach Firefly geht.</span>
      </div>` : '<div class="empty">Noch keine Dateien im Archiv.</div>'}`;
    el.querySelectorAll('[data-partial]').forEach((x) => (x.indeterminate = true));
  }

  el.addEventListener('change', (e) => {
    if (e.target.id === 'a-input' || e.target.id === 'a-dir') return e.target.files.length && upload(e.target.files);
    const acc = e.target.dataset.acc;
    if (acc !== undefined) {
      const g = groups().find((x) => x.key === acc);
      g?.files.forEach((f) => (e.target.checked ? selected.add(f.id) : selected.delete(f.id)));
      return render();
    }
    if (e.target.dataset.file) {
      if (e.target.checked) selected.add(e.target.dataset.file);
      else selected.delete(e.target.dataset.file);
      render();
    }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.open !== undefined) {
      if (open.has(t.dataset.open)) open.delete(t.dataset.open);
      else open.add(t.dataset.open);
      return render();
    }
    if (t.dataset.del) {
      const f = data.files.find((x) => x.id === t.dataset.del);
      if (!f || !window.confirm(`„${f.name}“ aus dem Archiv löschen? In Firefly ändert sich nichts.`)) return;
      data = await call(`/file/${f.id}`, { method: 'DELETE', headers });
      selected.delete(f.id);
      fileCache.delete(f.id);
      note = '';
      return render();
    }
    const runChecks = async (keys) => {
      try {
        for (const key of keys) {
          const g = groups().find((x) => x.key === key);
          if (g) await checkGroup(g);
        }
        note = '';
      } catch (err) {
        note = `<span class="bad">Abgleich fehlgeschlagen: ${esc(err.message)}</span>`;
      }
      busy = '';
      render();
    };
    if (t.dataset.pickMissing !== undefined) {
      const g = groups().find((x) => x.key === t.dataset.pickMissing);
      if (!g) return;
      g.files.forEach((f) => selected.delete(f.id));
      g.files.filter((f) => fileState(g, f).missing).forEach((f) => selected.add(f.id));
      open.add(g.key);
      return render();
    }
    if (t.dataset.check) return runChecks([t.dataset.check]);
    if (t.id === 'a-check-sel') return runChecks(groups().filter((g) => g.files.some((f) => selected.has(f.id))).map((g) => g.key));
    if (t.id === 'a-load') {
      const files = data.files.filter((f) => selected.has(f.id));
      busy = `Lade ${files.length} Datei${files.length === 1 ? '' : 'en'} …`;
      render();
      try {
        const objs = await asFiles(files);
        busy = '';
        note = `${files.length} Datei${files.length === 1 ? '' : 'en'} im Abgleich – siehe unten.`;
        render();
        await load(objs);
      } catch (err) {
        busy = '';
        note = `<span class="bad">${esc(err.message)}</span>`;
        render();
      }
    }
  });
  const drop = el;
  drop.addEventListener('dragover', (e) => {
    if (!e.target.closest('#a-drop')) return;
    e.preventDefault();
    e.target.closest('#a-drop').classList.add('over');
  });
  drop.addEventListener('dragleave', (e) => e.target.closest('#a-drop')?.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    if (!e.target.closest('#a-drop')) return;
    e.preventDefault();
    e.target.closest('#a-drop').classList.remove('over');
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  });

  (async () => {
    busy = 'Lade Archiv …';
    render();
    try {
      const [list, accs] = await Promise.all([call(''), api.getAll('accounts', { type: 'asset' }).catch(() => [])]);
      data = list;
      accounts = accs.map((a) => ({ id: a.id, name: a.attributes?.name || '', iban: String(a.attributes?.iban || '').replace(/\s+/g, '').toUpperCase() })).filter((a) => a.iban);
      await ensureInfos();
    } catch (err) {
      note = `<span class="bad">Archiv nicht lesbar: ${esc(err.message)}</span>`;
    }
    busy = '';
    render();
  })();
}
