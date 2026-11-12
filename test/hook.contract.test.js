// Contract test: replays the exact calls claude-bugfix makes against the bughook, by sourcing the live
// /opt/claude-bugfix/lib.sh (read-only) and calling its hook_fetch / post_status / hook_post / hook_stored_status
// against the panel's hook on a random port. Also checks bugfix.sh's BUG.md jq still renders our GET /bug/:id.
import { SECRETS, resetDb, done, q, TMP } from './helpers.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startHook, ctlRequest } from '../server/hook.js';
import { createIssue, addMessage } from '../server/issues.js';

const LIB = process.env.BUGFIX_LIB ?? '/opt/claude-bugfix/lib.sh';
const BUGFIX = process.env.BUGFIX_SH ?? '/opt/claude-bugfix/bugfix.sh';
const haveLib = fs.existsSync(LIB);

let hook;
let base;
let ctlServer;
let ctlMode = 'ok';
const ctlCalls = [];
const ID = '1570000000000000001';
const OLD = '1570000000000000002';
const GONE = '1570000000000000003';
const REPORTER = '200000000000000001';

function bash(script) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME ?? '/root', LANG: 'C.UTF-8',
    CONFIG_FILE: '/dev/null', SECRETS_FILE: '/dev/null', RES_DIR: TMP, FIX_ROOT: path.join(TMP, 'fix'),
    HOOK_URL: base, BUG_HOOK_SECRET: SECRETS.BUG_HOOK_SECRET, DRY_RUN: '0', PROTECTED_RESOURCES: 'monitor',
  };
  // async: the hook runs in this process, so a sync spawn would deadlock on its own curl calls
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', `set -uo pipefail; source "${LIB}"; load_config; ${script}`], { env });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// post_status threadId status note [model] [resource] [summary] [commit] [reasoning] [expect] -> { rc, http, body }
async function postStatus(...args) {
  const r = await bash(`post_status ${args.map(sh).join(' ')}; rc=$?; printf '%s\\n%s\\n%s' "$rc" "$POST_HTTP" "$POST_BODY"`);
  const [rc, httpCode, ...body] = r.out.split('\n');
  return { rc: Number(rc), http: httpCode, body: body.join('\n'), err: r.err };
}
async function status(id) { return (await q('SELECT status, not_fixed_count FROM issues WHERE id = ?', [id]))[0]; }
async function raw(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${SECRETS.BUG_HOOK_SECRET}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

before(async () => {
  await resetDb();
  ctlServer = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      ctlCalls.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      if (ctlMode === 'unknown') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"unknown resource"}'); }
      if (ctlMode === 'protected') { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"protected resource"}'); }
      if (ctlMode === 'disabled') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"kora_qa is disabled"}'); }
      if (ctlMode === 'badauth') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise((r) => ctlServer.listen(0, '127.0.0.1', r));
  const ctlUrl = `http://127.0.0.1:${ctlServer.address().port}/kora_qa/ctl`;
  hook = await startHook({ port: 0, secret: SECRETS.BUG_HOOK_SECRET, ctl: (p) => (ctlMode === 'down' ? ctlRequest(p, { url: 'http://127.0.0.1:9/x', secret: SECRETS.KORA_QA_GAME_SECRET }) : ctlRequest(p, { url: ctlUrl, secret: SECRETS.KORA_QA_GAME_SECRET })) });
  base = `http://127.0.0.1:${hook.address().port}`;
  const t0 = Date.now() - 60000;
  await createIssue({ id: ID, source: 'discord', title: 'Fishing rod does not sell', reporterDiscordId: REPORTER, reporterName: 'Tess', at: t0 });
  await addMessage({ issueId: ID, discordId: REPORTER, name: 'Tess', content: 'Selling a rod at the shop gives no money.', at: t0 + 1 });
  await createIssue({ id: OLD, source: 'discord', title: 'Old fixed', status: 'fixed', at: Date.now() - 30 * 86400000 });
  await createIssue({ id: GONE, source: 'discord', title: 'Deleted' });
  await q('UPDATE issues SET deleted = 1 WHERE id = ?', [GONE]);
});
after(async () => {
  hook?.close();
  ctlServer?.close();
  await done();
});

test('GET /bugs and /bugs?active=1 via hook_fetch', { skip: !haveLib && 'lib.sh not present' }, async () => {
  const out = path.join(TMP, 'bugs.json');
  let r = await bash(`hook_fetch "/bugs?active=1" ${sh(out)}; echo "$? $HOOK_HTTP"`);
  assert.equal(r.out.trim(), '0 200');
  let body = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(body.bugs.map((b) => b.threadId), [ID]);
  const b = body.bugs[0];
  assert.deepEqual(Object.keys(b), ['threadId', 'title', 'status', 'updatedAt', 'notFixedCount', 'kind']);
  assert.equal(b.status, 'open'); assert.equal(b.kind, 'bug'); assert.equal(b.notFixedCount, 0);
  assert.match(b.updatedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  r = await bash(`hook_fetch "/bugs" ${sh(out)}; echo "$? $HOOK_HTTP"`);
  body = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(body.bugs.map((x) => x.threadId).sort(), [ID, OLD].sort(), 'old closed kept without active=1, deleted never');
  r = await bash(`hook_fetch "/bugs?status=fixed" ${sh(out)}; echo "$?"`);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).bugs.map((x) => x.threadId), [OLD]);
  // bugfix.sh's candidate selection jq
  r = await bash(`jq -c --arg s "open,confirmed,reopen" --argjson stuck '[]' '([$s | split(",")[] | gsub("\\\\s"; "") | select(. != "" and . != "reopen")]) as $want | [.bugs[] | select((.kind // "bug") != "suggestion") | select((.status as $x | $want | index($x)))] | length' ${sh(out.replace('bugs.json', 'bugs.json'))}`);
  assert.equal(r.code, 0);
});

test('hook down: hook_fetch reports 000', { skip: !haveLib && 'lib.sh not present' }, async () => {
  const r = spawnSync('bash', ['-c', `source "${LIB}"; RES_DIR=/tmp; HOOK_URL=http://127.0.0.1:9 BUG_HOOK_SECRET=x; hook_fetch /bugs /dev/null; hook_down && echo down`], { encoding: 'utf8', env: { PATH: process.env.PATH, CONFIG_FILE: '/dev/null', SECRETS_FILE: '/dev/null' } });
  assert.match(r.stdout, /down/);
});

test('GET /bug/:id shape and bugfix.sh BUG.md rendering', { skip: !haveLib && 'lib.sh not present' }, async () => {
  const out = path.join(TMP, 'bug.json');
  const r = await bash(`hook_fetch "/bug/${ID}" ${sh(out)}; echo "$? $HOOK_HTTP"`);
  assert.equal(r.out.trim(), '0 200');
  const bug = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(bug), ['threadId', 'title', 'status', 'url', 'messages']);
  assert.equal(bug.url, `https://example.test/qa/issues/${ID}`);
  assert.equal(bug.messages[0].content, 'Selling a rod at the shop gives no money.');
  assert.deepEqual(Object.keys(bug.messages[0]), ['author', 'isBot', 'createdAt', 'content', 'attachments']);
  // the exact jq bugfix.sh uses to build BUG.md
  const md = await bash(`jq -r '"# " + (.title // "Untitled") + "\\n\\nThread: " + .threadId + "  Status: " + (.status // "?") + "\\n"' ${sh(out)}; jq -r '.messages[]? | "## " + (if .isBot then "[bot] " else "" end) + (.author // "?") + " (" + (.createdAt // "") + ")\\n\\n" + (.content // "") + (if ((.attachments // []) | length) > 0 then "\\n\\nAttachments: " + ((.attachments // []) | join(", ")) else "" end) + "\\n"' ${sh(out)}`);
  assert.equal(md.code, 0);
  assert.match(md.out, /^# Fishing rod does not sell\n\nThread: 1570000000000000001 {2}Status: open/);
  assert.match(md.out, /## Tess \(/);
  if (fs.existsSync(BUGFIX)) assert.ok(fs.readFileSync(BUGFIX, 'utf8').includes('hook_fetch "/bug/$tid"'), 'bugfix.sh still fetches /bug/$tid');
  const missing = await raw('GET', '/bug/1570000000000000999');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'not found' });
  assert.equal((await raw('GET', '/bug/123')).status, 400);
});

test('bugfix.sh status flow with expect (post_status)', { skip: !haveLib && 'lib.sh not present' }, async () => {
  let r = await postStatus(ID, 'fix_initiated', 'Fix cycle 1 of 3: Claude is reading the report.', 'claude-sonnet-5-5', '', '', '', '', 'open');
  assert.equal(r.rc, 0, r.err); assert.equal(r.http, '200');
  assert.deepEqual(JSON.parse(r.body), { ok: true, threadId: ID, status: 'fix_initiated', previous: 'open' });
  assert.equal((await status(ID)).status, 'fix_initiated');

  // a human changed it since: expect mismatch -> 409 "status changed" -> rc 3
  r = await postStatus(ID, 'fix_in_progress', 'Attempting a fix', 'claude-sonnet-5-5', 'kora_fishing', '', '', 'why', 'open');
  assert.equal(r.rc, 3); assert.equal(r.http, '409');
  assert.equal(JSON.parse(r.body).error, 'status changed: expected open, is fix_initiated');
  // the fallback parse bugfix.sh does on that body
  const parsed = await bash(`jq -r '.error // ""' <<<${sh(r.body)} | sed -n 's/.*, is \\([A-Za-z_]*\\).*/\\1/p'`);
  assert.equal(parsed.out.trim(), 'fix_initiated');

  // same status again -> 409 "already marked" -> rc 0
  r = await postStatus(ID, 'fix_initiated', 'again', '', '', '', '', '', 'fix_initiated');
  assert.equal(r.rc, 0); assert.equal(r.http, '409'); assert.match(JSON.parse(r.body).error, /already marked/);

  // several resources (space) go into the note; long notes are clipped by lib.sh and accepted
  r = await postStatus(ID, 'fix_in_progress', 'x'.repeat(700), 'claude-sonnet-5-5', 'kora_fishing kora_inventory', '', '', 'r'.repeat(600), 'fix_initiated');
  assert.equal(r.rc, 0, r.body); assert.equal((await status(ID)).status, 'fix_in_progress');

  r = await postStatus(ID, 'fixed_awaiting_restart', 'Fix ready for review (kora_fishing, risk: low, patch 21f8baf71d). Waiting for approval before it goes live.', 'claude-sonnet-5-5', 'kora_fishing', 'Sell price was nil.\nConfig: x=1 (kora_fishing)', '21f8baf71d', 'Simple nil check', 'fix_in_progress');
  assert.equal(r.rc, 0, r.body);
  const ev = (await q("SELECT data, note FROM issue_events WHERE issue_id = ? AND to_status = 'fixed_awaiting_restart'", [ID]))[0];
  assert.equal(ev.data.attempt.commit, '21f8baf'); assert.equal(ev.data.attempt.model, 'claude-sonnet-5-5'); assert.equal(ev.data.attempt.reasoning, 'Simple nil check');
  const botMsg = (await q('SELECT content FROM issue_messages WHERE issue_id = ? AND is_bot = 1 ORDER BY id DESC LIMIT 1', [ID]))[0].content;
  assert.match(botMsg, /Commit: `21f8baf` in kora_fishing/); assert.match(botMsg, /Attempted by: `claude-sonnet-5-5`/);

  // apply-fix.sh after a successful restart (no expect)
  r = await postStatus(ID, 'awaiting_test', 'Fix is live: restarted kora_fishing. Please test.', 'claude-sonnet-5-5', 'kora_fishing', 'Sell price was nil.', '21f8baf71d', 'Simple nil check');
  assert.equal(r.rc, 0, r.body); assert.equal((await status(ID)).status, 'awaiting_test');

  // the fixer's reopen never counts as Not fixed
  r = await postStatus(ID, 'reopen', 'reverted', '', '', '', '', '', 'awaiting_test');
  assert.equal(r.rc, 0); assert.deepEqual(await status(ID), { status: 'open', not_fixed_count: 0 });

  // every verb lands on hook_stored_status(verb)
  let cur = 'open';
  for (const verb of ['needs_info', 'reopen', 'prompt_ready', 'fix_attempted', 'needs_manual_review', 'fixed']) {
    r = await postStatus(ID, verb, `to ${verb}`, '', '', '', '', '', cur);
    assert.equal(r.rc, 0, `${verb}: ${r.body}`);
    cur = (await bash(`hook_stored_status ${verb}`)).out.trim();
    assert.equal((await status(ID)).status, cur, verb);
  }
  // fixed via the hook pays the reporter once
  const xp = await q('SELECT discord_id, event FROM xp_outbox WHERE issue_id = ?', [ID]);
  assert.deepEqual(xp.map((x) => `${x.event}:${x.discord_id}`), [`bug_fixed:${REPORTER}`]);
});

test('POST /bug-status validation (same errors as communitybot)', async () => {
  const cases = [
    [{ threadId: 'abc', status: 'fixed' }, 400, 'threadId must be a Discord id string'],
    [{ threadId: ID, status: 'confirmed' }, 400, /^status must be one of: prompt_ready, fix_initiated/],
    [{ threadId: ID, status: 'reopen', commit: 'xyz' }, 400, 'commit must be 7 to 40 hex characters'],
    [{ threadId: ID, status: 'reopen', resource: 'a b' }, 400, 'resource must be a resource name (letters, digits, _ . -)'],
    [{ threadId: ID, status: 'reopen', model: 'bad model!' }, 400, 'model must be a model id (letters, digits, _ . -)'],
    [{ threadId: ID, status: 'reopen', note: 'n'.repeat(501) }, 400, 'note is longer than 500 characters'],
    [{ threadId: ID, status: 'reopen', summary: 's'.repeat(501) }, 400, 'summary is longer than 500 characters'],
    [{ threadId: ID, status: 'reopen', reasoning: 5 }, 400, 'reasoning must be a string'],
    [{ threadId: ID, status: 'reopen', expect: 'bogus' }, 400, /^expect must be one of: open, info/],
    [{ threadId: '1570000000000000999', status: 'reopen' }, 404, /./],
  ];
  for (const [body, code, err] of cases) {
    const r = await raw('POST', '/bug-status', body);
    assert.equal(r.status, code, JSON.stringify(body));
    assert.equal(r.body.ok, false);
    if (err instanceof RegExp) assert.match(r.body.error, err); else assert.equal(r.body.error, err);
  }
  assert.equal((await raw('POST', '/bug-status', '[1]')).body.error, 'body must be a JSON object');
  assert.equal((await raw('POST', '/bug-status', '{nope')).body.error, 'body must be JSON');
  assert.equal((await raw('POST', '/bug-status', JSON.stringify({ threadId: ID, status: 'reopen', note: 'x'.repeat(9000) }))).status, 413);
  const unauth = await raw('POST', '/bug-status', { threadId: ID, status: 'reopen' }, { Authorization: 'Bearer wrong' });
  assert.deepEqual([unauth.status, unauth.body], [401, { ok: false, error: 'unauthorized' }]);
  const get = await raw('GET', '/bug-status');
  assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  assert.equal(get.headers.get('connection'), 'close');
  assert.equal((await raw('GET', '/nope')).status, 404);
  // expect accepts the hook verb aliases
  const r = await raw('POST', '/bug-status', { threadId: ID, status: 'reopen', expect: 'fixed' });
  assert.equal(r.status, 200);
  const r2 = await raw('POST', '/bug-status', { threadId: ID, status: 'needs_info', expect: 'reopen' });
  assert.equal(r2.status, 200);
});

test('POST /bug-meta', async () => {
  let r = await raw('POST', '/bug-meta', { threadId: ID, kind: 'suggestion', title: '  Better\nfishing  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, threadId: ID, kind: 'suggestion', title: 'Better fishing', status: 'info', changed: true });
  r = await raw('POST', '/bug-meta', { threadId: ID, status: 'dup', note: 'same as 123' });
  assert.equal(r.body.status, 'dup'); assert.equal(r.body.changed, true);
  r = await raw('POST', '/bug-meta', { threadId: ID, kind: 'suggestion' });
  assert.equal(r.body.changed, false);
  assert.equal((await raw('POST', '/bug-meta', { threadId: ID })).body.error, 'nothing to change: give kind, title and/or status');
  assert.equal((await raw('POST', '/bug-meta', { threadId: ID, status: 'fixed' })).status, 400);
  assert.equal((await raw('POST', '/bug-meta', { threadId: ID, title: 'x'.repeat(101) })).body.error, 'title must be 1 to 100 characters');
  assert.equal((await raw('POST', '/bug-meta', { threadId: ID, kind: 'feature' })).body.error, "kind must be 'bug' or 'suggestion'");
});

test('POST /resource-restart via apply-fix.sh restart path (hook_post)', { skip: !haveLib && 'lib.sh not present' }, async () => {
  ctlMode = 'ok';
  let r = await bash(`hook_post /resource-restart "$(jq -nc --arg name kora_fishing '{name:$name}')"`);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, message: 'ensure kora_fishing sent (no console output)' });
  assert.deepEqual(ctlCalls.at(-1), { auth: `Bearer ${SECRETS.KORA_QA_GAME_SECRET}`, body: { cmd: 'restart', name: 'kora_fishing' } });
  for (const [name, code] of [['monitor', 403], ['kora_qa', 403]]) {
    const x = await raw('POST', '/resource-restart', { name });
    assert.deepEqual([x.status, x.body], [code, { ok: false, error: 'protected' }]);
  }
  r = await bash('hook_post /resource-restart \'{"name":"monitor"}\'');
  assert.notEqual(r.code, 0, 'curl -f fails on 403');
  ctlMode = 'unknown';
  let x = await raw('POST', '/resource-restart', { name: 'nope_res' });
  assert.deepEqual([x.status, x.body], [404, { ok: false, error: 'unknown resource' }]);
  ctlMode = 'down';
  x = await raw('POST', '/resource-restart', { name: 'kora_fishing' });
  assert.equal(x.status, 502);
  ctlMode = 'protected';
  x = await raw('POST', '/resource-restart', { name: 'kora_core' });
  assert.deepEqual([x.status, x.body], [403, { ok: false, error: 'protected' }]);
  ctlMode = 'disabled';
  x = await raw('POST', '/resource-restart', { name: 'kora_core' });
  assert.equal(x.status, 503); assert.match(x.body.error, /kora_qa_enabled 0/);
  ctlMode = 'badauth';
  x = await raw('POST', '/resource-restart', { name: 'kora_core' });
  assert.equal(x.status, 502); assert.match(x.body.error, /refused the panel \(HTTP 401/);
  ctlMode = 'ok';
  assert.equal((await raw('POST', '/resource-restart', { name: '../x' })).status, 400);
});
