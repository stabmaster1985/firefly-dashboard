# Hinweise für die Arbeit an diesem Repo

Firefly Dashboard: Node 22 (ESM, ohne Framework), Oberfläche in `public/` (deutsch), Server in
`server.js` + `lib/`. Firefly wird nur gelesen; Änderungen laufen ausschließlich über n8n-Automationen.
Demo ohne echte Firefly-Instanz: `npm run demo` (http://localhost:8080, Demo-API in `mock/`).

## Screenshots in der README aktuell halten

Die Bilder in `docs/screenshots/` gehören zur README. **Ändert sich eine Seite sichtbar, die auf
einem Bild zu sehen ist, die Bilder im selben Commit neu erzeugen:**

```sh
npm run screenshots   # Playwright mit Chromium nötig; sonst PLAYWRIGHT_MODULE=/pfad/zu/playwright/index.mjs
```

Das Skript (`scripts/screenshots.mjs`) startet die Demo auf eigenen Ports mit dem Stand aus
`mock/demo-data/` und erzeugt alle Bilder neu. Danach jedes geänderte Bild ansehen, bevor es
committet wird.

| Bild | Seite / Bereich |
|---|---|
| `uebersicht.png` | Übersicht (`#/`) |
| `kategorien.png` | Kategorien |
| `haendler.png` | Händler |
| `jahresrueckblick.png` | Jahresrückblick |
| `fragen.png` | Fragen |
| `labor.png` | Labor, Reiter „Übersicht“ |
| `labor-ki.png` | Labor, Reiter „KI“ (Vorschläge prüfen) |
| `csv-abgleich.png` | CSV-Abgleich (Archiv) |
| `aufraeumen.png` | Daten aufräumen (Gegenkonten zusammenführen) |
| `handy.png` | Handy: Übersicht hell, Labor dunkel |

Gemeinsame Teile (Farben, Menü, Kopfzeile, Karten, Kennzahl-Kacheln) erscheinen auf allen Bildern –
bei Änderungen daran alle neu erzeugen. Kommt eine neue Seite in die README, Bild im Skript
ergänzen und diese Tabelle erweitern.

**Nur Demo-Daten.** Das Repo ist öffentlich: keine echten Finanzdaten, Import-Konfigurationen,
IP-Adressen oder Zugangsdaten in Bildern, `mock/demo-data/` oder sonstigen Dateien.

## Sonst

- Nach Änderungen an Dateien in `public/` die Version in `public/sw.js` (`VERSION`) erhöhen,
  damit installierte Apps die neue Oberfläche laden.
- Prüfen in der Demo, auch am Handy (390 px) und im dunklen Modus.
