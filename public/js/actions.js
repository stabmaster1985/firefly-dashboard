// Automationen: Webhooks (z. B. n8n-Workflows) anlegen, bearbeiten und per
// Knopfdruck starten. Die Konfiguration speichert der Dashboard-Server.

import { esc, fmtDate, isoDate } from './util.js';
import { seriesColor } from './charts.js';

const DEFAULT_BODY = `{
  "quelle": "firefly-dashboard",
  "zeitraum": "{{period}}",
  "von": "{{start}}",
  "bis": "{{end}}",
  "ausgeloest": "{{now}}"
}`;

const TRIGGERS = {
  manual: { label: 'Per Knopf', run: '▶ Ausführen', hint: 'Startet, wenn du auf „Ausführen“ klickst. Mitgeschickt wird der gewählte Zeitraum.' },
  'report-salary': { label: 'Monatsabschluss (Gehaltsmonat)', run: '▶ Letzten Gehaltsmonat jetzt senden', hint: 'Startet automatisch, sobald ein Gehaltsmonat abgeschlossen ist – mit Einnahmen, Ausgaben, Kategorien, Zielen, größten Buchungen und einem fertigen Text. Body leer lassen = alle Daten als JSON.' },
  'report-calendar': { label: 'Monatsabschluss (Kalendermonat)', run: '▶ Letzten Monat jetzt senden', hint: 'Wie oben, aber zum Monatswechsel am 1.' },
  alerts: { label: 'Warnungen', run: '▶ Testwarnung senden', hint: 'Startet bei jeder neuen Warnung: große Ausgabe, Abo mit neuem Betrag, ausgebliebene Zahlung. Jede Warnung wird nur einmal gesendet.' },
  categorize: { label: 'Kategorie übernehmen', run: '▶ Testdaten senden', hint: 'Startet, wenn du in den Details einer Buchung eine Kategorie setzt oder bei „Ohne Kategorie“ einen Vorschlag übernimmst. Der Workflow erhält Buchungs-ID und Kategorie (typ „kategorie_setzen“) und setzt sie in Firefly – fertiger Workflow: n8n/firefly-buchung-bearbeiten.json.' },
  import: { label: 'Import starten', run: '▶ Import starten', hint: 'Erscheint als Knopf auf der Seite „Prüfen“ beim Import-Status, z. B. für deinen n8n-Workflow, der die Bank-CSV abholt und importiert. Mitgeschickt werden die Konten, die überfällig wirken.' },
  update: { label: 'Dashboard aktualisieren', run: '▶ Jetzt aktualisieren', hint: 'Erscheint oben unter „Dashboard-Version“, sobald es auf GitHub eine neuere Version gibt – z. B. für den n8n-Workflow n8n/firefly-dashboard-update.json. Achtung: auch „Testen“ startet das Update wirklich.' },
  tags: { label: 'Tags setzen', run: '▶ Testdaten senden', hint: 'Startet, wenn du in den Details einer Buchung einen Tag hinzufügst oder entfernst. Der Workflow erhält Buchungs-ID und die komplette neue Tag-Liste (typ „tags_setzen“) – derselbe n8n-Workflow wie für Kategorien kann beides.' },
};

async function local(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/local/actions${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

const fmtTime = (iso) => `${fmtDate(iso)} ${new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

function resultHtml(r) {
  let pretty = r.response || '';
  try {
    if (/json/.test(r.contentType || '') || /^[[{]/.test(pretty.trim())) pretty = JSON.stringify(JSON.parse(pretty), null, 2);
  } catch {
    // keine gültige JSON-Antwort – Text unverändert anzeigen
  }
  return `<div class="run-result ${r.ok ? 'ok' : 'fail'}">
    <div><span class="badge ${r.ok ? 'good' : 'bad'}">${r.ok ? 'Erfolgreich' : 'Fehlgeschlagen'}</span>
      <span class="muted">${r.status ? `HTTP ${r.status}` : ''} · ${(r.durationMs / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s</span></div>
    ${pretty ? `<details${r.ok ? '' : ' open'}><summary>Antwort anzeigen</summary><pre>${esc(pretty)}${r.truncated ? '\n…' : ''}</pre></details>` : ''}
  </div>`;
}

export async function actions(view, { period }) {
  const context = { start: isoDate(period.start), end: isoDate(period.end), period: period.label };
  let list = [];

  view.innerHTML = `
    <div class="toolbar">
      <button class="btn primary" id="act-new">+ Neue Automation</button>
      <span class="meta-line">Startet Webhooks, z. B. n8n-Workflows · der gewählte Zeitraum wird mitgeschickt</span>
    </div>
    <section class="card version-card" id="act-version"><div class="skeleton" style="height:40px"></div></section>
    <div id="act-editor"></div>
    <section class="card settings-card"><form id="act-settings" class="settings-row">
      <label>Gehaltstag <input type="number" name="payday" min="2" max="28" required></label>
      <label>„Große Ausgabe“ ab <input type="number" name="alertThreshold" min="1" step="1" required> €</label>
      <button class="btn">Speichern</button><span class="muted" id="set-out">Gilt für Monatsabschluss und Warnungen.</span>
    </form></section>
    <div class="tiles action-tiles" id="act-list"><section class="card">Lade …</section></div>`;
  const listEl = view.querySelector('#act-list');
  const editorEl = view.querySelector('#act-editor');

  async function reload() {
    try {
      list = await local('');
      renderList();
    } catch (err) {
      listEl.innerHTML = `<section class="card error-card"><h2>Automationen nicht verfügbar</h2><p>${esc(err.message)}</p></section>`;
    }
  }

  function renderList() {
    if (!list.length) {
      listEl.innerHTML = `<section class="card empty-actions">
        <h2>Noch keine Automationen</h2>
        <p>So bindest du einen n8n-Workflow an:</p>
        <ol><li>In n8n als ersten Knoten einen <b>Webhook</b> anlegen (Methode POST).</li>
          <li>Die <b>Production URL</b> kopieren und den Workflow aktivieren.</li>
          <li>Hier auf <b>+ Neue Automation</b> klicken und die URL eintragen.</li></ol>
        <p class="muted">Der Workflow bekommt den gewählten Zeitraum mit (von, bis, Bezeichnung) – oder was du im Body festlegst.</p>
      </section>`;
      return;
    }
    listEl.innerHTML = list
      .map((a) => `<section class="card tile action" data-id="${esc(a.id)}" style="--accent-bar:${seriesColor(Number(a.color || 1) - 1)}">
        <div class="action-head"><span class="name">${esc(a.name)}</span><button class="link-btn" data-edit="${esc(a.id)}">Bearbeiten</button></div>
        ${a.description ? `<p class="action-desc">${esc(a.description)}</p>` : ''}
        <div class="action-meta"><span class="badge trigger">${esc((TRIGGERS[a.trigger] || TRIGGERS.manual).label)}</span> ${esc(a.method)} · ${esc(new URL(a.url).host)}${a.lastRun
          ? ` · zuletzt ${fmtTime(a.lastRun.at)} <span class="badge ${a.lastRun.ok ? 'good' : 'bad'}">${a.lastRun.ok ? 'ok' : `Fehler ${a.lastRun.status || ''}`}</span>` : ''}</div>
        <button class="btn ${(a.trigger || 'manual') === 'manual' ? 'primary' : ''} run-btn" data-run="${esc(a.id)}">${(TRIGGERS[a.trigger] || TRIGGERS.manual).run}</button>
        <div class="run-out"></div>
      </section>`)
      .join('');
  }

  async function run(id, button) {
    const a = list.find((x) => x.id === id);
    if (a.confirm && !window.confirm(`„${a.name}“ jetzt ausführen?`)) return;
    const out = button.parentElement.querySelector('.run-out');
    button.disabled = true;
    button.textContent = 'Läuft …';
    out.innerHTML = '';
    try {
      const preview = (a.trigger || 'manual') !== 'manual';
      const result = await local(`/${encodeURIComponent(id)}/run`, { method: 'POST', body: preview ? { preview: true } : { context } });
      a.lastRun = { at: new Date().toISOString(), ok: result.ok, status: result.status };
      out.innerHTML = resultHtml(result);
    } catch (err) {
      out.innerHTML = resultHtml({ ok: false, status: 0, durationMs: 0, response: err.message });
    } finally {
      button.disabled = false;
      button.textContent = (TRIGGERS[a.trigger] || TRIGGERS.manual).run;
    }
  }

  function openEditor(action) {
    const a = action || { name: '', description: '', url: '', method: 'POST', headers: [], body: DEFAULT_BODY, confirm: false, color: '1', trigger: 'manual' };
    editorEl.innerHTML = `<section class="card editor">
      <div class="card-head"><h2>${action ? 'Automation bearbeiten' : 'Neue Automation'}</h2></div>
      <form id="act-form" class="form-grid">
        <label>Name<input name="name" required maxlength="80" value="${esc(a.name)}" placeholder="z. B. Monatsbericht erstellen"></label>
        <label>Beschreibung<input name="description" maxlength="300" value="${esc(a.description)}" placeholder="Was macht der Workflow?"></label>
        <label class="wide">Webhook-URL<input name="url" required type="url" value="${esc(a.url)}" placeholder="https://n8n.example.com/webhook/…"></label>
        <label>Auslöser<select name="trigger">${Object.entries(TRIGGERS).map(([k, t]) => `<option value="${k}"${k === (a.trigger || 'manual') ? ' selected' : ''}>${t.label}</option>`).join('')}</select></label>
        <p class="form-hint trigger-hint">${esc((TRIGGERS[a.trigger] || TRIGGERS.manual).hint)}</p>
        <label>Methode<select name="method">${['POST', 'GET', 'PUT'].map((m) => `<option${m === a.method ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
        <fieldset class="colors"><legend>Farbe</legend>${[1, 2, 3, 4, 5, 6, 7, 8]
          .map((c) => `<label class="swatch-pick"><input type="radio" name="color" value="${c}"${String(c) === String(a.color) ? ' checked' : ''}><i style="background:${seriesColor(c - 1)}"></i></label>`)
          .join('')}</fieldset>
        <div class="wide"><div class="field-label">Header <span class="muted">(z. B. für Header-Auth in n8n)</span></div>
          <div id="hdr-rows">${a.headers.map((h) => headerRow(h)).join('')}</div>
          <button type="button" class="link-btn" id="hdr-add">+ Header hinzufügen</button></div>
        <label class="wide">Body <span class="muted">(JSON; Platzhalter: {{start}} {{end}} {{period}} {{now}} {{action}}, {{daten}} = alle Daten; leer = alle Daten als JSON)</span>
          <textarea name="body" rows="8" spellcheck="false">${esc(a.body)}</textarea></label>
        <label class="check wide"><input type="checkbox" name="confirm"${a.confirm ? ' checked' : ''}> Vor dem Ausführen nachfragen</label>
        <div class="wide form-actions">
          ${action ? '<button type="button" class="btn danger" id="act-del">Löschen</button>' : ''}
          <span class="spacer"></span>
          <button type="button" class="btn" id="act-cancel">Abbrechen</button>
          <button type="button" class="btn" id="act-test">Testen</button>
          <button type="submit" class="btn primary">Speichern</button>
        </div>
        <div class="wide" id="act-test-out"></div>
      </form></section>`;
    const form = editorEl.querySelector('form');
    const read = () => {
      const f = new FormData(form);
      return {
        name: f.get('name'),
        description: f.get('description'),
        url: f.get('url'),
        method: f.get('method'),
        color: f.get('color') || '1',
        trigger: f.get('trigger') || 'manual',
        body: f.get('body'),
        confirm: f.get('confirm') === 'on',
        headers: [...editorEl.querySelectorAll('.hdr-row')].map((r) => ({ name: r.querySelector('[data-k=name]').value, value: r.querySelector('[data-k=value]').value })),
      };
    };
    form.querySelector('[name=trigger]').addEventListener('change', (e) => {
      form.querySelector('.trigger-hint').textContent = TRIGGERS[e.target.value].hint;
      // Für automatische Auslöser ist „alle Daten als JSON“ meist das Richtige
      const body = form.querySelector('[name=body]');
      if (e.target.value !== 'manual' && body.value.trim() === DEFAULT_BODY.trim()) body.value = '';
      if (e.target.value === 'manual' && !body.value.trim()) body.value = DEFAULT_BODY;
    });
    editorEl.querySelector('#hdr-add').addEventListener('click', () => editorEl.querySelector('#hdr-rows').insertAdjacentHTML('beforeend', headerRow({ name: '', value: '' })));
    editorEl.querySelector('#hdr-rows').addEventListener('click', (e) => e.target.closest('.hdr-del')?.closest('.hdr-row').remove());
    editorEl.querySelector('#act-cancel').addEventListener('click', () => (editorEl.innerHTML = ''));
    editorEl.querySelector('#act-test').addEventListener('click', async (e) => {
      const out = editorEl.querySelector('#act-test-out');
      e.target.disabled = true;
      out.innerHTML = '<span class="muted">Sende Testaufruf …</span>';
      try {
        const cfg = read();
        out.innerHTML = resultHtml(await local('/test', { method: 'POST', body: { action: cfg, context, preview: cfg.trigger !== 'manual' } }));
      } catch (err) {
        out.innerHTML = resultHtml({ ok: false, status: 0, durationMs: 0, response: err.message });
      } finally {
        e.target.disabled = false;
      }
    });
    editorEl.querySelector('#act-del')?.addEventListener('click', async () => {
      if (!window.confirm(`„${action.name}“ wirklich löschen?`)) return;
      await local(`/${encodeURIComponent(action.id)}`, { method: 'DELETE' });
      editorEl.innerHTML = '';
      reload();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = editorEl.querySelector('#act-test-out');
      try {
        if (action) await local(`/${encodeURIComponent(action.id)}`, { method: 'PUT', body: read() });
        else await local('', { method: 'POST', body: read() });
        editorEl.innerHTML = '';
        reload();
      } catch (err) {
        out.innerHTML = `<div class="run-result fail">${esc(err.message)}</div>`;
      }
    });
    editorEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    form.querySelector('[name=name]').focus();
  }

  view.querySelector('#act-new').addEventListener('click', () => openEditor(null));
  versionCard(view.querySelector('#act-version'));

  // Einstellungen für Zeitplan (Gehaltstag, Schwelle für Warnungen)
  const setForm = view.querySelector('#act-settings');
  fetch('/local/settings').then((r) => r.json()).then((st) => {
    setForm.payday.value = st.payday;
    setForm.alertThreshold.value = st.alertThreshold;
  }).catch(() => {});
  setForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = await fetch('/local/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' },
      body: JSON.stringify({ payday: Number(setForm.payday.value), alertThreshold: Number(setForm.alertThreshold.value) }),
    }).then((r) => r.json());
    try {
      localStorage.setItem('ffd-payday', String(st.payday));
    } catch {
      // ohne localStorage gilt der Wert nur auf dem Server
    }
    view.querySelector('#set-out').textContent = 'Gespeichert ✓';
  });
  listEl.addEventListener('click', (e) => {
    const runBtn = e.target.closest('[data-run]');
    if (runBtn) return run(runBtn.dataset.run, runBtn);
    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(list.find((a) => a.id === edit.dataset.edit));
  });
  reload();
}

// ---- Dashboard-Version & Update ------------------------------------------------

const short = (sha) => String(sha || '').slice(0, 7);

/** Laufende Version, neue Commits auf GitHub und Knopf für die Update-Automation. */
async function versionCard(el, { force = false } = {}) {
  let v;
  try {
    v = await fetch(`/local/version${force ? '?refresh=1' : ''}`).then((r) => r.json());
  } catch {
    el.hidden = true;
    return;
  }
  if (!el.isConnected) return;
  const updateAction = await local('').then((l) => l.find((a) => a.trigger === 'update')).catch(() => null);
  const cur = v.current || {};
  const stand = cur.commit
    ? `<b>${esc(short(cur.commit))}</b>${cur.branch ? ` (${esc(cur.branch)})` : ''}${cur.updatedAt ? ` · Stand ${fmtTime(cur.updatedAt)}` : ''}`
    : '<span class="muted">unbekannt (ohne Git-Daten gebaut)</span>';
  let state = '';
  if (!v.enabled) state = '<span class="muted">Update-Prüfung ist ausgeschaltet (UPDATE_CHECK=0).</span>';
  else if (v.error) state = `<span class="badge warn">Prüfung fehlgeschlagen</span> <span class="muted">${esc(v.error)}</span>`;
  else if (v.status === 'current') state = `<span class="badge good">aktuell</span>${v.latest?.commit !== cur.commit ? ' <span class="muted">(neuer als GitHub)</span>' : ''}`;
  else if (v.status === 'unknown') state = '<span class="badge warn">Eigener Stand</span> <span class="muted">Dieser Commit ist auf GitHub nicht bekannt (z. B. lokale Änderungen).</span>';
  else if (v.latest) {
    state = `<span class="badge warn">Update verfügbar${v.behind ? ` · ${v.behind} neue${v.behind === 1 ? 'r Commit' : ' Commits'}` : ''}</span>`;
    if (v.commits?.length) {
      state += `<ul class="commit-list">${v.commits.map((c) => `<li><code>${esc(short(c.commit))}</code> ${esc(c.message)} <span class="muted">${c.date ? fmtDate(c.date) : ''}</span></li>`).join('')}</ul>`;
    } else if (v.latest.message) {
      state += `<ul class="commit-list"><li><code>${esc(short(v.latest.commit))}</code> ${esc(v.latest.message)}</li></ul>`;
    }
  }
  const outdated = v.status === 'update';
  el.innerHTML = `<div class="card-head"><h2>Dashboard-Version</h2><span class="meta">${v.repo ? `<a href="https://github.com/${esc(v.repo)}/commits" target="_blank" rel="noopener">${esc(v.repo)} ↗</a>` : ''}</span></div>
    <p class="version-line">Läuft: ${stand}</p>
    <div>${state}</div>
    <div class="version-actions">
      <button class="btn" data-v="check">Jetzt prüfen</button>
      ${updateAction ? `<button class="btn ${outdated ? 'primary' : ''}" data-v="update">▶ ${esc(updateAction.name)}</button>` : '<span class="muted">Für einen Update-Knopf: Automation mit Auslöser „Dashboard aktualisieren“ anlegen (n8n-Vorlage: n8n/firefly-dashboard-update.json).</span>'}
    </div>
    <div class="run-out" id="v-out"></div>`;
  el.querySelector('[data-v=check]').addEventListener('click', (e) => {
    e.target.disabled = true;
    versionCard(el, { force: true });
  });
  el.querySelector('[data-v=update]')?.addEventListener('click', async (e) => {
    if (!window.confirm('Dashboard jetzt aktualisieren? Es ist danach kurz nicht erreichbar.')) return;
    e.target.disabled = true;
    const out = el.querySelector('#v-out');
    out.innerHTML = '<span class="muted">Starte Update …</span>';
    const result = await local(`/${encodeURIComponent(updateAction.id)}/run`, { method: 'POST', body: { context: { typ: 'update', von: cur.commit || null, auf: v.latest?.commit || null } } })
      .catch((err) => ({ ok: false, status: 0, durationMs: 0, response: err.message }));
    if (!result.ok) {
      out.innerHTML = resultHtml(result);
      e.target.disabled = false;
      return;
    }
    // Neustart abwarten: sobald eine andere Version läuft, Seite neu laden
    out.innerHTML = '<span class="badge good">Update gestartet</span> <span class="muted">Das Dashboard wird neu gebaut und startet neu – die Seite lädt danach von selbst neu (meist 1–3 Minuten).</span>';
    const started = Date.now();
    const poll = async () => {
      if (!el.isConnected) return;
      const now = await fetch('/local/version', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (now?.current?.commit && now.current.commit !== cur.commit) return location.reload();
      if (Date.now() - started > 10 * 60_000) {
        out.innerHTML = '<span class="badge warn">Noch keine neue Version</span> <span class="muted">Bitte in n8n die Ausführung des Workflows prüfen.</span>';
        return;
      }
      setTimeout(poll, 10_000);
    };
    setTimeout(poll, 15_000);
  });
}

/** Kurzinfo für die Seitenleiste: Version und Hinweis auf ein Update. */
export async function versionBadge(host) {
  const v = await fetch('/local/version').then((r) => r.json()).catch(() => null);
  if (!v?.current?.commit || !host) return;
  const outdated = v.status === 'update' && !v.error;
  host.innerHTML = `Version ${esc(short(v.current.commit))}${outdated ? ` · <a href="#/automationen" class="update-link">Update verfügbar${v.behind ? ` (${v.behind})` : ''} →</a>` : ''}`;
}

function headerRow(h) {
  return `<div class="hdr-row"><input data-k="name" placeholder="Name, z. B. Authorization" value="${esc(h.name)}">
    <input data-k="value" placeholder="Wert" value="${esc(h.value)}"><button type="button" class="icon-btn hdr-del" aria-label="Header entfernen">✕</button></div>`;
}
