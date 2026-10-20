// Gruppen im Kategorien-Labor: Buchungen von Hand zusammenstellen, Ähnliches
// finden lassen, Gegenbeispiele markieren und daraus Regeln bilden.
// Gespeichert wird alles auf dem Server (lib/groups.js) – Schritt für Schritt,
// damit die Arbeit über Tage, Geräte und Updates hinweg erhalten bleibt.

import { money, esc, fmtDate } from './util.js';
import { txAttrs, bindTxDetails } from './common.js';
import * as api from './api.js';
import { counterpartyOf, toFireflyRules } from './rules.js';
import { buildIndex, findSimilar, proposeRules } from './similar.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const KIND = { category: 'Kategorie', tag: 'Tag' };
const idOf = (t) => String(t.transaction_journal_id);
const PERIODS = { all: 'alle vorhandenen Buchungen', '24': 'Buchungen der letzten 24 Monate', none: 'nur künftige Buchungen' };
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/local/groups${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/**
 * ctx: { card, bar, txs, basis, knownCategories, knownTags, getRules, setRules, toast }
 * Liefert Hilfen für die übrigen Labor-Listen (Häkchen-Spalte, „Als Gruppe bearbeiten“).
 */
export function createGroupsPanel(ctx) {
  const { card, bar, txs } = ctx;
  // index/byId: was das Labor gerade zeigt (ggf. eingeschränkt) – für Anzeige und „Ähnliche finden“.
  // full*: alle Buchungen – Regeln dürfen auch außerhalb der Einschränkung nichts Falsches treffen.
  const index = buildIndex(txs);
  const byId = new Map(txs.map((t) => [idOf(t), t]));
  const all = ctx.allTxs || txs;
  let fullIndexCache = null;
  const fullIndex = () => (fullIndexCache ||= all === txs ? index : buildIndex(all));
  const fullById = all === txs ? byId : new Map(all.map((t) => [idOf(t), t]));
  const picked = new Set(); // Auswahl in den Listen (nur in dieser Sitzung)
  let data = { groups: [], trash: [] };
  let openId = null;
  let similar = [];
  let similarChecked = new Set();
  let showTrash = false;
  let listFilter = 'alle';
  let memberCache = null;

  const group = () => data.groups.find((g) => g.id === openId) || null;
  const replaceGroup = (g) => {
    const i = data.groups.findIndex((x) => x.id === g.id);
    if (i >= 0) data.groups[i] = g;
    else data.groups.push(g);
  };

  async function reload() {
    try {
      data = await request('');
    } catch (err) {
      card.innerHTML = `<div class="empty">Gruppen konnten nicht geladen werden: ${esc(err.message)}</div>`;
      return;
    }
    if (ctx.openGroup && !openId && data.groups.some((g) => g.id === ctx.openGroup)) {
      openId = ctx.openGroup; // z. B. frisch aus der Suche auf „Buchungen“ angelegt
      ctx.openGroup = null;
      setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
    if (openId && !group()) openId = null; // z. B. auf einem anderen Gerät gelöscht
    render();
  }

  /** Eine Änderung speichern; bei Erfolg den Stand vom Server übernehmen. */
  /** Änderung an einer Gruppe speichern (Standard: die geöffnete). */
  async function change(ops, id = openId) {
    const g = data.groups.find((x) => x.id === id);
    if (!g) return;
    try {
      replaceGroup(await request(`/${encodeURIComponent(g.id)}`, { method: 'POST', body: { ops } }));
    } catch (err) {
      ctx.toast(`Nicht gespeichert: ${err.message}`);
      await reload();
      return;
    }
    render();
  }

  async function create(name, kind, ids, source = '') {
    const g = await request('', { method: 'POST', body: { name, kind, include: ids, source, basis: ctx.basis } });
    data.groups.push(g);
    openId = g.id;
    similar = [];
    render();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return g;
  }

  // ---- Darstellung -------------------------------------------------------------

  const txRowHtml = (t, key, { check = null, extra = '', actions = '' } = {}) => `<tr ${txAttrs(key)}>
    ${check === null ? '' : `<td class="pick-cell"><input type="checkbox" ${check ? 'checked' : ''} data-sim="${esc(idOf(t))}" aria-label="auswählen"></td>`}
    <td class="date">${fmtDate(t.date)}</td>
    <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterpartyOf(t))}${t.category_name ? ` · ${esc(t.category_name)}` : ' · ohne Kategorie'}${(t.tags || []).map((x) => ` <span class="tag">${esc(x)}</span>`).join('')}</div>${extra}</td>
    <td class="num">${money(t.amount, t.currency_code)}${actions ? `<div class="row-actions">${actions}</div>` : ''}</td></tr>`;

  /** Stand einer Gruppe: offen → übernommen (Labor) → in Firefly; „geändert“, wenn danach weiterbearbeitet. */
  const changed = (g) => g.changedAt || g.updatedAt;
  const stateOf = (g) => {
    if (g.transfer?.ok) return changed(g) > g.transfer.at ? 'geaendert' : 'firefly';
    if (g.status === 'uebernommen') return g.appliedAt && changed(g) > g.appliedAt ? 'veraltet' : 'uebernommen';
    return 'offen';
  };
  const STATE = {
    offen: ['offen', ''],
    uebernommen: ['im Labor übernommen, nicht in Firefly', 'warn'],
    veraltet: ['seit Übernahme geändert – Regeln aktualisieren', 'warn'],
    firefly: ['in Firefly', 'good'],
    geaendert: ['seit Übertragung geändert – erneut übertragen', 'warn'],
  };
  const FILTERS = [
    ['alle', 'Alle', () => true],
    ['offen', 'Offen', (s) => s === 'offen'],
    ['labor', 'Nicht in Firefly', (s) => s === 'uebernommen' || s === 'veraltet'],
    ['firefly', 'In Firefly', (s) => s === 'firefly'],
    ['geaendert', 'Geändert seit Übertragung', (s) => s === 'geaendert'],
  ];

  function renderList() {
    const ORDER = { geaendert: 0, veraltet: 1, offen: 2, uebernommen: 3, firefly: 4 };
    const test = (FILTERS.find(([k]) => k === listFilter) || FILTERS[0])[2];
    const shown = data.groups.filter((g) => test(stateOf(g))).sort((a, b) => ORDER[stateOf(a)] - ORDER[stateOf(b)] || String(changed(b)).localeCompare(String(changed(a))));
    const chips = data.groups.length > 1 ? `<div class="chips small group-filter" role="group" aria-label="Gruppen filtern">${FILTERS.map(([k, l, f]) => {
      const n = data.groups.filter((g) => f(stateOf(g))).length;
      return k === 'alle' || n ? `<button class="chip" data-g-filter="${k}" aria-pressed="${k === listFilter}">${l} (${n})</button>` : '';
    }).join('')}</div>` : '';
    const row = (g) => {
      const here = g.include.filter((id) => byId.has(id)).length;
      const [label, cls] = STATE[stateOf(g)];
      return `<div class="row group-row${g.id === openId ? ' active' : ''}">
        <div class="avatar">${g.kind === 'tag' ? '#' : '▣'}</div>
        <div style="min-width:0"><div class="title">${esc(g.name)} <span class="badge">${KIND[g.kind]}</span> <span class="badge ${cls}">${label}</span>${g.transfer && !g.transfer.ok ? ' <span class="badge bad">letzte Übertragung fehlgeschlagen</span>' : ''}</div>
          <div class="subtitle">${g.include.length} Buchung${g.include.length === 1 ? '' : 'en'}${here < g.include.length ? ` (${here} in dieser Ansicht)` : ''}${g.exclude.length ? ` · ${g.exclude.length} ausgeschlossen` : ''} · zuletzt ${fmtDate(g.updatedAt)}</div></div>
        <div class="amount"><button class="btn small" data-g-open="${esc(g.id)}">${g.id === openId ? 'Schließen' : 'Bearbeiten'}</button></div></div>`;
    };
    return `${chips}${data.groups.length
      ? shown.length ? `<div class="list">${shown.map(row).join('')}</div>` : '<div class="empty">Keine Gruppen mit diesem Stand.</div>'
      : `<div class="empty">Noch keine Gruppen. Hake in den Listen unten Buchungen an und wähle „Neue Gruppe“ – oder nutze bei einem Vorschlag „Als Gruppe bearbeiten“.</div>`}
      <div class="group-foot"><button class="link-btn" data-g-new>+ Leere Gruppe</button>${data.trash.length ? ` · <button class="link-btn" data-g-trash>Papierkorb (${data.trash.length})</button>` : ''}</div>
      ${showTrash && data.trash.length ? `<div class="list trash">${data.trash.map((g) => `<div class="row"><div class="avatar">🗑</div>
        <div style="min-width:0"><div class="title">${esc(g.name)}</div><div class="subtitle">${g.include.length} Buchungen · gelöscht ${fmtDate(g.deletedAt)} · wird nach 30 Tagen endgültig entfernt</div></div>
        <div class="amount"><button class="btn small" data-g-restore="${esc(g.id)}">Wiederherstellen</button></div></div>`).join('')}</div>` : ''}`;
  }

  function renderEditor(g) {
    const members = g.include.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const missing = g.include.length - members.length;
    const excluded = g.exclude.map((id) => byId.get(id)).filter(Boolean);
    const plan = g.include.length ? proposeRules(fullIndex(), g.include, { kind: g.kind, name: g.name, groupId: g.id }) : null;
    const names = g.kind === 'tag' ? ctx.knownTags : ctx.knownCategories;
    return `<div class="group-editor">
      <div class="group-head">
        <label>Name <input data-g-name value="${esc(g.name)}" list="g-names" maxlength="80"></label>
        <datalist id="g-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="chips small" role="group" aria-label="Art">${Object.entries(KIND).map(([k, l]) => `<button class="chip" data-g-kind="${k}" aria-pressed="${g.kind === k}">${l}</button>`).join('')}</div>
        <span class="spacer"></span>
        <button class="link-btn danger-link" data-g-delete>Gruppe löschen</button>
      </div>
      ${g.source ? `<p class="muted small-text">Entstanden aus: ${esc(g.source)}</p>` : ''}

      <h3>In der Gruppe (${members.length})</h3>
      ${missing ? `<p class="muted small-text">${missing} weitere Buchung${missing === 1 ? '' : 'en'} gespeichert, aber nicht in dieser Ansicht (außerhalb der Einschränkung, älter als 24 Monate, in Firefly gelöscht oder ${g.basis === 'einnahmen' ? 'Ausgaben' : 'Einnahmen'}-Ansicht) – sie bleiben erhalten und zählen beim Übernehmen mit.</p>` : ''}
      ${members.length ? `<div class="table-wrap scroll group-table"><table><tbody>${members.map((t, k) => txRowHtml(t, `m:${k}`, {
        actions: `<button class="link-btn" data-g-remove="${esc(idOf(t))}" title="aus der Gruppe nehmen">entfernen</button><button class="link-btn" data-g-exclude="${esc(idOf(t))}" title="als Gegenbeispiel merken">gehört nicht dazu</button>`,
      })).join('')}</tbody></table></div>` : '<div class="empty">Noch leer – hake unten Buchungen an.</div>'}

      <h3>Ähnliche Buchungen ${members.length ? `<button class="btn small" data-g-find>${similar.length ? 'Neu suchen' : 'Ähnliche finden'}</button>` : ''}</h3>
      ${similar.length ? `<p class="muted small-text">Sehr ähnliche sind schon angehakt. Prüfe kurz, dann „Angehakte hinzufügen“. Was nicht passt, als „gehört nicht dazu“ markieren – das verbessert die nächste Suche.</p>
        <div class="table-wrap scroll group-table"><table><tbody>${similar.map((s, k) => txRowHtml(s.t, `s:${k}`, {
          check: similarChecked.has(s.id),
          extra: `<div class="flow reason">${s.sure ? '<span class="badge good">sehr ähnlich</span> ' : ''}${esc(s.reasons.join(' · '))}</div>`,
        })).join('')}</tbody></table></div>
        <div class="group-actions"><button class="btn primary" data-g-add-checked>Angehakte hinzufügen (${similarChecked.size})</button>
          <button class="btn" data-g-exclude-unchecked>Nicht angehakte: gehört nicht dazu (${similar.length - similarChecked.size})</button></div>`
        : `<p class="muted small-text">${members.length ? '„Ähnliche finden“ sucht nach gleichen Empfängern, seltenen gemeinsamen Wörtern im Verwendungszweck und ähnlichen Beträgen.' : ''}</p>`}

      ${excluded.length ? `<details class="struct-hits"><summary>Gehört nicht dazu (${excluded.length})</summary>
        <div class="table-wrap scroll group-table"><table><tbody>${excluded.map((t, k) => txRowHtml(t, `x:${k}`, {
          actions: `<button class="link-btn" data-g-unexclude="${esc(idOf(t))}">zurück zur Auswahl</button>`,
        })).join('')}</tbody></table></div></details>` : ''}

      ${plan ? `<h3>Übernehmen als ${KIND[g.kind]} „${esc(g.name)}“</h3>
        <div class="list plan">${plan.rules.map((r) => `<div class="row"><div class="avatar">${r.oneOff ? '1×' : '⟳'}</div>
          <div style="min-width:0"><div class="title">${esc(r.label)}</div><div class="subtitle">${r.count} Buchung${r.count === 1 ? '' : 'en'} · ${r.oneOff ? 'einmalig (per „Änderungen an n8n übergeben“)' : 'dauerhaft – greift auch bei künftigen Buchungen'}</div></div><div></div></div>`).join('')}</div>
        <div class="group-actions"><button class="btn primary" data-g-apply>${g.status === 'uebernommen' ? 'Regeln aktualisieren' : 'Als Labor-Regeln übernehmen'}</button>
          <span class="muted small-text">${plan.permanent} Regel${plan.permanent === 1 ? '' : 'n'} ohne Fehltreffer${plan.oneOff ? `, ${plan.oneOff} einzeln` : ''}. Die Gruppe bleibt gespeichert und lässt sich später weiter bearbeiten.</span></div>
        ${transferHtml(g, plan)}` : ''}
    </div>`;
  }

  /** Abschnitt „Nach Firefly übertragen“ mit Vorschau, was dort passiert. */
  /** Mitglieder, die das Labor nicht kennt (älter als 24 Monate …): mit Verweis übertragbar, sonst nicht. */
  const outsideOf = (g) => {
    const out = g.include.filter((id) => !fullById.has(id));
    return { withRef: out.filter((id) => g.refs?.[id]), lost: out.filter((id) => !g.refs?.[id]) };
  };

  function transferHtml(g, plan) {
    const { rules: rulesAction, categorize } = ctx.actions;
    const last = g.transfer;
    const outside = outsideOf(g);
    const missing = [!rulesAction && plan.permanent ? '„Firefly-Regeln anlegen“' : '', !categorize && (plan.oneOff || outside.withRef.length) ? '„Kategorie übernehmen“' : ''].filter(Boolean);
    return `<h3>Nach Firefly übertragen</h3>
      <ul class="transfer-plan small-text">
        ${plan.permanent ? `<li><b>${plan.permanent} Regel${plan.permanent === 1 ? '' : 'n'}</b> in der Firefly-Regelgruppe „${esc(fireflyGroupTitle(g))}“ anlegen bzw. aktualisieren – Firefly ${g.kind === 'tag' ? 'taggt' : 'kategorisiert'} damit künftig neue Buchungen beim Import selbst.</li>` : '<li>Keine dauerhafte Regel möglich – nur einzelne Buchungen.</li>'}
        ${plan.permanent ? `<li>Die Regeln anwenden auf: <select data-g-period>${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}"${k === (last?.period || 'all') ? ' selected' : ''}>${l}</option>`).join('')}</select></li>` : ''}
        ${plan.oneOff ? `<li><b>${plan.oneOff} einzelne Buchung${plan.oneOff === 1 ? '' : 'en'}</b> direkt ${g.kind === 'tag' ? `mit Tag „${esc(g.name)}“ versehen` : `auf „${esc(g.name)}“ setzen`} (einmalig).</li>` : ''}
        ${outside.withRef.length ? `<li><b>${outside.withRef.length} ältere Buchung${outside.withRef.length === 1 ? '' : 'en'}</b> (außerhalb der 24 Monate des Labors) ${outside.withRef.length === 1 ? 'wird' : 'werden'} aus Firefly nachgeladen und ebenfalls direkt gesetzt.</li>` : ''}
        ${outside.lost.length ? `<li class="warn-text">${outside.lost.length} Buchung${outside.lost.length === 1 ? '' : 'en'} kennt das Labor nicht mehr (z. B. in Firefly gelöscht) – sie werden übersprungen.</li>` : ''}
      </ul>
      ${missing.length ? `<p class="small-text warn-text">Dafür fehlt in den <a href="#/automationen">Automationen</a> noch: ${missing.join(' und ')} (n8n-Vorlage firefly-buchung-bearbeiten.json).</p>` : ''}
      <div class="group-actions"><button class="btn primary" data-g-transfer ${missing.length ? 'disabled' : ''}>Nach Firefly übertragen</button>
        ${last ? `<span class="small-text ${last.ok ? 'muted' : 'warn-text'}">Zuletzt übertragen ${fmtDate(last.at)}: ${last.ok ? `${last.rules} Regeln, ${last.oneOff} einzeln, ${esc(PERIODS[last.period] || '')}` : `Fehler – ${esc(last.message)}`}</span>` : ''}</div>`;
  }

  function render() {
    const g = group();
    memberCache = null; // Gruppen haben sich geändert
    card.innerHTML = `${renderList()}${g ? renderEditor(g) : ''}`;
    renderBar();
    ctx.onGroupsChange?.();
  }

  function renderBar() {
    if (!picked.size) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const target = [...data.groups].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const names = (kind) => [...new Set([...(kind === 'tag' ? ctx.knownTags : ctx.knownCategories), ...data.groups.filter((g) => g.kind === kind).map((g) => g.name)])]
      .sort((a, b) => a.localeCompare(b, 'de'));
    bar.innerHTML = `<span><b>${picked.size}</b> ausgewählt</span>
      <form class="bar-form" data-quick="category" title="Setzt die Kategorie im Labor (Probe) – über eine Gruppe gleichen Namens"><input name="v" list="pick-cats" placeholder="Kategorie …" aria-label="Kategorie setzen" autocomplete="off"><button class="btn small primary">Setzen</button></form>
      <form class="bar-form" data-quick="tag" title="Vergibt den Tag im Labor (Probe) – über eine Gruppe gleichen Namens"><input name="v" list="pick-tags" placeholder="Tag …" aria-label="Tag hinzufügen" autocomplete="off"><button class="btn small">Hinzufügen</button></form>
      <datalist id="pick-cats">${names('category').map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <datalist id="pick-tags">${names('tag').map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <button class="btn small" data-pick-new>Neue Gruppe …</button>
      <button class="btn small" data-pick-ok title="Kategorie passt so – als erledigt markieren">✓ Passt so</button>
      <button class="link-btn" data-pick-unok>„Passt so“ aufheben</button>
      ${target.length ? `<select data-pick-to aria-label="Zu Gruppe hinzufügen"><option value="">Zu Gruppe hinzufügen …</option>${target.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>` : ''}
      <button class="link-btn" data-pick-clear>Auswahl aufheben</button>`;
  }

  // ---- Bedienung ---------------------------------------------------------------

  const keyTx = (key) => {
    const [kind, k] = key.split(':');
    const g = group();
    if (!g) return null;
    if (kind === 'm') return g.include.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)))[Number(k)];
    if (kind === 's') return similar[Number(k)]?.t;
    if (kind === 'x') return g.exclude.map((id) => byId.get(id)).filter(Boolean)[Number(k)];
    return null;
  };
  bindTxDetails(card, keyTx);

  card.addEventListener('click', async (e) => {
    const t = e.target;
    const btn = (sel) => t.closest(sel);
    if (btn('[data-g-open]')) {
      const id = btn('[data-g-open]').dataset.gOpen;
      openId = openId === id ? null : id;
      similar = [];
      similarChecked = new Set();
      return render();
    }
    if (btn('[data-g-new]')) return create('Neue Gruppe', 'category', []);
    if (btn('[data-g-filter]')) {
      listFilter = btn('[data-g-filter]').dataset.gFilter;
      return render();
    }
    if (btn('[data-g-trash]')) {
      showTrash = !showTrash;
      return render();
    }
    if (btn('[data-g-restore]')) {
      await request(`/${encodeURIComponent(btn('[data-g-restore]').dataset.gRestore)}/restore`, { method: 'POST' }).catch((err) => ctx.toast(err.message));
      return reload();
    }
    const g = group();
    if (!g) return;
    if (btn('[data-g-kind]')) return change([{ op: 'set', kind: btn('[data-g-kind]').dataset.gKind }]);
    if (btn('[data-g-delete]')) {
      if (!window.confirm(`Gruppe „${g.name}“ löschen? Sie liegt danach 30 Tage im Papierkorb. Bereits übernommene Labor-Regeln bleiben bestehen.`)) return;
      await request(`/${encodeURIComponent(g.id)}`, { method: 'DELETE' }).catch((err) => ctx.toast(err.message));
      openId = null;
      return reload();
    }
    if (btn('[data-g-remove]')) return change([{ op: 'remove', ids: [btn('[data-g-remove]').dataset.gRemove] }]);
    if (btn('[data-g-exclude]')) return change([{ op: 'exclude', ids: [btn('[data-g-exclude]').dataset.gExclude] }]);
    if (btn('[data-g-unexclude]')) return change([{ op: 'unexclude', ids: [btn('[data-g-unexclude]').dataset.gUnexclude] }, { op: 'add', ids: [btn('[data-g-unexclude]').dataset.gUnexclude] }]);
    if (btn('[data-g-find]')) return search();
    if (btn('[data-g-add-checked]')) {
      const ids = [...similarChecked];
      similar = [];
      similarChecked = new Set();
      await change([{ op: 'add', ids }]);
      return search(); // gleich die nächste Runde
    }
    if (btn('[data-g-exclude-unchecked]')) {
      const ids = similar.filter((s) => !similarChecked.has(s.id)).map((s) => s.id);
      similar = similar.filter((s) => similarChecked.has(s.id));
      return change([{ op: 'exclude', ids }]);
    }
    if (btn('[data-g-apply]')) return apply(g);
    if (btn('[data-g-transfer]')) return transfer(g);
  });

  card.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-sim]');
    if (cb) {
      if (cb.checked) similarChecked.add(cb.dataset.sim);
      else similarChecked.delete(cb.dataset.sim);
      const b = card.querySelector('[data-g-add-checked]');
      if (b) b.textContent = `Angehakte hinzufügen (${similarChecked.size})`;
      const u = card.querySelector('[data-g-exclude-unchecked]');
      if (u) u.textContent = `Nicht angehakte: gehört nicht dazu (${similar.length - similarChecked.size})`;
      return;
    }
    if (e.target.matches('[data-g-name]')) {
      const name = e.target.value.trim();
      if (name && name !== group()?.name) change([{ op: 'set', name }]);
    }
  });

  function search() {
    const g = group();
    if (!g) return;
    similar = findSimilar(index, g.include, g.exclude);
    similarChecked = new Set(similar.filter((s) => s.sure).map((s) => s.id));
    render();
    if (!similar.length) ctx.toast('Keine weiteren ähnlichen Buchungen gefunden.');
  }

  /** Regeln der Gruppe ins Labor übernehmen (ersetzt frühere Regeln derselben Gruppe). */
  async function apply(g, { quiet = false } = {}) {
    const plan = proposeRules(fullIndex(), g.include, { kind: g.kind, name: g.name, groupId: g.id });
    const clean = plan.rules.map(({ label, count, oneOff, ...rule }) => rule);
    const others = ctx.getRules().filter((r) => r.groupId !== g.id);
    // Kategorie-Gruppen vorne einreihen (die erste passende Regel bestimmt die Kategorie)
    const next = g.kind === 'category' ? [...clean, ...others] : [...others, ...clean];
    const ok = await ctx.setRules(next);
    if (!ok) return;
    await change([{ op: 'set', status: 'uebernommen', ruleIds: clean.map((r) => r.id) }], g.id);
    if (!quiet) ctx.toast(`„${g.name}“ übernommen: ${clean.length} Regel${clean.length === 1 ? '' : 'n'} im Labor.`);
  }

  const fireflyGroupTitle = (g) => `Dashboard: ${g.name}`;

  /**
   * Nur diese Gruppe nach Firefly: Regeln in eine eigene Firefly-Regelgruppe
   * (wiedergefunden über „gid:<id>“, auch nach Umbenennen), anwenden im gewählten
   * Zeitraum, einzelne Buchungen direkt setzen.
   */
  async function transfer(g) {
    const plan = proposeRules(fullIndex(), g.include, { kind: g.kind, name: g.name, groupId: g.id });
    const period = card.querySelector('[data-g-period]')?.value || 'none';
    const permanent = plan.rules.filter((r) => !r.oneOff).map(({ label, count, oneOff, ...rule }) => rule);
    const oneOffIds = plan.rules.filter((r) => r.oneOff).flatMap((r) => String(r.when[0].value).split(','));
    const oneOffTx = oneOffIds.map((id) => fullById.get(id)).filter(Boolean);
    // ältere Buchungen (außerhalb der 24 Monate): über den gespeicherten Verweis aus Firefly holen
    const older = outsideOf(g).withRef;
    if (older.length) {
      const wanted = new Set(older);
      const groupIds = [...new Set(older.map((id) => g.refs[id]))];
      const fetched = await Promise.all(groupIds.map((gid) => api.get(`transactions/${gid}`)
        .then((r) => (r?.data ? api.flattenTransactions([r.data]) : [])).catch(() => [])));
      oneOffTx.push(...fetched.flat().filter((t) => wanted.has(String(t.transaction_journal_id))));
    }
    const lines = [
      permanent.length ? `• ${permanent.length} Regel(n) in Firefly-Regelgruppe „${fireflyGroupTitle(g)}“ anlegen/aktualisieren` : '',
      permanent.length ? `• anwenden auf: ${PERIODS[period]}` : '',
      oneOffTx.length ? `• ${oneOffTx.length} einzelne Buchung(en) direkt setzen` : '',
    ].filter(Boolean);
    if (!window.confirm(`„${g.name}“ nach Firefly übertragen?\n\n${lines.join('\n')}\n\nDas ändert Daten in Firefly.`)) return;
    const button = card.querySelector('[data-g-transfer]');
    if (button) {
      button.disabled = true;
      button.textContent = 'Überträgt … (kann ein paar Minuten dauern)';
    }
    await apply(g, { quiet: true }); // Labor-Regeln auf denselben Stand bringen
    const result = { ok: true, rules: 0, oneOff: 0, period, message: '' };
    try {
      if (permanent.length || g.transfer) {
        const today = new Date();
        const regeln = toFireflyRules(permanent).filter((r) => !r.hinweis)
          .map((r, i, all) => ({ ...r, order: all.length - i, description: `Aus der Dashboard-Gruppe „${g.name}“ · id:${r.labor_id}` }));
        const payload = {
          typ: 'regeln_anlegen',
          gruppe: fireflyGroupTitle(g),
          gruppe_key: `gid:${g.id}`,
          regeln,
          anwenden: !regeln.length || period === 'none' ? null
            : { start: period === 'all' ? '2000-01-01' : isoDay(new Date(today.getFullYear(), today.getMonth() - 24, 1)), end: isoDay(today) },
        };
        const res = await ctx.runAction(ctx.actions.rules, payload);
        if (!res.ok) throw new Error(`Regeln: ${res.status ? `HTTP ${res.status}` : res.response || 'fehlgeschlagen'}`);
        result.rules = regeln.length;
      }
      if (oneOffTx.length) {
        const payload = {
          typ: 'kategorien_uebernehmen',
          aenderungen: oneOffTx.map((t) => ({
            transaction_group_id: t.groupId, transaction_journal_id: t.transaction_journal_id, datum: String(t.date).slice(0, 10),
            beschreibung: t.description, betrag: t.amount, kategorie_alt: t.category_name || null,
            ...(g.kind === 'category' ? { kategorie: g.name } : { kategorie: null, tags: [...new Set([...(t.tags || []), g.name])] }),
          })),
        };
        const res = await ctx.runAction(ctx.actions.categorize, payload);
        if (!res.ok) throw new Error(`Einzelne Buchungen: ${res.status ? `HTTP ${res.status}` : res.response || 'fehlgeschlagen'}`);
        result.oneOff = oneOffTx.length;
      }
    } catch (err) {
      result.ok = false;
      result.message = err.message;
    }
    api.forget();
    await change([{ op: 'set', transfer: result }], g.id);
    ctx.toast(result.ok ? `„${g.name}“ ist in Firefly: ${result.rules} Regeln, ${result.oneOff} einzelne Buchungen.` : `Übertragung fehlgeschlagen: ${result.message}`);
  }

  // Häkchen in den übrigen Labor-Listen (ctx.view ist der Container dieser Seite)
  ctx.view.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-pick]');
    if (!cb) return;
    if (cb.checked) picked.add(cb.dataset.pick);
    else picked.delete(cb.dataset.pick);
    ctx.view.querySelectorAll(`[data-pick="${CSS.escape(cb.dataset.pick)}"]`).forEach((x) => (x.checked = cb.checked));
    renderBar();
  });
  const clearPicked = () => {
    picked.clear();
    ctx.view.querySelectorAll('[data-pick]').forEach((x) => (x.checked = false));
    renderBar();
  };
  bar.addEventListener('click', async (e) => {
    const ok = e.target.closest('[data-pick-ok]');
    if (ok || e.target.closest('[data-pick-unok]')) {
      const ids = [...picked];
      clearPicked();
      return ctx.onReviewed?.(ids, Boolean(ok));
    }
    if (e.target.closest('[data-pick-clear]')) {
      picked.clear();
      ctx.view.querySelectorAll('[data-pick]').forEach((x) => (x.checked = false));
      return renderBar();
    }
    if (e.target.closest('[data-pick-new]')) {
      const name = window.prompt('Name der neuen Gruppe (Kategorie oder Tag – lässt sich später ändern):', '');
      if (name === null) return;
      await create(name.trim() || 'Neue Gruppe', 'category', [...picked], `${picked.size} von Hand ausgewählte Buchungen`);
      picked.clear();
      ctx.view.querySelectorAll('[data-pick]').forEach((x) => (x.checked = false));
      renderBar();
    }
  });
  /**
   * Schnell: Kategorie/Tag für die Auswahl setzen. Dahinter steckt eine Gruppe mit
   * diesem Namen (gibt es sie schon, wird sie ergänzt), die gleich als Labor-Regel
   * übernommen wird – nach Firefly geht es wie gewohnt über die Gruppe.
   */
  async function quickSet(kind, name) {
    const ids = [...picked];
    const existing = data.groups.find((g) => g.kind === kind && g.name.toLowerCase() === name.toLowerCase());
    let g;
    try {
      g = existing
        ? await request(`/${encodeURIComponent(existing.id)}`, { method: 'POST', body: { ops: [{ op: 'add', ids }] } })
        : await request('', { method: 'POST', body: { name, kind, include: ids, source: `${ids.length} im Labor ausgewählte Buchungen`, basis: ctx.basis } });
    } catch (err) {
      ctx.toast(`Nicht gespeichert: ${err.message}`);
      return;
    }
    replaceGroup(g);
    clearPicked();
    await apply(g, { quiet: true });
    ctx.toast(`${ids.length} Buchung${ids.length === 1 ? '' : 'en'} → ${KIND[kind]} „${g.name}“ (Gruppe ${existing ? 'ergänzt' : 'angelegt'}, im Labor übernommen). `
      + 'Nach Firefly: Gruppe öffnen → „Nach Firefly übertragen“.');
  }
  bar.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target.closest('[data-quick]');
    const name = form?.v.value.trim();
    if (name && picked.size) quickSet(form.dataset.quick, name);
  });

  bar.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-pick-to]');
    if (!sel || !sel.value) return;
    openId = sel.value;
    await change([{ op: 'add', ids: [...picked] }]);
    ctx.toast(`${picked.size} Buchung${picked.size === 1 ? '' : 'en'} zu „${group()?.name}“ hinzugefügt.`);
    picked.clear();
    ctx.view.querySelectorAll('[data-pick]').forEach((x) => (x.checked = false));
    renderBar();
  });

  reload();

  return {
    /** Häkchen-Zelle für eine Buchungszeile in anderen Labor-Listen. */
    pickCell: (t) => `<td class="pick-cell"><input type="checkbox" data-pick="${esc(idOf(t))}" ${picked.has(idOf(t)) ? 'checked' : ''} aria-label="für eine Gruppe auswählen"></td>`,
    /** Mehrere Buchungen auf einmal auswählen (z. B. „Alle angezeigten“). */
    pickMany: (ids) => {
      ids.forEach((id) => picked.add(String(id)));
      ids.forEach((id) => ctx.view.querySelectorAll(`[data-pick="${CSS.escape(String(id))}"]`).forEach((x) => (x.checked = true)));
      renderBar();
    },
    /** Journal-IDs aller Buchungen in irgendeiner Gruppe (für den Bearbeitungsstand). */
    memberIds: () => {
      memberCache ||= new Set(data.groups.flatMap((g) => g.include));
      return memberCache;
    },
    /** Gruppe aus einem Vorschlag starten. */
    createFrom: (name, kind, list, source) => create(name, kind, list.map(idOf), source),
    reload,
  };
}
