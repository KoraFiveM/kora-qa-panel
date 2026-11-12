// Scenario service: discovery (qa_feature opt-in), compile, matching, priorities/ambiguity, caps, aliases, hash, DB upsert.
import { resetDb, done, q, FIXTURES, TMP } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadValidationContext, validateFeatureText, discover, qaFeatureGlobs, makeContext, mergeSteps, buildMatcher } from '../server/scenarios/index.js';
import { runScan, servedScenarios, saveRegistry } from '../server/scenarios/service.js';

const RES = path.join(FIXTURES, 'resources');
const steps = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'steps.json'), 'utf8'));

before(resetDb);
after(done);

test('qa_feature opt-in parsing', () => {
  assert.deepEqual(qaFeatureGlobs("-- qa_feature 'x/*.feature'\nqa_feature 'tests/*.feature'\nqa_feature(\"more/a.feature\")"), ['tests/*.feature', 'more/a.feature']);
  assert.deepEqual(qaFeatureGlobs("qa_features { 'a/*.feature', \"b/*.feature\" }"), ['a/*.feature', 'b/*.feature']);
  const names = discover(RES).map((r) => r.name);
  assert.ok(names.includes('kora_fishing') && names.includes('kora_hud') && !names.includes('kora_plain'));
  assert.ok(discover(RES, { scanAll: true }).some((r) => r.name === 'kora_plain'));
});

test('validation against the fixture catalog', () => {
  const ctx = loadValidationContext({ resDir: RES, catalogFile: path.join(FIXTURES, 'steps.json') });
  assert.equal(ctx.catalog.error, null);
  assert.deepEqual(ctx.matcher.errors, []);
  const text = fs.readFileSync(path.join(RES, '[kora]', 'kora_fishing', 'tests', 'selling.feature'), 'utf8');
  const v = validateFeatureText(text, { resource: 'kora_fishing', file: 'tests/selling.feature', ctx });
  assert.equal(v.ok, false);
  const byLine = Object.fromEntries(v.results.map((r) => [r.line, r]));
  assert.equal(byLine[8].valid, true);
  assert.deepEqual(byLine[8].legacyIds, ['legacy:fish-sell']);
  assert.equal(byLine[8].scenario.steps[0].defId, 'teleport.location', 'background step included');
  assert.deepEqual(byLine[8].scenario.steps[0].resolved.location, { x: -1850.1, y: -1250.2, z: 8.6, h: 140 });
  assert.equal(byLine[8].scenario.steps.at(-1).defId, 'manual.confirm');
  assert.equal(byLine[8].scenario.description, '1. Catch a fish and sell it at the shop.\nExpect: cash goes up.');
  assert.ok(byLine[27].valid && byLine[28].valid, 'outline rows are separate scenarios');
  assert.deepEqual(byLine[28].scenario.steps[1].args, [5, 'fish']);
  const bad = byLine[30];
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors.map((e) => e.idx), [1, 2, 3, 4, 5, 6]);
  assert.match(bad.errors.find((e) => e.idx === 3).message, /"tank" \(model\) is on the model denylist/);
  assert.equal(byLine[39].wip, true);
  // hash is stable and content-sensitive
  const again = validateFeatureText(text, { resource: 'kora_fishing', file: 'tests/selling.feature', ctx });
  assert.equal(again.results[0].scenario.hash, byLine[8].scenario.hash);
  const changed = validateFeatureText(text.replace('I have 2 "fish"', 'I have 3 "fish"'), { resource: 'kora_fishing', file: 'tests/selling.feature', ctx });
  assert.notEqual(changed.results[0].scenario.hash, byLine[8].scenario.hash);
});

test('priority wins, equal priority is ambiguous', () => {
  const extra = [
    { id: 'fish.rod', pattern: 'I have a fishing rod equipped', kind: 'setup', priority: 5 },
    { id: 'generic.equip', pattern: 'I have a {string} equipped', kind: 'setup', priority: 0 },
    { id: 'dup.a', pattern: 'the boat sinks', kind: 'check', priority: 1 },
    { id: 'dup.b', pattern: 'the {word} sinks', kind: 'check', priority: 1 },
  ];
  const m = buildMatcher(mergeSteps(steps, extra));
  assert.equal(m.match('I have a fishing rod equipped').def.id, 'fish.rod');
  assert.match(m.match('the boat sinks').error, /^ambiguous: matches dup\.a, dup\.b at priority 1/);
  assert.equal(m.match('I manually: anything at all').def.id, 'manual.do');
  assert.match(m.match('gibberish').error, /no step definition/);
});

test('feature-level problems', () => {
  const ctx = makeContext({ steps: mergeSteps(steps) });
  assert.match(validateFeatureText('Feature: x\n  Scenario: y\n    Given I have 1 "water"\n      | a | b |\n      | c |\n', { resource: 'r', ctx }).errors[0].message, /inconsistent cell count/);
  assert.match(validateFeatureText('Feature: empty\n', { resource: 'r', ctx }).errors[0].message, /no scenarios/);
  const t = validateFeatureText('@target:0 @needs:wizard\nFeature: x\n  Scenario: y\n', { resource: 'r', ctx });
  assert.deepEqual(t.results[0].errors.map((e) => e.message), ['@target:0: target must be 1..50', '@needs:wizard: unknown need (use @needs:admin or @needs:players:<n>)', 'scenario has no steps']);
});

test('scan upserts, serves valid non-wip, marks removed', async () => {
  const s1 = await runScan();
  assert.equal(s1.catalog.error, null);
  assert.ok(s1.scenarios >= 6);
  const rows = await q('SELECT id, valid, removed FROM scenarios ORDER BY id');
  assert.ok(rows.some((r) => r.id === 'kora_broken:tests/bad.feature:0' && !r.valid), 'unparsable file listed at line 0');
  assert.ok(rows.some((r) => r.id === 'kora_hud:tests/id.feature:3' && r.valid));
  const served = await servedScenarios();
  assert.ok(served.scenarios.every((s) => !s.tags.includes('@wip')));
  assert.ok(!served.scenarios.some((s) => s.id === 'kora_fishing:tests/selling.feature:30'));
  const hud = served.scenarios.find((s) => s.id === 'kora_hud:tests/id.feature:3');
  assert.deepEqual(hud.needs, { admin: false, players: 2 });
  assert.equal(hud.target, 3);
  assert.deepEqual(Object.keys(hud), ['id', 'resource', 'name', 'description', 'tags', 'target', 'needs', 'hash', 'passes', 'steps']);
  assert.match(served.hash, /^[0-9a-f]{40}$/);
  const s2 = await runScan();
  assert.equal(s2.changed, 0, 'unchanged files do not rewrite rows');

  // a copied resource tree to test removal and registry aliases
  const res2 = path.join(TMP, 'res2');
  fs.cpSync(RES, res2, { recursive: true });
  await runScan({ resDir: res2 });
  fs.rmSync(path.join(res2, '[kora]', 'kora_hud'), { recursive: true });
  const s3 = await runScan({ resDir: res2 });
  assert.ok(s3.removed >= 1);
  assert.equal((await q("SELECT removed FROM scenarios WHERE id = 'kora_hud:tests/id.feature:3'"))[0].removed, 1);

  // registry aliases make the "nowhere" alias resolve; caps from registry tighten maxItemCount
  await saveRegistry({ steps: [], caps: { maxItemCount: 1 }, aliases: { kora_fishing: { locations: { nowhere: { x: 0, y: 0, z: 0 } } } } });
  await runScan({ resDir: res2 });
  const r = (await q("SELECT valid, errors FROM scenarios WHERE id = 'kora_fishing:tests/selling.feature:8'"))[0];
  assert.equal(r.valid, 0);
  assert.match(JSON.stringify(r.errors), /is over the maxItemCount cap \(1\)/);
  const bad = (await q("SELECT errors FROM scenarios WHERE id = 'kora_fishing:tests/selling.feature:30'"))[0];
  assert.doesNotMatch(JSON.stringify(bad.errors), /nowhere/);
});
