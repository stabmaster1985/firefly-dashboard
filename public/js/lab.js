// Kategorien-Labor: alle Buchungen mit eigenen Regeln probeweise neu
// kategorisieren und taggen. Nichts wird in Firefly geändert – erst ein
// Export (Firefly-Regeln, CSV oder n8n) macht es auf Wunsch dauerhaft.

import * as api from './api.js';
import { money, esc, fmtDate, today, debounce, isoDate } from './util.js';
import { skeleton, card, stat, sum, mainCurrency, downloadCsv, txAttrs, bindTxDetails } from './common.js';
import { detectRecurring } from './recurring.js';
import { FIELDS, OPS, INTERNAL_FIELDS, INTERNAL_OPS, AUTO_TAGS, applyRules, suggestRules, describeRule, toFireflyRules, counterpartyOf, normParty, ruleMatches } from './rules.js';
import { suggestTags, suggestCategoryStructure } from './structure.js';
import { createGroupsPanel } from './labgroups.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const RULE_GROUP = 'Firefly Dashboard (Labor)';
const RULE_DESC = 'Aus dem Kategorien-Labor des Firefly Dashboards – Änderungen besser dort machen';
const BASES = {
  ausgaben: { label: 'Ausgaben', type: 'withdrawal' },
  einnahmen: { label: 'Einnahmen', type: 'deposit' },
};

export async function lab(view, { params }) {
  const baseKey = BASES[params.get('basis')] ? params.get('basis') : 'ausgaben';
  const base = BASES[baseKey];
  const t0 = today();
  const from = new Date(t0.getFullYear(), t0.getMonth() - 24, 1); // gleicher Cache wie „Wiederkehrend“
  // Einschränkung (aus der Adresse, damit Links wie „Im Labor bearbeiten“ sie mitgeben können)
  const scope = {
    von: /^\d{4}-\d{2}-\d{2}$/.test(params.get('von') || '') ? params.get('von') : '',
    bis: /^\d{4}-\d{2}-\d{2}$/.test(params.get('bis') || '') ? params.get('bis') : '',
    konto: params.get('konto') || '',
    kategorie: params.get('kategorie') || '',
    text: params.get('text') || '',
    min: /^\d+([.,]\d+)?$/.test(params.get('min') || '') ? params.get('min').replace(',', '.') : '',
    max: /^\d+([.,]\d+)?$/.test(params.get('max') || '') ? params.get('max').replace(',', '.') : '',
  };
  const scoped = Object.values(scope).some(Boolean);

  view.innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Grundlage">${Object.entries(BASES)
        .map(([k, b]) => `<a class="chip" href="#/labor${k === 'ausgaben' ? '' : `?basis=${k}`}" aria-pressed="${k === baseKey}">${b.label}</a>`).join('')}</div>
      <div class="chips" role="group" aria-label="Automatische Tags" id="lab-auto"></div>
      <span class="meta-line">Nur Probe – Firefly bleibt unverändert · Buchungen seit ${fmtDate(from)}</span>
    </div>
    <form class="lab-scope${scoped ? ' active' : ''}" id="lab-scope"></form>
    <div class="grid">
      <section class="card span-3" id="l-count"></section>
      <section class="card span-3" id="l-changed"></section>
      <section class="card span-3" id="l-none"></section>
      <section class="card span-3" id="l-tags"></section>
      ${card('l-progress', 'Fortschritt', { meta: '<span class="chips small" id="l-progress-tabs" role="group" aria-label="Aufteilung"></span>' })}
      ${card('l-groups', 'Gruppen', { meta: '<span class="muted">eigene Zusammenstellungen · bleiben gespeichert</span>' })}
      ${card('l-rules', 'Deine Regeln', { span: 'span-7', link: '<span class="lab-export"><button class="link-btn" data-export="firefly">Als Firefly-Regeln ↓</button> · <button class="link-btn" data-export="csv">Änderungen als CSV ↓</button><span id="l-n8n"></span></span>' })}
      ${card('l-suggest', 'Vorschläge', { span: 'span-5', meta: '<span id="l-suggest-meta"></span>' })}
      ${card('l-struct', 'Tags & Kategorien-Struktur', { meta: '<span class="chips small" id="l-struct-tabs" role="group" aria-label="Art"></span>' })}
      ${card('l-compare', 'Kategorien vorher / nachher', { span: 'span-7', filter: true })}
      ${card('l-tagtable', 'Tags (Probe)', { span: 'span-5' })}
      ${card('l-tx', 'Buchungen', { filter: true, meta: '<span id="l-tx-chips"></span>' })}
    </div>
    <div class="pick-bar" id="l-pickbar" hidden></div>
    <div class="toast" id="l-toast" role="status" hidden></div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  ['l-count', 'l-changed', 'l-none', 'l-tags'].forEach((id) => ($(id).innerHTML = skeleton(2, 22)));
  ['l-progress', 'l-groups', 'l-rules', 'l-suggest', 'l-struct', 'l-compare', 'l-tagtable', 'l-tx'].forEach((id) => ($(id).innerHTML = skeleton(5)));

  let allTxs;
  let stored;
  let dismissed;
  let categorizeAction;
  let rulesAction;
  try {
    [allTxs, stored, [categorizeAction, rulesAction], dismissed] = await Promise.all([
      api.getAll('transactions', { start: from, end: t0, type: base.type })
        .then((groups) => api.flattenTransactions(groups).filter((t) => t.type === base.type)),
      fetch('/local/rules').then((r) => r.json()),
      fetch('/local/actions').then((r) => r.json())
        .then((l) => ['categorize', 'rules'].map((trigger) => l.find((a) => a.trigger === trigger) || null))
        .catch(() => [null, null]),
      api.loadDismissed(),
    ]);
  } catch (err) {
    view.querySelector('.grid').innerHTML = `<section class="card span-12"><div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div></section>`;
    return;
  }
  if (!view.isConnected) return;

  let rules = stored.rules || [];
  let autoTags = stored.autoTags || [];
  let txMode = 'changed';
  let structTab = 'tags';
  let progressBy = 'category';
  let focus = null; // { by: 'category' | 'party', value } – Filter der Buchungsliste
  let tagFilter = null;
  const accountOf = (t) => (t.type === 'deposit' ? t.destination_name : t.source_name) || '';
  const inScope = (t) => {
    const d = String(t.date).slice(0, 10);
    if (scope.von && d < scope.von) return false;
    if (scope.bis && d > scope.bis) return false;
    if (scope.konto && accountOf(t) !== scope.konto) return false;
    if (scope.kategorie && (t.category_name || 'Ohne Kategorie') !== scope.kategorie) return false;
    if (scope.text && !`${t.description} ${counterpartyOf(t)} ${t.notes || ''}`.toLowerCase().includes(scope.text.toLowerCase())) return false;
    if (scope.min && Math.abs(t.amount) < Number(scope.min)) return false;
    if (scope.max && Math.abs(t.amount) > Number(scope.max)) return false;
    return true;
  };
  // txs = was das Labor zeigt und auswertet; allTxs = alles (für Regeln ohne Fehltreffer, Abo-Erkennung)
  const txs = scoped ? allTxs.filter(inScope) : allTxs;
  const code = mainCurrency(allTxs);
  const knownCategories = [...new Set(allTxs.map((t) => t.category_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  renderScope();
  const recurringParties = new Set(detectRecurring(allTxs, base.type === 'deposit' ? 'income' : 'expense').items
    .filter((r) => r.active).map((r) => normParty(r.party || r.name)));

  let rev = stored.rev ?? 0;
  let toastTimer;
  const toast = (msg) => {
    const el = $('l-toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 5000);
  };
  /**
   * Regeln speichern – mit Revision: Hat ein anderes Gerät inzwischen gespeichert,
   * wird nichts überschrieben, sondern der neue Stand geladen.
   */
  async function saveNow() {
    try {
      const res = await fetch('/local/rules', { method: 'PUT', headers, body: JSON.stringify({ rules, autoTags, rev }) });
      const data = await res.json();
      if (res.status === 409) {
        rules = data.rules || [];
        autoTags = data.autoTags || [];
        rev = data.rev ?? 0;
        render();
        toast('Die Regeln wurden inzwischen auf einem anderen Gerät geändert – neuer Stand geladen. Bitte die letzte Änderung wiederholen.');
        return false;
      }
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      rev = data.rev ?? rev;
      return true;
    } catch (err) {
      toast(`Regeln nicht gespeichert: ${err.message}`);
      return false;
    }
  }
  const save = debounce(saveNow, 400);

  const knownTags = [...new Set([...allTxs.flatMap((t) => t.tags || []), ...rules.flatMap((r) => r.addTags || [])])].sort((a, b) => a.localeCompare(b, 'de'));
  const groups = createGroupsPanel({
    view,
    card: $('l-groups'),
    bar: $('l-pickbar'),
    txs,
    allTxs,
    openGroup: params.get('gruppe'),
    basis: baseKey,
    knownCategories,
    knownTags,
    toast,
    actions: { rules: rulesAction, categorize: categorizeAction },
    runAction: (action, payload) => fetch(`/local/actions/${encodeURIComponent(action.id)}/run`, { method: 'POST', headers, body: JSON.stringify({ context: { ...payload, daten: payload } }) })
      .then((x) => x.json()).catch((err) => ({ ok: false, response: err.message })),
    onGroupsChange: () => {
      if (!$('l-progress')) return;
      const results = compute();
      renderProgress(results);
      renderTx(results);
    },
    onReviewed: (ids, ok) => markReviewed(ids, ok),
    getRules: () => rules,
    setRules: async (next) => {
      rules = next;
      const ok = await saveNow();
      render();
      return ok;
    },
  });

  /** Alle Buchungen mit den aktuellen Regeln durchrechnen. */
  const compute = () => txs.map((t) => ({ t, r: applyRules(t, rules, { autoTags, recurringParties }) }));

  function render() {
    const results = compute();
    const changed = results.filter((x) => x.r.changed);
    const tagged = results.filter((x) => x.r.tags.length);
    const noneBefore = results.filter((x) => !x.t.category_name).length;
    const noneAfter = results.filter((x) => !x.r.category).length;

    $('l-count').innerHTML = stat('Buchungen', String(results.length), scoped ? `${base.label} in der Einschränkung (von ${allTxs.length})` : `${base.label} seit ${fmtDate(from, { month: 'short', year: 'numeric' })}`);
    $('l-changed').innerHTML = stat('Neu kategorisiert', String(changed.length), `zusammen ${money(sum(changed, (x) => x.t.amount), code)}`);
    $('l-none').innerHTML = stat('Ohne Kategorie', `${noneBefore} → ${noneAfter}`, noneBefore ? `${Math.round((1 - noneAfter / noneBefore) * 100)} % davon zugeordnet` : 'war schon alles zugeordnet');
    $('l-tags').innerHTML = stat('Getaggt', String(tagged.length), `${new Set(tagged.flatMap((x) => x.r.tags)).size} verschiedene Tags`);

    renderAuto();
    renderProgress(results);
    renderRules(results);
    renderSuggestions();
    renderStructure();
    renderCompare(results);
    renderTags(tagged);
    renderTx(results);
  }

  function renderAuto() {
    $('lab-auto').innerHTML = `<span class="muted chip-label">Auto-Tags:</span>${Object.entries(AUTO_TAGS)
      .map(([k, label]) => `<button class="chip small" data-auto="${k}" aria-pressed="${autoTags.includes(k)}">${label}</button>`).join('')}`;
  }

  function renderRules(results) {
    const count = (rule) => results.filter((x) => x.r.hits.includes(rule.id)).length;
    const fieldOpts = Object.entries(FIELDS).filter(([k]) => !INTERNAL_FIELDS.includes(k)).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    const opOpts = Object.entries(OPS).filter(([k]) => !INTERNAL_OPS.includes(k)).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    $('l-rules').innerHTML = `${rules.length ? `<div class="rule-list">${rules.map((rule, i) => {
      const d = describeRule(rule);
      return `<div class="rule${rule.enabled === false ? ' off' : ''}" data-i="${i}">
        <label class="rule-toggle" title="Regel an/aus"><input type="checkbox" data-toggle ${rule.enabled === false ? '' : 'checked'}></label>
        <div class="rule-text"><div>Wenn ${esc(d.cond)}${rule.groupId ? ' <span class="badge">Gruppe</span>' : ''}</div><div class="muted">→ ${esc(d.act)}</div></div>
        <span class="badge">${count(rule)}×</span>
        <span class="rule-btns"><button class="icon-btn small" data-up title="nach oben" ${i ? '' : 'disabled'}>↑</button><button class="icon-btn small" data-del title="Regel löschen">✕</button></span>
      </div>`;
    }).join('')}</div>` : '<div class="empty">Noch keine Regeln – übernimm rechts einen Vorschlag oder lege unten eine an.</div>'}
      <form class="rule-form" id="rule-form">
        <select name="field">${fieldOpts}</select><select name="op">${opOpts}</select>
        <input name="value" placeholder="Wert, z. B. REWE" required><input name="value2" placeholder="bis" hidden>
        <span class="muted">→</span>
        <input name="setCategory" placeholder="Kategorie" list="lab-cats"><input name="addTags" placeholder="Tags (mit Komma)">
        <button class="btn primary">Hinzufügen</button>
        <datalist id="lab-cats">${knownCategories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      </form>
      <div class="legend" style="margin-top:8px"><span>Reihenfolge zählt: Die erste passende Regel bestimmt die Kategorie, Tags sammeln sich.</span></div>`;
    $('l-n8n').innerHTML = `${rulesAction ? ' · <button class="link-btn" data-export="ff-rules">In Firefly anlegen</button>' : ''}${categorizeAction ? ' · <button class="link-btn" data-export="n8n">Änderungen an n8n übergeben</button>' : ''}`;
  }

  /**
   * Aufklappbare Liste der betroffenen Buchungen eines Vorschlags; jede Zeile
   * öffnet per Klick die vollen Details (Verwendungszweck, Notizen, Firefly-Links).
   */
  const HITS_MAX = 300;
  function hitsBlock(prefix, hits, extra = '') {
    const rows = [...hits].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, HITS_MAX);
    return `<details class="struct-hits" data-hits="${prefix}"><summary>${hits.length} Buchung${hits.length === 1 ? '' : 'en'} ansehen${extra}</summary>
      <div class="table-wrap scroll"><table><tbody>${rows.map((t, k) => `<tr ${txAttrs(`${prefix}:${k}`)}>${groups.pickCell(t)}<td class="date">${fmtDate(t.date)}</td>
        <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterpartyOf(t))}${t.category_name ? ` · ${esc(t.category_name)}` : ' · ohne Kategorie'}${(t.tags || []).map((x) => ` <span class="tag">${esc(x)}</span>`).join('')}</div>
          ${t.notes ? `<div class="flow note">${esc(t.notes)}</div>` : ''}</td>
        <td class="num">${money(t.amount, t.currency_code)}</td></tr>`).join('')}</tbody></table></div>
      ${hits.length > HITS_MAX ? `<div class="muted">Die neuesten ${HITS_MAX} von ${hits.length}</div>` : ''}
      <div class="muted">Zeile anklicken zeigt alle Details.</div></details>`;
  }
  /** Für bindTxDetails: Schlüssel „Vorschlag:Zeile“ → Buchung (gleiche Sortierung wie hitsBlock). */
  const hitFrom = (list) => (key) => {
    const [i, k] = key.split(':').map(Number);
    const hits = list()?.[i]?.hits;
    return hits && [...hits].sort((a, b) => String(b.date).localeCompare(String(a.date)))[k];
  };

  function renderSuggestions() {
    const list = suggestRules(txs, rules, knownCategories).slice(0, 25)
      // Buchungen, die der Vorschlag ändern würde
      .map((s) => ({ ...s, hits: txs.filter((t) => ruleMatches(s.rule, t) && (t.category_name || '') !== s.rule.setCategory) }));
    $('l-suggest-meta').textContent = list.length ? `${list.length} gefunden` : '';
    $('l-suggest').innerHTML = list.length
      ? `<div class="list">${list.map((s, i) => {
        const d = describeRule(s.rule);
        return `<div class="row suggestion"><div class="avatar kind-${s.kind}">${s.kind === 'haendler' ? 'H' : s.kind === 'ohne' ? '?' : '≠'}</div>
          <div style="min-width:0"><div class="title">${esc(d.cond)} → ${esc(s.rule.setCategory)}</div><div class="subtitle">${esc(s.reason)}</div>
            ${s.hits.length ? hitsBlock(i, s.hits) : ''}</div>
          <div class="amount struct-btns"><button class="btn small" data-take="${i}">+ ${s.changes}</button>${s.hits.length ? `<button class="link-btn" data-group-from="suggest:${i}">Als Gruppe</button>` : ''}</div></div>`;
      }).join('')}</div>${list.length > 1 ? '<div class="more"><button class="btn" data-take-all>Alle übernehmen</button></div>' : ''}`
      : '<div class="empty">Keine weiteren Vorschläge – sieht aufgeräumt aus.</div>';
    $('l-suggest').suggestions = list;
    bindTxDetails($('l-suggest'), hitFrom(() => $('l-suggest').suggestions));
  }

  // Struktur-Vorschläge: Tags (Themen, Reisen) und Kategorien (zusammenfassen, aufteilen)
  const sameRule = (a, b) => JSON.stringify(a.when) === JSON.stringify(b.when) && a.setCategory === b.setCategory
    && JSON.stringify(a.addTags) === JSON.stringify(b.addTags);
  const STRUCT_ICON = { wort: '#', reise: '✈', name: '≈', ueberschneidung: '∩', klein: '↘', aufteilen: '⑂' };
  function renderStructure() {
    const ign = dismissed.structure;
    const fresh = (s) => !ign.has(s.title) && !s.rules.every((r) => rules.some((x) => sameRule(x, r)));
    const lists = { tags: suggestTags(txs, rules).filter(fresh), kategorien: suggestCategoryStructure(txs).filter(fresh) };
    $('l-struct-tabs').innerHTML = [['tags', 'Tags'], ['kategorien', 'Kategorien']]
      .map(([k, l]) => `<button class="chip" data-struct-tab="${k}" aria-pressed="${k === structTab}">${l} (${lists[k].length})</button>`).join('');
    const list = lists[structTab];
    $('l-struct').structure = list;
    $('l-struct').innerHTML = list.length
      ? `<div class="list">${list.map((s, i) => `<div class="row suggestion struct-row">
          <div class="avatar kind-${s.kind}">${STRUCT_ICON[s.kind] || '•'}</div>
          <div style="min-width:0"><div class="title">${esc(s.title)}</div><div class="subtitle wrap">${esc(s.reason)}</div>
            ${hitsBlock(i, s.hits, s.rules.length > 1 ? ` · ${s.rules.length} Regeln` : '')}</div>
          <div class="amount struct-btns"><button class="btn small" data-struct-take="${i}">Übernehmen</button><button class="link-btn" data-group-from="struct:${i}">Als Gruppe bearbeiten</button><button class="link-btn" data-struct-ignore="${i}">Ignorieren</button></div>
        </div>`).join('')}</div>
        <div class="legend" style="margin-top:8px"><span>Alles lokal aus deinen Buchungen berechnet (Verwendungszweck, Empfänger, bisherige Kategorien) – ohne KI, nichts verlässt das Dashboard.
          „Übernehmen“ legt Labor-Regeln an; erst „In Firefly anlegen“ bzw. „Änderungen an n8n übergeben“ ändert Firefly.</span></div>`
      : `<div class="empty">${structTab === 'tags' ? 'Keine weiteren Tag-Vorschläge.' : 'Die Kategorien sehen aufgeräumt aus – nichts zum Zusammenfassen oder Aufteilen gefunden.'}</div>`;
    bindTxDetails($('l-struct'), hitFrom(() => $('l-struct').structure));
  }

  function renderCompare(results) {
    const before = new Map();
    const after = new Map();
    for (const { t, r } of results) {
      const b = t.category_name || 'Ohne Kategorie';
      const a = r.category || 'Ohne Kategorie';
      before.set(b, (before.get(b) || 0) + t.amount);
      after.set(a, (after.get(a) || 0) + t.amount);
    }
    const names = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => (after.get(y) || 0) - (after.get(x) || 0));
    $('l-compare').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Kategorie</th><th class="num">Firefly</th><th class="num">Probe</th><th class="num">Unterschied</th></tr></thead><tbody>${names
      .map((n) => {
        const b = before.get(n) || 0;
        const a = after.get(n) || 0;
        const d = a - b;
        return `<tr style="cursor:default"><td>${esc(n)}${before.has(n) ? '' : ' <span class="badge">neu</span>'}</td><td class="num muted">${money(b, code)}</td>
          <td class="num"><b>${money(a, code)}</b></td><td class="num ${Math.abs(d) < 0.01 ? 'muted' : ''}">${Math.abs(d) < 0.01 ? '–' : money(d, code, { signed: true })}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function renderTags(tagged) {
    const byTag = new Map();
    for (const { t, r } of tagged) for (const tag of r.tags) {
      const g = byTag.get(tag) || { n: 0, sum: 0 };
      g.n += 1;
      g.sum += t.amount;
      byTag.set(tag, g);
    }
    const total = sum(txs, (t) => t.amount);
    $('l-tagtable').innerHTML = byTag.size
      ? `<div class="list">${[...byTag].sort((a, b) => b[1].sum - a[1].sum).map(([tag, g]) => `<button class="row plain tag-row${tagFilter === tag ? ' active' : ''}" data-tag="${esc(tag)}">
          <div class="avatar">#</div><div style="min-width:0;text-align:left"><div class="title">${esc(tag)}</div><div class="subtitle">${g.n} Buchungen · ${Math.round((g.sum / total) * 100)} % der ${base.label}</div></div>
          <div class="amount">${money(g.sum, code)}</div></button>`).join('')}</div>
        <div class="legend" style="margin-top:8px"><span>Tag anklicken zeigt die Buchungen unten</span></div>`
      : '<div class="empty">Noch keine Tags – Auto-Tags oben einschalten oder Regeln mit Tags anlegen.</div>';
  }

  function renderTx(results) {
    const st = (x) => statusOf(x.t, x.r);
    let rows = txMode === 'changed' ? results.filter((x) => x.r.changed)
      : txMode === 'none' ? results.filter((x) => !x.r.category)
        : txMode === 'open' ? results.filter((x) => st(x) === 'offen')
          : txMode === 'done' ? results.filter((x) => st(x) !== 'offen') : results;
    if (tagFilter) rows = results.filter((x) => x.r.tags.includes(tagFilter));
    if (focus) rows = rows.filter((x) => focusKey(x.t, focus.by) === focus.value);
    rows = [...rows].sort((a, b) => String(b.t.date).localeCompare(String(a.t.date)));
    const modes = [['open', 'Offen'], ['done', 'Erledigt'], ['changed', 'Geänderte'], ['none', 'Ohne Kategorie'], ['all', 'Alle']]
      .map(([k, l]) => `<button class="link-btn" data-mode="${k}" aria-pressed="${k === txMode}">${l}</button>`).join(' · ');
    $('l-tx-chips').innerHTML = tagFilter
      ? `<span class="chip small" aria-pressed="true">#${esc(tagFilter)} <button class="chip-x" data-untag>✕</button></span>`
      : `${focus ? `<span class="chip small" aria-pressed="true">${focus.by === 'party' ? 'Empfänger' : 'Kategorie'}: ${esc(focus.value)} <button class="chip-x" data-unfocus aria-label="Filter entfernen">✕</button></span> ` : ''}${modes}`;
    $('l-tx').innerHTML = rows.length
      ? `<div class="table-wrap scroll"><table><tbody>${rows.slice(0, 500).map(({ t, r }, i) => `<tr ${txAttrs(i)}>${groups.pickCell(t)}
          <td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterpartyOf(t))}</div></td>
          <td>${r.changed ? `<span class="muted strike">${esc(t.category_name || 'ohne')}</span> → <b>${esc(r.category || 'ohne')}</b>` : esc(r.category || '–')}
            ${r.tags.length ? `<div>${r.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
            <div class="status-line">${statusBadge(statusOf(t, r), idOf(t))}</div></td>
          <td class="num">${money(t.amount, t.currency_code)}</td></tr>`).join('')}</tbody></table></div>
        <div class="legend" style="margin-top:8px"><span>${rows.length > 500 ? `Die ersten 500 von ${rows.length} · ` : ''}<button class="link-btn" data-pick-all>Alle ${Math.min(rows.length, 500)} angezeigten auswählen</button> – z. B. für „✓ Passt so“ oder eine Gruppe</span></div>`
      : `<div class="empty">${txMode === 'open' ? 'Nichts mehr offen. 🎉' : txMode === 'changed' && !tagFilter ? 'Noch keine Änderungen – lege Regeln an oder übernimm Vorschläge.' : 'Keine Buchungen.'}</div>`;
    bindTxDetails($('l-tx'), (i) => rows[Number(i)]?.t);
  }

  // ---- Einschränkung ------------------------------------------------------------------
  function renderScope() {
    const form = $('lab-scope');
    const accounts = [...new Set(allTxs.map(accountOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    const cats = ['Ohne Kategorie', ...knownCategories];
    const y = t0.getFullYear();
    const iso = (d) => isoDate(d);
    const PRESETS = [
      ['', 'alle (24 Monate)', '', ''],
      ['jahr', `${y}`, `${y}-01-01`, iso(t0)],
      ['vorjahr', `${y - 1}`, `${y - 1}-01-01`, `${y - 1}-12-31`],
      ['12m', 'letzte 12 Monate', iso(new Date(y, t0.getMonth() - 12, t0.getDate() + 1)), iso(t0)],
      ['3m', 'letzte 3 Monate', iso(new Date(y, t0.getMonth() - 3, t0.getDate() + 1)), iso(t0)],
    ];
    const preset = PRESETS.find(([, , v, b]) => v === scope.von && b === scope.bis)?.[0] ?? 'eigener';
    form.innerHTML = `<span class="scope-label">Einschränken:</span>
      <label>Zeitraum <select name="zeit">${PRESETS.map(([k, l]) => `<option value="${k}"${k === preset ? ' selected' : ''}>${l}</option>`).join('')}<option value="eigener"${preset === 'eigener' ? ' selected' : ''}>eigener …</option></select></label>
      <span class="scope-dates"${preset === 'eigener' ? '' : ' hidden'}><input type="date" name="von" value="${esc(scope.von)}" aria-label="von"> – <input type="date" name="bis" value="${esc(scope.bis)}" aria-label="bis"></span>
      <label>Konto <select name="konto"><option value="">alle</option>${accounts.map((a) => `<option${a === scope.konto ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label>Kategorie <select name="kategorie"><option value="">alle</option>${cats.map((c) => `<option${c === scope.kategorie ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Text <input type="search" name="text" value="${esc(scope.text)}" placeholder="Beschreibung, Empfänger, Notiz …" size="16"></label>
      <label>Betrag <input type="number" name="min" value="${esc(scope.min)}" min="0" step="0.01" placeholder="ab" aria-label="Betrag ab" class="amount-input"> – <input type="number" name="max" value="${esc(scope.max)}" min="0" step="0.01" placeholder="bis" aria-label="Betrag bis" class="amount-input"> €</label>
      ${scoped ? `<span class="scope-info"><b>${txs.length}</b> von ${allTxs.length} Buchungen · <button type="button" class="link-btn" data-scope-clear>Einschränkung aufheben</button></span>` : ''}`;
    const apply = () => {
      const f = new FormData(form);
      const zeit = f.get('zeit');
      const p = PRESETS.find(([k]) => k === zeit);
      const next = new URLSearchParams();
      if (baseKey !== 'ausgaben') next.set('basis', baseKey);
      const von = zeit === 'eigener' ? f.get('von') : p?.[2];
      const bis = zeit === 'eigener' ? f.get('bis') : p?.[3];
      if (von) next.set('von', von);
      if (bis) next.set('bis', bis);
      for (const k of ['konto', 'kategorie', 'text', 'min', 'max']) if (f.get(k)) next.set(k, String(f.get(k)).trim());
      location.hash = `#/labor${next.toString() ? `?${next}` : ''}`;
    };
    form.addEventListener('change', (e) => {
      if (e.target.name === 'zeit' && e.target.value === 'eigener') {
        form.querySelector('.scope-dates').hidden = false;
        return;
      }
      if (!['text', 'min', 'max'].includes(e.target.name)) apply();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      apply();
    });
    // Text und Betrag: übernehmen mit Enter oder beim Verlassen des Feldes
    form.querySelectorAll('[name=text], [name=min], [name=max]').forEach((input) => {
      input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), apply()));
      input.addEventListener('change', apply);
    });
    form.querySelector('[data-scope-clear]')?.addEventListener('click', () => {
      location.hash = `#/labor${baseKey === 'ausgaben' ? '' : `?basis=${baseKey}`}`;
    });
  }

  // ---- Bearbeitungsstand -----------------------------------------------------------
  // erledigt = in einer Gruppe, von einer Labor-Regel erfasst oder als „passt so“ markiert
  const idOf = (t) => String(t.transaction_journal_id);
  const focusKey = (t, by) => (by === 'party' ? counterpartyOf(t) || '–' : t.category_name || 'Ohne Kategorie');
  function statusOf(t, r) {
    const id = idOf(t);
    if (groups.memberIds().has(id)) return 'gruppe';
    if (r.hits.length) return 'regel';
    if (dismissed.reviewed.has(id)) return 'geprueft';
    return 'offen';
  }
  const STATUS = { offen: 'offen', gruppe: 'in Gruppe', regel: 'Regel', geprueft: 'passt so' };
  const statusBadge = (s, id) => `<span class="st st-${s}">${STATUS[s]}</span>${s === 'offen'
    ? ` <button class="link-btn" data-ok-one="${esc(id)}" title="als erledigt markieren – Kategorie passt so">passt so</button>`
    : s === 'geprueft' ? ` <button class="link-btn" data-unok-one="${esc(id)}">zurücknehmen</button>` : ''}`;

  async function markReviewed(ids, ok) {
    if (!ids.length) return;
    await (ok ? api.dismiss('reviewed', ids) : api.undismiss('reviewed', ids));
    const results = compute();
    renderProgress(results);
    renderTx(results);
    toast(ok ? `${ids.length} Buchung${ids.length === 1 ? '' : 'en'} als „passt so“ markiert.` : `„Passt so“ bei ${ids.length} Buchung${ids.length === 1 ? '' : 'en'} zurückgenommen.`);
  }

  function renderProgress(results) {
    const counts = { offen: 0, gruppe: 0, regel: 0, geprueft: 0 };
    const byKey = new Map();
    for (const x of results) {
      const s = statusOf(x.t, x.r);
      counts[s] += 1;
      const key = focusKey(x.t, progressBy);
      const g = byKey.get(key) || { name: key, total: 0, open: 0, sum: 0 };
      g.total += 1;
      if (s === 'offen') {
        g.open += 1;
        g.sum += x.t.amount;
      }
      byKey.set(key, g);
    }
    const total = results.length || 1;
    const done = results.length - counts.offen;
    const pct = results.length ? Math.round((done / results.length) * 100) : 0;
    $('l-progress-tabs').innerHTML = [['category', 'nach Kategorie'], ['party', 'nach Empfänger']]
      .map(([k, l]) => `<button class="chip" data-progress-by="${k}" aria-pressed="${k === progressBy}">${l}</button>`).join('');
    const rows = [...byKey.values()].filter((g) => g.open).sort((a, b) => b.open - a.open || b.sum - a.sum);
    if (!results.length) {
      $('l-progress').innerHTML = `<div class="empty">Keine Buchungen${scoped ? ' in dieser Einschränkung' : ''}.</div>`;
      return;
    }
    $('l-progress').innerHTML = `<div class="progress-head">
        <div class="progress-num"><b>${done}</b> von ${results.length} erledigt <span class="muted">(${pct} %)</span></div>
        <div class="progress-bar" role="img" aria-label="${pct} Prozent erledigt">
          ${['gruppe', 'regel', 'geprueft'].map((s) => `<i class="st-bg-${s}" style="width:${(counts[s] / total) * 100}%"></i>`).join('')}
        </div>
        <div class="legend">${['gruppe', 'regel', 'geprueft', 'offen'].map((s) => `<span><i class="dot st-bg-${s}"></i>${STATUS[s]} <b>&nbsp;${counts[s]}</b></span>`).join('')}</div>
      </div>
      ${rows.length ? `<div class="table-wrap scroll progress-table"><table><thead><tr><th>${progressBy === 'party' ? 'Empfänger' : 'Kategorie (Firefly)'}</th><th class="num">offen</th><th class="num hide-sm">gesamt</th><th class="hide-sm">erledigt</th></tr></thead>
        <tbody>${rows.slice(0, 200).map((g) => `<tr data-focus="${esc(g.name)}"${focus?.by === progressBy && focus.value === g.name ? ' class="active"' : ''}>
          <td>${esc(g.name)}</td><td class="num"><b>${g.open}</b><div class="flow">${money(g.sum, code)}</div></td><td class="num hide-sm">${g.total}</td>
          <td class="hide-sm"><div class="mini-bar"><i style="width:${Math.round(((g.total - g.open) / g.total) * 100)}%"></i></div></td></tr>`).join('')}</tbody></table></div>
        <div class="legend" style="margin-top:8px"><span>Zeile anklicken zeigt unten genau diese offenen Buchungen. Erledigt ist eine Buchung, wenn sie in einer Gruppe steckt, eine Labor-Regel greift oder du sie als „passt so“ markierst (Häkchen → „Passt so“ oder direkt in der Zeile).</span></div>`
        : '<div class="empty">Alles erledigt. 🎉</div>'}`;
  }

  /** Vorschlag → Gruppe(n): Name und Art aus dem Vorschlag, Buchungen = seine Treffer. */
  async function startGroup(s, where) {
    if (!s) return;
    const rulesOf = where === 'suggest' ? [s.rule] : s.rules;
    // „Aufteilen“ ergibt mehrere Zielkategorien → je eine Gruppe
    const targets = new Map();
    for (const r of rulesOf) {
      const key = r.setCategory ? `category:${r.setCategory}` : `tag:${r.addTags?.[0] || ''}`;
      if (!targets.has(key)) targets.set(key, { kind: r.setCategory ? 'category' : 'tag', name: r.setCategory || r.addTags?.[0] || 'Neue Gruppe', hits: [] });
      targets.get(key).hits.push(...s.hits.filter((t) => ruleMatches(r, t)));
    }
    const source = where === 'suggest' ? `Vorschlag: ${describeRule(s.rule).cond} → ${s.rule.setCategory}` : `Vorschlag: ${s.title}`;
    for (const t of targets.values()) await groups.createFrom(t.name, t.kind, [...new Set(t.hits)], source);
    toast(targets.size > 1 ? `${targets.size} Gruppen angelegt – du bearbeitest „${[...targets.values()].pop().name}“.` : 'Gruppe angelegt – jetzt anpassen und Ähnliches finden.');
  }

  // ---- Bedienung --------------------------------------------------------------
  view.addEventListener('click', (e) => {
    const auto = e.target.closest('[data-auto]');
    if (auto) {
      const k = auto.dataset.auto;
      autoTags = autoTags.includes(k) ? autoTags.filter((x) => x !== k) : [...autoTags, k];
      save();
      return render();
    }
    const from = e.target.closest('[data-group-from]');
    if (from) {
      const [where, i] = from.dataset.groupFrom.split(':');
      startGroup(where === 'suggest' ? $('l-suggest').suggestions[Number(i)] : $('l-struct').structure[Number(i)], where);
      return;
    }
    const tab = e.target.closest('[data-struct-tab]');
    if (tab) {
      structTab = tab.dataset.structTab;
      return renderStructure();
    }
    const structTake = e.target.closest('[data-struct-take]');
    if (structTake) {
      const s = $('l-struct').structure[Number(structTake.dataset.structTake)];
      // Zusammenfassen/Aufteilen vorne einreihen, damit es vor allgemeinen Regeln greift
      rules = s.kind === 'wort' || s.kind === 'reise' ? [...rules, ...s.rules] : [...s.rules, ...rules];
      save();
      return render();
    }
    const structIgnore = e.target.closest('[data-struct-ignore]');
    if (structIgnore) {
      const s = $('l-struct').structure[Number(structIgnore.dataset.structIgnore)];
      structIgnore.disabled = true;
      api.dismiss('structure', s.title).then(renderStructure);
      return;
    }
    const take = e.target.closest('[data-take]');
    if (take) {
      rules = [...rules, $('l-suggest').suggestions[Number(take.dataset.take)].rule];
      save();
      return render();
    }
    if (e.target.closest('[data-take-all]')) {
      rules = [...rules, ...$('l-suggest').suggestions.map((s) => s.rule)];
      save();
      return render();
    }
    const ruleEl = e.target.closest('.rule');
    if (ruleEl && e.target.closest('[data-del]')) {
      rules = rules.filter((_, i) => i !== Number(ruleEl.dataset.i));
      save();
      return render();
    }
    if (ruleEl && e.target.closest('[data-up]')) {
      const i = Number(ruleEl.dataset.i);
      [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
      save();
      return render();
    }
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      txMode = mode.dataset.mode;
      return renderTx(compute());
    }
    const by = e.target.closest('[data-progress-by]');
    if (by) {
      progressBy = by.dataset.progressBy;
      return renderProgress(compute());
    }
    const foc = e.target.closest('[data-focus]');
    if (foc) {
      focus = focus?.by === progressBy && focus.value === foc.dataset.focus ? null : { by: progressBy, value: foc.dataset.focus };
      txMode = 'open';
      tagFilter = null;
      const results = compute();
      renderProgress(results);
      renderTx(results);
      if (focus) $('l-tx').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (e.target.closest('[data-unfocus]')) {
      focus = null;
      const results = compute();
      renderProgress(results);
      return renderTx(results);
    }
    if (e.target.closest('[data-pick-all]')) {
      groups.pickMany([...$('l-tx').querySelectorAll('[data-pick]')].map((x) => x.dataset.pick));
      return;
    }
    const okOne = e.target.closest('[data-ok-one]');
    if (okOne) return markReviewed([okOne.dataset.okOne], true);
    const unokOne = e.target.closest('[data-unok-one]');
    if (unokOne) return markReviewed([unokOne.dataset.unokOne], false);
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      tagFilter = tagFilter === tagBtn.dataset.tag ? null : tagBtn.dataset.tag;
      render();
      $('l-tx').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (e.target.closest('[data-untag]')) {
      tagFilter = null;
      return render();
    }
    const exp = e.target.closest('[data-export]');
    if (exp) exportChanges(exp.dataset.export, exp);
  });
  view.addEventListener('change', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const i = Number(toggle.closest('.rule').dataset.i);
      rules[i] = { ...rules[i], enabled: toggle.checked };
      save();
      render();
    }
    if (e.target.name === 'op') e.target.form.value2.hidden = e.target.value !== 'between';
  });
  view.addEventListener('submit', (e) => {
    if (e.target.id !== 'rule-form') return;
    e.preventDefault();
    const f = e.target;
    const rule = {
      id: `r${Date.now().toString(36)}`,
      enabled: true,
      when: [{ field: f.field.value, op: f.op.value, value: f.value.value.trim(), value2: f.value2.value.trim() }],
      setCategory: f.setCategory.value.trim(),
      addTags: f.addTags.value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    if (!rule.setCategory && !rule.addTags.length) {
      f.setCategory.focus();
      return;
    }
    const hits = txs.filter((t) => ruleMatches(rule, t)).length;
    rules = [...rules, rule];
    save();
    render();
    if (!hits) $('l-rules').insertAdjacentHTML('beforeend', '<div class="empty">Hinweis: Diese Regel trifft auf keine Buchung zu.</div>');
  });

  async function exportChanges(kind, btn) {
    const results = compute().filter((x) => x.r.changed || x.r.tags.length);
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'firefly') {
      const blob = new Blob([JSON.stringify(toFireflyRules(rules), null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `firefly-regeln-${stamp}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (kind === 'csv') {
      downloadCsv(`kategorien-probe-${stamp}.csv`, [
        ['Datum', 'Beschreibung', 'Empfänger/Zahler', 'Betrag', 'Kategorie bisher', 'Kategorie neu', 'Tags'],
        ...results.map(({ t, r }) => [String(t.date).slice(0, 10), t.description, counterpartyOf(t), t.amount, t.category_name || '', r.category || '', r.tags.join(', ')]),
      ]);
    } else if (kind === 'ff-rules' && rulesAction) {
      // Regeln aus Gruppen haben eigene Firefly-Regelgruppen („Nach Firefly übertragen“ in der Gruppe)
      const all = toFireflyRules(rules.filter((r) => !r.groupId));
      const regeln = all.filter((r) => !r.hinweis);
      const skipped = all.length - regeln.length;
      if (!regeln.length) return window.alert('Keine Regel, die Firefly so übernehmen kann.');
      if (!window.confirm(`${regeln.length} Regel${regeln.length === 1 ? '' : 'n'} in Firefly anlegen bzw. aktualisieren (Regelgruppe „${RULE_GROUP}“)?`
        + `${skipped ? `\n${skipped} Regel(n) mit Bedingungen, die Firefly nicht kennt (Regex oder einzelne Buchungen aus Gruppen), werden übersprungen – die setzt „Änderungen an n8n übergeben“.` : ''}`
        + '\nRegeln, die du hier im Labor gelöscht hast, werden in dieser Gruppe ebenfalls entfernt.')) return;
      const apply = window.confirm(`Die Regeln auch gleich auf die vorhandenen Buchungen seit ${fmtDate(from)} anwenden?\n\nOK = ja, Abbrechen = nur für künftige Buchungen.`);
      btn.textContent = 'Sende …';
      const payload = {
        typ: 'regeln_anlegen',
        gruppe: RULE_GROUP,
        // Firefly führt alle passenden Regeln aus, die letzte Kategorie gewinnt – im Labor gewinnt
        // die erste. Darum umgekehrte Reihenfolge.
        regeln: regeln.map((r, i) => ({ ...r, order: regeln.length - i, description: `${RULE_DESC} · id:${r.labor_id}` })),
        anwenden: apply ? { start: isoDate(from), end: isoDate(t0) } : null,
      };
      const res = await fetch(`/local/actions/${encodeURIComponent(rulesAction.id)}/run`, { method: 'POST', headers, body: JSON.stringify({ context: { ...payload, daten: payload } }) })
        .then((x) => x.json()).catch(() => ({ ok: false }));
      if (res.ok) api.forget();
      btn.textContent = res.ok ? `In Firefly angelegt ✓${apply ? ' und angewendet' : ''}` : 'Fehler – siehe Automationen';
    } else if (kind === 'n8n' && categorizeAction) {
      // Kategorie geändert oder neue Tags; Tags gehen als komplette neue Liste mit
      const changes = results.filter((x) => x.r.changed || x.r.tags.some((tag) => !(x.t.tags || []).includes(tag)));
      if (!window.confirm(`${changes.length} Änderungen an „${categorizeAction.name}“ übergeben? Der Workflow schreibt sie dann in Firefly.${scoped ? '\n\nNur Buchungen innerhalb der aktuellen Einschränkung.' : ''}`)) return;
      btn.textContent = changes.length > 50 ? 'Sende … (dauert bei vielen Änderungen ein paar Minuten)' : 'Sende …';
      const payload = {
        typ: 'kategorien_uebernehmen',
        aenderungen: changes.map(({ t, r }) => ({
          transaction_group_id: t.groupId, transaction_journal_id: t.transaction_journal_id, datum: String(t.date).slice(0, 10),
          beschreibung: t.description, betrag: t.amount, kategorie_alt: t.category_name || null, kategorie: r.category,
          tags: [...new Set([...(t.tags || []), ...r.tags])], tags_neu: r.tags.filter((tag) => !(t.tags || []).includes(tag)),
        })),
      };
      const res = await fetch(`/local/actions/${encodeURIComponent(categorizeAction.id)}/run`, { method: 'POST', headers, body: JSON.stringify({ context: { ...payload, daten: payload } }) })
        .then((x) => x.json()).catch(() => ({ ok: false }));
      if (res.ok) api.forget();
      btn.textContent = res.ok ? 'Übergeben ✓' : 'Fehler – siehe Automationen';
    }
  }

  render();
}
