// Buchungen aus dem Dashboard heraus ändern – über n8n-Automationen
// (Auslöser „Kategorie übernehmen“ / „Tags setzen“). Das Dashboard selbst
// schreibt nie in Firefly; das übernimmt der Workflow.

import * as api from './api.js';
import { esc } from './util.js';

let actionsPromise = null;
/** Automationen einmal je Seitenaufruf laden. */
function loadActions() {
  actionsPromise ||= fetch('/local/actions').then((r) => r.json()).catch(() => []);
  return actionsPromise;
}

/** Automation mit diesem Auslöser, falls eingerichtet. */
export const actionFor = (trigger) => loadActions().then((list) => list.find((a) => a.trigger === trigger) || null);

const partyOf = (t) => (t.type === 'deposit' ? t.source_name : t.destination_name);

/** Gemeinsame Angaben zur Buchung für den Workflow. */
const baseContext = (t) => ({
  transaction_group_id: t.groupId,
  transaction_journal_id: t.transaction_journal_id,
  beschreibung: t.description,
  empfaenger: partyOf(t),
  betrag: t.amount,
  datum: String(t.date).slice(0, 10),
});

/** Startet eine Automation; liefert die Antwort des Servers ({ ok, status, response }). */
export async function runAction(action, context) {
  const res = await fetch(`/local/actions/${encodeURIComponent(action.id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' },
    body: JSON.stringify({ context }),
  }).then((r) => r.json());
  if (res.ok) api.forget(); // Daten haben sich geändert
  return res;
}

export const setCategory = (action, t, name, id) =>
  runAction(action, { typ: 'kategorie_setzen', ...baseContext(t), kategorie: name, kategorie_id: id ?? null });

export const setTags = (action, t, tags, change = {}) =>
  runAction(action, { typ: 'tags_setzen', ...baseContext(t), tags, tag_hinzugefuegt: change.added ?? null, tag_entfernt: change.removed ?? null });

let listsPromise = null;
function loadLists() {
  listsPromise ||= Promise.all([
    api.getAll('categories').then((l) => l.map((c) => ({ id: c.id, name: c.attributes.name }))).catch(() => []),
    api.getAll('tags').then((l) => l.map((x) => x.attributes.tag)).catch(() => []),
  ]).then(([categories, tags]) => {
    const byName = (a, b) => a.localeCompare(b, 'de');
    categories.sort((a, b) => byName(a.name, b.name));
    tags.sort(byName);
    // gemeinsame Auswahllisten für alle Eingabefelder
    document.getElementById('ffd-cat-list')?.remove();
    document.getElementById('ffd-tag-list')?.remove();
    document.body.insertAdjacentHTML('beforeend',
      `<datalist id="ffd-cat-list">${categories.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
       <datalist id="ffd-tag-list">${tags.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`);
    return { categories, tags };
  });
  return listsPromise;
}

const status = (el, text, cls = '') => {
  el.className = `tx-edit-status ${cls}`;
  el.textContent = text;
};

/**
 * Füllt den Bereich „Ändern“ in aufgeklappten Buchungsdetails. onChange wird
 * nach einer erfolgreichen Änderung aufgerufen (Details neu zeichnen).
 */
export async function enhanceTxEdit(slot, t, onChange) {
  if (!slot || t.type === 'opening balance' || t.type === 'reconciliation') return;
  const [catAction, tagAction] = await Promise.all([actionFor('categorize'), actionFor('tags')]);
  if (!slot.isConnected) return;
  if (!catAction && !tagAction) {
    slot.innerHTML = `<p class="muted">Kategorie und Tags direkt hier ändern: in den <a href="#/automationen">Automationen</a> einen n8n-Workflow mit
      Auslöser „Kategorie übernehmen“ bzw. „Tags setzen“ anlegen (Vorlage: <code>n8n/firefly-buchung-bearbeiten.json</code>).</p>`;
    return;
  }
  const { categories } = await loadLists();
  if (!slot.isConnected) return;
  const tags = [...(t.tags || [])];
  slot.innerHTML = `
    ${catAction ? `<form class="tx-edit-row" data-form="cat">
      <label>Kategorie <input name="cat" list="ffd-cat-list" value="${esc(t.category_name || '')}" placeholder="Kategorie wählen …" autocomplete="off"></label>
      <button class="btn small">Setzen</button></form>` : ''}
    ${tagAction ? `<form class="tx-edit-row" data-form="tag">
      <span class="tx-edit-tags">${tags.map((x) => `<span class="tag">${esc(x)} <button type="button" class="chip-x" data-untag="${esc(x)}" aria-label="Tag ${esc(x)} entfernen">✕</button></span>`).join('')}</span>
      <label>Tag <input name="tag" list="ffd-tag-list" placeholder="Tag hinzufügen …" autocomplete="off"></label>
      <button class="btn small">Hinzufügen</button></form>` : ''}
    <div class="tx-edit-status" role="status"></div>`;
  const out = slot.querySelector('.tx-edit-status');

  const busy = (on) => slot.querySelectorAll('button, input').forEach((el) => (el.disabled = on));
  const apply = async (label, run, onOk) => {
    busy(true);
    status(out, `${label} – sende an n8n …`);
    try {
      const res = await run();
      if (!res.ok) throw new Error(res.status ? `HTTP ${res.status}` : res.response || res.message || 'fehlgeschlagen');
      onOk();
      onChange?.();
    } catch (err) {
      busy(false);
      status(out, `Fehler: ${err.message}`, 'bad');
    }
  };

  slot.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.dataset.form === 'cat') {
      const name = form.cat.value.trim();
      if (!name || name === t.category_name) return;
      const known = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!known && !window.confirm(`Kategorie „${name}“ gibt es noch nicht – neu anlegen lassen?`)) return;
      const finalName = known?.name || name;
      apply(`Kategorie „${finalName}“`, () => setCategory(catAction, t, finalName, known?.id), () => {
        t.category_name = finalName;
        t.category_id = known?.id ?? null;
      });
    } else {
      const tag = form.tag.value.trim();
      if (!tag || tags.includes(tag)) return;
      apply(`Tag „${tag}“`, () => setTags(tagAction, t, [...tags, tag], { added: tag }), () => (t.tags = [...tags, tag]));
    }
  });
  slot.addEventListener('click', (e) => {
    const x = e.target.closest('[data-untag]');
    if (!x) return;
    const tag = x.dataset.untag;
    const next = tags.filter((v) => v !== tag);
    apply(`Tag „${tag}“ entfernen`, () => setTags(tagAction, t, next, { removed: tag }), () => (t.tags = next));
  });
}
