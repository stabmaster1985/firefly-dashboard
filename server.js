#!/usr/bin/env node
// Firefly Dashboard – kleiner Server ohne Framework.
// Liefert die Weboberfläche aus und reicht lesende API-Aufrufe an Firefly III
// weiter. Der Access Token bleibt dabei ausschließlich auf dem Server.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createActions } from './lib/actions.js';
import { createFirefly } from './lib/firefly.js';
import { startWarmer } from './lib/warmer.js';
import { createAutomation } from './lib/automation.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // keine .env-Datei – Umgebungsvariablen werden direkt verwendet
}

const FIREFLY_URL = (process.env.FIREFLY_URL || '').replace(/\/+$/, '');
const FIREFLY_TOKEN = process.env.FIREFLY_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS ?? 60);
const CACHE_HISTORY_HOURS = Number(process.env.CACHE_HISTORY_HOURS ?? 12);
const FIREFLY_CONCURRENCY = Number(process.env.FIREFLY_CONCURRENCY ?? 4);
const WARM_MINUTES = Number(process.env.WARM_MINUTES ?? 10);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

if (!FIREFLY_URL || !FIREFLY_TOKEN) {
  console.error('FIREFLY_URL und FIREFLY_TOKEN müssen gesetzt sein (siehe .env.example).');
  process.exit(1);
}

// Automationen (Webhooks) – eigene, lokal gespeicherte Konfiguration
const handleActions = createActions(DATA_DIR);

// Nur diese Firefly-Endpunkte dürfen gelesen werden – in Firefly wird nie geschrieben.
const ALLOWED = [
  /^about(\/user)?$/,
  /^summary\/basic$/,
  /^accounts(\/\d+(\/transactions)?)?$/,
  /^transactions(\/\d+)?$/,
  /^search\/transactions$/,
  /^insight\/(expense|income)\/(category|no-category|total|budget|no-budget|expense|revenue|asset|tag|bill)$/,
  /^chart\/account\/overview$/,
  /^categories(\/\d+(\/transactions)?)?$/,
  /^tags(\/[^/]+(\/transactions)?)?$/,
  /^currencies(\/default|\/primary)?$/,
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const STATIC_FILES = {
  '/vendor/chart.umd.js': path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.js'),
};

const firefly = createFirefly({
  baseUrl: FIREFLY_URL,
  token: FIREFLY_TOKEN,
  ttl: CACHE_SECONDS,
  historyTtl: CACHE_HISTORY_HOURS * 3600,
  concurrency: Math.max(1, FIREFLY_CONCURRENCY),
});

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req) {
  if (!DASHBOARD_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, DASHBOARD_USER || user) && safeEqual(pass, DASHBOARD_PASSWORD);
}

// Gehaltstage, die Browser melden (für das Vorwärmen von Gehaltsmonaten)
const monthStarts = new Set();
let warmNow = null;
function noteMonthStart(req) {
  const day = Number(req.headers['x-month-start']);
  if (!(day >= 2 && day <= 28) || monthStarts.has(day)) return;
  if (monthStarts.size >= 3) monthStarts.delete(monthStarts.values().next().value);
  monthStarts.add(day);
  setTimeout(() => warmNow?.(), 5000); // neuen Gehaltstag zeitnah vorladen
}

async function proxy(req, res, url) {
  noteMonthStart(req);
  const apiPath = url.pathname.replace(/^\/api\//, '');
  if (req.method !== 'GET') {
    return send(res, 405, JSON.stringify({ message: 'Nur lesender Zugriff erlaubt.' }), {
      'Content-Type': MIME['.json'],
    });
  }
  if (!ALLOWED.some((re) => re.test(apiPath))) {
    return send(res, 403, JSON.stringify({ message: `Endpunkt nicht freigegeben: ${apiPath}` }), {
      'Content-Type': MIME['.json'],
    });
  }

  try {
    const result = await firefly.get(apiPath, url.searchParams, { fresh: req.headers['x-no-cache'] === '1' });
    const gzip = result.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    send(res, result.status, gzip ? result.gz : result.body, {
      'Content-Type': result.type,
      'X-Cache': result.state,
      'Cache-Control': 'no-store',
      ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    });
  } catch (err) {
    console.error(`Firefly nicht erreichbar (${apiPath}):`, err.message);
    send(res, 502, JSON.stringify({ message: `Firefly III nicht erreichbar: ${err.message}` }), {
      'Content-Type': MIME['.json'],
    });
  }
}

// Statische Dateien einmal komprimiert vorhalten; ETag spart Übertragungen
const staticCache = new Map();

function serveStatic(req, res, url) {
  let file = STATIC_FILES[url.pathname];
  if (!file) {
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    file = path.join(ROOT, 'public', rel || 'index.html');
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'Forbidden');
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      // Unbekannte Pfade landen in der App (Hash-Routing)
      file = path.join(ROOT, 'public', 'index.html');
      stat = fs.statSync(file);
    }
    const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
    let entry = staticCache.get(file);
    if (!entry || entry.etag !== etag) {
      const body = fs.readFileSync(file);
      entry = { etag, body, gz: body.length > 1024 ? zlib.gzipSync(body) : null };
      staticCache.set(file, entry);
    }
    const gzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    send(res, 200, gzip ? entry.gz : entry.body, gzip ? { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : headers);
  });
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    return send(res, 401, 'Anmeldung erforderlich', {
      'WWW-Authenticate': 'Basic realm="Firefly Dashboard", charset="UTF-8"',
    });
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);
  if (url.pathname === '/local/actions' || url.pathname.startsWith('/local/actions/')) return handleActions(req, res, url);
  if (['/local/settings', '/local/goals', '/local/alerts', '/local/rules'].includes(url.pathname)) return handleAutomation(req, res, url);
  if (url.pathname === '/local/stats') {
    return send(res, 200, JSON.stringify(firefly.summary()), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  }
  if (url.pathname === '/config.json') {
    const config = { fireflyUrl: process.env.FIREFLY_PUBLIC_URL || FIREFLY_URL };
    return send(res, 200, JSON.stringify(config), { 'Content-Type': MIME['.json'] });
  }
  serveStatic(req, res, url);
});

// Ziele, Einstellungen, Monatsabschluss und Warnungen
const handleAutomation = createAutomation({ dataDir: DATA_DIR, firefly, actions: handleActions });

if (WARM_MINUTES > 0) warmNow = startWarmer(firefly, { minutes: WARM_MINUTES, monthStarts: () => [...monthStarts] });

server.listen(PORT, HOST, () => {
  console.log(`Firefly Dashboard läuft auf http://localhost:${PORT}`);
  console.log(`Firefly III: ${FIREFLY_URL}`);
  if (!DASHBOARD_PASSWORD) {
    console.log('Hinweis: Kein DASHBOARD_PASSWORD gesetzt – jeder im Netzwerk kann das Dashboard öffnen.');
  }
});
