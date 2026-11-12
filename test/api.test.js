// UI REST API: dev login, roles, issues (list/detail/comments/status/not-fixed/works/meta/override), files, fixes
// (fake apply-fix), users, scenarios, runs, testers, auth pages.
import { resetDb, done, q, TMP } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { createIssue, addMessage } from '../server/issues.js';
import { runScan } from '../server/scenarios/service.js';
import { storeFile } from '../server/files.js';
import { bugView } from '../server/bugview.js';

let app;
const cookies = {};
const ADMIN = '100000000000000001';
const DEV = '100000000000000002';
const TESTER = '100000000000000003';
const REPORTER = '100000000000000009';
const ISSUE = '1570000000000000301';

async function login(discordId, role) {
  const r = await app.inject({ method: 'GET', url: `/qa/auth/dev-login?discordId=${discordId}&role=${role}&name=${role}&redirect=0` });
  assert.equal(r.statusCode, 200, r.body);
  cookies[role] = r.cookies.find((c) => c.name === 'kqa_sid').value;
}
const api = (role, method, url, payload) => app.inject({ method, url: `/qa/api${url}`, payload, cookies: role ? { kqa_sid: cookies[role] } : {} });

before(async () => {
  await resetDb();
  await runScan();
  app = await buildApp();
  await login(ADMIN, 'admin');
  await login(DEV, 'dev');
  await login(TESTER, 'tester');
  await createIssue({ id: ISSUE, source: 'discord', title: 'Broken fishing', reporterDiscordId: REPORTER, reporterName: 'Rae' });
  await addMessage({ issueId: ISSUE, discordId: REPORTER, name: 'Rae', content: 'It broke' });
});
after(async () => { await app.close(); await done(); });

test('me, auth guard, dev-login is loopback only', async () => {
  assert.equal((await api(null, 'GET', '/me')).json().user, null);
  assert.equal((await api('tester', 'GET', '/me')).json().user.role, 'tester');
  assert.equal((await api(null, 'GET', '/issues')).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/qa/auth/dev-login?discordId=${TESTER}`, headers: { 'x-forwarded-for': '1.1.1.1' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/qa/api/issues/1/comments', payload: { content: 'x' }, headers: { origin: 'https://evil.example' }, cookies: { kqa_sid: cookies.tester } })).statusCode, 403);
  const login = await app.inject({ method: 'GET', url: '/qa/auth/login' });
  assert.equal(login.statusCode, 503);
  assert.match(login.body, /not configured/);
  assert.equal((await api('tester', 'GET', '/nope')).statusCode, 404);
});

test('issues list and detail', async () => {
  const l = (await api('tester', 'GET', '/issues?status=open&q=fish')).json();
  assert.equal(l.total, 1);
  assert.equal(l.items[0].id, ISSUE);
  assert.equal(l.items[0].messages, 1);
  assert.equal((await api('tester', 'GET', '/issues?status=closed')).json().total, 0);
  const d = (await api('tester', 'GET', `/issues/${ISSUE}`)).json();
  assert.equal(d.issue.title, 'Broken fishing');
  assert.deepEqual(d.allowedOps, []);
  assert.deepEqual(d.promptPreview, await bugView(ISSUE));
  assert.equal(d.events[0].to, 'open');
  assert.equal((await api('tester', 'GET', '/issues/1570000000000000999')).statusCode, 404);
});

test('comments bump updatedAt for the fixer', async () => {
  const before = (await q('SELECT updated_at FROM issues WHERE id = ?', [ISSUE]))[0].updated_at;
  await new Promise((r) => setTimeout(r, 5));
  const r = await api('tester', 'POST', `/issues/${ISSUE}/comments`, { content: 'Me too, every time' });
  assert.equal(r.statusCode, 200);
  assert.ok((await q('SELECT updated_at FROM issues WHERE id = ?', [ISSUE]))[0].updated_at > before);
  assert.equal((await api('tester', 'POST', `/issues/${ISSUE}/comments`, { content: '' })).statusCode, 400);
});

test('status permissions and XP', async () => {
  assert.equal((await api('tester', 'POST', `/issues/${ISSUE}/status`, { status: 'confirmed' })).statusCode, 403);
  let r = await api('dev', 'POST', `/issues/${ISSUE}/status`, { status: 'confirmed', note: 'repro ok' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().from, r.json().to], ['open', 'confirmed']);
  assert.equal((await api('dev', 'POST', `/issues/${ISSUE}/status`, { status: 'dup' })).statusCode, 403);
  assert.equal((await api('dev', 'POST', `/issues/${ISSUE}/status`, { status: 'confirmed' })).statusCode, 409);
  assert.equal((await api('dev', 'POST', `/issues/${ISSUE}/status`, { status: 'info', expect: 'open' })).statusCode, 409);
  const xp = (await q('SELECT event, discord_id FROM xp_outbox WHERE issue_id = ? ORDER BY event', [ISSUE])).map((x) => `${x.event}:${x.discord_id}`);
  assert.deepEqual(xp, [`bug_confirmed:${REPORTER}`, `bug_triaged:${DEV}`]);
});

test('Mod override reaches the fixer', async () => {
  let r = await api('tester', 'POST', `/issues/${ISSUE}/status`, { status: 'open', override: 'try again' });
  assert.equal(r.statusCode, 403);
  r = await api('dev', 'POST', `/issues/${ISSUE}/status`, { status: 'open', override: 'try the server side this time' });
  assert.equal(r.statusCode, 200, r.body);
  const v = await bugView(ISSUE);
  assert.equal(v.modOverride.reason, 'try the server side this time');
  assert.equal(v.modOverride.by, 'dev');
  const bot = v.messages.filter((m) => m.isBot).at(-1);
  assert.match(bot.content, /^Mod override: try a fix — try the server side this time$/m);
});

test('works / not fixed flow escalates after 3', async () => {
  const setAwaiting = () => q("UPDATE issues SET status = 'awaiting_test' WHERE id = ?", [ISSUE]);
  await setAwaiting();
  assert.equal((await api('tester', 'POST', `/issues/${ISSUE}/not-fixed`, {})).statusCode, 400);
  for (let i = 1; i <= 3; i++) {
    await setAwaiting();
    const r = await api('tester', 'POST', `/issues/${ISSUE}/not-fixed`, { note: `round ${i}` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().to, i < 3 ? 'open' : 'needs_manual_review');
  }
  assert.equal((await q('SELECT not_fixed_count FROM issues WHERE id = ?', [ISSUE]))[0].not_fixed_count, 3);
  assert.equal((await api('tester', 'POST', `/issues/${ISSUE}/works`, {})).statusCode, 403);
  await setAwaiting();
  const w = await api('tester', 'POST', `/issues/${ISSUE}/works`, { note: 'all good' });
  assert.equal(w.json().to, 'fixed');
  const xp = (await q("SELECT event FROM xp_outbox WHERE issue_id = ? AND event IN ('bug_fixed','bug_triaged') AND discord_id IN (?, ?)", [ISSUE, REPORTER, TESTER])).map((x) => x.event).sort();
  assert.deepEqual(xp, ['bug_fixed', 'bug_triaged']);
});

test('meta (dev)', async () => {
  assert.equal((await api('tester', 'POST', `/issues/${ISSUE}/meta`, { title: 'x' })).statusCode, 403);
  const r = await api('dev', 'POST', `/issues/${ISSUE}/meta`, { title: 'Fishing: sell broken', kind: 'suggestion' });
  assert.equal(r.json().issue.kind, 'suggestion');
  assert.equal(r.json().issue.title, 'Fishing: sell broken');
});

test('files: session or signed token', async () => {
  const { rel } = storeFile(Buffer.from([0xff, 0xd8, 0xff, 1, 2]), 'image/jpeg');
  const [ins] = [await q('INSERT INTO issue_attachments (issue_id, kind, path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)', [ISSUE, 'screenshot', rel, 'image/jpeg', 5, Date.now()])];
  const id = ins.insertId;
  assert.equal((await app.inject({ method: 'GET', url: `/qa/files/${id}` })).statusCode, 401);
  const view = await bugView(ISSUE);
  const url = new URL(view.messages[0].attachments.find((u) => u.includes(`/files/${id}?`)));
  const r = await app.inject({ method: 'GET', url: `/qa/files/${id}${url.search}` });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal((await api('tester', 'GET', `/files/${id}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/qa/files/${id}?t=zz.bad` })).statusCode, 401);
});

test('fixes: list, detail, apply needs admin + confirm', async () => {
  const dir = path.join(TMP, 'fix', 'fixes', ISSUE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ threadId: ISSUE, title: 'Broken fishing', model: 'claude-sonnet-5-5', patchId: 'abcdef1234', createdAt: '2026-11-09T10:00:00+00:00', kind: 'bug', summary: 'nil check', details: 'd', risk: 'low', testSteps: 't', reasoning: 'r', resources: [{ name: 'kora_fishing', path: '/x', head: 'abc', patch: 'kora_fishing.patch' }] }));
  fs.writeFileSync(path.join(dir, 'kora_fishing.patch'), '--- a/x\n+++ b/x\n');
  assert.equal((await api('tester', 'GET', '/fixes')).statusCode, 403);
  const l = (await api('dev', 'GET', '/fixes?state=waiting')).json();
  assert.equal(l.items.length, 1);
  assert.deepEqual(l.items[0].resources, ['kora_fishing']);
  const d = (await api('dev', 'GET', `/fixes/${ISSUE}`)).json();
  assert.equal(d.diffSource, 'apply-fix --show');
  assert.match(d.diff, /^----- kora_fishing\.patch/);
  assert.equal((await api('dev', 'POST', `/fixes/${ISSUE}/apply`, { confirm: true })).statusCode, 403);
  assert.equal((await api('admin', 'POST', `/fixes/${ISSUE}/apply`, {})).statusCode, 400);
  const a = await api('admin', 'POST', `/fixes/${ISSUE}/apply`, { confirm: true, noRestart: true });
  assert.equal(a.statusCode, 200, a.body);
  assert.match(a.json().output, new RegExp(`fake --apply ${ISSUE} --no-restart`));
  const ev = (await q("SELECT note FROM issue_events WHERE issue_id = ? AND type = 'fix'", [ISSUE]))[0];
  assert.match(ev.note, /apply \(no restart\): ok/);
});

test('users (admin) and the last-admin guard', async () => {
  assert.equal((await api('dev', 'GET', '/users')).statusCode, 403);
  const r = await api('admin', 'POST', '/users', { discordId: '100000000000000077', name: 'New', role: 'tester' });
  assert.equal(r.json().user.role, 'tester');
  assert.equal((await api('admin', 'POST', '/users/100000000000000077/role', { role: 'dev' })).json().user.role, 'dev');
  assert.equal((await api('admin', 'POST', `/users/${ADMIN}/role`, { role: 'tester' })).statusCode, 409);
  assert.ok((await api('admin', 'GET', '/users')).json().items.length >= 4);
});

test('scenarios, runs, testers, dashboard, meta', async () => {
  const s = (await api('tester', 'GET', '/scenarios?resource=kora_fishing')).json();
  assert.ok(s.items.length >= 4);
  assert.ok(s.resources.some((r) => r.resource === 'kora_fishing'));
  const id = encodeURIComponent('kora_fishing:tests/selling.feature:8');
  const sd = (await api('tester', 'GET', `/scenarios/${id}`)).json();
  assert.equal(sd.scenario.steps.length, 8);
  assert.ok((await api('tester', 'GET', '/scenarios/invalid')).json().items.some((x) => x.id === 'kora_broken:tests/bad.feature:0'));
  const cov = (await api('tester', 'GET', '/scenarios/coverage')).json();
  assert.ok(cov.withoutScenarios.includes('monitor'));
  assert.equal((await api('tester', 'POST', '/scenarios/rescan')).statusCode, 403);
  assert.equal((await api('dev', 'POST', '/scenarios/rescan')).json().ok, true);
  await q("INSERT INTO runs (scenario_id, discord_id, name, status, started_at, finished_at) VALUES ('kora_fishing:tests/selling.feature:8', ?, 'tester', 'passed', ?, ?)", [TESTER, Date.now(), Date.now()]);
  const runs = (await api('tester', 'GET', '/runs?status=passed')).json();
  assert.equal(runs.total, 1);
  const rd = (await api('tester', 'GET', `/runs/${runs.items[0].id}`)).json();
  assert.equal(rd.run.status, 'passed');
  assert.ok((await api('tester', 'GET', '/testers')).json().items.some((t) => t.discordId === TESTER && t.runs.passed === 1));
  assert.equal((await api('tester', 'GET', `/testers/${TESTER}`)).json().tester.runs.passed, 1);
  const dash = (await api('tester', 'GET', '/dashboard')).json();
  assert.equal(dash.runsToday.passed, 1);
  const meta = (await api('tester', 'GET', '/meta')).json();
  assert.equal(meta.statuses.length, 13);
  assert.ok(meta.steps.some((x) => x.id === 'manual.confirm'));
  assert.equal((await api('tester', 'GET', '/retests')).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/qa/issues/123' })).statusCode, 200, 'SPA fallback');
  assert.equal((await app.inject({ method: 'GET', url: '/qa' })).statusCode, 301);
});

test('issues filter: status is literal, state/open=1 are groups', async () => {
  await createIssue({ id: '1570000000000000401', source: 'discord', title: 'Lit open' });
  await createIssue({ id: '1570000000000000402', source: 'discord', title: 'Info one' });
  await q("UPDATE issues SET status = 'info' WHERE id = '1570000000000000402'");
  const ids = async (qs) => (await api('tester', 'GET', `/issues?${qs}&pageSize=200`)).json().items.map((i) => i.id).sort();
  const literal = await ids('status=open');
  assert.ok(literal.includes('1570000000000000401') && !literal.includes('1570000000000000402'));
  assert.ok((await ids('state=open')).includes('1570000000000000402'));
  assert.deepEqual(await ids('open=1'), await ids('state=open'));
  assert.deepEqual(await ids('status=closed'), await ids('state=closed'), 'one-release compat');
  assert.deepEqual(await ids('state=open&status=info'), ['1570000000000000402']);
});

test('admin: dismiss refused sign-in, disable/enable user', async () => {
  await q("INSERT INTO kv (k, v) VALUES ('pending_logins', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify([{ discordId: '100000000000000088', name: 'x', at: 1 }])]);
  assert.equal((await api('dev', 'POST', '/users/pending/100000000000000088/dismiss', {})).statusCode, 403);
  assert.deepEqual((await api('admin', 'POST', '/users/pending/100000000000000088/dismiss', {})).json(), { ok: true, dismissed: 1 });
  assert.deepEqual((await api('admin', 'GET', '/users')).json().pendingLogins, []);
  assert.equal((await api('admin', 'POST', `/users/${ADMIN}/disabled`, { disabled: true })).statusCode, 409, 'not yourself');
  assert.equal((await api('admin', 'POST', `/users/${TESTER}/disabled`, { disabled: 'yes' })).statusCode, 400);
  const r = await api('admin', 'POST', `/users/${TESTER}/disabled`, { disabled: true });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().user.disabled, true);
  assert.ok(r.json().sessionsRevoked >= 1);
  assert.equal((await api('tester', 'GET', '/me')).json().user, null, 'session revoked');
  assert.equal((await app.inject({ method: 'GET', url: `/qa/auth/dev-login?discordId=${TESTER}&redirect=0` })).statusCode, 403, 'cannot log in');
  const G = { authorization: `Bearer ${process.env.KORA_QA_GAME_SECRET}` };
  assert.deepEqual((await app.inject({ method: 'GET', url: `/qa/game/tester?discordId=${TESTER}`, headers: G })).json(), { allowed: false, role: null, reason: 'disabled' });
  assert.ok((await q('SELECT COUNT(*) AS n FROM runs WHERE discord_id = ?', [TESTER]))[0].n >= 1, 'history kept');
  assert.equal((await api('admin', 'POST', `/users/${TESTER}/disabled`, { disabled: false })).json().user.disabled, false);
  await login(TESTER, 'tester');
  assert.equal((await api('tester', 'GET', '/me')).json().user.role, 'tester');
});

test('scenario detail includes per-step results for recent runs', async () => {
  const run = (await q("SELECT id FROM runs WHERE scenario_id = 'kora_fishing:tests/selling.feature:8' LIMIT 1"))[0];
  await q("INSERT INTO run_steps (run_id, idx, text, kind, status, at) VALUES (?, 0, 'x', 'setup', 'passed', 1), (?, 1, 'y', 'setup', 'failed', 2)", [run.id, run.id]);
  const d = (await api('tester', 'GET', `/scenarios/${encodeURIComponent('kora_fishing:tests/selling.feature:8')}`)).json();
  const r = d.runs.find((x) => x.id === Number(run.id));
  assert.deepEqual(r.steps.map((s) => [s.idx, s.status]), [[0, 'passed'], [1, 'failed']]);
});

test('static UI: fresh lookups, asset 404, cache headers', async () => {
  const dist = path.join(TMP, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  const ui = await buildApp({ webDist: dist });
  let r = await ui.inject({ method: 'GET', url: '/qa/issues/1' });
  assert.match(r.body, /not built yet/);
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>v1</html>');
  r = await ui.inject({ method: 'GET', url: '/qa/issues/1' });
  assert.equal(r.body, '<html>v1</html>');
  assert.equal(r.headers['cache-control'], 'no-cache');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbCd1234.js'), 'console.log(1)');
  r = await ui.inject({ method: 'GET', url: '/qa/assets/index-AbCd1234.js' });
  assert.equal(r.statusCode, 200, 'built after start, no restart');
  assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  r = await ui.inject({ method: 'GET', url: '/qa/assets/index-OldHash1.js' });
  assert.equal(r.statusCode, 404);
  assert.equal((await ui.inject({ method: 'GET', url: '/qa/favicon.ico' })).statusCode, 404);
  assert.equal((await ui.inject({ method: 'GET', url: '/qa/..%2F..%2Fetc%2Fpasswd' })).body, '<html>v1</html>', 'traversal never reads outside dist');
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>v2</html>');
  assert.equal((await ui.inject({ method: 'GET', url: '/qa/' })).body, '<html>v2</html>');
  assert.equal((await ui.inject({ method: 'GET', url: '/qa/api/nope', cookies: { kqa_sid: cookies.admin } })).statusCode, 404);
  await ui.close();
});
