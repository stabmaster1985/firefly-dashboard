// Hilfe anzeigen: Fenster für einzelne Themen (?-Knöpfe) und die Seite „Hilfe“.

import { esc } from './util.js';
import { PAGES, CARDS, pageOfCard } from './help.js';

let dialog = null;

function topic(key) {
  const [kind, id] = String(key).split(':');
  if (kind === 'page' && PAGES[id]) return { ...PAGES[id], kind, id };
  if (kind === 'card' && CARDS[id]) return { ...CARDS[id], kind, id, page: pageOfCard(id) };
  return null;
}

function body(t) {
  const section = (label, text) => (text ? `<h3>${label}</h3><p>${esc(text)}</p>` : '');
  return `${section('Wofür?', t.what)}
    ${section('Was passiert im Dashboard?', t.app)}
    ${section('Was passiert in Firefly?', t.firefly)}
    ${t.tips?.length ? `<h3>Tipps</h3><ul>${t.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
}

/** Hilfe-Fenster öffnen (key: „page:lab“ oder „card:l-groups“). */
export function openHelp(key) {
  const t = topic(key);
  if (!t) return;
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'help-dialog';
    document.body.append(dialog);
    dialog.addEventListener('click', (e) => {
      // Klick auf den Hintergrund oder „Schließen“ schließt
      if (e.target === dialog || e.target.closest('[data-help-close]') || e.target.closest('a[href^="#/"]')) dialog.close();
    });
  }
  const related = t.kind === 'page'
    ? t.cards.filter((c) => CARDS[c]).map((c) => `<button class="chip small" data-help="card:${c}">${esc(CARDS[c].title)}</button>`).join('')
    : t.page ? `<button class="chip small" data-help="page:${t.page}">Zur Seite: ${esc(PAGES[t.page].title)}</button>` : '';
  dialog.innerHTML = `<div class="help-inner">
      <div class="help-head"><h2>${esc(t.title)}</h2><button class="icon-btn small" data-help-close aria-label="Schließen">✕</button></div>
      ${body(t)}
      ${related ? `<h3>${t.kind === 'page' ? 'Auf dieser Seite' : 'Mehr'}</h3><div class="chips help-related">${related}</div>` : ''}
      <div class="help-foot"><a href="#/hilfe">Alle Hilfethemen →</a></div>
    </div>`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.help-inner').scrollTop = 0;
}

/** Seite „Hilfe“: alle Seiten und Karten, durchsuchbar. */
export function helpPage(view) {
  view.innerHTML = `
    <div class="toolbar"><input type="search" class="help-search" id="help-q" placeholder="Hilfe durchsuchen, z. B. „Gruppe“, „Firefly“, „n8n“ …" aria-label="Hilfe durchsuchen"></div>
    <section class="card help-intro">
      <h2>So funktioniert das Dashboard</h2>
      <p>Das Dashboard <b>liest</b> deine Daten aus Firefly III und wertet sie aus. Es <b>schreibt nie selbst</b> in Firefly.
        Wo etwas in Firefly geändert werden soll (Kategorie setzen, Tags, Regeln anlegen), schickt das Dashboard die Änderung an einen
        <b>n8n-Workflow</b>, den du unter <a href="#/automationen">Automationen</a> eingerichtet hast – der führt sie dann aus.</p>
      <p>Eigene Einstellungen des Dashboards (Ziele, Labor-Regeln, Gruppen, Automationen, ausgeblendete Vorschläge) speichert der
        Dashboard-Server in seinem Datenordner – sie gelten auf allen Geräten und bleiben bei Updates erhalten.</p>
      <p>Überall gilt: <b>?</b> neben einer Karte erklärt diese Karte, <b>?</b> oben rechts erklärt die ganze Seite.</p>
    </section>
    <div id="help-list">${Object.entries(PAGES).map(([id, p]) => `
      <section class="card help-page" data-text="${esc([p.title, p.what, p.app, p.firefly, ...(p.tips || []), ...p.cards.map((c) => Object.values(CARDS[c] || {}).join(' '))].join(' ').toLowerCase())}">
        <h2>${esc(p.title)}</h2>
        ${body(p)}
        ${p.cards.filter((c) => CARDS[c]).map((c) => `<details class="help-card" data-text="${esc(Object.values(CARDS[c]).flat().join(' ').toLowerCase())}"><summary>${esc(CARDS[c].title)}</summary>${body(CARDS[c])}</details>`).join('')}
      </section>`).join('')}
    </div>`;
  const q = view.querySelector('#help-q');
  q.addEventListener('input', () => {
    const term = q.value.trim().toLowerCase();
    view.querySelectorAll('.help-page').forEach((sec) => {
      const cards = [...sec.querySelectorAll('.help-card')];
      cards.forEach((d) => {
        const hit = term && d.dataset.text.includes(term);
        d.open = Boolean(hit);
      });
      sec.hidden = Boolean(term) && !sec.dataset.text.includes(term);
    });
  });
}
