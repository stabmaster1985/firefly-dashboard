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
    <div id="act-editor"></div>
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
        <div class="action-meta">${esc(a.method)} · ${esc(new URL(a.url).host)}${a.lastRun
          ? ` · zuletzt ${fmtTime(a.lastRun.at)} <span class="badge ${a.lastRun.ok ? 'good' : 'bad'}">${a.lastRun.ok ? 'ok' : `Fehler ${a.lastRun.status || ''}`}</span>` : ''}</div>
        <button class="btn primary run-btn" data-run="${esc(a.id)}">▶ Ausführen</button>
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
      const result = await local(`/${encodeURIComponent(id)}/run`, { method: 'POST', body: { context } });
      a.lastRun = { at: new Date().toISOString(), ok: result.ok, status: result.status };
      out.innerHTML = resultHtml(result);
    } catch (err) {
      out.innerHTML = resultHtml({ ok: false, status: 0, durationMs: 0, response: err.message });
    } finally {
      button.disabled = false;
      button.textContent = '▶ Ausführen';
    }
  }

  function openEditor(action) {
    const a = action || { name: '', description: '', url: '', method: 'POST', headers: [], body: DEFAULT_BODY, confirm: false, color: '1' };
    editorEl.innerHTML = `<section class="card editor">
      <div class="card-head"><h2>${action ? 'Automation bearbeiten' : 'Neue Automation'}</h2></div>
      <form id="act-form" class="form-grid">
        <label>Name<input name="name" required maxlength="80" value="${esc(a.name)}" placeholder="z. B. Monatsbericht erstellen"></label>
        <label>Beschreibung<input name="description" maxlength="300" value="${esc(a.description)}" placeholder="Was macht der Workflow?"></label>
        <label class="wide">Webhook-URL<input name="url" required type="url" value="${esc(a.url)}" placeholder="https://n8n.example.com/webhook/…"></label>
        <label>Methode<select name="method">${['POST', 'GET', 'PUT'].map((m) => `<option${m === a.method ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
        <fieldset class="colors"><legend>Farbe</legend>${[1, 2, 3, 4, 5, 6, 7, 8]
          .map((c) => `<label class="swatch-pick"><input type="radio" name="color" value="${c}"${String(c) === String(a.color) ? ' checked' : ''}><i style="background:${seriesColor(c - 1)}"></i></label>`)
          .join('')}</fieldset>
        <div class="wide"><div class="field-label">Header <span class="muted">(z. B. für Header-Auth in n8n)</span></div>
          <div id="hdr-rows">${a.headers.map((h) => headerRow(h)).join('')}</div>
          <button type="button" class="link-btn" id="hdr-add">+ Header hinzufügen</button></div>
        <label class="wide">Body <span class="muted">(JSON; Platzhalter: {{start}} {{end}} {{period}} {{now}} {{action}} – leer = alle Werte als JSON)</span>
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
        body: f.get('body'),
        confirm: f.get('confirm') === 'on',
        headers: [...editorEl.querySelectorAll('.hdr-row')].map((r) => ({ name: r.querySelector('[data-k=name]').value, value: r.querySelector('[data-k=value]').value })),
      };
    };
    editorEl.querySelector('#hdr-add').addEventListener('click', () => editorEl.querySelector('#hdr-rows').insertAdjacentHTML('beforeend', headerRow({ name: '', value: '' })));
    editorEl.querySelector('#hdr-rows').addEventListener('click', (e) => e.target.closest('.hdr-del')?.closest('.hdr-row').remove());
    editorEl.querySelector('#act-cancel').addEventListener('click', () => (editorEl.innerHTML = ''));
    editorEl.querySelector('#act-test').addEventListener('click', async (e) => {
      const out = editorEl.querySelector('#act-test-out');
      e.target.disabled = true;
      out.innerHTML = '<span class="muted">Sende Testaufruf …</span>';
      try {
        out.innerHTML = resultHtml(await local('/test', { method: 'POST', body: { action: read(), context } }));
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
  listEl.addEventListener('click', (e) => {
    const runBtn = e.target.closest('[data-run]');
    if (runBtn) return run(runBtn.dataset.run, runBtn);
    const edit = e.target.closest('[data-edit]');
    if (edit) openEditor(list.find((a) => a.id === edit.dataset.edit));
  });
  reload();
}

function headerRow(h) {
  return `<div class="hdr-row"><input data-k="name" placeholder="Name, z. B. Authorization" value="${esc(h.name)}">
    <input data-k="value" placeholder="Wert" value="${esc(h.value)}"><button type="button" class="icon-btn hdr-del" aria-label="Header entfernen">✕</button></div>`;
}
