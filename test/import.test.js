// Legacy import (scripts/lib/legacy): fixtures written to a temp communitybot/fixer tree, Discord REST + CDN mocked.
import { TMP, resetDb, done, q } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { tx } = await import('../server/db.js');
const { runImport } = await import('../scripts/lib/legacy/index.js');
const { feedbackCopies, matchFeedback, runKey } = await import('../scripts/lib/legacy/tests.js');
const { postEvents } = await import('../scripts/lib/legacy/issues.js');
const { inferMods } = await import('../scripts/lib/legacy/people.js');
const { messageText } = await import('../scripts/lib/legacy/discord.js');

const BOT = path.join(TMP, 'bot');
const FIX = process.env.FIX_ROOT;
const DATA = process.env.DATA_DIR;
const TOKEN = 'test-bot-token-not-real';

// ids
const A = '1565520418167717949'; // thread with 120 messages, attachments, fix folder
const B = '1565536828189052978'; // thread: first messages call is rate limited
const C = '1566000000000000001'; // thread deleted on Discord (404)
const D = '1566602630631915610'; // meta.deletedPosts
const ORPHAN = '1567000000000000099'; // fix folder without an issue
const T1 = '1568926304307515494'; // test-triage post of load-appears
const REPORTER = '176162320957964290';
const MOD = '357115138895249409';
const TESTER = '286693234321784833';
const BOTID = '1400000000000000001';
const PROMPT_MSG = '1569281966673760266';
const FB_AT = 1794172810120;

const write = (rel, data) => {
  const f = path.join(BOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
};

function fixtures() {
  write('.env', `DISCORD_TOKEN=${TOKEN}\n`);
  write('data/bug-tracker.json', {
    meta: { deletedPosts: { [D]: { title: 'Target Hospital Sandy', status: 'open', deletedAt: 1793577633935 } } },
    posts: {
      [A]: { reporterId: REPORTER, status: 'fix_attempted', controlId: '1', createdAt: 1793391265590, title: 'Clothing: TextUI prompt', statusAt: 1793630936979, statusBy: null,
        notFixedCount: 1, fixedPaid: false, modOverride: { at: 1793927445915, by: MOD, reason: 'try it' },
        history: [{ at: 1793463785370, by: null, status: 'fix_attempted' }, { at: 1793504370825, by: TESTER, status: 'open' }, { at: 1793514934245, by: null, status: 'fix_attempted' }],
        notFixedNotes: [{ at: 1793504370825, by: TESTER, text: 'still broken' }], plan: { state: 'ready', info: [{ by: TESTER, byName: 'Illusion', at: 1, text: 'x' }] } },
      [B]: { reporterId: TESTER, status: 'fixed', kind: 'suggestion', controlId: '2', createdAt: 1793400000000, title: 'Trucking keys', statusAt: 1793500000000, statusBy: MOD, fixedPaid: true,
        history: [{ at: 1793450000000, by: MOD, status: 'confirmed' }, { at: 1793500000000, by: MOD, status: 'fixed' }] },
      [C]: { reporterId: REPORTER, status: 'dup', controlId: '3', createdAt: 1793410000000, title: 'Gone thread', statusAt: 1793420000000, statusBy: MOD },
    },
  });
  write('assets/test-triage/items.json', { items: [{ id: 'load-appears', title: 'Loading screen shows', group: 'kora_loading', target: 3, description: '1. Connect.\nExpect: it shows.' }] });
  write('data/test-triage.json', { v: 1, items: {
    'load-appears': { threadId: T1, threadName: 'kora_loading: Loading screen shows', works: [{ id: TESTER, name: 'Illusion', at: 1794148035707 }],
      feedback: [{ id: REPORTER, name: 'RaVn', at: FB_AT }], worksHistory: [{ id: MOD, name: 'Jay60', at: 1794100000000, clearedAt: 1794110000000, round: 0 }], round: 1,
      retest: { round: 1, since: 1794110000000, by: 'Jay60', byId: MOD } },
    'old-retired': { threadId: '1568926307058851972', threadName: 'kora_loading: Old test', works: [], feedback: [], retired: true },
  } });
  write('assets/tester-checklist/features.json', { resources: [{ resource: 'kora_core', folder: '[kora]', category: 'Core', description: 'core', features: [
    { id: 'character-login', name: 'Character login', test: 'Log in.' }, { id: 'lang', name: 'Language', test: 'Switch.' }] }] });
  write('data/tester-checklist.json', { channelId: '1', threads: { kora_core: { id: '1567520337174855690' } }, items: {
    'kora_core/character-login': { works: [{ userId: TESTER, name: 'Illusion', at: 1793801809614 }],
      bugs: [{ userId: REPORTER, name: 'RaVn', at: 1793841457433, postId: C, resolution: 'dup', resolvedAt: 1793841991610 }], suggestions: [] },
  } });
  write('data/test-spots.json', { v: 1, spots: {}, proposals: { 'load-appears': [{ label: 'Beach', x: 1, y: 2, z: 3, h: 0, source: 'a.lua:1' }] } });
  write('data/test-prompts.json', { v: 1, prompts: { [PROMPT_MSG]: { threadId: T1, file: `fix-prompt-${T1}.md`, at: 1794216377168, changes: [], aborted: { by: MOD, byName: 'Jay60', at: 1794244292771 } } } });
  write('data/tester-activity.json', { seen: { [TESTER]: 1794237950041, [REPORTER]: 1794252974346 }, days: { '2026-10': { [TESTER]: ['2026-10-31'] } }, lastReportDate: { 0: '2' } });
  write('data/tester-of-month.json', { lastMonth: '2026-10', winnerId: TESTER, score: 345, at: 1793556034461 });
  write(`data/planner/${A}/BUG.md`, '# bug');
  write(`data/planner/${A}/fix-prompt-${A}.md`, 'prompt v1');
  write(`data/planner/${A}/fix-prompt-${A}-v2.md`, 'prompt v2');

  const fx = (rel, data) => { const f = path.join(FIX, 'fixes', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); };
  fx(`${A}/meta.json`, { threadId: A, patchId: '21f8baf71d', model: 'm', risk: 'medium', summary: 'sum', details: 'det', testSteps: 'steps', createdAt: '2026-11-06T02:16:11+00:00', resources: [] });
  fx(`${A}/applied.json`, { appliedAt: '2026-11-06T07:31:35+00:00', backupTag: 'x' });
  fx(`${A}/kora_clothing.patch`, 'diff');
  fx(`${A}/TRIAGE.md`, 'triage text');
  fx(`${A}/history/20261106T224213Z/meta.json`, { patchId: '21f8baf71d', model: 'old', summary: 'older attempt', createdAt: '2026-11-05T00:00:00+00:00' });
  fx(`${ORPHAN}/meta.json`, { patchId: 'abc', createdAt: '2026-11-06T00:00:00Z' });
}

// --- mocked Discord --------------------------------------------------------------------
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const state = { calls: [], rateLimited: false, cdnVersion: 1, expired: new Set() };
const author = (id, name, bot = false) => ({ id, username: name.toLowerCase(), global_name: name, ...(bot ? { bot: true } : {}) });
const msg = (id, a, content, extra = {}) => ({ id, type: 0, author: a, content, timestamp: new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString(), attachments: [], embeds: [], ...extra });
const sid = (base, i) => (BigInt(base) + BigInt(i) * 4194304n).toString();

function threadMessages(id) {
  if (id === A) {
    const out = [msg(A, author(REPORTER, 'RaVn'), 'Starter post', { attachments: [{ id: '900000000000000001', filename: 'shot one.png', size: PNG.length, content_type: 'image/png', url: `https://cdn.discordapp.com/attachments/${A}/900000000000000001/shot.png?v=${state.cdnVersion}` }] })];
    for (let i = 1; i < 120; i++) out.push(msg(sid(A, i), i % 2 ? author(BOTID, 'Kora Bot', true) : author(TESTER, 'Illusion'), `message ${i}`, i === 1 ? { embeds: [{ title: 'Status', description: 'Fix attempted', fields: [{ name: 'Commit', value: 'abc' }] }] } : {}));
    out.push({ ...msg(sid(A, 120), author(BOTID, 'Kora Bot', true), ''), type: 18 }); // thread system message
    return out;
  }
  if (id === B) return [msg(B, author(TESTER, 'Illusion'), 'Keys missing'), msg(sid(B, 1), author(MOD, 'Jay60'), 'confirmed')];
  if (id === T1) {
    return [
      msg(T1, author(BOTID, 'Kora Bot', true), 'Test post'),
      { ...msg(sid(T1, 1), author(BOTID, 'Kora Bot', true), ''), timestamp: new Date(FB_AT + 800).toISOString(), embeds: [{ title: 'Feedback', description: `Progress text never shows, see https://discord.com/channels/1/${B}`, fields: [{ name: 'From', value: `<@${REPORTER}> · in-game /test` }, { name: 'In game', value: 'x=1' }] }] },
      msg(PROMPT_MSG, author(BOTID, 'Kora Bot', true), 'Fix prompt', { attachments: [{ id: '900000000000000002', filename: `fix-prompt-${T1}.md`, size: 10, content_type: 'text/markdown', url: `https://cdn.discordapp.com/attachments/${T1}/900000000000000002/fix-prompt.md?v=${state.cdnVersion}` }] }),
    ];
  }
  return null;
}

const res = (status, body, headers = {}) => new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  state.calls.push({ url, auth: init.headers?.Authorization ?? null });
  if (u.hostname === 'cdn.discordapp.com') {
    if (init.headers?.Authorization) throw new Error('token sent to CDN');
    if (Number(u.searchParams.get('v')) !== state.cdnVersion) return res(404, 'expired', { 'content-type': 'text/plain' });
    if (u.pathname.endsWith('.md')) return res(200, '# Fix prompt\nDo the thing.', { 'content-type': 'text/markdown' });
    return res(200, PNG, { 'content-type': 'image/png' });
  }
  assert.equal(init.headers?.Authorization, `Bot ${TOKEN}`);
  const m = /^\/api\/v10\/channels\/(\d+)(\/messages)?$/.exec(u.pathname);
  if (!m) return res(404, { code: 0, message: 'no route' });
  const id = m[1];
  const all = threadMessages(id);
  if (!all) return res(404, { code: 10003, message: 'Unknown Channel' });
  if (!m[2]) return res(200, { id, name: `thread ${id}`, parent_id: '1', guild_id: '1', thread_metadata: { archived: true, locked: false }, applied_tags: ['t'], message_count: all.length });
  if (id === B && !state.rateLimited) { state.rateLimited = true; return res(429, { message: 'You are being rate limited.', retry_after: 0.01, global: false }, { 'retry-after': '1' }); }
  const after = BigInt(u.searchParams.get('after') ?? '0');
  const limit = Number(u.searchParams.get('limit') ?? 50);
  const page = all.filter((x) => BigInt(x.id) > after).slice(0, limit).reverse(); // Discord returns newest first
  return res(200, page, { 'x-ratelimit-remaining': page.length === limit ? '0' : '4', 'x-ratelimit-reset-after': '0.01' });
}

const opts = (extra = {}) => ({ db: { q, tx }, botDir: BOT, fixRoot: FIX, dataDir: DATA, token: TOKEN, fetchImpl: fakeFetch, sleep: async () => {}, log: () => {}, concurrency: 2, dbName: 'kora_qa_test', ...extra });
const count = async (t, w = '1=1', p = []) => Number((await q(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`, p))[0].n);
const allCounts = async () => {
  const out = {};
  for (const t of ['issues', 'issue_events', 'issue_messages', 'issue_attachments', 'fixes', 'issue_prompts', 'legacy_tests', 'runs', 'tester_stats', 'users', 'kv', 'xp_outbox']) out[t] = await count(t);
  return out;
};

before(async () => { await resetDb(); fixtures(); });
after(done);

test('pure helpers: events, feedback matching, mods, message text, run keys', () => {
  const ev = postEvents(A, { createdAt: 1, history: [{ at: 2, by: null, status: 'fix_attempted' }, { at: 3, by: 'x', status: 'open' }], notFixedNotes: [{ at: 3, by: TESTER, text: 'n' }] });
  assert.deepEqual(ev.map((e) => [e.type, e.from ?? null, e.to ?? null]), [['import', null, 'open'], ['status', 'open', 'awaiting_test'], ['status', 'awaiting_test', 'open'], ['comment', null, null]]);
  assert.equal(ev[1].data.raw, 'fix_attempted');
  const copies = feedbackCopies([{ id: '1', timestamp: new Date(1000).toISOString(), embeds: [{ title: 'Feedback', description: 'hi', fields: [{ name: 'From', value: `<@${TESTER}>` }] }] }]);
  assert.equal(copies[0].uid, TESTER);
  assert.deepEqual(matchFeedback([{ id: TESTER, at: 1500 }, { id: TESTER, at: 1600 }], copies).map((c) => c?.text ?? null), ['hi', null]);
  const mods = inferMods({ posts: { [A]: { reporterId: REPORTER, history: [{ by: REPORTER, status: 'fixed' }, { by: TESTER, status: 'open' }, { by: MOD, status: 'wontfix' }] } } });
  assert.deepEqual([...mods.keys()], [MOD]);
  assert.equal(messageText({ content: 'a', embeds: [{ title: 'T', fields: [{ name: 'f', value: 'v' }] }], components: [{ type: 17, components: [{ type: 10, content: 'cv2' }] }] }), 'a\n\n**T**\n**f:** v\n\ncv2');
  assert.ok(runKey('x'.repeat(150)).length <= 100);
});

test('dry run counts but writes nothing and makes no requests', async () => {
  const s = await runImport(opts({ dryRun: true }));
  assert.equal(s.reports.issues.counts.issues, 3);
  assert.equal(s.reports.issues.counts.deleted, 1);
  assert.ok(s.writes.issues >= 4);
  assert.equal(state.calls.length, 0);
  assert.deepEqual(Object.values(await allCounts()).filter(Boolean), [], 'no rows anywhere');
  assert.ok(!fs.existsSync(path.join(DATA, 'import', 'discord-cache')));
  assert.ok(fs.existsSync(s.reportFile));
});

test('unknown part is refused', async () => {
  await assert.rejects(runImport(opts({ only: ['nope'] })), /unknown part/);
});

test('full import', async () => {
  const s = await runImport(opts());
  const fails = Object.fromEntries(Object.entries(s.reports).map(([k, r]) => [k, r.failures]));

  // issues
  assert.equal(await count('issues'), 4);
  const a = (await q('SELECT * FROM issues WHERE id = ?', [A]))[0];
  assert.equal(a.status, 'awaiting_test');
  assert.equal(a.kind, 'bug');
  assert.equal(a.source, 'discord');
  assert.equal(a.not_fixed_count, 1);
  assert.equal(a.reporter_name, 'RaVn');
  assert.deepEqual(a.mod_override, { reason: 'try it', by: MOD, at: 1793927445915 });
  assert.equal(a.legacy.controlId, '1');
  assert.equal(a.legacy.thread.archived, true);
  const b = (await q('SELECT * FROM issues WHERE id = ?', [B]))[0];
  assert.equal(b.kind, 'suggestion');
  assert.equal(b.fixed_paid, 1);
  const d = (await q('SELECT * FROM issues WHERE id = ?', [D]))[0];
  assert.equal(d.deleted, 1);
  assert.equal(d.title, 'Target Hospital Sandy');
  const evA = await q('SELECT type, from_status, to_status, by_discord_id, note FROM issue_events WHERE issue_id = ? ORDER BY at, id', [A]);
  assert.deepEqual(evA.filter((e) => e.type === 'status').map((e) => e.to_status), ['awaiting_test', 'open', 'awaiting_test']);
  assert.ok(evA.some((e) => e.type === 'comment' && e.note === 'still broken'));
  assert.ok(evA.some((e) => e.type === 'meta' && /Mod override/.test(e.note)));
  assert.equal(await count('xp_outbox'), 0, 'never pays XP');
  assert.equal(await count('issue_events', "legacy_key IS NULL"), 0);

  // messages: 120 content messages in A (system one skipped), sorted, bots flagged, attachment downloaded
  assert.equal(await count('issue_messages', 'issue_id = ?', [A]), 120);
  const msgs = await q('SELECT legacy_message_id, is_bot, content, author_name FROM issue_messages WHERE issue_id = ? ORDER BY created_at, id', [A]);
  assert.equal(msgs[0].legacy_message_id, A, 'starter first');
  assert.equal(msgs[1].is_bot, 1);
  assert.match(msgs[1].content, /\*\*Status\*\*\nFix attempted\n\*\*Commit:\*\* abc/);
  const att = (await q('SELECT * FROM issue_attachments WHERE issue_id = ?', [A]))[0];
  assert.equal(att.kind, 'screenshot');
  assert.equal(att.path, `legacy/${A}/900000000000000001-shot_one.png`);
  assert.deepEqual(fs.readFileSync(path.join(DATA, 'files', att.path)), PNG);
  assert.match(att.original_url, /cdn\.discordapp\.com/);
  assert.equal(await count('issue_messages', 'issue_id = ?', [B]), 2);
  assert.equal(s.discord.rateLimited, 1, '429 retried');
  const c = (await q('SELECT legacy FROM issues WHERE id = ?', [C]))[0];
  assert.equal(c.legacy.threadFetch.status, 404);
  assert.ok(fails.messages.some((f) => f.id === C));
  assert.equal(s.reports.messages.counts.inaccessible, 1);

  // fixes
  const fx = await q('SELECT patch_id, is_history, applied, meta FROM fixes WHERE issue_id = ? ORDER BY is_history', [A]);
  assert.deepEqual(fx.map((f) => [f.patch_id, f.is_history]), [['21f8baf71d', 0], ['21f8baf71d@20261106T224213Z', 1]]);
  assert.equal(fx[0].applied.backupTag, 'x');
  assert.equal(fx[0].meta._import.files['TRIAGE.md'], 'triage text');
  assert.ok(fails.fixes.some((f) => f.id === ORPHAN));
  assert.equal(await count('fixes', 'issue_id = ?', [ORPHAN]), 0);

  // prompts
  const tp = (await q("SELECT * FROM issue_prompts WHERE legacy_key = ?", [`tp:${PROMPT_MSG}`]))[0];
  assert.equal(tp.issue_id, null);
  assert.equal(tp.legacy_test_id, 'load-appears');
  assert.equal(tp.content, '# Fix prompt\nDo the thing.');
  assert.deepEqual((await q('SELECT legacy_key, kind, content FROM issue_prompts WHERE issue_id = ? ORDER BY legacy_key', [A])).map((p) => [p.legacy_key, p.kind, p.content]), [
    [`pl:${A}:BUG`, 'plan_bug', '# bug'], [`pl:${A}:fix-prompt-v1`, 'plan_prompt', 'prompt v1'], [`pl:${A}:fix-prompt-v2`, 'plan_prompt', 'prompt v2']]);

  // tests + runs
  assert.equal(await count('legacy_tests', "source = 'game'"), 2);
  assert.equal(await count('legacy_tests', "source = 'checklist'"), 2);
  assert.equal((await q("SELECT resource FROM legacy_tests WHERE id = 'kora_core:character-login'"))[0].resource, 'kora_core');
  assert.equal(await count('legacy_tests', 'scenario_id IS NOT NULL'), 0);
  const runs = await q('SELECT * FROM runs ORDER BY started_at');
  assert.ok(runs.every((r) => r.legacy === 1 && r.scenario_id === null));
  const fb = runs.find((r) => r.legacy_test_id === 'load-appears' && r.status === 'failed');
  assert.match(fb.note, /Progress text never shows/);
  assert.equal(fb.issue_id, B, 'feedback linked to the bug thread it mentions');
  assert.equal(fb.context.inGame, 'x=1');
  assert.equal(runs.filter((r) => r.legacy_test_id === 'load-appears' && r.status === 'passed').length, 2);
  assert.equal(runs.find((r) => r.legacy_test_id === 'load-appears' && r.discord_id === MOD).context.clearedByRetest, true);
  const clBug = runs.find((r) => r.legacy_test_id === 'kora_core:character-login' && r.status === 'failed');
  assert.equal(clBug.issue_id, C);
  assert.equal(clBug.context.resolution, 'dup');
  assert.equal(runs.length, 5);
  const spots = (await q("SELECT v FROM kv WHERE k = 'legacy_spots'"))[0].v;
  assert.equal(spots.proposals['load-appears'][0].label, 'Beach');

  // stats + users
  const st = (await q('SELECT data FROM tester_stats WHERE discord_id = ?', [TESTER]))[0].data;
  assert.equal(st.testerOfMonth[0].score, 345);
  assert.deepEqual(st.days['2026-10'], ['2026-10-31']);
  const users = await q('SELECT discord_id, name, role, legacy FROM users ORDER BY discord_id');
  assert.ok(!users.some((u) => u.discord_id === BOTID), 'bots excluded');
  assert.deepEqual(users.map((u) => u.discord_id).sort(), [REPORTER, TESTER, MOD].sort());
  assert.equal(users.find((u) => u.discord_id === MOD).role, 'dev');
  assert.equal(users.find((u) => u.discord_id === TESTER).role, 'tester');
  assert.equal(users.find((u) => u.discord_id === MOD).name, 'Jay60');
  assert.ok(users.every((u) => u.legacy === 1));
  assert.match(fs.readFileSync(s.reportFile, 'utf8'), /## users/);
  assert.equal(await count('xp_outbox'), 0);
});

test('re-run is idempotent and served from the cache; expired CDN links refetch the thread', async () => {
  const before = await allCounts();
  // a panel user logged in meanwhile and was made admin: the import keeps role and name
  await q("UPDATE users SET role = 'admin', name = 'Jay', last_login_at = 1 WHERE discord_id = ?", [MOD]);
  fs.rmSync(path.join(DATA, 'files', 'legacy', A), { recursive: true });
  state.cdnVersion = 2; // cached URLs (v=1) are now expired
  state.calls = [];
  const s = await runImport(opts());
  assert.deepEqual(await allCounts(), before);
  assert.ok(fs.existsSync(path.join(DATA, 'files', `legacy/${A}/900000000000000001-shot_one.png`)), 're-downloaded with a fresh URL');
  const api = state.calls.filter((x) => x.url.includes('/api/v10/'));
  assert.deepEqual([...new Set(api.map((x) => new URL(x.url).pathname))], [`/api/v10/channels/${A}/messages`], 'only the thread with a failed download is refetched');
  assert.equal(s.reports.messages.counts.attachmentsFailed ?? 0, 0);
  const mod = (await q('SELECT role, name FROM users WHERE discord_id = ?', [MOD]))[0];
  assert.deepEqual({ ...mod }, { role: 'admin', name: 'Jay' });
});

test('--only limits the parts and a panel-created issue is never overwritten', async () => {
  await q("INSERT INTO issues (id, title, status, source, created_at) VALUES ('1600000000000000001', 'native', 'open', 'freeform', 1)");
  const posts = JSON.parse(fs.readFileSync(path.join(BOT, 'data/bug-tracker.json'), 'utf8'));
  posts.posts['1600000000000000001'] = { reporterId: TESTER, status: 'fixed', createdAt: 1, title: 'clash' };
  fs.writeFileSync(path.join(BOT, 'data/bug-tracker.json'), JSON.stringify(posts));
  const s = await runImport(opts({ only: ['issues'] }));
  assert.deepEqual(s.parts, ['issues']);
  assert.deepEqual(Object.keys(s.reports), ['issues']);
  assert.ok(s.reports.issues.failures.some((f) => f.id === '1600000000000000001'));
  const n = (await q("SELECT title, status, legacy FROM issues WHERE id = '1600000000000000001'"))[0];
  assert.deepEqual({ ...n }, { title: 'native', status: 'open', legacy: null });
  assert.equal(s.discord, null);
});
