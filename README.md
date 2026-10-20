# Firefly Dashboard

Ein modernes, schreibgeschütztes Web-Dashboard für [Firefly III](https://www.firefly-iii.org/) –
als frischere Alternative zur Standardoberfläche, wenn du deine Finanzen einfach nur **anschauen** willst.

- **Übersicht** – Nettovermögen, Einnahmen und Ausgaben mit Vergleich zur Vorperiode, Saldo &
  Sparquote, Cashflow der letzten 12 Monate, **Geldfluss-Diagramm** (Einnahmen → Ausgaben →
  Gespart; Klick auf einen Block oder ein Band zeigt die Buchungen dazu, mit Sprung zur Analyse
  oder ins Labor), Ausgaben nach Kategorie, größte Veränderungen je Kategorie und letzte Buchungen
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
- **Buchungsdetails überall** – jede Buchung in jeder Liste (Übersicht, Buchungen, Kategorien,
  Monats-Drilldown, Kategorisierungshilfe, Kontoseite, Labor, Jahresrückblick) klappt per Klick
  auf: Datum, Art, Betrag, Von/An mit IBAN, Kategorie, Budget, Rechnung, Tags, Notizen, Referenzen,
  SEPA-Angaben und ID – dazu **In Firefly öffnen** und **In Firefly bearbeiten**. Konten und
  Kategorien darin sind verlinkt
- **Kategorie und Tags direkt ändern** – in den Buchungsdetails Kategorie setzen sowie Tags
  hinzufügen/entfernen; das Dashboard startet dafür einen n8n-Workflow (Vorlage
  `n8n/firefly-buchung-bearbeiten.json`), der die Änderung über die Firefly-API speichert
- **Kategorie-Detail** – Monatsverlauf mit Durchschnittslinie, Spitzenmonat, Anzahl und Ø pro
  Buchung, Top-Empfänger und alle Buchungen der Kategorie (nach Datum oder Betrag)
- **Buchungen** – Liste mit Kategorie-Filter und Volltextsuche (inkl. Firefly-Suchoperatoren wie
  `category_is:"Lebensmittel"`, `amount_more:100`, `description_contains:`, `notes_contains:`),
  Filter nach Art, Details per Klick. Treffer lassen sich anhaken (auch alle auf einmal und über
  mehrere Suchen hinweg) und gesammelt bearbeiten: **Kategorie setzen**, **Tag hinzufügen** (über
  n8n) oder **Als Gruppe ins Labor** – das funktioniert auch für Buchungen, die älter als die
  24 Monate des Labors sind (die Gruppe merkt sich, wo sie in Firefly liegen)
- **Konten** – Kontostände und Verlauf als Liniendiagramm, **Vermögensverlauf** über 1–10 Jahre
  (Monatsendstände, Veränderung, Ø pro Monat, Höchststand), Verbindlichkeiten; Klick auf ein
  Konto öffnet die **Kontoseite** mit Saldo-Verlauf, Ein-/Ausgängen je Monat, Verteilung nach
  Kategorie und allen Buchungen (Details per Klick)
- **Ziele je Kategorie** – Monatsziel direkt im Dashboard festlegen (unabhängig von
  Firefly-Budgets): Fortschritt in der Übersicht, Spalte in der Kategorien-Tabelle, Markierung
  in der Matrix und Ziel-Linie im Monatsverlauf; mit Prognose auch „wird knapp“
- **Hinweise** – große Ausgaben, Abos mit neuem Betrag, ausgebliebene Zahlungen und Buchungen
  ohne Kategorie auf einen Blick
- **Kategorisierungshilfe** – für Buchungen „Ohne Kategorie“ ein Vorschlag aus ähnlichen
  früheren Buchungen; per Klick an n8n übergeben oder direkt in Firefly öffnen
- **Kategorien-Labor** – alle Buchungen (24 Monate) probeweise neu kategorisieren und taggen,
  ohne Firefly anzufassen: eigene Regeln („Empfänger enthält REWE → Lebensmittel“, Betrag
  zwischen …, Tags), automatische Tags (Abo, Online, Bargeld, Wochenende, große Ausgabe,
  Kleinbetrag) und Regel-Vorschläge aus deinen Daten (uneinheitlich kategorisierte Empfänger,
  Buchungen ohne Kategorie, bekannte Händler; Zahlungsdienste wie PayPal nach Buchungstext).
  Vorher/Nachher je Kategorie, Auswertung nach Tags, Export als **Firefly-Regeln** (JSON),
  CSV oder Übergabe an n8n. Mit **In Firefly anlegen** werden die Regeln per n8n als echte
  Firefly-Regeln in einer eigenen Regelgruppe angelegt und abgeglichen (geänderte Regeln
  aktualisiert, im Labor gelöschte entfernt) – auf Wunsch gleich auf alle vorhandenen Buchungen
  angewendet. Danach kategorisiert Firefly neue Buchungen beim Import selbst
  - **Tags & Kategorien-Struktur** (rein lokal, ohne KI): schlägt Tags für Themen vor, die im
    Verwendungszweck bei mehreren Empfängern auftauchen (z. B. „Kita“), erkennt Reisen (mehrere
    sonst unbekannte Händler in wenigen Tagen → „Reise Riva 2026“) und schlägt vor, Kategorien
    zusammenzufassen (ähnliche Namen wie „KFZ“/„Auto“, gemeinsame Empfänger, sehr kleine
    Kategorien) oder aufzuteilen (z. B. „Shopping“ in Elektronik, Kleidung, Wohnen …). Jeder
    Vorschlag zeigt die betroffenen Buchungen und wird per „Übernehmen“ zu Labor-Regeln;
    Regeln können dafür auch ein Datum (zwischen) enthalten
  - **Kategorie/Tag schnell setzen** – Buchungen anhaken, in der Leiste unten Kategorie „Setzen“
    bzw. Tag „Hinzufügen“: legt eine Gruppe mit diesem Namen an (oder ergänzt sie) und übernimmt
    sie gleich als Labor-Regel; nach Firefly geht es über „Nach Firefly übertragen“ in der Gruppe
  - **Gruppen** – Buchungen selbst zusammenstellen (Häkchen in allen Labor-Listen oder „Als Gruppe
    bearbeiten“ bei einem Vorschlag), Namen und Art (Kategorie/Tag) frei wählen und mit
    **„Ähnliche finden“** schrittweise erweitern: gleiche Empfänger, seltene gemeinsame Wörter im
    Verwendungszweck, ähnliche Beträge – jeweils mit Begründung, sehr ähnliche schon angehakt.
    Was nicht passt, als „gehört nicht dazu“ markieren; das verbessert die nächste Suche. Zum
    Schluss bildet das Labor daraus möglichst wenige Regeln, die keine Buchung außerhalb der
    Gruppe treffen (dauerhaft, auch für künftige Buchungen); der Rest wird einmalig gesetzt.
    Gruppen werden Schritt für Schritt auf dem Server gespeichert – über Tage, Geräte und
    Updates hinweg; gelöschte liegen 30 Tage im Papierkorb. **„Nach Firefly übertragen“** überträgt
    nur diese eine Gruppe: ihre Regeln landen in einer eigenen Firefly-Regelgruppe
    („Dashboard: <Name>“, auch nach Umbenennen wiedergefunden), werden auf Wunsch auf alle
    vorhandenen Buchungen bzw. die letzten 24 Monate angewendet, und die einzelnen Buchungen
    werden direkt gesetzt. Erneutes Übertragen aktualisiert die Regeln statt sie zu verdoppeln
  - **Einschränken** – Zeitraum, Konto, Kategorie, Suchtext und Betrag grenzen alles im Labor ein
    (Fortschritt, Vorschläge, Buchungen, „Ähnliche finden“, Übergabe an n8n); Regeln aus Gruppen
    werden trotzdem gegen alle Buchungen geprüft, damit sie außerhalb keine Fehltreffer erzeugen
  - **Fortschritt** – zeigt, was schon erledigt ist (in einer Gruppe, von einer Labor-Regel erfasst
    oder als **„passt so“** markiert) und was noch offen ist, aufgeteilt nach Kategorie oder
    Empfänger; Klick filtert die Buchungsliste auf genau diese offenen Buchungen. „Passt so“ geht
    einzeln in der Zeile oder gesammelt (Häkchen bzw. „Alle angezeigten auswählen“). Die
    Gruppenliste filtert nach „Offen“, „Nicht in Firefly“ und „Geändert seit Übertragung"
- **Prüfen** – Datenqualität auf einen Blick:
  - **Import-Status je Konto**: letzte Buchung und üblicher Abstand; „überfällig“, wenn ein Konto
    deutlich länger als sonst keine Buchung hat (CSV-Import vergessen?). Eine Automation mit
    Auslöser **Import starten** (z. B. dein n8n-Workflow für die Bank-CSV) erscheint dort als Knopf
  - **Mögliche doppelte Buchungen**: gleiche Art, Betrag und Konten höchstens 3 Tage auseinander,
    eingestuft als sicher / wahrscheinlich / möglich; „Kein Duplikat“ blendet ein Paar aus
  - beides erscheint auch unter **Hinweise** in der Übersicht
- **Jahresrückblick** – Sparquote, Monat für Monat, Highlights, Kategorien im Vergleich zum
  Vorjahr, größte Ausgaben, Abo-Kosten pro Jahr und ein **Ausgaben-Kalender** (ein Feld pro
  Tag, je dunkler, desto mehr ausgegeben; Klick zeigt die Buchungen des Tages, dazu Ø pro Tag,
  Werktag vs. Wochenende und der teuerste Tag)
- **Empfänger-Seite** – alles zu einem Händler oder Zahler (z. B. „Amazon“): Ausgaben der letzten
  12 Monate im Vergleich zu davor, Monatsverlauf, Summe pro Jahr, Kategorien und alle Buchungen.
  Erreichbar über die Suche, „Top-Empfänger“ und die Buchungsdetails
- **Als App aufs Handy** – installierbar (Startbildschirm), startet sofort und zeigt ohne
  Verbindung die zuletzt geladenen Daten
- **Automationen** – eigene Knöpfe für Webhooks, z. B. **n8n-Workflows**: in der Oberfläche
  anlegen (URL, Methode, Header, Body mit Platzhaltern wie `{{start}}`/`{{end}}`), testen und
  per Klick starten; Antwort und letzter Lauf werden angezeigt
- **Suche** (Taste `/` oder Strg+K) – findet Kategorien, Empfänger, Zahler und Konten; Enter
  springt direkt hin, sonst Volltextsuche in den Buchungen
- **Zeitraum** – Kalendermonate (Monat, Quartal, Jahr …), **Gehaltsmonate** oder ein **eigener
  Zeitraum** von–bis. Ein Gehaltsmonat beginnt am Gehaltstag (Standard: 24., änderbar über
  „Gehaltstag ändern …“); fällt der aufs Wochenende, beginnt er am Freitag davor. Ist ein
  Gehaltsmonat gewählt, rechnen auch Matrix, Monatsverläufe, Vergleich und Prognose in
  Gehaltsmonaten – so lässt sich Gehaltsmonat mit Gehaltsmonat vergleichen
- **Vergleich** wahlweise mit der Vorperiode oder dem **Vorjahr**
- **Monatsmatrix** – Feld anklicken zeigt die Buchungen dieser Kategorie in diesem Monat;
  Kategorien lassen sich filtern (mehrere mit Komma, z. B. `lebens, restaurant`) und zusammen
  auswerten; Tabelle und Matrix als **CSV-Export** für Excel
- **Hilfe überall** – ein **?** an jeder Karte und oben rechts für die ganze Seite erklärt jeweils:
  wofür es da ist, was im Dashboard passiert und was (nicht) in Firefly passiert. Die Seite
  `#/hilfe` sammelt alle Themen mit Suche
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

**Auslöser** – jede Automation startet entweder per Knopf oder automatisch:

| Auslöser | Wann | Was n8n bekommt |
|---|---|---|
| Per Knopf | Klick auf „Ausführen“ | gewählter Zeitraum (`start`, `end`, `period`) |
| Monatsabschluss (Gehalts-/Kalendermonat) | sobald ein Monat abgeschlossen ist | Einnahmen, Ausgaben, Saldo, Sparquote, Vormonat, Kategorien mit Veränderung, Ziele, größte Buchungen, Auffälliges und einen fertigen Text (`text`) |
| Wochenrückblick | sonntags ab 18 Uhr (Serverzeit, ggf. `TZ=Europe/Berlin` setzen) für die Woche Mo–So | Ausgaben, Einnahmen, Vergleich mit dem Ø der letzten 8 Wochen, Kategorien, größte Ausgaben, Auffälliges, Buchungen ohne Kategorie, Stand der Ziele und einen fertigen mehrzeiligen Text (`text`) |
| Warnungen | bei jeder neuen Warnung (einmalig) | `art` (grosse_buchung, preisaenderung, ausgeblieben), `titel`, `text`, `details` |
| Kategorie übernehmen | Kategorie in den Buchungsdetails, „Übernehmen“ bei einem Vorschlag, Labor „Änderungen an n8n übergeben“ | `kategorie_setzen` bzw. `kategorien_uebernehmen` – siehe unten |
| Tags setzen | Tag in den Buchungsdetails hinzufügen/entfernen | `tags_setzen` mit kompletter neuer Tag-Liste |
| Firefly-Regeln anlegen | Labor „In Firefly anlegen“ | `regeln_anlegen`: Gruppe, Regeln im Firefly-Format, optional Zeitraum zum Anwenden |
| Import starten | Knopf auf der Seite „Prüfen“ | `konten_ueberfaellig` |
| Dashboard aktualisieren | Knopf „Jetzt aktualisieren“ unter Dashboard-Version | `von`, `auf` (Commits) |
| Firefly-Backup | Knopf „Jetzt sichern“ / Stand auf der Seite „Prüfen“ | `typ`: `backup` oder `status` – Antwort mit letzter Sicherung, Größe, Anzahl |

Body leer lassen = alle Daten als JSON; im Body-Text fügt `{{daten}}` sie ebenfalls ein. Mit
„Jetzt senden“ bzw. „Testen“ lässt sich das Ergebnis vorab ansehen. Gehaltstag und die Schwelle
für „große Ausgabe“ stehen oben auf der Seite Automationen. Der erste Monatsabschluss wird zum
nächsten Monatswechsel verschickt, bestehende Warnungen beim Einrichten nicht nachträglich.

Die Konfiguration speichert der Server in `DATA_DIR` (im Container `/data`): Automationen,
Ziele, Einstellungen und was bereits verschickt wurde.
Der Aufruf geht vom Dashboard-Server aus, nicht vom Browser – die n8n-Adresse muss also vom
Server aus erreichbar sein (im selben Docker-Netz z. B. `http://n8n:5678/webhook/…`).

### Deine Daten im Dashboard

Alles, was du im Dashboard selbst anlegst, liegt in `DATA_DIR` (Docker: Volume
`firefly-dashboard-data` → `/data`) und übersteht damit jedes Update:

| Datei | Inhalt |
|---|---|
| `groups.json` | Gruppen aus dem Kategorien-Labor (inkl. Papierkorb) |
| `rules.json` | Labor-Regeln und Auto-Tags |
| `dismissed.json` | ausgeblendete Vorschläge („Ignorieren“, „Kein Duplikat“) und „passt so“ |
| `actions.json` | Automationen |
| `goals.json`, `settings.json`, `state.json` | Ziele, Gehaltstag/Schwelle, was schon verschickt wurde |

Geschrieben wird immer über eine temporäre Datei; `<datei>.bak` enthält den zuletzt
geschriebenen Stand. Für Gruppen und Regeln legt der Server zusätzlich einen Schnappschuss pro
Tag in `DATA_DIR/backups` an (14 Tage). Ist eine Datei unlesbar, wird sie nicht überschrieben:
Der Server nutzt die Sicherung und bewahrt die kaputte Datei als `<datei>.broken-…` auf.
Gleichzeitiges Arbeiten auf mehreren Geräten überschreibt nichts: Gruppen werden in einzelnen
Schritten gespeichert, Regeln mit Versionsnummer (bei einem Konflikt lädt das Labor den neuen
Stand). Gruppen merken sich Buchungen über ihre feste Firefly-ID.

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

### Aktualisieren per n8n

`n8n/firefly-dashboard-update.json` ist ein fertiger n8n-Workflow, der das Dashboard auf dem
Docker-Host per SSH aktualisiert: Repository nach `~/firefly-diy` holen (beim ersten Lauf
klonen, danach `git pull`), neu bauen und starten (`docker compose up -d --build`), alte Images
aufräumen und prüfen, ob der Container läuft. Lokale Änderungen, z. B. Token und Passwort in der
`docker-compose.yml`, bleiben erhalten (`git pull --autostash`).

1. In n8n **Import from File** → `n8n/firefly-dashboard-update.json`.
2. Im Knoten **Update auf CT 114** eine SSH-Zugangsdaten anlegen (Host = IP des LXC 114,
   Benutzer, privater Schlüssel). Der Benutzer braucht Docker-Rechte (root oder Gruppe `docker`)
   sowie `git` auf dem Host.
3. Im Knoten **Webhook** eine Header-Auth-Zugangsdaten anlegen (z. B. Name `X-Update-Key`,
   langer Zufallswert) und den Workflow aktivieren.

**Update-Knopf im Dashboard:** Lege unter Automationen eine Automation mit Auslöser
**Dashboard aktualisieren** und der Webhook-URL dieses Workflows an. Oben auf der Seite
Automationen zeigt die Karte **Dashboard-Version** den laufenden Commit und – sobald es auf
GitHub Neues gibt – die neuen Commits und den Knopf zum Aktualisieren; die Seite lädt nach dem
Neustart von selbst neu. In der Seitenleiste erscheint dann „Update verfügbar“. Die Prüfung
fragt höchstens einmal pro Stunde bei GitHub nach (`UPDATE_CHECK=0` schaltet sie ab,
`UPDATE_REPO` wählt ein anderes Repository). Die Version schreibt der Docker-Build aus dem
`.git`-Verzeichnis in die Datei `version.json`.

Gestartet wird per **Test workflow**, per `POST` auf den Webhook (z. B. als Knopf unter
Automationen im Dashboard – mit dem Header von oben) oder, wenn aktiviert, täglich um 4 Uhr.
Der Webhook antwortet sofort mit 202, weil sich das Dashboard beim Neustart selbst beendet;
das Ergebnis steht in den n8n-Ausführungen, ein Fehler bricht den Workflow mit der Ausgabe ab
(und löst einen eingestellten Error-Workflow aus).

### Buchungen bearbeiten und Regeln anlegen per n8n

Das Dashboard selbst schreibt nie in Firefly. Kategorie und Tags lassen sich trotzdem aus den
Buchungsdetails ändern und Labor-Regeln in Firefly anlegen – über einen n8n-Workflow:

1. In n8n `n8n/firefly-buchung-bearbeiten.json` importieren.
2. Im Knoten **Einstellungen** die Firefly-Adresse eintragen (ohne `/api`).
3. Im Knoten **In Firefly speichern** Header-Auth-Zugangsdaten anlegen: Name `Authorization`,
   Wert `Bearer <Firefly-Token>`.
4. Workflow aktivieren und die **Production URL** kopieren.
5. Im Dashboard unter **Automationen** drei Automationen mit dieser URL anlegen: Auslöser
   **Kategorie übernehmen**, **Tags setzen** und **Firefly-Regeln anlegen** (Body jeweils leer
   lassen) – jeweils „Testen“.

Der Workflow bekommt `typ` (`kategorie_setzen` / `tags_setzen`), `transaction_group_id`,
`transaction_journal_id` und `kategorie` bzw. die komplette neue Liste `tags`; aus dem Labor
kommen Sammeländerungen (`kategorien_uebernehmen`) und Regeln (`regeln_anlegen`). Die Regeln
landen in der Gruppe „Firefly Dashboard (Labor)“; zugeordnet werden sie über `id:…` in ihrer
Beschreibung – Regeln, die du in dieser Gruppe von Hand anlegst, bleiben unberührt. Weil Firefly
alle passenden Regeln ausführt (die letzte Kategorie gewinnt) und im Labor die erste Regel
gewinnt, stehen sie in Firefly in umgekehrter Reihenfolge. Eine noch
unbekannte Kategorie legt Firefly dabei an. Nach einer erfolgreichen Änderung verwirft das
Dashboard seinen Zwischenspeicher, damit alle Seiten die neuen Daten laden.

### Datensicherung von Firefly per n8n

Die Firefly-API kann keine Datenbank-Sicherung auslösen (sie kennt nur CSV-Exporte, die sich
nicht zurückspielen lassen). `n8n/firefly-backup.json` sichert deshalb direkt auf dem
Docker-Host von Firefly per SSH:

- **Datenbank** – MariaDB/MySQL (`mariadb-dump`) oder Postgres (`pg_dump`); Container und
  Zugangsdaten werden automatisch erkannt (aus den Umgebungsvariablen des DB-Containers)
- **Anhänge** (`storage/upload`) und **APP_KEY** – Firefly verschlüsselt Anhänge damit
- Prüfung, dass der Dump wirklich Tabellen enthält; alte Sicherungen nach 14 Tagen löschen
- je Sicherung ein Ordner `~/firefly-backups/firefly-<datum>` mit `LIESMICH.txt` zum Wiederherstellen

Einrichten: Workflow importieren, im Knoten **Sicherung auf dem Firefly-Host** SSH-Zugangsdaten
für den Firefly-Host anlegen (Benutzer mit Docker-Rechten), im Knoten **Einstellungen** bei Bedarf
Ordner, Aufbewahrung oder Container-Namen setzen (leer = automatisch), aktivieren. Er läuft
täglich um 3:17 Uhr. Im Dashboard eine Automation mit Auslöser **Firefly-Backup** und der
Webhook-URL anlegen – dann zeigt die Seite **Prüfen** den Stand der letzten Sicherung und hat
einen Knopf „Jetzt sichern“. Tipp: die Sicherungen zusätzlich auf ein anderes Gerät kopieren.

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

## Als App installieren

Im Browser des Handys „Zum Startbildschirm hinzufügen“ wählen. Für die vollständige
App-Installation (Android/Chrome) und den Offline-Modus muss das Dashboard über **HTTPS**
erreichbar sein, z. B. über denselben Reverse Proxy wie Firefly – über `http://IP:8080`
funktioniert es nur als normales Lesezeichen.

## Hinweise

- Der Kontostand-Verlauf nutzt Fireflys Diagramm-Endpunkt; er zeigt die Konten, die in Firefly
  für die Startseite ausgewählt sind (*Optionen → Einstellungen → Konten auf der Startseite*).
- Bei mehreren Währungen werden Summen in der jeweils häufigsten Währung angezeigt.
- Getestet mit der Firefly-III-API v6.
