// „Kategorien zusammenführen“ (Seite „Aufräumen“): mehrere Kategorien in eine. Zwei Wege:
//   - nur im Dashboard: Auswertungen zählen sie sofort unter dem Ziel (umkehrbar, Firefly unverändert)
//   - in Firefly: per n8n-Workflow „Regeln anlegen“ eine Regel „Kategorie ist A → Kategorie B“ je Quelle,
//     angewendet auf alle Buchungen – auch künftige Importe mit der alten Kategorie landen im Ziel.
// Server: /local/kategorien (lib/ledger.js, gespeichert in DATA_DIR/autocat.json).

import * as api from './api.js';
import { esc, money, fmtDate, today, isoDate } from './util.js';
import { runAction } from './txedit.js';
import { toFireflyRules } from './rules.js';
import { similar } from './combo.js';

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
  let target = ''; // Ziel – eingetippt oder per Vorschlag
  let query = ''; // Suche in der Tabelle
  let note = '';

  const sum = (c) => c.ausgaben + c.einnahmen;
  /** Passt der Name zur Suche bzw. ist er dem Ziel ähnlich (Schreibweise, Einzahl/Mehrzahl, Teilwort)? */
  const related = (name, term) => {
    const a = fold(name);
    const b = fold(term);
    if (!b) return false;
    return a.includes(b) || b.includes(a) || similar(term, name) || b.split(' ').some((w) => w.length >= 4 && a.includes(w));
  };

  // Gerüst: Erklärung, Schritt 1 (Ziel) und Suche bleiben stehen – nur Liste und Knöpfe werden neu gezeichnet
  el.innerHTML = `
    <p class="muted" style="margin-top:0">Mehrere Kategorien zu einer machen, z. B. „Supermarkt“ und „Einkauf“ → „Lebensmittel“.
      <b>Nur im Dashboard</b> wirkt sofort und lässt sich aufheben; <b>in Firefly</b> stellt per Regel alle Buchungen um – auch künftige Importe.</p>
    <ol class="cm-steps">
      <li><b>Ziel</b> wählen – die Kategorie, die bleiben soll (vorhanden oder neu):
        <input class="input" data-cm-target list="cm-names" placeholder="z. B. Lebensmittel" aria-label="Zielkategorie"></li>
      <li><b>Ankreuzen</b>, was darin aufgehen soll – so viele du willst. Die Suche findet auch ähnliche Namen; dem Ziel ähnliche sind markiert.
        Vorschläge sind nur eine Abkürzung: „übernehmen“ setzt Ziel und Häkchen, du kannst danach weitere ankreuzen oder abwählen.</li>
      <li><b>Zusammenführen</b> – nur im Dashboard oder in Firefly (Knöpfe unten).</li>
    </ol>
    <div class="cm-tools"><input class="input" type="search" data-cm-search placeholder="Kategorien suchen, z. B. lebensm, auto, versich …" aria-label="Kategorien suchen"></div>
    <div data-cm-body><p class="muted">Lade Kategorien …</p></div>
    <datalist id="cm-names"></datalist>`;
  const body = el.querySelector('[data-cm-body]');
  const targetInput = el.querySelector('[data-cm-target]');
  const searchInput = el.querySelector('[data-cm-search]');

  function render() {
    const list = data.kategorien;
    const active = list.filter((c) => !c.ziel);
    const merged = data.zusammengefuehrt;
    const sugg = suggestions(list);
    el.querySelector('#cm-names').innerHTML = [...new Set(active.map((c) => c.name))].sort((a, b) => a.localeCompare(b, 'de')).map((n) => `<option value="${esc(n)}">`).join('');
    meta.textContent = `${active.length} Kategorien${merged.length ? ` · ${merged.length} zusammengeführt` : ''}`;
    const to = target.trim();
    const from = [...picked].filter((f) => f.toLowerCase() !== to.toLowerCase());
    const like = (c) => to && c.name.toLowerCase() !== to.toLowerCase() && related(c.name, to);
    // Reihenfolge: ausgewählte, dem Ziel ähnliche, dann nach Buchungen; die Suche filtert
    const rows = active
      .filter((c) => !query.trim() || related(c.name, query) || picked.has(c.name))
      .sort((a, b) => Number(picked.has(b.name)) - Number(picked.has(a.name)) || Number(like(b)) - Number(like(a)) || b.n - a.n);
    const why = !to ? 'Erst oben das Ziel wählen.' : !from.length ? 'Kategorien ankreuzen, die in „' + esc(to) + '“ aufgehen sollen.' : '';
    body.innerHTML = `
      ${note ? `<div class="cm-note">${note}</div>` : ''}
      ${sugg.length ? `<div class="cm-sugg"><b>Vorschläge</b> (fast gleiche Namen):
        ${sugg.map((x, i) => `<div class="cm-sugg-row"><span>${x.from.map((f) => `„${esc(f)}“`).join(', ')} → <b>„${esc(x.to)}“</b></span>
          <button class="btn small" type="button" data-sugg="${i}">übernehmen</button></div>`).join('')}</div>` : ''}
      <div class="table-wrap cm-wrap"><table class="cm-table">
        <thead><tr><th class="pick-cell"></th><th>Kategorie</th><th class="num">Buchungen</th><th class="num hide-sm">Ausgaben</th><th class="num hide-sm">Einnahmen</th></tr></thead>
        <tbody>${rows.map((c) => {
          const isTarget = to && c.name.toLowerCase() === to.toLowerCase();
          const parts = merged.filter((m) => m.to.toLowerCase() === c.name.toLowerCase());
          return `<tr data-name="${esc(c.name)}" class="${picked.has(c.name) ? 'cm-picked' : ''}${isTarget ? ' cm-target' : ''}">
          <td class="pick-cell">${isTarget ? '<span title="Ziel">★</span>' : `<input type="checkbox" data-pick="${esc(c.name)}" ${picked.has(c.name) ? 'checked' : ''} aria-label="${esc(c.name)} auswählen">`}</td>
          <td><div class="desc">${esc(c.name)} ${isTarget ? '<span class="badge good">Ziel</span>' : like(c) ? '<span class="badge warn" title="Ähnlicher Name wie das Ziel">ähnlich</span>' : ''}</div>
            <div class="flow">${!c.inFirefly ? 'nur im Dashboard (automatisch/zusammengeführt)' : c.n === 0 ? 'in Firefly, ohne Buchungen' : c.auto && c.firefly ? 'Firefly + automatisch' : c.auto ? 'automatisch zugeordnet' : 'Firefly'}${parts.length ? ` · enthält ${parts.map((m) => `„${esc(m.from)}“`).join(', ')}` : ''}${!isTarget ? ` · <button type="button" class="link-btn" data-as-target="${esc(c.name)}">als Ziel</button>` : ''}</div></td>
          <td class="num">${c.n}</td>
          <td class="num hide-sm">${c.ausgaben ? money(c.ausgaben) : '–'}</td>
          <td class="num hide-sm">${c.einnahmen ? money(c.einnahmen) : '–'}</td></tr>`;
        }).join('') || `<tr><td colspan="5" class="muted">Nichts gefunden für „${esc(query)}“.</td></tr>`}</tbody></table></div>
      <div class="cm-form">
        <div class="cm-summary">${from.length && to ? `<span><b>${from.length}</b> → „<b>${esc(to)}</b>“:</span> ${from.map((f) => `<span class="chip small">${esc(f)} <button type="button" class="chip-x" data-unpick="${esc(f)}" aria-label="${esc(f)} abwählen">✕</button></span>`).join(' ')}` : `<span class="muted">${why}</span>`}</div>
        <div class="cm-btns">
          <button class="btn" type="button" data-merge="dashboard"${from.length && to ? '' : ' disabled'}>Nur im Dashboard</button>
          <button class="btn primary" type="button" data-merge="firefly"${from.length && to && rulesAction ? '' : ' disabled'} title="${rulesAction ? 'Per n8n-Workflow „Regeln anlegen“' : 'Dafür eine Automation mit Auslöser „Firefly-Regeln anlegen“ einrichten (n8n/firefly-buchung-bearbeiten.json)'}">In Firefly zusammenführen</button>
          ${picked.size ? '<button class="link-btn" type="button" data-unpick-all>Auswahl leeren</button>' : ''}
        </div>
      </div>
      ${!rulesAction ? '<p class="muted small-text">„In Firefly“ braucht unter <a href="#/automationen">Automationen</a> eine Automation mit Auslöser „Firefly-Regeln anlegen“ (Vorlage n8n/firefly-buchung-bearbeiten.json).</p>' : ''}
      ${merged.length ? `<h3 class="sub-h" style="margin-top:18px">Zusammengeführt</h3>
        <div class="list cm-merged">${merged.map((m) => `<div class="row" style="cursor:default">
          <div style="min-width:0"><div class="title">„${esc(m.from)}“ → „${esc(m.to)}“</div>
            <div class="subtitle">${m.sentAt ? `in Firefly übertragen am ${fmtDate(m.sentAt)} (Regel in der Gruppe „${esc(RULE_GROUP)}“)` : m.firefly ? '<span class="bad">für Firefly vorgesehen, Übertragen fehlgeschlagen – erneut versuchen</span>' : 'nur im Dashboard – lässt sich jederzeit nach Firefly übertragen'}</div></div>
          <span class="cm-acts">${!m.sentAt && rulesAction ? `<button class="btn small" type="button" data-tofirefly="${esc(m.from)}" title="Regel „Kategorie ist ${esc(m.from)} → ${esc(m.to)}“ in Firefly anlegen und auf alle Buchungen anwenden">nach Firefly übertragen</button>` : ''}
            <button class="link-btn" type="button" data-unmerge="${esc(m.from)}">aufheben</button></span></div>`).join('')}</div>
        ${merged.filter((m) => !m.sentAt).length > 1 && rulesAction ? `<button class="btn small" type="button" id="cm-all" style="margin-top:10px">Alle ${merged.filter((m) => !m.sentAt).length} nach Firefly übertragen</button>` : ''}
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

  let searchTimer;
  el.addEventListener('input', (e) => {
    if (e.target === searchInput) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = searchInput.value;
        render();
      }, 150);
    } else if (e.target === targetInput) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        target = targetInput.value;
        render();
      }, 250);
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target === targetInput) {
      target = targetInput.value;
      return render();
    }
    const box = e.target.closest('[data-pick]');
    if (!box) return;
    if (box.checked) picked.add(box.dataset.pick);
    else picked.delete(box.dataset.pick);
    // noch kein Ziel: die größte ausgewählte Kategorie vorschlagen
    if (!target.trim() && picked.size >= 2) {
      const list = data.kategorien;
      target = [...picked].sort((a, b) => sum(list.find((c) => c.name === b) || { ausgaben: 0, einnahmen: 0 }) - sum(list.find((c) => c.name === a) || { ausgaben: 0, einnahmen: 0 }))[0];
      targetInput.value = target;
    }
    render();
  });
  function merge(mode, btn) {
    const to = target.trim();
    const from = [...picked].filter((f) => f.toLowerCase() !== to.toLowerCase());
    if (!to || !from.length) return;
    if (mode === 'firefly' && !window.confirm(`In Firefly ${from.map((f) => `„${f}“`).join(', ')} → „${to}“ zusammenführen?\n\nDas Dashboard legt per n8n je Kategorie eine Regel an und wendet sie auf alle Buchungen an – die Kategorie der Buchungen ändert sich in Firefly.`)) return;
    btn.disabled = true;
    act(async () => {
      data = await call({ from, to, firefly: mode === 'firefly' });
      picked.clear();
      target = '';
      targetInput.value = '';
      note = mode === 'firefly' ? '' : `✓ ${from.map((f) => `„${esc(f)}“`).join(', ')} zählt jetzt als „${esc(to)}“ – im ganzen Dashboard.`;
      if (mode === 'firefly') {
        body.querySelector('.cm-form').insertAdjacentHTML('afterend', '<p class="muted cm-busy">Übertrage nach Firefly … (kann bei vielen Buchungen ein paar Minuten dauern)</p>');
        const n = await sendToFirefly();
        note = `<span class="good">✓ In Firefly: ${n} Regel${n === 1 ? '' : 'n'} in der Gruppe „${esc(RULE_GROUP)}“, auf alle Buchungen angewendet.</span>`;
      }
    });
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.merge) return merge(b.dataset.merge, b);
    if (b.dataset.asTarget) {
      target = b.dataset.asTarget;
      targetInput.value = target;
      picked.delete(target);
      return render();
    }
    if (b.dataset.unpick) {
      picked.delete(b.dataset.unpick);
      return render();
    }
    if (b.dataset.unpickAll !== undefined) {
      picked.clear();
      return render();
    }
    if (b.dataset.sugg !== undefined) {
      const x = suggestions(data.kategorien)[Number(b.dataset.sugg)];
      picked.clear();
      x.from.forEach((n) => picked.add(n));
      target = x.to;
      targetInput.value = x.to;
      render();
      body.querySelector('.cm-form').scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    // nachträglich nach Firefly: einzelne oder alle noch nicht übertragenen Zusammenführungen
    const later = b.dataset.tofirefly ? data.zusammengefuehrt.filter((m) => m.from === b.dataset.tofirefly)
      : b.id === 'cm-all' ? data.zusammengefuehrt.filter((m) => !m.sentAt) : null;
    if (later?.length) {
      if (!window.confirm(`In Firefly zusammenführen?\n\n${later.map((m) => `„${m.from}“ → „${m.to}“`).join('\n')}\n\nDas Dashboard legt per n8n je Kategorie eine Regel an und wendet sie auf alle Buchungen an – die Kategorie der Buchungen ändert sich in Firefly.`)) return;
      b.disabled = true;
      act(async () => {
        for (const m of later) data = await call({ from: [m.from], to: m.to, firefly: true });
        const n = await sendToFirefly();
        note = `<span class="good">✓ In Firefly übertragen: ${later.map((m) => `„${esc(m.from)}“ → „${esc(m.to)}“`).join(', ')} (${n} Regel${n === 1 ? '' : 'n'} in der Gruppe, auf alle Buchungen angewendet).</span>`;
      });
    }
  });

  call().then((d) => {
    data = d;
    if (el.isConnected) render();
  }).catch((err) => (el.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div>`));
}
