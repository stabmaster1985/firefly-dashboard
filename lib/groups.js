// Gruppen aus dem Kategorien-Labor: von Hand zusammengestellte Buchungen, die
// eine Kategorie oder einen Tag bekommen sollen. Das ist längere Arbeit über
// viele Sitzungen und Geräte – darum:
//  - gespeichert in DATA_DIR/groups.json (mit Versionsnummer, Sicherung, Schnappschüssen)
//  - Buchungen über ihre feste Firefly-Journal-ID referenziert
//  - Änderungen als einzelne Schritte (hinzufügen, entfernen, umbenennen …), damit
//    sich Handy und Laptop nicht gegenseitig überschreiben
//  - unbekannte Felder bleiben erhalten (spätere Versionen verlieren nichts)
//  - Löschen heißt Papierkorb (30 Tage wiederherstellbar)
//
//   GET    /local/groups                 { version, groups, trash }
//   POST   /local/groups                 neue Gruppe { name, kind, include, source }
//   POST   /local/groups/:id             { ops: [...] } → geänderte Gruppe
//   DELETE /local/groups/:id             in den Papierkorb
//   POST   /local/groups/:id/restore     aus dem Papierkorb zurück

import path from 'node:path';
import crypto from 'node:crypto';
import { jsonFile } from './store.js';

const VERSION = 1;
const TRASH_DAYS = 30;
const MAX_IDS = 5000;
const KINDS = ['category', 'tag'];

const text = (v, n) => String(v ?? '').trim().slice(0, n);
const ids = (list) => (Array.isArray(list) ? list : []).map((x) => String(x)).filter((x) => /^[0-9A-Za-z_-]{1,40}$/.test(x));

export function createGroups(dataDir, { log = console.log } = {}) {
  const file = jsonFile(path.join(dataDir, 'groups.json'), { version: VERSION, groups: [], trash: [] }, { snapshots: true, log });

  const load = () => {
    const data = file.read();
    // Papierkorb nach 30 Tagen leeren
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    data.trash = (data.trash || []).filter((g) => Date.parse(g.deletedAt || 0) > cutoff);
    return data;
  };

  function apply(group, ops) {
    const include = new Set(group.include || []);
    const exclude = new Set(group.exclude || []);
    for (const op of Array.isArray(ops) ? ops : []) {
      const list = ids(op.ids);
      if (op.op === 'add') list.forEach((id) => { include.add(id); exclude.delete(id); });
      else if (op.op === 'remove') list.forEach((id) => include.delete(id));
      else if (op.op === 'exclude') list.forEach((id) => { exclude.add(id); include.delete(id); });
      else if (op.op === 'unexclude') list.forEach((id) => exclude.delete(id));
      else if (op.op === 'set') {
        if (op.name !== undefined && text(op.name, 80)) group.name = text(op.name, 80);
        if (KINDS.includes(op.kind)) group.kind = op.kind;
        if (['offen', 'uebernommen'].includes(op.status)) group.status = op.status;
        if (op.note !== undefined) group.note = text(op.note, 500);
        if (Array.isArray(op.ruleIds)) group.ruleIds = op.ruleIds.map((x) => text(x, 40)).filter(Boolean).slice(0, 200);
      }
    }
    group.include = [...include].slice(0, MAX_IDS);
    group.exclude = [...exclude].slice(0, MAX_IDS);
    group.updatedAt = new Date().toISOString();
    return group;
  }

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 2_000_000) {
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

  return async function handle(req, res, url) {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    const parts = url.pathname.replace(/^\/local\/groups\/?/, '').split('/').filter(Boolean);
    try {
      // erst die Anfrage komplett lesen – danach Laden, Ändern, Schreiben ohne
      // Unterbrechung, damit sich gleichzeitige Änderungen nicht überschreiben
      const input = req.method === 'POST' ? await readJson(req) : {};
      if (!parts.length && req.method === 'GET') return json(200, load());
      if (!parts.length && req.method === 'POST') {
        const data = load();
        const now = new Date().toISOString();
        const group = apply({
          id: crypto.randomUUID(),
          name: text(input.name, 80) || 'Neue Gruppe',
          kind: KINDS.includes(input.kind) ? input.kind : 'category',
          status: 'offen',
          source: text(input.source, 200),
          basis: ['ausgaben', 'einnahmen'].includes(input.basis) ? input.basis : 'ausgaben',
          note: '',
          include: [],
          exclude: [],
          ruleIds: [],
          createdAt: now,
        }, [{ op: 'add', ids: input.include }, { op: 'exclude', ids: input.exclude }]);
        data.groups.push(group);
        data.version = VERSION;
        file.write(data);
        return json(201, group);
      }
      const data = load();
      const id = parts[0];
      if (parts[1] === 'restore' && req.method === 'POST') {
        const i = data.trash.findIndex((g) => g.id === id);
        if (i < 0) return json(404, { message: 'Nicht im Papierkorb.' });
        const [group] = data.trash.splice(i, 1);
        delete group.deletedAt;
        data.groups.push(group);
        file.write(data);
        return json(200, group);
      }
      const index = data.groups.findIndex((g) => g.id === id);
      if (index < 0) return json(404, { message: 'Gruppe nicht gefunden – evtl. auf einem anderen Gerät gelöscht.' });
      if (parts.length === 1 && req.method === 'POST') {
        data.groups[index] = apply(data.groups[index], input.ops);
        file.write(data);
        return json(200, data.groups[index]);
      }
      if (parts.length === 1 && req.method === 'DELETE') {
        const [group] = data.groups.splice(index, 1);
        data.trash.push({ ...group, deletedAt: new Date().toISOString() });
        file.write(data);
        return json(200, { ok: true });
      }
      return json(405, { message: 'Nicht unterstützt.' });
    } catch (err) {
      log(`Gruppen: ${err.message}`);
      return json(400, { message: err.message });
    }
  };
}
