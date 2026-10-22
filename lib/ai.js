// KI-Analyse mit Ollama (lokal – die Finanzdaten verlassen das eigene Netz nicht).
//
// Statt jede Buchung einzeln zu fragen, werden Buchungen zu Händlern
// gruppiert (wie im Labor). Je Händler liefert das Modell Kategorie, Tags,
// eine Einordnung (notwendig / sinnvoll / verzichtbar) und eine Begründung.
// Optional entwirft es vorher ein eigenes Kategoriesystem („Clustern“).
//
//   GET/PUT /local/ai/settings   { url, model, freedom, layer: { on, min } }
//   GET     /local/ai/models     Modelle der Ollama-Instanz
//   GET     /local/ai/status     Fortschritt + Ergebnisse
//   POST    /local/ai/run        { mode: 'classify' | 'scheme', scope: 'open' | 'all' }
//   POST    /local/ai/stop       laufende Analyse anhalten
//   POST    /local/ai/test       kurze Probe-Anfrage: erreichbar? wie schnell?
//   POST    /local/ai/ask        { frage, modus: 'auto'|'schnell'|'ki' } → Antwort mit exakten Zahlen
//   PUT     /local/ai/review     { status: {key: 'ok'|'nein'|null}, categories: {Name: Ziel|null}, tags: {…} }
//   DELETE  /local/ai/labels     Ergebnisse verwerfen
//
// Neue Kategorien/Tags sind erlaubt (je nach Einstellung „freedom“). Ob ein
// Vorschlag neu ist, entscheidet der Vergleich mit dem Bestand in Firefly
// (`pool` im Status) – nicht das Modell. Alles bleibt im Dashboard, bis es
// exportiert wird.
//
// Ollama läuft oft auf einer CPU oder kleinen GPU: Laden des Modells und das
// Lesen eines langen Prompts können Minuten dauern. Darum wird gestreamt (kein
// Gesamt-Zeitlimit, nur „wie lange ohne neues Wort“), mit node:http statt fetch
// (fetch bricht nach 5 Minuten ohne Antwortkopf ab), mit kleinem Kontext und
// Paketen, die sich bei einer Zeitüberschreitung selbst halbieren.

import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { jsonFile } from './store.js';
import { isoDate } from '../public/js/util.js';
import { merchantOf, cleanText, isGenericText } from '../public/js/rules.js';
import { PAGE_SIZE } from './warmer.js';
import { parseQuestion, cleanQuery, resolvePeriod, comparePeriod, runQuery, answerText, AUSWERTUNGEN, ZEITRAEUME } from '../public/js/askcore.js';

const BATCH = 8;
const WAIT_CHOICES = [5, 10, 20, 30]; // Minuten bis zum ersten Wort (Modell laden + Prompt lesen)
const IDLE_MS = 2 * 60_000; // danach: höchstens so lange ohne neues Wort
const NEEDS = ['notwendig', 'sinnvoll', 'verzichtbar'];
const FREEDOM = ['vorhanden', 'sinnvoll', 'frei'];
const POOL_TTL = 5 * 60_000;

/** Vergleichsschlüssel: Groß/klein, Sonderzeichen und einfache Plural-Endungen egal. */
const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '').replace(/(en|n|e|s)$/, '');

/** Namen auf die Schreibweise im Bestand bringen („versicherungen“ → „Versicherung“). */
export function matchPool(name, pool) {
  const clean = String(name || '').trim();
  if (!clean) return '';
  const f = fold(clean);
  return pool.find((x) => x.toLowerCase() === clean.toLowerCase()) || pool.find((x) => fold(x) === f) || clean;
}

/** Erstes JSON-Objekt aus einer Modellantwort holen (Modelle schreiben manchmal Text drumherum). */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Antwort enthielt kein JSON');
    return JSON.parse(m[0]);
  }
}

export function createAi({ dataDir, firefly, log = console.log }) {
  const settingsFile = jsonFile(path.join(dataDir, 'ai-settings.json'), {
    url: process.env.OLLAMA_URL || 'http://ollama:11434',
    model: process.env.OLLAMA_MODEL || '',
    freedom: 'sinnvoll',
    wait: Number(process.env.OLLAMA_WAIT_MINUTES) || 10,
    layer: { on: false, min: 80 }, // KI-Ergebnisse im Labor anwenden, ab Sicherheit
  }, { log });
  const EMPTY = { labels: {}, scheme: null, decisions: { categories: {}, tags: {} } };
  const labelsFile = jsonFile(path.join(dataDir, 'ai-labels.json'), EMPTY, { snapshots: true, log });
  let job = null; // { mode, total, done, errors, startedAt, stop, message }

  // ---- Ollama -----------------------------------------------------------------
  const base = () => settingsFile.read().url.replace(/\/+$/, '');

  async function listModels() {
    const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Ollama antwortet mit HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details?.family || '' }));
  }

  /** Kontextgröße passend zum Prompt (kleiner = schneller, weniger Speicher). */
  const ctxFor = (text, answer) => Math.min(8192, Math.max(2048, Math.ceil((text.length / 3 + answer) / 1024) * 1024));

  class Timeout extends Error {}

  /** POST mit gestreamter NDJSON-Antwort; ruft onLine je Zeile. Zeitlimits über arm(). */
  function postStream(url, body, { onLine, firstMs, signal }) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      let timer;
      let gotAny = false;
      const fail = (err) => {
        clearTimeout(timer);
        req.destroy();
        reject(err);
      };
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new Timeout(gotAny
          ? `Ollama hat ${ms / 60_000} Minuten lang nichts mehr geschickt.`
          : `Keine Antwort von Ollama nach ${ms / 60_000} Minuten – das Modell lädt oder rechnet zu lange (siehe „Speichern & testen“).`)), ms);
      };
      if (signal?.aborted) return fail(new Error('Angehalten.'));
      signal?.addEventListener('abort', () => fail(new Error('Angehalten.')), { once: true });
      arm(firstMs);
      req.on('error', (err) => fail(new Error(err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH'
        ? `Ollama unter ${u.origin} nicht erreichbar (${err.code}).` : `Verbindung zu Ollama: ${err.message}`)));
      req.on('response', (res) => {
        if (res.statusCode >= 400) {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => fail(new Error(`Ollama: HTTP ${res.statusCode} ${text.slice(0, 200)}`)));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            gotAny = true;
            arm(IDLE_MS);
            try {
              onLine(JSON.parse(line));
            } catch (err) {
              return fail(err);
            }
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          if (buf.trim()) {
            try {
              onLine(JSON.parse(buf));
            } catch {
              // unvollständige letzte Zeile ignorieren
            }
          }
          resolve();
        });
        res.on('error', fail);
      });
      req.end(JSON.stringify(body));
    });
  }

  /**
   * Eine Anfrage an Ollama (gestreamt). Liefert das JSON der Antwort und
   * Messwerte; onProgress bekommt die Zahl der bisher erzeugten Teile.
   */
  async function chat(system, user, { answer = 1500, onProgress, signal } = {}) {
    const { model, wait } = settingsFile.read();
    if (!model) throw new Error('Kein Modell gewählt.');
    const firstMs = (WAIT_CHOICES.includes(Number(wait)) ? Number(wait) : 10) * 60_000;
    let content = '';
    let parts = 0;
    let stats = {};
    const started = Date.now();
    let firstAt = null;
    await postStream(`${base()}/api/chat`, {
      model,
      stream: true,
      format: 'json',
      keep_alive: '30m', // zwischen den Paketen nicht neu laden
      options: { temperature: 0.1, num_ctx: ctxFor(system + user, answer), num_predict: answer },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, {
      firstMs,
      signal,
      onLine: (j) => {
        if (j.error) throw new Error(`Ollama: ${j.error}`);
        if (j.message?.content) {
          content += j.message.content;
          parts += 1;
          firstAt ??= Date.now();
          onProgress?.(parts);
        }
        if (j.done) stats = j;
      },
    });
    const ns = (v) => (Number(v) || 0) / 1e9;
    return {
      data: parseJson(content),
      metrics: {
        seconds: Math.round((Date.now() - started) / 100) / 10,
        firstSeconds: firstAt ? Math.round((firstAt - started) / 100) / 10 : null,
        loadSeconds: Math.round(ns(stats.load_duration) * 10) / 10,
        promptTokens: stats.prompt_eval_count || 0,
        promptPerSecond: ns(stats.prompt_eval_duration) ? Math.round((stats.prompt_eval_count / ns(stats.prompt_eval_duration)) * 10) / 10 : null,
        tokens: stats.eval_count || parts,
        perSecond: ns(stats.eval_duration) ? Math.round((stats.eval_count / ns(stats.eval_duration)) * 10) / 10 : null,
      },
    };
  }

  /** Kurze Probe im Hintergrund: erreichbar, Modell lädt, Geschwindigkeit. */
  let probe = null; // { running, metrics, error, model, at, ctrl }
  const asking = new Set(); // laufende Fragen (AbortController)
  function test() {
    if (probe?.running) return;
    const { model } = settingsFile.read();
    const ctrl = new AbortController();
    probe = { running: true, model, at: new Date().toISOString(), ctrl };
    chat('Antworte nur mit JSON.', 'Gib {"ok": true, "wort": "Lebensmittel"} zurück.', { answer: 40, signal: ctrl.signal })
      .then(({ metrics }) => (probe = { metrics, model, at: new Date().toISOString() }))
      .catch((err) => (probe = { error: ctrl.signal.aborted ? 'Test abgebrochen.' : err.message, model, at: new Date().toISOString() }));
  }

  // ---- Daten: Buchungen → Händler ------------------------------------------------
  async function getJson(apiPath, params) {
    const r = await firefly.get(apiPath, params, { priority: 'warm' });
    if (r.status >= 400) throw new Error(`Firefly ${apiPath}: HTTP ${r.status}`);
    return JSON.parse(r.body.toString('utf8'));
  }

  /** Kategorien und Tags, die es in Firefly schon gibt (auch ohne Buchungen im Zeitraum). */
  let poolCache = null;
  async function pool() {
    if (poolCache && Date.now() - poolCache.at < POOL_TTL) return poolCache.data;
    const all = async (apiPath, pick) => {
      const out = [];
      for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
        const r = await getJson(apiPath, { limit: PAGE_SIZE, page });
        pages = r?.meta?.pagination?.total_pages || 1;
        out.push(...(r.data || []).map((x) => pick(x.attributes || {})).filter(Boolean));
      }
      return [...new Set(out)].sort((a, b) => a.localeCompare(b, 'de'));
    };
    const [categories, tags] = await Promise.all([
      all('categories', (a) => a.name).catch(() => []),
      all('tags', (a) => a.tag).catch(() => []),
    ]);
    poolCache = { at: Date.now(), data: { categories, tags } };
    return poolCache.data;
  }

  /** Händler der letzten 24 Monate (gleiche Abfrage wie Labor/Wiederkehrend → Cache). */
  /** Was die KI zu einer Buchung lesen soll: Beschreibung und Notizen ohne Bank-Standardtexte. */
  const infoText = (tx) => [...new Set([tx.description, tx.notes].filter((x) => !isGenericText(x)).map(cleanText))].join(' · ').slice(0, 140);

  /** Händler der letzten 24 Monate (gleiche Abfrage wie Labor/Wiederkehrend → Cache) plus Datenqualität. */
  async function merchants() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    const params = { start: isoDate(new Date(t.getFullYear(), t.getMonth() - 24, 1)), end: isoDate(t), type: 'withdrawal' };
    const first = await getJson('transactions', { ...params, limit: PAGE_SIZE, page: 1 });
    const pages = first?.meta?.pagination?.total_pages || 1;
    const all = [first];
    for (let p = 2; p <= pages; p++) {
      signal?.throwIfAborted();
      all.push(await getJson('transactions', { ...params, limit: PAGE_SIZE, page: p }));
    }
    const txs = all.flatMap((r) => r.data || []).flatMap((g) => (g.attributes?.transactions || []).map((x) => ({ ...x, amount: Number(x.amount) })))
      .filter((x) => x.type === 'withdrawal');
    const groups = new Map();
    const quality = { total: txs.length, genericDescription: 0, genericParty: 0, fromNotes: 0, unknown: 0 };
    for (const tx of txs) {
      const m = merchantOf(tx);
      if (isGenericText(tx.description)) quality.genericDescription += 1;
      if (m.generic) quality.genericParty += 1;
      if (m.from === 'notes') quality.fromNotes += 1;
      if (!m.key || m.key === 'text:') {
        quality.unknown += 1;
        continue;
      }
      const g = groups.get(m.key) || { key: m.key, name: m.name, via: m.via, match: m.cond, n: 0, sum: 0, examples: new Set(), cats: new Map(), tags: new Set() };
      (tx.tags || []).forEach((tag) => g.tags.add(tag));
      g.n += 1;
      g.sum += tx.amount;
      const info = infoText(tx);
      if (info && g.examples.size < 4) g.examples.add(info);
      const c = tx.category_name || 'ohne';
      g.cats.set(c, (g.cats.get(c) || 0) + 1);
      groups.set(m.key, g);
    }
    const list = [...groups.values()].sort((a, b) => b.sum - a.sum);
    list.quality = quality;
    return list;
  }

  const describe = (g, i) => {
    const cats = [...g.cats].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} (${n})`).join(', ');
    return `${i + 1}. ${g.name}${g.via ? ` (über ${g.via})` : ''} | Texte: ${[...g.examples].map((e) => `„${e}“`).join(', ')} | ${g.n} Buchungen, ${Math.round(g.sum)} € | bisher: ${cats}${g.tags.size ? ` | Tags: ${[...g.tags].join(', ')}` : ''}`;
  };

  // ---- Fragen an die eigenen Daten -------------------------------------------------
  const appSettings = jsonFile(path.join(dataDir, 'settings.json'), { payday: 24 }, { log });

  /** Buchungen eines Zeitraums (aus dem Zwischenspeicher des Firefly-Clients). */
  async function transactionsBetween(start, end, type, signal) {
    const params = { start: isoDate(start), end: isoDate(end), ...(type ? { type } : {}) };
    const first = await getJson('transactions', { ...params, limit: PAGE_SIZE, page: 1 });
    const pages = Math.min(first?.meta?.pagination?.total_pages || 1, 200);
    const all = [first];
    for (let p = 2; p <= pages; p++) all.push(await getJson('transactions', { ...params, limit: PAGE_SIZE, page: p }));
    return all.flatMap((r) => r.data || []).flatMap((g) => (g.attributes?.transactions || []).map((x) => ({ ...x, groupId: g.id, amount: Number(x.amount) })));
  }

  /** Bekannte Namen für das Verstehen der Frage: Kategorien, Tags, Händler. */
  async function knownNames() {
    const [existing, list] = await Promise.all([pool().catch(() => ({ categories: [], tags: [] })), merchants().catch(() => [])]);
    return { kategorien: existing.categories, tags: existing.tags, haendler: list.slice(0, 400).map((g) => g.name) };
  }

  /** Frage → Abfrage mit der KI (Ollama). Namen werden auf den Bestand abgebildet. */
  async function understandWithAi(question, known, now, signal) {
    const today = isoDate(now);
    const { data } = await chat('Du übersetzt Fragen zu privaten Finanzen in eine Abfrage. Antworte ausschließlich mit gültigem JSON ohne weiteren Text.',
      `Heute ist ${today}. Frage: „${question}“\n\n`
      + `Erzeuge ein JSON-Objekt mit diesen Feldern:\n`
      + `- "auswertung": eins von ${AUSWERTUNGEN.join(', ')} (summe = wie viel; anzahl = wie oft; liste = Buchungen zeigen; groesste = größte Buchungen; top_haendler / top_kategorien = wo am meisten; verlauf = je Monat; aenderung = je Händler/Kategorie mehr oder weniger als im Vergleich)\n`
      + `- "art": ausgaben, einnahmen oder beides\n`
      + `- "zeitraum": eins von ${ZEITRAEUME.join(', ')} (ohne Angabe: letzte_n_monate mit n 12); dazu ggf. "monat" (JJJJ-MM), "jahr" (JJJJ), "n" (Monate), "von"/"bis" (JJJJ-MM-TT)\n`
      + `- "vergleich": vorjahr, vorperiode oder monat (dann "vergleich_monat" JJJJ-MM), nur wenn ein Vergleich gefragt ist\n`
      + `- bei auswertung aenderung (was war mehr/weniger als im Vergleichszeitraum, gleich gebliebene Posten ausgeblendet): "richtung" mehr, weniger oder beide; "gruppe" haendler oder kategorie; "zeitraum" ist der neuere Zeitraum\n`
      + `- "haendler", "kategorien", "tags": Listen – nur Namen aus diesen Listen verwenden:\n`
      + `  Kategorien: ${known.kategorien.join(', ') || '(keine)'}\n  Tags: ${known.tags.join(', ') || '(keine)'}\n`
      + `  Händler (Auswahl): ${known.haendler.slice(0, 150).join(', ')}\n`
      + `- "text": Suchbegriff, wenn ein Name in keiner Liste steht\n- "limit": Anzahl bei Top/Liste\n`
      + 'Beispiel: {"auswertung":"summe","art":"ausgaben","zeitraum":"letzter_monat","haendler":["Amazon"],"kategorien":[],"tags":[]}',
      { answer: 300, signal });
    const q = cleanQuery(data);
    // Namen der KI auf den Bestand abbilden (Groß/klein, Teilwort)
    const mapTo = (names, pool) => names.map((n) => pool.find((x) => x.toLowerCase() === n.toLowerCase())
      || pool.find((x) => x.toLowerCase().includes(n.toLowerCase())) || pool.find((x) => n.toLowerCase().includes(x.toLowerCase())) || n);
    q.kategorien = mapTo(q.kategorien, known.kategorien);
    q.tags = mapTo(q.tags, known.tags);
    q.haendler = mapTo(q.haendler, known.haendler);
    return q;
  }

  /** Frage beantworten – die Zahlen rechnet immer das Dashboard. */
  async function ask(question, modus = 'auto', signal) {
    const now = new Date();
    const known = await knownNames();
    const parsed = parseQuestion(question, known, now);
    const { model } = settingsFile.read();
    let query = parsed.query;
    let how = 'schnell';
    let note = '';
    const useAi = modus === 'ki' || (modus === 'auto' && model && !parsed.sure);
    if (useAi) {
      if (!model) note = 'Für die KI ist im Labor noch kein Ollama-Modell eingestellt – ohne KI beantwortet.';
      else {
        try {
          query = await understandWithAi(question, known, now, signal);
          how = 'ki';
        } catch (err) {
          if (signal?.aborted) throw new Error('Abgebrochen.');
          note = `KI nicht verfügbar (${err.message}) – ohne KI beantwortet.`;
        }
      }
    }
    const period = resolvePeriod(query, now, appSettings.read().payday);
    const compare = query.vergleich ? comparePeriod(period, query.vergleich, query) : null;
    const type = query.art === 'ausgaben' ? 'withdrawal' : query.art === 'einnahmen' ? 'deposit' : null;
    const from = compare && compare.start < period.start ? compare.start : period.start;
    signal?.throwIfAborted();
    const txs = await transactionsBetween(from, period.end, type, signal);
    const result = runQuery(query, txs, period, compare);
    // nichts Bestimmtes erkannt? Dann ehrlich sagen, dass die Zahl für alles gilt
    const unfiltered = !query.haendler.length && !query.kategorien.length && !query.tags.length && !query.text;
    if (unfiltered && /\b(bei|beim|für|fuer|an|vom|von)\s+\S/i.test(question) && !['top_haendler', 'top_kategorien', 'groesste'].includes(query.auswertung)) {
      note = `${note ? `${note} ` : ''}Keinen Händler, keine Kategorie und keinen Tag erkannt – die Zahl gilt für alle ${query.art === 'einnahmen' ? 'Einnahmen' : 'Ausgaben'}. Den Namen so schreiben, wie er in Firefly heißt.`;
    }
    const slim = (t) => ({ date: String(t.date).slice(0, 10), description: t.description, party: (t.type === 'deposit' ? t.source_name : t.destination_name) || '',
      merchant: merchantOf(t).name, category: t.category_name || '', amount: t.amount, type: t.type, groupId: t.groupId, notes: t.notes ? String(t.notes).slice(0, 120) : '' });
    return {
      frage: question, antwort: answerText(result), how, note, sure: parsed.sure, query,
      zeitraum: period.label, vergleich: compare?.label || null,
      n: result.n, sum: result.sum, compare: result.compare ? { label: compare.label, n: result.compare.n, sum: result.compare.sum } : null,
      groups: result.groups || null, months: result.months || null,
      diffs: result.diffs || null, diffsTotal: result.diffsTotal || 0, same: result.same || 0, hits: result.hits.slice(0, 50).map(slim),
    };
  }

  const SYSTEM = 'Du bist ein sorgfältiger Assistent für private Finanzen in Deutschland. Du ordnest Empfänger aus Kontoauszügen ein. '
    + 'Antworte ausschließlich mit gültigem JSON ohne weiteren Text.';

  /** Schritt „Clustern“: aus den größten Händlern ein Kategoriesystem entwerfen. */
  async function proposeScheme(list, existing, opts) {
    const sample = list.slice(0, 80).map((g, i) => `${i + 1}. ${g.name} – ${String([...g.examples][0] || '').slice(0, 40)} – ${Math.round(g.sum)} €`).join('\n');
    const { data: out } = await chat(SYSTEM, `Hier sind die Empfänger eines Haushalts mit Beispieltext und Summe über 24 Monate:\n${sample}\n\n`
      + 'Entwirf daraus ein übersichtliches Kategoriesystem für Ausgaben: 8 bis 16 Kategorien, kurze deutsche Namen, je eine Beschreibung, '
      + 'was dazugehört. Fasse Ähnliches zusammen, trenne aber Fixkosten (Wohnen, Versicherungen, Verträge) von Alltag und Freizeit. '
      + `Vorhandene Kategorien: ${existing.join(', ') || '(keine)'} – übernimm deren Namen, wo sie passen, und ergänze nur, was fehlt.\n`
      + 'Format: {"kategorien":[{"name":"…","beschreibung":"…"}]}', { answer: 1500, ...opts });
    const cats = (out.kategorien || []).map((c) => ({ name: String(c.name || '').trim().slice(0, 40), beschreibung: String(c.beschreibung || '').slice(0, 200) }))
      .filter((c) => c.name);
    if (cats.length < 3) throw new Error('Das Modell hat kein brauchbares Kategoriesystem geliefert.');
    return cats.map((c) => ({ ...c, name: matchPool(c.name, existing) }));
  }

  /** Ein Paket Händler einordnen. */
  const RULES_BY_FREEDOM = {
    vorhanden: 'Verwende nur vorhandene Kategorien und Tags. Eine neue Kategorie nur, wenn wirklich gar nichts passt; keine neuen Tags.',
    sinnvoll: 'Nutze eine vorhandene Kategorie bzw. einen vorhandenen Tag, wenn er gut passt. Ist nichts passend oder ist das Vorhandene '
      + 'zu grob (z. B. „Sonstiges“, „ohne“), schlage eine treffendere neue Kategorie bzw. neue Tags vor.',
    frei: 'Schlage die Kategorie und Tags vor, die du für am treffendsten hältst – vorhandene oder neue. Gute neue Tags beschreiben '
      + 'Zweck oder Lebensbereich (z. B. Kinder, Haustier, Hobby, Arbeit, Gesundheit, Abo, Fixkosten).',
  };

  /** Ein Paket Händler einordnen. */
  async function classify(batch, existing, scheme, freedom, opts) {
    const allowed = scheme
      ? `Verwende als Kategorie ausschließlich eine dieser:\n${scheme.map((c) => `- ${c.name}: ${c.beschreibung}`).join('\n')}`
      : `Vorhandene Kategorien: ${existing.categories.join(', ') || '(noch keine)'}.`;
    const { data: out } = await chat(SYSTEM, `${allowed}\nVorhandene Tags: ${existing.tags.join(', ') || '(noch keine)'}.\n${RULES_BY_FREEDOM[freedom]}\n\n`
      + `Ordne jeden Empfänger ein:\n${batch.map(describe).join('\n')}\n\n`
      + 'Für jeden Empfänger: "kategorie" (kurzer deutscher Name); "tags" (0–3 kurze Schlagworte); '
      + '"bedarf": "notwendig" (Grundbedarf wie Miete, Lebensmittel, Versicherung), "sinnvoll" (nützlich, aber verhandelbar) oder "verzichtbar" (Luxus/Impuls); '
      + '"sicherheit" 0–100; "grund" (max. 12 Wörter). Wenn "bisher" eindeutig ist und passt, übernimm diese Kategorie.\n'
      + 'Format: {"ergebnisse":[{"nr":1,"kategorie":"…","tags":["…"],"bedarf":"notwendig","sicherheit":90,"grund":"…"}]}',
    { answer: 120 + batch.length * 90, ...opts });
    const cats = scheme ? scheme.map((c) => c.name) : existing.categories;
    return (out.ergebnisse || out.results || []).map((r) => {
      let tags = [...new Set((Array.isArray(r.tags) ? r.tags : []).map((x) => matchPool(String(x).slice(0, 30), existing.tags)).filter(Boolean))].slice(0, 3);
      if (freedom === 'vorhanden') tags = tags.filter((x) => existing.tags.includes(x));
      return {
        nr: Number(r.nr),
        kategorie: matchPool(String(r.kategorie || '').slice(0, 40), cats),
        tags,
        bedarf: NEEDS.includes(String(r.bedarf).toLowerCase()) ? String(r.bedarf).toLowerCase() : null,
        sicherheit: Math.max(0, Math.min(100, Math.round(Number(r.sicherheit) || 0))),
        grund: String(r.grund || '').slice(0, 120),
      };
    });
  }

  async function run(mode, scope) {
    if (job && !job.finished) throw new Error('Es läuft bereits eine Analyse.');
    const ctrl = new AbortController();
    job = { mode, total: 0, done: 0, errors: 0, startedAt: new Date().toISOString(), stop: false, ctrl, message: 'Lade Buchungen …' };
    const waiting = (what) => (parts) => {
      job.message = parts ? `${what} (${parts} Teile empfangen)` : what;
    };
    (async () => {
      try {
        poolCache = null; // frischer Bestand für den Vergleich „neu / vorhanden“
        const [list, existing] = await Promise.all([merchants(), pool()]);
        const data = labelsFile.read();
        const { model, freedom } = settingsFile.read();
        if (mode === 'scheme') {
          job.message = 'Entwerfe Kategoriesystem … (beim ersten Mal lädt Ollama das Modell)';
          const opts = { signal: ctrl.signal, onProgress: waiting('Entwerfe Kategoriesystem …') };
          let kategorien;
          try {
            kategorien = await proposeScheme(list, existing.categories, opts);
          } catch (err) {
            if (!(err instanceof Timeout)) throw err;
            // zu langsam für 80 Händler → mit den 40 größten noch einmal
            job.note = "Ollama antwortet langsam – Kategoriesystem aus den 40 größten Händlern.";
            kategorien = await proposeScheme(list.slice(0, 40), existing.categories, opts);
          }
          data.scheme = { at: new Date().toISOString(), model, kategorien };
          data.labels = {}; // neues System → alles neu einordnen
          labelsFile.write(data);
        }
        const todo = list.filter((g) => scope === 'all' || mode === 'scheme' || !data.labels[g.key]);
        job.total = todo.length;
        job.message = todo.length ? 'Ordne Händler ein … (beim ersten Mal lädt Ollama das Modell)' : 'Alle Händler sind bereits bewertet.';
        const fr = FREEDOM.includes(freedom) ? freedom : 'sinnvoll';
        const store = (batch, results) => {
          for (const r of results) {
            const g = batch[r.nr - 1];
            if (!g || !r.kategorie) continue;
            // Entscheidung aus dem Dashboard behalten, solange die KI dasselbe vorschlägt
            const prev = data.labels[g.key];
            const status = prev?.status && prev.kategorie === r.kategorie ? prev.status : undefined;
            data.labels[g.key] = { name: g.name, via: g.via, match: g.match, n: g.n, sum: Math.round(g.sum * 100) / 100, ...r, ...(status && { status }), model, at: new Date().toISOString() };
          }
        };
        let size = BATCH; // wird kleiner, sobald Ollama für ein Paket zu lange braucht
        /** Paket einordnen; dauert es zu lange, in zwei Hälften noch einmal versuchen. */
        const work = async (batch) => {
          if (job.stop) return;
          try {
            store(batch, await classify(batch, existing, data.scheme?.kategorien || null, fr,
              { signal: ctrl.signal, onProgress: waiting(`Ordne Händler ein … ${job.done + 1}–${job.done + batch.length} von ${job.total}`) }));
            job.done += batch.length;
          } catch (err) {
            if (err instanceof Timeout && batch.length > 1 && !job.stop) {
              const half = Math.ceil(batch.length / 2);
              size = Math.min(size, half);
              job.note = `Ollama antwortet langsam – Pakete auf ${size} Händler verkleinert.`;
              log(`KI-Analyse: ${err.message} – teile das Paket (${batch.length} → ${half})`);
              await work(batch.slice(0, half));
              await work(batch.slice(half));
              return;
            }
            if (job.stop) return;
            job.errors += 1;
            job.lastError = err.message;
            job.done += batch.length;
            log(`KI-Analyse: ${err.message}`);
          }
          labelsFile.write(data); // Zwischenstand sichern – Abbruch verliert nichts
        };
        for (let i = 0; i < todo.length && !job.stop;) {
          const batch = todo.slice(i, i + size);
          i += batch.length;
          await work(batch);
        }
        labelsFile.write(data);
        job.message = job.stop ? 'Angehalten.' : `Fertig: ${job.done} Händler bewertet${job.errors ? `, ${job.errors} Pakete mit Fehler` : ''}.`;
      } catch (err) {
        job.message = job.stop ? 'Angehalten.' : `Fehler: ${err.message}`;
        if (!job.stop) job.errors += 1;
      } finally {
        job.finished = true;
        job.finishedAt = new Date().toISOString();
      }
    })();
  }

  // ---- HTTP -----------------------------------------------------------------------
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
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
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'firefly-dashboard') return json(403, { message: 'Anfrage abgelehnt.' });
    const p = url.pathname.replace('/local/ai/', '');
    try {
      if (p === 'settings') {
        if (req.method === 'PUT') {
          const input = await readJson(req);
          const cur = settingsFile.read();
          let next = cur.url;
          if (input.url !== undefined) {
            const u = new URL(String(input.url).trim());
            if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Nur http:// und https:// werden unterstützt.');
            next = u.toString();
          }
          settingsFile.write({
            url: next,
            model: input.model !== undefined ? String(input.model).slice(0, 100) : cur.model,
            freedom: FREEDOM.includes(input.freedom) ? input.freedom : cur.freedom,
            wait: WAIT_CHOICES.includes(Number(input.wait)) ? Number(input.wait) : cur.wait,
            layer: input.layer && typeof input.layer === 'object'
              ? { on: Boolean(input.layer.on), min: Math.max(0, Math.min(100, Math.round(Number(input.layer.min) || 80))) }
              : cur.layer,
          });
        }
        return json(200, settingsFile.read());
      }
      if (p === 'models') return json(200, { models: await listModels() });
      if (p === 'preview') {
        // Was die KI je Händler zu sehen bekommt + wie aussagekräftig die Daten sind
        const list = await merchants();
        return json(200, { quality: list.quality, merchants: list.length, lines: list.slice(0, 8).map(describe) });
      }
      if (p === 'ask' && req.method === 'POST') {
        const input = await readJson(req);
        const frage = String(input.frage || '').trim().slice(0, 300);
        if (!frage) throw new Error('Keine Frage.');
        // abbrechbar: Knopf „Abbrechen“ (ask/stop) oder Verbindung zu → Anfrage an Ollama sofort beenden
        const ctrl = new AbortController();
        asking.add(ctrl);
        res.on('close', () => !res.writableFinished && ctrl.abort());
        try {
          return json(200, await ask(frage, ['auto', 'schnell', 'ki'].includes(input.modus) ? input.modus : 'auto', ctrl.signal));
        } catch (err) {
          if (ctrl.signal.aborted) return res.writableEnded || res.destroyed ? undefined : json(499, { message: 'Abgebrochen.' });
          throw err;
        } finally {
          asking.delete(ctrl);
        }
      }
      if (p === 'ask/stop' && req.method === 'POST') {
        for (const c of asking) c.abort();
        return json(200, { ok: true, stopped: asking.size });
      }
      if (p === 'test' && req.method === 'POST') {
        test();
        return json(202, { ok: true });
      }
      if (p === 'status') {
        const data = labelsFile.read();
        const existing = await pool().catch(() => ({ categories: [], tags: [] }));
        return json(200, { job: job && { ...job, stop: undefined, ctrl: undefined }, test: probe && { ...probe, ctrl: undefined }, scheme: data.scheme, labels: data.labels, decisions: data.decisions, pool: existing, settings: settingsFile.read() });
      }
      if (p === 'review' && req.method === 'PUT') {
        // Entscheidungen im Dashboard: je Händler annehmen/ablehnen, neue Namen umbenennen/zusammenlegen/ignorieren
        const input = await readJson(req);
        const data = labelsFile.read();
        for (const [key, st] of Object.entries(input.status || {})) {
          if (!data.labels[key]) continue;
          if (st === 'ok' || st === 'nein') data.labels[key].status = st;
          else delete data.labels[key].status;
        }
        for (const kind of ['categories', 'tags']) {
          for (const [name, target] of Object.entries(input[kind] || {})) {
            const n = String(name).slice(0, 40);
            if (target === undefined || target === n) delete data.decisions[kind][n];
            else data.decisions[kind][n] = target === null ? null : String(target).trim().slice(0, 40) || null;
          }
        }
        labelsFile.write(data);
        return json(200, { ok: true });
      }
      if (p === 'run' && req.method === 'POST') {
        const input = await readJson(req);
        await run(input.mode === 'scheme' ? 'scheme' : 'classify', input.scope === 'all' ? 'all' : 'open');
        return json(202, { ok: true });
      }
      if (p === 'stop' && req.method === 'POST') {
        if (job) {
          job.stop = true;
          job.ctrl?.abort(); // laufende Anfrage an Ollama sofort beenden
        }
        probe?.ctrl?.abort();
        return json(200, { ok: true });
      }
      if (p === 'labels' && req.method === 'DELETE') {
        labelsFile.write(structuredClone(EMPTY));
        return json(200, { ok: true });
      }
      return json(404, { message: 'Unbekannt.' });
    } catch (err) {
      return json(400, { message: err.message });
    }
  };
}
