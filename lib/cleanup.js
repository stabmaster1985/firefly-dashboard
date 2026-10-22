// „Daten aufräumen“: vorbereitete Pläne, die erst per Knopf nach Firefly gehen.
// Liegen auf dem Server (DATA_DIR), damit Anpassungen auf allen Geräten und nach
// Updates erhalten bleiben. Änderungen kommen als einzelne Schritte (Patch je
// Eintrag), damit sich Handy und Laptop nicht gegenseitig überschreiben.
//
//   GET    /local/cleanup/import          Plan aus der Import-Konfiguration
//   PUT    /local/cleanup/import          neuer Plan (nach dem Hochladen) – Anpassungen bleiben
//   POST   /local/cleanup/import/items    { changes: { id: { …felder } } }
//   POST   /local/cleanup/import/sent     { at, ids }  – übertragen
//   DELETE /local/cleanup/import          Plan verwerfen
//   GET    /local/cleanup/merge           Plan zum Zusammenführen von Gegenkonten
//   POST   /local/cleanup/merge/groups    { changes: { key: { …felder } } }

import path from 'node:path';
import { jsonFile } from './store.js';

const text = (v, n = 200) => String(v ?? '').slice(0, n);
const KEY = /^[\w:.-]{1,120}$/;

export function createCleanup(dataDir, { log = console.log } = {}) {
  const importFile = jsonFile(path.join(dataDir, 'cleanup-import.json'), { plan: null, items: {} }, { snapshots: true, log });
  const mergeFile = jsonFile(path.join(dataDir, 'cleanup-merge.json'), { groups: {} }, { snapshots: true, log });

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 5_000_000) {
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

  /** Eintrag eines Regelvorschlags säubern (nur bekannte Felder, begrenzte Längen). */
  const cleanItem = (it, old = {}) => ({
    ...old,
    ...(it.names !== undefined ? { names: (Array.isArray(it.names) ? it.names : []).slice(0, 200).map((x) => text(x, 120)) } : {}),
    ...(it.op !== undefined ? { op: ['equals', 'contains'].includes(it.op) ? it.op : 'equals' } : {}),
    ...(it.value !== undefined ? { value: text(it.value, 120) } : {}),
    ...(it.category !== undefined ? { category: text(it.category, 80) } : {}),
    ...(it.direction !== undefined ? { direction: it.direction === 'deposit' ? 'deposit' : 'withdrawal' } : {}),
    ...(it.enabled !== undefined ? { enabled: Boolean(it.enabled) } : {}),
    ...(it.edited !== undefined ? { edited: Boolean(it.edited) } : {}),
    ...(it.suggested !== undefined ? { suggested: it.suggested && typeof it.suggested === 'object' ? {
      op: text(it.suggested.op, 10), value: text(it.suggested.value, 120), category: text(it.suggested.category, 80),
    } : null } : {}),
  });
  const cleanGroup = (g, old = {}) => ({
    ...old,
    ...(g.target !== undefined ? { target: text(g.target, 20) } : {}),
    ...(g.members !== undefined ? { members: (Array.isArray(g.members) ? g.members : []).slice(0, 200).map((x) => text(x, 20)) } : {}),
    ...(g.rename !== undefined ? { rename: text(g.rename, 120) } : {}),
    ...(g.ignored !== undefined ? { ignored: Boolean(g.ignored) } : {}),
    ...(g.selected !== undefined ? { selected: Boolean(g.selected) } : {}),
    ...(g.done !== undefined ? { done: g.done ? text(g.done, 40) : null } : {}),
    ...(g.emptied !== undefined ? { emptied: (Array.isArray(g.emptied) ? g.emptied : []).slice(0, 200).map((x) => text(x, 20)) } : {}),
  });

  return async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    const p = url.pathname.replace('/local/cleanup/', '');
    try {
      if (p === 'import') {
        if (req.method === 'PUT') {
          // neuer Plan: Vorschläge ersetzen, eigene Anpassungen (edited) an gleichen Einträgen behalten
          const input = await readJson(req);
          const cur = importFile.read();
          const items = {};
          for (const [id, it] of Object.entries(input.items || {}).slice(0, 5000)) {
            if (!KEY.test(id)) continue;
            const old = cur.items[id];
            items[id] = old?.edited ? cleanItem({ suggested: it.suggested, names: it.names }, old) : cleanItem({ enabled: true, ...it, edited: false });
          }
          const plan = {
            file: text(input.plan?.file, 200), uploadedAt: new Date().toISOString(),
            columns: (Array.isArray(input.plan?.columns) ? input.plan.columns : []).slice(0, 60).map((c) => ({
              index: Number(c.index) || 0, role: text(c.role, 40), label: text(c.label, 60), header: text(c.header, 80), mapped: Number(c.mapped) || 0,
            })),
            hints: (Array.isArray(input.plan?.hints) ? input.plan.hints : []).slice(0, 20).map((h) => text(h, 400)),
            sentAt: cur.plan?.sentAt || null,
          };
          importFile.write({ plan, items });
          return json(200, importFile.read());
        }
        if (req.method === 'DELETE') {
          importFile.write({ plan: null, items: {} });
          return json(200, importFile.read());
        }
        return json(200, importFile.read());
      }
      if (p === 'import/items' && req.method === 'POST') {
        const input = await readJson(req);
        const data = importFile.read();
        for (const [id, ch] of Object.entries(input.changes || {})) {
          if (!KEY.test(id)) continue;
          if (ch === null) delete data.items[id];
          else data.items[id] = cleanItem({ ...ch, edited: ch.edited ?? true }, data.items[id]);
        }
        importFile.write(data);
        return json(200, data);
      }
      if (p === 'import/sent' && req.method === 'POST') {
        const input = await readJson(req);
        const data = importFile.read();
        if (data.plan) data.plan.sentAt = new Date().toISOString();
        const sent = new Set((input.ids || []).map(String));
        for (const [id, it] of Object.entries(data.items)) {
          // Stand der Übertragung merken – „geändert seit Übertragung“ erkennen
          if (sent.has(id)) it.sent = { op: it.op, value: it.value, category: it.category, direction: it.direction, enabled: it.enabled };
        }
        importFile.write(data);
        return json(200, data);
      }
      if (p === 'merge') return json(200, mergeFile.read());
      if (p === 'merge/groups' && req.method === 'POST') {
        const input = await readJson(req);
        const data = mergeFile.read();
        for (const [key, ch] of Object.entries(input.changes || {})) {
          if (!KEY.test(key)) continue;
          if (ch === null) delete data.groups[key];
          else data.groups[key] = cleanGroup(ch, data.groups[key]);
        }
        mergeFile.write(data);
        return json(200, data);
      }
      return json(404, { message: 'Unbekannt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}
