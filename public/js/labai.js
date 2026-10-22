// KI-Analyse im Kategorien-Labor: ein lokales Sprachmodell (Ollama) bewertet
// Händler – Kategorie, Tags, Bedarf, Sicherheit. Die Ergebnisse sind eine
// zuschaltbare Ebene über den eigenen Regeln. Neue Kategorien/Tags werden am
// Bestand in Firefly erkannt und lassen sich hier prüfen (umbenennen,
// zusammenlegen, ignorieren). Nichts davon ändert Firefly – das passiert erst
// über „In Firefly anlegen“, „Änderungen an n8n übergeben“ oder den Export.

import { money, esc, fmtDate } from './util.js';
import { partyKey } from './rules.js';
import { shareStrip } from './dist.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };

/**
 * onChange(full): full = die Buchungen müssen neu durchgerechnet werden (KI-Ergebnisse,
 * Entscheidungen, Ebene oder Bestand geändert); sonst reicht es, diese Karte neu zu zeichnen.
 */
export function createAiPanel({ el, txs, knownCategories, code, from, onChange }) {
  let aiData = { labels: {}, scheme: null, job: null, settings: {}, decisions: { categories: {}, tags: {} }, pool: null };
  let aiLayer = { on: false, min: 80 };
  let aiFilter = 'alle';
  let aiEditing = null; // „kind:name“ des neuen Namens, der gerade umbenannt wird
  let models = null; // { list } oder { error } – einmal laden, nicht bei jedem Neuzeichnen
  let preview = null; // { quality, merchants, lines } – was die KI zu sehen bekommt

  async function loadPreview() {
    preview = await fetch('/local/ai/preview').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    onChange();
  }

  /** Hinweis auf nichtssagende Importdaten + die Zeilen, die das Modell bekommt. */
  function renderPreview() {
    if (!preview) return '';
    const q = preview.quality;
    const pct = (n) => Math.round((n / (q.total || 1)) * 100);
    const weak = q.total && (pct(q.genericDescription) >= 30 || pct(q.genericParty) >= 10);
    return `${weak ? `<div class="ai-hint"><b>Deine Importdaten sind wenig aussagekräftig:</b>
        ${pct(q.genericDescription) >= 30 ? `Bei ${pct(q.genericDescription)} % der Ausgaben steht in der Beschreibung nur ein Bank-Standardtext (z. B. „Kartenzahlung“, „Lastschrift“).` : ''}
        ${q.genericParty ? `Bei ${pct(q.genericParty)} % fehlt ein echter Empfänger.` : ''}
        ${q.fromNotes ? `Für ${pct(q.fromNotes)} % erkennt das Dashboard den Händler deshalb aus den Notizen.` : ''}
        ${q.unknown ? `${q.unknown} Buchungen haben gar keinen erkennbaren Händler und werden übersprungen.` : ''}
        Besser wird es, wenn beim Import der Name des Zahlungsbeteiligten als Gegenkonto und der Verwendungszweck als Beschreibung ankommen.</div>` : ''}
      <details class="ai-preview"><summary>Was die KI sieht (${preview.merchants} Händler)</summary>
        <p class="muted">So bekommt das Modell die ${Math.min(8, preview.merchants)} größten Händler – Bank-Standardtexte, Daten und Nummern sind entfernt, Notizen einbezogen:</p>
        <pre>${preview.lines.map(esc).join('\n')}</pre></details>`;
  }

  async function loadModels() {
    models = await fetch('/local/ai/models').then(async (r) => {
      const d = await r.json();
      return r.ok ? { list: d.models || [] } : { error: d.message || `HTTP ${r.status}` };
    }).catch((err) => ({ error: err.message }));
    onChange();
  }

  /** Messwerte der Probe-Anfrage verständlich machen. */
  function verdict(m) {
    const facts = [`Antwort nach ${m.seconds} s`, m.loadSeconds >= 1 ? `davon Modell laden ${m.loadSeconds} s` : 'Modell war schon geladen',
      m.perSecond ? `schreibt ${m.perSecond} Token/s` : '', m.promptPerSecond ? `liest ${m.promptPerSecond} Token/s` : ''].filter(Boolean).join(' · ');
    // grobe Schätzung für ein Paket mit 8 Händlern: ~1500 Token lesen, ~800 schreiben
    const perBatch = m.perSecond && m.promptPerSecond ? Math.round((1500 / m.promptPerSecond + 800 / m.perSecond) / 6) / 10 : null;
    const hint = !m.perSecond ? ''
      : m.perSecond < 3 ? 'Sehr langsam – vermutlich ohne GPU. Ein kleineres Modell (z. B. qwen2.5:3b, llama3.2:3b) oder eine längere Wartezeit hilft.'
        : m.perSecond < 8 ? 'Langsam, aber machbar – ein Durchlauf dauert eine Weile, die Seite darf dabei geschlossen werden.'
          : 'Gute Geschwindigkeit.';
    return `${facts}${perBatch ? ` · ca. ${perBatch} Min. je Paket mit 8 Händlern` : ''}${hint ? `<br>${hint}` : ''}`;
  }

  const txTags = [...new Set(txs.flatMap((t) => t.tags || []))];
  const poolSet = (kind) => new Set((aiData.pool?.[kind]?.length ? aiData.pool[kind] : kind === 'tags' ? txTags : knownCategories).map((x) => x.toLowerCase()));
  let pool = { categories: poolSet('categories'), tags: poolSet('tags') };
  const isNew = (kind, name) => Boolean(name) && !pool[kind].has(String(name).toLowerCase());
  const nameTag = (kind, name, extra = '') => `<span class="tag${isNew(kind, name) ? ' new' : ''}${extra}" title="${isNew(kind, name) ? 'neu – noch nicht in Firefly' : 'aus deinem Bestand'}">${esc(name)}</span>`;

  /** Entscheidungen aus dem Dashboard anwenden: umbenannt/zusammengelegt (Name) oder ignoriert (null). */
  const resolve = (kind, name) => {
    const d = aiData.decisions?.[kind] || {};
    return Object.hasOwn(d, name) ? d[name] : name;
  };
  const effLabel = (l) => ({
    ...l,
    kategorie: resolve('categories', l.kategorie),
    tags: [...new Set((l.tags || []).map((x) => resolve('tags', x)).filter(Boolean))],
  });
  /** Wird das Ergebnis angewendet? Angenommen immer, abgelehnt nie, sonst ab Mindest-Sicherheit. */
  const aiActive = (l) => l.status === 'ok' || (l.status !== 'nein' && l.sicherheit >= aiLayer.min);

  /** KI-Ergebnis zu einer Buchung (nur wenn die Ebene an ist und es greift). */
  const aiFor = (t) => {
    if (!aiLayer.on) return null;
    const l = aiData.labels[partyKey(t)];
    return l && aiActive(l) ? effLabel(l) : null;
  };


  function renderAi(results) {
    const st = aiData.settings || {};
    const job = aiData.job;
    const running = job && !job.finished;
    const labels = Object.entries(aiData.labels || {}).map(([key, l]) => ({ ...l, key }));
    const changedByAi = results.filter((x) => x.r.source === 'ai' && x.r.changed);
    // Bedarf über alle bewerteten Buchungen (24 Monate)
    const needs = new Map([['notwendig', 0], ['sinnvoll', 0], ['verzichtbar', 0]]);
    for (const { t } of results) {
      const l = aiData.labels[partyKey(t)];
      if (l?.bedarf) needs.set(l.bedarf, needs.get(l.bedarf) + t.amount);
    }
    const scheme = aiData.scheme?.kategorien || [];
    const testState = aiData.test; // { running } | { metrics } | { error } – läuft auf dem Server
    // während der Fortschrittsanzeige nicht unter den Fingern neu zeichnen, wenn gerade etwas eingetippt wird
    if (el.querySelector('#ai-settings, .ai-rename')?.contains(document.activeElement) && document.activeElement.matches('input')) return;
    el.innerHTML = `
      <form class="ai-settings" id="ai-settings">
        <label>Ollama-Adresse <input name="url" value="${esc(st.url || '')}" placeholder="http://ollama:11434"></label>
        <label>Modell <select name="model">${(models?.list?.length ? models.list.map((m) => m.name) : [st.model || ''])
          .map((n) => `<option value="${esc(n)}"${n === st.model ? ' selected' : ''}>${esc(n || '– wählen –')}</option>`).join('')}</select></label>
        <label>Neue Kategorien &amp; Tags <select name="freedom">${[['vorhanden', 'möglichst vorhandene'], ['sinnvoll', 'vorschlagen, wenn sinnvoll'], ['frei', 'frei vorschlagen']]
          .map(([k, l]) => `<option value="${k}"${(st.freedom || 'sinnvoll') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Wartezeit aufs Modell <select name="wait">${[5, 10, 20, 30].map((v) => `<option value="${v}"${Number(st.wait || 10) === v ? ' selected' : ''}>${v} Min.</option>`).join('')}</select></label>
        <button class="btn"${testState?.running ? ' disabled' : ''}>Speichern &amp; testen</button>
        <span class="muted" id="ai-conn">${models?.error ? `Ollama nicht erreichbar: ${esc(models.error)}` : models ? `verbunden · ${models.list.length} Modelle` : ''}</span>
      </form>
      ${testState ? `<div class="ai-test ${testState.error ? 'bad' : ''}">${testState.running ? 'Teste Modell … (beim ersten Mal wird es geladen, das kann dauern) <button class="link-btn" data-ai-stop>Anhalten</button>'
        : testState.error ? `Test fehlgeschlagen: ${esc(testState.error)}` : `Test ok: ${verdict(testState.metrics)}`}</div>` : ''}
      <div class="ai-actions">
        <button class="btn primary" data-ai-run="classify"${running ? ' disabled' : ''}>Händler bewerten${labels.length ? ' (nur neue)' : ''}</button>
        <button class="btn" data-ai-run="scheme"${running ? ' disabled' : ''} title="Die KI entwirft aus deinen Händlern ein eigenes Kategoriesystem und ordnet danach alles neu ein">Kategoriesystem neu entwerfen (Clustern)</button>
        ${labels.length && !running ? '<button class="btn" data-ai-run="all">Alle neu bewerten</button>' : ''}
        ${running ? '<button class="btn" data-ai-stop>Anhalten</button>' : ''}
        ${labels.length && !running ? '<button class="link-btn" data-ai-reset>Ergebnisse verwerfen</button>' : ''}
      </div>
      ${job ? `<div class="ai-progress"><div class="progress"><span style="width:${job.total ? Math.round((job.done / job.total) * 100) : running ? 5 : 100}%"></span></div>
        <span class="muted">${esc(job.message || '')}${job.total ? ` · ${job.done}/${job.total}` : ''}${job.note ? ` · ${esc(job.note)}` : ''}${job.lastError ? ` · letzter Fehler: ${esc(job.lastError)}` : ''}</span></div>` : ''}
      ${renderPreview()}
      ${scheme.length ? `<div class="ai-scheme"><span class="muted">KI-Kategoriesystem:</span> ${scheme.map((c) => nameTag('categories', c.name).replace('title="', `title="${esc(c.beschreibung)} · `)).join(' ')}</div>` : ''}
      ${labels.length ? `
        <div class="ai-layer">
          <label class="check"><input type="checkbox" data-ai-layer ${aiLayer.on ? 'checked' : ''}> KI-Ergebnisse anwenden</label>
          <label>ab Sicherheit <select data-ai-min>${[50, 70, 80, 90].map((v) => `<option value="${v}"${v === aiLayer.min ? ' selected' : ''}>${v} %</option>`).join('')}</select></label>
          <span class="muted">${labels.length} Händler bewertet${aiLayer.on ? ` · ändert ${changedByAi.length} Buchungen` : ''} · eigene Regeln haben Vorrang</span>
        </div>
        ${renderNewNames(labels)}
        <h3 class="sub-h" style="margin-top:16px">Bewertung: Wofür geht das Geld? <span class="muted">(Ausgaben seit ${fmtDate(from, { month: 'short', year: 'numeric' })}, Einordnung der KI)</span></h3>
        ${shareStrip([...needs].map(([name, value]) => ({ id: name, name: name[0].toUpperCase() + name.slice(1), value })), { code, max: 3 })}
        ${renderLabelTable(labels)}
        <p class="ai-note">Alles bleibt im Dashboard gespeichert – auch über Neustarts und auf anderen Geräten. Nach Firefly geht erst etwas,
          wenn du bei „Deine Regeln“ „In Firefly anlegen“, „Änderungen an n8n übergeben“ oder den Export nutzt – neue Kategorien und Tags entstehen dabei in Firefly.</p>`
        : '<div class="empty">Noch keine KI-Bewertung. Ollama-Adresse und Modell eintragen, dann „Händler bewerten“. Je nach Modell und Datenmenge dauert das einige Minuten – du kannst die Seite dabei verlassen.</div>'}`;
  }


  /** Neue Kategorien/Tags der KI: übernehmen, umbenennen/zusammenlegen oder ignorieren. */
  function renderNewNames(labels) {
    const used = { categories: new Map(), tags: new Map() };
    for (const l of labels) {
      if (l.status === 'nein') continue;
      const add = (kind, name) => {
        const g = used[kind].get(name) || { n: 0, sum: 0 };
        g.n += 1;
        g.sum += l.sum || 0;
        used[kind].set(name, g);
      };
      if (l.kategorie) add('categories', l.kategorie);
      (l.tags || []).forEach((x) => add('tags', x));
    }
    const fresh = (kind) => [...used[kind]].filter(([name]) => isNew(kind, name)).sort((x, y) => y[1].sum - x[1].sum);
    const kept = (kind) => [...used[kind].keys()].filter((name) => !isNew(kind, name));
    const row = (kind, [name, g]) => {
      const d = aiData.decisions?.[kind] || {};
      const decided = Object.hasOwn(d, name);
      const target = d[name];
      const id = `${kind}:${name}`;
      if (aiEditing === id) {
        return `<form class="ai-new-row ai-rename" data-kind="${kind}" data-name="${esc(name)}">${nameTag(kind, name)} <span class="muted">→</span>
          <input name="target" value="${esc(target || name)}" list="ai-pool-${kind}" aria-label="Neuer Name oder vorhandene ${kind === 'tags' ? 'Tag' : 'Kategorie'}" required>
          <button class="btn small primary">OK</button><button type="button" class="btn small" data-ai-cancel>Abbrechen</button></form>`;
      }
      return `<div class="ai-new-row${decided && target === null ? ' ignored' : ''}">
        ${nameTag(kind, name)}${decided && target ? ` <span class="muted">→</span> ${nameTag(kind, target)}` : ''}
        <span class="muted">${g.n} Händler · ${money(g.sum, code)}</span>
        <span class="ai-new-btns">${decided
          ? `<button class="link-btn" data-ai-name="${esc(name)}" data-ai-kind="${kind}" data-ai-do="reset">${target === null ? 'doch verwenden' : 'zurücksetzen'}</button>`
          : `<button class="link-btn" data-ai-name="${esc(name)}" data-ai-kind="${kind}" data-ai-do="edit" title="Neuen Namen eingeben oder eine vorhandene Kategorie/einen vorhandenen Tag wählen">umbenennen</button> · <button class="link-btn" data-ai-name="${esc(name)}" data-ai-kind="${kind}" data-ai-do="ignore">ignorieren</button>`}</span>
      </div>`;
    };
    const block = (kind, title) => {
      const list = fresh(kind);
      return `<div class="ai-new-col"><h4>${title} <span class="muted">${list.length ? `${list.length} neu` : 'keine neuen'} · ${kept(kind).length} aus dem Bestand</span></h4>
        ${list.length ? list.map((x) => row(kind, x)).join('') : '<div class="muted">Die KI nutzt nur, was es in Firefly schon gibt.</div>'}</div>`;
    };
    const datalist = (kind) => `<datalist id="ai-pool-${kind}">${[...(aiData.pool?.[kind] || [])].map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
    return `<div class="ai-new">
      <div class="ai-new-head"><h3 class="sub-h">Vorschläge prüfen</h3>
        <span class="legend"><span><span class="tag">vorhanden</span> aus deinem Bestand</span><span><span class="tag new">neu</span> noch nicht in Firefly</span></span></div>
      <div class="ai-new-grid">${block('categories', 'Kategorien')}${block('tags', 'Tags')}</div>${datalist('categories')}${datalist('tags')}
    </div>`;
  }

  /** Alle Bewertungen je Händler, mit Annehmen/Ablehnen. */
  function renderLabelTable(labels) {
    const hasNew = (l) => isNew('categories', l.kategorie) || (l.tags || []).some((x) => isNew('tags', x));
    const filters = {
      alle: ['Alle', () => true],
      neu: ['Mit Neuem', hasNew],
      bestand: ['Nur Bestand', (l) => !hasNew(l)],
      offen: ['Unter Schwelle', (l) => !l.status && l.sicherheit < aiLayer.min],
      nein: ['Abgelehnt', (l) => l.status === 'nein'],
    };
    const rows = labels.filter(filters[aiFilter]?.[1] || (() => true)).sort((a, b) => b.sum - a.sum);
    const statusBtns = (l) => `<span class="ai-status">
      <button class="icon-btn small${l.status === 'ok' ? ' on' : ''}" data-ai-status="ok" data-key="${esc(l.key)}" title="Annehmen – gilt unabhängig von der Sicherheit" aria-pressed="${l.status === 'ok'}">✓</button>
      <button class="icon-btn small${l.status === 'nein' ? ' on bad' : ''}" data-ai-status="nein" data-key="${esc(l.key)}" title="Ablehnen – wird nie angewendet" aria-pressed="${l.status === 'nein'}">✕</button></span>`;
    return `<details class="ai-list"${aiFilter !== 'alle' || aiEditing ? ' open' : ''}><summary>Alle Bewertungen ansehen (${labels.length})</summary>
      <div class="chips" role="group" aria-label="Bewertungen filtern">${Object.entries(filters).map(([k, [label, fn]]) =>
        `<button class="chip small" data-ai-filter="${k}" aria-pressed="${k === aiFilter}">${label} <span class="muted">${labels.filter(fn).length}</span></button>`).join('')}</div>
      ${rows.length ? `<div class="table-wrap scroll"><table><thead><tr><th>Händler</th><th>KI-Kategorie</th><th class="hide-sm">Tags</th><th>Bedarf</th><th class="num">Sicherheit</th><th class="num hide-sm">24 Monate</th><th></th></tr></thead><tbody>
      ${rows.map((l) => {
        const e = effLabel(l);
        const active = aiActive(l);
        return `<tr style="cursor:default" class="${active ? '' : 'inactive'}" title="${esc(l.grund)}">
          <td><div class="desc">${esc(l.name)}</div><div class="flow">${esc(l.grund)}${l.via ? ` · über ${esc(l.via)}` : ''}</div></td>
          <td>${e.kategorie ? nameTag('categories', e.kategorie) : '<span class="muted">ignoriert</span>'}${e.kategorie !== l.kategorie ? `<div class="flow">KI: ${esc(l.kategorie)}</div>` : ''}</td>
          <td class="hide-sm">${e.tags.map((x) => nameTag('tags', x)).join('')}</td>
          <td>${esc(l.bedarf || '–')}</td>
          <td class="num"><span class="badge ${l.sicherheit >= 80 ? 'good' : l.sicherheit >= 60 ? 'warn' : 'bad'}">${l.sicherheit} %</span></td>
          <td class="num hide-sm">${money(l.sum, code)}</td>
          <td class="num">${statusBtns(l)}</td></tr>`;
      }).join('')}
      </tbody></table></div>` : '<div class="empty">Keine Bewertungen in dieser Auswahl.</div>'}</details>`;
  }

  let polling = null;
  let lastSig = JSON.stringify([null, false]);
  async function refreshAi() {
    aiData = await fetch('/local/ai/status').then((r) => r.json()).catch(() => aiData);
    if (!el.isConnected) return clearInterval(polling);
    aiLayer = aiData.settings?.layer || aiLayer;
    pool = { categories: poolSet('categories'), tags: poolSet('tags') };
    // nur neu durchrechnen, wenn sich etwas geändert hat, das auf die Buchungen wirkt
    const sig = JSON.stringify([aiData.pool, aiLayer.on && [aiLayer.min, aiData.decisions, aiData.labels]]);
    const full = sig !== lastSig;
    lastSig = sig;
    onChange(full);
    const running = (aiData.job && !aiData.job.finished) || aiData.test?.running;
    if (running && !polling) polling = setInterval(refreshAi, 1500);
    if (!running && polling) {
      clearInterval(polling);
      polling = null;
    }
  }

  // ---- Bedienung --------------------------------------------------------------
  const review = (body) => fetch('/local/ai/review', { method: 'PUT', headers, body: JSON.stringify(body) }).then(refreshAi);

  el.addEventListener('click', async (e) => {
    const nameBtn = e.target.closest('[data-ai-do]');
    if (nameBtn) {
      const { aiName: name, aiKind: kind, aiDo: act } = nameBtn.dataset;
      if (act === 'edit') {
        aiEditing = `${kind}:${name}`;
        onChange();
        return el.querySelector('.ai-rename input')?.select();
      }
      return review({ [kind]: { [name]: act === 'ignore' ? null : name } });
    }
    if (e.target.closest('[data-ai-cancel]')) {
      aiEditing = null;
      return onChange();
    }
    const statusBtn = e.target.closest('[data-ai-status]');
    if (statusBtn) {
      const { key, aiStatus } = statusBtn.dataset;
      return review({ status: { [key]: aiData.labels[key]?.status === aiStatus ? null : aiStatus } });
    }
    const aiF = e.target.closest('[data-ai-filter]');
    if (aiF) {
      aiFilter = aiF.dataset.aiFilter;
      return onChange();
    }
    const aiRun = e.target.closest('[data-ai-run]');
    if (aiRun) {
      const mode = aiRun.dataset.aiRun;
      if (mode === 'scheme' && !window.confirm('Die KI entwirft ein neues Kategoriesystem und ordnet alle Händler neu ein. Bisherige KI-Ergebnisse werden ersetzt. Fortfahren?')) return;
      const res = await fetch('/local/ai/run', { method: 'POST', headers, body: JSON.stringify({ mode: mode === 'all' ? 'classify' : mode, scope: mode === 'all' ? 'all' : 'open' }) })
        .then((r) => r.json()).catch((err) => ({ message: err.message }));
      if (res.message) window.alert(res.message);
      return refreshAi();
    }
    if (e.target.closest('[data-ai-stop]')) {
      await fetch('/local/ai/stop', { method: 'POST', headers });
      return refreshAi();
    }
    if (e.target.closest('[data-ai-reset]')) {
      if (!window.confirm('Alle KI-Bewertungen verwerfen?')) return;
      await fetch('/local/ai/labels', { method: 'DELETE', headers });
      return refreshAi();
    }
  });
  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-ai-layer], [data-ai-min]')) return;
    aiLayer = e.target.matches('[data-ai-layer]') ? { ...aiLayer, on: e.target.checked } : { ...aiLayer, min: Number(e.target.value) };
    fetch('/local/ai/settings', { method: 'PUT', headers, body: JSON.stringify({ layer: aiLayer }) }).catch(() => {});
    lastSig = JSON.stringify([aiData.pool, aiLayer.on && [aiLayer.min, aiData.decisions, aiData.labels]]);
    onChange(true);
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'ai-settings') {
      const f = e.target;
      const res = await fetch('/local/ai/settings', { method: 'PUT', headers, body: JSON.stringify({ url: f.url.value.trim(), model: f.model.value, freedom: f.freedom.value, wait: Number(f.wait.value) }) })
        .then((r) => r.json()).catch((err) => ({ message: err.message }));
      if (res.message) return window.alert(res.message);
      await refreshAi();
      await loadModels();
      if (models?.error) return;
      // Probe-Anfrage im Hintergrund: lädt das Modell und misst die Geschwindigkeit
      await fetch('/local/ai/test', { method: 'POST', headers }).catch(() => {});
      return refreshAi();
    }
    if (e.target.matches('.ai-rename')) {
      const { kind, name } = e.target.dataset;
      const raw = e.target.target.value.trim();
      // vorhandenen Namen in dessen Schreibweise übernehmen (zusammenlegen)
      const target = (aiData.pool?.[kind] || []).find((x) => x.toLowerCase() === raw.toLowerCase()) || raw;
      aiEditing = null;
      return review({ [kind]: { [name]: target } });
    }
  });

  /** Labor-Regeln aus den KI-Ergebnissen (je Händler eine), nur wenn die Ebene an ist. */
  function aiRules() {
    if (!aiLayer.on) return [];
    return Object.entries(aiData.labels).filter(([, l]) => aiActive(l)).map(([key, l]) => [key, effLabel(l)]).map(([key, l]) => ({
      id: `ai-${key}`, enabled: true,
      // Bedingung vom Server (Empfänger, Beschreibung oder Notizen); ältere Ergebnisse ohne: wie bisher
      when: [l.match || (key.startsWith('text:') ? { field: 'description', op: 'contains', value: l.name } : { field: 'party', op: 'equals', value: l.name })],
      setCategory: l.kategorie || '', addTags: [...l.tags, ...(l.bedarf ? [`Bedarf: ${l.bedarf}`] : [])],
    })).filter((r) => r.setCategory || r.addTags.length);
  }

  refreshAi();
  loadModels();
  loadPreview();
  return { aiFor, isNew, nameTag, aiRules, render: renderAi };
}
