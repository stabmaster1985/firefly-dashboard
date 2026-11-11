// Seite „Zuordnen“: automatische Kategorien (lib/autocat.js, lib/ledger.js). Buchungen ohne
// Firefly-Kategorie bekommen in allen Auswertungen eine – aus dem Händler abgeleitet. Hier sieht man,
// wie viel abgedeckt ist, ordnet offene Händler zu und korrigiert automatische Zuordnungen.
// Firefly bleibt unverändert.

import * as api from './api.js';
import { money, esc, fmtDate, percent } from './util.js';
import { card, skeleton } from './common.js';

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
      ${card('z-set', 'Einstellungen', { meta: 'Woraus die Kategorien abgeleitet werden' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  ['z-open', 'z-auto', 'z-set'].forEach((id) => ($(id).innerHTML = skeleton(4)));
  let data;
  let shownOpen = 40;
  let shownAuto = 40;

  const catInput = (value, attrs) => `<input class="input" list="z-cats" value="${esc(value || '')}" placeholder="Kategorie wählen oder neu eingeben" aria-label="Kategorie" ${attrs}>`;
  const quelle = (q) => (q ? `<span class="badge auto" title="Quelle der Zuordnung">${esc(data.quellen[q] || q)}</span>` : '');

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
          <div class="subtitle">${m.n} Buchung${m.n === 1 ? '' : 'en'} · zuletzt ${fmtDate(m.last)}${m.beispiel ? ` · ${esc(m.beispiel)}` : ''}</div></div>
        <div class="amount">${money(m.offen, code)}</div>
        ${m.key ? `<form class="z-form" data-assign="${esc(m.key)}" data-name="${esc(m.name)}">${catInput('', 'name="category" required')}<button class="btn primary small" type="submit">Zuordnen</button></form>`
    : '<div class="muted z-form">kein Händler erkennbar – einzeln in den Buchungen kategorisieren</div>'}
      </div>`).join('')}</div>
      ${data.offen.length > shownOpen ? `<button class="btn" id="z-open-more" style="margin-top:12px">Weitere ${Math.min(40, data.offen.length - shownOpen)} zeigen</button>` : ''}`
      : '<div class="empty">Alle Ausgaben der letzten 24 Monate haben eine Kategorie. 🎉</div>';

    // ---- automatisch ----
    $('z-auto-meta').textContent = data.automatisch.length ? `${data.automatisch.length} Händler · ${money(s.automatisch, code)}` : '';
    $('z-auto').innerHTML = data.automatisch.length ? `
      <p class="muted" style="margin-top:0">Passt etwas nicht? Kategorie ändern – deine Zuordnung hat Vorrang vor Regeln, Händlerliste und KI.</p>
      <div class="list z-list">${data.automatisch.slice(0, shownAuto).map((m) => `<div class="row z-row" data-key="${esc(m.key)}">
        <div style="min-width:0"><div class="title">${esc(m.name)} ${quelle(m.quelle)}</div>
          <div class="subtitle">${m.n} Buchung${m.n === 1 ? '' : 'en'} · zuletzt ${fmtDate(m.last)}${m.beispiel ? ` · ${esc(m.beispiel)}` : ''}</div></div>
        <div class="amount">${money(m.auto, code)}</div>
        ${m.key ? `<form class="z-form" data-assign="${esc(m.key)}" data-name="${esc(m.name)}">${catInput(m.category, 'name="category" required')}<button class="btn small" type="submit">Ändern</button>
          ${m.fest ? `<button class="link-btn" type="button" data-reset="${esc(m.key)}" title="Deine Zuordnung entfernen – dann gelten wieder Regeln, Händlerliste und KI">zurücksetzen</button>` : ''}</form>` : '<div class="z-form"></div>'}
      </div>`).join('')}</div>
      ${data.automatisch.length > shownAuto ? `<button class="btn" id="z-auto-more" style="margin-top:12px">Weitere ${Math.min(40, data.automatisch.length - shownAuto)} zeigen</button>` : ''}`
      : '<div class="empty">Noch nichts automatisch zugeordnet.</div>';

    // ---- Einstellungen ----
    const e = data.einstellungen;
    const q = s.quellen;
    const check = (key, label, hint, sum) => `<label class="check z-opt"><input type="checkbox" data-opt="${key}" ${e[key] ? 'checked' : ''}${key !== 'enabled' && !e.enabled ? ' disabled' : ''}>
      <span><b>${label}</b>${sum !== undefined ? ` <span class="muted">· ${money(sum, code)}</span>` : ''}<br><span class="muted">${hint}</span></span></label>`;
    const p = data.pruefung;
    $('z-set').innerHTML = `
      ${check('enabled', 'Automatische Zuordnung', 'Aus: Buchungen ohne Firefly-Kategorie bleiben „ohne Kategorie“.')}
      <div class="z-opts">
        <div class="z-opt muted"><b>1. Deine Zuordnungen</b> · ${money(q.zuordnung, code)}<br>${e.assigned} Händler von dir fest zugeordnet (oben) – gelten immer zuerst.</div>
        <div class="z-opt muted"><b>2. Deine Regeln</b> · ${money(q.regel, code)}<br>Regeln aus dem <a href="#/labor?tab=regeln">Labor</a> mit „Kategorie setzen“.</div>
        ${check('learn', '3. Aus deinen Buchungen lernen', 'Händler, der in Firefly sonst eindeutig kategorisiert ist (mind. 2 Buchungen, 60 % gleiche Kategorie).', q.gelernt)}
        ${check('list', '4. Händlerliste', 'Bekannte Händler: Aldi, Lidl, Netto, Rewe → Lebensmittel; Aral, Shell → Mobilität; Telekom → Nebenkosten usw.', q.liste)}
        ${check('ai', '5. KI-Bewertung', `Ergebnisse der <a href="#/labor?tab=ki">KI-Analyse</a> ab <select data-opt-min ${e.enabled && e.ai ? '' : 'disabled'}>${[50, 70, 80, 90].map((v) => `<option value="${v}"${v === e.aiMin ? ' selected' : ''}>${v} %</option>`).join('')}</select> Sicherheit – nur für Händler, die sonst niemand kennt.`, q.ki)}
      </div>
      <div class="z-check ${p ? (p.ok ? 'good' : 'bad') : 'muted'}">${p
    ? (p.ok ? `Selbstprüfung ✓ – die Summen des Dashboards stimmen mit Firefly überein (${p.months.map((m) => fmtDate(`${m.monat}-01`, { month: 'long', year: 'numeric' })).join(', ')}; geprüft ${fmtDate(p.at)}).`
      : `Selbstprüfung: Abweichung zu Firefly – ${p.months.flatMap((m) => m.checks.filter((c) => !c.ok).map((c) => `${fmtDate(`${m.monat}-01`, { month: 'short', year: 'numeric' })} ${c.art}: Dashboard ${money(c.dashboard, c.waehrung)}, Firefly ${money(c.firefly, c.waehrung)}${c.kategorienAbweichend ? `, ${c.kategorienAbweichend} Kategorien` : ''}`)).join(' · ')}. Bitte melden.`)
    : 'Selbstprüfung läuft nach dem ersten Vorladen (vergleicht die eigenen Summen mit Firefly).'}
        <button class="link-btn" id="z-recheck">jetzt prüfen</button></div>`;
  }

  async function update(promise) {
    try {
      data = await promise;
      api.forget(); // Summen und Listen der anderen Seiten ändern sich
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  view.addEventListener('submit', (e) => {
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
    if (e.target.dataset.opt) return update(call('PUT', { [e.target.dataset.opt]: e.target.checked }));
    if (e.target.matches('[data-opt-min]')) return update(call('PUT', { aiMin: Number(e.target.value) }));
  });

  try {
    data = await call('GET');
    if (view.isConnected) render();
  } catch (err) {
    $('z-cover').innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`;
    ['z-open', 'z-auto', 'z-set'].forEach((id) => ($(id).innerHTML = ''));
  }
}
