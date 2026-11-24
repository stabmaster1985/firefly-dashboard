// Seite „Zuordnen“: automatische Kategorien (lib/autocat.js, lib/ledger.js). Buchungen ohne
// Firefly-Kategorie bekommen in allen Auswertungen eine – aus dem Händler abgeleitet. Hier sieht man,
// wie viel abgedeckt ist, ordnet offene Händler zu und korrigiert automatische Zuordnungen.
// Firefly bleibt unverändert.

import * as api from './api.js';
import { money, esc, fmtDate, percent } from './util.js';
import { card, skeleton, txAttrs, bindTxDetails, signedAmount, setFolded } from './common.js';
import { actionFor, runAction, setCategory } from './txedit.js';
import { toFireflyRules } from './rules.js';
import { isoDate, today, storage, store } from './util.js';

const FF_GROUP = 'Dashboard: Händler → Kategorie (Zuordnen)';
/** Kurze, feste Kennung je Händler für die Regel-Markierung („id:…“ ohne Leerzeichen). */
const keyId = (k) => {
  let h = 2166136261;
  for (const ch of String(k)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `z-${h.toString(36)}`;
};

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const call = (method, body) => fetch('/local/autocat', { method, headers: method === 'GET' ? {} : headers, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
    return data;
  });

export async function assignPage(view) {
  view.innerHTML = `
    <div class="grid">
      <section class="card span-12" id="z-cover">${skeleton(3)}</section>
      ${card('z-open', 'Noch nicht zugeordnet', { filter: true, meta: '<span id="z-open-meta"></span>' })}
      ${card('z-auto', 'Automatisch zugeordnet', { filter: true, meta: '<span id="z-auto-meta"></span>' })}
      ${card('z-ff', 'In Firefly übernehmen', { filter: true, meta: '<span id="z-ff-meta"></span>' })}
      ${card('z-set', 'Einstellungen', { meta: 'Woraus die Kategorien abgeleitet werden' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  ['z-open', 'z-auto', 'z-ff', 'z-set'].forEach((id) => ($(id).innerHTML = skeleton(4)));
  let rulesAction = null;
  let editAction = null;
  let ffPick = null; // ausgewählte Händler (Schlüssel) – beim ersten Laden vorbelegt
  const ffSeen = new Map(); // Händler → Stand bei der letzten Vorbelegung
  let ffRange = 'all';
  let ffOverwrite = storage('ffd-z-ff-over', '') === '1'; // rückwirkend auch vorhandene (andere) Kategorien umstellen
  let ffView = storage('ffd-z-ff-view', 'offen'); // offen | angehakt | firefly | alle
  let ffSource = ''; // Quelle oder '' = alle
  let ffNote = '';
  let fixAllNote = false; // Meldung von „Alle jetzt setzen“ oben statt unter dem Knopf zeigen
  let ffBusy = '';
  let data;
  let shownOpen = 40;
  let shownAuto = 40;
  let autoFilter = storage('ffd-z-auto', 'pruefen'); // pruefen | fest | alle
  const openKeys = new Set(); // aufgeklappte Händler (Buchungen sichtbar)
  const splitOpen = new Set(); // Händler, deren „Aufteilen“ offen ist
  const drafts = new Map(); // Händler → { lines: [{ field, value, category }], rest } – Entwurf beim Aufteilen
  const bookings = new Map(); // Händler → { anzahl, buchungen } | 'laden' | Fehlertext

  const catInput = (value, attrs) => `<input class="input" list="z-cats" value="${esc(value || '')}" placeholder="Kategorie wählen oder neu eingeben" aria-label="Kategorie" ${attrs}>`;
  // Woher eine Zuordnung kommt – als Erklärung an jedem Quellen-Etikett
  const QUELLE_INFO = {
    buchung: 'Du hast diese Buchung einzeln zugeordnet („nur diese“).',
    zuordnung: 'Du hast diesen Händler selbst zugeordnet oder bestätigt.',
    regel: 'Eine deiner Regeln im Labor (Kategorie setzen) trifft auf diesen Händler zu.',
    import: 'Aus der Tabelle „Händler → Kategorie“ deiner Data-Importer-Konfiguration (Seite Aufräumen).',
    gelernt: 'Gelernt: Andere Buchungen dieses Händlers haben in Firefly meist diese Kategorie.',
    liste: 'Eingebaute Händlerliste des Dashboards (z. B. Rossmann → Drogerie) – abschaltbar unter Einstellungen.',
    ki: 'KI-Bewertung aus dem Labor – abschaltbar unter Einstellungen.',
  };
  const mixedNote = (m) => (m.gemischt ? `<div class="z-mixed">⚠ In Firefly stehen Buchungen dieses Empfängers in verschiedenen Kategorien (${m.gemischt.map((c) => `${esc(c.name)} ${c.n}×`).join(', ')}) – vermutlich stecken verschiedene Händler dahinter. Eine Zuordnung für den ganzen Händler (und die Firefly-Regel) träfe alle gleich; besser einzeln („Buchungen ansehen“ → „nur diese“).</div>` : '');
  const quelle = (q) => (q ? `<span class="badge auto" title="${esc(QUELLE_INFO[q] || 'Quelle der Zuordnung')}">${esc(data.quellen[q] || q)}</span>` : '');
  /** Händler in „Automatisch zugeordnet“ anzeigen und zum Bearbeiten markieren. */
  function editMerchant(key) {
    const list = autoFilter === 'alle' ? data.automatisch : data.automatisch.filter((m) => (autoFilter === 'fest' ? m.fest : !m.fest));
    if (!list.some((m) => m.key === key)) autoFilter = 'alle';
    const all = autoFilter === 'alle' ? data.automatisch : list;
    shownAuto = Math.max(shownAuto, all.findIndex((m) => m.key === key) + 1);
    render();
    const sec = $('z-auto').closest('.card');
    if (sec.classList.contains('folded')) setFolded(sec, false);
    const row = [...$('z-auto').querySelectorAll('.z-row')].find((r) => r.dataset.key === key);
    if (!row) return;
    row.hidden = false;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('z-flash');
    setTimeout(() => row.classList.remove('z-flash'), 2500);
  }

  // ---- In Firefly übernehmen: Händler-Zuordnungen als Firefly-Regeln, Einzelzuordnungen per n8n ----
  /** Kategorie für die Firefly-Regel: bei deiner Zuordnung deren Kategorie („sonst“ beim Aufteilen), sonst die erkannte. */
  const mainCat = (m) => (m.fest && m.festKategorie ? m.festKategorie : m.category);
  const sameSplit = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  /** Kategorie der allgemeinen Firefly-Regel – leer, wenn die übrigen Buchungen ihre Kategorie behalten (keep). */
  const ffCat = (m) => (m.festKeep ? '' : mainCat(m));
  const UP_TO_DATE = (m) => m.ff && m.ff.sentAt && m.ff.category === ffCat(m) && Boolean(m.ff.keep) === Boolean(m.festKeep) && sameSplit(m.ff.split, m.split);
  /**
   * Übertragen – und was davon in Firefly angekommen ist: Die Regel setzt nur Buchungen ohne Kategorie; Buchungen mit
   * anderer Kategorie bleiben (dafür „auch vorhandene Kategorien umstellen“).
   */
  function ffState(m) {
    const st = m.ffStand;
    if (!st) return '<span class="badge good" title="Regel in Firefly angelegt">Regel in Firefly</span>';
    const andere = st.namen.map((c) => `„${c.name}“ ${c.n}×`).join(', ');
    const fresh = Date.now() - new Date(m.ff.sentAt).getTime() < 10 * 60_000; // Firefly wendet die Regel evtl. noch an
    const parts = [`<span class="badge good" title="Regel in Firefly angelegt">Regel in Firefly</span>`];
    parts.push(`<span class="muted">${st.ziel} von ${st.ziel + st.ohne + st.andere} Buchungen (24 Monate) dort mit „${esc(ffCat(m) || 'Unterscheidung')}“</span>`);
    if (st.andere) parts.push(`<span class="badge warn" title="${esc(`In Firefly noch: ${andere}. Die Regel ändert vorhandene Kategorien nicht – „jetzt setzen“ stellt sie direkt um.`)}">${st.andere} mit anderer Kategorie</span>`);
    if (st.ohne) parts.push(fresh ? `<span class="badge" title="Firefly wendet die Regel gerade an – die Liste lädt nach etwa 2 und 7 Minuten neu">${st.ohne} ohne Kategorie – Firefly arbeitet noch</span>`
      : `<span class="badge bad" title="Die Regel hat diese Buchungen nicht erfasst. „jetzt setzen“ setzt sie direkt. Ursache prüfen: Läuft die Automation „Firefly-Regeln anlegen“ fehlerfrei (n8n-Ausführungen)? Passt die Bedingung der Regel zu den Buchungen (Regel in Firefly öffnen, „Testen“)? Erneut übertragen mit „rückwirkend anwenden“.">${st.ohne} noch ohne Kategorie</span>`);
    if (editAction && (st.andere || (st.ohne && !fresh))) parts.push(fixButton(m.key, st, fresh));
    return parts.join(' ');
  }
  /** „jetzt setzen“: Buchungen mit anderer bzw. (nach Ablauf der Regel) ohne Kategorie direkt in Firefly setzen. */
  const fixButton = (key, st, fresh) => {
    const n = st.andere + (fresh ? 0 : st.ohne);
    return `<button class="btn small" type="button" data-ff-over-one="${esc(key)}"${fresh ? '' : ' data-ohne="1"'}${ffBusy ? ' disabled' : ''} title="Die Kategorie bei diesen Buchungen direkt in Firefly setzen (Automation „Kategorie übernehmen“) – vorher zeigt eine Rückfrage, was sich ändert">${n} jetzt setzen</button>`;
  };
  /** Übertragene Händler, bei denen in Firefly noch Buchungen eine andere (oder, nach Ablauf der Regel, keine) Kategorie haben. */
  const ffFixable = () => (data.firefly || []).filter((f) => f.sentAt && f.stand
    && (f.stand.andere || (f.stand.ohne && Date.now() - new Date(f.sentAt).getTime() >= 10 * 60_000)));
  const ffCandidates = () => data.automatisch.filter((m) => m.cond && (m.category || m.split) && m.quelle !== 'buchung');
  /** Karte „In Firefly übernehmen“ – ein Fehler darin zeigt sich in der Karte, statt sie leer zu lassen. */
  function renderFirefly() {
    // Scrollstand der Liste behalten (sonst springt sie nach jedem Häkchen nach oben)
    const top = $('z-ff').querySelector('.z-ff-table')?.scrollTop || 0;
    try {
      renderFireflyCard();
      const box = $('z-ff').querySelector('.z-ff-table');
      if (box && top) box.scrollTop = top;
    } catch (err) {
      console.error(err);
      $('z-ff').innerHTML = `<div class="empty bad">Die Liste konnte nicht angezeigt werden: ${esc(err.message)}. Bitte melden.</div>`;
    }
  }
  function renderFireflyCard() {
    const cands = ffCandidates();
    // Vorbelegung: deine eigenen, noch nicht übertragenen Zuordnungen. Neu bestätigte/geänderte Händler
    // (Stand je Händler geändert) werden auch nachträglich angehakt.
    ffPick ||= new Set();
    for (const m of cands) {
      const sig = `${m.quelle}|${m.category}|${m.ff?.sentAt || ''}`;
      if (ffSeen.get(m.key) === sig) continue;
      ffSeen.set(m.key, sig);
      if (!UP_TO_DATE(m) && m.quelle === 'zuordnung' && !m.gemischt) ffPick.add(m.key); // nur, was du selbst bestätigt/zugeordnet hast
      else ffPick.delete(m.key);
    }
    const keys = new Set(cands.map((m) => m.key));
    const fixable = ffFixable();
    const elsewhere = data.firefly.filter((f) => !keys.has(f.key)); // übertragen – Firefly hat die Buchungen inzwischen kategorisiert
    const sent = data.firefly.filter((f) => f.sentAt).length;
    const marked = cands.filter((m) => ffPick.has(m.key)).length;
    $('z-ff-meta').textContent = [marked ? `${marked} vorgemerkt` : '', sent ? `${sent} Regel${sent === 1 ? '' : 'n'} in Firefly` : ''].filter(Boolean).join(' · ');
    const status = (m) => (m.gemischt ? `<span class="badge bad" title="${esc(`In Firefly in verschiedenen Kategorien: ${m.gemischt.map((c) => c.name).join(', ')} – vermutlich verschiedene Händler`)}">⚠ verschiedene Händler?</span> ` : '') + (UP_TO_DATE(m) ? ffState(m)
      : m.ff?.sentAt ? `<span class="badge warn" title="In Firefly steht noch „${esc(m.ff.category)}“">geändert</span>` : '');
    const n = [...ffPick].filter((k) => keys.has(k)).length;
    // Filter: Status und Quelle (Text über das Filterfeld der Karte)
    const inFf = (m) => Boolean(m.ff?.sentAt);
    const views = {
      offen: { label: 'Noch nicht in Firefly', test: (m) => !UP_TO_DATE(m) },
      angehakt: { label: 'Angehakt', test: (m) => ffPick.has(m.key) },
      firefly: { label: 'Schon in Firefly', test: inFf },
      alle: { label: 'Alle', test: () => true },
    };
    if (!views[ffView]) ffView = 'offen';
    const bySource = (m) => !ffSource || m.quelle === ffSource;
    const shown = cands.filter((m) => views[ffView].test(m) && bySource(m));
    const sources = [...new Set(cands.map((m) => m.quelle).filter(Boolean))];
    const filterBar = `<div class="z-ff-filter">
        <div class="chips" role="group" aria-label="Status">${Object.entries(views).map(([k, v]) => `<button type="button" class="chip" data-ff-view="${k}" aria-pressed="${ffView === k}">${v.label} ${cands.filter((m) => v.test(m) && bySource(m)).length}</button>`).join('')}</div>
        ${sources.length > 1 ? `<label>Quelle <select class="input select" data-ff-source><option value="">alle</option>${sources.map((q) => `<option value="${esc(q)}"${q === ffSource ? ' selected' : ''}>${esc(data.quellen[q] || q)} (${cands.filter((m) => m.quelle === q).length})</option>`).join('')}</select></label>` : ''}
      </div>`;
    $('z-ff').innerHTML = `
      <p class="muted" style="margin-top:0">Macht aus den Zuordnungen Firefly-Regeln (Gruppe „${esc(FF_GROUP)}“): „Händler → Kategorie“ –
        sie greifen bei künftigen Importen und auf Wunsch rückwirkend, <b>nur bei Ausgaben ohne Kategorie</b> (vorhandene Kategorien bleiben). Ausnahme: Unterscheidungen beim Aufteilen gelten immer, auch über eine vorhandene Kategorie.
        Sollen auch alte Buchungen umgestellt werden, die schon eine andere Kategorie haben: „auch vorhandene Kategorien umstellen“ anhaken.
        Danach stehen die Kategorien in Firefly selbst.</p>
      ${ffNote && (!rulesAction || !cands.length) ? `<div class="cm-note">${ffNote}</div>` : ''}
      ${!rulesAction ? `<div class="cm-note"><b>Zum Übertragen fehlt die Automation „Firefly-Regeln anlegen“.</b> Unter <a href="#/automationen">Automationen</a> eine Automation mit diesem Auslöser einrichten (Vorlage n8n/firefly-buchung-bearbeiten.json, dieselbe wie für „Kategorie übernehmen“ – nur der Auslöser ist ein anderer).</div>
        ${cands.length ? `<p class="muted">Vorgemerkt sind deine bestätigten Zuordnungen (${[...ffPick].filter((k) => keys.has(k)).length} von ${cands.length} Händlern):</p><ul class="z-ff-plain">${cands.filter((m) => ffPick.has(m.key)).slice(0, 50).map((m) => `<li>${esc(m.name)} → ${esc(m.category)} ${quelle(m.quelle)} <button type="button" class="link-btn" data-edit="${esc(m.key)}">bearbeiten</button></li>`).join('')}</ul>` : ''}` : `
      ${editAction && fixable.length ? `<div class="cm-note z-ff-fixall"><span><b>${fixable.length} übertragene Händler</b> haben in Firefly noch Buchungen mit anderer oder ohne Kategorie (${fixable.reduce((a, f) => a + f.stand.andere + f.stand.ohne, 0)} in den letzten 24 Monaten).</span>
        <button class="btn small" type="button" id="z-ff-fix-all"${ffBusy ? ' disabled' : ''}>${ffBusy ? '<span class="spinner"></span> läuft …' : 'Alle jetzt setzen'}</button></div>` : ''}
      ${ffNote && fixAllNote ? `<div class="cm-note" role="status">${ffNote}</div>` : ''}
      ${cands.length ? `${filterBar}${shown.length ? `<div class="table-wrap z-ff-table"><table><thead><tr><th class="pick-cell"><input type="checkbox" id="z-ff-all" aria-label="alle angezeigten auswählen" title="alle angezeigten"></th><th>Händler</th><th>Kategorie</th><th class="num hide-sm">24 Monate</th></tr></thead>
        <tbody>${shown.map((m) => `<tr style="cursor:default">
          <td class="pick-cell"><input type="checkbox" data-ff="${esc(m.key)}" ${ffPick.has(m.key) ? 'checked' : ''} aria-label="${esc(m.name)}"></td>
          <td><div class="desc">${esc(m.name)} ${status(m)}</div><div class="flow">${quelle(m.quelle)} <button type="button" class="link-btn" data-edit="${esc(m.key)}">bearbeiten</button> · ${esc(m.cond.field === 'party' ? 'Empfänger' : m.cond.field === 'notes' ? 'Notizen' : 'Beschreibung')} ${m.cond.op === 'equals' ? 'ist' : 'enthält'} „${esc(m.cond.value)}“</div></td>
          <td>${m.festKeep ? '<span class="muted">übrige bleiben</span>' : esc(mainCat(m))}${m.split ? `<div class="flow">+ ${m.split.length} Unterscheidung${m.split.length === 1 ? '' : 'en'} (${m.split.map((x) => `„${esc(x.value)}“ → ${esc(x.category)}`).join(', ')})</div>` : ''}</td>
          <td class="num hide-sm">${money(m.auto, data.waehrung)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Keine Händler in dieser Auswahl.</div>'}
        <div class="z-ff-actions">
          <label>rückwirkend anwenden <select class="input select" data-ff-range>
            <option value="all"${ffRange === 'all' ? ' selected' : ''}>alle Buchungen ohne Kategorie</option>
            <option value="24"${ffRange === '24' ? ' selected' : ''}>letzte 24 Monate</option>
            <option value="none"${ffRange === 'none' ? ' selected' : ''}>nein, nur künftige Importe</option></select></label>
          ${editAction && ffRange !== 'none' ? `<label class="z-ff-over" title="Buchungen dieser Händler, die in Firefly schon eine andere Kategorie haben, direkt umstellen (einmalig, per n8n). Einzeln zugeordnete („nur diese“) bleiben. Künftige Importe: weiterhin nur ohne Kategorie."><input type="checkbox" data-ff-over${ffOverwrite ? ' checked' : ''}> auch vorhandene Kategorien umstellen</label>` : ''}
          <span class="z-ff-btns">${editAction && n ? `<button class="btn" type="button" id="z-ff-fix-picked"${ffBusy ? ' disabled' : ''} title="Bei den angehakten Händlern die Kategorie direkt in Firefly setzen – bei Buchungen mit anderer oder ohne Kategorie (ohne Regel; Rückfrage zeigt vorher alles)">Kategorie bei ${n} angehakten jetzt setzen</button>` : ''}
          <button class="btn primary" type="button" id="z-ff-send"${n && !ffBusy ? '' : ' disabled'}>${ffBusy ? '<span class="spinner"></span> Überträgt …' : `${n} als Regel${n === 1 ? '' : 'n'} nach Firefly`}</button></span>
        </div>
        ${ffBusy ? `<div class="cm-note" role="status"><span class="spinner"></span> ${esc(ffBusy)}</div>` : ffNote && !fixAllNote ? `<div class="cm-note" role="status">${ffNote}</div>` : ''}
        <p class="muted small-text">Angehakt sind nur deine bestätigten Zuordnungen („✓ Passt“ oder geändert). Andere (Händlerliste, gelernt, Import, KI) erst prüfen – „bearbeiten“ springt zum Händler – oder selbst anhaken. Bereits übertragene Regeln bleiben bestehen; „geändert“ heißt: im Dashboard jetzt eine andere Kategorie – erneut übertragen ändert die Regel.</p>`
    : '<div class="empty">Keine automatischen Zuordnungen mit erkennbarem Händler.</div>'}
      ${elsewhere.length ? `<details class="r-hidden"><summary>${elsewhere.length} Regel${elsewhere.length === 1 ? '' : 'n'} schon in Firefly wirksam (die Buchungen haben dort ihre Kategorie)</summary>
        <ul>${elsewhere.map((f) => `<li>${esc(f.name)} → ${esc(f.category || 'Unterscheidungen')}${f.stand ? ` <span class="muted">· ${f.stand.ziel} von ${f.stand.ziel + f.stand.ohne + f.stand.andere} Buchungen (24 Monate) so in Firefly</span>` : ''}
          ${f.stand?.andere ? ` <span class="badge warn" title="${esc(`In Firefly noch: ${f.stand.namen.map((c) => `„${c.name}“ ${c.n}×`).join(', ')}`)}">${f.stand.andere} mit anderer Kategorie</span>` : ''}${f.stand?.ohne ? ` <span class="badge bad">${f.stand.ohne} ohne Kategorie</span>` : ''}${editAction && f.stand && (f.stand.andere || f.stand.ohne) ? ` ${fixButton(f.key, f.stand, false)}` : ''}
          <button class="link-btn" type="button" data-ff-remove="${esc(f.key)}">Regel entfernen</button></li>`).join('')}</ul></details>` : ''}
      ${data.einzeln?.length ? `<div class="z-ff-single"><b>${data.einzeln.length} einzeln zugeordnete Buchung${data.einzeln.length === 1 ? '' : 'en'}</b> <span class="muted">(„nur diese“) – dafür gibt es keine Regel; ${editAction ? 'direkt per n8n setzen:' : 'braucht die Automation „Kategorie übernehmen“.'}</span>
        ${editAction ? `<button class="btn small" type="button" id="z-ff-single"${ffBusy ? ' disabled' : ''}>In Firefly setzen</button>` : ''}</div>` : ''}`}
      ${ffBusy && (!rulesAction || !cands.length) ? `<p class="muted"><span class="spinner"></span> ${esc(ffBusy)}</p>` : ''}`;
    const all = $('z-ff').querySelector('#z-ff-all');
    if (all) {
      all.checked = shown.length > 0 && shown.every((m) => ffPick.has(m.key));
      all.indeterminate = !all.checked && shown.some((m) => ffPick.has(m.key));
    }
  }

  /** Alle vorgemerkten Händler als Regeln schicken (die Gruppe wird abgeglichen) und ggf. rückwirkend anwenden. */
  async function sendRules(list) {
    // Je Händler zuerst die allgemeine Regel, danach die Unterscheidungen: Firefly führt Regeln in aufsteigender
    // Reihenfolge aus (hier: spätere im Feld zuerst) – die speziellen setzen die Kategorie, die allgemeine findet dann
    // keine Buchung ohne Kategorie mehr.
    const rules = list.flatMap((f) => [
      ...(f.keep ? [] : [{ id: keyId(f.key), enabled: true, when: [f.cond], setCategory: f.category, addTags: [] }]), // keep: keine allgemeine Regel
      // umgekehrt: die erste Zeile läuft in Firefly zuerst (wie im Dashboard)
      ...[...(f.split || [])].reverse().map((x) => ({ split: true, id: keyId(`${f.key}|${x.field}|${x.value}`), enabled: true, when: [f.cond, { field: x.field, op: 'contains', value: x.value }], setCategory: x.category, addTags: [] })),
    ]);
    const splitIds = new Set(rules.filter((r) => r.split).map((r) => r.id));
    const regeln = toFireflyRules(rules).map((r, k, arr) => ({
      ...r,
      // nur Ausgaben ohne Kategorie – vorhandene Kategorien (auch vom Import) bleiben unangetastet
      // Unterscheidungen (Händler + Mandatsreferenz o. ä.) sind deine ausdrückliche Entscheidung: sie gelten auch, wenn die
      // Buchung schon eine Kategorie hat (z. B. vom Import „Versicherung“); die allgemeine Regel nur ohne Kategorie
      triggers: [...r.triggers, ...(splitIds.has(r.labor_id) ? [] : [{ type: 'has_no_category', value: 'true' }]), { type: 'transaction_type', value: 'withdrawal' }],
      order: arr.length - k,
      description: `Zuordnen (Dashboard) · id:${r.labor_id}`,
    }));
    const t0 = today();
    const anwenden = ffRange === 'none' ? null
      : { start: ffRange === 'all' ? '2000-01-01' : isoDate(new Date(t0.getFullYear(), t0.getMonth() - 24, 1)), end: isoDate(t0) };
    const res = await runAction(rulesAction, { typ: 'regeln_anlegen', gruppe: FF_GROUP, regeln, anwenden });
    if (!res.ok) throw new Error(`n8n antwortet mit ${res.status || 'Fehler'}: ${String(res.response || '').slice(0, 200)}`);
  }

  /** Vorhandene Kategorien direkt umstellen (Automation „Kategorie übernehmen“) – in Paketen gegen Zeitüberschreitungen. */
  async function overwriteExisting(change) {
    let ok = 0;
    let last = null; // letzte Fehler-Antwort von n8n – für die Fehlersuche
    // Kleine Pakete, Größe nach Antwortzeit (Ziel ~25 s): Ein Proxy vor n8n bricht lange Anfragen nach ~60 s mit 504 ab
    let size = 8;
    const queue = change.map((c) => ({ c, tries: 0 }));
    const total = change.length;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (queue.length) {
      const part = queue.splice(0, size);
      ffBusy = `Setze Kategorien in Firefly … ${total - queue.length - part.length} von ${total}`;
      renderFirefly();
      const t0 = Date.now();
      const r = await runAction(editAction, {
        typ: 'kategorien_uebernehmen',
        aenderungen: part.map(({ c }) => ({ transaction_group_id: c.transaction_group_id, transaction_journal_id: c.transaction_journal_id, datum: c.date, beschreibung: c.description, betrag: c.amount, kategorie_alt: c.alt, kategorie: c.kategorie })),
      }).catch((err) => ({ ok: false, response: err.message }));
      if (r.ok) {
        ok += part.length;
        size = Math.max(2, Math.min(25, Math.round(size * 25_000 / Math.max(1000, Date.now() - t0))));
        continue;
      }
      last = r;
      // Zeitüberschreitung (504 vom Proxy o. ä.): n8n arbeitet meist weiter – kurz warten, in Firefly nachsehen, Rest erneut
      const timeout = !r.status || [502, 503, 504, 524].includes(r.status);
      let rest = part;
      if (timeout) {
        ffBusy = `Zeitüberschreitung bei n8n – prüfe in Firefly, was angekommen ist … (${total - queue.length - part.length} von ${total})`;
        renderFirefly();
        await sleep(30_000);
        const chk = await call('POST', { pruefeKategorien: part.map(({ c }) => ({ g: c.transaction_group_id, j: c.transaction_journal_id, kategorie: c.kategorie })) }).catch(() => null);
        if (chk && !chk.fehler) {
          const missing = new Set(chk.fehlt.map((x) => String(x.j)));
          rest = part.filter(({ c }) => missing.has(String(c.transaction_journal_id)));
          ok += part.length - rest.length;
        }
        size = Math.max(2, Math.floor(size / 2));
      }
      const again = rest.filter((x) => x.tries < 2).map((x) => ({ ...x, tries: x.tries + 1 }));
      if (timeout) queue.unshift(...again);
    }
    // Nicht auf „200“ von n8n verlassen: in Firefly nachsehen, ob die Kategorie wirklich angekommen ist
    let check = null;
    if (ok) {
      ffBusy = 'Prüfe in Firefly, ob die Kategorien angekommen sind …';
      renderFirefly();
      check = await call('POST', { pruefeKategorien: change.map((c) => ({ g: c.transaction_group_id, j: c.transaction_journal_id, kategorie: c.kategorie })) }).catch(() => null);
      refreshLater([6_000, 20_000]); // der Server erneuert die Monate kurz nach der Änderung
    }
    return { ok, check, last: ok < change.length ? last : null, total: change.length };
  }
  /** Ergebnis von overwriteExisting als Meldung (mit Hinweisen zur Fehlersuche). */
  function overwriteReport(r, what) {
    const body = String(r.last?.response || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const reply = r.last ? `${r.last.status ? `HTTP ${r.last.status}` : 'keine Antwort'}${body ? `: ${body.slice(0, 160)}` : ''}` : '';
    const proxyHint = [502, 504, 524].includes(r.last?.status)
      ? '<br><span class="muted">Ein Proxy vor n8n (z. B. Nginx Proxy Manager) bricht lange Anfragen ab. Das Dashboard schickt dann kleinere Pakete und prüft nach; dauerhaft hilft es, beim Proxy-Host von n8n die Zeitgrenze zu erhöhen (Advanced: <code>proxy_read_timeout 300s;</code>) – oder die Automation direkt auf n8n zeigen zu lassen (http://IP:5678/webhook/…).</span>' : '';
    const name = esc(editAction?.name || 'Kategorie übernehmen');
    if (!r.ok) {
      return `<span class="bad">Nichts gesetzt – die Automation „${name}“ meldet einen Fehler (${esc(reply)}).</span>
        <br><span class="muted">In n8n unter „Executions“ die letzte Ausführung des Workflows ansehen. Ist es der Workflow aus der Vorlage n8n/firefly-buchung-bearbeiten.json (aktuelle Fassung)?</span>${proxyHint}`;
    }
    const c = r.check;
    if (c && c.geprueft && c.ok === c.geprueft && r.ok === r.total) return `<span class="good">✓ ${r.ok} ${what} gesetzt – in Firefly nachgeprüft.</span>`;
    if (c && c.geprueft && c.ok < c.geprueft) {
      const ist = [...new Set(c.fehlt.map((x) => x.ist || 'ohne Kategorie'))].slice(0, 4).join(', ');
      return `<span class="bad">n8n hat ${r.ok === r.total ? 'alles' : `${r.ok} von ${r.total}`} angenommen, aber in Firefly ist ${c.ok ? `nur bei ${c.ok} von ${c.geprueft}` : `bei keiner der ${c.geprueft}`} geprüften Buchungen die neue Kategorie angekommen (dort steht: ${esc(ist)}).</span>
        <br><span class="muted">Antwort von n8n: <code>${esc(reply) || '–'}</code>. Die Automation „${name}“ ruft vermutlich einen Workflow auf, der den Typ „kategorien_uebernehmen“ nicht verarbeitet (eigener oder alter Workflow, oder einer, der sofort „OK“ antwortet).
        Abhilfe: in n8n die Vorlage n8n/firefly-buchung-bearbeiten.json importieren und die Automation auf deren Webhook zeigen lassen; die letzte Ausführung unter „Executions“ zeigt, wo es hängt.</span>`;
    }
    const failed = r.ok < r.total ? ` <span class="bad">${r.total - r.ok} nicht gesetzt (${esc(reply)}) – erneut versuchen.</span>` : '';
    return `<span class="good">✓ ${r.ok} ${what} an n8n übergeben${c?.fehler ? ` – Nachprüfung in Firefly nicht möglich (${esc(c.fehler)})` : ''}.</span>${failed}${failed ? proxyHint : ''}`;
  }
  const changeSummary = (change) => [...change.reduce((acc, c) => acc.set(`${c.alt || 'ohne Kategorie'} → ${c.kategorie}`, (acc.get(`${c.alt || 'ohne Kategorie'} → ${c.kategorie}`) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]);

  /** Nach dem rückwirkenden Anwenden: Firefly braucht etwas – in 2 und 7 Minuten neu laden (der Server erneuert vorher). */
  function refreshLater(times = [120_000, 420_000]) {
    for (const ms of times) {
      setTimeout(async () => {
        if (!view.isConnected || ffBusy || splitOpen.size || view.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
        try {
          api.forget();
          bookings.clear();
          data = await call('GET');
          openKeys.forEach((key) => loadBookings(key, true));
          render();
        } catch {
          // nächster Versuch bzw. beim nächsten Öffnen
        }
      }, ms);
    }
  }

  async function ffDo(label, fn) {
    ffBusy = label;
    ffNote = '';
    renderFirefly();
    try {
      ffNote = await fn();
      api.forget();
      bookings.clear();
      data = await call('GET');
    } catch (err) {
      ffNote = `<span class="bad">${esc(err.message)}</span>`;
    }
    ffBusy = '';
    render();
  }

  // ---- Aufteilen: je nach Buchungstext eine andere Kategorie (Versicherer mit Kfz- und Familienversicherung) ----
  const low = (x) => String(x ?? '').toLowerCase();
  const matchLine = (lines, t) => lines.find((x) => x.value.trim().length >= 2 && x.category.trim() && low(t[x.field]).includes(low(x.value).trim()));
  /** Kennzeichen, die nur einen Teil der Buchungen betreffen – Mandatsreferenz zuerst (sie gehört zu genau einem Vertrag). */
  function splitHints(list) {
    const counts = new Map();
    const add = (field, value, kind) => {
      const k = `${field}|${low(value)}`;
      const c = counts.get(k) || { field, value: low(value), kind, n: 0 };
      c.n += 1;
      counts.set(k, c);
    };
    for (const t of list) {
      const seen = new Set();
      for (const field of ['description', 'notes']) {
        const txt = String(t[field] || '');
        const mref = /MREF[:+]?\s*([A-Za-z0-9./-]{5,})/i.exec(txt);
        if (mref && !seen.has(`${field}${low(mref[1])}`)) {
          seen.add(`${field}${low(mref[1])}`);
          add(field, mref[1], 'Mandatsreferenz');
        }
        for (const w of new Set(txt.split(/[\s,;:/()+]+/).map((x) => x.replace(/^[.+-]+|[.+-]+$/g, '')))) {
          if (w.length < 3 || /^(eref|mref|cred|iban|bic|svwz|sepa|lastschrift|basislastschrift)$/i.test(w) || /^\d{1,5}$/.test(w)) continue;
          if (seen.has(`${field}${low(w)}`)) continue;
          seen.add(`${field}${low(w)}`);
          add(field, w, /\d{6,}/.test(w) ? 'Nummer' : 'Wort');
        }
      }
    }
    return [...counts.values()]
      .filter((c) => c.n >= 2 && c.n < list.length) // kommt mehrfach vor, aber nicht überall
      .sort((a, b) => Number(b.kind === 'Mandatsreferenz') - Number(a.kind === 'Mandatsreferenz') || b.n - a.n)
      .slice(0, 12);
  }
  function splitBlock(m) {
    if (!splitOpen.has(m.key)) return '';
    const d = drafts.get(m.key);
    const b = bookings.get(m.key);
    const list = b && typeof b === 'object' ? b.buchungen : null;
    const line = (x, i) => `<div class="z-split-line" data-line="${i}">
        <select class="input select" data-sf="field" aria-label="Wo suchen"><option value="description"${x.field === 'description' ? ' selected' : ''}>Beschreibung</option><option value="notes"${x.field === 'notes' ? ' selected' : ''}>Notiz</option></select>
        <span class="muted">enthält</span><input class="input" data-sf="value" value="${esc(x.value)}" placeholder="z. B. Kfz oder Vertragsnummer" aria-label="Text">
        <span class="muted">→</span>${catInput(x.category, 'data-sf="category"')}
        <button type="button" class="link-btn" data-split-del="${i}" aria-label="Unterscheidung entfernen">✕</button>
        ${list ? (() => {
    const hits = list.filter((t) => matchLine([x], t));
    const inFf = hits.filter((t) => t.ffd_quelle === 'firefly').length;
    return `<span class="muted z-split-n" title="${inFf ? `davon ${inFf} mit Kategorie in Firefly` : 'alle ohne Kategorie in Firefly'}">${hits.length}×</span>`;
  })() : ''}</div>`;
    const hints = list ? splitHints(list) : [];
    const preview = list ? list.map((t) => {
      const ff = t.ffd_quelle === 'firefly';
      const hit = matchLine(d.lines, t);
      const target = ff ? t.category_name : hit ? hit.category : d.keep ? t.category_name : d.rest;
      // Firefly-Kategorie, die eine Unterscheidung ändert: geschieht über die Firefly-Regel (rückwirkend anwenden)
      const viaRule = ff && hit && hit.category.trim().toLowerCase() !== String(t.category_name || '').toLowerCase();
      return `<tr style="cursor:default"><td class="date">${fmtDate(t.date)}</td><td><div class="desc">${esc(String(t.description || '').slice(0, 90))}</div>${t.notes ? `<div class="flow">${esc(String(t.notes).slice(0, 110))}</div>` : ''}</td>
        <td class="num">${signedAmount(t)}</td><td>${viaRule ? `<s class="muted">${esc(target || '')}</s> → <b>${esc(hit.category)}</b> <span class="badge warn" title="Steht in Firefly mit Kategorie – wird über „In Firefly übernehmen“ (rückwirkend anwenden) umgestellt">per Firefly-Regel</span>`
    : ff ? `${esc(target || '')} <span class="badge" title="Kategorie steht so in Firefly – bleibt">Firefly</span>` : !hit && d.keep ? `${esc(target || '–')} <span class="muted">(bleibt)</span>` : `→ <b>${esc(target || '–')}</b>${hit ? '' : ' <span class="muted">(sonst)</span>'}`}</td></tr>`;
    }).join('') : '';
    return `<div class="z-split" data-split-box="${esc(m.key)}">
      <p class="muted" style="margin-top:0">Je nach Buchungstext eine andere Kategorie – z. B. beim Versicherer die Kfz-Versicherung (Mandatsreferenz oder „Kfz“ im Text) nach „KFZ“, die Familienversicherung nach „Familie“. Die erste passende Zeile gilt.
        Buchungen, die in Firefly schon eine Kategorie haben, stellt die Aufteilung über „In Firefly übernehmen“ (rückwirkend anwenden) um – in der Vorschau „per Firefly-Regel“; künftige Importe auch dann, wenn der Import schon eine Kategorie setzt.</p>
      ${d.lines.map(line).join('')}
      <div class="z-split-actions"><button type="button" class="btn small" data-split-add>+ Unterscheidung</button>
        ${hints.length ? `<span class="muted">Vorschläge:</span> ${hints.map((h, i) => `<button type="button" class="chip small" data-split-hint="${i}" title="${esc(h.kind)} in ${h.field === 'notes' ? 'der Notiz' : 'der Beschreibung'}">${esc(h.kind === 'Wort' ? h.value : `${h.kind} ${h.value}`)} · ${h.n}×</button>`).join(' ')}` : list ? '' : '<span class="muted">Lade Buchungen …</span>'}</div>
      <div class="z-split-rest"><span class="muted">sonst</span>
        <select class="input select" data-split-keep aria-label="Übrige Buchungen"><option value="set"${d.keep ? '' : ' selected'}>→ Kategorie festlegen</option><option value="keep"${d.keep ? ' selected' : ''}>Kategorie beibehalten</option></select>
        ${d.keep ? '' : catInput(d.rest, 'data-split-rest')}
        <button type="button" class="btn small primary" data-split-save="${esc(m.key)}" data-name="${esc(m.name)}">Aufteilung speichern</button>
        ${m.split ? `<button type="button" class="link-btn" data-split-clear="${esc(m.key)}" data-name="${esc(m.name)}">Aufteilung entfernen</button>` : ''}</div>
      ${list ? (() => {
    // Firefly-Buchungen, die keine Zeile trifft, behalten ihre Kategorie – „sonst“ gilt nur ohne Kategorie
    const stay = d.keep ? 0 : list.filter((t) => t.ffd_quelle === 'firefly' && !matchLine(d.lines, t) && d.rest.trim() && String(t.category_name || '').toLowerCase() !== d.rest.trim().toLowerCase()).length;
    return stay ? `<p class="z-split-note">${stay} Buchung${stay === 1 ? '' : 'en'} mit Kategorie in Firefly trifft keine Zeile und ${stay === 1 ? 'behält ihre' : 'behalten ihre'} Kategorie („sonst“ gilt nur für Buchungen ohne Kategorie). Sollen auch sie umgestellt werden, eine eigene Zeile anlegen – z. B. mit der Mandatsreferenz des zweiten Vertrags.</p>` : '';
  })() : ''}
      ${list ? `<details class="z-split-preview" open><summary>Vorschau: ${list.length} Buchung${list.length === 1 ? '' : 'en'}</summary><div class="table-wrap"><table><tbody>${preview}</tbody></table></div></details>` : ''}
      <script type="application/json" data-hints>${JSON.stringify(hints).replace(/</g, '\\u003c')}</script>
    </div>`;
  }
  /** Eingaben des offenen Editors in den Entwurf übernehmen (vor jedem Neuzeichnen). */
  function readDraft(key) {
    const box = [...view.querySelectorAll('[data-split-box]')].find((x) => x.dataset.splitBox === key);
    const d = drafts.get(key);
    if (!box || !d) return d;
    box.querySelectorAll('[data-line]').forEach((row) => {
      const x = d.lines[Number(row.dataset.line)];
      if (!x) return;
      x.field = row.querySelector('[data-sf="field"]').value;
      x.value = row.querySelector('[data-sf="value"]').value;
      x.category = row.querySelector('[data-sf="category"]').value;
    });
    d.keep = box.querySelector('[data-split-keep]').value === 'keep';
    const rest = box.querySelector('[data-split-rest]');
    if (rest) d.rest = rest.value;
    return d;
  }

  /** Buchungen eines aufgeklappten Händlers: Datum, Text, Betrag, Kategorie samt Herkunft – einzeln änderbar. */
  function txBlock(key) {
    if (!openKeys.has(key)) return '';
    const b = bookings.get(key);
    if (b === 'laden' || b === undefined) return `<div class="z-txs">${skeleton(2)}</div>`;
    if (typeof b === 'string') return `<div class="z-txs"><div class="empty">Konnte nicht geladen werden: ${esc(b)}</div></div>`;
    const herkunft = (t) => (t.ffd_quelle === 'firefly' ? '<span class="badge" title="Kategorie steht so in Firefly">Firefly</span>' : t.ffd_quelle ? quelle(t.ffd_quelle) : '<span class="badge warn">offen</span>');
    const text = (t) => [t.description, t.notes && t.notes !== t.description ? t.notes : ''].filter(Boolean).join(' · ');
    const m = data.automatisch.find((x) => x.key === key);
    const origin = m?.quelle && QUELLE_INFO[m.quelle] ? `<p class="z-origin"><b>Woher kommt „${esc(m.category || '')}“?</b> ${esc(QUELLE_INFO[m.quelle])}${m.quelle === 'gelernt' ? ' Welche das sind, zeigen die Zeilen mit „Firefly“.' : ''}</p>` : '';
    return `<div class="z-txs" data-txs="${esc(key)}">
      ${origin}
      ${b.anzahl > b.buchungen.length ? `<p class="muted">Die neuesten ${b.buchungen.length} von ${b.anzahl} Buchungen.</p>` : ''}
      <div class="table-wrap"><table><tbody>${b.buchungen.map((t, i) => `<tr ${txAttrs(`${key}|${i}`)}>
        <td class="date">${fmtDate(t.date)}</td>
        <td><div class="desc">${esc(text(t).slice(0, 160))}</div><div class="flow">${esc(t.source_name || '')} → ${esc(t.destination_name || '')}</div></td>
        <td class="num">${signedAmount(t)}</td>
        <td class="z-tx-cat">${t.category_name ? `<span class="cat">${esc(t.category_name)}</span> ` : ''}${herkunft(t)}
          ${t.ffd_quelle === 'firefly' ? '' : `<form class="z-form z-tx-form" data-tx-assign="${esc(t.transaction_journal_id)}" data-key="${esc(key)}">${catInput('', 'name="category" required')}<button class="btn small" type="submit" title="Nur diese eine Buchung – der Händler bleibt, wie er ist">nur diese</button>
            ${t.ffd_quelle === 'buchung' ? `<button class="link-btn" type="button" data-tx-reset="${esc(t.transaction_journal_id)}" data-key="${esc(key)}">zurücksetzen</button>` : ''}</form>`}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="muted small-text">Zeile anklicken: alle Angaben der Buchung und „In Firefly öffnen“. „nur diese“ ordnet eine einzelne Buchung zu, z. B. eine PayPal-Zahlung ohne Händlerangabe.</p>
    </div>`;
  }
  async function loadBookings(key, fresh = false) {
    if (bookings.has(key) && !fresh) return render(); // schon geladen: nur wieder anzeigen
    bookings.set(key, 'laden');
    render();
    try {
      const r = await fetch(`/local/autocat?haendler=${encodeURIComponent(key)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
      bookings.set(key, body);
    } catch (err) {
      bookings.set(key, err.message);
    }
    render();
  }

  function render() {
    const code = data.waehrung;
    const s = data.summen;
    const total = s.firefly + s.automatisch + s.offen || 1;
    const part = (v) => percent(v / total);
    const seg = (v, cls, label) => (v > 0 ? `<span class="${cls}" style="width:${(v / total) * 100}%" title="${esc(label)}: ${esc(money(v, code))}"></span>` : '');
    $('z-cover').innerHTML = `
      <div class="z-head"><h2>Abdeckung der Ausgaben</h2><span class="muted">${fmtDate(data.zeitraum.von, { month: 'short', year: 'numeric' })} – heute</span></div>
      <div class="z-bar" role="img" aria-label="Anteil der Ausgaben mit Kategorie">${seg(s.firefly, 'z-ff', 'Kategorie aus Firefly')}${seg(s.automatisch, 'z-au', 'automatisch zugeordnet')}${seg(s.offen, 'z-of', 'noch offen')}</div>
      <div class="z-legend">
        <span><i class="z-ff"></i>Kategorie aus Firefly <b>${part(s.firefly)}</b> <span class="muted">${money(s.firefly, code)}</span></span>
        <span><i class="z-au"></i>Automatisch zugeordnet <b>${part(s.automatisch)}</b> <span class="muted">${money(s.automatisch, code)}</span></span>
        <span><i class="z-of"></i>Noch offen <b>${part(s.offen)}</b> <span class="muted">${money(s.offen, code)}</span></span>
      </div>
      <p class="muted z-note">Buchungen ohne Kategorie in Firefly bekommen hier automatisch eine – aus dem Händler abgeleitet. Sie zählen damit in der Übersicht,
        unter Kategorien, im Jahresrückblick und bei „Fragen“ mit (z. B. Netto, Aldi und Lidl zusammen unter „Lebensmittel“). Firefly selbst bleibt unverändert;
        automatisch Zugeordnetes ist in den Buchungsdetails als „automatisch“ markiert.
        ${data.einstellungen.enabled ? '' : '<b>Die automatische Zuordnung ist gerade abgeschaltet.</b>'}</p>
      <datalist id="z-cats">${data.kategorien.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;

    // ---- offen ----
    $('z-open-meta').textContent = data.offenAnzahl ? `${data.offenAnzahl} Händler · ${money(s.offen, code)}` : 'alles zugeordnet';
    $('z-open').innerHTML = data.offen.length ? `
      <p class="muted" style="margin-top:0">Größte zuerst. Eine Zuordnung gilt für alle Buchungen dieses Händlers – auch für künftige.</p>
      <div class="list z-list">${data.offen.slice(0, shownOpen).map((m) => `<div class="row z-row" data-key="${esc(m.key)}">
        <div style="min-width:0"><div class="title">${esc(m.name)}</div>
          <div class="subtitle"><button class="link-btn z-show" type="button" data-show="${esc(m.key)}" aria-expanded="${openKeys.has(m.key)}">${openKeys.has(m.key) ? '▾' : '▸'} ${m.n} Buchung${m.n === 1 ? '' : 'en'} ansehen</button> · zuletzt ${fmtDate(m.last)}${m.beispiel ? ` · ${esc(m.beispiel)}` : ''}</div>${mixedNote(m)}</div>
        <div class="amount">${money(m.offen, code)}</div>
        ${m.key ? `<form class="z-form" data-assign="${esc(m.key)}" data-name="${esc(m.name)}">${catInput('', 'name="category" required')}<button class="btn primary small" type="submit">Zuordnen</button></form>`
    : '<div class="muted z-form">kein Händler erkennbar – Buchungen ansehen und einzeln zuordnen</div>'}
      </div>${txBlock(m.key)}`).join('')}</div>
      ${data.offen.length > shownOpen ? `<button class="btn" id="z-open-more" style="margin-top:12px">Weitere ${Math.min(40, data.offen.length - shownOpen)} zeigen</button>` : ''}`
      : '<div class="empty">Alle Ausgaben der letzten 24 Monate haben eine Kategorie. 🎉</div>';

    // ---- automatisch: standardmäßig nur, was du noch nicht bestätigt oder geändert hast ----
    // erledigt: deine Zuordnung für den Händler – oder alle seine Buchungen einzeln zugeordnet („nur diese“)
    const done = (m) => m.fest || m.nurEinzeln;
    const todo = data.automatisch.filter((m) => !done(m));
    const fest = data.automatisch.filter(done);
    const autoList = autoFilter === 'fest' ? fest : autoFilter === 'alle' ? data.automatisch : todo;
    const onlyHere = fest.filter((m) => m.fest && m.cond && m.category && !UP_TO_DATE(m) && !m.gemischt);
    const ffState = (m) => (!m.cond ? '' : UP_TO_DATE(m) ? '<span class="badge good" title="Als Regel in Firefly">in Firefly</span>'
      : m.ff?.sentAt ? '<span class="badge warn" title="In Firefly steht noch eine andere Kategorie">Firefly: geändert</span>'
      : m.fest ? '<span class="badge" title="Gilt bisher nur im Dashboard – vorgemerkt unter „In Firefly übernehmen“">nur Dashboard</span>' : '');
    $('z-auto-meta').textContent = data.automatisch.length ? `${todo.length} zu prüfen · ${fest.length} bestätigt · ${money(s.automatisch, code)}` : '';
    $('z-auto').innerHTML = data.automatisch.length ? `
      <div class="chips z-auto-filter" role="group" aria-label="Anzeigen">
        <button type="button" class="chip" data-auto-filter="pruefen" aria-pressed="${autoFilter === 'pruefen'}">Zu prüfen ${todo.length}</button>
        <button type="button" class="chip" data-auto-filter="fest" aria-pressed="${autoFilter === 'fest'}">Von dir bestätigt ${fest.length}</button>
        <button type="button" class="chip" data-auto-filter="alle" aria-pressed="${autoFilter === 'alle'}">Alle ${data.automatisch.length}</button>
      </div>
      <p class="muted" style="margin-top:8px">${autoFilter === 'fest'
    ? 'Deine Zuordnungen – sie haben Vorrang vor Regeln, Händlerliste und KI.'
    : 'Passt die Kategorie? „✓ Passt“ bestätigt sie, sonst ändern. Bestätigte und geänderte verschwinden aus dieser Liste (zu finden unter „Von dir bestätigt“).'}</p>
      ${onlyHere.length ? `<p class="z-ff-hint">${onlyHere.length === 1 ? 'Eine deiner Zuordnungen gilt' : `${onlyHere.length} deiner Zuordnungen gelten`} bisher nur im Dashboard – für Firefly vorgemerkt (angehakt) unter <button type="button" class="link-btn" data-goto-ff>In Firefly übernehmen ↓</button></p>` : ''}
      ${autoList.length ? `<div class="list z-list">${autoList.slice(0, shownAuto).map((m) => `<div class="row z-row" data-key="${esc(m.key)}">
        <div style="min-width:0"><div class="title">${esc(m.name)} ${quelle(m.quelle)} ${ffState(m)}</div>
          <div class="subtitle"><button class="link-btn z-show" type="button" data-show="${esc(m.key)}" aria-expanded="${openKeys.has(m.key)}">${openKeys.has(m.key) ? '▾' : '▸'} ${m.n} Buchung${m.n === 1 ? '' : 'en'} ansehen</button> · zuletzt ${fmtDate(m.last)}${m.beispiel ? ` · ${esc(m.beispiel)}` : ''}</div>${mixedNote(m)}</div>
        <div class="amount">${money(m.auto, code)}</div>
        ${m.key ? `<form class="z-form" data-assign="${esc(m.key)}" data-name="${esc(m.name)}">${catInput(mainCat(m), `name="category" required${m.split ? ' title="Kategorie für alle übrigen Buchungen (sonst)"' : ''}`)}<button class="btn small" type="submit">Ändern</button>
          ${!m.fest && m.category && m.quelle !== 'buchung' ? `<button class="btn small primary" type="button" data-ok="${esc(m.key)}" data-name="${esc(m.name)}" data-category="${esc(m.category)}" title="Kategorie bestätigen – gilt dann als deine Zuordnung">✓ Passt</button>` : ''}
          ${m.cond ? `<button class="link-btn" type="button" data-split="${esc(m.key)}" title="Unterschiedliche Kategorien je nach Buchungstext, z. B. Kfz- und Familienversicherung beim selben Versicherer">${splitOpen.has(m.key) ? 'Aufteilen schließen' : 'aufteilen'}</button>` : ''}
          ${m.fest ? `<button class="link-btn" type="button" data-reset="${esc(m.key)}" title="Deine Zuordnung entfernen – dann gelten wieder Regeln, Händlerliste und KI">zurücksetzen</button>` : ''}</form>` : '<div class="z-form"></div>'}
        ${m.split ? `<div class="z-split-sum">Aufgeteilt: ${m.split.map((x) => `${x.field === 'notes' ? 'Notiz' : 'Text'} enthält „${esc(x.value)}“ → <b>${esc(x.category)}</b>`).join(' · ')} · sonst ${m.festKeep ? '<b>bleibt die vorhandene Kategorie</b>' : `→ <b>${esc(mainCat(m) || '–')}</b>`}</div>` : ''}
      </div>${splitBlock(m)}${txBlock(m.key)}`).join('')}</div>
      ${autoList.length > shownAuto ? `<button class="btn" id="z-auto-more" style="margin-top:12px">Weitere ${Math.min(40, autoList.length - shownAuto)} zeigen</button>` : ''}`
    : `<div class="empty">${autoFilter === 'pruefen' ? 'Alles geprüft. 🎉' : 'Noch nichts bestätigt.'}</div>`}`
      : '<div class="empty">Noch nichts automatisch zugeordnet.</div>';

    // Buchungszeilen aufklappbar (Details, „In Firefly öffnen“, Ausblenden)
    try { view.querySelectorAll('[data-txs]').forEach((box) => bindTxDetails(box, (k) => {
      const [key, i] = [k.slice(0, k.lastIndexOf('|')), Number(k.slice(k.lastIndexOf('|') + 1))];
      const b = bookings.get(key);
      return b && typeof b === 'object' ? b.buchungen[i] : null;
    })); } catch (err) { console.error(err); }

    renderFirefly();

    // ---- Einstellungen ----
    const e = data.einstellungen;
    const q = s.quellen;
    const check = (key, label, hint, sum) => `<label class="check z-opt"><input type="checkbox" data-opt="${key}" ${e[key] ? 'checked' : ''}${key !== 'enabled' && !e.enabled ? ' disabled' : ''}>
      <span><b>${label}</b>${sum !== undefined ? ` <span class="muted">· ${money(sum, code)}</span>` : ''}<br><span class="muted">${hint}</span></span></label>`;
    const p = data.pruefung;
    $('z-set').innerHTML = `
      ${check('enabled', 'Automatische Zuordnung', 'Aus: Buchungen ohne Firefly-Kategorie bleiben „ohne Kategorie“.')}
      <div class="z-opts">
        <div class="z-opt muted"><b>1. Deine Zuordnungen</b> · ${money(q.zuordnung + q.buchung, code)}<br>${e.assigned} Händler${e.assignedTx ? ` und ${e.assignedTx} einzelne Buchung${e.assignedTx === 1 ? '' : 'en'}` : ''} von dir zugeordnet (oben) – gelten immer zuerst.</div>
        <div class="z-opt muted"><b>2. Deine Regeln</b> · ${money(q.regel, code)}<br>Regeln aus dem <a href="#/labor?tab=regeln">Labor</a> mit „Kategorie setzen“.</div>
        <div class="z-opt muted"><b>3. Deine Import-Zuordnung</b> · ${money(q.import, code)}<br>${e.importRules
    ? `${e.importRules} Einträge aus der Übersetzungstabelle „Händler → Kategorie“ deiner Data-Importer-Konfiguration – greifen auch für Buchungen, die beim Import noch keine Kategorie bekamen (z. B. Händler hinter PayPal).`
    : 'Keine Import-Konfiguration hinterlegt. Unter <a href="#/aufraeumen">Aufräumen</a> die JSON des Data Importers hochladen – dann gilt deine Tabelle „Händler → Kategorie“ auch hier.'}</div>
        ${check('learn', '4. Aus deinen Buchungen lernen', 'Händler, der in Firefly sonst eindeutig kategorisiert ist (mind. 2 Buchungen, 60 % gleiche Kategorie).', q.gelernt)}
        ${check('list', '5. Händlerliste', 'Bekannte Händler: Aldi, Lidl, Netto, Rewe → Lebensmittel; Aral, Shell → Mobilität; Telekom → Nebenkosten usw.', q.liste)}
        ${check('ai', '6. KI-Bewertung', `Ergebnisse der <a href="#/labor?tab=ki">KI-Analyse</a> ab <select data-opt-min ${e.enabled && e.ai ? '' : 'disabled'}>${[50, 70, 80, 90].map((v) => `<option value="${v}"${v === e.aiMin ? ' selected' : ''}>${v} %</option>`).join('')}</select> Sicherheit – nur für Händler, die sonst niemand kennt.`, q.ki)}
      </div>
      <div class="z-check ${p ? (p.ok ? 'good' : 'bad') : 'muted'}">${p
    ? (p.ok ? `Selbstprüfung ✓ – die Summen des Dashboards stimmen mit Firefly überein (${p.months.map((m) => fmtDate(`${m.monat}-01`, { month: 'long', year: 'numeric' })).join(', ')}; geprüft ${fmtDate(p.at)}).`
      : `Selbstprüfung: Abweichung zu Firefly – ${p.months.flatMap((m) => m.checks.filter((c) => !c.ok).map((c) => `${fmtDate(`${m.monat}-01`, { month: 'short', year: 'numeric' })} ${c.art}: Dashboard ${money(c.dashboard, c.waehrung)}, Firefly ${money(c.firefly, c.waehrung)}${c.kategorienAbweichend ? `, ${c.kategorienAbweichend} Kategorien` : ''}`)).join(' · ')}. Bitte melden.`)
    : 'Selbstprüfung läuft nach dem ersten Vorladen (vergleicht die eigenen Summen mit Firefly).'}
        <button class="link-btn" id="z-recheck">jetzt prüfen</button></div>`;
  }

  /** Einzelne Buchung zuordnen: Übersicht und die Buchungsliste des Händlers kommen in einem Rutsch zurück. */
  async function updateTx(key, body) {
    try {
      const res = await call('POST', { ...body, haendler: key });
      bookings.set(key, res.buchungen);
      data = res;
      api.forget();
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  async function update(promise) {
    try {
      bookings.clear(); // Kategorien der Buchungen können sich geändert haben
      data = await promise;
      openKeys.forEach((key) => loadBookings(key, true));
      api.forget(); // Summen und Listen der anderen Seiten ändern sich
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  view.addEventListener('submit', (e) => {
    const one = e.target.closest('[data-tx-assign]');
    if (one) {
      e.preventDefault();
      const category = new FormData(one).get('category').trim();
      if (!category) return;
      one.querySelector('button').disabled = true;
      return updateTx(one.dataset.key, { journal: one.dataset.txAssign, category });
    }
    const form = e.target.closest('[data-assign]');
    if (!form) return;
    e.preventDefault();
    const category = new FormData(form).get('category').trim();
    if (!category) return;
    form.querySelector('button').disabled = true;
    const m = data.automatisch.find((x) => x.key === form.dataset.assign);
    update(call('POST', { key: form.dataset.assign, name: form.dataset.name, category, ...(m?.split ? { split: m.split } : {}) }));
  });
  view.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.reset) return update(call('POST', { key: t.dataset.reset, category: null }));
    if (t.dataset.edit) return editMerchant(t.dataset.edit);
    if (t.dataset.split) {
      const key = t.dataset.split;
      if (splitOpen.has(key)) {
        splitOpen.delete(key);
        return render();
      }
      const m = data.automatisch.find((x) => x.key === key);
      drafts.set(key, { lines: (m.split || []).map((x) => ({ ...x })), rest: m.festKeep ? '' : mainCat(m) || '', keep: Boolean(m.festKeep) });
      if (!drafts.get(key).lines.length) drafts.get(key).lines.push({ field: 'description', value: '', category: '' });
      splitOpen.add(key);
      render();
      return loadBookings(key);
    }
    const box = t.closest('[data-split-box]');
    if (box) {
      const key = box.dataset.splitBox;
      const d = readDraft(key);
      if (t.dataset.splitAdd !== undefined) {
        d.lines.push({ field: 'description', value: '', category: '' });
        return render();
      }
      if (t.dataset.splitDel !== undefined) {
        d.lines.splice(Number(t.dataset.splitDel), 1);
        return render();
      }
      if (t.dataset.splitHint !== undefined) {
        const h = JSON.parse(box.querySelector('[data-hints]').textContent)[Number(t.dataset.splitHint)];
        const empty = d.lines.find((x) => !x.value.trim());
        if (empty) Object.assign(empty, { field: h.field, value: h.value });
        else d.lines.push({ field: h.field, value: h.value, category: '' });
        return render();
      }
      if (t.dataset.splitSave) {
        const lines = d.lines.filter((x) => x.value.trim().length >= 2 && x.category.trim());
        if (!d.keep && !d.rest.trim()) return alert('Bitte eine Kategorie für „sonst“ eintragen – oder „vorhandene Kategorie beibehalten“ wählen.');
        if (!lines.length) return alert('Bitte mindestens eine Unterscheidung mit Text und Kategorie eintragen.');
        splitOpen.delete(key);
        return update(call('POST', { key, name: t.dataset.name, category: d.keep ? '' : d.rest.trim(), split: lines, keep: d.keep }));
      }
      if (t.dataset.splitClear) {
        splitOpen.delete(key);
        return update(call('POST', { key, name: t.dataset.name, category: d.rest.trim() || mainCat(data.automatisch.find((x) => x.key === key)), split: [] }));
      }
    }
    if (t.dataset.ffView) {
      ffView = t.dataset.ffView;
      store('ffd-z-ff-view', ffView);
      return renderFirefly();
    }
    if (t.dataset.ok) {
      t.disabled = true;
      return update(call('POST', { key: t.dataset.ok, name: t.dataset.name, category: t.dataset.category }));
    }
    if (t.dataset.autoFilter) {
      autoFilter = t.dataset.autoFilter;
      store('ffd-z-auto', autoFilter);
      shownAuto = 40;
      return render();
    }
    if (t.dataset.gotoFf !== undefined) {
      const sec = $('z-ff').closest('.card');
      if (sec.classList.contains('folded')) setFolded(sec, false); // zugeklappte Karte wirkt sonst leer
      return sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (t.id === 'z-ff-send') {
      fixAllNote = false;
      const list = ffCandidates().filter((m) => ffPick.has(m.key));
      const mixed = list.filter((m) => m.gemischt);
      if (mixed.length && !window.confirm(`Achtung: Hinter ${mixed.map((m) => m.name).join(', ')} stecken vermutlich verschiedene Händler (in Firefly verschiedene Kategorien). Die Regel gibt künftig allen Buchungen ohne Kategorie bei diesem Empfänger dieselbe Kategorie. Trotzdem übertragen?`)) return;
      if (!list.length) return;
      const overwrite = ffOverwrite && editAction && ffRange !== 'none';
      return (async () => {
        // Vorher zählen, welche Buchungen schon eine andere Kategorie haben – die stellt das Dashboard direkt um
        let change = [];
        if (overwrite) {
          ffBusy = 'Suche Buchungen, die in Firefly eine andere Kategorie haben …';
          ffNote = '';
          renderFirefly();
          try {
            change = (await call('POST', { ueberschreiben: { monate: ffRange, items: list.map((m) => ({ key: m.key, category: ffCat(m), split: m.split || [], keep: Boolean(m.festKeep) })) } })).buchungen;
          } catch (err) {
            ffNote = `<span class="bad">${esc(err.message)}</span>`;
            return renderFirefly();
          } finally {
            ffBusy = '';
            renderFirefly();
          }
        }
        const pairs = changeSummary(change);
        const overText = !overwrite ? '' : change.length
          ? `\n\nAußerdem ${change.length} Buchung${change.length === 1 ? '' : 'en'} mit anderer Kategorie umstellen:\n${pairs.slice(0, 8).map(([k, n]) => `• ${k} (${n}×)`).join('\n')}${pairs.length > 8 ? '\n…' : ''}`
          : '\n\nBuchungen mit anderer Kategorie: keine gefunden.';
        if (!window.confirm(`${list.length} Regel${list.length === 1 ? '' : 'n'} „Händler → Kategorie“ in Firefly anlegen${ffRange === 'none' ? '' : ' und auf vorhandene Ausgaben ohne Kategorie anwenden'}?${overText}`)) return;
        return ffDo('Übertrage nach Firefly … (rückwirkend anwenden kann ein paar Minuten dauern)', async () => {
          const res = await call('POST', { ff: { add: list.map((m) => ({ key: m.key, name: m.name, category: ffCat(m), cond: m.cond, split: m.split || [], keep: Boolean(m.festKeep) })) } });
          await sendRules(res.firefly);
          await call('POST', { ff: { sent: true } });
          list.forEach((m) => ffPick.delete(m.key));
          let fail = '';
          if (change.length) {
            fail = `<br>${overwriteReport(await overwriteExisting(change), 'vorhandene Kategorien')}`;
          }
          if (ffRange !== 'none') refreshLater();
          return `<span class="good">✓ ${res.firefly.length} Regel${res.firefly.length === 1 ? '' : 'n'} in Firefly (Gruppe „${esc(FF_GROUP)}“)${ffRange === 'none' ? '' : '. Firefly wendet die Regeln jetzt auf Buchungen ohne Kategorie an – das kann ein paar Minuten dauern; die Listen aktualisieren sich von selbst'}.</span>${fail}`;
        });
      })();
    }
    if (t.dataset.ffOverOne || t.id === 'z-ff-fix-all' || t.id === 'z-ff-fix-picked') {
      // eine Zeile („… jetzt setzen“), alle übertragenen Händler, bei denen in Firefly noch etwas fehlt, oder die angehakten
      const picked = t.id === 'z-ff-fix-picked';
      const all = t.id === 'z-ff-fix-all' || picked;
      fixAllNote = t.id === 'z-ff-fix-all';
      const fs = picked ? ffCandidates().filter((m) => ffPick.has(m.key)).map((m) => ({ key: m.key, name: m.name, category: ffCat(m), split: m.split || [], keep: Boolean(m.festKeep) }))
        : all ? ffFixable() : data.firefly.filter((x) => x.key === t.dataset.ffOverOne);
      if (!fs.length) return;
      const label = all ? `${fs.length} Händler${fs.length === 1 ? '' : 'n'}` : fs[0].name;
      return (async () => {
        ffBusy = all ? `Suche Buchungen von ${label}, die in Firefly nicht die zugeordnete Kategorie haben …` : `Suche Buchungen von ${label}, die in Firefly nicht „${fs[0].category || 'wie zugeordnet'}“ haben …`;
        ffNote = '';
        renderFirefly();
        let change;
        try {
          change = (await call('POST', { ueberschreiben: { ohne: all || t.dataset.ohne === '1', monate: ffRange === '24' ? '24' : 'all', items: fs.map((f) => ({ key: f.key, category: f.category, split: f.split || [], keep: Boolean(f.keep) })) } })).buchungen;
        } catch (err) {
          ffNote = `<span class="bad">${esc(err.message)}</span>`;
          change = null;
        }
        ffBusy = '';
        renderFirefly();
        if (!change) return;
        if (!change.length) {
          ffNote = 'Keine passenden Buchungen gefunden (einzeln zugeordnete und ausgeblendete zählen nicht).';
          return renderFirefly();
        }
        const pairs = changeSummary(change);
        if (!window.confirm(`${label}: ${change.length} Buchung${change.length === 1 ? '' : 'en'} in Firefly setzen?\n${pairs.slice(0, 10).map(([k, n]) => `• ${k} (${n}×)`).join('\n')}${pairs.length > 10 ? `\n… und ${pairs.length - 10} weitere` : ''}`)) return;
        return ffDo('Setze die Kategorien in Firefly …', async () => overwriteReport(await overwriteExisting(change), `Buchung${change.length === 1 ? '' : 'en'}${all ? '' : ` von ${esc(label)}`}`));
      })();
    }
    if (t.dataset.ffRemove) {
      fixAllNote = false;
      return ffDo('Entferne die Regel in Firefly …', async () => {
        const res = await call('POST', { ff: { remove: [t.dataset.ffRemove] } });
        await sendRules(res.firefly.filter((f) => f.sentAt));
        return 'Regel in Firefly entfernt – bereits gesetzte Kategorien bleiben.';
      });
    }
    if (t.id === 'z-ff-single') {
      fixAllNote = false;
      const list = data.einzeln;
      if (!window.confirm(`${list.length} Buchung${list.length === 1 ? '' : 'en'} in Firefly kategorisieren?`)) return;
      return ffDo(`Setze ${list.length} Kategorie${list.length === 1 ? '' : 'n'} in Firefly …`, async () => {
        let ok = 0;
        for (const tx of list) {
          const res = await setCategory(editAction, tx, tx.ffd_ziel).catch(() => ({ ok: false }));
          if (res.ok) ok += 1;
        }
        return ok === list.length ? `<span class="good">✓ ${ok} Buchung${ok === 1 ? '' : 'en'} in Firefly kategorisiert.</span>` : `<span class="bad">${ok} von ${list.length} gesetzt – Rest bitte erneut versuchen.</span>`;
      });
    }
    if (t.dataset.show !== undefined) {
      const key = t.dataset.show;
      if (openKeys.has(key)) {
        openKeys.delete(key);
        return render();
      }
      openKeys.add(key);
      return loadBookings(key);
    }
    if (t.dataset.txReset) return updateTx(t.dataset.key, { journal: t.dataset.txReset, category: null });
    if (t.id === 'z-open-more') {
      shownOpen += 40;
      return render();
    }
    if (t.id === 'z-auto-more') {
      shownAuto += 40;
      return render();
    }
    if (t.id === 'z-recheck') {
      t.disabled = true;
      t.textContent = 'prüfe …';
      await fetch('/local/ledger?pruefen=1').catch(() => {});
      return update(call('GET'));
    }
  });
  // Aufteilen: jede Eingabe sofort in den Entwurf (übersteht Neuzeichnen, z. B. wenn die Buchungen nachladen)
  view.addEventListener('input', (e) => {
    const box = e.target.closest('[data-split-box]');
    if (box) readDraft(box.dataset.splitBox);
  });
  view.addEventListener('change', (e) => {
    // Aufteilen: Vorschau und Trefferzahlen nach jeder Eingabe neu
    if (e.target.closest('[data-split-box]') && (e.target.matches('[data-sf], [data-split-rest], [data-split-keep]'))) {
      readDraft(e.target.closest('[data-split-box]').dataset.splitBox);
      return render();
    }
    if (e.target.dataset.ff) {
      if (e.target.checked) ffPick.add(e.target.dataset.ff);
      else ffPick.delete(e.target.dataset.ff);
      return renderFirefly();
    }
    if (e.target.id === 'z-ff-all') {
      // nur die angezeigten (Status, Quelle und Filterfeld)
      $('z-ff').querySelectorAll('tbody tr:not([hidden]) input[data-ff]').forEach((i) => (e.target.checked ? ffPick.add(i.dataset.ff) : ffPick.delete(i.dataset.ff)));
      return renderFirefly();
    }
    if (e.target.matches('[data-ff-source]')) {
      ffSource = e.target.value;
      return renderFirefly();
    }
    if (e.target.matches('[data-ff-range]')) {
      ffRange = e.target.value;
      return renderFirefly();
    }
    if (e.target.matches('[data-ff-over]')) {
      ffOverwrite = e.target.checked;
      store('ffd-z-ff-over', ffOverwrite ? '1' : '');
      return;
    }
    if (e.target.dataset.opt) return update(call('PUT', { [e.target.dataset.opt]: e.target.checked }));
    if (e.target.matches('[data-opt-min]')) return update(call('PUT', { aiMin: Number(e.target.value) }));
  });

  try {
    [data, rulesAction, editAction] = await Promise.all([call('GET'), actionFor('rules').catch(() => null), actionFor('categorize').catch(() => null)]);
    if (view.isConnected) render();
  } catch (err) {
    $('z-cover').innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
    ['z-open', 'z-auto', 'z-set'].forEach((id) => ($(id).innerHTML = ''));
  }
}
