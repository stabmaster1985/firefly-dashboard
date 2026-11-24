// „Nur im Dashboard“: Was liegt nur in DATA_DIR und nicht in Firefly – was wäre nach einer Neuinstallation
// (leeres DATA_DIR) weg bzw. neu einzurichten? Dazu Sicherung herunterladen und wiederherstellen.
//
//   GET  /local/nurdashboard              Bestandsaufnahme (Zahlen, Listen, je Punkt was passiert)
//   GET  /local/nurdashboard?sicherung=1  alle Dashboard-Daten als eine JSON-Datei (inkl. CSV-Archiv)
//   POST /local/nurdashboard              Sicherung wiederherstellen (vorher wird der jetzige Stand aufgehoben),
//                                         danach Neustart des Servers (Docker startet ihn wieder)

import fs from 'node:fs';
import path from 'node:path';

const MAX_RESTORE = 200 * 1024 * 1024;
// Nicht in die Sicherung: Zwischenspeicher, Laufzeit-Zustand, Anmeldegeheimnis
const SKIP = new Set(['session-secret', 'sync-job.json', 'import-report.json', 'cache-dirty.json']);
const NAME = /^[a-z0-9][a-z0-9._-]*\.json$/i;
const CSV_NAME = /^[^/\\]+$/;

export function createLocalState({ dataDir, view, autocat, log = console.log }) {
  const read = (name, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    } catch {
      return fallback;
    }
  };
  const archiveDir = path.join(dataDir, 'csv-archive');
  const csvFiles = () => {
    try {
      return fs.readdirSync(archiveDir).filter((f) => fs.statSync(path.join(archiveDir, f)).isFile());
    } catch {
      return [];
    }
  };
  const jsonFiles = () => {
    try {
      return fs.readdirSync(dataDir).filter((f) => NAME.test(f) && !SKIP.has(f) && fs.statSync(path.join(dataDir, f)).isFile());
    } catch {
      return [];
    }
  };

  async function inventory() {
    const stats = await view.localStats().catch((err) => ({ fehler: err.message }));
    // Zuordnungen je Händler: schon als Firefly-Regel übertragen (und unverändert)?
    const assign = autocat.assignments() || {};
    const ff = new Map(autocat.ffList().map((f) => [f.key, f]));
    const same = (a, f) => f?.sentAt && Boolean(f.keep) === Boolean(a.keep)
      && f.category === (a.keep ? '' : a.category) && JSON.stringify(f.split || []) === JSON.stringify(a.split || []);
    const assigned = Object.entries(assign).map(([key, a]) => ({ key, name: a.name || key, category: a.keep ? '' : a.category, split: (a.split || []).length, inFirefly: Boolean(same(a, ff.get(key))) }));
    const merges = autocat.merges();
    const excludedRules = read('excluded.json', { rules: [] }).rules || [];
    const rules = read('rules.json', { rules: [], autoTags: [] });
    const groups = read('groups.json', { groups: [], trash: [] });
    const byStatus = {};
    for (const g of groups.groups || []) byStatus[g.status || 'offen'] = (byStatus[g.status || 'offen'] || 0) + 1;
    const ai = read('ai-labels.json', { labels: {} });
    const actions = read('actions.json', []);
    const goals = read('goals.json', { goals: {} });
    const settings = read('settings.json', {});
    const mqtt = read('mqtt.json', { topics: [] });
    const recurring = read('recurring.json', { hidden: [], manual: [], vertraege: {} });
    const dismissed = read('dismissed.json', {});
    const csvSync = read('csv-sync.json', { rows: {} });
    const importConfig = read('import-config.json', { config: null });
    const cleanupImport = read('cleanup-import.json', { plan: null, items: {} });
    const cleanupMerge = read('cleanup-merge.json', { groups: {} });
    const files = csvFiles();
    const csvBytes = files.reduce((a, f) => a + (fs.statSync(path.join(archiveDir, f)).size || 0), 0);
    const actionList = Array.isArray(actions) ? actions : actions.actions || [];
    return {
      erstellt: new Date().toISOString(),
      auswertung: stats,
      zuordnungen: { gesamt: assigned.length, nichtInFirefly: assigned.filter((a) => !a.inFirefly).slice(0, 200), inFirefly: assigned.filter((a) => a.inFirefly).length },
      einzeln: Object.keys(autocat.txAssignments() || {}).length,
      zusammenfuehrungen: merges.map((m) => ({ von: m.from, nach: m.to, inFirefly: Boolean(m.sentAt) })),
      ausgeblendet: { buchungen: excludedRules.filter((r) => r.art === 'buchung').length, gegenkonten: excludedRules.filter((r) => r.art === 'gegenkonto').map((r) => r.name).slice(0, 50) },
      laborRegeln: { regeln: (rules.rules || []).length, autoTags: (rules.autoTags || []).length },
      gruppen: { anzahl: (groups.groups || []).length, status: byStatus, papierkorb: (groups.trash || []).length },
      ki: { bewertungen: Object.keys(ai.labels || {}).length },
      automationen: actionList.map((a) => ({ name: a.name, trigger: a.trigger })),
      ziele: Object.keys(goals.goals || {}).length,
      einstellungen: Object.keys(settings).length,
      mqtt: (mqtt.topics || []).length,
      wiederkehrend: { ausgeblendet: (recurring.hidden || []).length, eigene: (recurring.manual || []).length, vertraege: Object.keys(recurring.vertraege || {}).length },
      gemerkt: Object.fromEntries(Object.entries(dismissed).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
      csv: { dateien: files.length, bytes: csvBytes, uebertrageneZeilen: Object.keys(csvSync.rows || {}).length },
      aufraeumen: { importKonfiguration: Boolean(importConfig.config), importPlan: Object.keys(cleanupImport.items || {}).length, kontenGruppen: Object.keys(cleanupMerge.groups || {}).length },
      dateien: jsonFiles(),
    };
  }

  function backup() {
    const out = { art: 'firefly-dashboard-sicherung', version: 1, erstellt: new Date().toISOString(), dateien: {}, csv: {} };
    for (const f of jsonFiles()) {
      try {
        out.dateien[f] = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
      } catch {
        // unlesbare Datei auslassen (der Server nutzt dann ohnehin .bak)
      }
    }
    for (const f of csvFiles()) out.csv[f] = fs.readFileSync(path.join(archiveDir, f)).toString('base64');
    return out;
  }

  function restore(data) {
    if (data?.art !== 'firefly-dashboard-sicherung' || typeof data.dateien !== 'object') throw new Error('Das ist keine Sicherung des Firefly Dashboards.');
    const names = Object.keys(data.dateien).filter((f) => NAME.test(f) && !SKIP.has(f));
    const csv = Object.keys(data.csv || {}).filter((f) => CSV_NAME.test(f) && f !== '.' && f !== '..');
    if (!names.length) throw new Error('Die Sicherung enthält keine Dateien.');
    // jetzigen Stand aufheben
    const keep = path.join(dataDir, 'backups', `vor-wiederherstellung-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(keep, { recursive: true });
    for (const f of jsonFiles()) fs.copyFileSync(path.join(dataDir, f), path.join(keep, f));
    for (const f of names) {
      const tmp = path.join(dataDir, `${f}.tmp-restore`);
      fs.writeFileSync(tmp, JSON.stringify(data.dateien[f], null, 2));
      fs.renameSync(tmp, path.join(dataDir, f));
    }
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const f of csv) fs.writeFileSync(path.join(archiveDir, f), Buffer.from(String(data.csv[f]), 'base64'));
    log(`Sicherung wiederhergestellt: ${names.length} Dateien, ${csv.length} CSV-Dateien (vorheriger Stand in ${path.relative(dataDir, keep)})`);
    return { dateien: names.length, csv: csv.length, vorher: path.relative(dataDir, keep) };
  }

  const inDocker = fs.existsSync('/.dockerenv');

  return async function handle(req, res, url) {
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    try {
      if (req.method === 'GET' && url.searchParams.get('sicherung') === '1') {
        const day = new Date().toISOString().slice(0, 10);
        return json(200, backup(), { 'Content-Disposition': `attachment; filename="firefly-dashboard-sicherung-${day}.json"` });
      }
      if (req.method === 'GET') return json(200, { ...(await inventory()), neustartMoeglich: inDocker });
      if (req.method !== 'POST') return json(405, { message: 'Nicht erlaubt.' });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_RESTORE) return json(413, { message: 'Die Sicherung ist zu groß.' });
        chunks.push(c);
      }
      const result = restore(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // Viele Module halten ihren Stand im Speicher – nach dem Zurückspielen neu starten (Docker: restart unless-stopped)
      json(200, { ok: true, ...result, neustart: inDocker });
      if (inDocker) setTimeout(() => process.exit(0), 800);
      return undefined;
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}
