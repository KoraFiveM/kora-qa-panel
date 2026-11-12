// Game API: loopback + bearer, registry, scenarios, runs (pass / fail -> issue), retests (works / not fixed), freeform
// issues, uploads, server-started with the applied.json rule, bug_posted / test XP.
import { resetDb, done, q, SECRETS, TMP } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { runScan } from '../server/scenarios/service.js';
import { createIssue, transition } from '../server/issues.js';
import { bugView } from '../server/bugview.js';

let app;
const AUTH = { authorization: `Bearer ${SECRETS.KORA_QA_GAME_SECRET}` };
const TESTER = '300000000000000001';
const SCN = 'kora_fishing:tests/selling.feature:8';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const g = (method, url, payload, headers = {}) => app.inject({ method, url: `/qa/game${url}`, payload, headers: { ...AUTH, ...headers } });

before(async () => {
  await resetDb();
  await runScan();
  app = await buildApp();
  await q("INSERT INTO users (discord_id, name, role, created_at) VALUES (?, 'Tess', 'tester', 0)", [TESTER]);
});
after(async () => { await app.close(); await done(); });

test('auth: bearer and loopback only, nginx-forwarded refused', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/qa/game/scenarios' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/qa/game/scenarios', headers: { authorization: 'Bearer nope' } })).statusCode, 401);
  assert.equal((await g('GET', '/scenarios', undefined, { 'x-forwarded-for': '1.2.3.4' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/qa/game/scenarios', headers: AUTH, remoteAddress: '10.0.0.5' })).statusCode, 404);
  assert.equal((await g('GET', '/scenarios')).statusCode, 200);
});

test('registry + scenarios + tester', async () => {
  let r = await g('POST', '/registry', { steps: [{ id: 'x.y', pattern: 'I fish', kind: 'observed' }], aliases: {}, caps: { maxItemCount: 50 } });
  assert.deepEqual(r.json(), { ok: true, steps: 1 });
  assert.equal((await g('POST', '/registry', { nope: 1 })).statusCode, 400);
  r = await g('GET', '/scenarios');
  assert.ok(r.json().scenarios.some((s) => s.id === SCN));
  assert.deepEqual((await g('GET', `/tester?discordId=${TESTER}`)).json(), { allowed: true, role: 'tester' });
  assert.deepEqual((await g('GET', '/tester?discordId=300000000000000999')).json(), { allowed: false, role: null, reason: 'log into the panel once' });
});

test('passed run pays test_passed once per scenario version', async () => {
  const { runId } = (await g('POST', '/runs', { scenarioId: SCN, scenarioHash: null, discordId: TESTER, name: 'Tess' })).json();
  assert.ok(runId);
  const steps = await q('SELECT idx, status FROM run_steps WHERE run_id = ? ORDER BY idx', [runId]);
  assert.equal(steps.length, 8, "background + 7");
  assert.equal((await g('POST', `/runs/${runId}/steps`, { idx: 0, status: 'passed', detail: { ok: true } })).statusCode, 200);
  assert.equal((await g('POST', `/runs/${runId}/steps`, { idx: 0, status: 'bogus' })).statusCode, 400);
  assert.deepEqual((await g('POST', `/runs/${runId}/finish`, { status: 'passed' })).json(), { ok: true });
  assert.equal((await g('POST', `/runs/${runId}/finish`, { status: 'passed' })).statusCode, 409);
  const { runId: r2 } = (await g('POST', '/runs', { scenarioId: SCN, discordId: TESTER })).json();
  await g('POST', `/runs/${r2}/finish`, { status: 'passed' });
  const xp = await q("SELECT issue_id FROM xp_outbox WHERE event = 'test_passed'");
  assert.equal(xp.length, 1);
  assert.match(xp[0].issue_id, /^test:[0-9a-f]{40}$/);
  assert.equal((await g('POST', '/runs', { scenarioId: 'nope:x:1', discordId: TESTER })).statusCode, 404);
});

let failedIssue;
test('failed run with context creates a scenario issue with report, upload and XP', async () => {
  const { runId } = (await g('POST', '/runs', { scenarioId: SCN, discordId: TESTER, name: 'Tess' })).json();
  const up = await app.inject({ method: 'POST', url: `/qa/game/uploads?runId=${runId}`, payload: JPEG, headers: { ...AUTH, 'content-type': 'image/jpeg' } });
  assert.equal(up.statusCode, 200, up.body);
  const { attachmentId } = up.json();
  const context = { v: 1, scenario: { id: SCN, hash: 'x', name: 'Selling a fish pays cash' }, failedIdx: 5, steps: [{ idx: 4, text: 'I should have no "fish"', status: 'passed' }, { idx: 5, text: 'my cash balance should have changed by 50', status: 'failed', detail: { delta: 0 } }], expected: '+50', actual: '0', note: 'no money', frequency: 'always', timeline: [], console: [] };
  const r = await g('POST', `/runs/${runId}/finish`, { status: 'failed', context, note: 'no money' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.match(body.issueId, /^\d{18,19}$/);
  assert.equal(body.url, `https://example.test/qa/issues/${body.issueId}`);
  failedIssue = body.issueId;
  const issue = (await q('SELECT * FROM issues WHERE id = ?', [failedIssue]))[0];
  assert.equal(issue.source, 'scenario'); assert.equal(issue.failed_step, 5); assert.equal(issue.scenario_id, SCN); assert.equal(Number(issue.run_id), runId);
  assert.equal(String((await q('SELECT issue_id FROM issue_attachments WHERE id = ?', [attachmentId]))[0].issue_id), failedIssue);
  const ev = (await q('SELECT event FROM xp_outbox WHERE issue_id = ? ORDER BY event', [failedIssue])).map((x) => x.event);
  assert.deepEqual(ev, ['bug_posted', 'test_failed_report']);
  const view = await bugView(failedIssue);
  assert.equal(view.messages[0].author, 'Tess');
  assert.match(view.messages[0].content, /❌ Then my cash balance should have changed by 50/);
  assert.match(view.messages[0].attachments[0], new RegExp(`^https://example\\.test/qa/files/${attachmentId}\\?t=`));
});

test('uploads validation', async () => {
  assert.equal((await app.inject({ method: 'POST', url: `/qa/game/uploads?issueId=${failedIssue}`, payload: Buffer.from('<svg/>'), headers: { ...AUTH, 'content-type': 'image/png' } })).statusCode, 415);
  assert.equal((await app.inject({ method: 'POST', url: '/qa/game/uploads', payload: JPEG, headers: { ...AUTH, 'content-type': 'image/jpeg' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/qa/game/uploads?issueId=${failedIssue}`, payload: Buffer.alloc(9 * 1024 * 1024), headers: { ...AUTH, 'content-type': 'image/jpeg' } })).statusCode, 413);
  const ok = await app.inject({ method: 'POST', url: `/qa/game/uploads?issueId=${failedIssue}`, payload: JPEG, headers: { ...AUTH, 'content-type': 'image/jpeg' } });
  assert.equal(ok.statusCode, 200);
});

test('freeform issue', async () => {
  const r = await g('POST', '/issues', { discordId: TESTER, name: 'Tess', title: '  Shop  is closed ', note: 'The shop never opens', frequency: 'sometimes', kind: 'bug', report: { v: 1, player: { coords: { x: 1, y: 2, z: 3, h: 0 } } } });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().issueId;
  const row = (await q('SELECT * FROM issues WHERE id = ?', [id]))[0];
  assert.equal(row.title, 'Shop is closed'); assert.equal(row.source, 'freeform'); assert.equal(row.report.note, 'The shop never opens'); assert.equal(row.report.frequency, 'sometimes');
  assert.equal((await g('POST', '/issues', { discordId: TESTER, title: 'x', note: '' })).statusCode, 400);
  assert.equal((await g('POST', '/issues', { discordId: TESTER, title: 'x', note: 'y', frequency: 'daily' })).statusCode, 400);
});

test('retests: pass -> fixed, fail -> Not fixed with failing step', async () => {
  const mk = async (id) => {
    await createIssue({ id, source: 'scenario', title: 'R', reporterDiscordId: '300000000000000002', scenarioId: SCN });
    await q("UPDATE issues SET status = 'awaiting_test' WHERE id = ?", [id]);
  };
  await mk('1570000000000000101');
  await mk('1570000000000000102');
  const list = (await g('GET', '/retests')).json().retests;
  assert.deepEqual(list.map((x) => x.issueId).sort(), ['1570000000000000101', '1570000000000000102']);
  assert.deepEqual(Object.keys(list[0]), ['issueId', 'title', 'scenarioId', 'notFixedCount']);

  let { runId } = (await g('POST', '/runs', { scenarioId: SCN, discordId: TESTER, retestIssueId: '1570000000000000101' })).json();
  let r = await g('POST', `/runs/${runId}/finish`, { status: 'passed' });
  assert.equal(r.json().issueId, '1570000000000000101');
  assert.equal((await q("SELECT status FROM issues WHERE id = '1570000000000000101'"))[0].status, 'fixed');

  ({ runId } = (await g('POST', '/runs', { scenarioId: SCN, discordId: TESTER, retestIssueId: '1570000000000000102' })).json());
  r = await g('POST', `/runs/${runId}/finish`, { status: 'failed', note: 'still broken', context: { v: 1, failedIdx: 5, steps: [{ idx: 5, text: 'my cash balance should have changed by 50', status: 'failed' }] } });
  assert.equal(r.statusCode, 200, r.body);
  const row = (await q("SELECT status, not_fixed_count FROM issues WHERE id = '1570000000000000102'"))[0];
  assert.deepEqual(row, { status: 'open', not_fixed_count: 1 });
  const msgs = await q("SELECT content, is_bot FROM issue_messages WHERE issue_id = '1570000000000000102' ORDER BY id");
  assert.ok(msgs.some((m) => !m.is_bot && /Retest failed.*step 6/.test(m.content)));
  assert.equal((await g('POST', '/runs', { scenarioId: SCN, discordId: TESTER, retestIssueId: '1570000000000000102' })).statusCode, 409);
});

test('server-started moves only applied (or patchless) fixes', async () => {
  const ids = { applied: '1570000000000000201', waiting: '1570000000000000202', none: '1570000000000000203', history: '1570000000000000204' };
  for (const id of Object.values(ids)) {
    await createIssue({ id, source: 'discord', title: id });
    await transition({ issueId: id, op: 'fixed_awaiting_restart', system: true });
  }
  const fx = path.join(TMP, 'fix', 'fixes');
  for (const id of [ids.applied, ids.waiting]) { fs.mkdirSync(path.join(fx, id), { recursive: true }); fs.writeFileSync(path.join(fx, id, 'meta.json'), JSON.stringify({ threadId: id, patchId: 'abc1234567' })); }
  fs.writeFileSync(path.join(fx, ids.applied, 'applied.json'), JSON.stringify({ appliedAt: '2026-11-09T10:00:00+00:00', backupTag: 'x' }));
  fs.mkdirSync(path.join(fx, ids.history, 'history', '20261101T000000Z'), { recursive: true });
  const r = (await g('POST', '/server-started', {})).json();
  assert.equal(r.moved, 3);
  assert.deepEqual(r.held, [ids.waiting]);
  const st = Object.fromEntries((await q(`SELECT id, status FROM issues WHERE id IN (${Object.values(ids).map(() => '?').join(',')})`, Object.values(ids))).map((x) => [String(x.id), x.status]));
  assert.equal(st[ids.applied], 'awaiting_test'); assert.equal(st[ids.none], 'awaiting_test'); assert.equal(st[ids.history], 'awaiting_test'); assert.equal(st[ids.waiting], 'fixed_awaiting_restart');
});

test('GET /runs (My runs) and passes in /scenarios', async () => {
  const r = await g('GET', `/runs?discordId=${TESTER}`);
  assert.equal(r.statusCode, 200);
  const runs = r.json().runs;
  assert.ok(runs.length >= 4);
  assert.deepEqual(Object.keys(runs.find((x) => x.issueId)).sort(), ['at', 'issueId', 'name', 'runId', 'scenarioId', 'status']);
  assert.equal(runs[0].name, 'Selling a fish pays cash');
  assert.equal((await g('GET', '/runs?discordId=x')).statusCode, 400);
  const served = (await g('GET', '/scenarios')).json();
  assert.equal(served.scenarios.find((s) => s.id === SCN).passes, 1, 'one distinct tester passed');
  assert.equal(served.scenarios.find((s) => s.id === 'kora_hud:tests/id.feature:3').passes, 0);
});
