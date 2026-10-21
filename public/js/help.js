// Hilfe-Texte: für jede Seite und jede Karte – wofür sie da ist, was im
// Dashboard passiert und was (nicht) in Firefly passiert. Wird über die
// ?-Knöpfe und die Seite „Hilfe“ angezeigt.

const READ_ONLY = 'Nichts – das Dashboard liest nur. Firefly bleibt unverändert.';
const VIA_N8N = 'Das Dashboard selbst schreibt nie in Firefly. Änderungen macht ein n8n-Workflow, den du unter Automationen eingerichtet hast (Vorlage n8n/firefly-buchung-bearbeiten.json).';

/** Seiten (Schlüssel = Route) */
export const PAGES = {
  overview: {
    title: 'Übersicht',
    what: 'Der schnelle Blick auf den gewählten Zeitraum: Vermögen, Einnahmen, Ausgaben, Saldo, Hinweise, Ziele und die letzten Buchungen.',
    app: 'Alle Zahlen werden aus Firefly gelesen und für den Zeitraum oben rechts berechnet. Vergleiche beziehen sich auf die Vorperiode bzw. das Vorjahr (umschaltbar über den Zeitraum).',
    firefly: READ_ONLY,
    tips: ['Zeitraum oben rechts: Kalender- oder Gehaltsmonate, eigener Zeitraum.', 'Das Prognose-Symbol (Linie mit Pfeil) blendet Hochrechnungen bis Periodenende ein.', 'Taste „/“ oder Strg+K öffnet die Suche.'],
    cards: ['hints', 'goals', 'cashflow', 'accounts', 'flow', 'expected', 'categories', 'changes', 'recent'],
  },
  categories: {
    title: 'Kategorien & Tags',
    what: 'Die Analyse-Seite: Wohin geht das Geld, wie entwickelt es sich, was ist auffällig?',
    app: 'Liest Summen je Kategorie bzw. Tag aus Firefly und rechnet Vergleich, Monatsmatrix und Verteilung im Browser.',
    firefly: READ_ONLY,
    tips: ['Klick auf einen Balken oder ein Matrixfeld klappt die Buchungen darunter auf.', 'Filter mit Komma: „lebens, restaurant“ zeigt beide.', 'CSV-Export für Excel über die Links in den Karten.'],
    cards: ['c-table', 'c-dist', 'c-stack', 'c-matrix'],
  },
  detail: {
    title: 'Kategorie- / Tag-Detail',
    what: 'Alles zu einer Kategorie oder einem Tag: Verlauf, Top-Empfänger, Verteilung, Buchungen.',
    app: 'Liest die Buchungen der Kategorie aus Firefly. Bei „Ohne Kategorie“ zeigt es zusätzlich Vorschläge aus ähnlichen, schon kategorisierten Buchungen.',
    firefly: 'Nur lesen – außer du nutzt „Übernehmen“ bei einem Vorschlag oder setzt in den Buchungsdetails eine Kategorie. ' + VIA_N8N,
    cards: ['d-chart', 'd-suggest', 'd-dist', 'd-partners', 'd-tx'],
  },
  recurring: {
    title: 'Wiederkehrend',
    what: 'Erkennt Abos, Verträge und regelmäßige Einnahmen automatisch aus den Buchungen der letzten 24 Monate.',
    app: 'Sucht gleiche Empfänger mit regelmäßigem Rhythmus (monatlich, quartalsweise, jährlich …). „Streng/Normal/Locker“ bestimmt, wie genau Rhythmus und Betrag passen müssen.',
    firefly: READ_ONLY,
    cards: ['r-table'],
  },
  transactions: {
    title: 'Buchungen',
    what: 'Alle Buchungen im Zeitraum – mit Suche über alles, was Firefly kennt (auch älter als 24 Monate), und Sammelaktionen.',
    app: 'Die Suche nutzt Fireflys Suchsprache und lässt sich kombinieren, z. B. amount_more:100 description_contains:"Kita" notes_contains:"Rechnung" category_is:"Freizeit" has_no_category:true tag_is:"Urlaub". Gesucht wird im oben gewählten Zeitraum (für alles: eigenen Zeitraum über viele Jahre wählen). Klick auf eine Zeile zeigt alle Details. Häkchen (oder das Häkchen im Tabellenkopf für alle angezeigten) sammeln Buchungen – auch über mehrere Suchen hinweg.',
    firefly: 'Suchen und Ansehen ändern nichts. In der Leiste unten: „Kategorie setzen“ und „Tag hinzufügen“ ändern die ausgewählten Buchungen in Firefly – über die Automation „Kategorie übernehmen“ (n8n). „Als Gruppe ins Labor“ ändert noch nichts in Firefly: Die Gruppe wird im Labor geöffnet und dort mit „Nach Firefly übertragen“ übertragen – auch Buchungen, die älter als 24 Monate sind.',
    tips: ['Weitere Suchbefehle: amount_less:, amount_exactly:, destination_account_contains:, source_account_is:, has_no_tag:true.', 'Für eine dauerhafte Regel (künftige Buchungen) den Weg über „Als Gruppe ins Labor“ nehmen – „Kategorie setzen“ ändert nur die ausgewählten Buchungen.'],
    cards: [],
  },
  accounts: {
    title: 'Konten',
    what: 'Kontostände, Verlauf und Vermögensentwicklung; Klick auf ein Konto öffnet die Kontoseite.',
    app: 'Liest Konten und Kontostände aus Firefly.',
    firefly: READ_ONLY,
    cards: ['acc-chart', 'acc-worth'],
  },
  account: {
    title: 'Kontoseite',
    what: 'Ein Konto im Detail: Saldo-Verlauf, Ein-/Ausgänge je Monat, Ausgaben nach Kategorie, Buchungen.',
    app: 'Liest die Buchungen des Kontos aus Firefly.',
    firefly: READ_ONLY,
    cards: ['a-chart', 'a-months', 'a-cats', 'a-tx'],
  },
  party: {
    title: 'Empfänger / Händler',
    what: 'Alles zu einem Gegenüber, z. B. „Amazon“: Ausgaben im Vergleich zum Vorjahr, Monatsverlauf, Kategorien, Buchungen.',
    app: 'Wertet die Buchungen der letzten 24 Monate aus, bei denen dieser Name Empfänger (bzw. bei Einnahmen Zahler) ist.',
    firefly: READ_ONLY,
    cards: ['p-months', 'p-years', 'p-cats', 'p-tx'],
  },
  check: {
    title: 'Prüfen',
    what: 'Datenqualität: Hast du einen Import vergessen? Gibt es doppelte Buchungen?',
    app: 'Vergleicht die letzte Buchung je Konto mit dem üblichen Abstand und sucht Buchungspaare mit gleichem Betrag und gleichen Konten innerhalb von 3 Tagen.',
    firefly: 'Nur lesen. Doppelte löschst du in Firefly selbst („In Firefly öffnen“ in den Details). Der Import-Knopf startet deinen n8n-Import-Workflow – was der in Firefly tut, bestimmt der Workflow.',
    cards: ['c-import', 'c-backup', 'c-dup'],
  },
  lab: {
    title: 'Kategorien-Labor',
    what: 'Die Werkstatt zum Aufräumen: Kategorien und Tags probeweise neu ordnen, Regeln bauen, Gruppen zusammenstellen – und erst am Ende nach Firefly übertragen.',
    app: 'Alles ist zunächst nur eine Probe auf Basis der Buchungen der letzten 24 Monate. Regeln, Gruppen und ausgeblendete Vorschläge speichert der Dashboard-Server (bleiben über Geräte und Updates erhalten).',
    firefly: 'Nichts, solange du nur probierst. Firefly ändert sich erst bei: „In Firefly anlegen“ (Regeln), „Änderungen an n8n übergeben“ (Kategorien/Tags direkt an Buchungen) oder „Nach Firefly übertragen“ in einer Gruppe. ' + VIA_N8N,
    tips: ['Typischer Ablauf: Vorschläge ansehen → als Gruppe bearbeiten → Ähnliche finden → Nach Firefly übertragen.', 'Oben „Ausgaben/Einnahmen“ wechselt die Grundlage.', '„Einschränken“ (Zeitraum, Konto, Kategorie, Text) wirkt auf alles im Labor: Fortschritt, Vorschläge, Buchungen, „Ähnliche finden“ und „Änderungen an n8n übergeben“. Regeln aus Gruppen werden trotzdem gegen alle Buchungen geprüft, damit sie außerhalb keine Fehltreffer erzeugen.', 'Auto-Tags (Abo, Online, …) sind nur eine Probe-Hilfe und gehen nur über „Änderungen an n8n übergeben“ nach Firefly.'],
    cards: ['l-progress', 'l-groups', 'l-ai', 'l-rules', 'l-suggest', 'l-struct', 'l-compare', 'l-tagtable', 'l-tx'],
  },
  year: {
    title: 'Jahresrückblick',
    what: 'Ein Jahr auf einen Blick: Sparquote, Monate, Highlights, Kalender, Kategorien im Vergleich zum Vorjahr, größte Ausgaben, Abos.',
    app: 'Im laufenden Jahr wird mit dem Vorjahr bis zum selben Tag verglichen.',
    firefly: READ_ONLY,
    cards: ['y-months', 'y-high', 'y-cal', 'y-share', 'y-cats', 'y-top', 'y-subs'],
  },
  actions: {
    title: 'Automationen',
    what: 'Verbindet das Dashboard mit n8n: Knöpfe für Workflows, automatische Berichte und alles, was in Firefly schreiben soll.',
    app: 'Speichert Webhook-URL, Methode, Header und Body. Je nach Auslöser startet die Automation per Knopf, nach Zeitplan (Monatsabschluss, Wochenrückblick, Warnungen) oder aus anderen Seiten heraus.',
    firefly: 'Das Dashboard schickt nur Daten an n8n. Ob und was in Firefly geändert wird, entscheidet der jeweilige n8n-Workflow.',
    tips: [
      'Auslöser „Per Knopf“: startet mit dem gewählten Zeitraum.',
      '„Monatsabschluss“ / „Wochenrückblick“: Berichte per Zeitplan (z. B. an Telegram/Mail).',
      '„Warnungen“: große Ausgaben, neue Abo-Beträge, ausgebliebene Zahlungen.',
      '„Kategorie übernehmen“ / „Tags setzen“ / „Firefly-Regeln anlegen“: schreiben in Firefly (Vorlage firefly-buchung-bearbeiten.json).',
      '„Import starten“: Knopf auf der Seite Prüfen. „Dashboard aktualisieren“: Update-Knopf. „Firefly-Backup“: Sicherung (Vorlage firefly-backup.json).',
      'Header-Namen: nur Buchstaben, Ziffern und - _ . – ungültige werden beim Speichern gemeldet.',
      'In n8n immer die Production-URL (/webhook/…) eintragen und den Workflow aktivieren.',
    ],
    cards: ['version'],
  },
};

/** Karten (Schlüssel = Karten-ID) */
export const CARDS = {
  // Übersicht
  hints: { title: 'Hinweise', what: 'Was gerade Aufmerksamkeit braucht: große Ausgaben, geänderte Abo-Beträge, ausgebliebene Zahlungen, Buchungen ohne Kategorie, mögliche Dubletten, überfällige Importe.', app: 'Klick auf einen Hinweis führt zur passenden Seite.', firefly: READ_ONLY },
  goals: { title: 'Ziele', what: 'Eigene Monatsziele je Kategorie (unabhängig von Firefly-Budgets) und wie weit du im Zeitraum bist.', app: 'Ein Ziel legst du auf der Detailseite einer Kategorie fest („+ Monatsziel festlegen“); gespeichert wird es auf dem Dashboard-Server.', firefly: 'Nichts – Ziele sind keine Firefly-Budgets.' },
  cashflow: { title: 'Einnahmen & Ausgaben', what: 'Einnahmen und Ausgaben der letzten 12 Monate (bzw. Gehaltsmonate).', app: 'Mit Durchschnitt und Sparquote darunter.', firefly: READ_ONLY },
  accounts: { title: 'Konten', what: 'Aktuelle Kontostände.', app: 'Klick öffnet die Kontoseite.', firefly: READ_ONLY },
  flow: { title: 'Geldfluss', what: 'Woher das Geld kommt und wohin es geht – Einnahmen → Ausgaben → Gespart.', app: 'Breite der Bänder = Betrag. Klick auf einen Block, ein Band oder einen Namen zeigt darunter die Buchungen dazu (mit Details); von dort geht es zur Kategorie-Analyse oder – mit Zeitraum und Kategorie als Einschränkung – ins Labor. Nochmal klicken hebt die Auswahl auf.', firefly: READ_ONLY },
  expected: { title: 'Erwartet bis Periodenende', what: 'Prognose: Welche wiederkehrenden Zahlungen und üblichen Ausgaben bis zum Ende des Zeitraums noch kommen.', app: 'Nur sichtbar mit eingeschalteter Prognose.', firefly: READ_ONLY },
  categories: { title: 'Ausgaben nach Kategorie', what: 'Die größten Ausgabenblöcke im Zeitraum.', app: 'Klick auf eine Kategorie öffnet ihre Detailseite.', firefly: READ_ONLY },
  changes: { title: 'Größte Veränderungen', what: 'Kategorien, die sich gegenüber der Vorperiode am stärksten verändert haben.', app: 'Laufende Zeiträume werden fair mit demselben Abschnitt davor verglichen.', firefly: READ_ONLY },
  recent: { title: 'Letzte Buchungen', what: 'Die neuesten Buchungen.', app: 'Klick zeigt alle Details mit Link nach Firefly.', firefly: READ_ONLY },
  // Kategorien
  'c-table': { title: 'Vergleichstabelle', what: 'Jede Kategorie mit Betrag, Anteil, Vorperiode, Veränderung, Ø pro Monat, Mini-Verlauf und – falls gesetzt – Stand des Monatsziels.', app: 'Spaltenköpfe sortieren, Klick auf eine Kategorie öffnet ihre Detailseite (dort lässt sich auch ein Monatsziel festlegen).', firefly: READ_ONLY },
  'c-dist': { title: 'Verteilung', what: 'Anteile, Ausgaben nach Wochentag und nach Betragshöhe.', app: '', firefly: READ_ONLY },
  'c-stack': { title: 'Top 5 im Monatsverlauf', what: 'Die fünf größten Kategorien Monat für Monat.', app: 'Klick auf ein Segment zeigt die Buchungen dieser Kategorie im Monat, Klick daneben alle des Monats.', firefly: READ_ONLY },
  'c-matrix': { title: 'Monatsmatrix', what: 'Kategorien × Monate als Heatmap; auffällige Monate (≥ 50 % über üblich) sind markiert.', app: 'Klick auf ein Feld zeigt dessen Buchungen.', firefly: READ_ONLY },
  // Detail
  'd-chart': { title: 'Monatsverlauf', what: 'Die Kategorie Monat für Monat mit Durchschnittslinie (und Ziel).', app: 'Klick auf einen Balken zeigt die Buchungen des Monats.', firefly: READ_ONLY },
  'd-suggest': { title: 'Vorschläge zum Kategorisieren', what: 'Für Buchungen ohne Kategorie: eine Kategorie aus ähnlichen, bereits kategorisierten Buchungen (gleicher Empfänger oder ähnlicher Text).', app: '„Übernehmen“ startet die Automation „Kategorie übernehmen“.', firefly: 'Mit „Übernehmen“ setzt der n8n-Workflow die Kategorie dieser einen Buchung in Firefly. „In Firefly“ öffnet die Buchung zum Bearbeiten.' },
  'd-dist': { title: 'Verteilung', what: 'Wann und in welcher Höhe in dieser Kategorie ausgegeben wird.', app: '', firefly: READ_ONLY },
  'd-partners': { title: 'Top-Empfänger', what: 'An wen das Geld in dieser Kategorie geht.', app: 'Klick öffnet die Empfänger-Seite.', firefly: READ_ONLY },
  'd-tx': { title: 'Buchungen', what: 'Alle Buchungen der Kategorie im Zeitraum.', app: 'Klick zeigt Details; dort ggf. Kategorie/Tags ändern.', firefly: 'Nur bei „Kategorie setzen“ / Tags in den Details – über n8n.' },
  // Wiederkehrend
  'r-table': { title: 'Regelmäßige Zahlungen', what: 'Erkannte Abos und Verträge mit Rhythmus, typischem Betrag, Kosten pro Jahr und nächster erwarteter Zahlung.', app: 'Zahlungen, die länger ausgeblieben sind, gelten als vermutlich beendet; „Inkl. beendete“ zeigt sie mit an.', firefly: READ_ONLY },
  // Konten
  'acc-chart': { title: 'Kontostand-Verlauf', what: 'Kontostände im gewählten Zeitraum.', app: '', firefly: READ_ONLY },
  'acc-worth': { title: 'Vermögensverlauf', what: 'Summe aller Konten über 1–10 Jahre (Monatsendstände).', app: 'Verbindlichkeiten sind nicht abgezogen.', firefly: READ_ONLY },
  'a-chart': { title: 'Kontostand', what: 'Saldo-Verlauf des Kontos.', app: '', firefly: READ_ONLY },
  'a-months': { title: 'Ein- und Ausgänge je Monat', what: 'Was auf dem Konto rein- und rausging.', app: '', firefly: READ_ONLY },
  'a-cats': { title: 'Ausgaben nach Kategorie', what: 'Wofür von diesem Konto ausgegeben wurde.', app: '', firefly: READ_ONLY },
  'a-tx': { title: 'Buchungen', what: 'Alle Buchungen des Kontos.', app: 'Klick zeigt Details.', firefly: READ_ONLY },
  // Empfänger
  'p-months': { title: 'Monatsverlauf', what: 'Ausgaben bei diesem Empfänger je Monat, mit Durchschnitt.', app: '', firefly: READ_ONLY },
  'p-years': { title: 'Pro Jahr', what: 'Summe und Anzahl je Jahr.', app: '', firefly: READ_ONLY },
  'p-cats': { title: 'Kategorien', what: 'In welchen Kategorien die Buchungen dieses Empfängers stehen – hilfreich, um Uneinheitliches zu finden.', app: '', firefly: READ_ONLY },
  'p-tx': { title: 'Buchungen', what: 'Alle Buchungen mit diesem Empfänger.', app: 'Klick zeigt Details.', firefly: READ_ONLY },
  // Prüfen
  'c-import': { title: 'Import-Status je Konto', what: 'Letzte Buchung je Konto und ob sie ungewöhnlich lange her ist („überfällig“ = länger als das Dreifache des üblichen Abstands, mind. 7, höchstens 60 Tage).', app: 'Der Knopf startet eine Automation mit Auslöser „Import starten“ (z. B. deinen Bank-CSV-Workflow).', firefly: 'Das Dashboard selbst ändert nichts. Was der Import-Workflow in Firefly anlegt, bestimmt der Workflow.' },
  'c-backup': { title: 'Datensicherung (Firefly)', what: 'Zeigt, wann Firefly zuletzt gesichert wurde, und startet eine Sicherung per Knopf.', app: 'Beim Öffnen fragt das Dashboard über die Automation „Firefly-Backup“ den Stand ab. „Jetzt sichern“ startet die Sicherung und zeigt das Ergebnis. Die Sicherungen selbst liegen auf dem Firefly-Host (Standard ~/firefly-backups), nicht im Dashboard.', firefly: 'Firefly wird nicht verändert. Der n8n-Workflow (Vorlage n8n/firefly-backup.json) verbindet sich per SSH mit dem Firefly-Host und sichert dort Datenbank (MariaDB/MySQL/Postgres, automatisch erkannt), Anhänge und APP_KEY; alte Sicherungen werden nach 14 Tagen gelöscht. Wiederherstellen: siehe LIESMICH.txt in jeder Sicherung.', tips: ['Gelb markiert, wenn die letzte Sicherung älter als 2 Tage ist.', 'Der APP_KEY ist wichtig: Firefly verschlüsselt Anhänge damit.', 'Bewahre zusätzlich eine Kopie außerhalb des Firefly-Hosts auf (z. B. NAS).'] },
  'c-dup': { title: 'Mögliche doppelte Buchungen', what: 'Paare mit gleicher Art, gleichem Betrag und gleichen Konten höchstens 3 Tage auseinander. „Sicher“ = gleiche Bank-Referenz, „wahrscheinlich“ = gleicher Text am selben Tag.', app: '„Kein Duplikat“ blendet ein Paar auf allen Geräten aus.', firefly: 'Nichts. Die überzählige Buchung löschst du selbst in Firefly („In Firefly öffnen“ in den Details).' },
  // Labor
  'l-progress': {
    title: 'Fortschritt',
    what: 'Wie weit du mit dem Aufräumen bist – und was noch offen ist, aufgeteilt nach Kategorie oder Empfänger.',
    app: 'Erledigt ist eine Buchung, wenn sie in einer Gruppe steckt („in Gruppe“), eine Labor-Regel auf sie greift („Regel“) oder du sie als „passt so“ markiert hast. Alles andere ist „offen“. Klick auf eine Zeile filtert die Buchungsliste unten auf genau diese offenen Buchungen. „Passt so“ wird auf dem Server gespeichert und gilt auf allen Geräten.',
    firefly: 'Nichts – der Bearbeitungsstand gibt es nur im Dashboard.',
    tips: ['Arbeite Kategorie für Kategorie: Zeile anklicken → unten passende Buchungen anhaken → Gruppe oder „Passt so“.', 'Mehrere Buchungen auf einmal: Häkchen setzen, dann „✓ Passt so“ in der Leiste unten.'],
  },
  'l-groups': {
    title: 'Gruppen',
    what: 'Deine eigenen Zusammenstellungen von Buchungen, die eine Kategorie oder einen Tag bekommen sollen – über Tage und Geräte hinweg.',
    app: 'Häkchen in den Labor-Listen + „Neue Gruppe“ oder „Als Gruppe bearbeiten“ bei einem Vorschlag. Im Editor: Name/Art ändern, „entfernen“, „gehört nicht dazu“ (Gegenbeispiel), „Ähnliche finden“ (gleiche Empfänger, seltene gemeinsame Wörter, ähnliche Beträge). Gespeichert wird jeder Schritt sofort auf dem Server; gelöschte Gruppen liegen 30 Tage im Papierkorb.',
    firefly: '„Als Labor-Regeln übernehmen“ ändert nichts in Firefly. „Nach Firefly übertragen“ legt die Regeln der Gruppe in einer eigenen Firefly-Regelgruppe „Dashboard: <Name>“ an (künftige Buchungen werden automatisch kategorisiert), wendet sie auf Wunsch auf vorhandene Buchungen an und setzt einzelne Buchungen direkt. ' + VIA_N8N,
    tips: ['„Sehr ähnlich“ ist schon angehakt – kurz prüfen, dann „Angehakte hinzufügen“.', 'Erneutes Übertragen aktualisiert die Regeln statt sie zu verdoppeln.', 'Der Filter über der Liste zeigt, was noch zu tun ist: „Offen“, „Nicht in Firefly“ (übernommen, aber noch nicht übertragen) und „Geändert seit Übertragung“ (nach dem Übertragen erweitert – erneut übertragen).'],
  },
  'l-ai': {
    title: 'KI-Analyse mit Ollama',
    what: 'Ein lokales Sprachmodell (Ollama, z. B. dieselbe Instanz wie der Paperless Companion) bewertet jeden Händler: Kategorie, Tags, Bedarf (notwendig / sinnvoll / verzichtbar), Sicherheit und Begründung. Auf Wunsch entwirft es ein eigenes Kategoriesystem (Clustern).',
    app: 'Bewertet wird je Händler (bei PayPal & Co. nach Buchungstext), im Hintergrund – du kannst die Seite verlassen. Die KI darf je nach Einstellung auch neue Kategorien und Tags vorschlagen; ob etwas neu ist, ergibt der Abgleich mit dem Bestand in Firefly (gestrichelt mit ✦ = neu). Unter „Vorschläge prüfen“ neue Namen übernehmen, umbenennen, mit Vorhandenem zusammenlegen oder ignorieren; je Händler annehmen (✓, gilt auch unter der Mindest-Sicherheit) oder ablehnen (✕). „KI-Ergebnisse anwenden“ legt sie als Ebene unter deine Regeln – eigene Regeln und Gruppen haben Vorrang. Alles wird auf dem Server gespeichert.',
    firefly: 'Nichts. Erst „In Firefly anlegen“, „Änderungen an n8n übergeben“ oder „Als Firefly-Regeln ↓“ nehmen die angewendeten KI-Ergebnisse mit (je Händler eine Regel) – wann du willst, auch viel später. Neue Kategorien und Tags entstehen dabei in Firefly. ' + VIA_N8N,
    tips: ['Ollama-Adresse muss vom Dashboard-Server aus erreichbar sein, im selben Docker-Netz z. B. http://ollama:11434.', 'Gute Modelle: qwen2.5:7b, llama3.1:8b, gemma2:9b – kleinere sind schneller, aber ungenauer.', 'Mindest-Sicherheit eher bei 80 % lassen und vor dem Übertragen Vorher/Nachher ansehen.'],
  },
  'l-rules': {
    title: 'Deine Regeln',
    what: 'Die Regeln, mit denen das Labor probeweise kategorisiert und taggt. Die erste passende Regel bestimmt die Kategorie, Tags sammeln sich.',
    app: 'Häkchen schaltet eine Regel an/aus, ↑ ändert die Reihenfolge, ✕ löscht. „Gruppe“ markiert Regeln aus einer Gruppe.',
    firefly: '„Als Firefly-Regeln ↓“ lädt nur eine Datei herunter. „In Firefly anlegen“ legt die Regeln (ohne Gruppen-Regeln) in der Regelgruppe „Firefly Dashboard (Labor)“ an und gleicht sie ab. „Änderungen an n8n übergeben“ setzt Kategorie/Tags direkt an allen Buchungen, die das Labor gerade ändern würde – inklusive Auto-Tags. ' + VIA_N8N,
  },
  'l-suggest': { title: 'Vorschläge', what: 'Regeln aus deinen Daten: uneinheitlich kategorisierte Empfänger, Buchungen ohne Kategorie, bekannte Händler.', app: '„+ N“ übernimmt die Regel (N = so viele Buchungen ändern sich), „Als Gruppe“ startet eine Gruppe damit. Aufklappen zeigt die betroffenen Buchungen.', firefly: 'Nichts – nur Probe im Labor.' },
  'l-struct': { title: 'Tags & Kategorien-Struktur', what: 'Größere Aufräum-Ideen: Tags für Themen im Verwendungszweck, Reisen, Kategorien zusammenfassen oder aufteilen.', app: '„Übernehmen“ legt Labor-Regeln an, „Als Gruppe bearbeiten“ macht eine Gruppe daraus (zum Verfeinern), „Ignorieren“ blendet den Vorschlag auf allen Geräten aus. Alles lokal, ohne KI.', firefly: 'Nichts – nur Probe im Labor.' },
  'l-compare': { title: 'Kategorien vorher / nachher', what: 'Wie sich die Summen je Kategorie mit deinen Regeln ändern würden.', app: '', firefly: 'Nichts – nur Probe.' },
  'l-tagtable': { title: 'Tags (Probe)', what: 'Welche Tags deine Regeln und Auto-Tags vergeben würden.', app: 'Klick auf einen Tag filtert die Buchungen unten.', firefly: 'Nichts – nur Probe.' },
  'l-tx': { title: 'Buchungen', what: 'Die Buchungen mit dem Probe-Ergebnis (bisher → neu) und ihrem Bearbeitungsstand.', app: '„Offen / Erledigt / Geänderte / Ohne Kategorie / Alle“ filtert. Häkchen (oder „Alle angezeigten auswählen“) sammeln Buchungen; in der Leiste unten dann: Kategorie „Setzen“ bzw. Tag „Hinzufügen“ (schnell – legt eine Gruppe mit diesem Namen an oder ergänzt sie und übernimmt sie gleich als Labor-Regel), „Neue Gruppe …“, „Zu Gruppe hinzufügen“ oder „✓ Passt so“.', firefly: 'Nichts – nur Probe. In Firefly landet es erst über die Gruppe („Nach Firefly übertragen“).' },
  // Automationen
  version: { title: 'Dashboard-Version', what: 'Welche Version des Dashboards läuft und ob es auf GitHub eine neuere gibt (geprüft höchstens einmal pro Stunde).', app: '„Jetzt prüfen“ fragt sofort bei GitHub nach. „Jetzt aktualisieren“ startet die Automation mit Auslöser „Dashboard aktualisieren“ (n8n-Vorlage firefly-dashboard-update.json): Sie holt den neuen Stand, baut den Container neu und startet ihn – das Dashboard ist dabei kurz nicht erreichbar und lädt danach von selbst neu. Deine Daten (Gruppen, Regeln, Automationen …) bleiben erhalten.', firefly: 'Nichts – Firefly wird beim Update nicht angefasst.' },
  // Jahr
  'y-months': { title: 'Monat für Monat', what: 'Einnahmen und Ausgaben je Monat des Jahres.', app: '', firefly: READ_ONLY },
  'y-high': { title: 'Highlights', what: 'Bester und teuerster Monat, größte Einzelausgabe, stärkste Veränderung.', app: '', firefly: READ_ONLY },
  'y-cal': { title: 'Ausgaben-Kalender', what: 'Ein Feld pro Tag – je dunkler, desto mehr ausgegeben.', app: 'Klick auf einen Tag zeigt seine Buchungen.', firefly: READ_ONLY },
  'y-share': { title: 'Wohin das Geld ging', what: 'Anteile der Kategorien am Jahr.', app: '', firefly: READ_ONLY },
  'y-cats': { title: 'Kategorien im Vorjahresvergleich', what: 'Jede Kategorie gegenüber dem Vorjahr.', app: '', firefly: READ_ONLY },
  'y-top': { title: 'Größte Ausgaben', what: 'Die größten Posten; gleiche (z. B. 12× Miete) zusammengefasst.', app: '', firefly: READ_ONLY },
  'y-subs': { title: 'Abos & Verträge', what: 'Was die erkannten regelmäßigen Zahlungen pro Jahr kosten.', app: '', firefly: READ_ONLY },
};


/** Alle Karten-IDs, die auf einer Seite vorkommen (für die Hilfe-Seite). */
export const pageOfCard = (cardId) => Object.keys(PAGES).find((k) => PAGES[k].cards.includes(cardId)) || null;
