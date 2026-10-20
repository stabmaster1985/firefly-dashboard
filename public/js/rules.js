// Regel-Engine für das Kategorien-Labor: eigene Regeln, automatische Tags
// und Regel-Vorschläge – alles nur als Probe im Dashboard, Firefly bleibt
// unverändert. Bewusst ohne KI: Händlerliste + deine bisherigen Kategorien.

export const FIELDS = {
  party: 'Empfänger / Zahler',
  description: 'Beschreibung',
  amount: 'Betrag',
  account: 'Konto',
  category: 'Firefly-Kategorie',
  date: 'Datum',
};

export const OPS = {
  contains: 'enthält',
  equals: 'ist genau',
  startsWith: 'beginnt mit',
  regex: 'passt zu (Regex)',
  gt: 'größer als',
  lt: 'kleiner als',
  between: 'zwischen',
};

export const AUTO_TAGS = {
  abo: 'Abo / Fixkosten',
  online: 'Online',
  bargeld: 'Bargeld',
  wochenende: 'Wochenende',
  gross: 'Große Ausgabe',
  klein: 'Kleinbetrag',
};

/** Gängige Händler → Kategorie (Stichworte, kleingeschrieben). */
const MERCHANTS = [
  ['Lebensmittel', ['rewe', 'edeka', 'aldi', 'lidl', 'kaufland', 'netto', 'penny', 'norma', 'globus', 'tegut', 'denns', 'alnatura', 'hit markt', 'marktkauf', 'wochenmarkt', 'bäckerei', 'baeckerei']],
  ['Drogerie', ['dm-drogerie', 'dm drogerie', 'rossmann', 'müller drogerie', 'budni']],
  ['Mobilität', ['aral', 'shell', 'esso', 'jet ', 'jet-', 'totalenergies', 'agip', 'avia', 'star tankstelle', 'deutsche bahn', 'db vertrieb', 'db fernverkehr', 'bvg', 'mvv', 'hvv', 'vrr', 'flixbus', 'uber', 'bolt', 'freenow', 'free now', 'sixt', 'share now', 'parkhaus', 'deutschlandticket']],
  ['Shopping', ['amazon', 'zalando', 'otto ', 'ebay', 'about you', 'mediamarkt', 'saturn', 'ikea', 'h&m', 'zara', 'decathlon', 'thalia', 'vinted', 'etsy', 'galaxus', 'kleinanzeigen']],
  ['Abos', ['netflix', 'spotify', 'disney', 'dazn', 'sky deutschland', 'apple.com', 'google play', 'youtube', 'audible', 'prime video', 'chatgpt', 'openai', 'icloud']],
  ['Restaurant', ['lieferando', 'mcdonald', 'burger king', 'starbucks', 'subway', 'wolt', 'pizzeria', 'restaurant', 'café', 'cafe ', 'sushi', 'döner', 'doener']],
  ['Nebenkosten', ['telekom', 'vodafone', 'o2 ', 'telefonica', '1&1', 'congstar', 'stadtwerke', 'e.on', 'eon ', 'vattenfall', 'enbw', 'rundfunk', 'gez']],
  ['Versicherung', ['huk', 'allianz', 'axa', 'ergo', 'devk', 'generali', 'signal iduna', 'versicherung']],
  ['Gesundheit', ['apotheke', 'docmorris', 'shop-apotheke', 'zahnarzt', 'praxis', 'physiotherapie', 'optiker', 'fielmann']],
];
/** Wie die Kategorien bei dir heißen könnten – eigene Namen haben Vorrang. */
const SYNONYMS = {
  Lebensmittel: ['lebensmittel', 'einkauf', 'supermarkt', 'essen'],
  Drogerie: ['drogerie', 'haushalt', 'körperpflege'],
  Mobilität: ['mobilität', 'auto', 'tanken', 'kfz', 'verkehr', 'fahrt'],
  Shopping: ['shopping', 'einkäufe', 'kleidung', 'online'],
  Abos: ['abo', 'streaming', 'mitglied'],
  Restaurant: ['restaurant', 'essen gehen', 'ausgehen', 'gastro'],
  Nebenkosten: ['nebenkosten', 'strom', 'internet', 'telefon', 'wohnen'],
  Versicherung: ['versicherung'],
  Gesundheit: ['gesundheit', 'arzt', 'apotheke'],
};
const ONLINE = ['paypal', 'amazon', 'zalando', 'ebay', 'klarna', 'otto ', 'etsy', 'vinted', 'apple.com', 'google'];

const lower = (s) => String(s ?? '').toLowerCase();
/** Zahlungsdienste: dahinter stecken verschiedene Händler → nach Buchungstext gruppieren. */
const INTERMEDIARIES = ['paypal', 'klarna', 'sumup', 'stripe', 'adyen', 'amazon payments', 'apple pay', 'google pay', 'sofort', 'giropay', 'mollie', 'unzer', 'payone', 'computop'];
const isIntermediary = (party) => INTERMEDIARIES.some((w) => lower(party).includes(w));
/** Kennwort aus dem Buchungstext, z. B. „PayPal *DisneyPlus 123456“ → „disneyplus“. */
const textKey = (t) => normParty(String(t.description).replace(/^(paypal|klarna|sumup)\s*\*?/i, '')).split(' ').filter((w) => w.length > 2).slice(0, 2).join(' ');
export const counterpartyOf = (t) => (t.type === 'deposit' ? t.source_name : t.destination_name) || '';
export const normParty = (s) => lower(s).replace(/[0-9]+/g, ' ').replace(/[^\p{L}& ]+/gu, ' ').replace(/\s+/g, ' ').trim();

function fieldValue(t, field) {
  if (field === 'party') return counterpartyOf(t);
  if (field === 'description') return t.description;
  if (field === 'amount') return t.amount;
  if (field === 'account') return t.type === 'deposit' ? t.destination_name : t.source_name;
  if (field === 'category') return t.category_name || '';
  if (field === 'date') return String(t.date).slice(0, 10);
  return '';
}

function test(cond, t) {
  const v = fieldValue(t, cond.field);
  if (cond.field === 'date') {
    // ISO-Daten lassen sich als Text vergleichen
    if (cond.op === 'between') return v >= cond.value && v <= cond.value2;
    if (cond.op === 'gt') return v > cond.value;
    if (cond.op === 'lt') return v < cond.value;
    if (cond.op === 'equals') return v === cond.value;
    return false;
  }
  if (cond.field === 'amount') {
    const a = Number(v);
    const x = Number(cond.value);
    if (cond.op === 'gt') return a > x;
    if (cond.op === 'lt') return a < x;
    if (cond.op === 'between') return a >= x && a <= Number(cond.value2);
    if (cond.op === 'equals') return Math.abs(a - x) < 0.005;
    return false;
  }
  const s = lower(v);
  const q = lower(cond.value);
  if (cond.op === 'contains') return q !== '' && s.includes(q);
  if (cond.op === 'equals') return s === q;
  if (cond.op === 'startsWith') return q !== '' && s.startsWith(q);
  if (cond.op === 'regex') {
    try {
      return new RegExp(cond.value, 'i').test(String(v));
    } catch {
      return false;
    }
  }
  return false;
}

export const ruleMatches = (rule, t) => rule.enabled !== false && (rule.when || []).length > 0 && rule.when.every((c) => test(c, t));

/**
 * Wendet Regeln (Reihenfolge zählt: erste Kategorie-Regel gewinnt; Tags
 * sammeln sich) und automatische Tags auf eine Buchung an.
 */
export function applyRules(t, rules, { autoTags = [], recurringParties = new Set(), bigFrom = 250 } = {}) {
  let category = t.category_name || null;
  let setBy = null;
  const tags = new Set();
  const hits = [];
  for (const rule of rules) {
    if (!ruleMatches(rule, t)) continue;
    hits.push(rule.id);
    if (rule.setCategory && !setBy) {
      category = rule.setCategory;
      setBy = rule.id;
    }
    (rule.addTags || []).forEach((tag) => tag && tags.add(tag));
  }
  const auto = new Set(autoTags);
  const party = lower(counterpartyOf(t));
  const day = new Date(String(t.date).slice(0, 10)).getDay();
  if (auto.has('abo') && recurringParties.has(normParty(counterpartyOf(t)))) tags.add(AUTO_TAGS.abo);
  if (auto.has('online') && ONLINE.some((w) => party.includes(w) || lower(t.description).includes(w))) tags.add(AUTO_TAGS.online);
  if (auto.has('bargeld') && /geldautomat|bargeld|atm|cash/.test(`${party} ${lower(t.description)}`)) tags.add(AUTO_TAGS.bargeld);
  if (auto.has('wochenende') && (day === 0 || day === 6)) tags.add(AUTO_TAGS.wochenende);
  if (auto.has('gross') && t.type === 'withdrawal' && t.amount >= bigFrom) tags.add(AUTO_TAGS.gross);
  if (auto.has('klein') && t.type === 'withdrawal' && t.amount < 10) tags.add(AUTO_TAGS.klein);
  return { category, changed: category !== (t.category_name || null), tags: [...tags], hits };
}

let seq = 0;
const newId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Regel-Vorschläge aus den Daten:
 *  1) Uneinheitlich: gleicher Empfänger in mehreren Kategorien → Mehrheit
 *  2) Ohne Kategorie: Empfänger, der sonst eindeutig kategorisiert ist
 *  3) Händlerliste: bekannte Händler, die noch nicht passend kategorisiert sind
 * Jeder Vorschlag sagt, wie viele Buchungen er ändern würde.
 */
export function suggestRules(txs, existingRules = [], knownCategories = []) {
  const out = [];
  const covered = (t) => existingRules.some((r) => r.setCategory && ruleMatches(r, t));
  const expenses = txs.filter((t) => t.type === 'withdrawal' && !covered(t));
  const byParty = new Map();
  for (const t of expenses) {
    // Zahlungsdienste nach Buchungstext, alle anderen nach Empfänger
    const via = isIntermediary(counterpartyOf(t));
    const key = via ? `text:${textKey(t)}` : normParty(counterpartyOf(t));
    if (key.length < 2 || key === 'text:') continue;
    if (!byParty.has(key)) byParty.set(key, { name: via ? textKey(t) : counterpartyOf(t), via, list: [] });
    byParty.get(key).list.push(t);
  }
  const used = new Set();
  for (const [key, { name, via, list }] of byParty) {
    const cats = new Map();
    list.filter((t) => t.category_name).forEach((t) => cats.set(t.category_name, (cats.get(t.category_name) || 0) + 1));
    const categorized = [...cats.values()].reduce((a, n) => a + n, 0);
    if (!categorized) continue;
    const [top, n] = [...cats].sort((a, b) => b[1] - a[1])[0];
    const share = n / categorized;
    const changes = list.filter((t) => t.category_name !== top).length;
    const missing = list.filter((t) => !t.category_name).length;
    if (changes === 0 || n < 2 || share < 0.6) continue;
    used.add(key);
    out.push({
      id: newId(),
      kind: missing === changes ? 'ohne' : 'uneinheitlich',
      reason: missing === changes
        ? `${missing}× ohne Kategorie, sonst ${n}× „${top}“`
        : `uneinheitlich: ${n}× „${top}“, ${changes}× anders${missing ? ` (davon ${missing} ohne)` : ''}`,
      changes,
      rule: { id: newId(), enabled: true, when: [via ? { field: 'description', op: 'contains', value: name } : { field: 'party', op: 'equals', value: name }], setCategory: top, addTags: [] },
    });
  }
  // Händlerliste – nur Kategorien vorschlagen, die es bei dir schon gibt (oder neu markieren)
  const known = new Map(knownCategories.map((c) => [lower(c), c]));
  const findKnown = (category) => known.get(lower(category))
    || [...known.values()].find((c) => (SYNONYMS[category] || [lower(category)]).some((syn) => lower(c).includes(syn)));
  for (const [category, words] of MERCHANTS) {
    const target = findKnown(category) || category;
    for (const w of words) {
      const hits = expenses.filter((t) => {
        const via = isIntermediary(counterpartyOf(t));
        if (used.has(via ? `text:${textKey(t)}` : normParty(counterpartyOf(t)))) return false;
        return (!via && lower(counterpartyOf(t)).includes(w)) || lower(t.description).includes(w);
      });
      const changes = hits.filter((t) => t.category_name !== target).length;
      if (!changes) continue;
      out.push({
        id: newId(),
        kind: 'haendler',
        reason: `bekannter Händler „${w.trim()}“ → ${target}${known.has(lower(target)) ? '' : ' (neue Kategorie)'}`,
        changes,
        rule: { id: newId(), enabled: true, when: [{ field: hits.every((t) => lower(counterpartyOf(t)).includes(w)) ? 'party' : 'description', op: 'contains', value: w.trim() }], setCategory: target, addTags: [] },
      });
    }
  }
  return out.sort((a, b) => b.changes - a.changes);
}

/** Kurzbeschreibung einer Regel für die Liste. */
export function describeRule(rule) {
  const cond = (rule.when || []).map((c) => {
    const short = (v) => (String(v).length > 60 ? `${String(v).slice(0, 57)}…` : v);
    const val = c.op === 'between' ? `${c.value} und ${c.value2}` : `„${short(c.value)}“`;
    return `${FIELDS[c.field] || c.field} ${OPS[c.op] || c.op} ${val}`;
  }).join(' und ');
  const act = [rule.setCategory ? `Kategorie „${rule.setCategory}“` : '', ...(rule.addTags || []).map((t) => `Tag „${t}“`)].filter(Boolean).join(', ');
  return { cond: cond || '–', act: act || '–' };
}

/**
 * Regeln als Firefly-Regeln (für POST /api/v1/rules oder zum Nachbauen in
 * Firefly unter Automatisierung → Regeln). Regex wird nicht unterstützt.
 */
export function toFireflyRules(rules) {
  const TRIGGER = {
    party: { contains: 'destination_account_contains', equals: 'destination_account_is', startsWith: 'destination_account_starts' },
    description: { contains: 'description_contains', equals: 'description_is', startsWith: 'description_starts' },
    amount: { gt: 'amount_more', lt: 'amount_less', equals: 'amount_exactly' },
    account: { contains: 'source_account_contains', equals: 'source_account_is', startsWith: 'source_account_starts' },
    category: { equals: 'category_is' },
    date: { equals: 'date_on', gt: 'date_after', lt: 'date_before' },
  };
  const shift = (iso, days) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return rules.filter((r) => r.enabled !== false).map((r) => {
    const triggers = [];
    let unsupported = false;
    for (const c of r.when || []) {
      if (c.field === 'amount' && c.op === 'between') {
        triggers.push({ type: 'amount_more', value: String(c.value) }, { type: 'amount_less', value: String(c.value2) });
        continue;
      }
      if (c.field === 'date' && c.op === 'between') {
        // Firefly: date_after/date_before ohne den Tag selbst
        triggers.push({ type: 'date_after', value: shift(c.value, -1) }, { type: 'date_before', value: shift(c.value2, 1) });
        continue;
      }
      const type = TRIGGER[c.field]?.[c.op];
      if (type) triggers.push({ type, value: String(c.value) });
      else unsupported = true;
    }
    const actions = [
      ...(r.setCategory ? [{ type: 'set_category', value: r.setCategory }] : []),
      ...(r.addTags || []).map((t) => ({ type: 'add_tag', value: t })),
    ];
    const { cond, act } = describeRule(r);
    return {
      labor_id: r.id,
      title: `${cond} → ${act}`.slice(0, 250),
      trigger: 'store-journal',
      active: true,
      strict: true,
      stop_processing: false,
      triggers,
      actions,
      ...(unsupported ? { hinweis: 'Enthält eine Bedingung, die Firefly so nicht kennt (z. B. Regex) – bitte von Hand anpassen.' } : {}),
    };
  });
}
