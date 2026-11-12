// Discord OAuth flow (Discord mocked), sessions/logout, closed signup, and the XP outbox sender with backoff.
import { resetDb, done, q, SECRETS } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
const { buildApp } = await import('../server/app.js');
const { flushOutbox, _resetBackoff } = await import('../server/xp.js');
const { setConfig, loadConfig } = await import('../server/config.js');

let app;
let profile = { id: '100000000000000001', username: 'boss', global_name: 'Boss', avatar: 'abc' };
const calls = [];
async function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), opts });
  if (String(url).endsWith('/oauth2/token')) {
    const body = new URLSearchParams(opts.body);
    if (body.get('code') !== 'good') return new Response('{"error":"invalid_grant"}', { status: 400 });
    return Response.json({ access_token: 'tok', token_type: 'Bearer' });
  }
  if (String(url).endsWith('/users/@me')) return Response.json(profile);
  return new Response('nope', { status: 404 });
}

before(async () => {
  setConfig(loadConfig());
  await resetDb();
  app = await buildApp({ fetchFn: fakeFetch });
});
after(async () => { await app.close(); await done(); });

async function loginFlow(code = 'good') {
  const start = await app.inject({ method: 'GET', url: '/qa/auth/login?next=/qa/issues/5' });
  assert.equal(start.statusCode, 302);
  const loc = new URL(start.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(loc.searchParams.get('scope'), 'identify');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://example.test/qa/auth/callback');
  const state = start.cookies.find((c) => c.name === 'kqa_state');
  assert.equal(state.path, '/qa/auth');
  assert.equal(state.httpOnly, true);
  return app.inject({ method: 'GET', url: `/qa/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, cookies: { kqa_state: state.value } });
}

test('OAuth: bootstrap admin logs in, session cookie scoped to /qa', async () => {
  const cb = await loginFlow();
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, '/qa/issues/5');
  const sid = cb.cookies.find((c) => c.name === 'kqa_sid');
  assert.equal(sid.path, '/qa');
  assert.equal(sid.httpOnly, true);
  assert.equal(sid.sameSite, 'Lax');
  const me = (await app.inject({ method: 'GET', url: '/qa/api/me', cookies: { kqa_sid: sid.value } })).json();
  assert.equal(me.user.role, 'admin');
  assert.equal(me.user.name, 'Boss');
  assert.equal(me.oauthConfigured, true);
  const out = await app.inject({ method: 'POST', url: '/qa/auth/logout', cookies: { kqa_sid: sid.value } });
  assert.equal(out.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/qa/api/me', cookies: { kqa_sid: sid.value } })).json().user, null);
});

test('OAuth: state mismatch and bad code are refused', async () => {
  const start = await app.inject({ method: 'GET', url: '/qa/auth/login' });
  const state = start.cookies.find((c) => c.name === 'kqa_state');
  const bad = await app.inject({ method: 'GET', url: '/qa/auth/callback?code=good&state=forged', cookies: { kqa_state: state.value } });
  assert.equal(bad.statusCode, 400);
  const noCookie = await app.inject({ method: 'GET', url: `/qa/auth/callback?code=good&state=${new URL(start.headers.location).searchParams.get('state')}` });
  assert.equal(noCookie.statusCode, 400);
  assert.equal((await loginFlow('bad')).statusCode, 502);
});

test('OAuth: unknown account is refused and listed; legacy user matched by discord id', async () => {
  profile = { id: '100000000000000055', username: 'stranger' };
  const r = await loginFlow();
  assert.equal(r.statusCode, 403);
  const pending = (await q("SELECT v FROM kv WHERE k = 'pending_logins'"))[0].v;
  assert.equal(pending[0].discordId, '100000000000000055');
  await q("INSERT INTO users (discord_id, name, role, legacy, created_at) VALUES ('100000000000000066', 'Old Tester', 'tester', 1, 0)");
  profile = { id: '100000000000000066', username: 'oldtester', global_name: 'Old T' };
  const ok = await loginFlow();
  assert.equal(ok.statusCode, 302);
  const u = (await q("SELECT name, role, legacy, last_login_at FROM users WHERE discord_id = '100000000000000066'"))[0];
  assert.equal(u.name, 'Old T'); assert.equal(u.role, 'tester'); assert.equal(u.legacy, 1); assert.ok(u.last_login_at > 0);
});

test('XP outbox: sends with bearer, retries with backoff, idempotent rows', async () => {
  const got = [];
  let mode = 'fail';
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      got.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      if (mode === 'fail') { res.writeHead(503); return res.end('{"ok":false}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"applied":true}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/qa-xp`;
  await q("INSERT INTO xp_outbox (discord_id, event, issue_id, at) VALUES ('1', 'bug_posted', '1570000000000000001', 5)");
  await q("INSERT IGNORE INTO xp_outbox (discord_id, event, issue_id, at) VALUES ('1', 'bug_posted', '1570000000000000001', 6)");
  _resetBackoff();
  let r = await flushOutbox({ url, secret: SECRETS.QA_XP_SECRET });
  assert.deepEqual(r, { sent: 0, failed: 1 });
  r = await flushOutbox({ url, secret: SECRETS.QA_XP_SECRET });
  assert.deepEqual(r, { sent: 0, failed: 0 }, 'backing off');
  mode = 'ok';
  r = await flushOutbox({ url, secret: SECRETS.QA_XP_SECRET, now: Date.now() + 60000 });
  assert.deepEqual(r, { sent: 1, failed: 0 });
  assert.deepEqual(got.at(-1), { auth: `Bearer ${SECRETS.QA_XP_SECRET}`, body: { discordId: '1', event: 'bug_posted', issueId: '1570000000000000001', at: 5 } });
  const row = (await q('SELECT sent_at, attempts, last_error FROM xp_outbox'))[0];
  assert.ok(row.sent_at > 0); assert.equal(row.attempts, 2); assert.equal(row.last_error, null);
  srv.close();
});
