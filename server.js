#!/usr/bin/env node
// Firefly Dashboard – kleiner Server ohne Framework.
// Liefert die Weboberfläche aus und reicht lesende API-Aufrufe an Firefly III
// weiter. Der Access Token bleibt dabei ausschließlich auf dem Server.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createActions } from './lib/actions.js';

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
};

const STATIC_FILES = {
  '/vendor/chart.umd.js': path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.js'),
};

const cache = new Map();

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

async function proxy(req, res, url) {
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

  const target = `${FIREFLY_URL}/api/v1/${apiPath}${url.search}`;
  const noCache = req.headers['x-no-cache'] === '1';
  const hit = cache.get(target);
  if (!noCache && hit && hit.expires > Date.now()) {
    return send(res, 200, hit.body, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${FIREFLY_TOKEN}`,
        Accept: 'application/vnd.api+json, application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (upstream.ok && CACHE_SECONDS > 0) {
      cache.set(target, { body, expires: Date.now() + CACHE_SECONDS * 1000 });
    }
    send(res, upstream.status, body, {
      'Content-Type': upstream.headers.get('content-type') || MIME['.json'],
      'X-Cache': 'MISS',
    });
  } catch (err) {
    console.error(`Firefly nicht erreichbar (${target}):`, err.message);
    send(res, 502, JSON.stringify({ message: `Firefly III nicht erreichbar: ${err.message}` }), {
      'Content-Type': MIME['.json'],
    });
  }
}

function serveStatic(res, url) {
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
    }
    fs.readFile(file, (readErr, data) => {
      if (readErr) return send(res, 404, 'Not found');
      send(res, 200, data, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    });
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
  if (url.pathname === '/config.json') {
    const config = { fireflyUrl: process.env.FIREFLY_PUBLIC_URL || FIREFLY_URL };
    return send(res, 200, JSON.stringify(config), { 'Content-Type': MIME['.json'] });
  }
  serveStatic(res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Firefly Dashboard läuft auf http://localhost:${PORT}`);
  console.log(`Firefly III: ${FIREFLY_URL}`);
  if (!DASHBOARD_PASSWORD) {
    console.log('Hinweis: Kein DASHBOARD_PASSWORD gesetzt – jeder im Netzwerk kann das Dashboard öffnen.');
  }
});
