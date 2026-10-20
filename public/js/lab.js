// Kategorien-Labor: alle Buchungen mit eigenen Regeln probeweise neu
// kategorisieren und taggen. Nichts wird in Firefly geändert – erst ein
// Export (Firefly-Regeln, CSV oder n8n) macht es auf Wunsch dauerhaft.

import * as api from './api.js';
import { money, esc, fmtDate, today, debounce } from './util.js';
import { skeleton, card, stat, sum, mainCurrency, downloadCsv, txAttrs, bindTxDetails } from './common.js';
import { detectRecurring } from './recurring.js';
import { FIELDS, OPS, AUTO_TAGS, applyRules, suggestRules, describeRule, toFireflyRules, counterpartyOf, normParty, ruleMatches } from './rules.js';

const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'firefly-dashboard' };
const BASES = {
  ausgaben: { label: 'Ausgaben', type: 'withdrawal' },
  einnahmen: { label: 'Einnahmen', type: 'deposit' },
};

export async function lab(view, { params }) {
  const baseKey = BASES[params.get('basis')] ? params.get('basis') : 'ausgaben';
  const base = BASES[baseKey];
  const t0 = today();
  const from = new Date(t0.getFullYear(), t0.getMonth() - 24, 1); // gleicher Cache wie „Wiederkehrend“

  view.innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Grundlage">${Object.entries(BASES)
        .map(([k, b]) => `<a class="chip" href="#/labor${k === 'ausgaben' ? '' : `?basis=${k}`}" aria-pressed="${k === baseKey}">${b.label}</a>`).join('')}</div>
      <div class="chips" role="group" aria-label="Automatische Tags" id="lab-auto"></div>
      <span class="meta-line">Nur Probe – Firefly bleibt unverändert · Buchungen seit ${fmtDate(from)}</span>
    </div>
    <div class="grid">
      <section class="card span-3" id="l-count"></section>
      <section class="card span-3" id="l-changed"></section>
      <section class="card span-3" id="l-none"></section>
      <section class="card span-3" id="l-tags"></section>
      ${card('l-rules', 'Deine Regeln', { span: 'span-7', link: '<span class="lab-export"><button class="link-btn" data-export="firefly">Als Firefly-Regeln ↓</button> · <button class="link-btn" data-export="csv">Änderungen als CSV ↓</button><span id="l-n8n"></span></span>' })}
      ${card('l-suggest', 'Vorschläge', { span: 'span-5', meta: '<span id="l-suggest-meta"></span>' })}
      ${card('l-compare', 'Kategorien vorher / nachher', { span: 'span-7', filter: true })}
      ${card('l-tagtable', 'Tags (Probe)', { span: 'span-5' })}
      ${card('l-tx', 'Buchungen', { filter: true, meta: '<span id="l-tx-chips"></span>' })}
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  ['l-count', 'l-changed', 'l-none', 'l-tags'].forEach((id) => ($(id).innerHTML = skeleton(2, 22)));
  ['l-rules', 'l-suggest', 'l-compare', 'l-tagtable', 'l-tx'].forEach((id) => ($(id).innerHTML = skeleton(5)));

  let txs;
  let stored;
  let categorizeAction;
  try {
    [txs, stored, categorizeAction] = await Promise.all([
      api.getAll('transactions', { start: from, end: t0, type: base.type })
        .then((groups) => api.flattenTransactions(groups).filter((t) => t.type === base.type)),
      fetch('/local/rules').then((r) => r.json()),
      fetch('/local/actions').then((r) => r.json()).then((l) => l.find((a) => a.trigger === 'categorize') || null).catch(() => null),
    ]);
  } catch (err) {
    view.querySelector('.grid').innerHTML = `<section class="card span-12"><div class="empty">Konnte nicht geladen werden: ${esc(err.message)}</div></section>`;
    return;
  }
  if (!view.isConnected) return;

  let rules = stored.rules || [];
  let autoTags = stored.autoTags || [];
  let txMode = 'changed';
  let tagFilter = null;
  const code = mainCurrency(txs);
  const knownCategories = [...new Set(txs.map((t) => t.category_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const recurringParties = new Set(detectRecurring(txs, base.type === 'deposit' ? 'income' : 'expense').items
    .filter((r) => r.active).map((r) => normParty(r.party || r.name)));

  const save = debounce(() => fetch('/local/rules', { method: 'PUT', headers, body: JSON.stringify({ rules, autoTags }) }).catch(() => {}), 400);

  /** Alle Buchungen mit den aktuellen Regeln durchrechnen. */
  const compute = () => txs.map((t) => ({ t, r: applyRules(t, rules, { autoTags, recurringParties }) }));

  function render() {
    const results = compute();
    const changed = results.filter((x) => x.r.changed);
    const tagged = results.filter((x) => x.r.tags.length);
    const noneBefore = results.filter((x) => !x.t.category_name).length;
    const noneAfter = results.filter((x) => !x.r.category).length;

    $('l-count').innerHTML = stat('Buchungen', String(results.length), `${base.label} seit ${fmtDate(from, { month: 'short', year: 'numeric' })}`);
    $('l-changed').innerHTML = stat('Neu kategorisiert', String(changed.length), `zusammen ${money(sum(changed, (x) => x.t.amount), code)}`);
    $('l-none').innerHTML = stat('Ohne Kategorie', `${noneBefore} → ${noneAfter}`, noneBefore ? `${Math.round((1 - noneAfter / noneBefore) * 100)} % davon zugeordnet` : 'war schon alles zugeordnet');
    $('l-tags').innerHTML = stat('Getaggt', String(tagged.length), `${new Set(tagged.flatMap((x) => x.r.tags)).size} verschiedene Tags`);

    renderAuto();
    renderRules(results);
    renderSuggestions();
    renderCompare(results);
    renderTags(tagged);
    renderTx(results);
  }

  function renderAuto() {
    $('lab-auto').innerHTML = `<span class="muted chip-label">Auto-Tags:</span>${Object.entries(AUTO_TAGS)
      .map(([k, label]) => `<button class="chip small" data-auto="${k}" aria-pressed="${autoTags.includes(k)}">${label}</button>`).join('')}`;
  }

  function renderRules(results) {
    const count = (rule) => results.filter((x) => x.r.hits.includes(rule.id)).length;
    const fieldOpts = Object.entries(FIELDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    const opOpts = Object.entries(OPS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    $('l-rules').innerHTML = `${rules.length ? `<div class="rule-list">${rules.map((rule, i) => {
      const d = describeRule(rule);
      return `<div class="rule${rule.enabled === false ? ' off' : ''}" data-i="${i}">
        <label class="rule-toggle" title="Regel an/aus"><input type="checkbox" data-toggle ${rule.enabled === false ? '' : 'checked'}></label>
        <div class="rule-text"><div>Wenn ${esc(d.cond)}</div><div class="muted">→ ${esc(d.act)}</div></div>
        <span class="badge">${count(rule)}×</span>
        <span class="rule-btns"><button class="icon-btn small" data-up title="nach oben" ${i ? '' : 'disabled'}>↑</button><button class="icon-btn small" data-del title="Regel löschen">✕</button></span>
      </div>`;
    }).join('')}</div>` : '<div class="empty">Noch keine Regeln – übernimm rechts einen Vorschlag oder lege unten eine an.</div>'}
      <form class="rule-form" id="rule-form">
        <select name="field">${fieldOpts}</select><select name="op">${opOpts}</select>
        <input name="value" placeholder="Wert, z. B. REWE" required><input name="value2" placeholder="bis" hidden>
        <span class="muted">→</span>
        <input name="setCategory" placeholder="Kategorie" list="lab-cats"><input name="addTags" placeholder="Tags (mit Komma)">
        <button class="btn primary">Hinzufügen</button>
        <datalist id="lab-cats">${knownCategories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      </form>
      <div class="legend" style="margin-top:8px"><span>Reihenfolge zählt: Die erste passende Regel bestimmt die Kategorie, Tags sammeln sich.</span></div>`;
    $('l-n8n').innerHTML = categorizeAction ? ` · <button class="link-btn" data-export="n8n">An n8n übergeben</button>` : '';
  }

  function renderSuggestions() {
    const list = suggestRules(txs, rules, knownCategories).slice(0, 25);
    $('l-suggest-meta').textContent = list.length ? `${list.length} gefunden` : '';
    $('l-suggest').innerHTML = list.length
      ? `<div class="list">${list.map((s, i) => {
        const d = describeRule(s.rule);
        return `<div class="row suggestion"><div class="avatar kind-${s.kind}">${s.kind === 'haendler' ? 'H' : s.kind === 'ohne' ? '?' : '≠'}</div>
          <div style="min-width:0"><div class="title">${esc(d.cond)} → ${esc(s.rule.setCategory)}</div><div class="subtitle">${esc(s.reason)}</div></div>
          <div class="amount"><button class="btn small" data-take="${i}">+ ${s.changes}</button></div></div>`;
      }).join('')}</div>${list.length > 1 ? '<div class="more"><button class="btn" data-take-all>Alle übernehmen</button></div>' : ''}`
      : '<div class="empty">Keine weiteren Vorschläge – sieht aufgeräumt aus.</div>';
    $('l-suggest').suggestions = list;
  }

  function renderCompare(results) {
    const before = new Map();
    const after = new Map();
    for (const { t, r } of results) {
      const b = t.category_name || 'Ohne Kategorie';
      const a = r.category || 'Ohne Kategorie';
      before.set(b, (before.get(b) || 0) + t.amount);
      after.set(a, (after.get(a) || 0) + t.amount);
    }
    const names = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => (after.get(y) || 0) - (after.get(x) || 0));
    $('l-compare').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Kategorie</th><th class="num">Firefly</th><th class="num">Probe</th><th class="num">Unterschied</th></tr></thead><tbody>${names
      .map((n) => {
        const b = before.get(n) || 0;
        const a = after.get(n) || 0;
        const d = a - b;
        return `<tr style="cursor:default"><td>${esc(n)}${before.has(n) ? '' : ' <span class="badge">neu</span>'}</td><td class="num muted">${money(b, code)}</td>
          <td class="num"><b>${money(a, code)}</b></td><td class="num ${Math.abs(d) < 0.01 ? 'muted' : ''}">${Math.abs(d) < 0.01 ? '–' : money(d, code, { signed: true })}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function renderTags(tagged) {
    const byTag = new Map();
    for (const { t, r } of tagged) for (const tag of r.tags) {
      const g = byTag.get(tag) || { n: 0, sum: 0 };
      g.n += 1;
      g.sum += t.amount;
      byTag.set(tag, g);
    }
    const total = sum(txs, (t) => t.amount);
    $('l-tagtable').innerHTML = byTag.size
      ? `<div class="list">${[...byTag].sort((a, b) => b[1].sum - a[1].sum).map(([tag, g]) => `<button class="row plain tag-row${tagFilter === tag ? ' active' : ''}" data-tag="${esc(tag)}">
          <div class="avatar">#</div><div style="min-width:0;text-align:left"><div class="title">${esc(tag)}</div><div class="subtitle">${g.n} Buchungen · ${Math.round((g.sum / total) * 100)} % der ${base.label}</div></div>
          <div class="amount">${money(g.sum, code)}</div></button>`).join('')}</div>
        <div class="legend" style="margin-top:8px"><span>Tag anklicken zeigt die Buchungen unten</span></div>`
      : '<div class="empty">Noch keine Tags – Auto-Tags oben einschalten oder Regeln mit Tags anlegen.</div>';
  }

  function renderTx(results) {
    let rows = txMode === 'changed' ? results.filter((x) => x.r.changed) : txMode === 'none' ? results.filter((x) => !x.r.category) : results;
    if (tagFilter) rows = results.filter((x) => x.r.tags.includes(tagFilter));
    rows = [...rows].sort((a, b) => String(b.t.date).localeCompare(String(a.t.date)));
    $('l-tx-chips').innerHTML = tagFilter
      ? `<span class="chip small" aria-pressed="true">#${esc(tagFilter)} <button class="chip-x" data-untag>✕</button></span>`
      : `${[['changed', 'Geänderte'], ['none', 'Ohne Kategorie'], ['all', 'Alle']]
        .map(([k, l]) => `<button class="link-btn" data-mode="${k}" aria-pressed="${k === txMode}">${l}</button>`).join(' · ')}`;
    $('l-tx').innerHTML = rows.length
      ? `<div class="table-wrap scroll"><table><tbody>${rows.slice(0, 500).map(({ t, r }, i) => `<tr ${txAttrs(i)}>
          <td class="date">${fmtDate(t.date)}</td>
          <td><div class="desc">${esc(t.description)}</div><div class="flow">${esc(counterpartyOf(t))}</div></td>
          <td>${r.changed ? `<span class="muted strike">${esc(t.category_name || 'ohne')}</span> → <b>${esc(r.category || 'ohne')}</b>` : esc(r.category || '–')}
            ${r.tags.length ? `<div>${r.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}</td>
          <td class="num">${money(t.amount, t.currency_code)}</td></tr>`).join('')}</tbody></table></div>
        ${rows.length > 500 ? `<div class="legend" style="margin-top:8px"><span>Die ersten 500 von ${rows.length}</span></div>` : ''}`
      : `<div class="empty">${txMode === 'changed' && !tagFilter ? 'Noch keine Änderungen – lege Regeln an oder übernimm Vorschläge.' : 'Keine Buchungen.'}</div>`;
    bindTxDetails($('l-tx'), (i) => rows[Number(i)]?.t);
  }

  // ---- Bedienung --------------------------------------------------------------
  view.addEventListener('click', (e) => {
    const auto = e.target.closest('[data-auto]');
    if (auto) {
      const k = auto.dataset.auto;
      autoTags = autoTags.includes(k) ? autoTags.filter((x) => x !== k) : [...autoTags, k];
      save();
      return render();
    }
    const take = e.target.closest('[data-take]');
    if (take) {
      rules = [...rules, $('l-suggest').suggestions[Number(take.dataset.take)].rule];
      save();
      return render();
    }
    if (e.target.closest('[data-take-all]')) {
      rules = [...rules, ...$('l-suggest').suggestions.map((s) => s.rule)];
      save();
      return render();
    }
    const ruleEl = e.target.closest('.rule');
    if (ruleEl && e.target.closest('[data-del]')) {
      rules = rules.filter((_, i) => i !== Number(ruleEl.dataset.i));
      save();
      return render();
    }
    if (ruleEl && e.target.closest('[data-up]')) {
      const i = Number(ruleEl.dataset.i);
      [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
      save();
      return render();
    }
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      txMode = mode.dataset.mode;
      return renderTx(compute());
    }
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      tagFilter = tagFilter === tagBtn.dataset.tag ? null : tagBtn.dataset.tag;
      render();
      $('l-tx').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (e.target.closest('[data-untag]')) {
      tagFilter = null;
      return render();
    }
    const exp = e.target.closest('[data-export]');
    if (exp) exportChanges(exp.dataset.export, exp);
  });
  view.addEventListener('change', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const i = Number(toggle.closest('.rule').dataset.i);
      rules[i] = { ...rules[i], enabled: toggle.checked };
      save();
      render();
    }
    if (e.target.name === 'op') e.target.form.value2.hidden = e.target.value !== 'between';
  });
  view.addEventListener('submit', (e) => {
    if (e.target.id !== 'rule-form') return;
    e.preventDefault();
    const f = e.target;
    const rule = {
      id: `r${Date.now().toString(36)}`,
      enabled: true,
      when: [{ field: f.field.value, op: f.op.value, value: f.value.value.trim(), value2: f.value2.value.trim() }],
      setCategory: f.setCategory.value.trim(),
      addTags: f.addTags.value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    if (!rule.setCategory && !rule.addTags.length) {
      f.setCategory.focus();
      return;
    }
    const hits = txs.filter((t) => ruleMatches(rule, t)).length;
    rules = [...rules, rule];
    save();
    render();
    if (!hits) $('l-rules').insertAdjacentHTML('beforeend', '<div class="empty">Hinweis: Diese Regel trifft auf keine Buchung zu.</div>');
  });

  async function exportChanges(kind, btn) {
    const results = compute().filter((x) => x.r.changed || x.r.tags.length);
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'firefly') {
      const blob = new Blob([JSON.stringify(toFireflyRules(rules), null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `firefly-regeln-${stamp}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (kind === 'csv') {
      downloadCsv(`kategorien-probe-${stamp}.csv`, [
        ['Datum', 'Beschreibung', 'Empfänger/Zahler', 'Betrag', 'Kategorie bisher', 'Kategorie neu', 'Tags'],
        ...results.map(({ t, r }) => [String(t.date).slice(0, 10), t.description, counterpartyOf(t), t.amount, t.category_name || '', r.category || '', r.tags.join(', ')]),
      ]);
    } else if (kind === 'n8n' && categorizeAction) {
      const changes = results.filter((x) => x.r.changed);
      if (!window.confirm(`${changes.length} Kategorie-Änderungen an „${categorizeAction.name}“ übergeben? Der Workflow schreibt sie dann in Firefly.`)) return;
      btn.textContent = 'Sende …';
      const payload = {
        typ: 'kategorien_uebernehmen',
        aenderungen: changes.map(({ t, r }) => ({
          transaction_group_id: t.groupId, transaction_journal_id: t.transaction_journal_id, datum: String(t.date).slice(0, 10),
          beschreibung: t.description, betrag: t.amount, kategorie_alt: t.category_name || null, kategorie: r.category, tags: r.tags,
        })),
      };
      const res = await fetch(`/local/actions/${encodeURIComponent(categorizeAction.id)}/run`, { method: 'POST', headers, body: JSON.stringify({ context: { ...payload, daten: payload } }) })
        .then((x) => x.json()).catch(() => ({ ok: false }));
      btn.textContent = res.ok ? 'Übergeben ✓' : 'Fehler – siehe Automationen';
    }
  }

  render();
}
