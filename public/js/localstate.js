// Seite „Nur im Dashboard“ (Werkzeuge): Was steckt nur im Dashboard (DATA_DIR) und nicht in Firefly?
// Was wäre nach einer Neuinstallation mit leerem /data weg, was müsste neu eingerichtet werden, was kommt von
// selbst wieder? Dazu Sicherung herunterladen und zurückspielen.

import { esc, money, fmtDate } from './util.js';
import { actionFor, runAction } from './txedit.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const plural = (n, one, many) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;
const bytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const GEMERKT = {
  duplicates: '„Kein Duplikat“ markiert',
  structure: 'ignorierte Struktur-Hinweise',
  reviewed: '„passt so“ markiert',
  parties: 'Gegenkonten „kein Fehler“',
};
const TRIGGER = {
  manual: 'manuell', 'report-calendar': 'Monatsbericht', 'report-salary': 'Gehaltsbericht', alerts: 'Warnungen', categorize: 'Kategorie übernehmen',
  tags: 'Tags', import: 'Import', update: 'Update', 'report-week': 'Wochenrückblick', rules: 'Firefly-Regeln anlegen', backup: 'Firefly-Backup',
  'csv-import': 'CSV-Import', 'import-report': 'Import-Bericht',
};

export async function localStatePage(view) {
  view.innerHTML = `
    <div class="grid">
      <section class="card span-12">
        <div class="card-head"><h2>Was steckt nur im Dashboard?</h2><span class="meta" id="ls-meta">wird gezählt …</span></div>
        <p class="muted" style="margin-top:0">Alles, was du im Dashboard anlegst, liegt im Datenordner des Dashboards (<code>/data</code>, Docker-Volume
          <code>firefly-dashboard-data</code>) – nicht in Firefly. <b>Updates behalten alles.</b> Weg wäre es nur bei einer Neuinstallation mit
          leerem Datenordner (Volume gelöscht, anderer Rechner). Dafür: Sicherung herunterladen und dort zurückspielen.</p>
        <div id="ls-summary"></div>
        <div class="ls-backup">
          <a class="btn primary" href="/local/nurdashboard?sicherung=1" download>Sicherung herunterladen</a>
          <label class="btn">Sicherung zurückspielen …<input type="file" accept="application/json,.json" id="ls-restore" hidden></label>
          <span class="muted small-text">Eine Datei mit allem aus <code>/data</code> (auch CSV-Archiv und Automationen samt Webhook-Adressen – vertraulich aufbewahren).</span>
        </div>
        <div id="ls-restore-note"></div>
      </section>
      <section class="card span-12">
        <div class="card-head"><h2>Verändert deine Auswertungen – steht so nicht in Firefly</h2><span class="meta" id="ls-num-meta"></span></div>
        <p class="muted" style="margin-top:0">Ohne diese Daten zeigt das Dashboard wieder genau das, was in Firefly steht. Was sich nach Firefly übertragen lässt, steht dabei – danach ist es dort sicher.</p>
        <div class="list task-list" id="ls-num"><p class="muted">Lade …</p></div>
      </section>
      <section class="card span-12">
        <div class="card-head"><h2>Einrichtung und Arbeitsstände – müsstest du neu anlegen</h2></div>
        <div class="list task-list" id="ls-setup"><p class="muted">Lade …</p></div>
      </section>
      <section class="card span-12">
        <div class="card-head"><h2>Gedächtnis – käme als Hinweis wieder</h2></div>
        <div class="list task-list" id="ls-memory"><p class="muted">Lade …</p></div>
      </section>
      <section class="card span-12">
        <div class="card-head"><h2>Nur in diesem Browser</h2></div>
        <div id="ls-browser"></div>
      </section>
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  bindRestore(view, $);
  browserCard($('ls-browser'));

  let d;
  let editAction = null;
  try {
    const r = await fetch('/local/nurdashboard', { headers: { 'X-No-Cache': '1' } });
    editAction = await actionFor('categorize').catch(() => null);
    d = await r.json();
    if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
  } catch (err) {
    $('ls-meta').textContent = '';
    $('ls-num').innerHTML = `<div class="empty bad">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
    return;
  }
  if (!view.isConnected) return;
  const a = d.auswertung || {};
  const q = a.quellen || {};
  const n = (k) => q[k]?.n || 0;
  const eur = (o) => (o?.sum ? ` · ${money(o.sum)}` : '');
  const zeitraum = a.zeitraum ? 'letzte 24 Monate' : '';

  // ---- Zahlen ----
  const notInFf = d.zuordnungen.nichtInFirefly;
  const mergesOpen = d.zusammenfuehrungen.filter((m) => !m.inFirefly);
  const viaZuordnen = (quelle) => `#/zuordnen?karte=z-ff&quelle=${quelle}`;
  const setHint = editAction ? '→ Direkt hier: „… in Firefly setzen“. Für künftige Importe zusätzlich unter Zuordnen → „In Firefly übernehmen“ als Regel.'
    : '→ Zuordnen, „In Firefly übernehmen“ (gefiltert auf diese Quelle): anhaken und „jetzt setzen“ – braucht die Automation „Kategorie übernehmen“.';
  // Einnahmen kennt „Zuordnen“ nicht (nur Ausgaben) – darum hier eigens nennen
  const inc = (o) => { const k = (o?.items || []).filter((x) => x.type === 'deposit').length; return k ? ` Davon ${plural(k, 'Einnahme', 'Einnahmen')} – die stehen nicht unter Zuordnen (das kennt nur Ausgaben).` : ''; };
  const mergedFf = (a.zusammengefuehrt?.items || []).filter((x) => x.firefly); // Firefly hat noch den alten Namen
  const num = [
    {
      n: n('zuordnung'), warn: true, href: viaZuordnen('zuordnung'), title: 'Kategorien aus deinen Händler-Zuordnungen', items: q.zuordnung?.items,
      sub: `${plural(n('zuordnung'), 'Buchung hat', 'Buchungen haben')} in Firefly keine Kategorie und ${n('zuordnung') === 1 ? 'bekommt' : 'bekommen'} sie nur hier${eur(q.zuordnung)}. ${plural(d.zuordnungen.gesamt, 'Zuordnung', 'Zuordnungen')}${notInFf.length ? `, ${notInFf.length} davon noch keine Firefly-Regel – nur für künftige Importe wichtig (z. B. ${notInFf.slice(0, 4).map((x) => x.name).join(', ')})` : ''}.${inc(q.zuordnung)} ${setHint}`, fix: 'zuordnung',
    },
    {
      n: n('buchung'), warn: true, href: '#/zuordnen?karte=z-ff', title: 'Einzeln zugeordnete Buchungen („nur diese“)', items: q.buchung?.items,
      sub: `In Firefly ohne Kategorie${eur(q.buchung)}.${inc(q.buchung)} ${setHint}`, fix: 'buchung',
    },
    {
      n: mergesOpen.length ? (a.zusammengefuehrt?.n || mergesOpen.length) : mergedFf.length, warn: true, href: '#/aufraeumen?karte=a-catmerge', title: 'Zusammengeführte Kategorien', items: mergesOpen.length ? a.zusammengefuehrt?.items : mergedFf,
      sub: mergesOpen.length
        ? `${plural(mergesOpen.length, 'Zusammenführung', 'Zusammenführungen')} nur im Dashboard: ${mergesOpen.slice(0, 5).map((m) => `${m.von} → ${m.nach}`).join(', ')}${mergesOpen.length > 5 ? ' …' : ''}. Diese Buchungen stehen in Firefly noch unter dem alten Namen. → Aufräumen, Karte „Kategorien zusammenführen“, ganz unten Liste „Zusammengeführt“: „Alle … nach Firefly übertragen“ (oder je Zeile). Willst du sie bewusst nur im Dashboard, bleibt der Punkt – dann sichert sie nur die Sicherung.`
        : `Die Zusammenführungen sind übertragen, aber in Firefly stehen diese Buchungen noch unter dem alten Namen (Regel nicht auf alle angewendet, z. B. weil das Übertragen damals scheiterte). → Aufräumen, „Kategorien zusammenführen“, unten bei der Zusammenführung „erneut übertragen“.`,
    },
    {
      n: n('regel'), href: viaZuordnen('regel'), title: 'Kategorien aus deinen Labor-Regeln', items: q.regel?.items,
      sub: `In Firefly ohne Kategorie${eur(q.regel)} – das Labor hat ${plural(d.laborRegeln.regeln, 'Regel', 'Regeln')}.${inc(q.regel)} ${setHint}`, fix: 'regel',
    },
    {
      n: n('import'), href: viaZuordnen('import'), title: 'Kategorien aus deiner Import-Zuordnung', items: q.import?.items,
      sub: `In Firefly ohne Kategorie${eur(q.import)} – die Kategorie kommt aus der hinterlegten Data-Importer-Konfiguration. Auch wenn unter Aufräumen alles übertragen ist: Diese Buchungen hat keine Firefly-Regel erfasst.${inc(q.import)} ${setHint}`, fix: 'import',
    },
    {
      n: n('ki'), href: viaZuordnen('ki'), title: 'Kategorien aus KI-Bewertungen', items: q.ki?.items,
      sub: `In Firefly ohne Kategorie${eur(q.ki)} – ${plural(d.ki.bewertungen, 'Bewertung', 'Bewertungen')} (neu erstellen dauert lange).${inc(q.ki)} ${setHint}`, fix: 'ki',
    },
    {
      n: (d.ausgeblendet.buchungen || 0) + d.ausgeblendet.gegenkonten.length, warn: true, href: '#/pruefen?karte=c-excl', title: 'Ausgeblendete Buchungen und Gegenkonten', items: a.ausgeblendet?.items,
      sub: `${plural(a.ausgeblendet?.n || 0, 'Buchung zählt', 'Buchungen zählen')} in den Auswertungen nicht mit${eur(a.ausgeblendet)}: ${plural(d.ausgeblendet.buchungen, 'einzelne Buchung', 'einzelne Buchungen')}${d.ausgeblendet.gegenkonten.length ? `, Gegenkonten ${d.ausgeblendet.gegenkonten.slice(0, 4).join(', ')}${d.ausgeblendet.gegenkonten.length > 4 ? ' …' : ''}` : ''}. Gibt es in Firefly nicht – nur über die Sicherung.`,
    },
  ];
  const back = n('gelernt') + n('liste');
  // „… in Firefly setzen“: die gelisteten Buchungen ohne Firefly-Kategorie direkt setzen (wie „jetzt setzen“ unter Zuordnen)
  const fixable = (r) => (editAction && r.fix ? (r.items || []).filter((x) => !x.firefly && x.dashboard && x.g && x.j) : []);
  for (const r of num) r.fixList = fixable(r);
  if (view.lsFixClick) view.removeEventListener('click', view.lsFixClick); // Seite wird nach dem Setzen neu gezeichnet
  view.lsFixClick = async (e) => {
    const b = e.target.closest('[data-ls-fix]');
    if (!b) return;
    const r = num.find((x) => x.fix === b.dataset.lsFix);
    const list = r?.fixList || [];
    if (!list.length) return;
    const pairs = [...list.reduce((m, x) => m.set(x.dashboard, (m.get(x.dashboard) || 0) + 1), new Map())].sort((x, y) => y[1] - x[1]);
    if (!window.confirm(`${plural(list.length, 'Buchung', 'Buchungen')} in Firefly kategorisieren?\n${pairs.slice(0, 10).map(([k, c]) => `• ohne → ${k} (${c}×)`).join('\n')}${pairs.length > 10 ? '\n…' : ''}`)) return;
    const status = b.parentElement.querySelector('.ls-fix-status');
    b.disabled = true;
    status.innerHTML = `<span class="spinner"></span> Setze ${list.length} …`;
    const res = await setInFirefly(editAction, list, (msg) => (status.innerHTML = `<span class="spinner"></span> ${esc(msg)}`));
    status.innerHTML = res.ok === list.length && res.checked === res.arrived
      ? `<span class="good">✓ ${plural(res.ok, 'Buchung', 'Buchungen')} gesetzt – in Firefly nachgeprüft. Die Seite aktualisiert sich gleich.</span>`
      : `<span class="bad">${res.ok} von ${list.length} an n8n übergeben${res.checked ? `, in Firefly angekommen: ${res.arrived} von ${res.checked} geprüften` : ''}${res.error ? ` (${esc(res.error)})` : ''}.</span>`;
    if (res.ok) setTimeout(() => view.isConnected && localStatePage(view), 8000);
  };
  view.addEventListener('click', view.lsFixClick);
  $('ls-num').innerHTML = rows(num, back ? `✓ ${plural(back, 'Buchung', 'Buchungen')} mit Kategorie „gelernt“ oder „Händlerliste“ – die errechnet das Dashboard von selbst wieder.` : '');
  $('ls-num-meta').textContent = a.fehler ? `Auswertung nicht möglich: ${a.fehler}` : zeitraum;

  // ---- Einrichtung ----
  const st = d.gruppen.status || {};
  const setup = [
    { n: d.automationen.length, href: '#/automationen', title: 'Automationen (n8n-Webhooks)', sub: d.automationen.map((x) => `${x.name} (${TRIGGER[x.trigger] || x.trigger})`).join(', ') },
    { n: d.ziele, href: '#/', title: 'Ziele', sub: 'Spar- und Budgetziele.' },
    { n: d.einstellungen ? 1 : 0, badge: '✓', href: '#/automationen', title: 'Einstellungen', sub: 'Gehaltstag, Schwellen, Berichte.' },
    { n: d.mqtt, href: '#/automationen', title: 'MQTT-Werte', sub: 'Eigene Werte für Home Assistant & Co.' },
    { n: d.wiederkehrend.eigene + d.wiederkehrend.ausgeblendet + d.wiederkehrend.vertraege, href: '#/wiederkehrend', title: 'Wiederkehrende Zahlungen',
      sub: `${plural(d.wiederkehrend.eigene, 'eigene', 'eigene')}, ${plural(d.wiederkehrend.ausgeblendet, 'ausgeblendete', 'ausgeblendete')}, ${plural(d.wiederkehrend.vertraege, 'Vertragsangabe', 'Vertragsangaben')} (Kündigungsfrist …).` },
    { n: d.gruppen.anzahl, href: '#/labor', title: 'Gruppen im Kategorien-Labor', sub: Object.entries(st).map(([k, v]) => `${v} ${k === 'uebernommen' ? 'übernommen' : k}`).join(', ') + (d.gruppen.papierkorb ? ` · ${d.gruppen.papierkorb} im Papierkorb` : '') },
    { n: d.laborRegeln.regeln, href: '#/labor', title: 'Labor-Regeln', sub: `${plural(d.laborRegeln.autoTags, 'Auto-Tag', 'Auto-Tags')} eingeschaltet.` },
    { n: d.aufraeumen.importPlan + d.aufraeumen.kontenGruppen + (d.aufraeumen.importKonfiguration ? 1 : 0), href: '#/aufraeumen', title: 'Aufräum-Pläne',
      sub: `${d.aufraeumen.importKonfiguration ? 'Data-Importer-Konfiguration hinterlegt · ' : ''}${plural(d.aufraeumen.importPlan, 'Punkt', 'Punkte')} aus der Import-Konfiguration, ${plural(d.aufraeumen.kontenGruppen, 'Konten-Gruppe', 'Konten-Gruppen')}.` },
  ];
  $('ls-setup').innerHTML = rows(setup);

  // ---- Gedächtnis ----
  const memory = [
    ...Object.entries(d.gemerkt).map(([k, v]) => ({ n: v, href: k === 'duplicates' ? '#/pruefen?karte=c-dup' : k === 'parties' ? '#/aufraeumen?karte=a-wrong' : '#/pruefen', title: GEMERKT[k] || k, sub: 'Erschiene wieder als offener Hinweis.' })),
    { n: d.csv.dateien, href: '#/abgleich?karte=s-archive', title: 'CSV-Archiv', sub: `${plural(d.csv.dateien, 'Bank-CSV', 'Bank-CSVs')} (${bytes(d.csv.bytes)}) – Grundlage für Kontostand-Prüfung und Lücken-Erkennung. Liegen sie noch bei dir (Bank-Ordner), lassen sie sich neu einlesen.` },
    { n: d.csv.uebertrageneZeilen, href: '#/abgleich', title: 'CSV-Abgleich: übertragene Zeilen', sub: 'Merkt sich, welche CSV-Zeilen schon nach Firefly gingen.' },
  ];
  $('ls-memory').innerHTML = rows(memory);

  const lost = num.filter((r) => r.n > 0).length;
  const redo = setup.filter((r) => r.n > 0).length;
  $('ls-meta').textContent = `${plural(lost, 'Punkt', 'Punkte')} mit Wirkung auf die Zahlen · ${plural(redo, 'Einrichtung', 'Einrichtungen')}`;
  $('ls-summary').innerHTML = lost || redo
    ? `<div class="cm-note"><b>Bei einer Neuinstallation mit leerem Datenordner</b> ${lost ? `ändern sich deine Auswertungen an ${plural(lost, 'Stelle', 'Stellen')} (unten, gelb markiert: lässt sich größtenteils vorher nach Firefly übertragen)` : 'bleiben deine Auswertungen gleich'}${redo ? `; ${plural(redo, 'Bereich', 'Bereiche')} müsstest du neu einrichten` : ''}. Mit der Sicherung bleibt alles erhalten.</div>`
    : '<div class="cm-note good">Nichts, was nur im Dashboard steckt – eine Neuinstallation zeigt dasselbe.</div>';
}

/** Wer: Gegenkonto – fehlt es („(no name)“), der Anfang der Notiz. */
const who = (x) => (x.party && x.party !== '(no name)' ? x.party : x.notes || x.description || '–');

function rows(list, okText = '') {
  const open = list.filter((r) => r.n > 0);
  const none = list.filter((r) => !r.n);
  const items = (r) => (r.items?.length ? `<details class="ls-items"><summary>Welche Buchungen? (${r.items.length < r.n ? `die neuesten ${r.items.length} von ${r.n.toLocaleString('de-DE')}` : r.items.length})</summary>
      <div class="table-wrap"><table><tbody>${r.items.map((x) => `<tr style="cursor:default"><td class="date">${fmtDate(x.date)}</td>
        <td><div class="desc">${esc(who(x))}</div><div class="flow">${esc([x.description, x.notes].filter((t) => t && t !== who(x)).join(' · '))}</div></td>
        <td class="num">${money(Math.abs(Number(x.amount)) * (x.type === 'withdrawal' ? -1 : 1))}</td>
        <td><span class="muted">Firefly: ${esc(x.firefly || 'ohne')}</span>${x.dashboard ? ` → <b>${esc(x.dashboard)}</b>` : ''}</td></tr>`).join('')}</tbody></table></div></details>` : '');
  return `${open.map((r) => `<div class="row task ls-row">
      <div class="task-n ${r.warn ? 'warn' : ''}">${r.badge ?? r.n.toLocaleString('de-DE')}</div>
      <div style="min-width:0"><div class="title">${esc(r.title)}</div><div class="subtitle">${esc(r.sub || '')}</div>
        ${r.fixList?.length ? `<div class="ls-fix"><button class="btn small" type="button" data-ls-fix="${esc(r.fix)}">${r.fixList.length} in Firefly setzen</button> <span class="ls-fix-status muted small-text"></span></div>` : ''}${items(r)}</div>
      <a class="task-go" href="${r.href}" title="Dorthin" aria-label="Dorthin: ${esc(r.title)}">›</a></div>`).join('')}
    ${!open.length ? '<div class="empty">Nichts davon.</div>' : ''}
    ${none.length || okText ? `<p class="muted task-ok">${[okText, none.length ? `Nichts bei: ${none.map((r) => esc(r.title)).join(' · ')}` : ''].filter(Boolean).join('<br>')}</p>` : ''}`;
}

/**
 * Kategorien per Automation „Kategorie übernehmen“ setzen – kleine Pakete (ein Proxy vor n8n bricht lange Anfragen
 * mit 504 ab; n8n arbeitet dann meist weiter), danach frisch in Firefly nachsehen.
 */
async function setInFirefly(action, list, progress) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (part) => fetch('/local/autocat', { method: 'POST', headers, body: JSON.stringify({ pruefeKategorien: part.map((x) => ({ g: x.g, j: x.j, kategorie: x.dashboard })) }) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  let ok = 0;
  let error = '';
  for (let k = 0; k < list.length; k += 8) {
    const part = list.slice(k, k + 8);
    progress(`Setze in Firefly … ${k} von ${list.length}`);
    const r = await runAction(action, {
      typ: 'kategorien_uebernehmen',
      aenderungen: part.map((x) => ({ transaction_group_id: x.g, transaction_journal_id: x.j, datum: x.date, beschreibung: x.description, betrag: x.amount, kategorie_alt: null, kategorie: x.dashboard })),
    }).catch((err) => ({ ok: false, response: err.message }));
    if (r.ok) {
      ok += part.length;
      continue;
    }
    error = `HTTP ${r.status || '–'}`;
    if (!r.status || [502, 503, 504, 524].includes(r.status)) {
      progress('Zeitüberschreitung bei n8n – prüfe in Firefly, was angekommen ist …');
      await sleep(30_000);
      const c = await check(part);
      if (c && !c.fehler) ok += c.ok;
    }
  }
  progress('Prüfe in Firefly …');
  const c = ok ? await check(list) : null;
  return { ok, checked: c?.geprueft || 0, arrived: c?.ok || 0, error };
}

/** Einstellungen, die nur dieser Browser kennt (localStorage) – nicht in der Sicherung. */
function browserCard(el) {
  let keys = [];
  let ignored = 0;
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith('ffd-'));
    ignored = JSON.parse(localStorage.getItem('ffd-cm-ignore') || '[]').length || 0;
  } catch {
    // privates Fenster o. ä.
  }
  el.innerHTML = `<p class="muted" style="margin-top:0">${keys.length ? `${plural(keys.length, 'Einstellung', 'Einstellungen')} nur in diesem Browser: Design (hell/dunkel), gewählte Filter und Zeiträume, auf- und zugeklappte Karten${ignored ? `, <b>${plural(ignored, 'ausgeblendeter Vorschlag', 'ausgeblendete Vorschläge')}</b> beim Kategorien-Zusammenführen („passt nicht“)` : ''}.` : 'Dieser Browser hat keine eigenen Einstellungen gespeichert.'}
    Sie gehören nicht zur Sicherung und fehlen auf jedem anderen Gerät ohnehin – verloren geht dabei nichts an Daten.</p>`;
}

function bindRestore(view, $) {
  $('ls-restore').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const note = $('ls-restore-note');
    let data;
    try {
      data = JSON.parse(await file.text());
      if (data?.art !== 'firefly-dashboard-sicherung') throw new Error('Das ist keine Sicherung des Firefly Dashboards.');
    } catch (err) {
      note.innerHTML = `<div class="cm-note bad">${esc(err.message)}</div>`;
      return;
    }
    const n = Object.keys(data.dateien || {}).length;
    const when = data.erstellt ? new Date(data.erstellt).toLocaleString('de-DE') : 'unbekannt';
    if (!window.confirm(`Sicherung vom ${when} zurückspielen (${n} Dateien, ${Object.keys(data.csv || {}).length} CSV-Dateien)?\n\nDer jetzige Stand wird ersetzt – er bleibt im Datenordner unter backups/vor-wiederherstellung-… erhalten. Danach startet das Dashboard neu.`)) return;
    note.innerHTML = '<div class="cm-note"><span class="spinner"></span> Spiele die Sicherung zurück …</div>';
    try {
      const r = await fetch('/local/nurdashboard', { method: 'POST', headers, body: JSON.stringify(data) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
      if (!body.neustart) {
        note.innerHTML = `<div class="cm-note good">✓ ${body.dateien} Dateien zurückgespielt. <b>Bitte das Dashboard jetzt neu starten</b> (läuft nicht in Docker), dann die Seite neu laden.</div>`;
        return;
      }
      note.innerHTML = '<div class="cm-note"><span class="spinner"></span> Zurückgespielt – das Dashboard startet neu …</div>';
      await waitForRestart();
      window.location.reload();
    } catch (err) {
      note.innerHTML = `<div class="cm-note bad">${esc(err.message)}</div>`;
    }
  });
}

async function waitForRestart() {
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < 60; i++) {
    const ok = await fetch('/local/nurdashboard', { headers: { 'X-No-Cache': '1' } }).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
