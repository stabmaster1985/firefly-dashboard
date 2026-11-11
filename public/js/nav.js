// Hauptmenü: Gruppen nach Aufgaben (am Desktop einklappbar), untere Leiste am Handy selbst wählbar,
// „Mehr“ als gegliedertes Blatt mit Suche, Zähler an Seiten mit offenen Aufgaben.

import { storage, store } from './util.js';
import { checkHints } from './check.js';

const PRIMARY_DEFAULT = ['overview', 'categories', 'transactions', 'recurring'];
const PRIMARY_MAX = 4;
const FOLD_DEFAULT = ['werkzeuge'];

const readList = (key, fallback) => {
  try {
    const v = JSON.parse(storage(key, 'null'));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

const nav = () => document.getElementById('nav');
const links = () => [...nav().querySelectorAll('a[data-route]')];

// ---- Gruppen einklappen (Desktop) -------------------------------------------------------
let folded = new Set(readList('ffd-nav-folded', FOLD_DEFAULT));
function applyFolds() {
  nav().querySelectorAll('.nav-sec').forEach((sec) => {
    // die Gruppe der aktuellen Seite bleibt sichtbar
    const open = !folded.has(sec.dataset.sec) || Boolean(sec.querySelector('a.active'));
    sec.classList.toggle('folded', !open);
    sec.querySelector('.nav-group').setAttribute('aria-expanded', String(open));
  });
}

// ---- Untere Leiste am Handy -------------------------------------------------------------
let primary = readList('ffd-nav-primary', PRIMARY_DEFAULT).filter((r) => links().some((a) => a.dataset.route === r)).slice(0, PRIMARY_MAX);
if (!primary.length) primary = PRIMARY_DEFAULT;
function applyPrimary() {
  links().forEach((a) => {
    const on = primary.includes(a.dataset.route);
    a.toggleAttribute('data-primary', on);
    // Reihenfolge nur für die untere Leiste am Handy (CSS), Menü und Blatt bleiben nach Gruppen sortiert
    if (on) a.style.setProperty('--nav-order', String(primary.indexOf(a.dataset.route)));
    else a.style.removeProperty('--nav-order');
  });
}

// ---- Zähler ---------------------------------------------------------------------------
let badgeAt = 0;
function setBadge(route, n, title) {
  const b = nav().querySelector(`[data-badge="${route}"]`);
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n || '');
  b.title = n ? title : '';
  b.closest('a').title = n ? title : '';
}
function markMore() {
  // „Mehr“ markieren, wenn ein Zähler an einem Punkt außerhalb der unteren Leiste steht
  const hidden = [...nav().querySelectorAll('.nav-badge:not([hidden])')].some((b) => !b.closest('a').hasAttribute('data-primary'));
  document.getElementById('nav-more').classList.toggle('has-badge', hidden);
}
/** Zähler neu holen – höchstens einmal je Minute (außer force). Fehler stören nicht. */
export async function updateBadges(force = false) {
  if (!force && Date.now() - badgeAt < 60_000) return;
  badgeAt = Date.now();
  await Promise.all([
    fetch('/local/autocat?anzahl=1').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d) setBadge('assign', d.offen || 0, `${d.offen} Händler noch ohne Kategorie`);
    }).catch(() => {}),
    checkHints().then((rows) => setBadge('check', rows.length, `${rows.length} Hinweis${rows.length === 1 ? '' : 'e'} zum Prüfen (doppelte Buchungen, Import überfällig)`)).catch(() => {}),
    fetch('/local/alerts').then((r) => (r.ok ? r.json() : null)).then((d) => {
      const n = (d?.alerts || []).filter((a) => a.art === 'kuendigungsfrist').length;
      setBadge('recurring', n, `${n} Kündigungsfrist${n === 1 ? '' : 'en'} in den nächsten 30 Tagen`);
    }).catch(() => {}),
  ]);
  markMore();
}

// ---- „Mehr“-Blatt: Suche und Leiste anpassen ----------------------------------------------
let pinning = false;
function setPinning(on) {
  pinning = on;
  nav().classList.toggle('nav-pinning', on);
  const btn = document.getElementById('nav-pin-toggle');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? `Fertig (${primary.length}/${PRIMARY_MAX} unten)` : 'Untere Leiste anpassen';
}
function filterSheet(q) {
  const t = q.trim().toLowerCase();
  nav().querySelectorAll('.nav-sec').forEach((sec) => {
    let any = false;
    sec.querySelectorAll('a[data-route]').forEach((a) => {
      const hit = !t || a.textContent.toLowerCase().includes(t) || sec.querySelector('.nav-group').textContent.toLowerCase().includes(t);
      a.classList.toggle('nav-miss', !hit);
      any ||= hit;
    });
    sec.classList.toggle('nav-miss', !any);
  });
}
/** Nach dem Schließen des Blatts: Suche und Anpassen zurücksetzen. */
export function resetSheet() {
  const find = document.getElementById('nav-find');
  if (find.value) {
    find.value = '';
    filterSheet('');
  }
  if (pinning) setPinning(false);
}

/** Nach jedem Seitenwechsel (aktive Seite steht fest). */
export function navRendered() {
  applyFolds();
  updateBadges();
}

export function initNav({ onNavigate }) {
  applyPrimary();
  applyFolds();
  nav().addEventListener('click', (e) => {
    const head = e.target.closest('.nav-group');
    if (head && !document.querySelector('.sidebar').classList.contains('nav-open')) {
      const key = head.closest('.nav-sec').dataset.sec;
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      store('ffd-nav-folded', JSON.stringify([...folded]));
      // aktive Gruppe: Einklappen erst wirksam, wenn man woanders ist – trotzdem sofort zeigen
      const sec = head.closest('.nav-sec');
      const open = !folded.has(key);
      sec.classList.toggle('folded', !open);
      head.setAttribute('aria-expanded', String(open));
      return;
    }
    if (e.target.closest('#nav-pin-toggle')) {
      setPinning(!pinning);
      return;
    }
    const a = e.target.closest('a[data-route]');
    if (a && pinning) {
      e.preventDefault();
      const r = a.dataset.route;
      if (primary.includes(r)) {
        if (primary.length > 1) primary = primary.filter((x) => x !== r);
      } else if (primary.length < PRIMARY_MAX) primary = [...primary, r];
      else primary = [...primary.slice(1), r]; // voll: der älteste fliegt raus
      store('ffd-nav-primary', JSON.stringify(primary));
      applyPrimary();
      markMore();
      setPinning(true);
      return;
    }
    if (a) onNavigate?.();
  });
  document.getElementById('nav-find').addEventListener('input', (e) => filterSheet(e.target.value));
  document.getElementById('nav-find').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = links().find((a) => !a.classList.contains('nav-miss'));
    if (first) location.hash = first.getAttribute('href').slice(1);
  });
  setTimeout(() => updateBadges(true), 4000); // erst wenn die erste Seite geladen ist
  setInterval(() => updateBadges(true), 10 * 60_000);
  for (const ev of ['ffd-rerender', 'ffd-excluded']) window.addEventListener(ev, () => setTimeout(() => updateBadges(true), 1500));
}
