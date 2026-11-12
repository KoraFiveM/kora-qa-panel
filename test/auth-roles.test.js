// Discord-role login (guild mode): roles mapped from guild member roles at every login (mocked Discord).
import { resetDb, done, q, SECRETS } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const GUILD = '1565098239345303633';
const MOD = '1565106012275351674';
const TESTER_ROLE = '1565463029506641960';
const DEV_ROLE = '1565000000000000777';
Object.assign(process.env, {
  DISCORD_CLIENT_SECRET: 'test-client-secret', DISCORD_GUILD_ID: GUILD, DISCORD_ADMIN_ROLE_IDS: MOD,
  DISCORD_TESTER_ROLE_IDS: TESTER_ROLE, DISCORD_DEV_ROLE_IDS: DEV_ROLE, ADMIN_DISCORD_IDS: '100000000000000001',
});
const { setConfig, loadConfig } = await import('../server/config.js');
setConfig(loadConfig());
const { buildApp } = await import('../server/app.js');
const { mapDiscordRoles } = await import('../server/auth.js');

let app;
let profile;
let member; // object, or a number = HTTP status
const memberCalls = [];
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (u.endsWith('/oauth2/token')) return Response.json({ access_token: 'tok' });
  if (u.endsWith('/users/@me')) return Response.json(profile);
  if (u.includes('/users/@me/guilds/')) {
    memberCalls.push({ url: u, auth: opts.headers?.Authorization });
    return typeof member === 'number' ? new Response('{}', { status: member }) : Response.json(member);
  }
  return new Response('nope', { status: 404 });
}
before(async () => { await resetDb(); app = await buildApp({ fetchFn: fakeFetch }); });
after(async () => { await app.close(); await done(); });

async function login(p, m) {
  profile = p; member = m;
  const start = await app.inject({ method: 'GET', url: '/qa/auth/login' });
  const loc = new URL(start.headers.location);
  const state = start.cookies.find((c) => c.name === 'kqa_state');
  const cb = await app.inject({ method: 'GET', url: `/qa/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { kqa_state: state.value } });
  return { start: loc, cb, sid: cb.cookies.find((c) => c.name === 'kqa_sid')?.value };
}
const me = async (sid) => (await app.inject({ method: 'GET', url: '/qa/api/me', cookies: { kqa_sid: sid } })).json();
const role = async (id) => (await q('SELECT role FROM users WHERE discord_id = ?', [id]))[0]?.role;

test('mapping: Mod wins, then dev, then tester', () => {
  assert.equal(mapDiscordRoles([TESTER_ROLE, MOD]), 'admin');
  assert.equal(mapDiscordRoles([TESTER_ROLE, DEV_ROLE]), 'dev');
  assert.equal(mapDiscordRoles(['1', TESTER_ROLE]), 'tester');
  assert.equal(mapDiscordRoles(['1']), null);
});

test('scope and member lookup with the user token', async () => {
  const r = await login({ id: '200000000000000001', username: 'tess' }, { roles: [TESTER_ROLE] });
  assert.equal(r.start.searchParams.get('scope'), 'identify guilds.members.read');
  assert.equal(r.cb.statusCode, 302);
  assert.equal(memberCalls.at(-1).url, `https://discord.com/api/v10/users/@me/guilds/${GUILD}/member`);
  assert.equal(memberCalls.at(-1).auth, 'Bearer tok');
  assert.equal((await me(r.sid)).user.role, 'tester');
});

test('role overwritten at every login and logged', async () => {
  const id = '200000000000000002';
  await q("INSERT INTO users (discord_id, name, role, legacy, created_at) VALUES (?, 'Old', 'tester', 1, 0)", [id]);
  let r = await login({ id, username: 'mod' }, { roles: [MOD, TESTER_ROLE] });
  assert.equal((await me(r.sid)).user.role, 'admin');
  r = await login({ id, username: 'mod' }, { roles: [TESTER_ROLE] });
  assert.equal(await role(id), 'tester');
  const changes = (await q("SELECT v FROM kv WHERE k = 'role_changes'"))[0].v;
  assert.deepEqual(changes.slice(0, 2).map((c) => `${c.from}->${c.to}`), ['admin->tester', 'tester->admin']);
  const users = (await app.inject({ method: 'GET', url: '/qa/api/users', cookies: { kqa_sid: (await login({ id: '100000000000000001', username: 'boss' }, { roles: [] })).sid } })).json();
  assert.equal(users.rolesFromDiscord, true);
  assert.ok(users.roleChanges.length >= 2);
});

test('ADMIN_DISCORD_IDS override even without roles', async () => {
  const r = await login({ id: '100000000000000001', username: 'boss' }, { roles: [] });
  assert.equal(r.cb.statusCode, 302);
  assert.equal((await me(r.sid)).user.role, 'admin');
});

test('refused: no mapped role, not a member; listed', async () => {
  let r = await login({ id: '200000000000000003', username: 'rando' }, { roles: ['42'] });
  assert.equal(r.cb.statusCode, 403);
  assert.match(r.cb.body, /Early Testers/);
  r = await login({ id: '200000000000000004', username: 'outsider' }, 404);
  assert.equal(r.cb.statusCode, 403);
  const pending = (await q("SELECT v FROM kv WHERE k = 'pending_logins'"))[0].v.map((p) => p.discordId);
  assert.ok(pending.includes('200000000000000003') && pending.includes('200000000000000004'));
  // a legacy account that lost its role is refused too and keeps its stored row
  await q("INSERT INTO users (discord_id, name, role, legacy, created_at) VALUES ('200000000000000005', 'Gone', 'tester', 1, 0)");
  r = await login({ id: '200000000000000005', username: 'gone' }, { roles: [] });
  assert.equal(r.cb.statusCode, 403);
  r = await login({ id: '200000000000000006', username: 'noscope' }, 403);
  assert.equal(r.cb.statusCode, 403);
  assert.match(r.cb.body, /allow the requested permissions/);
  r = await login({ id: '200000000000000006', username: 'x' }, 500);
  assert.equal(r.cb.statusCode, 502);
});

test('disabled users stay disabled', async () => {
  await q("INSERT INTO users (discord_id, name, role, disabled, created_at) VALUES ('200000000000000007', 'Off', 'tester', 1, 0)");
  const r = await login({ id: '200000000000000007', username: 'off' }, { roles: [MOD] });
  assert.equal(r.cb.statusCode, 403);
  assert.match(r.cb.body, /Access removed/);
  assert.equal(await role('200000000000000007'), 'tester');
});

test('game /tester: stored role; unknown ids must log in once', async () => {
  const G = { authorization: `Bearer ${SECRETS.KORA_QA_GAME_SECRET}` };
  const t = async (id) => (await app.inject({ method: 'GET', url: `/qa/game/tester?discordId=${id}`, headers: G })).json();
  assert.deepEqual(await t('200000000000000001'), { allowed: true, role: 'tester' });
  assert.deepEqual(await t('200000000000000099'), { allowed: false, role: null, reason: 'log into the panel once' });
  assert.deepEqual(await t('200000000000000007'), { allowed: false, role: null, reason: 'disabled' });
});
