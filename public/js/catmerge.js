// „Kategorien zusammenführen“ (Seite „Aufräumen“): mehrere Kategorien in eine. Zwei Wege:
//   - nur im Dashboard: Auswertungen zählen sie sofort unter dem Ziel (umkehrbar, Firefly unverändert)
//   - in Firefly: per n8n-Workflow „Regeln anlegen“ eine Regel „Kategorie ist A → Kategorie B“ je Quelle,
//     angewendet auf alle Buchungen – auch künftige Importe mit der alten Kategorie landen im Ziel.
// Server: /local/kategorien (lib/ledger.js, gespeichert in DATA_DIR/autocat.json).

import * as api from './api.js';
import { esc, money, fmtDate, today, isoDate } from './util.js';
import { runAction } from './txedit.js';
import { toFireflyRules } from './rules.js';

const RULE_GROUP = 'Dashboard: Kategorien zusammengeführt';
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const call = (body) => fetch('/local/kategorien', body ? { method: 'POST', headers, body: JSON.stringify(body) } : {}).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`);
  return data;
});

/** Vergleichsform eines Namens: „Lebensmittel & Drogerie“ ≈ „lebensmittel und drogerie“, Einzahl ≈ Mehrzahl. */
const fold = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/&/g, ' und ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map((w) => w.replace(/(en|n|e|s)$/, '')).join(' ');

/** Vorschläge: Kategorien mit (fast) gleichem Namen, das Ziel ist die größte. */
function suggestions(list) {
  const groups = new Map();
  for (const c of list) {
    if (c.ziel) continue;
    const k = fold(c.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const sorted = [...g].sort((a, b) => Number(b.inFirefly) - Number(a.inFirefly) || b.n - a.n);
    return { to: sorted[0].name, from: sorted.slice(1).map((c) => c.name) };
  });
}

export function catMergeCard(el, meta, { rulesAction }) {
  let data;
  const picked = new Set();
  let note = '';

  const sum = (c) => c.ausgaben + c.einnahmen;
  function render() {
    const list = data.kategorien;
    const active = list.filter((c) => !c.ziel);
    const merged = data.zusammengefuehrt;
    const sugg = suggestions(list);
    const names = [...new Set(active.map((c) => c.name))].sort((a, b) => a.localeCompare(b, 'de'));
    meta.textContent = `${active.length} Kategorien${merged.length ? ` · ${merged.length} zusammengeführt` : ''}`;
    const pendingFirefly = merged.filter((m) => m.firefly && !m.sentAt);
    el.innerHTML = `
      <p class="muted" style="margin-top:0">Mehrere Kategorien zu einer machen, z. B. „Lebensmittel“, „Supermarkt“ und „Einkauf“ → „Lebensmittel“.
        <b>Nur im Dashboard</b> wirkt sofort in allen Auswertungen und lässt sich jederzeit aufheben – Firefly bleibt unverändert.
        <b>In Firefly</b> legt per n8n je Kategorie eine Regel „Kategorie ist A → Kategorie B“ an und wendet sie auf alle Buchungen an;
        so landen auch künftige Importe mit der alten Kategorie im Ziel.</p>
      ${note ? `<div class="cm-note">${note}</div>` : ''}
      ${sugg.length ? `<div class="cm-sugg"><b>Vorschläge</b> (fast gleiche Namen):
        ${sugg.map((s, i) => `<div class="cm-sugg-row"><span>${s.from.map((f) => `„${esc(f)}“`).join(', ')} → <b>„${esc(s.to)}“</b></span>
          <button class="btn small" type="button" data-sugg="${i}">übernehmen</button></div>`).join('')}</div>` : ''}
      <div class="table-wrap"><table class="cm-table">
        <thead><tr><th class="pick-cell"></th><th>Kategorie</th><th class="num">Buchungen</th><th class="num hide-sm">Ausgaben</th><th class="num hide-sm">Einnahmen</th></tr></thead>
        <tbody>${active.map((c) => `<tr data-name="${esc(c.name)}">
          <td class="pick-cell"><input type="checkbox" data-pick="${esc(c.name)}" ${picked.has(c.name) ? 'checked' : ''} aria-label="${esc(c.name)} auswählen"></td>
          <td><div class="desc">${esc(c.name)}</div><div class="flow">${!c.inFirefly ? 'nur im Dashboard (automatisch/zusammengeführt)' : c.n === 0 ? 'in Firefly, ohne Buchungen' : c.auto && c.firefly ? 'Firefly + automatisch' : c.auto ? 'automatisch zugeordnet' : 'Firefly'}${(merged.filter((m) => m.to.toLowerCase() === c.name.toLowerCase()).length) ? ` · enthält ${merged.filter((m) => m.to.toLowerCase() === c.name.toLowerCase()).map((m) => `„${esc(m.from)}“`).join(', ')}` : ''}</div></td>
          <td class="num">${c.n}</td>
          <td class="num hide-sm">${c.ausgaben ? money(c.ausgaben) : '–'}</td>
          <td class="num hide-sm">${c.einnahmen ? money(c.einnahmen) : '–'}</td></tr>`).join('')}</tbody></table></div>
      <form class="cm-form" id="cm-form">
        <span class="muted">${picked.size ? `${picked.size} ausgewählt` : 'Kategorien oben ankreuzen'}</span>
        <label>zusammenführen in <input class="input" name="to" list="cm-names" required placeholder="Ziel (vorhanden oder neu)" value="${esc(picked.size ? [...picked].sort((a, b) => sum(list.find((c) => c.name === b) || { ausgaben: 0, einnahmen: 0 }) - sum(list.find((c) => c.name === a) || { ausgaben: 0, einnahmen: 0 }))[0] : '')}"></label>
        <datalist id="cm-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <button class="btn" type="submit" name="mode" value="dashboard"${picked.size ? '' : ' disabled'}>Nur im Dashboard</button>
        <button class="btn primary" type="submit" name="mode" value="firefly"${picked.size && rulesAction ? '' : ' disabled'} title="${rulesAction ? 'Per n8n-Workflow „Regeln anlegen“' : 'Dafür eine Automation mit Auslöser „Firefly-Regeln anlegen“ einrichten (n8n/firefly-buchung-bearbeiten.json)'}">In Firefly zusammenführen</button>
      </form>
      ${!rulesAction ? '<p class="muted small-text">„In Firefly“ braucht unter <a href="#/automationen">Automationen</a> eine Automation mit Auslöser „Firefly-Regeln anlegen“ (Vorlage n8n/firefly-buchung-bearbeiten.json).</p>' : ''}
      ${merged.length ? `<h3 class="sub-h" style="margin-top:18px">Zusammengeführt</h3>
        <div class="list cm-merged">${merged.map((m) => `<div class="row" style="cursor:default">
          <div style="min-width:0"><div class="title">„${esc(m.from)}“ → „${esc(m.to)}“</div>
            <div class="subtitle">${m.sentAt ? `in Firefly übertragen am ${fmtDate(m.sentAt)} (Regel in der Gruppe „${esc(RULE_GROUP)}“)` : m.firefly ? '<span class="bad">für Firefly vorgesehen, noch nicht übertragen</span>' : 'nur im Dashboard'}</div></div>
          <button class="link-btn" type="button" data-unmerge="${esc(m.from)}">aufheben</button></div>`).join('')}</div>
        ${pendingFirefly.length && rulesAction ? `<button class="btn small" type="button" id="cm-resend" style="margin-top:10px">Noch offene nach Firefly übertragen (${pendingFirefly.length})</button>` : ''}
        <p class="muted small-text">„Aufheben“ wirkt sofort im Dashboard; wurde schon nach Firefly übertragen, wird die Regel dort entfernt –
          die Buchungen behalten aber die neue Kategorie (in Firefly ggf. von Hand zurücksetzen). Leere alte Kategorien kannst du in Firefly löschen.
          Tipp: Auch in der Import-Konfiguration (Data Importer) die alte Kategorie durch die neue ersetzen.</p>` : ''}`;
  }

  /** Alle für Firefly vorgesehenen Zusammenführungen als Regeln schicken (die Gruppe wird abgeglichen) und anwenden. */
  async function sendToFirefly() {
    const all = data.zusammengefuehrt.filter((m) => m.firefly);
    const rules = all.map((m) => ({ id: `kat-${m.from.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}`, enabled: true, when: [{ field: 'category', op: 'equals', value: m.from }], setCategory: m.to, addTags: [] }));
    const regeln = toFireflyRules(rules).map((r, k, arr) => ({ ...r, order: arr.length - k, description: `Kategorien zusammenführen (Dashboard) · id:${r.labor_id}` }));
    const res = await runAction(rulesAction, { typ: 'regeln_anlegen', gruppe: RULE_GROUP, regeln, anwenden: { start: '2000-01-01', end: isoDate(today()) } });
    if (!res.ok) throw new Error(`n8n antwortet mit ${res.status || 'Fehler'}: ${String(res.response || '').slice(0, 200)}`);
    data = await call({ sent: all.map((m) => m.from) });
    return all.length;
  }

  async function act(fn) {
    try {
      await fn();
      api.forget(); // Summen und Listen aller Seiten ändern sich
    } catch (err) {
      note = `<span class="bad">${esc(err.message)}</span>`;
    }
    render();
  }

  el.addEventListener('change', (e) => {
    const box = e.target.closest('[data-pick]');
    if (!box) return;
    if (box.checked) picked.add(box.dataset.pick);
    else picked.delete(box.dataset.pick);
    render();
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = e.submitter?.value || 'dashboard';
    const to = new FormData(e.target).get('to').trim();
    const from = [...picked].filter((f) => f.toLowerCase() !== to.toLowerCase());
    if (!to || !from.length) return;
    if (mode === 'firefly' && !window.confirm(`In Firefly ${from.map((f) => `„${f}“`).join(', ')} → „${to}“ zusammenführen?\n\nDas Dashboard legt per n8n je Kategorie eine Regel an und wendet sie auf alle Buchungen an – die Kategorie der Buchungen ändert sich in Firefly.`)) return;
    e.submitter.disabled = true;
    act(async () => {
      data = await call({ from, to, firefly: mode === 'firefly' });
      picked.clear();
      note = mode === 'firefly' ? '' : `✓ ${from.map((f) => `„${esc(f)}“`).join(', ')} zählt jetzt als „${esc(to)}“ – im ganzen Dashboard.`;
      if (mode === 'firefly') {
        el.querySelector('.cm-form').insertAdjacentHTML('afterend', '<p class="muted cm-busy">Übertrage nach Firefly … (kann bei vielen Buchungen ein paar Minuten dauern)</p>');
        const n = await sendToFirefly();
        note = `<span class="good">✓ In Firefly: ${n} Regel${n === 1 ? '' : 'n'} in der Gruppe „${esc(RULE_GROUP)}“, auf alle Buchungen angewendet.</span>`;
      }
    });
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sugg !== undefined) {
      const s = suggestions(data.kategorien)[Number(b.dataset.sugg)];
      picked.clear();
      [...s.from, s.to].forEach((n) => picked.add(n));
      render();
      el.querySelector('#cm-form input[name=to]').value = s.to;
      el.querySelector('#cm-form').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (b.dataset.unmerge) {
      b.disabled = true;
      act(async () => {
        const wasSent = data.zusammengefuehrt.find((m) => m.from === b.dataset.unmerge)?.sentAt;
        data = await call({ unmerge: b.dataset.unmerge });
        note = `„${esc(b.dataset.unmerge)}“ ist wieder eine eigene Kategorie im Dashboard.`;
        if (wasSent && rulesAction) {
          // die Regel in Firefly entfernen (Abgleich der Gruppe) – bereits geänderte Buchungen bleiben, wie sie sind
          await sendToFirefly();
          note += ' Die Regel in Firefly ist entfernt; Buchungen, die sie schon umgestellt hat, behalten die neue Kategorie.';
        }
      });
      return;
    }
    if (b.id === 'cm-resend') {
      b.disabled = true;
      act(async () => {
        const n = await sendToFirefly();
        note = `<span class="good">✓ ${n} Regel${n === 1 ? '' : 'n'} in Firefly abgeglichen und angewendet.</span>`;
      });
    }
  });

  call().then((d) => {
    data = d;
    if (el.isConnected) render();
  }).catch((err) => (el.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`));
}
