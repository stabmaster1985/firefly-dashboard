// Sicheres Speichern der eigenen Daten (DATA_DIR) als JSON-Dateien.
//
//  - Schreiben über eine temporäre Datei und Umbenennen (nie halb geschrieben)
//  - <datei>.bak enthält immer den zuletzt geschriebenen Stand (falls die Datei leidet)
//  - optional ein Schnappschuss pro Tag in DATA_DIR/backups (14 Tage)
//  - eine unlesbare Datei wird nie stillschweigend überschrieben: Es wird der
//    .bak-Stand gelesen, die kaputte Datei als <datei>.broken-<zeit> aufbewahrt

import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 14;

export function jsonFile(file, fallback, { snapshots = false, log = console.log } = {}) {
  const parse = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const withDefaults = (data) => (Array.isArray(fallback) ? data : { ...structuredClone(fallback), ...data });

  function read() {
    try {
      return withDefaults(parse(file));
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(fallback);
      // beschädigt: Kopie aufheben, auf den letzten guten Stand ausweichen
      const broken = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        if (!fs.existsSync(`${file}.broken-latest`)) fs.copyFileSync(file, broken);
        fs.writeFileSync(`${file}.broken-latest`, broken);
      } catch {
        // Kopie nicht möglich – trotzdem weiter mit .bak
      }
      log(`Warnung: ${path.basename(file)} ist nicht lesbar (${err.message}) – verwende Sicherung.`);
      try {
        return withDefaults(parse(`${file}.bak`));
      } catch {
        return structuredClone(fallback);
      }
    }
  }

  function snapshot() {
    const dir = path.join(path.dirname(file), 'backups');
    const day = new Date().toISOString().slice(0, 10);
    const name = path.basename(file, '.json');
    const target = path.join(dir, `${name}-${day}.json`);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, target);
    // alte Schnappschüsse dieser Datei aufräumen
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.json')).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_DAYS))) fs.rmSync(path.join(dir, old), { force: true });
  }

  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Tages-Schnappschuss vom bisherigen Stand (nur wenn der lesbar ist)
    if (snapshots && fs.existsSync(file)) {
      try {
        parse(file);
        snapshot();
      } catch {
        // kaputt – keinen kaputten Schnappschuss anlegen
      }
    }
    const body = JSON.stringify(data, null, 2);
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
    // .bak = immer der zuletzt geschriebene, gute Stand
    fs.writeFileSync(`${file}.bak.tmp`, body);
    fs.renameSync(`${file}.bak.tmp`, `${file}.bak`);
    try {
      fs.rmSync(`${file}.broken-latest`, { force: true });
    } catch {
      // egal
    }
  }

  return { read, write };
}
