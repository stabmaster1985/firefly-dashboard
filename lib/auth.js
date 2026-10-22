// Anmeldung: Login-Seite + Sitzungs-Cookie statt HTTP Basic Auth (Browser – vor allem die
// installierte App auf dem Handy – vergessen Basic-Auth-Zugangsdaten ständig).
//
// Das Cookie ist signiert (HMAC) und gilt 180 Tage; bei Benutzung verlängert es sich von selbst.
// Der Schlüssel liegt in DATA_DIR und übersteht so Neustarts und Updates. Er hängt zusätzlich
// an Benutzer und Passwort: Wer das Passwort ändert, meldet damit alle Geräte ab.
// Basic Auth (Header) gilt weiter – für Skripte und Werkzeuge.
//
//   GET  /login     Anmeldeseite        POST /login   { user, password, next }
//   GET  /logout    dieses Gerät abmelden

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE = 'ffd_session';
const LIFETIME_S = 180 * 24 * 3600;
const RENEW_AFTER_S = 24 * 3600; // höchstens einmal am Tag neu ausstellen
const MAX_FAILS = 10; // Fehlversuche je Adresse …
const FAIL_WINDOW_MS = 15 * 60_000; // … in diesem Zeitraum

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function loadSecret(dataDir) {
  const file = path.join(dataDir, 'session-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {
    // noch keiner da
  }
  const s = b64url(crypto.randomBytes(32));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
  } catch (err) {
    console.warn(`Sitzungsschlüssel nicht gespeichert (${err.message}) – nach einem Neustart ist eine neue Anmeldung nötig.`);
  }
  return s;
}

const page = (error = '', next = '/', askUser = true) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anmelden · Firefly Dashboard</title><meta name="theme-color" content="#2a78d6"><link rel="icon" href="favicon.svg">
<style>
:root { --bg: #f6f6f3; --card: #fff; --text: #1c1c1a; --muted: #6b6a65; --border: #e2e1dc; --accent: #2a78d6; --bad: #b4232c; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #33322f; --accent: #5a9cf0; --bad: #f07171; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
form { width: 100%; max-width: 340px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 28px 24px; display: grid; gap: 14px; }
h1 { margin: 0 0 4px; font-size: 20px; display: flex; align-items: center; gap: 10px; }
h1 svg { width: 28px; height: 28px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input[type=text], input[type=password] { font: inherit; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.check { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 14px; }
button { font: inherit; font-weight: 600; padding: 11px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
.error { color: var(--bad); font-size: 14px; margin: 0; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
</style></head><body>
<form method="post" action="login">
  <h1><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2a78d6"/><path d="M7 21l6-6 4 4 8-8" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Firefly Dashboard</h1>
  ${error ? `<p class="error" role="alert">${error}</p>` : ''}
  ${askUser ? '<label>Benutzer <input type="text" name="user" autocomplete="username" autocapitalize="none" required autofocus></label>' : '<input type="hidden" name="user" value="" autocomplete="username">'}
  <label>Passwort <input type="password" name="password" autocomplete="current-password" required${askUser ? '' : ' autofocus'}></label>
  <label class="check"><input type="checkbox" name="remember" value="1" checked> Angemeldet bleiben (180 Tage)</label>
  <input type="hidden" name="next" value="${String(next).replace(/[^\w#/?=&%.-]/g, '')}">
  <button>Anmelden</button>
  <p class="hint">Die Anmeldung gilt nur für dieses Gerät bzw. diesen Browser.</p>
</form></body></html>`;

export function createAuth({ dataDir, user, password, log = console.log }) {
  const enabled = Boolean(password);
  const secret = enabled ? loadSecret(dataDir) : '';
  // Schlüssel hängt an Benutzer + Passwort → Passwort ändern = alle Geräte abmelden
  const key = enabled ? crypto.createHmac('sha256', secret).update(`${user}\n${password}`).digest() : null;
  const sign = (payload) => b64url(crypto.createHmac('sha256', key).update(payload).digest());
  const fails = new Map(); // ip → [Zeitpunkte]

  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const isHttps = (req) => Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const cookieHeader = (req, value, maxAge) => [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    ...(maxAge !== null ? [`Max-Age=${maxAge}`] : []),
    ...(isHttps(req) ? ['Secure'] : []),
  ].join('; ');
  /** Sitzungs-Cookie: v1.<ablauf>.<ausgestellt>.<persistent>.<signatur> */
  const issue = (req, persistent) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = `v1.${now + LIFETIME_S}.${now}.${persistent ? 1 : 0}`;
    return cookieHeader(req, `${payload}.${sign(payload)}`, persistent ? LIFETIME_S : null);
  };
  const session = (req) => {
    const raw = cookies(req)[COOKIE];
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    const payload = parts.slice(0, 4).join('.');
    if (!safeEqual(parts[4], sign(payload))) return null;
    const exp = Number(parts[1]);
    if (!(exp > Date.now() / 1000)) return null;
    return { issued: Number(parts[2]), persistent: parts[3] === '1' };
  };
  const basicOk = (req) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    return sep >= 0 && safeEqual(decoded.slice(0, sep), user || decoded.slice(0, sep)) && safeEqual(decoded.slice(sep + 1), password);
  };
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const blocked = (ip) => {
    const list = (fails.get(ip) || []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);
    fails.set(ip, list);
    return list.length >= MAX_FAILS;
  };
  const readForm = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 10_000) {
        reject(new Error('zu groß'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
  const html = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(body);
  };
  const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w#/?=&%.-]*$/.test(n) ? n : '/');

  return {
    enabled,
    /**
     * Vor jeder Anfrage: true = weiter, false = schon beantwortet.
     * Oberfläche (HTML/JS/CSS) ist frei – sie enthält keine Daten und ist ohnehin öffentlich;
     * Daten (/api, /local, /config.json) brauchen eine Sitzung.
     */
    async handle(req, res, url) {
      if (!enabled) {
        if (url.pathname === '/login' || url.pathname === '/logout') {
          res.writeHead(302, { Location: './' });
          res.end();
          return false;
        }
        return true;
      }
      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          const ip = clientIp(req);
          const form = await readForm(req).catch(() => ({}));
          const next = safeNext(form.next);
          if (blocked(ip)) return html(res, 429, page('Zu viele Fehlversuche – bitte 15 Minuten warten.', next, Boolean(user))), false;
          const ok = safeEqual(form.password || '', password) && (!user || safeEqual((form.user || '').trim(), user));
          if (!ok) {
            fails.get(ip).push(Date.now());
            log(`Anmeldung fehlgeschlagen (${ip})`);
            return html(res, 401, page('Benutzer oder Passwort falsch.', next, Boolean(user))), false;
          }
          fails.delete(ip);
          res.writeHead(303, { Location: next, 'Set-Cookie': issue(req, form.remember === '1'), 'Cache-Control': 'no-store' });
          res.end();
          return false;
        }
        if (session(req)) {
          res.writeHead(302, { Location: safeNext(url.searchParams.get('next')) });
          res.end();
          return false;
        }
        return html(res, 200, page('', safeNext(url.searchParams.get('next')), Boolean(user))), false;
      }
      if (url.pathname === '/logout') {
        res.writeHead(302, { Location: 'login', 'Set-Cookie': cookieHeader(req, '', 0), 'Cache-Control': 'no-store' });
        res.end();
        return false;
      }
      const s = session(req);
      if (s) {
        // gleitend verlängern: wer das Dashboard nutzt, bleibt angemeldet
        if (s.persistent && Date.now() / 1000 - s.issued > RENEW_AFTER_S) res.setHeader('Set-Cookie', issue(req, true));
        return true;
      }
      if (basicOk(req)) return true;
      const isData = url.pathname.startsWith('/api/') || url.pathname.startsWith('/local/') || url.pathname === '/config.json';
      if (!isData) return true;
      // kein WWW-Authenticate → der Browser zeigt kein Basic-Auth-Fenster; die App leitet zur Anmeldung
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Login-Required': '1' });
      res.end(JSON.stringify({ message: 'Anmeldung erforderlich.' }));
      return false;
    },
  };
}
