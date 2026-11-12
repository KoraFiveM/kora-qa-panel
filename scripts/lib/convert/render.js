// Deterministic parts of the conversion: tags, the verbatim description block, file layout, feature text.
import { slug } from './sources.js';

export const KEYWORDS = ['Given', 'When', 'Then', 'And', 'But'];
// A description line starting like this would be read as Gherkin structure, not text.
const STRUCTURAL = /^\s*(Given |When |Then |And |But |\* |#|@|\||"""|```|Feature:|Background:|Rule:|Scenario|Example|Examples:|Scenarios:)/;

export function gameTags(t) {
  const tags = [`@${t.resource}`, `@legacy:${t.id}`, `@target:${t.target}`];
  if (t.needsAdmin) tags.push('@needs:admin');
  if (t.needsPlayers) tags.push(`@needs:players:${t.needsPlayers}`);
  if (t.bug) tags.push('@regression');
  return tags;
}

export function checklistTags(c) {
  return [`@checklist`, `@checklist:${c.resource}:${c.id}`, `@cat:${slug(c.category)}`];
}

export function cleanTag(t) {
  return String(t).replace(/\s+/g, '-');
}

// Description lines kept verbatim; only a line that Gherkin would parse as structure gets a visible "> " prefix.
export function descriptionLines(text) {
  return String(text ?? '').replace(/\r/g, '').split('\n').map((l) => (STRUCTURAL.test(l) ? `> ${l}` : l));
}

// The """ block under a Scenario. game: original description (+ the separate `setup` text if any);
// checklist: "Checklist test: <test>"; merged checklist features are appended as their own lines.
export function descriptionBlock(entry, merged = []) {
  const lines = [];
  if (entry.kind === 'checklist') lines.push(...descriptionLines(`Checklist test: ${entry.description}`));
  else {
    if (entry.setup) lines.push(...descriptionLines(`Setup: ${entry.setup}`));
    lines.push(...descriptionLines(entry.description));
  }
  for (const c of merged) lines.push(...descriptionLines(`Also checklist ${c.resource}:${c.id} (${c.title}): ${c.description}`));
  return lines;
}

// "Then I confirm: x" -> { keyword, text }. Lines without a valid keyword get null.
export function splitStep(line) {
  const s = String(line ?? '').replace(/[\r\n]+/g, ' ').trim();
  const m = /^(Given|When|Then|And|But|\*)\s+(.+)$/.exec(s);
  if (!m) return null;
  return { keyword: m[1], text: m[2].trim() };
}

// Gherkin keywords are cosmetic for matching, but keep them readable: first of a run uses Given/When/Then by kind.
export function keywordFor(kind, text) {
  if (kind === 'setup') return 'Given';
  if (kind === 'check') return 'Then';
  if (kind === 'manual') return /^I confirm:/.test(text) ? 'Then' : 'When';
  return 'When';
}

export function normaliseKeywords(steps) {
  let prev = null;
  return steps.map((st) => {
    const base = st.base ?? st.keyword;
    const kw = base === prev ? 'And' : base;
    prev = base;
    return { ...st, keyword: kw };
  });
}

// One scenario block. steps: [{keyword, text}] already normalised.
export function renderScenario({ tags, name, description, steps }) {
  const out = [];
  out.push(`  ${tags.map(cleanTag).join(' ')}`);
  out.push(`  Scenario: ${String(name).replace(/[\r\n]+/g, ' ').trim()}`);
  if (description?.length) {
    out.push('    """');
    for (const l of description) out.push(l.trim() ? `    ${l}` : '');
    out.push('    """');
  }
  for (const st of steps) out.push(`    ${st.keyword} ${st.text}`);
  return out;
}

// -> { text, scenarioLines: { key: lineOfScenarioKeyword } }
export function renderFeature({ title, header = [], scenarios }) {
  const lines = [...header.map((h) => `# ${h}`), `Feature: ${title}`, ''];
  const scenarioLines = {};
  for (const sc of scenarios) {
    const block = renderScenario(sc);
    scenarioLines[sc.key] = lines.length + 2; // tags line is lines.length+1 (1-based), Scenario: right after
    lines.push(...block, '');
  }
  return { text: lines.join('\n'), scenarioLines };
}

export function gameFile(resource) {
  return { file: 'tests/legacy-game.feature', title: `${resource} — game tests` };
}

export function checklistFile(resource, category) {
  return { file: `tests/checklist-${slug(category)}.feature`, title: `${resource} — ${category}` };
}
