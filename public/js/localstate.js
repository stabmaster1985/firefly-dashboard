// Seite „Nur im Dashboard“ (Werkzeuge): Was steckt nur im Dashboard (DATA_DIR) und nicht in Firefly?
// Was wäre nach einer Neuinstallation mit leerem /data weg, was müsste neu eingerichtet werden, was kommt von
// selbst wieder? Dazu Sicherung herunterladen und zurückspielen.

import { esc, money } from './util.js';

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
  try {
    const r = await fetch('/local/nurdashboard', { headers: { 'X-No-Cache': '1' } });
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
  const num = [
    {
      n: n('zuordnung'), warn: true, href: '#/zuordnen?karte=z-ff', title: 'Kategorien aus deinen Händler-Zuordnungen',
      sub: `${plural(n('zuordnung'), 'Buchung', 'Buchungen')} ohne Kategorie in Firefly bekommen sie nur hier${eur(q.zuordnung)} (${zeitraum}). ${plural(d.zuordnungen.gesamt, 'Zuordnung', 'Zuordnungen')}, davon ${notInFf.length} noch nicht als Firefly-Regel${notInFf.length ? ` (z. B. ${notInFf.slice(0, 4).map((x) => x.name).join(', ')})` : ''}. → „In Firefly übernehmen“, ggf. „jetzt setzen“.`,
    },
    {
      n: d.einzeln, warn: true, href: '#/zuordnen?karte=z-ff', title: 'Einzeln zugeordnete Buchungen („nur diese“)',
      sub: `Davon ${n('buchung')} ohne Kategorie in Firefly${eur(q.buchung)} (${zeitraum}). → „In Firefly übernehmen“ → „In Firefly setzen“.`,
    },
    {
      n: mergesOpen.length, warn: true, href: '#/aufraeumen?karte=a-catmerge', title: 'Zusammengeführte Kategorien, nicht in Firefly übertragen',
      sub: `${mergesOpen.slice(0, 5).map((m) => `${m.von} → ${m.nach}`).join(', ')}${mergesOpen.length > 5 ? ' …' : ''}. ${plural(a.zusammengefuehrt?.n || 0, 'Buchung', 'Buchungen')} erscheinen dadurch unter einem anderen Namen. → „Kategorien zusammenführen“ → in Firefly übertragen.`,
    },
    {
      n: n('regel'), href: '#/labor', title: 'Kategorien aus deinen Labor-Regeln',
      sub: `${plural(n('regel'), 'Buchung', 'Buchungen')}${eur(q.regel)} – aus ${plural(d.laborRegeln.regeln, 'Regel', 'Regeln')}. → Labor „In Firefly anlegen“ (ob schon geschehen, merkt sich das Dashboard nicht).`,
    },
    {
      n: n('import'), href: '#/aufraeumen?karte=a-import', title: 'Kategorien aus deiner Import-Zuordnung',
      sub: `${plural(n('import'), 'Buchung', 'Buchungen')}${eur(q.import)} – aus der hinterlegten Data-Importer-Konfiguration. → „Regeln aus der Import-Konfiguration“ nach Firefly übertragen.`,
    },
    {
      n: n('ki'), href: '#/labor', title: 'Kategorien aus KI-Bewertungen',
      sub: `${plural(n('ki'), 'Buchung', 'Buchungen')}${eur(q.ki)} – ${plural(d.ki.bewertungen, 'Bewertung', 'Bewertungen')} (neu erstellen dauert lange). → Labor: als Regeln nach Firefly.`,
    },
    {
      n: (d.ausgeblendet.buchungen || 0) + d.ausgeblendet.gegenkonten.length, warn: true, href: '#/pruefen?karte=c-excl', title: 'Ausgeblendete Buchungen und Gegenkonten',
      sub: `${plural(a.ausgeblendet?.n || 0, 'Buchung zählt', 'Buchungen zählen')} in den Auswertungen nicht mit${eur(a.ausgeblendet)}: ${plural(d.ausgeblendet.buchungen, 'einzelne Buchung', 'einzelne Buchungen')}${d.ausgeblendet.gegenkonten.length ? `, Gegenkonten ${d.ausgeblendet.gegenkonten.slice(0, 4).join(', ')}${d.ausgeblendet.gegenkonten.length > 4 ? ' …' : ''}` : ''}. Gibt es in Firefly nicht – nur über die Sicherung.`,
    },
  ];
  const back = n('gelernt') + n('liste');
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

function rows(list, okText = '') {
  const open = list.filter((r) => r.n > 0);
  const none = list.filter((r) => !r.n);
  return `${open.map((r) => `<a class="row task" href="${r.href}">
      <div class="task-n ${r.warn ? 'warn' : ''}">${r.badge ?? r.n.toLocaleString('de-DE')}</div>
      <div style="min-width:0"><div class="title">${esc(r.title)}</div><div class="subtitle">${esc(r.sub || '')}</div></div>
      <span class="task-go" aria-hidden="true">›</span></a>`).join('')}
    ${!open.length ? '<div class="empty">Nichts davon.</div>' : ''}
    ${none.length || okText ? `<p class="muted task-ok">${[okText, none.length ? `Nichts bei: ${none.map((r) => esc(r.title)).join(' · ')}` : ''].filter(Boolean).join('<br>')}</p>` : ''}`;
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
