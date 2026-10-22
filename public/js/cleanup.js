// Seite „Daten aufräumen“: Vorschläge im Dashboard vorbereiten, anpassen und erst
// per Knopf nach Firefly übertragen. Pläne liegen auf dem Server (gelten auf allen
// Geräten und nach Updates):
//  1) Regeln aus der Import-Konfiguration (JSON des Data Importers): Übersetzungstabelle
//     „Händler → Kategorie“ → Firefly-Regeln (über die Automation „Firefly-Regeln anlegen“)
//  2) Ähnliche Gegenkonten zusammenführen (über die Automation „Kategorie übernehmen“,
//     Firefly verschiebt alle Buchungen eines Kontos in einem Schritt)

import * as api from './api.js';
import { esc, fmtDate, debounce, money } from './util.js';
import { card, skeleton } from './common.js';
import { actionFor, runAction } from './txedit.js';
import { loadHistory } from './check.js';
import { counterpartyOf, toFireflyRules } from './rules.js';
import { analyzeImportConfig, mergeGroups } from './cleanupcore.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const RULE_GROUP = 'Dashboard: Händler → Kategorie (Import)';
const lower = (s) => String(s ?? '').trim().toLowerCase();
const post = (url, body, method = 'POST') => fetch(url, { method, headers, body: JSON.stringify(body) }).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
  return d;
});

export async function cleanup(view) {
  view.innerHTML = `
    <p class="sync-intro">Hier wird nur vorbereitet: Das Dashboard analysiert und schlägt vor, du passt an – gespeichert auf dem Server, also auf allen Geräten
      und nach Updates. Nach Firefly geht erst etwas, wenn du den jeweiligen Knopf drückst.</p>
    <div class="grid">
      ${card('a-import', 'Regeln aus der Import-Konfiguration', { meta: '<span id="a-import-meta"></span>' })}
      ${card('a-merge', 'Ähnliche Gegenkonten zusammenführen', { meta: '<span id="a-merge-meta"></span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  $('a-import').innerHTML = skeleton(4);
  $('a-merge').innerHTML = skeleton(4);

  let txs;
  let categories;
  let importPlan;
  let mergePlan;
  let rulesAction;
  let editAction;
  try {
    [txs, categories, importPlan, mergePlan, rulesAction, editAction] = await Promise.all([
      loadHistory(),
      api.getAll('categories').then((list) => list.map((c) => ({ id: String(c.id), name: c.attributes?.name || '' }))),
      fetch('/local/cleanup/import').then((r) => r.json()),
      fetch('/local/cleanup/merge').then((r) => r.json()),
      actionFor('rules'),
      actionFor('categorize'),
    ]);
  } catch (err) {
    view.querySelector('.grid').innerHTML = `<section class="card span-12"><div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div></section>`;
    return;
  }
  if (!view.isConnected) return;
  const catNames = categories.map((c) => c.name).sort((a, b) => a.localeCompare(b, 'de'));

  // ======================================================================
  // 1) Regeln aus der Import-Konfiguration
  // ======================================================================
  let impFilter = 'alle';
  let impSearch = '';
  let applyRange = 'none';

  /** Treffer einer Regel in den Buchungen der letzten 24 Monate. */
  const hitsOf = (it) => {
    const v = lower(it.value);
    if (!v) return { n: 0, ok: 0, change: 0 };
    const want = it.direction === 'deposit' ? 'deposit' : 'withdrawal';
    const list = txs.filter((t) => t.type === want && (it.op === 'contains' ? lower(counterpartyOf(t)).includes(v) : lower(counterpartyOf(t)) === v));
    const ok = list.filter((t) => lower(t.category_name) === lower(it.category)).length;
    return { n: list.length, ok, change: list.length - ok };
  };
  const changedSinceSent = (it) => it.sent && ['op', 'value', 'category', 'direction', 'enabled'].some((k) => (it.sent[k] ?? null) !== (it[k] ?? null));

  async function upload(file) {
    const out = $('a-import-out');
    try {
      const cfg = JSON.parse(await file.text());
      const result = analyzeImportConfig(cfg, categories);
      // Richtung je Vorschlag aus den Buchungen ableiten (Zahler bei Einnahmen)
      for (const it of Object.values(result.items)) {
        const v = lower(it.value);
        const m = (t) => (it.op === 'contains' ? lower(counterpartyOf(t)).includes(v) : lower(counterpartyOf(t)) === v);
        const dep = txs.filter((t) => t.type === 'deposit' && m(t)).length;
        const wd = txs.filter((t) => t.type === 'withdrawal' && m(t)).length;
        it.direction = dep > wd ? 'deposit' : 'withdrawal';
        if (!it.category) it.category = `Kategorie #${it.categoryId}`;
        delete it.categoryId;
      }
      if (result.missingCategories.length) result.hints.push(`${result.missingCategories.length} Kategorie-Nummer(n) aus der Datei gibt es in Firefly nicht mehr (${result.missingCategories.slice(0, 8).join(', ')}) – diese Vorschläge heißen „Kategorie #…“, bitte anpassen.`);
      importPlan = await post('/local/cleanup/import', {
        plan: { file: file.name, columns: result.columns, hints: result.hints },
        items: result.items,
      }, 'PUT');
      renderImport();
    } catch (err) {
      if (out) out.innerHTML = `<span class="badge bad">Fehler</span> <span class="muted">${esc(err.message)}</span>`;
      else window.alert(err.message);
    }
  }

  function renderImport() {
    const el = $('a-import');
    const plan = importPlan?.plan;
    const uploadBox = `<label class="drop" id="a-drop"><input type="file" accept=".json,application/json" id="a-file">
      <b>Import-Konfiguration (.json) wählen</b> oder hierher ziehen <span class="muted">– die Datei, die der Firefly Data Importer zum Herunterladen anbietet</span></label>`;
    if (!plan) {
      $('a-import-meta').textContent = '';
      el.innerHTML = `<p class="sync-intro">Die Konfiguration des Data Importers verrät, welche CSV-Spalte wohin geht – und enthält oft eine Übersetzungstabelle
        (z. B. „Name Zahlungsbeteiligter → Kategorie“). Daraus macht das Dashboard Firefly-Regeln, die du anpassen kannst. So kategorisiert Firefly
        künftige Importe selbst, auch wenn die Spalte künftig als Gegenkonto zugeordnet ist.</p>${uploadBox}<div id="a-import-out" class="sync-info"></div>`;
      bindDrop(el);
      return;
    }
    const items = Object.entries(importPlan.items).map(([id, it]) => ({ id, ...it, hits: hitsOf(it) }));
    const active = items.filter((i) => i.enabled);
    const sum = (list, k) => list.reduce((s, i) => s + i.hits[k], 0);
    const filters = {
      alle: ['Alle', () => true],
      aktiv: ['Aktiv', (i) => i.enabled],
      aus: ['Ausgeschaltet', (i) => !i.enabled],
      angepasst: ['Von dir angepasst', (i) => i.edited],
      aendern: ['Würden etwas ändern', (i) => i.hits.change],
      ohne: ['Ohne Treffer', (i) => !i.hits.n],
      offen: ['Noch nicht übertragen', (i) => i.enabled && (!i.sent || changedSinceSent(i))],
    };
    const q = lower(impSearch);
    const shown = items.filter(filters[impFilter][1]).filter((i) => !q || lower(`${i.value} ${i.category} ${(i.names || []).join(' ')}`).includes(q));
    // nach Kategorie gruppiert, größte zuerst
    const byCat = new Map();
    for (const i of shown) {
      if (!byCat.has(i.category)) byCat.set(i.category, []);
      byCat.get(i.category).push(i);
    }
    const groups = [...byCat].sort((a, b) => b[1].reduce((s, i) => s + i.hits.n, 0) - a[1].reduce((s, i) => s + i.hits.n, 0) || a[0].localeCompare(b[0], 'de'));
    const columns = plan.columns || [];
    $('a-import-meta').textContent = `${active.length} von ${items.length} Regeln aktiv`;
    el.innerHTML = `
      <div class="sync-info">Datei <b>${esc(plan.file)}</b>, ausgewertet am ${fmtDate(plan.uploadedAt)}${plan.sentAt ? ` · zuletzt übertragen am ${fmtDate(plan.sentAt)}` : ''}
        · <label class="link-btn file-link">andere Datei<input type="file" accept=".json,application/json" id="a-file" hidden></label>
        · <button class="link-btn" data-imp-drop>Plan verwerfen</button></div>
      ${(plan.hints || []).map((h) => `<div class="ai-hint">${esc(h)}</div>`).join('')}
      ${columns.length ? `<details class="ai-preview"><summary>Spaltenzuordnung der Datei (${columns.length} Spalten)</summary>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>Spalte (VR-Bank)</th><th>zugeordnet als</th><th class="num">Übersetzungen</th></tr></thead><tbody>
        ${columns.map((c) => `<tr style="cursor:default"><td>${c.index + 1}</td><td>${esc(c.header || '–')}</td><td>${esc(c.label || c.role)}</td><td class="num">${c.mapped || ''}</td></tr>`).join('')}
        </tbody></table></div></details>` : ''}
      <div class="sync-total-num"><b>${items.length}</b> Regelvorschläge · <b>${active.length}</b> aktiv · in den letzten 24 Monaten treffen sie
        <b>${sum(active, 'n')}</b> Buchungen, davon würden <b>${sum(active, 'change')}</b> eine andere Kategorie bekommen
        ${sum(items, 'n') === 0 ? '<br><span class="muted">Noch keine Treffer? Die Regeln prüfen den Empfänger – erst nach dem CSV-Abgleich (Empfänger nachgetragen) gibt es welche.</span>' : ''}</div>
      <div class="imp-tools">
        <div class="chips" role="group" aria-label="Filter">${Object.entries(filters).map(([k, [l, fn]]) =>
          `<button class="chip small" data-imp-filter="${k}" aria-pressed="${k === impFilter}">${l} <span class="muted">${items.filter(fn).length}</span></button>`).join('')}</div>
        <input class="input" type="search" data-imp-search value="${esc(impSearch)}" placeholder="Händler oder Kategorie suchen …">
      </div>
      <datalist id="a-cats">${catNames.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      ${groups.length ? `<div class="table-wrap scroll imp-table"><table><thead><tr><th></th><th>Wenn der Empfänger …</th><th>→ Kategorie</th><th class="num">Treffer (24 Monate)</th><th></th></tr></thead>
      ${groups.map(([cat, list]) => `<tbody class="imp-group">
        <tr class="imp-cat" style="cursor:default"><td><input type="checkbox" data-imp-cat="${esc(cat)}" ${list.every((i) => i.enabled) ? 'checked' : ''} aria-label="alle dieser Kategorie"></td>
          <td colspan="4"><b>${esc(cat)}</b> <span class="muted">${list.length} Regel${list.length === 1 ? '' : 'n'} · ${list.reduce((s, i) => s + i.hits.n, 0)} Buchungen${catNames.some((c) => lower(c) === lower(cat)) ? '' : ' · <span class="badge new">neue Kategorie</span>'}</span></td></tr>
        ${list.map((i) => `<tr data-id="${esc(i.id)}" class="${i.enabled ? '' : 'off'}" style="cursor:default">
          <td><input type="checkbox" data-f="enabled" ${i.enabled ? 'checked' : ''} aria-label="Regel aktiv"></td>
          <td><div class="imp-cond"><select data-f="direction" aria-label="Art"><option value="withdrawal"${i.direction !== 'deposit' ? ' selected' : ''}>Empfänger</option><option value="deposit"${i.direction === 'deposit' ? ' selected' : ''}>Zahler</option></select>
            <select data-f="op" aria-label="Vergleich"><option value="equals"${i.op === 'equals' ? ' selected' : ''}>ist genau</option><option value="contains"${i.op === 'contains' ? ' selected' : ''}>enthält</option></select>
            <input data-f="value" value="${esc(i.value)}" aria-label="Name"></div>
            ${(i.names || []).length > 1 || (i.names?.[0] && i.names[0] !== i.value) ? `<div class="flow">aus der Datei: ${(i.names || []).map(esc).join(' · ')}</div>` : ''}</td>
          <td><input data-f="category" value="${esc(i.category)}" list="a-cats" aria-label="Kategorie"></td>
          <td class="num">${i.hits.n ? `<b>${i.hits.n}</b><div class="flow">${i.hits.ok} passen schon${i.hits.change ? `, <b>${i.hits.change}</b> würden geändert` : ''}</div>` : '<span class="muted">–</span>'}</td>
          <td>${i.edited ? `<span class="badge">angepasst</span> <button class="link-btn" data-imp-reset title="Vorschlag wiederherstellen">↺</button>` : ''}
            ${i.sent && (i.enabled || i.sent.enabled) ? (changedSinceSent(i) ? '<span class="badge warn">geändert seit Übertragung</span>' : '<span class="badge good">übertragen</span>') : ''}</td>
        </tr>`).join('')}</tbody>`).join('')}</table></div>` : '<div class="empty">Keine Regeln in dieser Auswahl.</div>'}
      <div class="sync-run">
        ${rulesAction ? `<button class="btn primary" id="a-imp-run" ${active.length ? '' : 'disabled'}>${active.length} Regeln in Firefly anlegen</button>
          <label class="sync-set">auf vorhandene Buchungen anwenden <select data-imp-apply>
            <option value="none"${applyRange === 'none' ? ' selected' : ''}>nein, nur künftige</option>
            <option value="24"${applyRange === '24' ? ' selected' : ''}>letzte 24 Monate</option>
            <option value="all"${applyRange === 'all' ? ' selected' : ''}>alle</option></select></label>
          <span class="muted">Legt die aktiven Regeln in der Regelgruppe „${esc(RULE_GROUP)}“ an bzw. gleicht sie ab (ausgeschaltete werden dort entfernt).</span>`
        : '<span class="muted">Zum Übertragen eine Automation mit Auslöser „Firefly-Regeln anlegen“ anlegen (Workflow n8n/firefly-buchung-bearbeiten.json).</span>'}
        <div class="run-out" id="a-import-out"></div>
      </div>`;
    bindDrop(el);
  }

  function bindDrop(el) {
    const input = el.querySelector('#a-file');
    input?.addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));
    const drop = el.querySelector('#a-drop');
    if (!drop) return;
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
    });
  }

  // Änderungen sammeln und gebündelt speichern (Patch je Eintrag – andere Geräte bleiben unberührt)
  let pendingItems = {};
  const flushItems = debounce(async () => {
    const changes = pendingItems;
    pendingItems = {};
    try {
      importPlan = { ...importPlan, ...(await post('/local/cleanup/import/items', { changes })) };
    } catch (err) {
      window.alert(`Nicht gespeichert: ${err.message}`);
    }
  }, 500);
  const patchItem = (id, change, rerender = false) => {
    importPlan.items[id] = { ...importPlan.items[id], ...change, edited: true };
    pendingItems[id] = { ...(pendingItems[id] || {}), ...change };
    flushItems();
    if (rerender) renderImport();
  };

  $('a-import').addEventListener('change', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row && e.target.dataset.f) {
      const f = e.target.dataset.f;
      const value = f === 'enabled' ? e.target.checked : e.target.value.trim();
      patchItem(row.dataset.id, { [f]: value }, true);
      return;
    }
    const cat = e.target.closest('[data-imp-cat]');
    if (cat) {
      for (const [id, it] of Object.entries(importPlan.items)) if (it.category === cat.dataset.impCat) patchItem(id, { enabled: cat.checked });
      return renderImport();
    }
    if (e.target.matches('[data-imp-apply]')) applyRange = e.target.value;
  });
  $('a-import').addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-imp-search]')) return;
    impSearch = e.target.value;
    renderImport();
    const s = $('a-import').querySelector('[data-imp-search]');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }, 250));
  $('a-import').addEventListener('click', async (e) => {
    const f = e.target.closest('[data-imp-filter]');
    if (f) {
      impFilter = f.dataset.impFilter;
      return renderImport();
    }
    const reset = e.target.closest('[data-imp-reset]');
    if (reset) {
      const id = reset.closest('tr').dataset.id;
      const sug = importPlan.items[id].suggested || {};
      importPlan.items[id] = { ...importPlan.items[id], ...sug, enabled: true, edited: false };
      pendingItems[id] = { ...sug, enabled: true, edited: false };
      flushItems();
      return renderImport();
    }
    if (e.target.closest('[data-imp-drop]')) {
      if (!window.confirm('Plan mit allen Anpassungen verwerfen? In Firefly ändert sich dadurch nichts.')) return;
      importPlan = await post('/local/cleanup/import', {}, 'DELETE');
      return renderImport();
    }
    if (e.target.id === 'a-imp-run') transferRules(e.target);
  });

  async function transferRules(btn) {
    const items = Object.entries(importPlan.items).map(([id, it]) => ({ id, ...it }));
    const rules = items.filter((i) => i.enabled && i.value && i.category).map((i) => ({
      id: i.id, enabled: true, direction: i.direction,
      when: [{ field: 'party', op: i.op, value: i.value }], setCategory: i.category, addTags: [],
    }));
    const regeln = toFireflyRules(rules).map((r, k, all) => ({ ...r, order: all.length - k, description: `Aus der Import-Konfiguration (Dashboard) · id:${r.labor_id}` }));
    if (!window.confirm(`${regeln.length} Regeln in Firefly in der Gruppe „${RULE_GROUP}“ anlegen bzw. abgleichen?${applyRange === 'none'
      ? '\n\nSie gelten für künftige Buchungen (z. B. beim nächsten Import).'
      : `\n\nAußerdem auf vorhandene Buchungen (${applyRange === 'all' ? 'alle' : 'letzte 24 Monate'}) anwenden – das kann bestehende Kategorien ändern.`}`)) return;
    btn.disabled = true;
    const out = $('a-import-out');
    out.innerHTML = '<span class="muted">Übertrage … (kann bei vielen Regeln ein paar Minuten dauern)</span>';
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const payload = {
      typ: 'regeln_anlegen',
      gruppe: RULE_GROUP,
      gruppe_key: 'import-mapping',
      regeln,
      anwenden: applyRange === 'none' ? null : { start: applyRange === 'all' ? '2000-01-01' : iso(new Date(today.getFullYear(), today.getMonth() - 24, 1)), end: iso(today) },
    };
    const res = await runAction(rulesAction, payload).catch((err) => ({ ok: false, response: err.message }));
    if (!res.ok) {
      btn.disabled = false;
      out.innerHTML = `<span class="badge bad">Fehler ${esc(res.status || '')}</span> <span class="muted">${esc(String(res.response || '').slice(0, 200))}</span>`;
      return;
    }
    importPlan = await post('/local/cleanup/import/sent', { ids: items.map((i) => i.id) });
    renderImport();
    $('a-import-out').innerHTML = `<span class="badge good">${regeln.length} Regeln in Firefly ✓</span> <span class="muted">Gruppe „${esc(RULE_GROUP)}“${applyRange === 'none' ? '' : ' – und auf vorhandene Buchungen angewendet'}.</span>`;
  }

  renderImport();

  // ======================================================================
  // 2) Ähnliche Gegenkonten zusammenführen
  // ======================================================================
  let accounts = [];
  let groups = [];
  let mergeFilter = 'offen';
  let mergeSearch = '';
  let stats = new Map(); // Kontoname (klein) → { n, sum, first, last } aus den Buchungen

  async function loadAccounts(fresh = false) {
    if (fresh) api.setFresh(true);
    try {
      const lists = await Promise.all(['expense', 'revenue'].map((type) => api.getAll('accounts', { type })
        .then((l) => l.map((a) => ({ id: String(a.id), name: a.attributes?.name || '', type, iban: a.attributes?.iban || null })))));
      accounts = lists.flat();
    } finally {
      if (fresh) api.setFresh(false);
    }
    const counts = new Map();
    stats = new Map();
    for (const t of txs) {
      const k = lower(counterpartyOf(t));
      counts.set(k, (counts.get(k) || 0) + 1);
      const d = String(t.date).slice(0, 10);
      const st = stats.get(k) || { n: 0, sum: 0, first: d, last: d };
      st.n += 1;
      st.sum += Math.abs(Number(t.amount)) || 0;
      if (d < st.first) st.first = d;
      if (d > st.last) st.last = d;
      stats.set(k, st);
    }
    groups = mergeGroups(accounts, counts);
  }

  /** Gruppe + gespeicherte Entscheidung (Ziel, Mitglieder, Name, ignoriert …). */
  const planOf = (g) => {
    const p = mergePlan.groups[g.key] || {};
    const ids = g.accounts.map((a) => a.id);
    const members = (p.members || ids).filter((id) => ids.includes(id));
    const target = ids.includes(p.target) ? p.target : g.target;
    const targetAcc = g.accounts.find((a) => a.id === target);
    return { ...p, members: members.includes(target) ? members : [...members, target], target, rename: p.rename ?? targetAcc?.name ?? '' };
  };
  const statusOf = (g) => {
    const p = planOf(g);
    if (p.ignored) return 'ignoriert';
    if (p.done && p.members.length <= 1) return 'erledigt';
    return p.selected ? 'ausgewählt' : 'offen';
  };

  let pendingGroups = {};
  const flushGroups = debounce(async () => {
    const changes = pendingGroups;
    pendingGroups = {};
    try {
      mergePlan = await post('/local/cleanup/merge/groups', { changes });
    } catch (err) {
      window.alert(`Nicht gespeichert: ${err.message}`);
    }
  }, 400);
  const patchGroup = (key, change) => {
    mergePlan.groups[key] = { ...(mergePlan.groups[key] || {}), ...change };
    pendingGroups[key] = { ...(pendingGroups[key] || {}), ...change };
    flushGroups();
    renderMerge();
  };

  function renderMerge() {
    const el = $('a-merge');
    const filters = ['offen', 'ausgewählt', 'ignoriert', 'erledigt'];
    const counts = Object.fromEntries(filters.map((f) => [f, groups.filter((g) => statusOf(g) === f).length]));
    counts.erledigt += Object.entries(mergePlan.groups).filter(([key, p]) => p.done && !groups.some((g) => g.key === key)).length;
    const shown = groups.filter((g) => statusOf(g) === mergeFilter || (mergeFilter === 'offen' && statusOf(g) === 'ausgewählt'));
    const selected = groups.filter((g) => statusOf(g) === 'ausgewählt');
    const q = lower(mergeSearch);
    const visible = q ? shown.filter((g) => g.accounts.some((a) => lower(a.name).includes(q))) : shown;
    // leere Konten aus dem Plan (auch wenn die Gruppe nicht mehr als Vorschlag auftaucht)
    const pending = Object.entries(mergePlan.groups).flatMap(([key, p]) => (p.emptied || []).map((id) => ({ g: { key }, id })));
    const history = Object.entries(mergePlan.groups).filter(([key, p]) => p.done && !groups.some((g) => g.key === key));
    $('a-merge-meta').textContent = `${groups.length} Gruppen · ${accounts.length} Gegenkonten`;
    el.innerHTML = `
      <p class="sync-intro">Gleiche Händler unter verschiedenen Namen (Filialnummern, „sagt Danke“, Groß/klein, gleiche IBAN) zerstückeln die Auswertung.
        Je Gruppe wählst du das Zielkonto und welche Konten hineinsollen. Beim Zusammenführen verschiebt Firefly alle Buchungen der anderen Konten
        auf das Zielkonto (Kategorien, Tags, Beträge bleiben); leere Konten lassen sich danach löschen.</p>
      <div class="chips" role="group" aria-label="Filter">${filters.map((f) => `<button class="chip small" data-m-filter="${f}" aria-pressed="${f === mergeFilter}">${f[0].toUpperCase() + f.slice(1)} <span class="muted">${counts[f]}</span></button>`).join('')}</div>
      ${groups.length > 6 ? `<div class="merge-tools"><input type="search" class="card-filter" id="a-m-search" placeholder="Gruppen durchsuchen …" value="${esc(mergeSearch)}" aria-label="Gruppen durchsuchen">
        ${mergeFilter === 'offen' && visible.length ? `<button class="link-btn" data-m-all="1">alle ${visible.length} angezeigten auswählen</button> · <button class="link-btn" data-m-all="0">keine</button>` : ''}</div>` : ''}
      ${visible.length ? `<div class="merge-list">${visible.slice(0, 300).map((g) => {
        const p = planOf(g);
        const st = statusOf(g);
        const statOf = (a) => stats.get(lower(a.name)) || { n: a.n, sum: 0, first: null, last: null };
        const inGroup = g.accounts.filter((a) => p.members.includes(a.id));
        const total = inGroup.reduce((s, a) => s + statOf(a).n, 0);
        const sum = inGroup.reduce((s, a) => s + statOf(a).sum, 0);
        const target = g.accounts.find((a) => a.id === p.target);
        // Ziel zuerst, dann nach Buchungen
        const ordered = [target, ...g.accounts.filter((a) => a.id !== p.target).sort((a, b) => statOf(b).n - statOf(a).n)].filter(Boolean);
        const row = (a) => {
          const isTarget = a.id === p.target;
          const on = p.members.includes(a.id);
          const s2 = statOf(a);
          return `<div class="mg-row${isTarget ? ' target' : ''}${on ? '' : ' off'}">
            ${isTarget ? '<span class="mg-pin" aria-hidden="true">★</span>' : `<input type="checkbox" data-m-member="${esc(a.id)}" ${on ? 'checked' : ''} aria-label="${esc(a.name)} übernehmen"${st === 'erledigt' ? ' disabled' : ''}>`}
            <div class="mg-name"><span>${esc(a.name)}</span>
              <span class="mg-sub">${s2.n} Buchung${s2.n === 1 ? '' : 'en'}${s2.sum ? ` · ${money(s2.sum)}` : ''}${s2.first ? ` · ${fmtDate(s2.first, { month: 'short', year: '2-digit' })}${s2.last !== s2.first ? `–${fmtDate(s2.last, { month: 'short', year: '2-digit' })}` : ''}` : ''}${a.iban ? ` · ${esc(a.iban)}` : ''}</span></div>
            ${isTarget ? '<span class="badge good">Ziel</span>' : st === 'erledigt' ? '' : `<button class="link-btn" data-m-target="${esc(a.id)}">als Ziel</button>`}
          </div>`;
        };
        const moving = inGroup.length - 1;
        return `<div class="merge-group ${st}" data-key="${esc(g.key)}">
          <div class="merge-head">
            <input type="checkbox" data-m-select ${p.selected ? 'checked' : ''} ${st === 'ignoriert' || st === 'erledigt' ? 'disabled' : ''} aria-label="Gruppe auswählen">
            <div class="mg-title"><b>${esc(p.rename || target?.name || '')}</b>
              <span class="mg-sub">${g.type === 'revenue' ? 'Einnahmen' : 'Ausgaben'} · ${moving > 0 ? `${moving} ${moving === 1 ? 'Konto' : 'Konten'} ${moving === 1 ? 'wird' : 'werden'} übernommen` : 'nichts zu übernehmen'} · ${total} Buchungen${sum ? ` · ${money(sum)}` : ''} (24 Monate)</span></div>
            <span class="merge-btns">${st === 'erledigt' ? '<span class="badge good">zusammengeführt</span>'
              : `${editAction && !p.ignored ? `<button class="btn small" data-m-run${moving > 0 ? '' : ' disabled'}>Zusammenführen</button>` : ''}<button class="link-btn" data-m-ignore>${p.ignored ? 'doch vorschlagen' : 'ignorieren'}</button>`}</span>
          </div>
          ${st === 'erledigt' ? '' : `<div class="mg-rows">${ordered.map(row).join('')}</div>
          <label class="merge-rename">Name danach <input data-m-rename value="${esc(p.rename)}" placeholder="${esc(target?.name || '')}"></label>`}
          ${(p.emptied || []).length ? `<div class="merge-empty">${p.emptied.length} leere${p.emptied.length === 1 ? 's' : ''} Konto/Konten übrig${editAction ? ' – <button class="link-btn" data-m-delete>löschen</button>' : ''}</div>` : ''}
        </div>`;
      }).join('')}</div>` : mergeFilter === 'erledigt' && history.length ? '' : `<div class="empty">${mergeFilter === 'offen' ? 'Keine (weiteren) ähnlichen Gegenkonten gefunden. 🎉' : 'Nichts in dieser Auswahl.'}</div>`}
      ${mergeFilter === 'erledigt' && history.length ? `<div class="merge-list">${history.map(([key, p]) => `<div class="merge-group erledigt" data-key="${esc(key)}">
        <div class="merge-head"><b>${esc(p.rename || key.split(':').slice(1).join(':'))}</b> <span class="muted">zusammengeführt am ${fmtDate(p.done)}</span>
          <span class="merge-btns"><span class="badge good">zusammengeführt</span></span></div>
        ${(p.emptied || []).length ? `<div class="merge-empty">${p.emptied.length} leere${p.emptied.length === 1 ? 's' : ''} Konto/Konten übrig${editAction ? ' – <button class="link-btn" data-m-delete>löschen</button>' : ''}</div>` : ''}</div>`).join('')}</div>` : ''}
      <div class="sync-run">
        ${editAction ? `<button class="btn primary" id="a-m-run" ${selected.length ? '' : 'disabled'}>${selected.length} ausgewählte Gruppe${selected.length === 1 ? '' : 'n'} zusammenführen</button>
          ${pending.length ? `<button class="btn" id="a-m-delete-all">${pending.length} leere Konten löschen</button>` : ''}
          <span class="muted">über „${esc(editAction.name)}“ (n8n-Workflow mit Zweig „Konten?“)</span>`
        : '<span class="muted">Zum Übertragen eine Automation mit Auslöser „Kategorie übernehmen“ anlegen (Workflow n8n/firefly-buchung-bearbeiten.json, aktuelle Version).</span>'}
        <div class="run-out" id="a-merge-out"></div>
      </div>`;
  }

  /** Ist das Konto leer (frisch aus Firefly)? */
  async function isEmpty(id) {
    const res = await fetch(`/api/accounts/${encodeURIComponent(id)}/transactions?limit=1`, { headers: { 'X-No-Cache': '1' } }).catch(() => null);
    if (!res) return false;
    if (res.status === 404) return true;
    const body = await res.json().catch(() => null);
    return Array.isArray(body?.data) && body.data.length === 0;
  }
  async function exists(id) {
    const res = await fetch(`/api/accounts/${encodeURIComponent(id)}`, { headers: { 'X-No-Cache': '1' } }).catch(() => null);
    return Boolean(res && res.ok);
  }

  async function runMerge(list) {
    const out = $('a-merge-out');
    const paare = [];
    const umbenennen = [];
    for (const g of list) {
      const p = planOf(g);
      const target = g.accounts.find((a) => a.id === p.target);
      for (const a of g.accounts) if (a.id !== p.target && p.members.includes(a.id)) paare.push({ von: a.id, nach: target.id, von_name: a.name, nach_name: target.name, art: g.type });
      if (p.rename && p.rename !== target.name) umbenennen.push({ id: target.id, name: p.rename, alt: target.name });
    }
    if (!paare.length && !umbenennen.length) return;
    if (!window.confirm(`${paare.length} Konten in ${list.length} Zielkonten zusammenführen${umbenennen.length ? ` und ${umbenennen.length} umbenennen` : ''}?\n\nFirefly verschiebt alle Buchungen der Konten auf das jeweilige Zielkonto. Kategorien, Tags und Beträge bleiben. Die leeren Konten bleiben zunächst stehen und lassen sich danach löschen.`)) return;
    out.innerHTML = '<span class="muted">Übertrage …</span>';
    const payload = { typ: 'konten_zusammenfuehren', paare, umbenennen };
    const res = await runAction(editAction, { ...payload, daten: payload }).catch((err) => ({ ok: false, response: err.message }));
    if (!res.ok) {
      out.innerHTML = `<span class="badge bad">Fehler ${esc(res.status || '')}</span> <span class="muted">${esc(String(res.response || '').slice(0, 200))}</span>`;
      return;
    }
    // nachsehen, welche Konten jetzt leer sind
    out.innerHTML = '<span class="muted">Prüfe in Firefly, ob die Konten leer sind …</span>';
    let moved = 0;
    for (const g of list) {
      const p = planOf(g);
      const from = g.accounts.filter((a) => a.id !== p.target && p.members.includes(a.id));
      const empty = [];
      for (const a of from) if (await isEmpty(a.id)) empty.push(a.id);
      moved += empty.length;
      patchGroup(g.key, { done: new Date().toISOString(), selected: false, members: [p.target], target: p.target, rename: p.rename, emptied: empty });
    }
    api.forget();
    txs = await loadHistory(); // Buchungen zählen jetzt beim Zielkonto
    await loadAccounts(true);
    renderMerge();
    $('a-merge-out').innerHTML = `<span class="badge good">${moved} von ${paare.length} Konten zusammengeführt ✓</span>${moved < paare.length ? ' <span class="muted">Bei den übrigen sind noch Buchungen da – in n8n unter „Executions“ nachsehen.</span>' : ' <span class="muted">Die leeren Konten kannst du jetzt löschen.</span>'}`;
  }

  async function deleteEmpty(list) {
    const ids = [];
    for (const { id } of list) if (await isEmpty(id)) ids.push(id);
    if (!ids.length) return;
    if (!window.confirm(`${ids.length} leere Konten in Firefly löschen? Sie haben keine Buchungen mehr (eben geprüft).`)) return;
    const out = $('a-merge-out');
    const payload = { typ: 'konten_loeschen', ids };
    const res = await runAction(editAction, { ...payload, daten: payload }).catch((err) => ({ ok: false, response: err.message }));
    if (!res.ok) {
      out.innerHTML = `<span class="badge bad">Fehler ${esc(res.status || '')}</span> <span class="muted">${esc(String(res.response || '').slice(0, 200))}</span>`;
      return;
    }
    let gone = 0;
    for (const { g, id } of list) {
      if (!ids.includes(id)) continue;
      if (!(await exists(id))) gone += 1;
      patchGroup(g.key, { emptied: (mergePlan.groups[g.key]?.emptied || []).filter((x) => x !== id) });
    }
    api.forget();
    await loadAccounts(true);
    renderMerge();
    $('a-merge-out').innerHTML = `<span class="badge good">${gone} leere Konten gelöscht ✓</span>`;
  }

  $('a-merge').addEventListener('click', (e) => {
    const f = e.target.closest('[data-m-filter]');
    if (f) {
      mergeFilter = f.dataset.mFilter;
      return renderMerge();
    }
    const box = e.target.closest('.merge-group');
    const g = box && (groups.find((x) => x.key === box.dataset.key) || { key: box.dataset.key, accounts: [], target: null });
    const all = e.target.closest('[data-m-all]');
    if (all) {
      const on = all.dataset.mAll === '1';
      const q = lower(mergeSearch);
      for (const x of groups.filter((x) => statusOf(x) === 'offen' || statusOf(x) === 'ausgewählt')) {
        if (q && !x.accounts.some((a) => lower(a.name).includes(q))) continue;
        mergePlan.groups[x.key] = { ...(mergePlan.groups[x.key] || {}), selected: on };
        pendingGroups[x.key] = { ...(pendingGroups[x.key] || {}), selected: on };
      }
      flushGroups();
      return renderMerge();
    }
    const tb = e.target.closest('[data-m-target]');
    if (g && tb) {
      const p = planOf(g);
      const target = tb.dataset.mTarget;
      const old = g.accounts.find((a) => a.id === p.target)?.name || '';
      const name = g.accounts.find((a) => a.id === target)?.name || '';
      // eigener Name bleibt, sonst wandert er mit dem Ziel
      return patchGroup(g.key, { target, members: [...new Set([...p.members, target])], rename: !p.rename || p.rename === old ? name : p.rename });
    }
    if (g && e.target.closest('[data-m-ignore]')) return patchGroup(g.key, { ignored: !planOf(g).ignored, selected: false });
    if (g && e.target.closest('[data-m-run]')) return runMerge([g]);
    if (g && e.target.closest('[data-m-delete]')) return deleteEmpty((mergePlan.groups[g.key]?.emptied || []).map((id) => ({ g, id })));
    if (e.target.id === 'a-m-run') return runMerge(groups.filter((x) => statusOf(x) === 'ausgewählt'));
    if (e.target.id === 'a-m-delete-all') return deleteEmpty(Object.entries(mergePlan.groups).flatMap(([key, p]) => (p.emptied || []).map((id) => ({ g: { key }, id }))));
  });
  $('a-merge').addEventListener('input', debounce((e) => {
    if (e.target.id !== 'a-m-search') return;
    mergeSearch = e.target.value;
    renderMerge();
    const box = $('a-m-search');
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }, 250));
  $('a-merge').addEventListener('change', (e) => {
    const box = e.target.closest('.merge-group');
    const g = box && groups.find((x) => x.key === box.dataset.key);
    if (!g) return;
    const p = planOf(g);
    if (e.target.matches('[data-m-select]')) return patchGroup(g.key, { selected: e.target.checked });
    if (e.target.matches('[data-m-member]')) {
      const id = e.target.dataset.mMember;
      const members = e.target.checked ? [...new Set([...p.members, id])] : p.members.filter((x) => x !== id);
      return patchGroup(g.key, { members, target: p.target });
    }
    if (e.target.matches('[data-m-rename]')) return patchGroup(g.key, { rename: e.target.value.trim() });
  });

  try {
    await loadAccounts();
    renderMerge();
  } catch (err) {
    $('a-merge').innerHTML = `<div class="empty">Konten konnten nicht geladen werden: ${esc(err.message)}</div>`;
  }
}
