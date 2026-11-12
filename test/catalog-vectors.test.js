// Shared vectors (test/fixtures/catalog-vectors.json): the panel's rules.js must give the same answers as kora_qa's
// shared/catalog.lua. The Lua side runs too when lua5.4 and the kora_qa resource are present.
import { done } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateArgs, validateDef } from '../server/scenarios/rules.js';
import { normalizeAliases } from '../server/scenarios/catalog.js';
import { FIXTURES, ROOT } from './helpers.js';
import { closePool } from '../server/db.js';

test.after(done);
const V = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'catalog-vectors.json'), 'utf8'));
const dropNulls = (v) => (Array.isArray(v) ? v.map(dropNulls) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, dropNulls(x)])) : v);

test('argument vectors (panel side)', () => {
  // the panel stores aliases normalised; the vectors must behave the same through that
  const aliases = Object.fromEntries(Object.entries(V.env.aliases).map(([k, a]) => [k, normalizeAliases(a)]));
  for (const c of V.cases) {
    const caps = { ...V.env.caps, ...(c.caps ?? {}) };
    for (const k of c.capsUnset ?? []) delete caps[k];
    const out = validateArgs({ args: c.specs }, c.values ?? [], { caps, aliases, resource: c.resource ?? V.env.resource });
    assert.equal(!out.error, c.ok, `${c.name}: ${out.error}`);
    if (!c.ok && c.error) assert.equal(out.error, c.error, c.name);
    if (c.ok && c.params) assert.deepEqual(dropNulls(out.params), c.params, c.name);
  }
});

test('definition vectors (panel side)', () => {
  for (const c of V.defs) {
    const out = validateDef(c.def);
    assert.equal(out.ok, c.ok, c.name);
    if (!c.ok) assert.equal(out.error, c.error, c.name);
  }
});

const QA_DIR = process.env.KORA_QA_DIR ?? '/home/DevTestingKora/kora/server/txData/kora dev/resources/[kora]/kora_qa';
const lua = spawnSync('which', ['lua5.4'], { encoding: 'utf8' }).stdout.trim();
test('same vectors through kora_qa/shared/catalog.lua', { skip: !(lua && fs.existsSync(path.join(QA_DIR, 'shared', 'catalog.lua'))) && 'lua5.4 or kora_qa missing' }, () => {
  const r = spawnSync(lua, [path.join(ROOT, 'test', 'lua', 'catalog-vectors.lua'), QA_DIR, path.join(FIXTURES, 'catalog-vectors.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
