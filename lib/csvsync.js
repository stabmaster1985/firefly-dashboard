// Gedächtnis des CSV-Abgleichs: welche CSV-Zeilen schon nach Firefly
// übertragen wurden. Wird dieselbe Datei noch einmal eingelesen, erkennt
// das Dashboard diese Zeilen und überspringt sie. Gespeichert wird nur ein
// Fingerabdruck der Zeile (Hash), dazu Buchungsnummer, Name und Zeitpunkt.
//
//   GET    /local/csvsync   { count, since, rows: { fp: { j, name, at } } }
//   POST   /local/csvsync   { items: [{ fp, j, name }] } → merken
//   DELETE /local/csvsync   alles vergessen

import path from 'node:path';
import { jsonFile } from './store.js';

const MAX = 500_000;

export function createCsvSync(dataDir, { log = console.log } = {}) {
  const file = jsonFile(path.join(dataDir, 'csv-sync.json'), { rows: {} }, { snapshots: true, log });

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('Ungültiges JSON.'));
        }
      });
      req.on('error', reject);
    });

  const summary = (data) => {
    const all = Object.values(data.rows);
    return { count: all.length, since: all.reduce((m, r) => (!m || r.at < m ? r.at : m), null), rows: data.rows };
  };

  /** Zeilen merken (auch für den Übertragungs-Auftrag auf dem Server). */
  const remember = (items) => {
    const data = file.read();
    const at = new Date().toISOString();
    for (const it of Array.isArray(items) ? items.slice(0, 20_000) : []) {
      const fp = String(it.fp ?? '');
      if (!/^[0-9a-z]{6,40}$/.test(fp)) continue;
      data.rows[fp] = { j: String(it.j ?? '').slice(0, 20), name: String(it.name ?? '').slice(0, 120), at };
    }
    if (Object.keys(data.rows).length > MAX) throw new Error('Zu viele gemerkte Zeilen – bitte „Gedächtnis leeren“.');
    file.write(data);
    return data;
  };

  async function handle(req, res) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    try {
      if (req.method === 'POST') {
        const input = await readJson(req);
        return json(200, summary(remember(input.items)));
      }
      if (req.method === 'DELETE') {
        file.write({ rows: {} });
        return json(200, summary({ rows: {} }));
      }
      return json(200, summary(file.read()));
    } catch (err) {
      return json(400, { message: err.message });
    }
  }
  handle.remember = remember;
  return handle;
}
