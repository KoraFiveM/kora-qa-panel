// Legacy conversion (scripts/convert-legacy.mjs): deterministic mapping, description block, checks, pipeline with a
// fake model runner (no network, no DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocationAliases, renderQaLua, aliasName } from '../scripts/lib/convert/spots.js';
import { gameTags, checklistTags, descriptionBlock, renderFeature, splitStep } from '../scripts/lib/convert/render.js';
import { parseSteps, extraChecks, adminConsole, INTERNAL_EVENT } from '../scripts/lib/convert/check.js';
import { buildPrompt, SCHEMA, FORBIDDEN_STEPS } from '../scripts/lib/convert/prompt.js';
import { cacheKey, readSecret, pool } from '../scripts/lib/convert/claude.js';
import { rankPhrases } from '../scripts/lib/convert/report.js';
import { normalizeGame, playersFromText } from '../scripts/lib/convert/sources.js';
import { convert, makeBatches } from '../scripts/lib/convert/convert.js';
import { loadValidationContext, validateFeatureText, parseLuaReturn } from '../scripts/lib/scenarios.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-convert-test-'));

function makeTree() {
  const res = path.join(TMP, 'resources');
  fs.cpSync(path.join(FIX, 'resources'), res, { recursive: true });
  const core = path.join(res, '[pre]', 'kora_core');
  fs.mkdirSync(path.join(core, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(core, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
  fs.writeFileSync(path.join(core, 'shared', 'jobs.lua'), "QBCoreSeed.jobs = {\n { name = 'unemployed', label = 'Civilian' },\n { name = 'police', label = 'Law' },\n}\n");
  fs.writeFileSync(path.join(core, 'shared', 'gangs.lua'), "QBCoreSeed.gangs = { { name = 'none', label = 'No Gang' } }\n");
  fs.writeFileSync(path.join(core, 'shared', 'items.lua'), "QBCoreSeed.items = {\n { name = 'water', label = 'Water', weight = 500 },\n { name = 'vehiclekey', label = 'Key', weight = 20 },\n}\n");
  const vk = path.join(res, '[kora]', 'kora_vehiclekeys');
  fs.mkdirSync(path.join(vk, 'client'), { recursive: true });
  fs.writeFileSync(path.join(vk, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
  fs.writeFileSync(path.join(vk, 'client', 'main.lua'), "Kora.commands.add('givekeys', function() end)\nKora.notify.send({ message = 'This vehicle is locked.' })\nlocal k = 'vehiclekey'\n");
  const bot = path.join(TMP, 'bot');
  fs.mkdirSync(path.join(bot, 'assets', 'test-triage'), { recursive: true });
  fs.mkdirSync(path.join(bot, 'assets', 'tester-checklist'), { recursive: true });
  fs.mkdirSync(path.join(bot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(bot, 'assets', 'test-triage', 'items.json'), JSON.stringify({ items: [
    { id: 'veh-locked', title: 'Locked vehicle refuses the trunk', group: 'kora_vehiclekeys', target: 3, description: '1. Lock a vehicle and try the trunk.\nExpect: "This vehicle is locked."' },
    { id: 'veh-give', title: 'Give keys', group: 'kora_vehiclekeys', target: 2, needsPlayers: 2, bug: true, description: '1. /givekeys 2\nExpect: other player gets keys.' },
    { id: 'veh-bad', title: 'Always invalid', group: 'kora_vehiclekeys', target: 1, description: 'Teleport somewhere.' },
  ] }));
  fs.writeFileSync(path.join(bot, 'assets', 'tester-checklist', 'features.json'), JSON.stringify({ resources: [
    { resource: 'kora_vehiclekeys', category: 'Vehicles', description: 'keys', features: [
      { id: 'lock-trunk', name: 'Locked trunk', test: 'Locked vehicle refuses the trunk.' },
      { id: 'queue', name: 'Queue card', test: 'When the server is full, players see a card.' },
    ] },
  ] }));
  fs.writeFileSync(path.join(bot, 'data', 'test-spots.json'), JSON.stringify({ v: 1, spots: {}, proposals: { 'veh-locked': [{ label: "Benny's Workshop", x: -211.55, y: -1324.55, z: 30.89, h: 270, source: 'kora_vehiclekeys/config.lua:10' }] } }));
  return { res, bot };
}

test('spot aliases: Mod spots win, proposals commented, panel reads the qa.lua', () => {
  const tests = [
    normalizeGame({ id: 'a', group: 'r', title: 'A', target: 1, description: '' }),
    normalizeGame({ id: 'b', group: 'r', title: 'B', target: 1, description: '' }),
    normalizeGame({ id: 'c', group: 'r', title: 'C', target: 1, description: '' }),
  ];
  const spots = {
    spots: { b: [{ label: 'Mod spot', x: 1, y: 2, z: 3 }] },
    proposals: { a: [{ label: '24/7 store', x: 10, y: 20, z: 30, h: 90, source: 'r/x.lua:5' }], b: [{ label: 'ignored', x: 9, y: 9, z: 9, source: 'r/y.lua:1' }], c: [{ label: '24/7 store', x: 10.1, y: 20, z: 30, source: 'r/z.lua:2' }] },
  };
  const { byResource, byTest } = buildLocationAliases(tests, spots);
  assert.deepEqual(Object.keys(byResource.r).sort(), ['at_24_7_store', 'mod_spot']);
  assert.deepEqual(byTest, { a: ['at_24_7_store'], b: ['mod_spot'], c: ['at_24_7_store'] });
  assert.equal(aliasName("Benny's Workshop"), 'bennys_workshop');
  const lua = renderQaLua('r', byResource.r);
  assert.match(lua, /-- proposed, from r\/x\.lua:5, r\/z\.lua:2/);
  assert.doesNotMatch(lua, /ignored/);
  const parsed = parseLuaReturn(lua);
  assert.deepEqual(parsed.locations.at_24_7_store, { x: 10, y: 20, z: 30, h: 90 });
});

test('deterministic tags', () => {
  assert.equal(playersFromText('Needs 2 testers and a car.\n1. x'), 2);
  assert.equal(playersFromText('Needs a Mod and 2 testers on a radio'), 2);
  assert.equal(playersFromText('Needs 4 or more testers'), 4);
  assert.equal(playersFromText('Needs a Mod.'), null);
  assert.equal(normalizeGame({ id: 'q', group: 'r', title: 't', target: 1, description: 'Needs two testers.' }).needsPlayers, 2);
  const g = normalizeGame({ id: 'x-1', group: 'kora_hud', title: 't', target: 3, description: 'd', needsAdmin: true, needsPlayers: 2, bug: true });
  assert.deepEqual(gameTags(g), ['@kora_hud', '@legacy:x-1', '@target:3', '@needs:admin', '@needs:players:2', '@regression']);
  assert.deepEqual(checklistTags({ resource: 'kora_hud', id: 'f', category: 'Character & UI' }), ['@checklist', '@checklist:kora_hud:f', '@cat:character-and-ui']);
});

test('description block survives the panel compiler verbatim', () => {
  const ctx = loadValidationContext({ resDir: path.join(FIX, 'resources'), catalogFile: path.join(FIX, 'steps.json') });
  const desc = '1. Do "this" # not a comment\n\n2. Then @everyone | pipes\nExpect: it works.';
  const e = { kind: 'game', description: desc };
  const { text } = renderFeature({ title: 't', scenarios: [{ key: 'k', tags: ['@kora_hud'], name: 'N', description: descriptionBlock(e), steps: [{ keyword: 'Then', text: 'I confirm: ok' }] }] });
  const v = validateFeatureText(text, { resource: 'kora_hud', file: 'tests/t.feature', ctx });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.results[0].scenario.description, desc.replace('2. Then', '2. Then'));
  const cl = descriptionBlock({ kind: 'checklist', description: 'When full, a card shows.' });
  assert.deepEqual(cl, ['Checklist test: When full, a card shows.']);
  assert.deepEqual(descriptionBlock({ kind: 'game', description: 'When x' }), ['> When x']);
});

test('step parsing and anti-invention checks', () => {
  const ctx = loadValidationContext({ resDir: path.join(FIX, 'resources'), catalogFile: path.join(FIX, 'steps.json') });
  const { steps, errors } = parseSteps(['Given I have 2 "water"', 'And my cash balance is 10', 'When I manually: do it', 'Then I confirm: ok', 'Then I confirm: also', 'nonsense'], ctx.matcher);
  assert.equal(errors.length, 1);
  assert.deepEqual(steps.map((s) => s.keyword), ['Given', 'And', 'When', 'Then', 'And']);
  assert.deepEqual(splitStep('And  I wait 2 seconds'), { keyword: 'And', text: 'I wait 2 seconds' });
  const sc = { steps: [
    { text: 'I am at 1, 2, 3', defId: 'teleport.coords', args: [1, 2, 3] },
    { text: 'I run the command "/nope"', defId: 'command.run', args: ['/nope'] },
    { text: 'I run the command "/id"', defId: 'command.run', args: ['/id'] },
    { text: 'I should see a notification containing "Locked!"', defId: 'notify.contains', args: ['Locked!'] },
    { text: 'I should see a notification containing "This vehicle is locked."', defId: 'notify.contains', args: ['This vehicle is locked.'] },
  ] };
  const late = extraChecks({ steps: [{ text: 'I confirm: a', defId: 'manual.confirm', kind: 'manual', args: [] }, { text: 'my armour is 0', defId: 'health.armour', kind: 'setup', args: [0] }] }, { facts: {}, allCommands: [], sourceText: '' });
  assert.match(late[0], /setup steps must all come first/);
  const defs = new Map(ctx.steps.map((d) => [d.id, d]));
  const loc = (t, text) => extraChecks({ steps: [t] }, { facts: {}, allCommands: [], sourceText: text, defs, sharedLocations: ['legion_square'], ownLocations: [] });
  assert.equal(loc({ text: 'I am at "legion_square"', defId: 'teleport.location', kind: 'setup', args: ['legion_square'] }, 'Go to a Burger Shot till').length, 1);
  assert.equal(loc({ text: 'I am at "legion_square"', defId: 'teleport.location', kind: 'setup', args: ['legion_square'] }, 'Go to Legion Square').length, 0);
  assert.equal(loc({ text: 'I am at -264, -966, 30', defId: 'teleport.coords', kind: 'setup', args: [-264, -966, 30] }, 'Go to -264,-966,30').length, 0);
  assert.ok(INTERNAL_EVENT.test('trigger qbvehiclekeys:client:lockpickUsed'));
  assert.equal(adminConsole('trigger qbvehiclekeys:client:lockpickUsed', false), false);
  assert.equal(adminConsole('in the server console run lua TriggerEvent(...)', true), true);
  assert.equal(adminConsole('ask a Mod to watch the server console for x:server:y', false), true);
  const errs = extraChecks(sc, { facts: { strings: new Set(['This vehicle is locked.']) }, allCommands: ['/id'], sourceText: 'run /id' });
  assert.equal(errs.length, 3);
  assert.match(errs[0], /coordinates are only allowed/);
  assert.ok(FORBIDDEN_STEPS.has('teleport.coords'));
});

test('helpers: batches, cache key, secret reader, pool, phrase ranking', async () => {
  const b = makeBatches('r', Array.from({ length: 45 }, (_, i) => ({ i })), 20);
  assert.deepEqual(b.map((x) => x.entries.length), [15, 15, 15]);
  assert.notEqual(cacheKey({ system: 'a', prompt: 'b', schema: {} }), cacheKey({ system: 'a', prompt: 'c', schema: {} }));
  const f = path.join(TMP, 's.env');
  fs.writeFileSync(f, '# x\nCLAUDE_CODE_OAUTH_TOKEN="abc"\n');
  assert.equal(readSecret(f, 'CLAUDE_CODE_OAUTH_TOKEN'), 'abc');
  let inFlight = 0, max = 0;
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setImmediate(r)); inFlight--; });
  assert.equal(max, 3);
  const r = rankPhrases([{ resource: 'a', unmapped: ['the HUD shows {String}', '"the HUD shows {string}"'] }, { resource: 'b', unmapped: ['x'] }]);
  assert.equal(r[0].count, 2);
  assert.ok(SCHEMA.properties.scenarios);
});

test('pipeline with a fake model: retry, unconvertible, merge, manual-only, mapping, report', async () => {
  const { res, bot } = makeTree();
  const out = path.join(TMP, 'out');
  const prompts = [];
  const runner = {
    stats: { calls: 0, cached: 0, failed: 0, costUsd: 0, cachedCostUsd: 0 },
    async run({ prompt, label }) {
      this.stats.calls++;
      prompts.push({ label, prompt });
      const retry = /PREVIOUS ATTEMPT FAILED/.test(prompt);
      const all = [
        { id: 'veh-locked', steps: ['Given a "sultan" is spawned in front of me with keys', 'And the vehicle is locked', 'And I am at "bennys_workshop"', 'When I manually: open the trunk from outside', 'Then I should see a notification containing "This vehicle is locked."'], unmapped: ['I open the trunk from outside'], duplicate_of: null },
        { id: 'veh-give', steps: retry ? ['When I run the command "/givekeys 2"', 'Then I confirm: the other player gets keys'] : ['When I run the command "/handkeys 2"'], unmapped: [], duplicate_of: null },
        { id: 'veh-bad', steps: ['Given I am at 1.0, 2.0, 3.0'], unmapped: [], duplicate_of: null },
        { id: 'lock-trunk', steps: ['Then I confirm: trunk refused'], unmapped: [], duplicate_of: 'veh-locked' },
        { id: 'queue', steps: ['Then I confirm: card shows'], unmapped: ['the queue card shows'], duplicate_of: null },
      ];
      const ids = [...prompt.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
      return { output: { scenarios: all.filter((s) => ids.includes(s.id)) } };
    },
  };
  const r = await convert({ outDir: out, resDir: res, botDir: bot, runner, log: () => {} });
  const by = Object.fromEntries(r.entries.map((e) => [e.key, e]));
  assert.equal(by['veh-locked'].status, 'converted');
  assert.equal(by['veh-give'].status, 'converted', by['veh-give'].reason);
  assert.equal(by['veh-give'].attempts, 2);
  assert.equal(by['veh-bad'].status, 'unconvertible');
  assert.match(by['veh-bad'].reason, /coordinates are only allowed/);
  assert.equal(by['checklist:kora_vehiclekeys:lock-trunk'].status, 'merged');
  assert.equal(by['checklist:kora_vehiclekeys:queue'].status, 'converted');
  assert.equal(by['checklist:kora_vehiclekeys:queue'].manualOnly, true);
  assert.equal(runner.stats.calls, 2);
  assert.match(prompts[0].prompt, /Location alias for this test: "bennys_workshop"/);
  assert.match(prompts[0].prompt, /GAME TEST INDEX/);
  const game = fs.readFileSync(path.join(out, 'kora_vehiclekeys', 'tests', 'legacy-game.feature'), 'utf8');
  assert.match(game, /@kora_vehiclekeys @legacy:veh-locked @target:3 @checklist @checklist:kora_vehiclekeys:lock-trunk @cat:vehicles/);
  assert.match(game, /@legacy:veh-give @target:2 @needs:players:2 @regression/);
  assert.match(game, /Also checklist kora_vehiclekeys:lock-trunk/);
  const cl = fs.readFileSync(path.join(out, 'kora_vehiclekeys', 'tests', 'checklist-vehicles.feature'), 'utf8');
  assert.match(cl, /Feature: kora_vehiclekeys — Vehicles/);
  assert.match(cl, /@manual/);
  assert.match(cl, /Checklist test: When the server is full/);
  const mapping = JSON.parse(fs.readFileSync(path.join(out, 'mapping.json'), 'utf8'));
  assert.equal(mapping.game['veh-locked'], by['veh-locked'].scenarioId);
  assert.match(mapping.game['veh-locked'], /^kora_vehiclekeys:tests\/legacy-game\.feature:\d+$/);
  assert.equal(mapping.checklist['kora_vehiclekeys:lock-trunk'], mapping.game['veh-locked']);
  assert.equal(mapping.game['veh-bad'], null);
  // the scenario id line really is the Scenario: line of that test
  const line = Number(mapping.game['veh-locked'].split(':').at(-1));
  assert.match(game.split('\n')[line - 1], /Scenario: Locked vehicle refuses the trunk/);
  const report = fs.readFileSync(path.join(out, 'conversion-report.md'), 'utf8');
  assert.match(report, /\| kora_vehiclekeys \| 5 \| 3 \| 1 \| 1 \| 1 \| 1 \|/);
  assert.match(report, /I open the trunk from outside/);
  assert.match(fs.readFileSync(path.join(out, 'kora_vehiclekeys', 'tests', 'qa.lua'), 'utf8'), /bennys_workshop/);
  // whole staging tree validates with the panel's CLI context too
  const ctx = loadValidationContext({ resDir: res, stagingDir: out });
  for (const f of ['legacy-game.feature', 'checklist-vehicles.feature']) {
    const v = validateFeatureText(fs.readFileSync(path.join(out, 'kora_vehiclekeys', 'tests', f), 'utf8'), { resource: 'kora_vehiclekeys', file: `tests/${f}`, ctx });
    assert.equal(v.ok, true, JSON.stringify(v.results.flatMap((x) => x.errors)));
  }
  assert.ok(buildPrompt);
});
