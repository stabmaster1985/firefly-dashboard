# Firefly Dashboard

Ein modernes, schreibgeschütztes Web-Dashboard für [Firefly III](https://www.firefly-iii.org/) –
als frischere Alternative zur Standardoberfläche, wenn du deine Finanzen einfach nur **anschauen** willst.

- **Übersicht** – Nettovermögen, Einnahmen und Ausgaben mit Vergleich zur Vorperiode, Saldo &
  Sparquote, Cashflow der letzten 12 Monate, Ausgaben nach Kategorie, größte Veränderungen je
  Kategorie und letzte Buchungen
- **Kategorien** – die Analyse-Seite für Ausgaben und Einnahmen:
  - Vergleichstabelle (sortierbar) mit Betrag, Anteil, Vorperiode, Veränderung, Ø pro Monat und
    Mini-Verlauf je Kategorie
  - Top 5 im Monatsverlauf als gestapeltes Diagramm
  - Monatsmatrix (Kategorien × Monate) als Heatmap mit Summen und Durchschnitt
  - Hinweis, wie viel noch „Ohne Kategorie“ ist
- **Tags** – dieselbe Analyse (Vergleich, Matrix, Detailseite) nach Tags, z. B. „Urlaub 2026“
  quer über alle Kategorien
- **Wiederkehrend** – erkennt regelmäßige Zahlungen (Abos, Versicherungen, Miete …) automatisch
  aus den Buchungen der letzten 24 Monate: Rhythmus, typischer Betrag, Kosten pro Jahr,
  nächste erwartete Zahlung, vermutlich beendete Verträge
- **Prognose** (Schalter oben rechts, standardmäßig aus) – Hochrechnung bis zum Ende des
  laufenden Zeitraums. Gerechnet wird mit dem, was in den Vormonaten im restlichen Teil des
  Monats typischerweise noch dazukam – bereits gebuchte Fixkosten wie die Miete werden also
  nicht doppelt hochgerechnet
- **Auffällige Monate** – in Matrix und Detailseite markiert, wenn ein Monat mindestens 50 %
  über dem üblichen Monat der Kategorie liegt
- **Filter überall** – Listen und Tabellen haben ein eigenes Filterfeld; auf den Analyse-Seiten
  zusätzlich eine Auswahl mit Häkchen, um gezielt einzelne Kategorien/Tags zu vergleichen
- **Kategorie-Detail** – Monatsverlauf mit Durchschnittslinie, Spitzenmonat, Anzahl und Ø pro
  Buchung, Top-Empfänger und alle Buchungen der Kategorie (nach Datum oder Betrag)
- **Buchungen** – Liste mit Kategorie-Filter und Volltextsuche (inkl. Firefly-Suchoperatoren wie
  `category_is:"Lebensmittel"` oder `amount_more:100`), Filter nach Art, Details per Klick
- **Konten** – Kontostände und Verlauf als Liniendiagramm, Verbindlichkeiten
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

## Wie es funktioniert

Ein kleiner Node.js-Server (ohne Framework) liefert die Oberfläche aus und reicht API-Anfragen an
Firefly III weiter. Dadurch

- bleibt dein **Access Token auf dem Server** und landet nie im Browser,
- gibt es keine CORS-Probleme,
- ist der Zugriff **nur lesend**: Der Server lässt ausschließlich `GET`-Anfragen auf eine
  feste Liste von Endpunkten durch – das Dashboard kann nichts in Firefly verändern.

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
docker run -d --name firefly-dashboard -p 8080:8080 --env-file .env firefly-dashboard
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
| `CACHE_SECONDS` | nein | Zwischenspeicher für API-Antworten (Standard 60, „Neu laden“ umgeht ihn) |

## Hinweise

- Der Kontostand-Verlauf nutzt Fireflys Diagramm-Endpunkt; er zeigt die Konten, die in Firefly
  für die Startseite ausgewählt sind (*Optionen → Einstellungen → Konten auf der Startseite*).
- Bei mehreren Währungen werden Summen in der jeweils häufigsten Währung angezeigt.
- Getestet mit der Firefly-III-API v6.
