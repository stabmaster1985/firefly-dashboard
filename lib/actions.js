// Automationen: frei konfigurierbare Webhooks (z. B. n8n), die sich aus der
// Oberfläche starten lassen. Gespeichert in DATA_DIR/actions.json.
//
//   GET    /local/actions            Liste
//   POST   /local/actions            anlegen
//   PUT    /local/actions/:id        ändern
//   DELETE /local/actions/:id        löschen
//   POST   /local/actions/:id/run    ausführen  (Body: { context })
//   POST   /local/actions/test       ungespeicherte Konfiguration testen

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BODY = 100_000;
const MAX_RESPONSE = 20_000;
const METHODS = ['POST', 'GET', 'PUT'];
/** Wann eine Automation startet: per Knopf oder automatisch durch den Zeitplan. */
export const TRIGGERS = ['manual', 'report-calendar', 'report-salary', 'alerts', 'categorize', 'tags'];
/** Auslöser, die Buchungen in Firefly ändern – danach ist der Zwischenspeicher veraltet. */
const WRITING = ['categorize', 'tags'];

export function createActions(dataDir, { onDataChange = () => {} } = {}) {
  const file = path.join(dataDir, 'actions.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  };
  const save = (list) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  };

  function validate(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Bitte einen Namen angeben.');
    let url;
    try {
      url = new URL(String(input.url || '').trim());
    } catch {
      throw new Error('Die Webhook-Adresse ist keine gültige URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Nur http:// und https:// werden unterstützt.');
    const method = METHODS.includes(String(input.method).toUpperCase()) ? String(input.method).toUpperCase() : 'POST';
    const headers = (Array.isArray(input.headers) ? input.headers : [])
      .map((h) => ({ name: String(h.name || '').trim(), value: String(h.value ?? '').trim() }))
      .filter((h) => h.name || h.value); // leere Zeilen ignorieren
    for (const h of headers) {
      if (!h.name) throw new Error(`Header mit Wert „${h.value.slice(0, 20)}…“ hat keinen Namen.`);
      // erlaubte Zeichen laut HTTP-Standard (Token), also auch _ und .
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.name)) {
        throw new Error(`Header-Name „${h.name}“ ist ungültig – erlaubt sind Buchstaben, Ziffern und - _ . (keine Leerzeichen, kein Doppelpunkt).`);
      }
      if (/[\r\n]/.test(h.value)) throw new Error(`Der Wert von Header „${h.name}“ darf keinen Zeilenumbruch enthalten.`);
    }
    return {
      name: name.slice(0, 80),
      description: String(input.description || '').slice(0, 300),
      url: url.toString(),
      method,
      headers,
      body: String(input.body ?? '').slice(0, MAX_BODY),
      confirm: Boolean(input.confirm),
      color: /^[1-8]$/.test(String(input.color)) ? String(input.color) : '1',
      trigger: TRIGGERS.includes(input.trigger) ? input.trigger : 'manual',
    };
  }

  /**
   * Platzhalter wie {{start}} im Body ersetzen (Werte als JSON-taugliche Texte).
   * {{daten}} fügt die kompletten Daten als JSON ein (z. B. den Monatsabschluss).
   */
  function render(template, context) {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      if (key === 'daten') return JSON.stringify(context.daten ?? context);
      const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), context);
      return value == null ? '' : String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    });
  }

  async function execute(action, context = {}) {
    const ctx = { ...context, now: new Date().toISOString(), action: action.name };
    const headers = Object.fromEntries(action.headers.map((h) => [h.name, h.value]));
    const init = { method: action.method, headers, signal: AbortSignal.timeout(60_000) };
    let url = action.url;
    if (action.method === 'GET') {
      const u = new URL(url);
      for (const [k, v] of Object.entries(ctx)) if (typeof v !== 'object') u.searchParams.set(k, v);
      url = u.toString();
    } else {
      init.body = action.body.trim() ? render(action.body, ctx) : JSON.stringify(ctx);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const startedAt = Date.now();
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        durationMs: Date.now() - startedAt,
        contentType: res.headers.get('content-type') || '',
        response: text.slice(0, MAX_RESPONSE),
        truncated: text.length > MAX_RESPONSE,
      };
    } catch (err) {
      return { ok: false, status: 0, durationMs: Date.now() - startedAt, response: `Nicht erreichbar: ${err.cause?.message || err.message}` };
    }
  }

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY * 2) {
          reject(new Error('Anfrage zu groß.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('Ungültiges JSON.'));
        }
      });
      req.on('error', reject);
    });

  /** Ausführen und letzten Lauf merken (für Knopf und Zeitplan). */
  async function runAndRecord(id, context) {
    const list = load();
    const index = list.findIndex((a) => a.id === id);
    if (index < 0) throw new Error('Automation nicht gefunden.');
    const result = await execute(list[index], context);
    if (result.ok && WRITING.includes(list[index].trigger) && !context?.test) onDataChange();
    const fresh = load();
    const i = fresh.findIndex((a) => a.id === id);
    if (i >= 0) {
      fresh[i].lastRun = { at: new Date().toISOString(), ok: result.ok, status: result.status, durationMs: result.durationMs };
      save(fresh);
    }
    return result;
  }

  async function handle(req, res, url) {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    // Eigener Header als Schutz gegen Formular-Anfragen fremder Seiten (CSRF)
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') {
      return json(403, { message: 'Anfrage abgelehnt.' });
    }
    const parts = url.pathname.replace(/^\/local\/actions\/?/, '').split('/').filter(Boolean);
    try {
      if (!parts.length && req.method === 'GET') return json(200, load());
      if (!parts.length && req.method === 'POST') {
        const action = { id: crypto.randomUUID(), ...validate(await readJson(req)), createdAt: new Date().toISOString() };
        save([...load(), action]);
        return json(201, action);
      }
      if (parts[0] === 'test' && req.method === 'POST') {
        const body = await readJson(req);
        const action = validate(body.action || {});
        const context = body.preview && hooks.preview ? await hooks.preview(action) : body.context;
        return json(200, await execute(action, context));
      }
      const list = load();
      const index = list.findIndex((a) => a.id === parts[0]);
      if (index < 0) return json(404, { message: 'Automation nicht gefunden.' });
      if (parts[1] === 'run' && req.method === 'POST') {
        const body = await readJson(req);
        // Monatsabschluss „jetzt testen“: Bericht über den letzten Monat erzeugen
        const context = body.preview && hooks.preview ? await hooks.preview(list[index]) : body.context;
        return json(200, await runAndRecord(list[index].id, context));
      }
      if (parts.length === 1 && req.method === 'PUT') {
        list[index] = { ...list[index], ...validate(await readJson(req)), updatedAt: new Date().toISOString() };
        save(list);
        return json(200, list[index]);
      }
      if (parts.length === 1 && req.method === 'DELETE') {
        list.splice(index, 1);
        save(list);
        return json(200, { ok: true });
      }
      return json(405, { message: 'Nicht unterstützt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  }

  /** Erweiterungen (z. B. Vorschau des Monatsabschlusses) setzt der Zeitplan. */
  const hooks = {};
  handle.list = load;
  handle.run = runAndRecord;
  handle.hooks = hooks;
  return handle;
}
