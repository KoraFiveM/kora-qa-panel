// Scenario service: builds the validation context (catalog + registry + caps + aliases), scans RES_DIR, upserts the
// scenarios table (marks vanished ones removed), re-scans on file changes (debounced) and on demand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { q, one, json } from '../db.js';
import { emit } from '../events.js';
import { catalogPath, loadCatalog, mergeAliases, mergeSteps, readConfigCaps, readQaLua, KORA_QA_REL } from './catalog.js';
import { makeContext } from './validate.js';
import { discover, validateResources } from './scan.js';

export async function getRegistry() {
  const row = await one('SELECT data, updated_at FROM registry WHERE id = 1');
  return row ? { ...(row.data ?? {}), updatedAt: row.updated_at } : null;
}

export async function saveRegistry(data) {
  const at = Date.now();
  await q('INSERT INTO registry (id, data, updated_at) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)', [json(data), at]);
  return at;
}

// Everything validation needs, from disk + the registry row. resources: discover() output (for qa.lua aliases).
export function buildContext({ registry, resources, resDir = config().resDir, catalogFile = config().stepsCatalog ?? catalogPath(resDir) }) {
  const catalog = loadCatalog(catalogFile);
  const steps = mergeSteps(catalog.steps, registry?.steps);
  const caps = { ...readConfigCaps(resDir), ...(registry?.caps ?? {}) };
  const aliases = {};
  for (const r of resources) aliases[r.name] = r.qaLua?.aliases;
  if (!aliases.kora_qa) aliases.kora_qa = readQaLua(path.join(resDir, KORA_QA_REL)).aliases;
  for (const [res, a] of Object.entries(registry?.aliases ?? {})) aliases[res] = mergeAliases(aliases[res], a);
  const ctx = makeContext({ steps, caps, aliases });
  return { ctx, catalog: { source: catalog.source, error: catalog.error, count: catalog.steps.length }, registryAt: registry?.updatedAt ?? null };
}

let scanning = null;
let again = false;

// Scans and writes the DB. Concurrent calls coalesce. -> summary
export function runScan(opts = {}) {
  if (scanning) { again = true; return scanning; }
  scanning = (async () => {
    try {
      let out;
      do { again = false; out = await scanOnce(opts); } while (again);
      return out;
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

async function scanOnce({ resDir = config().resDir, scanAll = config().scanAll } = {}) {
  const started = Date.now();
  const resources = discover(resDir, { scanAll });
  const registry = await getRegistry();
  const { ctx, catalog, registryAt } = buildContext({ registry, resources, resDir });
  const { results, fileErrors } = validateResources(resources, ctx);

  const rows = results.map((r) => ({
    id: r.scenario.id, resource: r.scenario.resource, file: r.file, line: r.line, name: r.scenario.name, description: r.scenario.description,
    tags: r.scenario.tags, steps: r.scenario.steps, hash: r.scenario.hash, target: r.scenario.target, legacyIds: r.legacyIds, valid: r.valid ? 1 : 0, errors: r.errors,
  }));
  // A file that does not parse at all: one row at line 0 so the panel lists it with its reasons.
  const byFile = new Map();
  for (const e of fileErrors) {
    if (e.file === 'tests/qa.lua') continue;
    const k = `${e.resource}:${e.file}:0`;
    if (!byFile.has(k)) byFile.set(k, { id: k, resource: e.resource, file: e.file, line: 0, name: `(${e.file} does not parse)`, description: '', tags: [], steps: [], hash: null, target: 1, legacyIds: [], valid: 0, errors: [] });
    byFile.get(k).errors.push({ line: e.line, message: e.message });
  }
  rows.push(...byFile.values());
  // qa.lua problems invalidate nothing by themselves but are attached to that resource's scenarios as a hint.
  const dup = new Set();
  const final = rows.filter((r) => (dup.has(r.id) ? false : (dup.add(r.id), true)));

  const existing = new Map((await q('SELECT id, hash, valid, errors, removed FROM scenarios')).map((r) => [r.id, r]));
  const now = Date.now();
  let changed = 0;
  for (const r of final) {
    const old = existing.get(r.id);
    const same = old && old.hash === r.hash && Number(old.valid) === r.valid && JSON.stringify(old.errors ?? []) === JSON.stringify(r.errors) && !Number(old.removed);
    if (same) continue;
    changed++;
    await q(`INSERT INTO scenarios (id, resource, file, line, name, description, tags, steps, hash, target, legacy_ids, valid, errors, removed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON DUPLICATE KEY UPDATE resource = VALUES(resource), file = VALUES(file), line = VALUES(line), name = VALUES(name), description = VALUES(description),
        tags = VALUES(tags), steps = VALUES(steps), hash = VALUES(hash), target = VALUES(target), legacy_ids = VALUES(legacy_ids), valid = VALUES(valid),
        errors = VALUES(errors), removed = 0, updated_at = VALUES(updated_at)`,
    [r.id, r.resource, r.file, r.line, String(r.name ?? '').slice(0, 300), r.description, json(r.tags), json(r.steps), r.hash, r.target, json(r.legacyIds), r.valid, json(r.errors), now]);
  }
  const seen = new Set(final.map((r) => r.id));
  const gone = [...existing.values()].filter((r) => !seen.has(r.id) && !Number(r.removed)).map((r) => r.id);
  for (const id of gone) await q('UPDATE scenarios SET removed = 1, updated_at = ? WHERE id = ?', [now, id]);

  const summary = {
    at: now, ms: now - started, resources: resources.map((r) => ({ name: r.name, optedIn: r.optedIn, files: r.files.length, qaLuaError: r.qaLua?.error ?? null })),
    scenarios: results.length, valid: results.filter((r) => r.valid).length, invalid: results.filter((r) => !r.valid).length + byFile.size,
    changed, removed: gone.length, catalog, registryAt, matcherErrors: ctx.matcher.errors, fileErrors,
  };
  await q('INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['scan', json(summary)]);
  if (changed || gone.length) emit('scenarios', { changed, removed: gone.length });
  return summary;
}

// What GET /qa/game/scenarios serves (valid, not removed, not @wip). `passes` = distinct testers with a passed run of
// the scenario (any version, legacy imports included) — kora_qa shows it as target progress. The set hash covers the
// scenario hashes and the pass counts, so kora_qa re-downloads when either changes.
export async function servedScenarios() {
  const rows = await q('SELECT id, resource, name, description, tags, steps, hash, target FROM scenarios WHERE valid = 1 AND removed = 0 ORDER BY id');
  const passRows = await q("SELECT scenario_id, COUNT(DISTINCT discord_id) AS n FROM runs WHERE status = 'passed' AND scenario_id IS NOT NULL GROUP BY scenario_id");
  const passes = new Map(passRows.map((r) => [r.scenario_id, Number(r.n)]));
  const scenarios = rows
    .filter((r) => !(r.tags ?? []).includes('@wip'))
    .map((r) => {
      const tags = r.tags ?? [];
      const needs = { admin: tags.includes('@needs:admin'), players: Number(/^@needs:players:(\d+)$/.exec(tags.find((t) => /^@needs:players:\d+$/.test(t)) ?? '')?.[1] ?? 1) };
      return { id: r.id, resource: r.resource, name: r.name, description: r.description ?? '', tags, target: r.target ?? 1, needs, hash: r.hash, passes: passes.get(r.id) ?? 0, steps: r.steps ?? [] };
    });
  const hash = crypto.createHash('sha1').update(scenarios.map((s) => `${s.id}@${s.hash}#${s.passes}`).join('\n')).digest('hex');
  return { hash, scenarios };
}

// Watches each opted-in resource's tests/ dir, each resource dir (fxmanifest, new tests/), the category dirs (new
// resources) and kora_qa/shared (steps.json). Re-armed after each scan. Debounced.
export function startWatcher({ resDir = config().resDir, debounceMs = 1500, log = console, onScan = () => {} } = {}) {
  let watchers = [];
  let timer = null;
  let stopped = false;
  const relevant = (f) => !f || /\.(feature|lua|json)$/.test(f) || f === 'tests';
  const trigger = (f) => {
    if (stopped || !relevant(f)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { onScan(await runScan()); } catch (error) { log.error?.('[scenarios] scan failed:', error?.message ?? error); }
      arm();
    }, debounceMs);
    timer.unref?.();
  };
  const watch = (dir) => {
    try { const w = fs.watch(dir, { persistent: false }, (_e, f) => trigger(f ? String(f) : null)); w.on('error', () => {}); watchers.push(w); } catch { /* gone */ }
  };
  function arm() {
    for (const w of watchers) try { w.close(); } catch { /* ignore */ }
    watchers = [];
    if (stopped) return;
    const dirs = new Set([resDir]);
    const walk = (dir, d) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some((e) => e.isFile() && e.name === 'fxmanifest.lua')) {
        dirs.add(dir);
        if (entries.some((e) => e.isDirectory() && e.name === 'tests')) dirs.add(path.join(dir, 'tests'));
        return;
      }
      dirs.add(dir);
      if (d < 4) for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
    };
    walk(resDir, 0);
    const shared = path.join(resDir, KORA_QA_REL, 'shared');
    if (fs.existsSync(shared)) dirs.add(shared);
    for (const d of dirs) watch(d);
  }
  arm();
  return { stop() { stopped = true; clearTimeout(timer); for (const w of watchers) try { w.close(); } catch { /* ignore */ } }, count: () => watchers.length };
}
