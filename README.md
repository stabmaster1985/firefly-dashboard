# Firefly Dashboard

Ein modernes, schreibgeschütztes Web-Dashboard für [Firefly III](https://www.firefly-iii.org/) –
als frischere Alternative zur Standardoberfläche, wenn du deine Finanzen einfach nur **anschauen** willst.

- **Übersicht** – Nettovermögen, Einnahmen und Ausgaben mit Vergleich zur Vorperiode, Saldo &
  Sparquote, Cashflow der letzten 12 Monate, **Geldfluss-Diagramm** (Einnahmen → Ausgaben →
  Gespart), Ausgaben nach Kategorie, größte Veränderungen je Kategorie und letzte Buchungen
- **Kategorien** – die Analyse-Seite für Ausgaben und Einnahmen:
  - Vergleichstabelle (sortierbar) mit Betrag, Anteil, Vorperiode, Veränderung, Ø pro Monat und
    Mini-Verlauf je Kategorie
  - Top 5 im Monatsverlauf als gestapeltes Diagramm
  - Monatsmatrix (Kategorien × Monate) als Heatmap mit Summen und Durchschnitt
  - Verteilung: Anteils-Leiste, Ausgaben nach Wochentag und nach Betragshöhe
  - Hinweis, wie viel noch „Ohne Kategorie“ ist
- **Tags** – dieselbe Analyse (Vergleich, Matrix, Detailseite) nach Tags, z. B. „Urlaub 2026“
  quer über alle Kategorien
- **Wiederkehrend** – erkennt regelmäßige Zahlungen (Abos, Versicherungen, Miete …) automatisch
  aus den Buchungen der letzten 24 Monate: Rhythmus, typischer Betrag, Kosten pro Jahr,
  nächste erwartete Zahlung, vermutlich beendete Verträge. Erkennt auch Abos, die über PayPal
  & Co. laufen; Empfindlichkeit Streng/Normal/Locker umschaltbar
- **Prognose** (Schalter oben rechts, standardmäßig aus) – Hochrechnung bis zum Ende des
  laufenden Zeitraums, auf der Übersicht zusätzlich **im Detail**: die einzelnen erwarteten
  Termine (aus den wiederkehrenden Zahlungen) und die geschätzten weiteren Ausgaben je Kategorie. Gerechnet wird mit dem, was in den Vormonaten im restlichen Teil des
  Monats typischerweise noch dazukam – bereits gebuchte Fixkosten wie die Miete werden also
  nicht doppelt hochgerechnet
- **Auffällige Monate** – in Matrix und Detailseite markiert, wenn ein Monat mindestens 50 %
  über dem üblichen Monat der Kategorie liegt
- **Filter überall** – Listen und Tabellen haben ein eigenes Filterfeld; auf den Analyse-Seiten
  zusätzlich eine Auswahl mit Häkchen, um gezielt einzelne Kategorien/Tags zu vergleichen
- **Klick auf einen Balken** (Top-5-Verlauf, Monatsverlauf der Detailseite) oder ein
  **Matrixfeld** klappt direkt darunter die Buchungen dieses Monats auf – sortierbar, filterbar,
  mit Link in Firefly. Im gestapelten Diagramm zeigt ein Segment nur diese Kategorie, ein Klick
  neben die Segmente alle Kategorien des Monats
- **Kategorie-Detail** – Monatsverlauf mit Durchschnittslinie, Spitzenmonat, Anzahl und Ø pro
  Buchung, Top-Empfänger und alle Buchungen der Kategorie (nach Datum oder Betrag)
- **Buchungen** – Liste mit Kategorie-Filter und Volltextsuche (inkl. Firefly-Suchoperatoren wie
  `category_is:"Lebensmittel"` oder `amount_more:100`), Filter nach Art, Details per Klick
- **Konten** – Kontostände und Verlauf als Liniendiagramm, Verbindlichkeiten; Klick auf ein
  Konto öffnet die **Kontoseite** mit Saldo-Verlauf, Ein-/Ausgängen je Monat, Verteilung nach
  Kategorie und allen Buchungen (Details per Klick)
- **Automationen** – eigene Knöpfe für Webhooks, z. B. **n8n-Workflows**: in der Oberfläche
  anlegen (URL, Methode, Header, Body mit Platzhaltern wie `{{start}}`/`{{end}}`), testen und
  per Klick starten; Antwort und letzter Lauf werden angezeigt
- **Suche** (Taste `/` oder Strg+K) – findet Kategorien, Empfänger, Zahler und Konten; Enter
  springt direkt hin, sonst Volltextsuche in den Buchungen
- **Zeitraum** – Vorgaben (Monat, Quartal, Jahr …) oder ein **eigener Zeitraum** von–bis
- **Vergleich** wahlweise mit der Vorperiode oder dem **Vorjahr**
- **Monatsmatrix** – Feld anklicken zeigt die Buchungen dieser Kategorie in diesem Monat;
  Kategorien lassen sich filtern (mehrere mit Komma, z. B. `lebens, restaurant`) und zusammen
  auswerten; Tabelle und Matrix als **CSV-Export** für Excel
- Hell-/Dunkelmodus, optimiert fürs Handy

Der Vergleich mit der Vorperiode ist fair: Läuft der gewählte Zeitraum noch (z. B. „Dieser
Monat“ am 19.), wird mit demselben Abschnitt davor verglichen (1.–19. des Vormonats).

## Automationen (n8n)

1. In n8n einen Workflow mit einem **Webhook**-Knoten beginnen (Methode POST), die
   **Production URL** kopieren und den Workflow aktivieren.
2. Im Dashboard unter **Automationen → + Neue Automation** Name und URL eintragen.
3. Optional einen Header für die Absicherung setzen (in n8n: Webhook → Authentication →
   Header Auth) und den Body anpassen. Platzhalter: `{{start}}`, `{{end}}` (gewählter Zeitraum,
   JJJJ-MM-TT), `{{period}}` (Bezeichnung), `{{now}}`, `{{action}}`.
4. **Testen**, **Speichern** – danach startet der Knopf den Workflow.

Die Konfiguration speichert der Server in `DATA_DIR/actions.json` (im Container `/data`).
Der Aufruf geht vom Dashboard-Server aus, nicht vom Browser – die n8n-Adresse muss also vom
Server aus erreichbar sein (im selben Docker-Netz z. B. `http://n8n:5678/webhook/…`).

## Wie es funktioniert

Ein kleiner Node.js-Server (ohne Framework) liefert die Oberfläche aus und reicht API-Anfragen an
Firefly III weiter. Dadurch

- bleibt dein **Access Token auf dem Server** und landet nie im Browser,
- gibt es keine CORS-Probleme,
- ist der Zugriff auf Firefly **nur lesend**: Der Server lässt ausschließlich `GET`-Anfragen auf
  eine feste Liste von Endpunkten durch – das Dashboard kann nichts in Firefly verändern.
  Geschrieben wird nur die eigene Automationen-Datei.

## Einrichtung

Voraussetzung: Node.js ≥ 20.12 oder Docker.

1. In Firefly III einen Token erstellen: **Optionen → Profil → OAuth → Persönliche Zugangs-Tokens → Neuen Token erstellen**.
2. Konfiguration anlegen:
   ```bash
   cp .env.example .env
   # FIREFLY_URL und FIREFLY_TOKEN eintragen, am besten auch DASHBOARD_PASSWORD
   ```
3. Starten:
   ```bash
   npm install
   npm start
   ```
4. <http://localhost:8080> öffnen.

### Mit Docker

```bash
docker build -t firefly-dashboard .
docker run -d --name firefly-dashboard -p 8080:8080 --env-file .env \
  -v firefly-dashboard-data:/data firefly-dashboard
```

Oder in deiner bestehenden `docker-compose.yml` neben Firefly:

```yaml
  firefly-dashboard:
    build: ./firefly-dashboard
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      FIREFLY_URL: http://app:8080            # interner Name des Firefly-Containers
      FIREFLY_PUBLIC_URL: https://firefly.example.com
      FIREFLY_TOKEN: ${FIREFLY_TOKEN}
      DASHBOARD_USER: ich
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}
    volumes:
      - firefly-dashboard-data:/data   # gespeicherte Automationen

volumes:
  firefly-dashboard-data:
```

## Demo ohne eigene Firefly-Instanz

```bash
npm install
npm run demo
```

Startet eine simulierte Firefly-API mit erfundenen Beispieldaten (Port 8090) plus das Dashboard
auf <http://localhost:8080>.

## Konfiguration

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `FIREFLY_URL` | ja | Adresse der Firefly-III-Instanz |
| `FIREFLY_TOKEN` | ja | Personal Access Token |
| `PORT` / `HOST` | nein | Adresse des Dashboards (Standard `0.0.0.0:8080`) |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | nein | Passwortschutz per HTTP Basic Auth – **empfohlen**, sobald das Dashboard nicht nur lokal läuft |
| `FIREFLY_PUBLIC_URL` | nein | Basis für „In Firefly öffnen“-Links |
| `CACHE_SECONDS` | nein | Gültigkeit für Daten des laufenden Zeitraums (Standard 60 s; danach wird sofort die letzte Antwort gezeigt und im Hintergrund erneuert) |
| `CACHE_HISTORY_HOURS` | nein | Gültigkeit für abgeschlossene Zeiträume (Standard 12 h) |
| `WARM_MINUTES` | nein | Vorwärmen alle N Minuten (Standard 10, `0` = aus) |
| `FIREFLY_CONCURRENCY` | nein | Höchstzahl gleichzeitiger Anfragen an Firefly (Standard 4) |
| `DATA_DIR` | nein | Ablage für Automationen (Standard `./data`, im Docker-Image `/data`) |

## Geschwindigkeit

Firefly III braucht pro Abfrage oft mehrere hundert Millisekunden und bearbeitet nur wenige
gleichzeitig. Das Dashboard gleicht das aus:

- **Zwischenspeicher mit Gedächtnis:** Abgeschlossene Monate ändern sich kaum und bleiben 12 h
  gültig, der laufende Zeitraum 60 s. Ist ein Eintrag abgelaufen, wird trotzdem sofort die
  letzte Antwort gezeigt und im Hintergrund erneuert.
- **Vorwärmen:** Beim Start und alle 10 Minuten lädt der Server die üblichen Daten (letzte
  13 Monate, Konten, Kategorien, Buchungen für „Wiederkehrend“) selbst vor.
- **Weniger und leichtere Abfragen:** gleiche Anfragen laufen nur einmal, große Listen in
  250er-Paketen, Antworten komprimiert, im Browser 3 Minuten gemerkt.
- Unten in der Seitenleiste steht die Antwortzeit von Firefly und die Trefferquote des
  Zwischenspeichers (Maus darüber zeigt die langsamsten Abfragen).

**Neu laden** (Pfeil oben rechts) holt alles frisch aus Firefly – z. B. nachdem du in Firefly
alte Buchungen umkategorisiert hast, denn abgeschlossene Monate werden sonst bis zu 12 h aus
dem Zwischenspeicher gezeigt.

## Hinweise

- Der Kontostand-Verlauf nutzt Fireflys Diagramm-Endpunkt; er zeigt die Konten, die in Firefly
  für die Startseite ausgewählt sind (*Optionen → Einstellungen → Konten auf der Startseite*).
- Bei mehreren Währungen werden Summen in der jeweils häufigsten Währung angezeigt.
- Getestet mit der Firefly-III-API v6.
