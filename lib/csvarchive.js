// CSV-Archiv für den Abgleich: Bank-CSV-Dateien einmal hochladen, sie bleiben auf dem
// Server (DATA_DIR/csv-archive) – auf allen Geräten und über Updates hinweg. Gelesen und
// nach Konto sortiert werden sie im Browser; hier liegen nur die Dateien, ihre Eckdaten
// (vom Browser ermittelt) und der letzte Stand „was ist davon in Firefly“ je Konto.
//
//   GET    /local/csvarchive                 { files: [{ id, name, size, at, info }], status: { konto: {…} } }
//   POST   /local/csvarchive?name=…          Rohdaten der Datei → { file, duplicate }
//   GET    /local/csvarchive/file/<id>       Rohdaten
//   DELETE /local/csvarchive/file/<id>       Datei löschen
//   POST   /local/csvarchive/info            { infos: { id: { own, from, to, rows } } }
//   POST   /local/csvarchive/status          { status: { konto: { …zahlen, at } } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { jsonFile } from './store.js';

const MAX_FILE = 30 * 1024 * 1024;
const MAX_FILES = 2000;
const ID = /^[0-9a-f]{24}$/;
const text = (v, n = 200) => String(v ?? '').slice(0, n);

export function createCsvArchive(dataDir, { log = console.log } = {}) {
  const dir = path.join(dataDir, 'csv-archive');
  fs.mkdirSync(dir, { recursive: true });
  const index = jsonFile(path.join(dataDir, 'csv-archive.json'), { files: {}, status: {} }, { snapshots: true, log });

  const readBody = (req, max) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error(`Datei zu groß (höchstens ${Math.round(max / 1024 / 1024)} MB).`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async (req) => {
    const buf = await readBody(req, 2_000_000);
    try {
      return buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch {
      throw new Error('Ungültiges JSON.');
    }
  };
  const list = () => {
    const data = index.read();
    return {
      files: Object.entries(data.files).map(([id, f]) => ({ id, ...f })).sort((a, b) => a.name.localeCompare(b.name, 'de')),
      status: data.status || {},
    };
  };
  const cleanInfo = (i) => ({
    own: text(i?.own, 40).replace(/[^A-Z0-9]/gi, ''), from: text(i?.from, 10), to: text(i?.to, 10),
    rows: Number(i?.rows) || 0, bank: text(i?.bank, 80), error: i?.error ? text(i.error, 200) : undefined,
  });

  return async function handle(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    const p = url.pathname.replace(/^\/local\/csvarchive\/?/, '');
    try {
      if (p === '' && req.method === 'GET') return json(200, list());
      if (p === '' && req.method === 'POST') {
        const name = text(url.searchParams.get('name') || 'umsaetze.csv', 160).replace(/[\\/]/g, '_');
        const buf = await readBody(req, MAX_FILE);
        if (!buf.length) throw new Error('Leere Datei.');
        // gleiche Datei (gleicher Inhalt) nur einmal
        const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
        const data = index.read();
        if (data.files[id]) return json(200, { file: { id, ...data.files[id] }, duplicate: true });
        if (Object.keys(data.files).length >= MAX_FILES) throw new Error('Das Archiv ist voll – bitte alte Dateien löschen.');
        fs.writeFileSync(path.join(dir, `${id}.csv.gz`), zlib.gzipSync(buf));
        data.files[id] = { name, size: buf.length, at: new Date().toISOString(), info: null };
        index.write(data);
        log(`CSV-Archiv: ${name} gespeichert (${Math.round(buf.length / 1024)} KB)`);
        return json(200, { file: { id, ...data.files[id] }, duplicate: false });
      }
      const m = p.match(/^file\/([0-9a-f]+)$/);
      if (m && ID.test(m[1])) {
        const file = path.join(dir, `${m[1]}.csv.gz`);
        const data = index.read();
        if (req.method === 'DELETE') {
          delete data.files[m[1]];
          index.write(data);
          fs.rmSync(file, { force: true });
          return json(200, list());
        }
        if (!data.files[m[1]] || !fs.existsSync(file)) return json(404, { message: 'Datei nicht im Archiv.' });
        const gz = fs.readFileSync(file);
        const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable', // Inhalt ändert sich nie (ID = Hash)
          ...(accepts ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
        });
        return res.end(accepts ? gz : zlib.gunzipSync(gz));
      }
      if (p === 'info' && req.method === 'POST') {
        const input = await readJson(req);
        const data = index.read();
        for (const [id, info] of Object.entries(input.infos || {})) if (data.files[id]) data.files[id].info = cleanInfo(info);
        index.write(data);
        return json(200, list());
      }
      if (p === 'status' && req.method === 'POST') {
        const input = await readJson(req);
        const data = index.read();
        data.status ||= {};
        for (const [key, s] of Object.entries(input.status || {}).slice(0, 200)) {
          if (!/^[\w:-]{1,60}$/.test(key)) continue;
          if (s === null) {
            delete data.status[key];
            continue;
          }
          const counts = Object.fromEntries(Object.entries(s.counts || {}).slice(0, 20).map(([k, v]) => [text(k, 30), Number(v) || 0]));
          data.status[key] = { counts, rows: Number(s.rows) || 0, from: text(s.from, 10), to: text(s.to, 10), files: text(s.files, 2000), at: new Date().toISOString() };
        }
        index.write(data);
        return json(200, list());
      }
      return json(404, { message: 'Unbekannt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}
