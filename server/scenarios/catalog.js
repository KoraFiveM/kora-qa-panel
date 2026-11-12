// Step catalog, caps and aliases: the validation context. Sources, later wins:
//   steps: RES_DIR/[kora]/kora_qa/shared/steps.json (canonical built-ins), then registry.steps posted by kora_qa (adds
//          steps other resources registered; same id replaces). Fallbacks manual.do / manual.confirm are always present.
//   caps:  DEFAULT_CAPS (empty lists) < Config.caps read from kora_qa/config.lua < registry.caps
//   aliases: per resource, tests/qa.lua read from disk < registry.aliases[resource]; the kora_qa resource's are shared.
import fs from 'node:fs';
import path from 'node:path';
import { parseLuaAssignment, parseLuaReturn } from './lua.js';

export const FALLBACK_STEPS = [
  { id: 'manual.do', pattern: 'I manually: {}', kind: 'manual', side: 'client', resource: 'kora_qa', priority: -100, description: 'The tester does this by hand and presses Done.', args: [{ name: 'instruction', type: 'any', maxLength: 500 }] },
  { id: 'manual.confirm', pattern: 'I confirm: {}', kind: 'manual', side: 'client', resource: 'kora_qa', priority: -100, description: 'The tester checks this and presses Pass or Fail.', args: [{ name: 'expectation', type: 'any', maxLength: 500 }] },
];

// No numeric defaults on purpose: like kora_qa's catalog.lua, a step whose `cap` is not configured is invalid
// ("cap X is not configured"). Caps come from kora_qa/config.lua (Config.caps) and the posted registry.
export const DEFAULT_CAPS = { itemDeny: [], itemAllow: null, modelDeny: [], allowCommands: [], metadataDeny: [] };

export const KORA_QA_REL = path.join('[kora]', 'kora_qa');
export const catalogPath = (resDir) => path.join(resDir, KORA_QA_REL, 'shared', 'steps.json');

// { steps, source, error }. A missing / unreadable catalog gives the fallbacks only (and error set).
export function loadCatalog(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const steps = Array.isArray(raw) ? raw : Array.isArray(raw?.steps) ? raw.steps : null;
    if (!steps) return { steps: [], source: file, error: 'steps.json is not an array' };
    return { steps: steps.filter((s) => s && typeof s.id === 'string' && typeof s.pattern === 'string'), source: file, error: null };
  } catch (error) {
    return { steps: [], source: file, error: error.code === 'ENOENT' ? `catalog not found: ${file}` : `catalog unreadable: ${error.message}` };
  }
}

export function mergeSteps(...lists) {
  const byId = new Map();
  for (const s of FALLBACK_STEPS) byId.set(s.id, s);
  for (const list of lists) for (const s of list ?? []) if (s && typeof s.id === 'string' && typeof s.pattern === 'string') byId.set(s.id, { priority: 0, ...s });
  return [...byId.values()];
}

const luaArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : v === null || v === undefined ? v : [v]);

export function normalizeCaps(c) {
  if (!c || typeof c !== 'object') return {};
  const out = { ...c };
  for (const k of ['itemDeny', 'modelDeny', 'allowCommands', 'accounts', 'metadataDeny', 'weather', 'inventoryTypes', 'itemAllow']) {
    if (k in out) out[k] = luaArray(out[k]);
  }
  return out;
}

export function readConfigCaps(resDir) {
  try {
    const src = fs.readFileSync(path.join(resDir, KORA_QA_REL, 'config.lua'), 'utf8');
    const caps = parseLuaAssignment(src, 'Config.caps');
    return caps && typeof caps === 'object' ? normalizeCaps(caps) : {};
  } catch {
    return {};
  }
}

export const mergeCaps = (...layers) => Object.assign({}, DEFAULT_CAPS, ...layers.map(normalizeCaps));

const ALIAS_KINDS = ['locations', 'vehicles', 'peds', 'props'];

// Normalises a qa.lua / registry alias object to { locations:{}, vehicles:{}, peds:{}, props:{}, fixtures:{name: def|true} }.
// Fixtures: qa.lua gives { name = { steps = {...} } }; the registry gives names only (array) -> name: true.
export function normalizeAliases(a) {
  const out = { locations: {}, vehicles: {}, peds: {}, props: {}, fixtures: {} };
  if (!a || typeof a !== 'object') return out;
  for (const k of ALIAS_KINDS) if (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) out[k] = { ...a[k] };
  const f = a.fixtures;
  if (Array.isArray(f)) { for (const n of f) if (typeof n === 'string') out.fixtures[n] = true; }
  else if (f && typeof f === 'object') for (const [k, v] of Object.entries(f)) { if (/^\d+$/.test(k) && typeof v === 'string') out.fixtures[v] = true; else if (v !== null && v !== undefined) out.fixtures[k] = v; }
  return out;
}

// { aliases, error } from <resourceDir>/tests/qa.lua (absent file = empty, no error).
export function readQaLua(resourceDir) {
  const file = path.join(resourceDir, 'tests', 'qa.lua');
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return { aliases: normalizeAliases(null), error: null }; }
  try { return { aliases: normalizeAliases(parseLuaReturn(src)), error: null }; } catch (error) { return { aliases: normalizeAliases(null), error: `tests/qa.lua: ${error.message}` }; }
}

export function mergeAliases(...layers) {
  const out = normalizeAliases(null);
  for (const l of layers.map(normalizeAliases)) {
    for (const k of [...ALIAS_KINDS, 'fixtures']) {
      for (const [name, v] of Object.entries(l[k])) if (!(k === 'fixtures' && v === true && out.fixtures[name] && out.fixtures[name] !== true)) out[k][name] = v;
    }
  }
  return out;
}
