// Pure units: status machine, XP rules, ids, file tokens, Lua reader, report renderer, env parsing.
import { done } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, xpFor, canSet, allowedOps, parseExpect, HOOK_ACTIONS, statusName } from '../server/machine.js';
import { snowflake, snowflakeTime, ISSUE_ID_RE } from '../server/ids.js';
import { signFileToken, verifyFileToken, sniffImage } from '../server/files.js';
import { parseLuaReturn, parseLuaAssignment, parseLuaValue } from '../server/scenarios/lua.js';
import { renderReport, inventoryDiff } from '../server/render-report.js';
import { parseEnv } from '../server/config.js';
import { backoff } from '../server/xp.js';
import { closePool } from '../server/db.js';

test.after(done);

test('decide: Not fixed counts and escalates at 3', () => {
  assert.deepEqual(decide({ from: 'awaiting_test', op: 'not_fixed', notFixedCount: 0 }), { to: 'open', notFixedCount: 1, testing: true, escalated: false });
  assert.deepEqual(decide({ from: 'awaiting_test', op: 'not_fixed', notFixedCount: 2 }), { to: 'needs_manual_review', notFixedCount: 3, testing: true, escalated: true });
  assert.ok(decide({ from: 'open', op: 'not_fixed' }).error);
  assert.deepEqual(decide({ from: 'awaiting_test', op: 'works' }), { to: 'fixed', testing: true });
  assert.equal(decide({ from: 'fix_attempted', op: 'fixed' }).to, 'fixed');
  assert.ok(decide({ from: 'open', op: 'bogus' }).error);
});

test('hook actions and expect aliases match communitybot', () => {
  assert.deepEqual(Object.keys(HOOK_ACTIONS), ['prompt_ready', 'fix_initiated', 'fix_in_progress', 'fixed_awaiting_restart', 'awaiting_test', 'fix_attempted', 'fixed', 'needs_info', 'needs_manual_review', 'reopen']);
  assert.deepEqual(parseExpect('reopen'), { expect: 'open' });
  assert.deepEqual(parseExpect('fix_attempted'), { expect: 'awaiting_test' });
  assert.ok(parseExpect(5).error);
  assert.equal(statusName('fixed_awaiting_restart'), 'Fix attempted, awaiting restart');
});

test('permissions per role', () => {
  assert.equal(canSet({ role: 'tester', op: 'works', from: 'awaiting_test' }), true);
  assert.equal(canSet({ role: 'tester', op: 'works', from: 'open' }), false);
  assert.equal(canSet({ role: 'tester', op: 'confirmed', from: 'open' }), false);
  assert.equal(canSet({ role: 'dev', op: 'confirmed', from: 'open' }), true);
  assert.equal(canSet({ role: 'dev', op: 'dup', from: 'open' }), false);
  assert.equal(canSet({ role: 'admin', op: 'wontfix', from: 'open' }), true);
  assert.deepEqual(allowedOps({ role: 'tester', from: 'awaiting_test' }), ['works', 'not_fixed']);
  assert.deepEqual(allowedOps({ role: 'dev', from: 'open' }), ['info', 'confirmed', 'needs_manual_review']);
});

test('xp rules', () => {
  const R = '1'; const D = '2';
  assert.deepEqual(xpFor({ from: 'open', to: 'confirmed', reporterId: R, actorId: D, actorRole: 'dev' }).events, [{ event: 'bug_confirmed', discordId: R }, { event: 'bug_triaged', discordId: D }]);
  assert.deepEqual(xpFor({ from: 'awaiting_test', to: 'fixed', reporterId: R, system: true }), { events: [{ event: 'bug_fixed', discordId: R }], setFixedPaid: true });
  assert.deepEqual(xpFor({ from: 'awaiting_test', to: 'fixed', reporterId: R, system: true, fixedPaid: true }).events, []);
  assert.deepEqual(xpFor({ from: 'open', to: 'dup', reporterId: R, actorId: D, actorRole: 'admin' }).events.map((e) => e.event), ['bug_revoked', 'bug_triaged']);
  assert.deepEqual(xpFor({ from: 'open', to: 'wontfix', reporterId: R, system: true }).events, []);
  assert.deepEqual(xpFor({ from: 'open', to: 'fix_initiated', reporterId: R, actorId: D, actorRole: 'admin' }).events, [], 'fixer statuses give no triage XP');
  assert.deepEqual(xpFor({ from: 'open', to: 'confirmed', reporterId: R, actorId: R, actorRole: 'dev' }).events, [{ event: 'bug_confirmed', discordId: R }], 'no triage XP on your own issue');
  assert.deepEqual(xpFor({ from: 'awaiting_test', to: 'open', reporterId: R, actorId: D, actorRole: 'tester', testing: true }).events, [{ event: 'bug_triaged', discordId: D }]);
  assert.deepEqual(xpFor({ from: 'open', to: 'info', reporterId: R, actorId: D, actorRole: 'tester' }).events, []);
});

test('snowflake ids', () => {
  const t = Date.UTC(2026, 10, 9);
  const a = snowflake(t);
  const b = snowflake(t);
  assert.match(a, ISSUE_ID_RE);
  assert.notEqual(a, b);
  assert.equal(snowflakeTime(a), t);
  assert.equal((BigInt(a) >> 17n) & 31n, 31n);
});

test('file tokens', () => {
  const tok = signFileToken(42);
  assert.equal(verifyFileToken(42, tok), true);
  assert.equal(verifyFileToken(43, tok), false);
  assert.equal(verifyFileToken(42, `${tok}x`), false);
  assert.equal(verifyFileToken(42, tok, { now: Date.now() + 9 * 86400000 }), false);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg>')), null);
});

test('lua reader', () => {
  assert.deepEqual(parseLuaReturn(`-- c\nreturn { locations = { a = vector4(1, 2.5, -3, 90) , ['b c'] = {x=1,y=2,z=3} }, fixtures = { 'f1', "f2" }, vehicles = { v = 'sultan' }, }`),
    { locations: { a: { x: 1, y: 2.5, z: -3, h: 90 }, 'b c': { x: 1, y: 2, z: 3 } }, fixtures: ['f1', 'f2'], vehicles: { v: 'sultan' } });
  assert.deepEqual(parseLuaReturn('local t = { a = 1 }\nreturn t'), { a: 1 });
  assert.deepEqual(parseLuaAssignment('Config = {}\nConfig.caps = { maxItemCount = 5, itemAllow = nil, modelDeny = { "rhino" }, x = GetConvar("a", "b") }', 'Config.caps'),
    { maxItemCount: 5, itemAllow: null, modelDeny: ['rhino'], x: { __expr: 'GetConvar("a", "b")' } });
  assert.deepEqual(parseLuaValue('{ [[long\nstr]], 0x10, true, nil }'), ['long\nstr', 16, true, null]);
  assert.throws(() => parseLuaReturn('x = 1'));
});

test('report renderer', () => {
  const md = renderReport({
    issue: { title: 'Selling fails', reporter_name: 'Tess', source: 'scenario' },
    report: {
      v: 1, scenario: { id: 'kora_fishing:tests/selling.feature:8', hash: 'abcdef1234567', name: 'Selling a fish' }, failedIdx: 1,
      steps: [{ idx: 0, text: 'I have 2 "fish"', status: 'passed' }, { idx: 1, text: 'my cash balance should have changed by 50', status: 'failed', detail: { got: 0 } }, { idx: 2, text: 'I confirm: x', status: 'skipped' }],
      expected: 'cash +50', actual: 'cash +0', note: 'nothing happened ```', frequency: 'always',
      timeline: Array.from({ length: 45 }, (_, i) => ({ at: 1000 + i, type: 'mark', data: { i } })),
      console: [{ at: 1, channel: 'script:kora_fishing', line: 'SCRIPT ERROR: attempt to index nil' }, { at: 2, channel: 'kora_fishing', line: 'loaded ok' }],
      player: { coords: { x: 1, y: 2, z: 3, h: 4 }, street: 'Pier', job: { name: 'unemployed', grade: 0 }, gang: { name: 'none', grade: 0 }, routingBucket: 3, money: { cash: 100, bank: 5 } },
      inventoryBefore: [{ name: 'fish', count: 2 }], inventoryAfter: [],
      screenshot: { available: false, reason: 'screenshot-basic missing' },
      teardown: [{ id: 'items.have', idx: 0, ok: true }, { id: 'vehicle.spawn', idx: 3, ok: false, error: 'entity gone' }],
      moneyBefore: { cash: 50, bank: 5 },
    },
    scenario: { steps: [{ idx: 0, keyword: 'Given' }, { idx: 1, keyword: 'Then' }] },
  });
  assert.match(md, /^# Selling fails/);
  assert.match(md, /✅ Given I have 2 "fish"/);
  assert.match(md, /❌ Then my cash balance should have changed by 50 {3}<-- failed here/);
  assert.match(md, /⏭ I confirm: x/);
  assert.match(md, /## Timeline \(last 40 of 45\)/);
  assert.match(md, /SCRIPT ERROR/);
  assert.doesNotMatch(md, /loaded ok/);
  assert.match(md, /~~~~\nnothing happened ```\n~~~~/);
  assert.match(md, /- fish: 2 → 0 \(-2\)/);
  assert.match(md, /## Teardown \(1\/2 undone\)\n- ❌ step 4 vehicle\.spawn: entity gone/);
  assert.match(md, /- Gang: none grade 0/);
  assert.match(md, /- Routing bucket: 3/);
  assert.match(md, /_No screenshot: screenshot-basic missing_/);
  assert.match(md, /before the run: cash 50/);
  assert.match(renderReport({ report: { console: [{ at: 1, channel: 'x', line: 'boom', error: true }] } }), /\[x\] ERROR boom/);
  assert.deepEqual(inventoryDiff([{ name: 'a', amount: 1 }], [{ name: 'a', amount: 3 }, { name: 'b' }]), [{ name: 'a', before: 1, after: 3, delta: 2 }, { name: 'b', before: 0, after: 1, delta: 1 }]);
});

test('env parsing and backoff', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="x y"\nexport C=\'z\'\nD=v # comment\n bad line'), { A: '1', B: 'x y', C: 'z', D: 'v' });
  assert.equal(backoff(1), 5000);
  assert.equal(backoff(3), 20000);
  assert.equal(backoff(30), 30 * 60 * 1000);
});
