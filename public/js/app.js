// Einstieg: Routing, Zeitraum, Theme und Verbindungsprüfung.

import * as api from './api.js';
import * as views from './views.js';
import { categories, categoryDetail, tags, tagDetail, forecastEnabled } from './categories.js';
import { recurring } from './recurring.js';
import { accountDetail } from './account.js';
import { actions } from './actions.js';
import { applyCardFilter } from './common.js';
import { destroyCharts } from './charts.js';
import { PERIODS, periodById, customPeriodId, parseDate, isoDate, debounce, storage, store, esc } from './util.js';

const ROUTES = {
  '': { view: views.overview, title: 'Übersicht', nav: 'overview' },
  kategorien: { view: categories, title: 'Kategorien', nav: 'categories' },
  tags: { view: tags, title: 'Tags', nav: 'tags' },
  wiederkehrend: { view: recurring, title: 'Wiederkehrend', nav: 'recurring', noPeriod: true },
  buchungen: { view: views.transactions, title: 'Buchungen', nav: 'transactions' },
  konten: { view: views.accounts, title: 'Konten', nav: 'accounts' },
  automationen: { view: actions, title: 'Automationen', nav: 'actions' },
};
const DETAIL = {
  kategorien: { view: categoryDetail, title: 'Kategorie', nav: 'categories' },
  tags: { view: tagDetail, title: 'Tag', nav: 'tags' },
  konten: { view: accountDetail, title: 'Konto', nav: 'accounts' },
};

const viewEl = document.getElementById('view');
const titleEl = document.getElementById('page-title');
const periodSelect = document.getElementById('period-select');
const refreshBtn = document.getElementById('refresh-btn');
const themeBtn = document.getElementById('theme-btn');
const forecastBtn = document.getElementById('forecast-btn');

let connectionError = null;

// ---- Zeitraum ---------------------------------------------------------------

let currentPeriod = storage('ffd-period', 'this-month');

function fillPeriodOptions() {
  const custom = periodById(currentPeriod);
  if (!custom.custom && !PERIODS.some((p) => p.id === currentPeriod)) currentPeriod = 'this-month';
  periodSelect.innerHTML = PERIODS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('') +
    (custom.custom ? `<option value="${esc(currentPeriod)}">${esc(custom.label)}</option>` : '') +
    '<option value="custom">Eigener Zeitraum …</option>';
  periodSelect.value = currentPeriod;
}
fillPeriodOptions();

function parseHash() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { path: path.replace(/\/$/, ''), params: new URLSearchParams(qs) };
}

async function render() {
  tooltip.hidden = true;
  const { path, params } = parseHash();
  const [section, id] = path.split('/');
  const route = (id && DETAIL[section]) || ROUTES[path] || ROUTES[''];
  destroyCharts();
  titleEl.textContent = route.title;
  document.title = `${route.title} · Firefly Dashboard`;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route.nav));
  document.querySelector('.period-wrap').hidden = Boolean(route.noPeriod);
  forecastBtn.hidden = Boolean(route.noPeriod);

  if (connectionError) return showConnectionError(connectionError);
  const period = periodById(currentPeriod);
  window.scrollTo({ top: 0 });
  await route.view(viewEl, { period, params, id: id && decodeURIComponent(id) });
}

function showConnectionError(err) {
  const hint =
    err.status === 401
      ? 'Der Access Token wurde abgelehnt. Prüfe <code>FIREFLY_TOKEN</code> – erstellen kannst du ihn in Firefly unter <em>Optionen → Profil → OAuth → Persönliche Zugangs-Tokens</em>.'
      : err.status === 502 || err.status === 0
        ? 'Firefly III ist nicht erreichbar. Prüfe <code>FIREFLY_URL</code> und ob die Instanz läuft.'
        : 'Unerwartete Antwort von Firefly III.';
  viewEl.innerHTML = `<section class="card error-card">
    <h2>Keine Verbindung zu Firefly III</h2>
    <p>${hint}</p>
    <p><small>Details: ${esc(err.message)}</small></p>
    <button class="btn primary" id="retry">Erneut versuchen</button>
  </section>`;
  viewEl.querySelector('#retry').addEventListener('click', () => connect());
}

async function connect() {
  try {
    const [about, user, config] = await Promise.all([
      api.get('about'),
      api.get('about/user').catch(() => null),
      fetch('/config.json').then((r) => r.json()).catch(() => ({})),
    ]);
    window.FFD_CONFIG = config;
    connectionError = null;
    const email = user?.data?.attributes?.email;
    document.getElementById('instance-info').innerHTML =
      `Firefly III ${esc(about?.data?.version || '')}${email ? `<br>${esc(email)}` : ''}`;
  } catch (err) {
    connectionError = err;
  }
  render();
}

// ---- Tooltips für Elemente mit data-tip ------------------------------------

const tooltip = document.getElementById('tooltip');
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return (tooltip.hidden = true);
  tooltip.textContent = el.dataset.tip;
  tooltip.hidden = false;
});
document.addEventListener('pointermove', (e) => {
  if (tooltip.hidden) return;
  const x = Math.min(e.clientX + 14, innerWidth - tooltip.offsetWidth - 8);
  const y = e.clientY + 18 + tooltip.offsetHeight > innerHeight ? e.clientY - tooltip.offsetHeight - 12 : e.clientY + 18;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
});
window.addEventListener('scroll', () => (tooltip.hidden = true), { passive: true });

// ---- Bedienelemente -------------------------------------------------------

window.addEventListener('hashchange', render);

const rangeForm = document.getElementById('custom-range');
const rangeFrom = document.getElementById('cr-from');
const rangeTo = document.getElementById('cr-to');

periodSelect.addEventListener('change', () => {
  if (periodSelect.value === 'custom') {
    const p = periodById(currentPeriod);
    rangeFrom.value = isoDate(p.start);
    rangeTo.value = isoDate(p.end);
    periodSelect.value = currentPeriod;
    rangeForm.hidden = false;
    rangeFrom.focus();
    return;
  }
  currentPeriod = periodSelect.value;
  store('ffd-period', currentPeriod);
  fillPeriodOptions();
  render();
});

rangeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  let from = parseDate(rangeFrom.value);
  let to = parseDate(rangeTo.value);
  if (!from || !to) return;
  if (from > to) [from, to] = [to, from];
  currentPeriod = customPeriodId(from, to);
  store('ffd-period', currentPeriod);
  rangeForm.hidden = true;
  fillPeriodOptions();
  render();
});
document.getElementById('cr-cancel').addEventListener('click', () => (rangeForm.hidden = true));

// ---- Prognose-Schalter (Standard: aus) -----------------------------------------

function syncForecastBtn() {
  const on = forecastEnabled();
  forecastBtn.setAttribute('aria-pressed', String(on));
  forecastBtn.title = on ? 'Prognose ausblenden' : 'Prognose einblenden (Hochrechnung für laufende Zeiträume)';
}
syncForecastBtn();
forecastBtn.addEventListener('click', () => {
  store('ffd-forecast', forecastEnabled() ? '0' : '1');
  syncForecastBtn();
  render();
});

// ---- Filterfelder in Karten ----------------------------------------------------

viewEl.addEventListener('input', (e) => {
  if (e.target.matches('.card-filter')) applyCardFilter(e.target);
});
// Inhalte, die nachgeladen oder neu sortiert werden, sofort wieder filtern
new MutationObserver((mutations) => {
  // eigene Hinweis-Änderungen („Nichts gefunden“) ignorieren
  const relevant = mutations.some((m) => !(m.target.classList?.contains('filter-empty') ||
    [...m.addedNodes, ...m.removedNodes].every((n) => n.classList?.contains('filter-empty'))));
  if (!relevant) return;
  viewEl.querySelectorAll('.card-filter').forEach((input) => input.value.trim() && applyCardFilter(input));
}).observe(viewEl, { childList: true, subtree: true });

// ---- Globale Suche ------------------------------------------------------------

const searchInput = document.getElementById('global-search');
const resultsEl = document.getElementById('search-results');
let searchIndex = null;
let activeResult = -1;

function loadSearchIndex() {
  searchIndex ??= Promise.all([
    api.getAll('categories').catch(() => []),
    api.getAll('accounts', { type: 'asset' }).catch(() => []),
    api.getAll('accounts', { type: 'expense' }).catch(() => []),
    api.getAll('accounts', { type: 'revenue' }).catch(() => []),
    api.getAll('tags').catch(() => []),
  ]).then(([cats, assets, expense, revenue, tagList]) => ({
    categories: cats.map((c) => ({ id: c.id, name: c.attributes.name })),
    tags: tagList.map((t) => ({ id: t.id, name: t.attributes.tag })),
    assets: assets.map((a) => a.attributes.name),
    payees: expense.map((a) => a.attributes.name),
    payers: revenue.map((a) => a.attributes.name),
  }));
  return searchIndex;
}

function highlight(name, term) {
  const i = name.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + term.length))}</mark>${esc(name.slice(i + term.length))}`;
}

async function updateSearch() {
  const term = searchInput.value.trim();
  if (!term) return closeSearch();
  const idx = await loadSearchIndex();
  if (searchInput.value.trim() !== term) return;
  const find = (list, key = (x) => x) =>
    list.filter((x) => key(x).toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => key(a).toLowerCase().indexOf(term.toLowerCase()) - key(b).toLowerCase().indexOf(term.toLowerCase()) || key(a).localeCompare(key(b), 'de'));
  const q = (op, name) => `#/buchungen?q=${encodeURIComponent(`${op}:"${name}"`)}`;
  const groups = [
    ['Kategorien', find(idx.categories, (c) => c.name).slice(0, 6).map((c) => [c.name, `#/kategorien/${encodeURIComponent(c.id)}`, 'Analyse'])],
    ['Tags', find(idx.tags, (t) => t.name).slice(0, 4).map((t) => [t.name, `#/tags/${encodeURIComponent(t.id)}`, 'Analyse'])],
    ['Empfänger', find(idx.payees).slice(0, 5).map((n) => [n, q('destination_account_is', n), 'Buchungen'])],
    ['Zahler', find(idx.payers).slice(0, 3).map((n) => [n, q('source_account_is', n), 'Buchungen'])],
    ['Konten', find(idx.assets).slice(0, 3).map((n) => [n, q('account_is', n), 'Buchungen'])],
  ].filter(([, items]) => items.length);
  const fulltext = [`Alle Buchungen mit „${term}“`, `#/buchungen?q=${encodeURIComponent(term)}`, 'Volltext'];
  resultsEl.innerHTML = groups
    .map(([label, items]) => `<div class="sr-group">${label}</div>${items
      .map(([name, href, hint]) => `<a class="sr-item" role="option" href="${href}"><span>${highlight(name, term)}</span><small>${hint}</small></a>`)
      .join('')}`)
    .join('') + `<a class="sr-item sr-all" role="option" href="${fulltext[1]}"><span>${esc(fulltext[0])}</span><small>${fulltext[2]}</small></a>`;
  activeResult = groups.length ? 0 : resultsEl.querySelectorAll('.sr-item').length - 1;
  markActive();
  resultsEl.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}

function markActive() {
  resultsEl.querySelectorAll('.sr-item').forEach((el, i) => el.classList.toggle('active', i === activeResult));
}

function closeSearch() {
  resultsEl.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
}

searchInput.addEventListener('focus', () => {
  loadSearchIndex();
  if (searchInput.value.trim()) updateSearch();
});
searchInput.addEventListener('input', debounce(updateSearch, 120));
searchInput.addEventListener('keydown', (e) => {
  const items = [...resultsEl.querySelectorAll('.sr-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    markActive();
    items[activeResult].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = items[activeResult] || items.at(-1);
    if (target) location.hash = target.getAttribute('href');
    else if (searchInput.value.trim()) location.hash = `#/buchungen?q=${encodeURIComponent(searchInput.value.trim())}`;
    finishSearch();
  } else if (e.key === 'Escape') {
    closeSearch();
    searchInput.blur();
  }
});
resultsEl.addEventListener('click', (e) => e.target.closest('.sr-item') && finishSearch());

function finishSearch() {
  closeSearch();
  searchInput.value = '';
  searchInput.blur();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) closeSearch();
  if (!e.target.closest('.period-wrap')) rangeForm.hidden = true;
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (e.key === 'Escape') rangeForm.hidden = true;
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  api.setFresh(true);
  searchIndex = null;
  try {
    if (connectionError) await connect();
    else await render();
  } finally {
    // Nachzügler-Anfragen der Karten noch ungecacht laufen lassen
    setTimeout(() => {
      api.setFresh(false);
      refreshBtn.classList.remove('spinning');
    }, 1500);
  }
});

function isDark() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

themeBtn.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store('ffd-theme', next);
  render();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) render();
});

connect();
