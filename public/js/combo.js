// Eigene Auswahlliste für Eingabefelder mit <datalist> (Kategorien, Tags,
// Gegenkonten …). Die Browser-Liste erscheint am Handy oft gar nicht oder nur
// als unauffällige Leiste über der Tastatur – dann legt man aus Versehen
// „Lebensmitel“ neben „Lebensmittel“ an. Diese Liste zeigt beim Tippen, was es
// schon gibt, warnt vor ähnlichen Namen und markiert, was neu angelegt würde.
// Greift automatisch für jedes <input list="…">.

import { esc } from './util.js';

const MAX = 50;
const norm = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/** Tippfehler-Abstand (Levenshtein), bricht oberhalb von max ab. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Ist `name` dem getippten Wert ähnlich (Tippfehler, Mehrzahl, Bindestrich …)? */
export function similar(typed, name) {
  const a = norm(typed);
  const b = norm(name);
  if (a.length < 3 || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && (b.startsWith(a) || a.startsWith(b))) return true;
  return distance(a, b, a.length >= 8 ? 2 : 1) <= (a.length >= 8 ? 2 : 1);
}

/** Treffer für den getippten Wert: genau, passend (enthält) und ähnlich. */
export function matches(typed, options) {
  const q = String(typed || '').trim();
  const lq = q.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === lq) || null;
  if (!q) return { exact, list: options.slice(0, MAX), similar: [] };
  const starts = [];
  const contains = [];
  for (const o of options) {
    const lo = o.toLowerCase();
    if (lo.startsWith(lq)) starts.push(o);
    else if (lo.includes(lq) || norm(o).includes(norm(q))) contains.push(o);
  }
  const list = [...starts, ...contains];
  const seen = new Set(list);
  const sim = exact ? [] : options.filter((o) => !seen.has(o) && similar(q, o)).slice(0, 5);
  return { exact, list: list.slice(0, MAX), similar: sim };
}

let pop = null; // { el, input, items, active }

function optionsOf(input) {
  const dl = document.getElementById(input.dataset.combo);
  return dl ? [...dl.options].map((o) => o.value).filter(Boolean) : [];
}

function close() {
  if (!pop) return;
  pop.el.remove();
  pop.input.setAttribute('aria-expanded', 'false');
  pop = null;
}

function place() {
  if (!pop) return;
  const r = pop.input.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewH = vv ? vv.height + vv.offsetTop : window.innerHeight;
  const below = viewH - r.bottom - 8;
  const above = r.top - 8;
  const up = below < 180 && above > below;
  const el = pop.el;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 220) - 8))}px`;
  el.style.width = `${Math.max(r.width, 220)}px`;
  el.style.maxHeight = `${Math.max(120, Math.min(300, up ? above : below))}px`;
  if (up) { el.style.top = ''; el.style.bottom = `${window.innerHeight - r.top + 4}px`; }
  else { el.style.bottom = ''; el.style.top = `${r.bottom + 4}px`; }
}

function render() {
  if (!pop) return;
  const { input, el } = pop;
  const value = input.value.trim();
  const m = matches(value, optionsOf(input));
  const items = [];
  let html = '';
  const row = (v, extra = '') => {
    items.push(v);
    return `<div class="combo-item${extra}" role="option" data-i="${items.length - 1}">${esc(v)}</div>`;
  };
  const isNew = value && !m.exact;
  if (isNew && m.similar.length) html += `<div class="combo-head">Meintest du?</div>${m.similar.map((v) => row(v, ' similar')).join('')}`;
  if (m.list.length) {
    if (isNew && m.similar.length) html += '<div class="combo-head">Vorhanden</div>';
    html += m.list.map((v) => row(v, m.exact === v ? ' exact' : '')).join('');
  } else if (!value) html += '<div class="combo-head">Noch nichts vorhanden – einfach eintippen</div>';
  // Hinweis „neu“: oben, wenn nichts passt – sonst unauffällig am Ende (beim Tippen eines Anfangs)
  if (isNew) {
    const note = `<div class="combo-new${m.list.length || m.similar.length ? ' end' : ''}">Neu: „${esc(value)}“ – gibt es noch nicht</div>`;
    html = m.list.length || m.similar.length ? html + note : note + html;
  }
  if (!html) return close();
  pop.items = items;
  pop.active = -1;
  el.innerHTML = html;
  place();
}

function open(input) {
  if (pop?.input === input) return render();
  close();
  const el = document.createElement('div');
  el.className = 'combo-pop';
  el.setAttribute('role', 'listbox');
  (input.closest('dialog') || document.body).append(el);
  pop = { el, input, items: [], active: -1 };
  input.setAttribute('aria-expanded', 'true');
  el.addEventListener('pointerdown', (e) => e.preventDefault()); // Fokus im Feld lassen
  el.addEventListener('click', (e) => {
    const it = e.target.closest('[data-i]');
    if (it) pick(pop.items[Number(it.dataset.i)]);
  });
  render();
}

function pick(value) {
  if (!pop) return;
  const { input } = pop;
  input.value = value;
  close();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function highlight(step) {
  if (!pop?.items.length) return;
  pop.active = (pop.active + step + pop.items.length) % pop.items.length;
  pop.el.querySelectorAll('.combo-item').forEach((n, i) => n.classList.toggle('active', i === pop.active));
  pop.el.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
}

/** Feld übernehmen: Browser-Liste abschalten, eigene Liste anbinden. */
function enhance(input) {
  if (input.dataset.combo) return;
  input.dataset.combo = input.getAttribute('list');
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
}

document.addEventListener('pointerdown', (e) => {
  const input = e.target.closest?.('input[list]');
  if (input) enhance(input);
}, true);
document.addEventListener('focusin', (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.hasAttribute('list')) enhance(input);
  if (input.dataset.combo) open(input);
});
document.addEventListener('focusout', (e) => {
  if (pop && e.target === pop.input) setTimeout(() => { if (pop && document.activeElement !== pop.input) close(); }, 120);
});
document.addEventListener('input', (e) => {
  if (e.target.dataset?.combo && e.isTrusted) {
    if (pop?.input === e.target) render();
    else open(e.target);
  }
});
document.addEventListener('keydown', (e) => {
  if (!pop || e.target !== pop.input) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); highlight(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(-1); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'Enter' && pop.active >= 0) { e.preventDefault(); pick(pop.items[pop.active]); }
  else if (e.key === 'Enter' || e.key === 'Tab') close();
});
window.addEventListener('resize', place);
window.visualViewport?.addEventListener('resize', place);
document.addEventListener('scroll', (e) => {
  if (pop && !pop.el.contains(e.target)) place();
}, true);
window.addEventListener('hashchange', close);
