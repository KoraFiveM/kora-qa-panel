// Validation of compiled scenarios: every step matches exactly one definition, every alias resolves, every value is
// inside the caps; tags give target / needs / legacy ids. Produces the Scenario object of QA-CONTRACTS §6 + hash.
import crypto from 'node:crypto';
import { buildMatcher } from './matcher.js';
import { compileFeature } from './compile.js';
import { mergeCaps, normalizeAliases } from './catalog.js';
import { validateArgs, validateDef } from './rules.js';

export const MAX_TARGET = 50;

// ctx: { steps, caps, aliases: { <resource>: aliasObj } }. Returns a context with a compiled matcher (reuse it for many
// files). Step definitions failing kora_qa's shape check (rules.validateDef) are left out and listed in matcher.errors.
export function makeContext({ steps, caps = {}, aliases = {} } = {}) {
  const good = [];
  const defErrors = [];
  for (const d of steps ?? []) { const v = validateDef(d); if (v.ok) good.push(d); else defErrors.push({ id: d?.id ?? null, pattern: d?.pattern ?? null, error: v.error }); }
  const matcher = buildMatcher(good);
  matcher.errors.push(...defErrors);
  const norm = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, normalizeAliases(v)]));
  return { steps: good, caps: mergeCaps(caps), aliases: norm, matcher };
}

// One argument through kora_qa's rules (kept for callers of the old API). -> { value, resolved?, error? }
export function checkArg(spec, value, { caps, aliases, resource }) {
  const out = validateArgs({ args: [spec] }, [value], { caps, aliases, resource });
  return out.error ? { value, error: out.error } : { value, resolved: out.params[spec.name] };
}

const ALIAS_ALLOW = new Set(['locations', 'vehicles', 'peds', 'props']);

export function tagInfo(tags) {
  const out = { target: 1, needs: { admin: false, players: 1 }, legacyIds: [], wip: false, manual: false, issueIds: [], errors: [] };
  for (const t of tags) {
    let m;
    if ((m = /^@target:(\d+)$/.exec(t))) {
      const n = Number(m[1]);
      if (n < 1 || n > MAX_TARGET) out.errors.push(`${t}: target must be 1..${MAX_TARGET}`); else out.target = n;
    } else if (/^@target/.test(t)) out.errors.push(`${t}: use @target:<n>`);
    else if (t === '@needs:admin') out.needs.admin = true;
    else if ((m = /^@needs:players:(\d+)$/.exec(t))) {
      const n = Number(m[1]);
      if (n < 1 || n > 32) out.errors.push(`${t}: players must be 1..32`); else out.needs.players = n;
    } else if (/^@needs:/.test(t)) out.errors.push(`${t}: unknown need (use @needs:admin or @needs:players:<n>)`);
    else if ((m = /^@(legacy|checklist):(.+)$/.exec(t))) out.legacyIds.push(`${m[1]}:${m[2]}`);
    else if ((m = /^@issue-(\d{15,25})$/.exec(t))) out.issueIds.push(m[1]);
    else if (t === '@wip') out.wip = true;
    else if (t === '@manual') out.manual = true;
  }
  return out;
}

// Stable sha1 of the scenario as served (everything but hash).
export function scenarioHash(s) {
  const body = { id: s.id, resource: s.resource, name: s.name, description: s.description, tags: s.tags, target: s.target, needs: s.needs, steps: s.steps };
  return crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
}

// raw scenario (compileFeature) + ctx -> { scenario, valid, errors:[{idx?, line?, text?, message}], legacyIds, wip }
export function validateScenario(raw, ctx) {
  const errors = [];
  const ti = tagInfo(raw.tags);
  for (const e of ti.errors) errors.push({ line: raw.line, message: e });
  if (!raw.steps.length) errors.push({ line: raw.line, message: 'scenario has no steps' });
  let entities = 0;
  const steps = raw.steps.map((st) => {
    const m = ctx.matcher.match(st.text);
    const out = { idx: st.idx, keyword: st.keyword, text: st.text, defId: null, kind: null, side: null, args: [], docString: st.docString, dataTable: st.dataTable };
    if (m.error) {
      errors.push({ idx: st.idx, line: st.line, text: st.text, message: m.error });
      return out;
    }
    out.defId = m.def.id;
    out.kind = m.def.kind ?? null;
    out.side = m.def.side ?? null;
    out.args = m.args;
    const v = validateArgs(m.def, m.args, { caps: ctx.caps, aliases: ctx.aliases, resource: raw.resource });
    if (v.error) errors.push({ idx: st.idx, line: st.line, text: st.text, message: v.error });
    else {
      const resolved = {};
      (m.def.args ?? []).forEach((spec, i) => {
        const p = v.params[spec.name];
        if (spec.allow === 'locations') resolved[spec.name] = Object.fromEntries(Object.entries(p).filter(([k, x]) => x !== null && k !== 'name'));
        else if (ALIAS_ALLOW.has(spec.allow) && p !== String(m.args[i])) resolved[spec.name] = p;
      });
      if (Object.keys(resolved).length) out.resolved = resolved;
    }
    if (Number(m.def.entities) > 0) entities += Number(m.def.entities);
    return out;
  });
  if (Number.isFinite(Number(ctx.caps.maxEntities)) && entities > Number(ctx.caps.maxEntities)) {
    errors.push({ line: raw.line, message: `scenario spawns ${entities} entities, over the cap maxEntities=${ctx.caps.maxEntities}` });
  }
  const scenario = { id: raw.id, resource: raw.resource, name: raw.name, description: raw.description, tags: raw.tags, target: ti.target, needs: ti.needs, hash: null, steps };
  scenario.hash = scenarioHash(scenario);
  return { scenario, file: raw.file, line: raw.line, valid: errors.length === 0, errors, legacyIds: ti.legacyIds, wip: ti.wip, issueIds: ti.issueIds };
}

// One feature file's text -> { ok, results:[validateScenario output], errors:[file-level {line, message}] }.
// The function S4's conversion script uses to check generated features.
export function validateFeatureText(text, { resource, file = 'tests/generated.feature', ctx }) {
  const { scenarios, errors } = compileFeature(text, { resource, file });
  const results = scenarios.map((raw) => validateScenario(raw, ctx));
  if (!errors.length && !scenarios.length) errors.push({ line: 1, message: 'feature has no scenarios' });
  return { ok: !errors.length && results.every((r) => r.valid), results, errors };
}
