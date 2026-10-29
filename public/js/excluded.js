// Ausgeblendete Buchungen (lib/excluded.js): zählen in Auswertungen nicht mit – Firefly bleibt
// unverändert. Hier: Regeln laden/ändern und die Knöpfe in den Buchungsdetails.

import * as api from './api.js';
import { money, esc, fmtDate } from './util.js';

let rulesP = null;

const call = (method, { body, id } = {}) =>
  fetch(`/local/excluded${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
    return data.rules || [];
  });

/** Alle Regeln (einmal je Seitenaufruf vom Server). */
export function loadExcluded() {
  rulesP ||= call('GET').catch(() => []);
  return rulesP;
}

/** Nach einer Änderung: Zwischenspeicher verwerfen und die Seite neu zeichnen (Summen ändern sich). */
function changed(rules) {
  rulesP = Promise.resolve(rules);
  api.forget();
  window.dispatchEvent(new Event('ffd-excluded'));
  return rules;
}

export const addExcluded = (rule) => call('POST', { body: rule }).then(changed);
export const removeExcluded = (id) => call('DELETE', { id }).then(changed);

export const partnerOf = (t) => (t.type === 'deposit' ? t.source_name : t.destination_name);
const norm = (s) => String(s ?? '').trim().toLowerCase();
export const RICHTUNG = { beide: 'Ein- und Ausgänge', eingang: 'nur Eingänge', ausgang: 'nur Ausgänge' };

/** Die Regel, nach der t ausgeblendet ist – oder null. Wie isExcluded in lib/excluded.js. */
export function ruleFor(t, rules) {
  if (t.type !== 'withdrawal' && t.type !== 'deposit') return null;
  const dir = t.type === 'deposit' ? 'eingang' : 'ausgang';
  return rules.find((r) => r.art === 'buchung' && String(r.j) === String(t.transaction_journal_id))
    || rules.find((r) => r.art === 'gegenkonto' && norm(r.name) === norm(partnerOf(t)) && (r.richtung === 'beide' || r.richtung === dir))
    || null;
}

/** Bereich „Auswertungen“ in den Buchungsdetails (nur Ein- und Ausgänge). */
export async function enhanceExclude(box, t) {
  if (!box || (t.type !== 'withdrawal' && t.type !== 'deposit')) return;
  const rules = await loadExcluded();
  if (!box.isConnected) return;
  const partner = partnerOf(t);
  const rule = ruleFor(t, rules);
  const dir = t.type === 'deposit' ? 'eingang' : 'ausgang';
  if (rule?.art === 'buchung') {
    box.innerHTML = `<p><span class="badge warn">Ausgeblendet</span> Zählt nicht in Einnahmen, Ausgaben und Auswertungen.</p>
      <div class="tx-edit-row"><button class="btn small" data-x="show">Wieder einblenden</button></div>`;
  } else if (rule) {
    box.innerHTML = `<p><span class="badge warn">Ausgeblendet</span> Alle Buchungen mit „${esc(rule.name)}“ (${RICHTUNG[rule.richtung]}) zählen nicht mit.</p>
      <div class="tx-edit-row"><button class="btn small" data-x="show">Regel für „${esc(rule.name)}“ entfernen</button></div>`;
  } else {
    box.innerHTML = `<p class="muted">Durchlaufender Posten (z. B. Geld, das nur weitergereicht wird)? Ausblenden nimmt ihn aus Einnahmen, Ausgaben und allen Auswertungen – Firefly bleibt unverändert.</p>
      <div class="tx-edit-row"><button class="btn small" data-x="one">Diese Buchung ausblenden</button>
      ${partner ? `<button class="btn small" data-x="partner">Alle ${dir === 'eingang' ? 'Eingänge von' : 'Ausgänge an'} „${esc(partner)}“ ausblenden</button>` : ''}</div>`;
  }
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-x]');
    if (!btn) return;
    btn.disabled = true;
    try {
      if (btn.dataset.x === 'show') await removeExcluded(rule.id);
      else if (btn.dataset.x === 'partner') await addExcluded({ art: 'gegenkonto', name: partner, richtung: dir });
      else {
        await addExcluded({
          art: 'buchung', j: t.transaction_journal_id,
          info: { date: String(t.date).slice(0, 10), amount: t.amount, currency: t.currency_code, description: t.description, partner, type: t.type },
        });
      }
    } catch (err) {
      btn.disabled = false;
      box.insertAdjacentHTML('beforeend', `<p class="tx-edit-status bad">Fehler: ${esc(err.message)}</p>`);
    }
  });
}

/** Kurzbeschreibung einer Regel für Listen. */
export function ruleLabel(r) {
  if (r.art === 'gegenkonto') return { title: `Alle mit „${r.name}“`, sub: RICHTUNG[r.richtung] || '' };
  const i = r.info || {};
  const amount = i.amount ? money(i.type === 'deposit' ? i.amount : -i.amount, i.currency || 'EUR') : '';
  return { title: i.description || `Buchung ${r.j}`, sub: [i.date && fmtDate(i.date), i.partner, amount].filter(Boolean).join(' · ') };
}
