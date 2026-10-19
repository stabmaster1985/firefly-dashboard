# Firefly Dashboard

Ein modernes, schreibgeschütztes Web-Dashboard für [Firefly III](https://www.firefly-iii.org/) –
als frischere Alternative zur Standardoberfläche, wenn du deine Finanzen einfach nur **anschauen** willst.

- **Übersicht** – Nettovermögen, Einnahmen, Ausgaben, Saldo & Sparquote, Cashflow der letzten
  12 Monate, Ausgaben nach Kategorie, Budgets, letzte Buchungen und demnächst fällige Verträge
- **Buchungen** – Liste mit Volltextsuche (inkl. Firefly-Suchoperatoren wie
  `category_is:"Lebensmittel"` oder `amount_more:100`), Filter nach Art, Details per Klick
- **Konten** – Kontostände und Verlauf als Liniendiagramm, Verbindlichkeiten
- **Budgets** – Fortschritt je Budget mit Tagesmarkierung („bin ich im Plan?“) und Tagesrest
- **Sparziele** – Sparschweine mit Fortschritt und nötiger Monatsrate bis zum Zieldatum
- **Verträge** – Fixkosten pro Monat/Jahr, Status (bezahlt/offen/überfällig), nächste Fälligkeit
- Zeitraumwahl (Monat, Quartal, Jahr …), Hell-/Dunkelmodus, optimiert fürs Handy

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
