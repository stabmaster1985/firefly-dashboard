// Gruppen im Kategorien-Labor: Buchungen von Hand zusammenstellen, Ähnliches
// finden lassen, Gegenbeispiele markieren und daraus Regeln bilden.
// Gespeichert wird alles auf dem Server (lib/groups.js) – Schritt für Schritt,
// damit die Arbeit über Tage, Geräte und Updates hinweg erhalten bleibt.

import { money, esc, fmtDate } from './util.js';
import { txAttrs, bindTxDetails } from './common.js';
import { counterpartyOf } from './rules.js';
import { buildIndex, findSimilar, proposeRules } from './similar.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const KIND = { category: 'Kategorie', tag: 'Tag' };
const idOf = (t) => String(t.transaction_journal_id);

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
  const index = buildIndex(txs);
  const byId = new Map(txs.map((t) => [idOf(t), t]));
  const picked = new Set(); // Auswahl in den Listen (nur in dieser Sitzung)
  let data = { groups: [], trash: [] };
  let openId = null;
  let similar = [];
  let similarChecked = new Set();
  let showTrash = false;

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
    if (openId && !group()) openId = null; // z. B. auf einem anderen Gerät gelöscht
    render();
  }

  /** Eine Änderung speichern; bei Erfolg den Stand vom Server übernehmen. */
  async function change(ops) {
    const g = group();
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

  function renderList() {
    const open = data.groups.filter((g) => g.status !== 'uebernommen');
    const done = data.groups.filter((g) => g.status === 'uebernommen');
    const row = (g) => {
      const here = g.include.filter((id) => byId.has(id)).length;
      return `<div class="row group-row${g.id === openId ? ' active' : ''}">
        <div class="avatar">${g.kind === 'tag' ? '#' : '▣'}</div>
        <div style="min-width:0"><div class="title">${esc(g.name)} <span class="badge">${KIND[g.kind]}</span>${g.status === 'uebernommen' ? ' <span class="badge good">übernommen</span>' : ''}</div>
          <div class="subtitle">${g.include.length} Buchung${g.include.length === 1 ? '' : 'en'}${here < g.include.length ? ` (${here} in dieser Ansicht)` : ''}${g.exclude.length ? ` · ${g.exclude.length} ausgeschlossen` : ''} · zuletzt ${fmtDate(g.updatedAt)}</div></div>
        <div class="amount"><button class="btn small" data-g-open="${esc(g.id)}">${g.id === openId ? 'Schließen' : 'Bearbeiten'}</button></div></div>`;
    };
    return `${data.groups.length
      ? `<div class="list">${[...open, ...done].map(row).join('')}</div>`
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
    const plan = members.length ? proposeRules(index, g.include, { kind: g.kind, name: g.name, groupId: g.id }) : null;
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
      ${missing ? `<p class="muted small-text">${missing} weitere Buchung${missing === 1 ? '' : 'en'} gespeichert, aber nicht in dieser Ansicht (älter als 24 Monate, in Firefly gelöscht oder ${g.basis === 'einnahmen' ? 'Ausgaben' : 'Einnahmen'}-Ansicht) – sie bleiben erhalten.</p>` : ''}
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
          <span class="muted small-text">${plan.permanent} Regel${plan.permanent === 1 ? '' : 'n'} ohne Fehltreffer${plan.oneOff ? `, ${plan.oneOff} einzeln` : ''}. Die Gruppe bleibt gespeichert und lässt sich später weiter bearbeiten.</span></div>` : ''}
    </div>`;
  }

  function render() {
    const g = group();
    card.innerHTML = `${renderList()}${g ? renderEditor(g) : ''}`;
    renderBar();
  }

  function renderBar() {
    if (!picked.size) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const target = data.groups.filter((g) => g.status !== 'uebernommen' || g.id === openId);
    bar.innerHTML = `<span><b>${picked.size}</b> ausgewählt</span>
      <button class="btn small primary" data-pick-new>Neue Gruppe …</button>
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
  async function apply(g) {
    const plan = proposeRules(index, g.include, { kind: g.kind, name: g.name, groupId: g.id });
    const clean = plan.rules.map(({ label, count, oneOff, ...rule }) => rule);
    const others = ctx.getRules().filter((r) => r.groupId !== g.id);
    // Kategorie-Gruppen vorne einreihen (die erste passende Regel bestimmt die Kategorie)
    const next = g.kind === 'category' ? [...clean, ...others] : [...others, ...clean];
    const ok = await ctx.setRules(next);
    if (!ok) return;
    await change([{ op: 'set', status: 'uebernommen', ruleIds: clean.map((r) => r.id) }]);
    ctx.toast(`„${g.name}“ übernommen: ${clean.length} Regel${clean.length === 1 ? '' : 'n'} im Labor.`);
  }

  // Häkchen in den übrigen Labor-Listen
  ctx.view.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-pick]');
    if (!cb) return;
    if (cb.checked) picked.add(cb.dataset.pick);
    else picked.delete(cb.dataset.pick);
    ctx.view.querySelectorAll(`[data-pick="${CSS.escape(cb.dataset.pick)}"]`).forEach((x) => (x.checked = cb.checked));
    renderBar();
  });
  bar.addEventListener('click', async (e) => {
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
    /** Gruppe aus einem Vorschlag starten. */
    createFrom: (name, kind, list, source) => create(name, kind, list.map(idOf), source),
    reload,
  };
}
