// CSV-Archiv (Stufe vor dem Abgleich): alle Bank-CSV-Dateien einmal hochladen – sie bleiben
// auf dem Server. Das Archiv sortiert sie nach Konto (IBAN des Auftragskontos), zeigt je Konto
// Zeitraum, Lücken und – auf Knopfdruck – was davon schon in Firefly ist. Ausgewählte Konten
// oder Dateien gehen dann in den bekannten Abgleich darunter.

import * as api from './api.js';
import { esc, fmtDate, money, isoDate, today } from './util.js';
import { fireflyTxUrl } from './common.js';
import { deleteBookings } from './txedit.js';
import { decodeCsv, readRows, uniqueRows, matchRows, fingerprints, saldoCheck, summarizeSaldo, fileInfo } from './csvmatch.js';

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

export function csvArchive(el, { load, memory, editAction = () => null }) {
  let data = { files: [], status: {} };
  let accounts = []; // Firefly-Bestandskonten { id, name, iban } (iban auch leer)
  const fileCache = new Map(); // id → ArrayBuffer
  const selected = new Set(); // Datei-IDs
  const open = new Set(); // aufgeklappte Konten
  let busy = '';
  let checking = null; // Konto, das gerade mit Firefly abgeglichen wird
  const queued = new Set(); // Konten, die danach drankommen
  let justDone = null; // zuletzt fertig geprüftes Konto (kurz hervorgehoben)
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
  const infoOf = (buf) => fileInfo(decodeCsv(buf));
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

  /** Firefly-Konto zur IBAN: über die IBAN in Firefly oder von Hand zugeordnet. */
  const accountFor = (iban) => accounts.find((a) => a.iban && a.iban === iban) || accounts.find((a) => a.id === data.links?.[iban]);
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
    checking = g.key;
    queued.delete(g.key);
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
    const saldo = !rows.some((r) => r.saldo !== null) ? { skipped: 'spalte' } : !g.acc ? { skipped: 'konto' } : await checkSaldo(g, rows);
    data = await call('/status', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ status: { [g.key]: { counts, perFile, rows: unique.length, from: g.from, to: g.to, files: g.sig, saldo } } }) });
  }

  /** Kontostand laut Bank („Saldo nach Buchung“) gegen Firefly – frisch aus Firefly, nicht aus dem Zwischenspeicher. */
  async function checkSaldo(g, rows) {
    busy = `${g.label}: vergleiche Kontostand laut Bank mit Firefly …`;
    render();
    const t0 = isoDate(today());
    const first = rows.filter((r) => r.saldo !== null).map((r) => r.book).sort()[0];
    api.setFresh(true);
    let account;
    let txs;
    try {
      [account, txs] = await Promise.all([
        api.get(`accounts/${g.acc.id}`).then((r) => r.data.attributes),
        api.getAll(`accounts/${g.acc.id}/transactions`, { start: isoOf(day(first) - 7 * DAY), end: t0, _alle: true }).then(api.flattenTransactions),
      ]);
    } finally {
      api.setFresh(false);
    }
    const res = saldoCheck(rows, txs, { accountId: g.acc.id, current: account.current_balance, today: t0 });
    return res ? summarizeSaldo(res, rows, g.acc.id) : null;
  }

  /** Zeile unter dem Abgleich-Status: stimmt der Kontostand mit der Bank überein? */
  const saldoLine = (g) => {
    let s = g.status?.saldo;
    if (g.key === UNKNOWN) return '';
    if (!g.status) return '<div class="arch-saldo muted">Kontostand laut Bank mit Firefly vergleichen: „Mit Firefly abgleichen“ klicken.</div>';
    if (!s) return '<div class="arch-saldo muted">Kontostand laut Bank mit Firefly vergleichen: „Neu prüfen“ klicken.</div>';
    if (s.skipped === 'konto') return '<div class="arch-saldo muted">Kontostand-Vergleich braucht das Firefly-Konto: oben unter „Firefly-Konto“ auswählen, dann „Neu prüfen“.</div>';
    if (s.skipped === 'spalte') return '<div class="arch-saldo muted">Kein Kontostand-Vergleich: Die CSV-Dateien haben keine Spalte „Saldo nach Buchung“.</div>';
    if (Math.abs(s.diff) < 0.005) return `<div class="arch-saldo good"><div>Kontostand stimmt mit der Bank überein ✓ <span class="muted">(${fmtDate(s.last)}: ${money(s.bank)})</span></div></div>`;
    const link = (x) => (x.group && fireflyTxUrl({ groupId: x.group }) ? ` <a class="plain" href="${esc(fireflyTxUrl({ groupId: x.group }))}" target="_blank" rel="noopener" title="In Firefly öffnen">↗</a>` : '');
    const item = (x, extra = '') => `<li><span class="date">${fmtDate(x.date)}</span> <b>${money(x.amount, 'EUR', { signed: true })}</b> ${esc(x.text)}${link(x)}${extra}</li>`;
    const half = (x) => Math.abs(Math.abs(x.amount) * 2 - Math.abs(s.diff)) < 0.005 || Math.abs(Math.abs(x.amount) - Math.abs(s.diff)) < 0.005;
    const hint = (x) => (half(x) ? ' <span class="badge bad">passt zur Differenz</span>' : '');
    // fehlt eine ganze Datei, ist der Saldo-Sprung über die Lücke keine „fehlende Zeile“
    if (s.luecke && s.gaps?.length) s = { ...s, gaps: s.gaps.filter((x) => !(x.prev <= s.luecke.ende && x.date >= s.luecke.start)) };
    return `<div class="arch-saldo bad">
      <div><b>Kontostand weicht ab: ${money(s.diff, 'EUR', { signed: true })}</b> – Bank am ${fmtDate(s.last)}: ${money(s.bank)}, Firefly: ${money(s.firefly)}.
        ${s.since ? (s.before ? `Bis ${fmtDate(s.before)} stimmte es, ab ${fmtDate(s.since)} nicht mehr – die Ursache liegt dazwischen.` : `Die Differenz besteht schon am ersten Tag der CSV-Dateien (${fmtDate(s.since)}) – Ursache davor (z. B. Anfangssaldo) oder ältere CSV-Dateien hochladen.`) : ''}</div>
      ${s.luecke ? `<div class="arch-gap"><b>Für ${fmtDate(s.luecke.von)} – ${fmtDate(s.luecke.bis)} liegt keine CSV-Datei im Archiv</b> (eine Datei endet am ${fmtDate(s.luecke.ende)}, die nächste beginnt am ${fmtDate(s.luecke.start)}).
        Genau dort liegt die Abweichung – die Buchungen dieser Tage sind deshalb nur <b>ungeprüft</b>, nicht unbedingt falsch.
        <b>Lösung:</b> im Online-Banking die Umsätze ab ${fmtDate(s.luecke.von)} bis ${fmtDate(s.luecke.bis)} (gern etwas mehr) als CSV exportieren, oben ins Archiv legen und „Neu prüfen“ – dann zeigt der Vergleich die genaue Ursache.</div>` : ''}
      ${s.wrong.length ? `<div>In Firefly mit falscher Richtung bzw. falschem Vorzeichen (z. B. Umbuchung vertauscht – zählt doppelt):<ul>${s.wrong.map((x) => item(x, ` <span class="muted">· Firefly: ${money(x.firefly, 'EUR', { signed: true })}</span>${hint({ amount: x.amount })}`)).join('')}</ul></div>` : ''}
      ${s.missing.length ? `<div>Bei der Bank, aber nicht auf diesem Konto in Firefly${s.missingCount > s.missing.length ? ` (${s.missingCount}, die ersten ${s.missing.length})` : ''} – fehlt oder liegt auf einem anderen Konto:<ul>${s.missing.map((x) => item(x, hint(x))).join('')}</ul></div>` : ''}
      ${s.extra.length ? `<div>In Firefly auf diesem Konto, aber nicht in den CSV-Dateien${s.extraCount > s.extra.length ? ` (${s.extraCount}, die ersten ${s.extra.length})` : ''} – ${s.luecke ? 'die meisten liegen in den Tagen ohne CSV (markiert); verdächtig sind nur die übrigen:' : 'doppelt, falsches Konto oder noch nicht gebucht:'}<ul>${s.extra.map((x) => item(x, `${s.luecke && x.date >= s.luecke.von && x.date <= s.luecke.bis ? ' <span class="badge">keine CSV für diesen Tag</span>' : ''}${hint(x)}${x.twin ? `<br><span class="badge warn">vermutlich doppelt</span> <span class="muted">gleiche Buchung schon vorhanden – ${esc(x.twin)}</span>${link({ group: x.twinGroup })}${x.group && editAction() ? ` <button class="link-btn danger" type="button" data-saldo-del="${esc(x.group)}" data-key="${esc(g.key)}" data-info="${esc(`${fmtDate(x.date)} · ${x.text} · ${money(x.amount, 'EUR', { signed: true })}`)}" title="Die überzählige Buchung in Firefly löschen (über n8n)">diese löschen</button>` : ''}` : ''}`)).join('')}</ul>
        ${s.extra.some((x) => x.twin) ? '<div class="muted">„Vermutlich doppelt“: Dieselbe Bewegung steht zweimal in Firefly – oft einmal aus der CSV dieses Kontos (Ausgabe/Einnahme) und einmal aus der des anderen eigenen Kontos (Umbuchung). Eine davon löschen – „diese löschen“ erledigt das über n8n und prüft danach neu; bei Geld zwischen eigenen Konten die Umbuchung behalten.</div>' : ''}</div>` : ''}
      ${s.pending?.length ? `<div>In den CSV-Dateien als <b>vorgemerkt</b> (ohne Saldo), aber schon in Firefly – die Bank bucht sie später, oft mit anderem Text oder Datum; steht die gebuchte Fassung auch in Firefly, zählt der Betrag doppelt:<ul>${s.pending.map((x) => item(x, `${hint(x)}${x.twin ? `<br><span class="badge warn">vermutlich doppelt</span> <span class="muted">gebuchte Fassung – ${esc(x.twin)}</span>${link({ group: x.twinGroup })}` : ''}`)).join('')}</ul>
        ${s.pending.some((x) => x.twin) ? '<div class="muted">Die vorgemerkte Buchung in Firefly löschen, die gebuchte behalten.</div>' : ''}</div>` : ''}
      ${s.gaps?.length ? `<div>Saldo der Bank ändert sich anders, als die CSV-Zeilen ergeben – im Export fehlt vermutlich eine Zeile:<ul>${s.gaps.map((x) => `<li><span class="date">${fmtDate(x.date)}</span> Saldo ${money(x.change, 'EUR', { signed: true })} ggü. ${fmtDate(x.prev)}, Zeilen ${money(x.rows, 'EUR', { signed: true })} → <b>${money(x.amount, 'EUR', { signed: true })}</b> ohne Zeile${hint(x)}</li>`).join('')}</ul>
        <div class="muted">Im Online-Banking die Umsätze dieser Tage ansehen; die fehlende Buchung in Firefly nachtragen oder die CSV für diese Tage neu exportieren.</div></div>` : ''}
      ${!s.wrong.length && !s.missing.length && !s.extra.length && !s.pending?.length && !s.gaps?.length ? '<div class="muted">Alle Zeilen passen zu Firefly-Buchungen – die Differenz stammt aus der Zeit vor den CSV-Dateien (Anfangssaldo) oder aus Buchungen nach dem letzten CSV-Tag mit anderem Datum.</div>' : ''}
    </div>`;
  };

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
      ${busy ? `<div class="arch-busy" role="status"><span class="spinner" aria-hidden="true"></span> ${esc(busy)}</div>` : note ? `<div class="arch-note">${note}</div>` : ''}
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
            ${checking === g.key ? '<button class="btn small" disabled><span class="spinner" aria-hidden="true"></span> Prüfe …</button>'
    : queued.has(g.key) ? '<button class="btn small" disabled>wartet …</button>'
    : `<button class="btn small" data-check="${esc(g.key)}"${busy ? ' disabled' : ''}>${g.status ? 'Neu prüfen' : 'Mit Firefly abgleichen'}</button>`}
          </div>
          ${g.key !== UNKNOWN && accounts.length && !(g.acc?.iban === g.key) ? `<div class="arch-link"><label>Firefly-Konto <select class="input select" data-link="${esc(g.key)}">
            <option value="">– nicht zugeordnet –</option>
            ${accounts.map((a) => `<option value="${esc(a.id)}"${g.acc?.id === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
            ${g.acc ? '' : '<span class="muted">In Firefly hat kein Konto diese IBAN – bitte zuordnen.</span>'}</div>` : ''}
          ${checking === g.key ? `<div class="arch-progress" role="status"><span class="spinner" aria-hidden="true"></span> ${esc(busy.replace(`${g.label}: `, ''))}</div>` : ''}
          <div class="arch-status${justDone === g.key ? ' arch-flash' : ''}">${statusLine(g)}</div>
          ${saldoLine(g)}
          ${(() => {
            const miss = g.files.filter((f) => fileState(g, f).missing);
            return miss.length ? `<div class="arch-miss">Fehlende Einträge in ${miss.length} Datei${miss.length === 1 ? '' : 'en'}: ${miss.slice(0, 5).map((f) => `<b>${esc(f.name)}</b> ${f.info?.from ? `(${fmtDate(f.info.from)} – ${fmtDate(f.info.to)})` : ''}: ${fileState(g, f).missing}`).join(' · ')}${miss.length > 5 ? ` · +${miss.length - 5} weitere` : ''}
              <button class="link-btn" data-pick-missing="${esc(g.key)}">nur diese auswählen</button></div>` : '';
          })()}
          ${g.gaps.length ? `<div class="arch-gaps">Lücken ohne CSV: ${g.gaps.slice(0, 6).map(([a, b]) => `${fmtDate(a)} – ${fmtDate(b)}`).join(' · ')}${g.gaps.length > 6 ? ` · +${g.gaps.length - 6} weitere` : ''}</div>` : ''}
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

  el.addEventListener('change', async (e) => {
    if (e.target.dataset.link !== undefined) {
      data = await call('/link', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ iban: e.target.dataset.link, account: e.target.value || null }) });
      return render();
    }
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
      keys.forEach((k) => queued.add(k));
      const t0 = Date.now();
      const doneLabels = [];
      try {
        for (const key of keys) {
          const g = groups().find((x) => x.key === key);
          if (!g) continue;
          await checkGroup(g);
          doneLabels.push(g.label);
          justDone = key;
        }
        note = doneLabels.length ? `<span class="good">✓ ${doneLabels.map(esc).join(', ')} mit Firefly abgeglichen (${Math.max(1, Math.round((Date.now() - t0) / 1000))} s).</span>` : '';
      } catch (err) {
        note = `<span class="bad">Abgleich fehlgeschlagen: ${esc(err.message)}</span>`;
      }
      busy = '';
      checking = null;
      queued.clear();
      render();
      setTimeout(() => {
        justDone = null;
        el.querySelectorAll('.arch-flash').forEach((x) => x.classList.remove('arch-flash'));
      }, 3000);
    };
    if (t.dataset.saldoDel) {
      if (!window.confirm(`Diese Buchung in Firefly löschen?\n\n${t.dataset.info}\n\nSie steht doppelt in Firefly (die andere Fassung bleibt). Das lässt sich nicht rückgängig machen.`)) return;
      t.disabled = true;
      t.textContent = 'lösche …';
      try {
        await deleteBookings(editAction(), [t.dataset.saldoDel]);
        note = '<span class="good">✓ Doppelte Buchung in Firefly gelöscht – der Kontostand wird neu geprüft.</span>';
        render();
        return runChecks([t.dataset.key]);
      } catch (err) {
        note = `<span class="bad">${esc(err.message)}</span>`;
        return render();
      }
    }
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
      accounts = accs.filter((a) => a.attributes?.active !== false).map((a) => ({ id: String(a.id), name: a.attributes?.name || '', iban: String(a.attributes?.iban || '').replace(/\s+/g, '').toUpperCase() }));
      await ensureInfos();
    } catch (err) {
      note = `<span class="bad">Archiv nicht lesbar: ${esc(err.message)}</span>`;
    }
    busy = '';
    render();
  })();
}
