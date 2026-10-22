// Übertragungs-Auftrag des CSV-Abgleichs – läuft auf dem Server, nicht im Browser.
// Handy oder PC müssen nicht an bleiben: Der Server schickt die Pakete an n8n (Automation
// „Kategorie übernehmen“, typ „gegenkonto_setzen“ mit hintergrund: true), richtet das Tempo
// nach Firefly, prüft am Ende jede Buchung frisch in Firefly und schickt Fehlendes erneut.
// Bricht die Verbindung zu n8n oder Firefly ab, versucht er es mit wachsenden Pausen weiter.
// Der Stand liegt in DATA_DIR/sync-job.json – nach einem Neustart (Update) geht es weiter.
//
//   GET    /local/syncjob            Stand (ohne Einzelposten; ?fps=1 mit erledigten Fingerabdrücken)
//   POST   /local/syncjob            neuer Auftrag { actionId, portion, parallel, items: [...] }
//   POST   /local/syncjob/pause      anhalten (laufende Pakete arbeitet n8n noch ab)
//   POST   /local/syncjob/resume     fortsetzen
//   DELETE /local/syncjob            Auftrag verwerfen

import path from 'node:path';
import { jsonFile } from './store.js';
import { hasNoParty } from '../public/js/csvmatch.js';

const SIZE_START = 40;
const SIZE_MIN = 5;
const SIZE_MAX = 250;
const TARGET_MS = 3 * 60_000; // eine n8n-Ausführung soll rund 3 Minuten dauern
const POLL_MS = Number(process.env.SYNC_POLL_MS || 10_000);
const STALL_MS = Number(process.env.SYNC_STALL_MS || 90_000); // so lange ohne Fortschritt → Paket hängt
const ROUNDS = 3; // so oft geht eine fehlende Buchung höchstens raus
// Pausen nach Verbindungsfehlern: 1, 2, 5, 10, 15, dann alle 30 Minuten – bis zu 12 Stunden
const BACKOFF_MIN = (process.env.SYNC_BACKOFF_MIN || '1,2,5,10,15,30').split(',').map(Number);
const GIVE_UP_MS = Number(process.env.SYNC_GIVE_UP_MS || 12 * 3600_000);
const EMPTY_LIMIT = 4; // so viele Pakete hintereinander ohne jede Wirkung → anhalten (Einrichtung prüfen)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (v, n) => String(v ?? '').slice(0, n);

export function createSyncJob(dataDir, { firefly, actions, csvMemory, log = console.log }) {
  const file = jsonFile(path.join(dataDir, 'sync-job.json'), { job: null }, { log });
  let job = file.read().job;
  // Paket-Markierungen eines abgebrochenen Laufs (Neustart mitten im Senden) zurücksetzen
  job?.items?.forEach((i) => delete i.taken);
  let running = false;
  let wake = null; // vorzeitig aus einer Pause wecken (fortsetzen)
  let lastSave = 0;

  const save = (force = false) => {
    if (!force && Date.now() - lastSave < 3000) return;
    lastSave = Date.now();
    file.write({ job });
  };
  const note = (msg) => {
    job.log.unshift({ at: new Date().toISOString(), msg: text(msg, 300) });
    job.log.length = Math.min(job.log.length, 40);
    job.message = text(msg, 300);
    log(`CSV-Übertragung: ${msg}`);
  };
  const count = (state) => job.items.filter((i) => i.state === state).length;
  const summary = (withFps = false) => job && job.status !== 'verworfen' && {
    id: job.id, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt || null, message: job.message || '',
    retryAt: job.retryAt || null, round: job.round, size: job.size, perMinute: job.perItem ? Math.round(60000 / job.perItem) : null,
    total: job.items.length, offen: count('offen'), gesendet: count('gesendet'), ok: count('ok'), fehlt: count('fehlt'),
    portion: job.portion, parallel: job.parallel, actionName: job.actionName, log: job.log.slice(0, 15),
    ...(withFps ? { fps: job.items.filter((i) => i.state === 'ok').map((i) => i.fp) } : {}),
  };

  /** Buchung frisch aus Firefly lesen: steht die Änderung schon drin? (null = Firefly nicht erreichbar) */
  async function arrived(item) {
    let r;
    try {
      r = await firefly.get(`transactions/${item.g}`, {}, { fresh: true, priority: 'warm' });
    } catch {
      return null;
    }
    if (r.status === 404) return false;
    if (r.status >= 400) return null;
    let split;
    try {
      split = (JSON.parse(r.body.toString('utf8'))?.data?.attributes?.transactions || []).find((x) => String(x.transaction_journal_id) === String(item.j));
    } catch {
      return null;
    }
    if (!split) return false;
    const c = item.check || {};
    if (c.party) {
      const party = String((split.type === 'deposit' ? split.source_name : split.destination_name) || '').trim();
      // Name aus der CSV – oder (bei gleicher IBAN) ein anderes, aber echtes Gegenkonto als vorher
      const ok = party.toLowerCase() === c.party.trim().toLowerCase() || (!hasNoParty(split) && party !== String(c.before || '').trim());
      if (!ok) return false;
    }
    if (c.description && String(split.description || '').trim() !== c.description.trim()) return false;
    if (c.tags?.length && !c.tags.every((x) => (split.tags || []).includes(x))) return false;
    return true;
  }

  /** Warten mit Wecker (Fortsetzen/Anhalten soll nicht bis zum Ende der Pause dauern). */
  const pause = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

  /** Verbindungsfehler: mit wachsender Pause neu versuchen; nach GIVE_UP_MS anhalten. */
  async function backoff(reason) {
    job.failSince ||= Date.now();
    job.fails = (job.fails || 0) + 1;
    if (Date.now() - job.failSince > GIVE_UP_MS) {
      job.status = 'pausiert';
      note(`Angehalten: seit ${Math.round((Date.now() - job.failSince) / 3600_000)} Stunden keine Verbindung (${reason}). „Fortsetzen“ versucht es erneut.`);
      save(true);
      return false;
    }
    const min = BACKOFF_MIN[Math.min(job.fails - 1, BACKOFF_MIN.length - 1)];
    job.retryAt = new Date(Date.now() + min * 60_000).toISOString();
    note(`${reason} – neuer Versuch in ${min} Min. (Versuch ${job.fails})`);
    save(true);
    await pause(min * 60_000);
    job.retryAt = null;
    return job.status === 'laeuft';
  }
  const connected = () => {
    job.fails = 0;
    job.failSince = null;
  };

  /** Ein Paket schicken und warten, bis n8n durch ist (nur die letzte Buchung + Fortschritt nachsehen). */
  async function sendPart(part) {
    const payload = { typ: 'gegenkonto_setzen', hintergrund: true, portion: job.portion, aenderungen: part.map((i) => i.payload) };
    const res = await actions.run(job.actionId, { ...payload, daten: payload }).catch((err) => ({ ok: false, status: 0, response: err.message }));
    if (!res.ok && res.status && res.status < 500 && res.status !== 408) {
      job.status = 'pausiert';
      note(`n8n lehnt ab (HTTP ${res.status}): ${text(res.response, 160)} – Automation prüfen, dann „Fortsetzen“.`);
      return 'stop';
    }
    if (!res.ok && !res.status) return `n8n nicht erreichbar (${text(res.response, 120)})`;
    const sentAt = Date.now();
    for (const i of part) {
      i.state = 'gesendet';
      i.sentAt = sentAt;
      i.tries = (i.tries || 0) + 1;
    }
    save(true);
    // Tempo: n8n arbeitet der Reihe nach – letzte Buchung des Pakets und die nächsten paar nachsehen
    const last = part[part.length - 1];
    let pos = 0;
    let lastProgress = Date.now();
    let through = false;
    let fireflyDown = 0;
    while (job.status === 'laeuft') {
      await sleep(POLL_MS);
      const a = await arrived(last);
      if (a === null) {
        fireflyDown += 1;
        if (fireflyDown >= 6) break; // Firefly antwortet nicht – die Prüfung am Ende holt das nach
        continue;
      }
      fireflyDown = 0;
      if (a) {
        through = true;
        break;
      }
      const before = pos;
      for (let n = 0; n < 3 && pos < part.length - 1 && (await arrived(part[pos])); n++) pos += 1;
      if (pos > before) lastProgress = Date.now();
      else if (Date.now() - lastProgress > STALL_MS) break;
    }
    if (!through && job.status !== 'laeuft') return 'stop'; // angehalten/verworfen – die Prüfung holt den Rest
    const took = Date.now() - sentAt;
    if (through) {
      last.state = 'ok';
      csvMemory([last]);
      job.perItem = took / part.length;
      job.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(TARGET_MS / job.perItem)));
      job.empty = 0;
      connected();
      return 'ok';
    }
    if (pos > 0) {
      job.perItem = (lastProgress - sentAt) / pos;
      job.size = Math.max(SIZE_MIN, Math.min(Math.floor(pos * 0.8), Math.round(TARGET_MS / job.perItem)));
      job.empty = 0;
      connected();
      return 'ok';
    }
    job.size = Math.max(SIZE_MIN, Math.floor(job.size / 2));
    job.empty = (job.empty || 0) + 1;
    if (!res.ok) return `n8n antwortet mit HTTP ${res.status}`;
    if (job.empty >= EMPTY_LIMIT) {
      job.status = 'pausiert';
      note(`Von ${EMPTY_LIMIT} Paketen hintereinander kam nichts in Firefly an – in n8n unter „Executions“ nachsehen, dann „Fortsetzen“.`);
      return 'stop';
    }
    return 'ok';
  }

  /** Alle „gesendet“ frisch prüfen → ok / fehlt. false = Firefly nicht erreichbar. */
  async function verifyAll() {
    const list = job.items.filter((i) => i.state === 'gesendet');
    for (let k = 0; k < list.length && job.status === 'laeuft'; k += 10) {
      const slice = list.slice(k, k + 10);
      const res = await Promise.all(slice.map(arrived));
      if (res.some((x) => x === null)) return false;
      const ok = [];
      slice.forEach((i, n) => {
        i.state = res[n] ? 'ok' : 'fehlt';
        if (res[n]) ok.push(i);
      });
      if (ok.length) csvMemory(ok);
      job.message = `Prüfe in Firefly: ${Math.min(k + 10, list.length)} von ${list.length} …`;
      save();
    }
    return true;
  }

  async function loop() {
    if (running || !job || job.status !== 'laeuft') return;
    running = true;
    try {
      while (job.status === 'laeuft') {
        // senden: alle offenen in Paketen, mehrere Arbeiter teilen sich die Warteschlange
        if (count('offen')) {
          job.message = `Runde ${job.round}: schicke ${count('offen')} Buchungen an n8n …`;
          let problem = null;
          const worker = async () => {
            while (job.status === 'laeuft' && !problem) {
              const part = job.items.filter((i) => i.state === 'offen' && !i.taken).slice(0, job.size);
              if (!part.length) return;
              part.forEach((i) => (i.taken = true));
              const r = await sendPart(part).finally(() => part.forEach((i) => delete i.taken));
              if (r !== 'ok' && r !== 'stop') problem = r;
            }
          };
          await Promise.all(Array.from({ length: job.parallel }, worker));
          if (problem) {
            if (!(await backoff(problem))) break;
            continue;
          }
          if (job.status !== 'laeuft') break;
        }
        // prüfen
        if (count('gesendet')) {
          // n8n arbeitet evtl. noch am letzten Paket (z. B. nach „Anhalten“/Neustart): warten, bis dessen
          // letzte Buchung angekommen ist – höchstens STALL_MS lang ohne Ergebnis
          const sent = job.items.filter((i) => i.state === 'gesendet');
          const last = sent.reduce((a, b) => ((b.sentAt || 0) >= (a.sentAt || 0) ? b : a), sent[0]); // letzte in Sende-Reihenfolge
          const since = Date.now();
          while (job.status === 'laeuft' && Date.now() - since < STALL_MS && (await arrived(last)) === false) {
            job.message = 'Warte, bis n8n das letzte Paket gespeichert hat …';
            await pause(POLL_MS);
          }
          if (job.status !== 'laeuft') break;
          if (!(await verifyAll())) {
            if (!(await backoff('Firefly nicht erreichbar'))) break;
            continue;
          }
          connected();
          if (job.status !== 'laeuft') break;
        }
        // fehlende erneut schicken, solange Runden übrig sind
        const again = job.items.filter((i) => i.state === 'fehlt' && (i.tries || 0) < ROUNDS);
        if (again.length) {
          job.round += 1;
          again.forEach((i) => (i.state = 'offen'));
          note(`${again.length} Buchungen fehlen in Firefly – Runde ${job.round}`);
          continue;
        }
        job.status = 'fertig';
        job.finishedAt = new Date().toISOString();
        firefly.invalidate?.();
        note(count('fehlt') ? `Fertig: ${count('ok')} umgestellt, ${count('fehlt')} nach ${ROUNDS} Versuchen nicht in Firefly.` : `Fertig: alle ${count('ok')} umgestellt und geprüft ✓`);
      }
    } catch (err) {
      job.status = 'pausiert';
      note(`Unerwarteter Fehler: ${err.message} – „Fortsetzen“ versucht es erneut.`);
    } finally {
      running = false;
      if (job.status === 'verworfen') {
        job = null;
        file.write({ job: null });
      } else save(true);
    }
  }

  // nach einem Neustart weitermachen; was mitten im Senden war, wird geprüft
  if (job?.status === 'laeuft') {
    log('CSV-Übertragung: setze den Auftrag nach dem Neustart fort.');
    setTimeout(loop, 5000);
  }

  const readJson = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25_000_000) {
        reject(new Error('Auftrag zu groß.'));
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
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    const p = url.pathname.replace(/^\/local\/syncjob\/?/, '');
    try {
      if (p === '' && req.method === 'GET') return json(200, { job: summary(url.searchParams.get('fps') === '1') });
      if (p === '' && req.method === 'POST') {
        if (job && ['laeuft', 'pausiert'].includes(job.status) && count('offen') + count('gesendet')) {
          throw new Error('Es läuft schon ein Auftrag – erst abwarten oder verwerfen.');
        }
        const input = await readJson(req);
        const action = actions.list().find((a) => a.id === input.actionId);
        if (!action) throw new Error('Automation nicht gefunden.');
        const items = (Array.isArray(input.items) ? input.items : []).slice(0, 50_000).map((i) => ({
          j: text(i.j, 20), g: text(i.g, 20), fp: text(i.fp, 40), name: text(i.name, 120),
          payload: i.payload && typeof i.payload === 'object' ? i.payload : {},
          check: { party: i.check?.party ? text(i.check.party, 200) : '', before: text(i.check?.before, 200), description: i.check?.description ? text(i.check.description, 500) : '', tags: Array.isArray(i.check?.tags) ? i.check.tags.slice(0, 30).map((x) => text(x, 80)) : [] },
          state: 'offen', tries: 0,
        })).filter((i) => /^\d+$/.test(i.j) && /^\d+$/.test(i.g));
        if (!items.length) throw new Error('Keine Buchungen im Auftrag.');
        job = {
          id: Date.now().toString(36), status: 'laeuft', createdAt: new Date().toISOString(), actionId: action.id, actionName: action.name,
          portion: Math.min(40, Math.max(1, Number(input.portion) || 10)), parallel: Math.min(4, Math.max(1, Number(input.parallel) || 1)),
          size: SIZE_START, round: 1, items, log: [],
        };
        note(`Neuer Auftrag: ${items.length} Buchungen über „${action.name}“`);
        save(true);
        loop();
        return json(200, { job: summary() });
      }
      if (!job) return json(404, { message: 'Kein Auftrag.' });
      if (p === 'pause' && req.method === 'POST') {
        if (job.status === 'laeuft') {
          job.status = 'pausiert';
          note('Angehalten – geschickte Pakete arbeitet n8n noch ab; „Fortsetzen“ prüft sie und macht weiter.');
          wake?.();
          save(true);
        }
        return json(200, { job: summary() });
      }
      if (p === 'resume' && req.method === 'POST') {
        if (job.status === 'pausiert') {
          job.status = 'laeuft';
          job.fails = 0;
          job.failSince = null;
          job.empty = 0;
          note('Fortgesetzt');
          save(true);
          wake?.();
          loop();
        }
        return json(200, { job: summary() });
      }
      if (p === '' && req.method === 'DELETE') {
        // läuft gerade etwas, räumt die Schleife selbst auf, sobald sie anhält
        if (running) {
          job.status = 'verworfen';
          wake?.();
        } else {
          job = null;
          file.write({ job: null });
        }
        return json(200, { job: null });
      }
      return json(404, { message: 'Unbekannt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}
