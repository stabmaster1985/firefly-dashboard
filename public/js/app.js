// Einstieg: Routing, Zeitraum, Theme und Verbindungsprüfung.

import * as api from './api.js';
import * as views from './views.js';
import { destroyCharts } from './charts.js';
import { PERIODS, periodById, storage, store, esc } from './util.js';

const ROUTES = {
  '': { view: views.overview, title: 'Übersicht', nav: 'overview' },
  buchungen: { view: views.transactions, title: 'Buchungen', nav: 'transactions' },
  konten: { view: views.accounts, title: 'Konten', nav: 'accounts' },
  budgets: { view: views.budgets, title: 'Budgets', nav: 'budgets' },
  sparziele: { view: views.piggies, title: 'Sparziele', nav: 'piggies', noPeriod: true },
  vertraege: { view: views.bills, title: 'Verträge', nav: 'bills' },
};

const viewEl = document.getElementById('view');
const titleEl = document.getElementById('page-title');
const periodSelect = document.getElementById('period-select');
const refreshBtn = document.getElementById('refresh-btn');
const themeBtn = document.getElementById('theme-btn');

let connectionError = null;

periodSelect.innerHTML = PERIODS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
periodSelect.value = storage('ffd-period', 'this-month');
if (!periodSelect.value) periodSelect.value = 'this-month';

function parseHash() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { path: path.replace(/\/$/, ''), params: new URLSearchParams(qs) };
}

async function render() {
  const { path, params } = parseHash();
  const route = ROUTES[path] || ROUTES[''];
  destroyCharts();
  titleEl.textContent = route.title;
  document.title = `${route.title} · Firefly Dashboard`;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route.nav));
  periodSelect.parentElement.hidden = Boolean(route.noPeriod);

  if (connectionError) return showConnectionError(connectionError);
  const period = periodById(periodSelect.value);
  window.scrollTo({ top: 0 });
  await route.view(viewEl, { period, params });
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

// ---- Bedienelemente -------------------------------------------------------

window.addEventListener('hashchange', render);

periodSelect.addEventListener('change', () => {
  store('ffd-period', periodSelect.value);
  render();
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  api.setFresh(true);
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
