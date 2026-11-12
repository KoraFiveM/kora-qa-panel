// Reusable, DB-free scenario tooling (S4's conversion script imports this to validate generated features):
//
//   import { loadValidationContext, validateFeatureText } from '<panel>/server/scenarios/index.js';
//   const ctx = loadValidationContext({ resDir, extraAliases: { kora_fishing: { locations: { pier: {x,y,z,h} } } } });
//   const { ok, results, errors } = validateFeatureText(text, { resource: 'kora_fishing', file: 'tests/selling.feature', ctx });
//   // results[i] = { scenario, valid, errors:[{idx, line, text, message}], legacyIds, wip }
import fs from 'node:fs';
import path from 'node:path';
import { catalogPath, loadCatalog, mergeAliases, mergeSteps, readConfigCaps, readQaLua, DEFAULT_CAPS, FALLBACK_STEPS } from './catalog.js';
import { makeContext, validateFeatureText, validateScenario, checkArg, tagInfo, scenarioHash } from './validate.js';
import { validateArgs, validateDef, resolveAlias, normalizeLocation, allowRules } from './rules.js';
import { compileFeature, cleanDescription } from './compile.js';
import { buildMatcher } from './matcher.js';
import { discover, findResources, qaFeatureGlobs, expandGlob, validateResources } from './scan.js';
import { parseLuaReturn, parseLuaAssignment, parseLuaValue } from './lua.js';

// resDir: live resources (catalog, caps from kora_qa/config.lua, every resource's tests/qa.lua).
// stagingDir: optional tree of <resource>/tests/qa.lua that overrides the live aliases (conversion staging).
// catalogFile / registry ({steps, caps, aliases}) / extraAliases / caps: optional overrides.
export function loadValidationContext({ resDir, stagingDir = null, catalogFile = null, registry = null, extraAliases = {}, caps = {} } = {}) {
  const catalog = loadCatalog(catalogFile ?? catalogPath(resDir));
  const steps = mergeSteps(catalog.steps, registry?.steps);
  const aliases = {};
  for (const r of discover(resDir, { scanAll: true })) aliases[r.name] = r.qaLua.aliases;
  if (stagingDir) for (const r of findStagingResources(stagingDir)) aliases[r.name] = mergeAliases(aliases[r.name], readQaLua(r.dir).aliases);
  for (const [res, a] of Object.entries(registry?.aliases ?? {})) aliases[res] = mergeAliases(aliases[res], a);
  for (const [res, a] of Object.entries(extraAliases)) aliases[res] = mergeAliases(aliases[res], a);
  const ctx = makeContext({ steps, caps: { ...readConfigCaps(resDir), ...(registry?.caps ?? {}), ...caps }, aliases });
  ctx.catalog = { source: catalog.source, error: catalog.error, count: catalog.steps.length };
  return ctx;
}

// Staging trees have no fxmanifest: every first-level folder is a resource.
function findStagingResources(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, dir: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

export {
  catalogPath, loadCatalog, mergeAliases, mergeSteps, readConfigCaps, readQaLua, DEFAULT_CAPS, FALLBACK_STEPS,
  makeContext, validateFeatureText, validateScenario, checkArg, tagInfo, scenarioHash,
  compileFeature, cleanDescription, buildMatcher,
  discover, findResources, qaFeatureGlobs, expandGlob, validateResources,
  parseLuaReturn, parseLuaAssignment, parseLuaValue,
  validateArgs, validateDef, resolveAlias, normalizeLocation, allowRules,
};
