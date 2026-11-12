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
  let ffView = storage('ffd-z-ff-view', 'offen'); // offen | angehakt | firefly | alle
  let ffSource = ''; // Quelle oder '' = alle
  let ffNote = '';
  let ffBusy = '';
  let data;
  let shownOpen = 40;
  let shownAuto = 40;
  let autoFilter = storage('ffd-z-auto', 'pruefen'); // pruefen | fest | alle
  const openKeys = new Set(); // aufgeklappte Händler (Buchungen sichtbar)
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
  const UP_TO_DATE = (m) => m.ff && m.ff.sentAt && m.ff.category === m.category;
  const ffCandidates = () => data.automatisch.filter((m) => m.cond && m.category && m.quelle !== 'buchung');
  /** Karte „In Firefly übernehmen“ – ein Fehler darin zeigt sich in der Karte, statt sie leer zu lassen. */
  function renderFirefly() {
    try {
      renderFireflyCard();
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
      if (!UP_TO_DATE(m) && m.quelle === 'zuordnung') ffPick.add(m.key); // nur, was du selbst bestätigt/zugeordnet hast
      else ffPick.delete(m.key);
    }
    const keys = new Set(cands.map((m) => m.key));
    const elsewhere = data.firefly.filter((f) => !keys.has(f.key)); // übertragen – Firefly hat die Buchungen inzwischen kategorisiert
    const sent = data.firefly.filter((f) => f.sentAt).length;
    const marked = cands.filter((m) => ffPick.has(m.key)).length;
    $('z-ff-meta').textContent = [marked ? `${marked} vorgemerkt` : '', sent ? `${sent} Regel${sent === 1 ? '' : 'n'} in Firefly` : ''].filter(Boolean).join(' · ');
    const status = (m) => (UP_TO_DATE(m) ? '<span class="badge good">in Firefly</span>'
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
        sie greifen bei künftigen Importen und auf Wunsch rückwirkend, <b>nur bei Ausgaben ohne Kategorie</b> (vorhandene Kategorien bleiben).
        Danach stehen die Kategorien in Firefly selbst.</p>
      ${ffNote ? `<div class="cm-note">${ffNote}</div>` : ''}
      ${!rulesAction ? `<div class="cm-note"><b>Zum Übertragen fehlt die Automation „Firefly-Regeln anlegen“.</b> Unter <a href="#/automationen">Automationen</a> eine Automation mit diesem Auslöser einrichten (Vorlage n8n/firefly-buchung-bearbeiten.json, dieselbe wie für „Kategorie übernehmen“ – nur der Auslöser ist ein anderer).</div>
        ${cands.length ? `<p class="muted">Vorgemerkt sind deine bestätigten Zuordnungen (${[...ffPick].filter((k) => keys.has(k)).length} von ${cands.length} Händlern):</p><ul class="z-ff-plain">${cands.filter((m) => ffPick.has(m.key)).slice(0, 50).map((m) => `<li>${esc(m.name)} → ${esc(m.category)} ${quelle(m.quelle)} <button type="button" class="link-btn" data-edit="${esc(m.key)}">bearbeiten</button></li>`).join('')}</ul>` : ''}` : `
      ${cands.length ? `${filterBar}${shown.length ? `<div class="table-wrap z-ff-table"><table><thead><tr><th class="pick-cell"><input type="checkbox" id="z-ff-all" aria-label="alle angezeigten auswählen" title="alle angezeigten"></th><th>Händler</th><th>Kategorie</th><th class="num hide-sm">24 Monate</th></tr></thead>
        <tbody>${shown.map((m) => `<tr style="cursor:default">
          <td class="pick-cell"><input type="checkbox" data-ff="${esc(m.key)}" ${ffPick.has(m.key) ? 'checked' : ''} aria-label="${esc(m.name)}"></td>
          <td><div class="desc">${esc(m.name)} ${status(m)}</div><div class="flow">${quelle(m.quelle)} <button type="button" class="link-btn" data-edit="${esc(m.key)}">bearbeiten</button> · ${esc(m.cond.field === 'party' ? 'Empfänger' : m.cond.field === 'notes' ? 'Notizen' : 'Beschreibung')} ${m.cond.op === 'equals' ? 'ist' : 'enthält'} „${esc(m.cond.value)}“</div></td>
          <td>${esc(m.category)}</td>
          <td class="num hide-sm">${money(m.auto, data.waehrung)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Keine Händler in dieser Auswahl.</div>'}
        <div class="z-ff-actions">
          <label>rückwirkend anwenden <select class="input select" data-ff-range>
            <option value="all"${ffRange === 'all' ? ' selected' : ''}>alle Buchungen ohne Kategorie</option>
            <option value="24"${ffRange === '24' ? ' selected' : ''}>letzte 24 Monate</option>
            <option value="none"${ffRange === 'none' ? ' selected' : ''}>nein, nur künftige Importe</option></select></label>
          <button class="btn primary" type="button" id="z-ff-send"${n && !ffBusy ? '' : ' disabled'}>${n} als Regel${n === 1 ? '' : 'n'} nach Firefly</button>
        </div>
        <p class="muted small-text">Angehakt sind nur deine bestätigten Zuordnungen („✓ Passt“ oder geändert). Andere (Händlerliste, gelernt, Import, KI) erst prüfen – „bearbeiten“ springt zum Händler – oder selbst anhaken. Bereits übertragene Regeln bleiben bestehen; „geändert“ heißt: im Dashboard jetzt eine andere Kategorie – erneut übertragen ändert die Regel.</p>`
    : '<div class="empty">Keine automatischen Zuordnungen mit erkennbarem Händler.</div>'}
      ${elsewhere.length ? `<details class="r-hidden"><summary>${elsewhere.length} Regel${elsewhere.length === 1 ? '' : 'n'} schon in Firefly wirksam (die Buchungen haben dort ihre Kategorie)</summary>
        <ul>${elsewhere.map((f) => `<li>${esc(f.name)} → ${esc(f.category)} <button class="link-btn" type="button" data-ff-remove="${esc(f.key)}">Regel entfernen</button></li>`).join('')}</ul></details>` : ''}
      ${data.einzeln?.length ? `<div class="z-ff-single"><b>${data.einzeln.length} einzeln zugeordnete Buchung${data.einzeln.length === 1 ? '' : 'en'}</b> <span class="muted">(„nur diese“) – dafür gibt es keine Regel; ${editAction ? 'direkt per n8n setzen:' : 'braucht die Automation „Kategorie übernehmen“.'}</span>
        ${editAction ? `<button class="btn small" type="button" id="z-ff-single"${ffBusy ? ' disabled' : ''}>In Firefly setzen</button>` : ''}</div>` : ''}`}
      ${ffBusy ? `<p class="muted">${esc(ffBusy)}</p>` : ''}`;
    const all = $('z-ff').querySelector('#z-ff-all');
    if (all) {
      all.checked = shown.length > 0 && shown.every((m) => ffPick.has(m.key));
      all.indeterminate = !all.checked && shown.some((m) => ffPick.has(m.key));
    }
  }

  /** Alle vorgemerkten Händler als Regeln schicken (die Gruppe wird abgeglichen) und ggf. rückwirkend anwenden. */
  async function sendRules(list) {
    const rules = list.map((f) => ({ id: keyId(f.key), enabled: true, when: [f.cond], setCategory: f.category, addTags: [] }));
    const regeln = toFireflyRules(rules).map((r, k, arr) => ({
      ...r,
      // nur Ausgaben ohne Kategorie – vorhandene Kategorien (auch vom Import) bleiben unangetastet
      triggers: [...r.triggers, { type: 'has_no_category', value: 'true' }, { type: 'transaction_type', value: 'withdrawal' }],
      order: arr.length - k,
      description: `Zuordnen (Dashboard) · id:${r.labor_id}`,
    }));
    const t0 = today();
    const anwenden = ffRange === 'none' ? null
      : { start: ffRange === 'all' ? '2000-01-01' : isoDate(new Date(t0.getFullYear(), t0.getMonth() - 24, 1)), end: isoDate(t0) };
    const res = await runAction(rulesAction, { typ: 'regeln_anlegen', gruppe: FF_GROUP, regeln, anwenden });
    if (!res.ok) throw new Error(`n8n antwortet mit ${res.status || 'Fehler'}: ${String(res.response || '').slice(0, 200)}`);
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
    if (bookings.has(key) && !fresh) return;
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
          <div class="subtitle"><button class="link-btn z-show" type="button" data-show="${esc(m.key)}" aria-expanded="${openKeys.has(m.key)}">${openKeys.has(m.key) ? '▾' : '▸'} ${m.n} Buchung${m.n === 1 ? '' : 'en'} ansehen</button> · zuletzt ${fmtDate(m.last)}${m.beispiel ? ` · ${esc(m.beispiel)}` : ''}</div></div>
        <div class="amount">${money(m.offen, code)}</div>
        ${m.key ? `<form class="z-form" data-assign="${esc(m.key)}" data-name="${esc(m.name)}">${catInput('', 'name="category" required')}<button class="btn primary small" type="submit">Zuordnen</button></form>`
    : '<div class="muted z-form">kein Händler erkennbar – Buchungen ansehen und einzeln zuordnen</div>'}
      </div>${txBlock(m.key)}`).join('')}</div>
      ${data.offen.length > shownOpen ? `<button class="btn" id="z-open-more" style="margin-top:12px">Weitere ${Math.min(40, data.offen.length - shownOpen)} zeigen</button>` : ''}`
      : '<div class="empty">Alle Ausgaben der letzten 24 Monate haben eine Kategorie. 🎉</div>';

    // ---- automatisch: standardmäßig nur, was du noch nicht bestätigt oder geändert hast ----
    const todo = data.automatisch.filter((m) => !m.fest);
    const fest = data.automatisch.filter((m) => m.fest);
    const autoList = autoFilter === 'fest' ? fest : autoFilter === 'alle' ? data.automatisch : todo;
    const onlyHere = fest.filter((m) => m.cond && m.category && !UP_TO_DATE(m));
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
          <div class="subtitle"><button class="link-btn z-show" type="button" data-show="${esc(m.key)}" aria-expanded="${openKeys.has(m.key)}">${openKeys.has(m.key) ? '▾' : '▸'} ${m.n} Buchung${m.n === 1 ? '' : 'en'} ansehen</button> · zuletzt ${fmtDate(m.last)}${m.beispiel ? ` · ${esc(m.beispiel)}` : ''}</div></div>
        <div class="amount">${money(m.auto, code)}</div>
        ${m.key ? `<form class="z-form" data-assign="${esc(m.key)}" data-name="${esc(m.name)}">${catInput(m.category, 'name="category" required')}<button class="btn small" type="submit">Ändern</button>
          ${!m.fest && m.category ? `<button class="btn small primary" type="button" data-ok="${esc(m.key)}" data-name="${esc(m.name)}" data-category="${esc(m.category)}" title="Kategorie bestätigen – gilt dann als deine Zuordnung">✓ Passt</button>` : ''}
          ${m.fest ? `<button class="link-btn" type="button" data-reset="${esc(m.key)}" title="Deine Zuordnung entfernen – dann gelten wieder Regeln, Händlerliste und KI">zurücksetzen</button>` : ''}</form>` : '<div class="z-form"></div>'}
      </div>${txBlock(m.key)}`).join('')}</div>
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
    update(call('POST', { key: form.dataset.assign, name: form.dataset.name, category }));
  });
  view.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.reset) return update(call('POST', { key: t.dataset.reset, category: null }));
    if (t.dataset.edit) return editMerchant(t.dataset.edit);
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
      const list = ffCandidates().filter((m) => ffPick.has(m.key));
      if (!list.length || !window.confirm(`${list.length} Regel${list.length === 1 ? '' : 'n'} „Händler → Kategorie“ in Firefly anlegen${ffRange === 'none' ? '' : ' und auf vorhandene Ausgaben ohne Kategorie anwenden'}?`)) return;
      return ffDo('Übertrage nach Firefly … (rückwirkend anwenden kann ein paar Minuten dauern)', async () => {
        const res = await call('POST', { ff: { add: list.map((m) => ({ key: m.key, name: m.name, category: m.category, cond: m.cond })) } });
        await sendRules(res.firefly);
        await call('POST', { ff: { sent: true } });
        list.forEach((m) => ffPick.delete(m.key));
        return `<span class="good">✓ ${res.firefly.length} Regel${res.firefly.length === 1 ? '' : 'n'} in Firefly (Gruppe „${esc(FF_GROUP)}“)${ffRange === 'none' ? '' : ', auf vorhandene Ausgaben ohne Kategorie angewendet'}.</span>`;
      });
    }
    if (t.dataset.ffRemove) {
      return ffDo('Entferne die Regel in Firefly …', async () => {
        const res = await call('POST', { ff: { remove: [t.dataset.ffRemove] } });
        await sendRules(res.firefly.filter((f) => f.sentAt));
        return 'Regel in Firefly entfernt – bereits gesetzte Kategorien bleiben.';
      });
    }
    if (t.id === 'z-ff-single') {
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
  view.addEventListener('change', (e) => {
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
