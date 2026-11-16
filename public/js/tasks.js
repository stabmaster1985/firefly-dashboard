// Seite „Aufgaben“ (Pflegen): alles, was gerade zu tun ist, auf einen Blick – mit Anzahl und Sprung
// zur passenden Karte – und darunter alle Pflege-Werkzeuge an einer Stelle. Rechnet mit denselben
// Quellen wie die einzelnen Seiten (Zuordnen, Prüfen, Aufräumen, Wiederkehrend, CSV-Abgleich).

import * as api from './api.js';
import { esc } from './util.js';
import { PAGES, CARDS } from './help.js';
import { checkHints, loadHistory } from './check.js';
import { wrongParties } from './partycore.js';
import { mergeGroups } from './cleanupcore.js';
import { counterpartyOf } from './rules.js';

const lower = (s) => String(s ?? '').trim().toLowerCase();
const json = (url) => fetch(url, { headers: { 'X-No-Cache': '1' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Werkzeuge je Bereich: [Seite (Pfad), Hilfe-Schlüssel, Karten]
const TOOLS = [
  ['zuordnen', 'assign', ['z-open', 'z-auto', 'z-ff']],
  ['aufraeumen', 'cleanup', ['a-wrong', 'a-merge', 'a-catmerge', 'a-import']],
  ['pruefen', 'check', ['c-dup', 'c-import', 'c-excl', 'c-backup']],
  ['abgleich', 'csvsync', ['s-archive', 's-files', 's-open', 's-import']],
];
const EXTRA_TOOLS = [
  ['Buchungen in ein anderes Gegenkonto verschieben', '#/buchungen', 'Buchungen suchen, anhaken, unten „Empfänger / Gegenkonto“ – „Verschieben“.'],
  ['Kategorie oder Tag für mehrere Buchungen setzen', '#/buchungen', 'Buchungen suchen, anhaken, unten „Kategorie …“ bzw. „Tag …“.'],
  ['Händler aufteilen (z. B. Kfz- und Familienversicherung)', '#/zuordnen?karte=z-auto', 'Unter „Automatisch zugeordnet“ beim Händler „aufteilen“.'],
];
/** Kurzbeschreibung: ganzer Text, an einer Wortgrenze gekürzt (Sätze nicht an „z. B.“ abschneiden). */
const firstSentence = (s) => {
  const t = String(s || '').trim();
  if (t.length <= 120) return t;
  return `${t.slice(0, 120).replace(/\s+\S*$/, '')} …`;
};

export async function tasksPage(view) {
  view.innerHTML = `
    <div class="grid">
      <section class="card span-12">
        <div class="card-head"><h2>Offene Aufgaben</h2><span class="meta" id="t-meta">wird geprüft …</span></div>
        <div class="list task-list" id="t-list"></div>
      </section>
      <section class="card span-12">
        <div class="card-head"><h2>Alle Pflege-Werkzeuge</h2><span class="meta">Klick springt zur Karte</span></div>
        <div class="tool-grid">${TOOLS.map(([path, help, cards]) => `<div class="tool-col"><h3><a href="#/${path}">${esc(PAGES[help].title)}</a></h3>
          ${cards.filter((c) => CARDS[c]).map((c) => `<a class="tool" href="#/${path}?karte=${c}"><b>${esc(CARDS[c].title)}</b><span>${esc(firstSentence(CARDS[c].what))}</span></a>`).join('')}</div>`).join('')}
          <div class="tool-col"><h3><a href="#/buchungen">Buchungen &amp; Zuordnen</a></h3>
          ${EXTRA_TOOLS.map(([t, href, sub]) => `<a class="tool" href="${href}"><b>${esc(t)}</b><span>${esc(sub)}</span></a>`).join('')}</div>
        </div>
      </section>
    </div>`;
  const list = view.querySelector('#t-list');
  const meta = view.querySelector('#t-meta');

  // Jede Prüfung trägt sich ein, sobald sie fertig ist – langsame halten die anderen nicht auf
  const rows = new Map(); // Schlüssel → { n, title, sub, href, prio, state }
  const SLOTS = [
    ['autocat', 'Zuordnen wird geprüft …'], ['check', 'Doppelte Buchungen und Importe werden geprüft …'],
    ['cleanup', 'Gegenkonten werden geprüft …'], ['recurring', 'Kündigungsfristen werden geprüft …'], ['job', ''],
  ];
  let pending = SLOTS.length;
  const set = (key, items) => {
    items.forEach((x, i) => rows.set(`${key}${i}`, x));
    pending -= 1;
    render();
  };
  function render() {
    if (!view.isConnected) return;
    const open = [...rows.values()].filter((r) => r.n > 0).sort((a, b) => (a.prio ?? 5) - (b.prio ?? 5) || b.n - a.n);
    const ok = [...rows.values()].filter((r) => !r.n && r.okText);
    const total = open.reduce((a, r) => a + (r.count === false ? 0 : 1), 0);
    meta.textContent = pending ? `wird geprüft … (${SLOTS.length - pending}/${SLOTS.length})` : total ? plural(total, 'offener Punkt', 'offene Punkte') : 'alles erledigt';
    list.innerHTML = `${open.map((r) => `<a class="row task" href="${r.href}">
        <div class="task-n ${r.warn ? 'warn' : ''}">${r.badge ?? r.n}</div>
        <div style="min-width:0"><div class="title">${esc(r.title)}</div><div class="subtitle">${esc(r.sub || '')}</div></div>
        <span class="task-go" aria-hidden="true">›</span></a>`).join('')}
      ${pending ? `<div class="row task muted"><div class="task-n">…</div><div>${esc(SLOTS.filter(([k]) => ![...rows.keys()].some((x) => x.startsWith(k))).map(([, t]) => t).filter(Boolean)[0] || 'wird geprüft …')}</div></div>` : ''}
      ${!pending && !open.length ? '<div class="empty">Nichts zu tun – alles gepflegt. 🎉</div>' : ''}
      ${ok.length ? `<p class="muted task-ok">✓ ${ok.map((r) => esc(r.okText)).join(' · ')}</p>` : ''}`;
  }
  render();

  // 1) Zuordnen
  json('/local/autocat').then((d) => {
    if (!d) return set('autocat', []);
    const upToDate = (m) => m.ff?.sentAt && m.ff.category === (m.festKeep ? '' : (m.festKategorie || m.category)) && Boolean(m.ff.keep) === Boolean(m.festKeep)
      && JSON.stringify(m.ff.split || []) === JSON.stringify(m.split || []);
    const todo = d.automatisch.filter((m) => !m.fest && !m.nurEinzeln).length;
    const vorgemerkt = d.automatisch.filter((m) => m.fest && m.cond && !m.gemischt && !upToDate(m)).length;
    set('autocat', [
      { n: d.offenAnzahl || 0, prio: 1, title: `${plural(d.offenAnzahl || 0, 'Händler', 'Händler')} ohne Kategorie`, sub: 'Zuordnen → Noch nicht zugeordnet', href: '#/zuordnen?karte=z-open', okText: 'Alle Händler haben eine Kategorie' },
      { n: todo, prio: 2, title: `${plural(todo, 'automatische Zuordnung', 'automatische Zuordnungen')} prüfen`, sub: 'Zuordnen → Automatisch zugeordnet: „✓ Passt“, ändern oder aufteilen', href: '#/zuordnen?karte=z-auto' },
      { n: vorgemerkt, prio: 3, title: `${plural(vorgemerkt, 'Zuordnung gilt', 'Zuordnungen gelten')} nur im Dashboard`, sub: 'Zuordnen → In Firefly übernehmen (als Regeln nach Firefly)', href: '#/zuordnen?karte=z-ff' },
      { n: d.einzeln?.length || 0, prio: 3, title: `${plural(d.einzeln?.length || 0, 'einzeln zugeordnete Buchung', 'einzeln zugeordnete Buchungen')} noch nicht in Firefly`, sub: 'Zuordnen → In Firefly übernehmen → „In Firefly setzen“', href: '#/zuordnen?karte=z-ff' },
    ]);
  });

  // 2) Prüfen (doppelte Buchungen, überfällige Importe) – dieselben Hinweise wie in der Übersicht
  checkHints().then((hints) => set('check', hints.map((h) => ({
    n: 1, badge: h.icon, prio: h.cls === 'hint-import' ? 1 : 2, warn: h.cls === 'hint-import', title: h.title, sub: `Prüfen → ${h.cls === 'hint-dup' ? 'Mögliche doppelte Buchungen' : 'Import-Status je Konto'}`,
    href: `#/pruefen?karte=${h.cls === 'hint-dup' ? 'c-dup' : 'c-import'}`,
  })).concat(hints.length ? [] : [{ n: 0, okText: 'Keine Dubletten, Importe aktuell' }]))).catch(() => set('check', []));

  // 3) Aufräumen: falsch zugeordnete und ähnliche Gegenkonten (aus den Buchungen der letzten 24 Monate)
  Promise.all([
    loadHistory({ alle: true }),
    api.loadDismissed(),
    json('/local/cleanup/merge'),
    Promise.all(['expense', 'revenue'].map((type) => api.getAll('accounts', { type }).then((l) => l.map((a) => ({ id: String(a.id), name: a.attributes?.name || '', type, iban: a.attributes?.iban || null }))).catch(() => []))),
  ]).then(([txs, dismissed, plan, accLists]) => {
    const wrong = wrongParties(txs, { dismissed: dismissed.parties || new Set() });
    const nWrong = wrong.reduce((a, r) => a + r.wrongCount, 0);
    const counts = new Map();
    for (const t of txs) counts.set(lower(counterpartyOf(t)), (counts.get(lower(counterpartyOf(t))) || 0) + 1);
    const groups = mergeGroups(accLists.flat(), counts).filter((g) => {
      const p = plan?.groups?.[g.key] || {};
      return !p.ignored && !p.done;
    });
    set('cleanup', [
      { n: nWrong, prio: 2, warn: true, title: `${plural(nWrong, 'Buchung', 'Buchungen')} bei ${plural(wrong.length, 'falschem Gegenkonto', 'falschen Gegenkonten')}`, sub: `Aufräumen → Falsch zugeordnete Gegenkonten${wrong[0] ? ` (z. B. ${wrong[0].party})` : ''}`, href: '#/aufraeumen?karte=a-wrong', okText: 'Gegenkonten passen zu den Buchungstexten' },
      { n: groups.length, prio: 4, title: `${plural(groups.length, 'Gruppe', 'Gruppen')} ähnlicher Gegenkonten`, sub: 'Aufräumen → Ähnliche Gegenkonten zusammenführen', href: '#/aufraeumen?karte=a-merge' },
    ]);
  }).catch(() => set('cleanup', []));

  // 4) Kündigungsfristen
  json('/local/alerts').then((d) => {
    const fr = (d?.alerts || []).filter((a) => a.art === 'kuendigungsfrist');
    set('recurring', [{ n: fr.length, prio: 0, warn: true, title: `${plural(fr.length, 'Kündigungsfrist', 'Kündigungsfristen')} in den nächsten 30 Tagen`, sub: fr[0]?.text || 'Wiederkehrend → Verträge & Kündigungsfristen', href: '#/wiederkehrend?karte=r-contracts', okText: 'Keine Kündigungsfrist in den nächsten 30 Tagen' }]);
  });

  // 5) Auftrag auf dem Server (CSV-Abgleich, Gegenkonten korrigieren)
  json('/local/syncjob').then((d) => {
    const j = d?.job;
    const live = j && ['laeuft', 'pausiert'].includes(j.status);
    set('job', live ? [{ n: 1, badge: j.status === 'laeuft' ? '⏳' : '⏸', prio: j.status === 'pausiert' ? 0 : 5, warn: j.status === 'pausiert', count: j.status === 'pausiert',
      title: j.status === 'laeuft' ? `Übertragung läuft: ${j.ok} von ${j.total}` : 'Übertragung angehalten', sub: j.message || 'CSV-Abgleich → Übertragung auf dem Server', href: '#/abgleich?karte=s-job' }] : []);
  });
}
