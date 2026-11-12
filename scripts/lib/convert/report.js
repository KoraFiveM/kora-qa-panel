// conversion-report.md + unmapped-phrase ranking.
export function normPhrase(p) {
  return String(p ?? '').trim().replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').replace(/\{(string|int|word|float)\}/gi, (m) => m.toLowerCase());
}

export function rankPhrases(entries) {
  const counts = new Map();
  for (const e of entries) for (const p of e.unmapped ?? []) {
    const k = normPhrase(p);
    if (!k) continue;
    const c = counts.get(k.toLowerCase()) ?? { phrase: k, count: 0, resources: new Set() };
    c.count++;
    c.resources.add(e.resource);
    counts.set(k.toLowerCase(), c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase)).map((c) => ({ ...c, resources: [...c.resources].sort() }));
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport({ generatedAt, resources, entries, phrases, stats, notes = [], existing = [], sections = [] }) {
  const L = [];
  L.push('# Legacy test conversion report', '');
  L.push(`Generated ${new Date(generatedAt).toISOString()} by kora-qa-panel/scripts/convert-legacy.mjs (Claude ${stats.model}, effort ${stats.effort}).`);
  L.push(`Staging only — nothing here is live. Model calls: ${stats.calls} new, ${stats.cached} from cache, ${stats.failed} failed; cost of new calls $${stats.costUsd.toFixed(2)} (all cached responses together $${stats.totalCostUsd.toFixed(2)}).`, '');
  for (const n of notes) L.push(`- ${n}`);
  if (notes.length) L.push('');
  for (const sec of sections) L.push(sec, '');
  const tot = { converted: 0, manualOnly: 0, merged: 0, unconvertible: 0, withSetup: 0, total: 0 };
  L.push('## Per resource', '', '| resource | legacy tests | converted | of which manual-only | merged (checklist → game test) | unconvertible | with generated setup | files |', '|---|---|---|---|---|---|---|---|');
  for (const r of resources) {
    const es = entries.filter((e) => e.resource === r.name);
    const c = {
      total: es.length,
      converted: es.filter((e) => e.status === 'converted').length,
      manualOnly: es.filter((e) => e.status === 'converted' && e.manualOnly).length,
      merged: es.filter((e) => e.status === 'merged').length,
      unconvertible: es.filter((e) => e.status === 'unconvertible').length,
      withSetup: es.filter((e) => e.status === 'converted' && e.setupSteps?.length).length,
    };
    for (const k of Object.keys(tot)) tot[k] += c[k];
    L.push(`| ${r.name} | ${c.total} | ${c.converted} | ${c.manualOnly} | ${c.merged} | ${c.unconvertible} | ${c.withSetup} | ${r.files.map((f) => `\`${f}\``).join(', ')} |`);
  }
  L.push(`| **total** | ${tot.total} | ${tot.converted} | ${tot.manualOnly} | ${tot.merged} | ${tot.unconvertible} | ${tot.withSetup} | |`, '');
  L.push('converted = its own valid scenario; manual-only = every step is `I manually:`/`I confirm:` (tagged `@manual`); merged = checklist feature judged a duplicate of a game test, added to that scenario as `@checklist:<resource>:<id>`.', '');

  L.push('## Unconvertible', '');
  const bad = entries.filter((e) => e.status === 'unconvertible');
  if (!bad.length) L.push('None.', '');
  for (const e of bad) L.push(`- **${e.resource}** \`${e.key}\` — ${esc(e.title)}: ${esc(e.reason)}`);
  if (bad.length) L.push('');

  L.push('## Scenarios with generated setup (eyeball these)', '');
  for (const r of resources) {
    const es = entries.filter((e) => e.resource === r.name && e.status === 'converted' && e.setupSteps?.length);
    if (!es.length) continue;
    L.push(`### ${r.name}`, '');
    for (const e of es) L.push(`- \`${e.scenarioId}\` (${e.key}) ${esc(e.title)}`, ...e.setupSteps.map((s) => `  - \`${s}\``));
    L.push('');
  }

  L.push('## Merged checklist features', '');
  const merged = entries.filter((e) => e.status === 'merged');
  if (!merged.length) L.push('None.', '');
  for (const e of merged) L.push(`- ${e.resource}: \`${e.key}\` (${esc(e.title)}) → \`${e.mergedInto}\``);
  if (merged.length) L.push('');

  L.push('## Unmapped phrases (candidate catalog steps, most frequent first)', '');
  L.push('| # | phrase | count | resources |', '|---|---|---|---|');
  phrases.forEach((p, i) => L.push(`| ${i + 1} | \`${esc(p.phrase)}\` | ${p.count} | ${p.resources.join(', ')} |`));
  L.push('');
  if (existing.length) {
    L.push('## Existing steps the model could not use (the app id / menu title / text was not known)', '');
    L.push('These patterns already exist; the scenarios fell back to `I confirm:` because the name was not in the test text or resource code. Adding the ids (or kora_qa marks) to the resources would let a later pass automate them.', '');
    L.push('| phrase | count | resources |', '|---|---|---|');
    for (const p of existing) L.push(`| \`${esc(p.phrase)}\` | ${p.count} | ${p.resources.join(', ')} |`);
    L.push('');
  }
  return L.join('\n');
}
