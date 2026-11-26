// Aufräumen: zwei Karten, die alles frisch bei Firefly fragen (alle Jahre)
//  - „Alte Kategorien in Regeln und Import“: Firefly-Regeln, eigene Einstellungen und die Import-Konfiguration,
//    die noch zusammengeführte oder gelöschte Kategorien setzen – sonst entstehen die alten Kategorien neu
//  - „Leere Gegenkonten und Tags“: ohne eine einzige Buchung – zum Löschen
// Server: /local/bezuege (lib/refs.js). Änderungen in Firefly über die Automation „Kategorie übernehmen“ (Zweig „Konten?“).

import * as api from './api.js';
import { esc, fmtDate } from './util.js';
import { runCleanupTask } from './txedit.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const get = (art, fresh) => fetch(`/local/bezuege?art=${art}${fresh ? '&frisch=1' : ''}`, { headers: { 'X-No-Cache': '1' } }).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
  return d;
});
const post = (body, art = '') => fetch(`/local/bezuege${art ? `?art=${art}` : ''}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
  return d;
});
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');
const catList = (cats) => `<datalist id="refs-cats">${cats.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>`;

// ================================================================================================
export function refsCard(el, meta, { editAction }) {
  let rules = null; // null | 'laden' | Fehlertext | Ergebnis
  let imp = null; // dito, Import-Konfiguration
  let impFile = null; // eigene Datei { name, config } statt der hinterlegten
  let note = '';
  const choice = new Map(); // `${regelId}|${index}` bzw. `imp|${id}` → neue Kategorie
  const off = new Set(); // abgewählte Funde

  async function load(fresh = false) {
    rules = 'laden';
    imp = 'laden';
    render();
    [rules, imp] = await Promise.all([
      get('regeln', fresh).catch((err) => err.message),
      (impFile ? post({ config: impFile.config }, 'import') : get('import')).catch((err) => err.message),
    ]);
    render();
  }

  function rulesHtml() {
    if (rules === 'laden') return '<p class="muted"><span class="spinner"></span> Lese die Firefly-Regeln …</p>';
    if (typeof rules === 'string') return `<p class="bad">${esc(rules)}</p>`;
    const own = rules.regeln.filter((r) => !r.dashboard);
    const managed = rules.regeln.filter((r) => r.dashboard);
    const row = (r) => r.funde.map((f) => {
      const k = `${r.id}|${f.index}`;
      const val = choice.has(k) ? choice.get(k) : f.neu;
      return `<div class="row refs-row${r.dashboard ? ' nocheck' : ''}" style="cursor:default">
        ${r.dashboard ? '' : `<input type="checkbox" data-refs-pick="${esc(k)}"${off.has(k) || !val ? '' : ' checked'}${val ? '' : ' disabled'} aria-label="umstellen">`}
        <div style="min-width:0"><div class="title">${esc(r.titel)} <span class="muted small-text">· ${esc(r.gruppe || 'ohne Gruppe')}${r.aktiv ? '' : ' · inaktiv'}</span></div>
          <div class="subtitle">setzt „${esc(f.alt)}“ – ${f.grund === 'zusammengeführt' ? `zusammengeführt in „${esc(f.neu)}“` : f.grund === 'gelöscht' ? 'gelöscht' : 'gibt es in Firefly nicht (wird beim nächsten Treffer neu angelegt)'}</div></div>
        ${r.dashboard ? '<span class="muted small-text">kommt aus dem Dashboard – siehe unten</span>'
    : `<label class="refs-to">→ <input class="input" list="refs-cats" data-refs-to="${esc(k)}" value="${esc(val)}" placeholder="neue Kategorie" aria-label="neue Kategorie"></label>`}</div>`;
    }).join('');
    const sel = own.flatMap((r) => r.funde.map((f) => ({ r, f, k: `${r.id}|${f.index}` }))).filter(({ k, f }) => !off.has(k) && (choice.has(k) ? choice.get(k) : f.neu));
    const dash = rules.dashboard || [];
    return `<p class="muted small-text">${rules.geprueft} Firefly-Regeln geprüft${rules.stand ? ` (Stand ${when(rules.stand)})` : ''}.</p>
      ${own.length ? `<div class="list">${own.map(row).join('')}</div>
        <div class="z-ff-btns" style="margin-top:8px">${editAction ? `<button class="btn small" type="button" data-refs-fix${sel.length ? '' : ' disabled'}>${sel.length} Regel-Aktion${sel.length === 1 ? '' : 'en'} in Firefly umstellen</button>` : '<span class="muted small-text">Zum Umstellen fehlt die Automation „Kategorie übernehmen“.</span>'}</div>`
    : '<div class="empty">Keine Firefly-Regel setzt eine alte Kategorie.</div>'}
      ${managed.length ? `<p class="muted small-text">${plural(managed.length, 'Regel', 'Regeln')} aus Dashboard-Gruppen (${[...new Set(managed.map((r) => r.gruppe))].map(esc).join(', ')}) – die schreibt das Dashboard beim nächsten Übertragen neu; darum unten im Dashboard umstellen und dann neu übertragen.</p>` : ''}
      ${dash.length ? `<h3 class="sub-h" style="margin-top:14px">Im Dashboard</h3>
        <div class="list">${dash.map((d) => `<div class="row" style="cursor:default"><div style="min-width:0"><div class="title">${esc(d.wo)}</div>
          <div class="subtitle">${plural(d.n, 'Eintrag setzt', 'Einträge setzen')} „${esc(d.alt)}“${d.neu ? ` → wird „${esc(d.neu)}“` : ' (gelöscht – Ziel bitte selbst wählen)'}</div></div></div>`).join('')}</div>
        ${dash.some((d) => d.neu) ? `<button class="btn small" type="button" data-refs-rename style="margin-top:8px">Im Dashboard umstellen</button>
          <p class="muted small-text">Danach die betroffenen Regeln neu übertragen (Zuordnen → „In Firefly übernehmen“ bzw. Labor / Import-Regeln) – dann stimmen auch die Dashboard-Regelgruppen in Firefly.</p>` : ''}` : ''}`;
  }

  function importHtml() {
    if (imp === 'laden') return '<p class="muted"><span class="spinner"></span> Prüfe die Import-Konfiguration …</p>';
    const pick = `<label class="btn small" style="cursor:pointer">${impFile ? 'Andere Datei …' : 'Konfigurationsdatei wählen …'}<input type="file" accept=".json,application/json" data-refs-file hidden></label>`;
    if (typeof imp === 'string') return `<p class="bad">${esc(imp)}</p>${pick}`;
    if (!imp.config) return `<p class="muted small-text">Keine Import-Konfiguration hinterlegt. Wähle die JSON-Datei deines Data Importers (je Konto eine) – sie wird nur geprüft, nicht gespeichert.</p>${pick}`;
    const src = impFile ? `Datei „${esc(impFile.name)}“` : `hinterlegte Konfiguration${imp.datei ? ` „${esc(imp.datei)}“` : ''}${imp.hinterlegt ? ` (vom ${fmtDate(imp.hinterlegt)})` : ''}`;
    const rows = imp.funde.map((g) => {
      const k = `imp|${g.id}`;
      const val = choice.has(k) ? choice.get(k) : g.neu;
      const ok = imp.kategorien.some((c) => c.name.toLowerCase() === String(val || '').trim().toLowerCase());
      return `<div class="row refs-row nocheck" style="cursor:default">
        <div style="min-width:0"><div class="title">${g.alt ? `„${esc(g.alt)}“` : `Kategorie-ID ${esc(g.id)}`} <span class="muted small-text">· ${g.grund === 'zusammengeführt' ? 'zusammengeführt' : g.grund === 'gelöscht' ? 'gelöscht' : 'gibt es in Firefly nicht (mehr)'}</span></div>
          <div class="subtitle">${plural(g.werte.length, 'Übersetzung', 'Übersetzungen')}: ${esc(g.werte.slice(0, 6).join(', '))}${g.werte.length > 6 ? ' …' : ''}</div></div>
        <label class="refs-to">→ <input class="input" list="refs-cats" data-refs-to="${esc(k)}" value="${esc(val)}" placeholder="Kategorie in Firefly" aria-label="neue Kategorie">${val && !ok ? '<span class="bad small-text">gibt es in Firefly nicht</span>' : ''}</label></div>`;
    }).join('');
    const ready = imp.funde.filter((g) => {
      const val = choice.has(`imp|${g.id}`) ? choice.get(`imp|${g.id}`) : g.neu;
      return imp.kategorien.some((c) => c.name.toLowerCase() === String(val || '').trim().toLowerCase());
    });
    return `<p class="muted small-text">Geprüft: ${src}. Der Data Importer ordnet Werte (z. B. Händlernamen) einer Kategorie-ID zu – zeigt sie auf eine alte Kategorie, entsteht diese beim Import neu. ${pick}</p>
      ${imp.funde.length ? `<div class="list">${rows}</div>
        <div class="z-ff-btns" style="margin-top:8px"><button class="btn small" type="button" data-refs-download${ready.length ? '' : ' disabled'}>Korrigierte Konfiguration herunterladen (${ready.length} von ${imp.funde.length})</button>
          ${!impFile && ready.length ? '<button class="link-btn" type="button" data-refs-store>auch als hinterlegte Konfiguration speichern</button>' : ''}</div>
        <p class="muted small-text">Die heruntergeladene Datei im Data Importer bzw. in deinem Import-Ordner (je Konto) ersetzen. Andere Konten: dort „Konfigurationsdatei wählen …“.</p>`
    : '<div class="empty">Die Konfiguration zeigt auf keine alte Kategorie.</div>'}`;
  }

  function render() {
    el.innerHTML = `${catList(imp && typeof imp === 'object' && imp.kategorien ? imp.kategorien : [])}
      <p class="muted" style="margin-top:0">Steht eine zusammengeführte oder gelöschte Kategorie noch in einer Firefly-Regel oder in der Import-Konfiguration, legt Firefly sie beim nächsten Treffer neu an – und das Aufräumen fängt von vorn an. Geprüft wird frisch bei Firefly.</p>
      ${note ? `<div class="cm-note" role="status">${note}</div>` : ''}
      ${rules === null ? '<button class="btn small" type="button" data-refs-load>Jetzt prüfen</button>' : `
        <h3 class="sub-h">Firefly-Regeln <button class="link-btn" type="button" data-refs-load="frisch">neu prüfen</button></h3>${rulesHtml()}
        <h3 class="sub-h" style="margin-top:18px">Import-Konfiguration (Data Importer)</h3>${importHtml()}`}`;
    const n = (rules && typeof rules === 'object' ? rules.regeln.length + (rules.dashboard || []).length : 0) + (imp && typeof imp === 'object' && imp.funde ? imp.funde.length : 0);
    meta.textContent = rules && typeof rules === 'object' ? (n ? plural(n, 'Fund', 'Funde') : 'alles sauber') : '';
  }

  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.refsPick) {
      if (t.checked) off.delete(t.dataset.refsPick);
      else off.add(t.dataset.refsPick);
      return render();
    }
    if (t.dataset.refsTo) {
      choice.set(t.dataset.refsTo, t.value.trim());
      return render();
    }
    if (t.matches('[data-refs-file]')) {
      const file = t.files?.[0];
      if (!file) return undefined;
      try {
        const config = JSON.parse(await file.text());
        impFile = { name: file.name, config };
        imp = 'laden';
        render();
        imp = await post({ config }, 'import');
      } catch (err) {
        imp = `Datei nicht lesbar: ${err.message}`;
      }
      return render();
    }
    return undefined;
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.refsLoad !== undefined) {
      note = '';
      return load(b.dataset.refsLoad === 'frisch');
    }
    if (b.dataset.refsFix !== undefined) {
      // je Regel alle Aktionen schicken, die gewählten „Kategorie setzen“ ersetzt
      const own = rules.regeln.filter((r) => !r.dashboard);
      const changes = [];
      for (const r of own) {
        const actions = r.actions.map((x) => ({ ...x }));
        let changed = false;
        for (const f of r.funde) {
          const k = `${r.id}|${f.index}`;
          const val = choice.has(k) ? choice.get(k) : f.neu;
          if (off.has(k) || !val) continue;
          actions[f.index].value = val;
          changed = true;
        }
        if (changed) changes.push({ id: r.id, titel: r.titel, actions });
      }
      if (!changes.length || !window.confirm(`${plural(changes.length, 'Firefly-Regel', 'Firefly-Regeln')} umstellen?\n\n${changes.slice(0, 12).map((c) => `• ${c.titel}`).join('\n')}`)) return undefined;
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span> Stelle um …';
      try {
        await runCleanupTask(editAction, 'regeln_aendern', { regeln: changes.map(({ id, actions }) => ({ id, actions })) }, 'Regeln ändern');
        note = `<span class="good">✓ ${plural(changes.length, 'Regel', 'Regeln')} in Firefly umgestellt.</span>`;
        choice.clear();
        off.clear();
        await post({ vergessen: true });
        return load(true);
      } catch (err) {
        note = `<span class="bad">${esc(err.message)}</span>`;
        return render();
      }
    }
    if (b.dataset.refsRename !== undefined) {
      const map = Object.fromEntries((rules.dashboard || []).filter((d) => d.neu).map((d) => [d.alt, d.neu]));
      if (!window.confirm(`Im Dashboard umstellen?\n\n${Object.entries(map).map(([a, c]) => `• ${a} → ${c}`).join('\n')}`)) return undefined;
      try {
        const r = await post({ umbenennen: map });
        api.forget();
        note = `<span class="good">✓ ${plural(r.geaendert, 'Eintrag', 'Einträge')} im Dashboard umgestellt. Jetzt die Regeln neu übertragen (Zuordnen → „In Firefly übernehmen“).</span>`;
        return load(true);
      } catch (err) {
        note = `<span class="bad">${esc(err.message)}</span>`;
        return render();
      }
    }
    if (b.dataset.refsDownload !== undefined || b.dataset.refsStore !== undefined) {
      try {
        const source = impFile ? impFile.config : (await fetch('/local/cleanup/importconfig').then((r) => r.json())).config;
        const cfg = structuredClone(source);
        const byName = new Map(imp.kategorien.map((c) => [c.name.toLowerCase(), c]));
        let n = 0;
        for (const g of imp.funde) {
          const val = choice.has(`imp|${g.id}`) ? choice.get(`imp|${g.id}`) : g.neu;
          const target = byName.get(String(val || '').trim().toLowerCase());
          if (!target) continue;
          cfg.roles.forEach((role, col) => {
            if (role !== 'category-name' && role !== 'category-id') return;
            const map = cfg.mapping?.[col];
            if (!map) return;
            for (const [k, v] of Object.entries(map)) {
              if (String(v) === g.id) {
                map[k] = typeof v === 'number' ? Number(target.id) : target.id;
                n += 1;
              }
            }
          });
        }
        if (b.dataset.refsStore !== undefined) {
          const stored = await fetch('/local/cleanup/importconfig').then((r) => r.json());
          const r = await fetch('/local/cleanup/importconfig', { method: 'PUT', headers, body: JSON.stringify({ file: stored.file || 'import-config.json', config: cfg }) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          note = `<span class="good">✓ Hinterlegte Konfiguration aktualisiert (${plural(n, 'Übersetzung', 'Übersetzungen')}). Die Datei im Data Importer bzw. Import-Ordner trotzdem ersetzen – herunterladen.</span>`;
          imp = await get('import');
          return render();
        }
        const blob = new Blob([JSON.stringify(cfg, null, 4)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (impFile?.name || imp.datei || 'import-config.json').replace(/\.json$/i, '') + '-korrigiert.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        note = `<span class="good">✓ ${plural(n, 'Übersetzung', 'Übersetzungen')} umgestellt – Datei „${esc(a.download)}“ heruntergeladen.</span>`;
      } catch (err) {
        note = `<span class="bad">${esc(err.message)}</span>`;
      }
      return render();
    }
    return undefined;
  });

  render();
}

// ================================================================================================
export function emptyCard(el, meta, { editAction }) {
  let res = null; // null | 'laden' | Fehlertext | { konten, tags, … }
  let note = '';
  const off = new Set(); // abgewählt: `k|id` bzw. `t|id`

  async function load(fresh = false) {
    res = 'laden';
    render();
    res = await get('leer', fresh).catch((err) => err.message);
    off.clear();
    render();
  }
  const list = (items, kind) => `<div class="list cm-merged">${items.map((x) => `<label class="row" style="cursor:pointer;display:flex;gap:10px;align-items:center;justify-content:flex-start">
      <input type="checkbox" data-empty-x="${kind}|${esc(x.id)}"${off.has(`${kind}|${x.id}`) ? '' : ' checked'}>
      <span style="min-width:0"><span class="title">${esc(x.name)}</span>${x.art ? ` <span class="muted small-text">· ${esc(x.art)}</span>` : ''}</span></label>`).join('')}</div>`;

  function render() {
    let body;
    if (res === null) body = '<button class="btn small" type="button" data-empty-load>Jetzt prüfen</button>';
    else if (res === 'laden') body = '<p class="muted"><span class="spinner"></span> Frage Firefly je Gegenkonto und Tag … (bei vielen Konten etwas Geduld)</p>';
    else if (typeof res === 'string') body = `<p class="bad">${esc(res)}</p><button class="btn small" type="button" data-empty-load>Erneut prüfen</button>`;
    else {
      const k = res.konten.filter((x) => !off.has(`k|${x.id}`));
      const t = res.tags.filter((x) => !off.has(`t|${x.id}`));
      body = `<p class="muted small-text">${res.gepruefteKonten} Gegenkonten und ${res.gepruefteTags} Tags geprüft${res.stand ? ` (Stand ${when(res.stand)})` : ''}. <button class="link-btn" type="button" data-empty-load="frisch">neu prüfen</button></p>
        <h3 class="sub-h">Gegenkonten ohne Buchung (${res.konten.length})</h3>
        ${res.konten.length ? `${list(res.konten, 'k')}${editAction ? `<button class="btn small" type="button" data-empty-del="k" style="margin-top:8px"${k.length ? '' : ' disabled'}>${k.length} ausgewählte löschen</button>` : ''}` : '<div class="empty">Keine.</div>'}
        <h3 class="sub-h" style="margin-top:16px">Tags ohne Buchung (${res.tags.length})</h3>
        ${res.tags.length ? `${list(res.tags, 't')}${editAction ? `<button class="btn small" type="button" data-empty-del="t" style="margin-top:8px"${t.length ? '' : ' disabled'}>${t.length} ausgewählte löschen</button>` : ''}` : '<div class="empty">Keine.</div>'}
        ${editAction ? '' : '<p class="muted small-text">Zum Löschen fehlt die Automation „Kategorie übernehmen“ (Vorlage n8n/firefly-buchung-bearbeiten.json).</p>'}
        <p class="muted small-text">Steht ein Gegenkonto noch in einer Regel oder kommt es wieder in einem Import vor, legt Firefly es neu an.</p>`;
    }
    el.innerHTML = `<p class="muted" style="margin-top:0">Gegenkonten (Händler, Zahler) und Tags, an denen in Firefly keine einzige Buchung hängt – egal wie alt. Bleiben oft nach dem Zusammenführen übrig.</p>
      ${note ? `<div class="cm-note" role="status">${note}</div>` : ''}${body}`;
    meta.textContent = res && typeof res === 'object' ? `${res.konten.length} Gegenkonten · ${res.tags.length} Tags` : '';
  }

  el.addEventListener('change', (e) => {
    const x = e.target.dataset.emptyX;
    if (!x) return;
    if (e.target.checked) off.delete(x);
    else off.add(x);
    render();
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.emptyLoad !== undefined) {
      note = '';
      load(b.dataset.emptyLoad === 'frisch');
      return;
    }
    const kind = b.dataset.emptyDel;
    if (!kind) return;
    const items = (kind === 'k' ? res.konten : res.tags).filter((x) => !off.has(`${kind}|${x.id}`));
    const what = kind === 'k' ? (items.length === 1 ? 'Gegenkonto' : 'Gegenkonten') : (items.length === 1 ? 'Tag' : 'Tags');
    if (!items.length || !window.confirm(`${items.length} ${what} in Firefly löschen?\n\n${items.slice(0, 15).map((x) => `• ${x.name}`).join('\n')}${items.length > 15 ? '\n…' : ''}\n\nSie haben in Firefly keine einzige Buchung (geprüft).`)) return;
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span> Lösche …';
    try {
      await runCleanupTask(editAction, kind === 'k' ? 'konten_loeschen' : 'tags_loeschen', { ids: items.map((x) => x.id), namen: items.map((x) => x.name) }, kind === 'k' ? 'Konten löschen' : 'Tags löschen');
      api.forget();
      note = `<span class="good">✓ ${items.length} ${what} gelöscht.</span>`;
      await load(true);
    } catch (err) {
      note = `<span class="bad">${esc(err.message)}</span>`;
      render();
    }
  });
  render();
}
