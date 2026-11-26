// „Kategorien zusammenführen“ (Seite „Aufräumen“): mehrere Kategorien in eine. Zwei Wege:
//   - nur im Dashboard: Auswertungen zählen sie sofort unter dem Ziel (umkehrbar, Firefly unverändert)
//   - in Firefly: per n8n-Workflow „Regeln anlegen“ eine Regel „Kategorie ist A → Kategorie B“ je Quelle,
//     angewendet auf alle Buchungen – auch künftige Importe mit der alten Kategorie landen im Ziel.
// Server: /local/kategorien (lib/ledger.js, gespeichert in DATA_DIR/autocat.json).

import * as api from './api.js';
import { esc, money, fmtDate, today, isoDate, storage, store } from './util.js';
import { runAction, actionFor, deleteCategories } from './txedit.js';
import { toFireflyRules } from './rules.js';
import { similar } from './combo.js';

const RULE_GROUP = 'Dashboard: Kategorien zusammengeführt';
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
let monateNow = 24; // Zeitraum der Seite (Aufräumen → „Buchungen auswerten“)
const call = (body) => fetch(`/local/kategorien?monate=${monateNow}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : {}).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
  return data;
});

/** Vergleichsform eines Namens: „Lebensmittel & Drogerie“ ≈ „lebensmittel und drogerie“, Einzahl ≈ Mehrzahl. */
const fold = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/&/g, ' und ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map((w) => w.replace(/(en|n|e|s)$/, '')).join(' ');

// Begriffe, die dasselbe meinen – je Zeile eine Bedeutung (Vergleich über fold, also ohne Endungen)
const SYNONYMS = [
  ['lebensmittel', 'supermarkt', 'einkauf', 'einkaeufe', 'lebensmitteleinkauf', 'grocerie', 'discounter', 'nahrungsmittel'],
  ['tanken', 'tankstelle', 'kraftstoff', 'benzin', 'diesel', 'sprit', 'treibstoff'],
  ['kfz', 'auto', 'fahrzeug', 'pkw', 'werkstatt', 'autokosten', 'kfz kosten'],
  ['restaurant', 'gastronomie', 'essen gehen', 'auswaerts essen', 'essen trinken', 'lieferdienst', 'imbis'],
  ['drogerie', 'koerperpflege', 'hygiene', 'kosmetik'],
  ['versicherung', 'versicherungen', 'assekuranz'],
  ['mobilitaet', 'oepnv', 'bahn', 'nahverkehr', 'fahrkarte', 'ticket'],
  ['kleidung', 'bekleidung', 'mode', 'schuhe', 'textil'],
  ['freizeit', 'hobby', 'unterhaltung', 'ausflug'],
  ['abo', 'abos', 'abonnement', 'streaming', 'mitgliedschaft'],
  ['gesundheit', 'arzt', 'apotheke', 'medizin', 'medikament'],
  ['wohnen', 'miete', 'wohnung', 'kaltmiete', 'warmmiete'],
  ['haushalt', 'haushaltsware', 'haus garten', 'baumarkt', 'garten'],
  ['kinder', 'kind', 'kita', 'schule', 'nachwuch'],
  ['geschenk', 'geschenke', 'praesent'],
  ['urlaub', 'reise', 'reisen', 'ferien', 'hotel'],
  ['bargeld', 'geldautomat', 'abhebung'],
  ['spende', 'spenden', 'charity'],
  ['haustier', 'tier', 'tierbedarf', 'hund', 'katze'],
].map((g) => g.map(fold));
const synonymGroup = (name) => {
  const f = fold(name);
  return SYNONYMS.findIndex((g) => g.some((w) => f === w || f.split(' ').includes(w)));
};
const STOP = new Set(['und', 'kosten', 'sonstig', 'sonstige', 'allgemein', 'diverse', 'neu', 'alt', 'privat', 'monatlich']);
const keyWords = (name) => fold(name).split(' ').filter((w) => w.length >= 5 && !STOP.has(w));

/** Vergleichsdaten einer Kategorie einmal vorbereiten (die Paarvergleiche laufen n² Mal). */
function prep(c) {
  const h = c.haendler || {};
  return { c, name: c.name, n: c.n, f: fold(c.name), kw: keyWords(c.name), syn: synonymGroup(c.name), h, total: Object.values(h).reduce((x, v) => x + v, 0) };
}

/** Gemeinsame Händler: Anteil der Buchungen der kleineren Kategorie bei Händlern, die auch die andere hat. */
function merchantOverlap(a, b) {
  if (a.total < 2 && b.total < 2) return null;
  const [small, big, total] = a.total <= b.total ? [a.h, b.h, a.total] : [b.h, a.h, b.total];
  if (total < 2) return null;
  let n = 0;
  const shared = [];
  for (const m in small) {
    if (big[m]) {
      n += small[m];
      shared.push(m);
    }
  }
  return shared.length && n >= 2 && n / total >= 0.5 ? shared.sort((x, y) => small[y] - small[x]).slice(0, 3) : null;
}

/** Warum gehören zwei Kategorien vermutlich zusammen? (vorbereitete Daten, siehe prep) Gründe als Text, sonst leere Liste. */
function reasons(a, b) {
  const out = [];
  if (a.f === b.f) out.push('gleicher Name');
  // Tippfehler-Vergleich nur, wenn die Längen passen oder einer der Anfang des anderen ist – sonst unnötig teuer
  else if ((Math.abs(a.f.length - b.f.length) <= 2 || a.f.startsWith(b.f) || b.f.startsWith(a.f)) && (similar(a.name, b.name) || similar(b.name, a.name))) out.push('fast gleicher Name');
  else if (a.kw.length && b.kw.length) {
    const shared = a.kw.filter((w) => b.kw.some((v) => v === w || (w.length >= 6 && v.length >= 6 && (v.includes(w) || w.includes(v)))));
    if (shared.length) out.push(`gemeinsames Wort „${shared[0]}“`);
  }
  if (a.syn >= 0 && a.syn === b.syn && !out.length) out.push('gleiche Bedeutung');
  const m = merchantOverlap(a, b);
  if (m) out.push(`gleiche Händler (${m.join(', ')})`);
  return out;
}

/**
 * Vorschläge als Gruppen („Cluster“): alle Paare mit Grund, stärkste zuerst (Name > gleiche Händler > Bedeutung,
 * mehrere Gründe zählen mehr). Ein Paar eröffnet eine Gruppe (Ziel = größere Kategorie) oder ergänzt eine Gruppe,
 * deren Ziel es enthält – kein Verketten über Dritte, sonst landet am Ende alles in einer Gruppe.
 */
const pairKey = (a, b) => [a, b].map((x) => x.toLowerCase()).sort().join('|');
// Ergebnis merken: neu gerechnet wird nur, wenn sich die Kategorien oder die ausgeblendeten Paare ändern –
// nicht bei jedem Häkchen (bei vielen Kategorien dauert die Berechnung spürbar)
let memo = { list: null, ignored: '', out: [] };
function suggestions(list, ignored = new Set()) {
  const ig = [...ignored].sort().join('\n');
  if (memo.list === list && memo.ignored === ig) return memo.out;
  const out = computeSuggestions(list, ignored);
  memo = { list, ignored: ig, out };
  return out;
}
function computeSuggestions(list, ignored) {
  const pool = list.filter((c) => !c.ziel && (c.n > 0 || c.inFirefly)).map(prep);
  const weight = (why) => why.reduce((x, w) => x + (w.includes('Name') ? 3 : w.startsWith('gemeinsames Wort') ? 2.5 : w.startsWith('gleiche Händler') ? 2 : 1), 0);
  const bigger = (a, b) => (Number(b.c.inFirefly) - Number(a.c.inFirefly) || b.n - a.n) < 0 ? a : b;
  const edges = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (ignored.has(pairKey(pool[i].name, pool[j].name))) continue; // „passt nicht“
      const why = reasons(pool[i], pool[j]);
      if (why.length) edges.push({ a: pool[i], b: pool[j], why, w: weight(why) });
    }
  }
  edges.sort((x, y) => y.w - x.w || (y.a.n + y.b.n) - (x.a.n + x.b.n));
  const clusterOf = new Map(); // Name → Gruppe
  const clusters = [];
  for (const e of edges) {
    const ca = clusterOf.get(e.a.name);
    const cb = clusterOf.get(e.b.name);
    if (!ca && !cb) {
      const center = bigger(e.a, e.b);
      const other = center === e.a ? e.b : e.a;
      const c = { to: center.name, n: center.n, members: [{ name: other.name, n: other.n, why: e.why }], w: e.w };
      clusters.push(c);
      clusterOf.set(center.name, c);
      clusterOf.set(other.name, c);
    } else if (ca && !cb && ca.to === e.a.name) {
      ca.members.push({ name: e.b.name, n: e.b.n, why: e.why });
      clusterOf.set(e.b.name, ca);
    } else if (cb && !ca && cb.to === e.b.name) {
      cb.members.push({ name: e.a.name, n: e.a.n, why: e.why });
      clusterOf.set(e.a.name, cb);
    }
  }
  return clusters
    .map((c) => ({ ...c, from: c.members.map((m) => m.name), pairs: c.members.map((m) => pairKey(c.to, m.name)) }))
    .sort((a, b) => b.w - a.w || b.members.length - a.members.length);
}

const IGNORE_KEY = 'ffd-cm-ignore'; // „passt nicht“ bei Vorschlägen (je Gerät)
const ignoredSugg = () => {
  try {
    return new Set(JSON.parse(storage(IGNORE_KEY, '[]')));
  } catch {
    return new Set();
  }
};

export function catMergeCard(el, meta, { rulesAction, monate = 24 }) {
  monateNow = monate;
  let showSugg = 6;
  let suggOpen = storage('ffd-cm-sugg-open', '1') !== '0'; // Vorschläge auf-/zugeklappt (je Gerät)
  let mergedOpen = storage('ffd-cm-merged-open', '1') !== '0'; // Liste „Zusammengeführt“ auf-/zugeklappt
  // Leere Kategorien (alle Jahre, frisch bei Firefly): null | 'laden' | Fehlertext | { geprueft, leer, off: Set }
  let empty = null;
  let emptyOpen = false;
  let emptyNote = '';
  let editAction = null;
  actionFor('categorize').then((a) => (editAction = a)).catch(() => {});
  async function checkEmpty() {
    empty = 'laden';
    emptyNote = '';
    render();
    try {
      const r = await fetch('/local/kategorien?leer=1', { headers: { 'X-No-Cache': '1' } });
      const body = await r.json();
      if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
      empty = { ...body, off: new Set() };
    } catch (err) {
      empty = err.message;
    }
    render();
  }
  function emptyHtml() {
    const head = `<details class="cm-merged-box" data-empty-box${emptyOpen ? ' open' : ''}><summary class="sub-h">Leere Kategorien <span class="muted">(in Firefly ohne eine einzige Buchung – alle Jahre)${empty && typeof empty === 'object' ? ` · ${empty.leer.length}` : ''}</span></summary>`;
    let body;
    if (!empty) body = `<p class="muted small-text">Fragt Firefly je Kategorie, ob es überhaupt eine Buchung gibt – egal wie alt. Was dann hier steht, kann gefahrlos gelöscht werden.</p><button class="btn small" type="button" data-empty-check>Jetzt prüfen</button>`;
    else if (empty === 'laden') body = '<p class="muted"><span class="spinner"></span> Frage Firefly je Kategorie … (bei vielen Kategorien etwas Geduld)</p>';
    else if (typeof empty === 'string') body = `<p class="bad">${esc(empty)}</p><button class="btn small" type="button" data-empty-check>Erneut prüfen</button>`;
    else {
      const sel = empty.leer.filter((c) => !empty.off.has(c.id));
      body = `<p class="muted small-text">${empty.geprueft} Kategorien geprüft, ${empty.leer.length} ohne jede Buchung. <button class="link-btn" type="button" data-empty-check>neu prüfen</button></p>
        ${empty.leer.length ? `<div class="list cm-merged">${empty.leer.map((c) => `<label class="row" style="cursor:pointer;display:flex;gap:10px;align-items:center;justify-content:flex-start">
            <input type="checkbox" data-empty-pick="${esc(c.id)}"${empty.off.has(c.id) ? '' : ' checked'}>
            <span style="min-width:0"><span class="title">${esc(c.name)}</span>${c.zusammengefuehrtIn ? ` <span class="muted small-text">· zusammengeführt in „${esc(c.zusammengefuehrtIn)}“</span>` : ''}</span></label>`).join('')}</div>
          <div class="z-ff-btns" style="margin-top:10px">${editAction ? `<button class="btn small" type="button" data-empty-delete${sel.length ? '' : ' disabled'}>${sel.length} ausgewählte in Firefly löschen</button>` : '<span class="muted small-text">Zum Löschen fehlt die Automation „Kategorie übernehmen“ (Vorlage n8n/firefly-buchung-bearbeiten.json).</span>'}</div>
          <p class="muted small-text">Steht eine Kategorie noch in einer Firefly-Regel oder in der Import-Konfiguration (Data Importer), legt Firefly sie beim nächsten Treffer wieder an – dort ggf. auch ersetzen.</p>` : '<div class="empty">Keine leeren Kategorien.</div>'}`;
    }
    return `${head}${emptyNote ? `<div class="cm-note" role="status">${emptyNote}</div>` : ''}${body}</details>`;
  }
  let mergedView = storage('ffd-cm-merged-view', 'alle'); // offen (nur im Dashboard) | firefly (übertragen) | alle
  el.addEventListener('toggle', (e) => {
    if (e.target.matches?.('[data-empty-box]')) {
      emptyOpen = e.target.open;
      if (emptyOpen && !empty) checkEmpty();
      return;
    }
    if (e.target.matches?.('[data-merged-box]')) {
      mergedOpen = e.target.open;
      store('ffd-cm-merged-open', mergedOpen ? '1' : '0');
      return;
    }
    if (!e.target.matches?.('[data-sugg-box]')) return;
    suggOpen = e.target.open;
    store('ffd-cm-sugg-open', suggOpen ? '1' : '0');
  }, true);
  const openRows = new Set(); // Kategorien mit sichtbaren Buchungen
  const txCache = new Map(); // Kategorie → { anzahl, buchungen } | 'laden' | Fehlertext
  async function loadTx(name) {
    if (txCache.has(name)) return;
    txCache.set(name, 'laden');
    try {
      const r = await fetch(`/local/kategorien?monate=${monate}&buchungen=${encodeURIComponent(name)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      txCache.set(name, d);
    } catch (err) {
      txCache.set(name, err.message);
    }
    if (el.isConnected) render();
  }
  const txRow = (c) => {
    if (!openRows.has(c.name)) return '';
    const d = txCache.get(c.name);
    const inner = d === 'laden' || d === undefined ? '<p class="muted">Lade Buchungen …</p>'
      : typeof d === 'string' ? `<p class="bad">Konnte nicht geladen werden: ${esc(d)}</p>`
      : !d.buchungen.length ? '<p class="muted">Keine Buchungen im Zeitraum.</p>'
      : `${d.anzahl > d.buchungen.length ? `<p class="muted">Die neuesten ${d.buchungen.length} von ${d.anzahl}.</p>` : ''}<table class="cm-tx"><tbody>${d.buchungen.map((t) => `<tr>
          <td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(String(t.description || '').slice(0, 100))}</div><div class="flow">${esc((t.type === 'deposit' ? t.source_name : t.destination_name) || '')}${t.category_name.toLowerCase() !== c.name.toLowerCase() ? ` · als „${esc(t.category_name)}“ (zusammengeführt)` : ''}${t.ffd_quelle !== 'firefly' ? ' · automatisch' : ''}</div></td>
          <td class="num">${t.type === 'deposit' ? '' : '−'}${money(t.amount, t.currency_code)}</td></tr>`).join('')}</tbody></table>`;
    return `<tr class="cm-tx-row"><td colspan="5">${inner}</td></tr>`;
  };
  let data;
  const picked = new Set();
  let target = ''; // Ziel – eingetippt oder per Vorschlag
  let query = ''; // Suche in der Tabelle
  let note = '';

  const sum = (c) => c.ausgaben + c.einnahmen;
  /** Passt der Name zur Suche bzw. ist er dem Ziel ähnlich (Schreibweise, Einzahl/Mehrzahl, Teilwort)? */
  const related = (name, term) => {
    const a = fold(name);
    const b = fold(term);
    if (!b) return false;
    return a.includes(b) || b.includes(a) || similar(term, name) || b.split(' ').some((w) => w.length >= 4 && a.includes(w));
  };

  // Gerüst: Erklärung, Schritt 1 (Ziel) und Suche bleiben stehen – nur Liste und Knöpfe werden neu gezeichnet
  el.innerHTML = `
    <p class="muted" style="margin-top:0">Mehrere Kategorien zu einer machen, z. B. „Supermarkt“ und „Einkauf“ → „Lebensmittel“.
      <b>Nur im Dashboard</b> wirkt sofort und lässt sich aufheben; <b>in Firefly</b> stellt per Regel alle Buchungen um – auch künftige Importe.</p>
    <ol class="cm-steps">
      <li><b>Ziel</b> wählen – die Kategorie, die bleiben soll (vorhanden oder neu):
        <input class="input" data-cm-target list="cm-names" placeholder="z. B. Lebensmittel" aria-label="Zielkategorie"></li>
      <li><b>Ankreuzen</b>, was darin aufgehen soll – so viele du willst. Die Suche findet auch ähnliche Namen; dem Ziel ähnliche sind markiert.
        Vorschläge sind nur eine Abkürzung: „übernehmen“ setzt Ziel und Häkchen, du kannst danach weitere ankreuzen oder abwählen.</li>
      <li><b>Zusammenführen</b> – nur im Dashboard oder in Firefly (Knöpfe unten).</li>
    </ol>
    <div class="cm-tools"><input class="input" type="search" data-cm-search placeholder="Kategorien suchen, z. B. lebensm, auto, versich …" aria-label="Kategorien suchen"></div>
    <div data-cm-body><p class="muted">Lade Kategorien …</p></div>
    <datalist id="cm-names"></datalist>`;
  const body = el.querySelector('[data-cm-body]');
  const targetInput = el.querySelector('[data-cm-target]');
  const searchInput = el.querySelector('[data-cm-search]');

  function render() {
    const list = data.kategorien;
    const active = list.filter((c) => !c.ziel);
    const merged = data.zusammengefuehrt;
    const mergedOpenN = merged.filter((m) => !m.sentAt).length;
    const mergedShown = merged.filter((m) => (mergedView === 'offen' ? !m.sentAt : mergedView === 'firefly' ? m.sentAt : true));
    const sugg = suggestions(list, ignoredSugg());
    // ausgeblendete Paare, deren Kategorien es noch gibt (Namen wie in der Liste)
    const byLow = new Map(list.map((c) => [c.name.toLowerCase(), c.name]));
    const hiddenPairs = [...ignoredSugg()].filter((k) => k.split('|').every((n) => byLow.has(n))).map((k) => k.split('|').map((n) => byLow.get(n)).join('|'));
    el.querySelector('#cm-names').innerHTML = [...new Set(active.map((c) => c.name))].sort((a, b) => a.localeCompare(b, 'de')).map((n) => `<option value="${esc(n)}">`).join('');
    const since = new Date(new Date().getFullYear(), new Date().getMonth() - monate, 1); // wie /local/kategorien
    meta.textContent = `${active.length} Kategorien${merged.length ? ` · ${merged.length} zusammengeführt` : ''} · Buchungen seit ${fmtDate(since, { month: 'short', year: 'numeric' })}`;
    const to = target.trim();
    const from = [...picked].filter((f) => f.toLowerCase() !== to.toLowerCase());
    // „ähnlich zum Ziel“ einmal je Zeichnen berechnen (nicht in jedem Sortiervergleich)
    const likeMap = new Map(to ? active.map((c) => [c.name, c.name.toLowerCase() !== to.toLowerCase() && related(c.name, to)]) : []);
    const like = (c) => Boolean(likeMap.get(c.name));
    // Reihenfolge: ausgewählte, dem Ziel ähnliche, dann nach Buchungen; die Suche filtert
    const rows = active
      .filter((c) => !query.trim() || related(c.name, query) || picked.has(c.name))
      .sort((a, b) => Number(picked.has(b.name)) - Number(picked.has(a.name)) || Number(like(b)) - Number(like(a)) || b.n - a.n);
    const why = !to ? 'Erst oben das Ziel wählen.' : !from.length ? 'Kategorien ankreuzen, die in „' + esc(to) + '“ aufgehen sollen.' : '';
    body.innerHTML = `
      ${note ? `<div class="cm-note">${note}</div>` : ''}
      ${sugg.length || hiddenPairs.length ? `<details class="cm-sugg" data-sugg-box${suggOpen ? ' open' : ''}><summary><b>Vorschläge: Was gehört vermutlich zusammen?</b> <span class="muted">${sugg.length} Vorschl${sugg.length === 1 ? 'ag' : 'äge'}${hiddenPairs.length ? ` · ${hiddenPairs.length} ausgeblendet` : ''}</span></summary>
        <div class="muted small-text">Nach Name, gemeinsamem Wort, Bedeutung und gleichen Händlern gruppiert. „übernehmen“ setzt Ziel und Häkchen; danach in der Tabelle anpassen.</div>
        ${sugg.slice(0, showSugg).map((x, i) => `<div class="cm-cluster">
          <div class="cm-cluster-head"><span>→ <b>„${esc(x.to)}“</b> <span class="muted">(${x.n} Buchungen)</span></span>
            <span><button class="btn small" type="button" data-sugg="${i}">übernehmen</button> <button class="link-btn" type="button" data-sugg-ignore="${i}" title="Diesen Vorschlag nicht mehr zeigen (dieses Gerät)">passt nicht</button></span></div>
          <ul>${x.members.map((m) => `<li>„${esc(m.name)}“ <span class="muted">· ${m.n} Buchungen · ${m.why.map(esc).join(' · ')}</span></li>`).join('')}</ul>
        </div>`).join('')}
        ${sugg.length > showSugg ? `<button class="link-btn" type="button" data-sugg-more>weitere ${sugg.length - showSugg} Vorschläge zeigen</button>` : ''}
        ${hiddenPairs.length ? `<div class="cm-hidden"><span class="muted">Ausgeblendet („passt nicht“):</span> ${hiddenPairs.map((k) => `<span class="chip small">${k.split('|').map(esc).join(' ↔ ')} <button type="button" class="chip-x" data-sugg-restore="${esc(k)}" title="wieder vorschlagen" aria-label="wieder vorschlagen">↺</button></span>`).join(' ')}
          <button type="button" class="link-btn" data-sugg-restore-all>alle wieder einblenden</button></div>` : ''}</details>` : ''}
      <div class="table-wrap cm-wrap"><table class="cm-table">
        <thead><tr><th class="pick-cell"></th><th>Kategorie</th><th class="num">Buchungen</th><th class="num hide-sm">Ausgaben</th><th class="num hide-sm">Einnahmen</th></tr></thead>
        <tbody>${rows.map((c) => {
          const isTarget = to && c.name.toLowerCase() === to.toLowerCase();
          const parts = merged.filter((m) => m.to.toLowerCase() === c.name.toLowerCase());
          return `<tr data-name="${esc(c.name)}" class="${picked.has(c.name) ? 'cm-picked' : ''}${isTarget ? ' cm-target' : ''}">
          <td class="pick-cell">${isTarget ? '<span title="Ziel">★</span>' : `<input type="checkbox" data-pick="${esc(c.name)}" ${picked.has(c.name) ? 'checked' : ''} aria-label="${esc(c.name)} auswählen">`}</td>
          <td><div class="desc">${esc(c.name)} ${isTarget ? '<span class="badge good">Ziel</span>' : like(c) ? '<span class="badge warn" title="Ähnlicher Name wie das Ziel">ähnlich</span>' : ''}</div>
            <div class="flow">${!c.inFirefly ? 'nur im Dashboard (automatisch/zusammengeführt)' : c.n === 0 ? 'in Firefly, ohne Buchungen' : c.auto && c.firefly ? 'Firefly + automatisch' : c.auto ? 'automatisch zugeordnet' : 'Firefly'}${parts.length ? ` · enthält ${parts.map((m) => `„${esc(m.from)}“`).join(', ')}` : ''}${c.n ? ` · <button type="button" class="link-btn" data-cm-tx="${esc(c.name)}">${openRows.has(c.name) ? 'Buchungen ausblenden' : 'Buchungen ansehen'}</button>` : ''}${!isTarget ? ` · <button type="button" class="link-btn" data-as-target="${esc(c.name)}">als Ziel</button>` : ''}</div></td>
          <td class="num">${c.n}</td>
          <td class="num hide-sm">${c.ausgaben ? money(c.ausgaben) : '–'}</td>
          <td class="num hide-sm">${c.einnahmen ? money(c.einnahmen) : '–'}</td></tr>${txRow(c)}`;
        }).join('') || `<tr><td colspan="5" class="muted">Nichts gefunden für „${esc(query)}“.</td></tr>`}</tbody></table></div>
      <div class="cm-form">
        <div class="cm-summary">${from.length && to ? `<span><b>${from.length}</b> → „<b>${esc(to)}</b>“:</span> ${from.map((f) => `<span class="chip small">${esc(f)} <button type="button" class="chip-x" data-unpick="${esc(f)}" aria-label="${esc(f)} abwählen">✕</button></span>`).join(' ')}` : `<span class="muted">${why}</span>`}</div>
        <div class="cm-btns">
          <button class="btn" type="button" data-merge="dashboard"${from.length && to ? '' : ' disabled'}>Nur im Dashboard</button>
          <button class="btn primary" type="button" data-merge="firefly"${from.length && to && rulesAction ? '' : ' disabled'} title="${rulesAction ? 'Per n8n-Workflow „Regeln anlegen“' : 'Dafür eine Automation mit Auslöser „Firefly-Regeln anlegen“ einrichten (n8n/firefly-buchung-bearbeiten.json)'}">In Firefly zusammenführen</button>
          ${picked.size ? '<button class="link-btn" type="button" data-unpick-all>Auswahl leeren</button>' : ''}
        </div>
      </div>
      ${!rulesAction ? '<p class="muted small-text">„In Firefly“ braucht unter <a href="#/automationen">Automationen</a> eine Automation mit Auslöser „Firefly-Regeln anlegen“ (Vorlage n8n/firefly-buchung-bearbeiten.json).</p>' : ''}
      ${merged.length ? `<details class="cm-merged-box" data-merged-box${mergedOpen ? ' open' : ''}><summary class="sub-h">Zusammengeführt <span class="muted">(${merged.length}${mergedOpenN ? ` · ${mergedOpenN} nur im Dashboard` : ' · alle in Firefly'})</span></summary>
        <div class="chips" role="group" aria-label="Zusammengeführt filtern" style="margin:8px 0">${[['offen', 'Nur im Dashboard', mergedOpenN], ['firefly', 'In Firefly übertragen', merged.length - mergedOpenN], ['alle', 'Alle', merged.length]].map(([k, label, c]) => `<button type="button" class="chip" data-merged-view="${k}" aria-pressed="${mergedView === k}">${label} ${c}</button>`).join('')}</div>
        ${mergedShown.length ? '' : `<div class="empty">${mergedView === 'offen' ? 'Alles in Firefly übertragen.' : 'Noch nichts übertragen.'}</div>`}
        <div class="list cm-merged">${mergedShown.map((m) => `<div class="row" style="cursor:default">
          <div style="min-width:0"><div class="title">„${esc(m.from)}“ → „${esc(m.to)}“</div>
            <div class="subtitle">${m.sentAt ? `in Firefly übertragen am ${fmtDate(m.sentAt)} (Regel in der Gruppe „${esc(RULE_GROUP)}“)` : m.firefly ? '<span class="bad">für Firefly vorgesehen, Übertragen fehlgeschlagen – erneut versuchen</span>' : 'nur im Dashboard – lässt sich jederzeit nach Firefly übertragen'}</div></div>
          <span class="cm-acts">${!m.sentAt && rulesAction ? `<button class="btn small" type="button" data-tofirefly="${esc(m.from)}" title="Regel „Kategorie ist ${esc(m.from)} → ${esc(m.to)}“ in Firefly anlegen und auf alle Buchungen anwenden">nach Firefly übertragen</button>`
    : m.sentAt && rulesAction ? `<button class="link-btn" type="button" data-tofirefly="${esc(m.from)}" title="Stehen in Firefly noch Buchungen unter „${esc(m.from)}“ (z. B. weil das Anwenden damals fehlschlug): Regel erneut anlegen und auf alle Buchungen anwenden">erneut übertragen</button>` : ''}
            <button class="link-btn" type="button" data-unmerge="${esc(m.from)}">aufheben</button></span></div>`).join('')}</div>
        ${merged.filter((m) => !m.sentAt).length > 1 && rulesAction ? `<button class="btn small" type="button" id="cm-all" style="margin-top:10px">Alle ${merged.filter((m) => !m.sentAt).length} nach Firefly übertragen</button>` : ''}
        <p class="muted small-text">„Aufheben“ wirkt sofort im Dashboard; wurde schon nach Firefly übertragen, wird die Regel dort entfernt –
          die Buchungen behalten aber die neue Kategorie (in Firefly ggf. von Hand zurücksetzen). Leere alte Kategorien kannst du in Firefly löschen.
          Tipp: Auch in der Import-Konfiguration (Data Importer) die alte Kategorie durch die neue ersetzen.</p></details>` : ''}
      ${emptyHtml()}`;
  }

  /** Alle für Firefly vorgesehenen Zusammenführungen als Regeln schicken (die Gruppe wird abgeglichen) und anwenden. */
  async function sendToFirefly() {
    const all = data.zusammengefuehrt.filter((m) => m.firefly);
    const rules = all.map((m) => ({ id: `kat-${m.from.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}`, enabled: true, when: [{ field: 'category', op: 'equals', value: m.from }], setCategory: m.to, addTags: [] }));
    const regeln = toFireflyRules(rules).map((r, k, arr) => ({ ...r, order: arr.length - k, description: `Kategorien zusammenführen (Dashboard) · id:${r.labor_id}` }));
    const res = await runAction(rulesAction, { typ: 'regeln_anlegen', gruppe: RULE_GROUP, regeln, anwenden: { start: '2000-01-01', end: isoDate(today()) } });
    if (!res.ok) throw new Error(`n8n antwortet mit ${res.status || 'Fehler'}: ${String(res.response || '').slice(0, 200)}`);
    data = await call({ sent: all.map((m) => m.from) });
    return all.length;
  }

  async function act(fn) {
    note = '<span class="muted">⏳ Speichere …</span>'; // sofort sichtbar – der Server rechnet die Summen neu
    render();
    try {
      await fn();
      txCache.clear();
      openRows.forEach((n) => loadTx(n));
      api.forget(); // Summen und Listen aller Seiten ändern sich
    } catch (err) {
      note = `<span class="bad">${esc(err.message)}</span>`;
    }
    render();
  }

  let searchTimer;
  el.addEventListener('input', (e) => {
    if (e.target === searchInput) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = searchInput.value;
        render();
      }, 150);
    } else if (e.target === targetInput) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        target = targetInput.value;
        render();
      }, 250);
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.dataset.emptyPick && empty && typeof empty === 'object') {
      if (e.target.checked) empty.off.delete(e.target.dataset.emptyPick);
      else empty.off.add(e.target.dataset.emptyPick);
      return render();
    }
    if (e.target === targetInput) {
      target = targetInput.value;
      return render();
    }
    const box = e.target.closest('[data-pick]');
    if (!box) return;
    if (box.checked) picked.add(box.dataset.pick);
    else picked.delete(box.dataset.pick);
    // noch kein Ziel: die größte ausgewählte Kategorie vorschlagen
    if (!target.trim() && picked.size >= 2) {
      const list = data.kategorien;
      target = [...picked].sort((a, b) => sum(list.find((c) => c.name === b) || { ausgaben: 0, einnahmen: 0 }) - sum(list.find((c) => c.name === a) || { ausgaben: 0, einnahmen: 0 }))[0];
      targetInput.value = target;
    }
    render();
  });
  function merge(mode, btn) {
    const to = target.trim();
    const from = [...picked].filter((f) => f.toLowerCase() !== to.toLowerCase());
    if (!to || !from.length) return;
    if (mode === 'firefly' && !window.confirm(`In Firefly ${from.map((f) => `„${f}“`).join(', ')} → „${to}“ zusammenführen?\n\nDas Dashboard legt per n8n je Kategorie eine Regel an und wendet sie auf alle Buchungen an – die Kategorie der Buchungen ändert sich in Firefly.`)) return;
    btn.disabled = true;
    act(async () => {
      data = await call({ from, to, firefly: mode === 'firefly' });
      picked.clear();
      target = '';
      targetInput.value = '';
      note = mode === 'firefly' ? '' : `✓ ${from.map((f) => `„${esc(f)}“`).join(', ')} zählt jetzt als „${esc(to)}“ – im ganzen Dashboard.`;
      if (mode === 'firefly') {
        body.querySelector('.cm-form').insertAdjacentHTML('afterend', '<p class="muted cm-busy">Übertrage nach Firefly … (kann bei vielen Buchungen ein paar Minuten dauern)</p>');
        const n = await sendToFirefly();
        note = `<span class="good">✓ In Firefly: ${n} Regel${n === 1 ? '' : 'n'} in der Gruppe „${esc(RULE_GROUP)}“, auf alle Buchungen angewendet.</span>`;
      }
    });
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.merge) return merge(b.dataset.merge, b);
    if (b.dataset.emptyCheck !== undefined) return checkEmpty();
    if (b.dataset.emptyDelete !== undefined && empty && typeof empty === 'object') {
      const sel = empty.leer.filter((c) => !empty.off.has(c.id));
      if (!sel.length || !window.confirm(`${sel.length} leere Kategorie${sel.length === 1 ? '' : 'n'} in Firefly löschen?\n\n${sel.slice(0, 15).map((c) => `• ${c.name}`).join('\n')}${sel.length > 15 ? '\n…' : ''}\n\nSie haben in Firefly keine einzige Buchung (eben geprüft).`)) return;
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span> Lösche …';
      deleteCategories(editAction, sel.map((c) => c.id), { namen: sel.map((c) => c.name) })
        .then(async () => {
          api.forget();
          await checkEmpty();
          emptyNote = `<span class="good">✓ ${sel.length} Kategorie${sel.length === 1 ? '' : 'n'} in Firefly gelöscht.</span>`;
          data = await call();
          render();
        })
        .catch((err) => {
          emptyNote = `<span class="bad">${esc(err.message)}</span>`;
          render();
        });
      return undefined;
    }
    if (b.dataset.mergedView) {
      mergedView = b.dataset.mergedView;
      store('ffd-cm-merged-view', mergedView);
      return render();
    }
    if (b.dataset.suggIgnore !== undefined) {
      const x = suggestions(data.kategorien, ignoredSugg())[Number(b.dataset.suggIgnore)];
      store(IGNORE_KEY, JSON.stringify([...ignoredSugg(), ...x.pairs].slice(-500)));
      return render();
    }
    if (b.dataset.suggRestore !== undefined || b.dataset.suggRestoreAll !== undefined) {
      const drop = b.dataset.suggRestore?.toLowerCase();
      store(IGNORE_KEY, JSON.stringify(drop ? [...ignoredSugg()].filter((k) => k !== drop) : []));
      return render();
    }
    if (b.dataset.suggMore !== undefined) {
      showSugg += 10;
      return render();
    }
    if (b.dataset.cmTx) {
      const name = b.dataset.cmTx;
      if (openRows.has(name)) openRows.delete(name);
      else {
        openRows.add(name);
        loadTx(name);
      }
      return render();
    }
    if (b.dataset.asTarget) {
      target = b.dataset.asTarget;
      targetInput.value = target;
      picked.delete(target);
      return render();
    }
    if (b.dataset.unpick) {
      picked.delete(b.dataset.unpick);
      return render();
    }
    if (b.dataset.unpickAll !== undefined) {
      picked.clear();
      return render();
    }
    if (b.dataset.sugg !== undefined) {
      const x = suggestions(data.kategorien, ignoredSugg())[Number(b.dataset.sugg)];
      picked.clear();
      x.from.forEach((n) => picked.add(n));
      target = x.to;
      targetInput.value = x.to;
      render();
      body.querySelector('.cm-form').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (b.dataset.unmerge) {
      b.disabled = true;
      act(async () => {
        const wasSent = data.zusammengefuehrt.find((m) => m.from === b.dataset.unmerge)?.sentAt;
        data = await call({ unmerge: b.dataset.unmerge });
        note = `„${esc(b.dataset.unmerge)}“ ist wieder eine eigene Kategorie im Dashboard.`;
        if (wasSent && rulesAction) {
          // die Regel in Firefly entfernen (Abgleich der Gruppe) – bereits geänderte Buchungen bleiben, wie sie sind
          await sendToFirefly();
          note += ' Die Regel in Firefly ist entfernt; Buchungen, die sie schon umgestellt hat, behalten die neue Kategorie.';
        }
      });
      return;
    }
    // nachträglich nach Firefly: einzelne oder alle noch nicht übertragenen Zusammenführungen
    const later = b.dataset.tofirefly ? data.zusammengefuehrt.filter((m) => m.from === b.dataset.tofirefly)
      : b.id === 'cm-all' ? data.zusammengefuehrt.filter((m) => !m.sentAt) : null;
    if (later?.length) {
      if (!window.confirm(`In Firefly zusammenführen?\n\n${later.map((m) => `„${m.from}“ → „${m.to}“`).join('\n')}\n\nDas Dashboard legt per n8n je Kategorie eine Regel an und wendet sie auf alle Buchungen an – die Kategorie der Buchungen ändert sich in Firefly.`)) return;
      b.disabled = true;
      act(async () => {
        for (const m of later) data = await call({ from: [m.from], to: m.to, firefly: true });
        const n = await sendToFirefly();
        note = `<span class="good">✓ In Firefly übertragen: ${later.map((m) => `„${esc(m.from)}“ → „${esc(m.to)}“`).join(', ')} (${n} Regel${n === 1 ? '' : 'n'} in der Gruppe, auf alle Buchungen angewendet).</span>`;
      });
    }
  });

  call().then((d) => {
    data = d;
    if (el.isConnected) render();
  }).catch((err) => (el.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`));
}
