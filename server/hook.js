// Bughook-compatible server (QA-CONTRACTS §4): the contract claude-bugfix (bugfix.sh / apply-fix.sh, lib.sh hook_*)
// uses against communitybot's modules/bughook.js today — same routes, Bearer auth, validation, 500-char limits, status
// codes and 409 texts ("status changed: expected X, is Y", "already marked"). Plain node:http like the original so
// the responses (JSON + Content-Length + Connection: close) match. Listens on 127.0.0.1 only.
import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { tx, json } from './db.js';
import { HOOK_ACTIONS, cleanText, normStatus, parseExpect, statusName } from './machine.js';
import { transition, getIssue } from './issues.js';
import { listBugs, bugView } from './bugview.js';
import { syncFixFromDisk } from './fixes.js';

export const THREAD_ID_RE = /^\d{15,25}$/;
export const RESOURCE_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const MAX_BODY = 8 * 1024;
export const MAX_NOTE = 500;
export const MIN_SECRET = 32;

export function secretMatches(header, secret) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  const a = crypto.createHash('sha256').update(m ? m[1] : '').digest();
  const b = crypto.createHash('sha256').update(String(secret ?? '')).digest();
  return crypto.timingSafeEqual(a, b) && Boolean(m) && Boolean(secret);
}

// Same validation and limits as communitybot's buildDetail. Returns { error } or { detail, attempt }.
export function buildDetail({ note, commit, model, resource, summary, reasoning }) {
  const lines = [];
  const attempt = {};
  if (commit !== undefined) {
    if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) return { error: 'commit must be 7 to 40 hex characters' };
    attempt.commit = commit.slice(0, 7).toLowerCase();
    attempt.patchId = commit.toLowerCase();
  }
  if (resource !== undefined) {
    if (typeof resource !== 'string' || !/^[\w.-]{1,60}$/.test(resource)) return { error: 'resource must be a resource name (letters, digits, _ . -)' };
    attempt.resource = resource;
  }
  if (model !== undefined) {
    if (typeof model !== 'string' || !/^[\w.-]{1,50}$/.test(model)) return { error: 'model must be a model id (letters, digits, _ . -)' };
    attempt.model = model;
  }
  if (summary !== undefined) {
    if (typeof summary !== 'string') return { error: 'summary must be a string' };
    if (summary.length > MAX_NOTE) return { error: `summary is longer than ${MAX_NOTE} characters` };
    const clean = cleanText(summary);
    if (clean) attempt.summary = clean;
  }
  if (reasoning !== undefined) {
    if (typeof reasoning !== 'string') return { error: 'reasoning must be a string' };
    if (reasoning.length > MAX_NOTE) return { error: `reasoning is longer than ${MAX_NOTE} characters` };
    const clean = cleanText(reasoning);
    if (clean) attempt.reasoning = clean;
  }
  let cleanNote = '';
  if (note !== undefined) {
    if (typeof note !== 'string') return { error: 'note must be a string' };
    if (note.length > MAX_NOTE) return { error: `note is longer than ${MAX_NOTE} characters` };
    cleanNote = cleanText(note);
  }
  if (attempt.commit) lines.push(`Commit: \`${attempt.commit}\`${attempt.resource ? ` in ${attempt.resource}` : ''}`);
  else if (attempt.resource) lines.push(`Resource: ${attempt.resource}`);
  if (attempt.summary) lines.push(`What changed: ${attempt.summary}`);
  if (attempt.model) lines.push(`Attempted by: \`${attempt.model}\``);
  if (attempt.reasoning) lines.push(`Why: ${attempt.reasoning}`);
  if (cleanNote) lines.push(`Note: ${cleanNote}`);
  return { detail: lines.join('\n'), attempt, note: cleanNote };
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); return resolve(null); }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) { done = true; chunks.length = 0; resolve(null); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// Common front matter for the POST routes: method, auth, body. Returns the parsed object or null (response sent).
async function postBody(req, res, secret) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    send(res, 405, { ok: false, error: 'use POST' });
    return null;
  }
  if (!secretMatches(req.headers.authorization, secret)) { send(res, 401, { ok: false, error: 'unauthorized' }); return null; }
  const raw = await readBody(req);
  if (raw === null) { send(res, 413, { ok: false, error: 'body too large' }); return null; }
  let body;
  try { body = JSON.parse(raw); } catch { send(res, 400, { ok: false, error: 'body must be JSON' }); return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { ok: false, error: 'body must be a JSON object' }); return null; }
  return body;
}

const FIXER = { name: 'claude-bugfix' };

async function handleStatus(req, res, secret) {
  const body = await postBody(req, res, secret);
  if (!body) return;
  const { threadId, status } = body;
  if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return send(res, 400, { ok: false, error: 'threadId must be a Discord id string' });
  if (typeof status !== 'string' || !Object.hasOwn(HOOK_ACTIONS, status)) return send(res, 400, { ok: false, error: `status must be one of: ${Object.keys(HOOK_ACTIONS).join(', ')}` });
  const built = buildDetail(body);
  if (built.error) return send(res, 400, { ok: false, error: built.error });
  const expected = parseExpect(body.expect);
  if (expected.error) return send(res, 400, { ok: false, error: expected.error });

  const issue = await getIssue(threadId);
  if (!issue) return send(res, 404, { ok: false, error: 'thread is not a post in the feedback forum' });
  const previous = normStatus(issue.status);
  const target = HOOK_ACTIONS[status];
  if (expected.expect !== undefined && previous !== expected.expect) return send(res, 409, { ok: false, error: `status changed: expected ${expected.expect}, is ${previous}` });
  if (previous === target) return send(res, 409, { ok: false, error: `post is already marked ${statusName(previous)}` });

  const attempt = Object.keys(built.attempt).length ? { ...built.attempt, at: Date.now() } : null;
  const result = await transition({
    issueId: threadId, op: target, system: true, actor: FIXER, expect: expected.expect ?? previous, detail: built.detail,
    note: built.note || null, data: { hook: status, ...(attempt ? { attempt } : {}) }, auto: 'by the automatic fixer',
  });
  if (!result.ok && result.code === 'same') return send(res, 409, { ok: false, error: `post is already marked ${statusName(result.current)}` });
  if (!result.ok && result.code === 'notfound') return send(res, 404, { ok: false, error: 'thread is not a post in the feedback forum' });
  if (!result.ok) return send(res, 409, { ok: false, error: result.code === 'expect' ? `status changed: expected ${expected.expect ?? previous}, is ${result.current}` : result.error });
  if (target === 'fixed_awaiting_restart') syncFixFromDisk(threadId).catch(() => {});
  return send(res, 200, { ok: true, threadId, status, previous });
}

const META_STATUS = { open: 'open', info: 'info', dup: 'dup', wontfix: 'wontfix' };

async function handleMeta(req, res, secret) {
  const body = await postBody(req, res, secret);
  if (!body) return;
  const { threadId, kind, title, status, note } = body;
  if (status !== undefined && !Object.hasOwn(META_STATUS, status)) return send(res, 400, { ok: false, error: `status must be one of: ${Object.keys(META_STATUS).join(', ')}` });
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) return send(res, 400, { ok: false, error: `note must be a string of at most ${MAX_NOTE} characters` });
  if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return send(res, 400, { ok: false, error: 'threadId must be a Discord id string' });
  if (kind !== undefined && kind !== 'bug' && kind !== 'suggestion') return send(res, 400, { ok: false, error: "kind must be 'bug' or 'suggestion'" });
  const name = title === undefined ? undefined : String(title).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name !== undefined && (!name || name.length > 100)) return send(res, 400, { ok: false, error: 'title must be 1 to 100 characters' });
  if (kind === undefined && name === undefined && status === undefined) return send(res, 400, { ok: false, error: 'nothing to change: give kind, title and/or status' });

  if (!(await getIssue(threadId))) return send(res, 404, { ok: false, error: 'thread is not a post in the feedback forum' });
  const changes = await tx(async (conn) => {
    const issue = await getIssue(threadId, conn, { lock: true });
    const out = [];
    const sets = [];
    const params = [];
    if (kind !== undefined && (issue.kind ?? 'bug') !== kind) { sets.push('kind = ?'); params.push(kind); out.push(`kind → ${kind}`); }
    if (name !== undefined && issue.title !== name) { sets.push('title = ?'); params.push(name); out.push(`title → ${name}`); }
    if (sets.length) {
      const at = Date.now();
      await conn.query(`UPDATE issues SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, at, threadId]);
      await conn.query('INSERT INTO issue_events (issue_id, at, by_name, type, note, data) VALUES (?, ?, ?, ?, ?, ?)', [threadId, at, FIXER.name, 'meta', out.join('; '), json({ changes: out, source: 'hook' })]);
    }
    return out;
  });
  let statusResult = null;
  const current = await getIssue(threadId);
  if (status !== undefined && normStatus(current.status) !== META_STATUS[status]) {
    const clean = note ? cleanText(note) : '';
    statusResult = await transition({ issueId: threadId, op: META_STATUS[status], system: true, actor: FIXER, detail: clean ? `Note: ${clean}` : '', note: clean || null, auto: 'during bug triage', data: { hook: 'bug-meta' } });
    if (!statusResult.ok) return send(res, 409, { ok: false, error: statusResult.error });
  }
  const after = await getIssue(threadId);
  return send(res, 200, { ok: true, threadId, kind: after.kind === 'suggestion' ? 'suggestion' : 'bug', title: after.title ?? null, status: normStatus(after.status), changed: changes.length > 0 || Boolean(statusResult?.ok) });
}

async function handleBugs(req, res, secret, url) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { ok: false, error: 'use GET' }); }
  if (!secretMatches(req.headers.authorization, secret)) return send(res, 401, { ok: false, error: 'unauthorized' });
  const filter = url.searchParams.get('status');
  const wanted = filter ? new Set(filter.split(',').map((s) => normStatus(s.trim())).filter(Boolean)) : null;
  const bugs = await listBugs({ statuses: wanted, active: url.searchParams.get('active') === '1' });
  return send(res, 200, { bugs });
}

async function handleBug(req, res, secret, threadId) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'use GET' }); }
  if (!secretMatches(req.headers.authorization, secret)) return send(res, 401, { error: 'unauthorized' });
  if (!THREAD_ID_RE.test(threadId)) return send(res, 400, { error: 'threadId must be a Discord id string' });
  const view = await bugView(threadId);
  if (!view) return send(res, 404, { error: 'not found' });
  return send(res, 200, view);
}

// Forwards { cmd:'restart', name } to kora_qa's ctl handler in FXServer.
export async function ctlRequest(payload, { url = config().fxCtlUrl, secret = config().gameSecret, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}

async function handleRestart(req, res, secret, ctl) {
  const body = await postBody(req, res, secret);
  if (!body) return;
  const { name } = body;
  if (typeof name !== 'string' || !RESOURCE_NAME_RE.test(name)) return send(res, 400, { ok: false, error: 'name must match ^[A-Za-z0-9_-]+$' });
  if (config().protectedResources.includes(name)) return send(res, 403, { ok: false, error: 'protected' });
  let out;
  try {
    out = await ctl({ cmd: 'restart', name });
  } catch (error) {
    return send(res, 502, { ok: false, error: `kora_qa ctl unreachable: ${error?.cause?.code ?? error?.name ?? 'error'}` });
  }
  // kora_qa ctl codes (S2): 404 unknown resource, 403 'protected resource' (its own Config.protectedResources) or
  // non-loopback, 401 bad bearer, 400 bad body, 503 kora_qa_enabled=0.
  const ctlError = String(out.body?.error ?? '');
  if (out.status === 404) return send(res, 404, { ok: false, error: 'unknown resource' });
  if (out.status === 403 && /protected/i.test(ctlError)) return send(res, 403, { ok: false, error: 'protected' });
  if (out.status === 503) return send(res, 503, { ok: false, error: `kora_qa is disabled on the server (kora_qa_enabled 0)${ctlError ? `: ${ctlError}` : ''}` });
  if (out.status === 401 || out.status === 403) return send(res, 502, { ok: false, error: `kora_qa ctl refused the panel (HTTP ${out.status}${ctlError ? `: ${ctlError}` : ''}); check KORA_QA_GAME_SECRET / kora_qa_secret` });
  if (out.status !== 200 || !out.body?.ok) return send(res, 502, { ok: false, error: `kora_qa ctl answered HTTP ${out.status}: ${String(out.body?.error ?? out.text ?? '').slice(0, 200)}` });
  return send(res, 200, { ok: true, message: `ensure ${name} sent${out.body.output ? `: ${out.body.output}` : ' (no console output)'}` });
}

const BUG_PATH = /^\/bug\/([^/]+)$/;

export function createHookHandler({ secret = config().bugHookSecret, ctl = ctlRequest } = {}) {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    let work;
    if (p === '/bug-status') work = handleStatus(req, res, secret);
    else if (p === '/bugs') work = handleBugs(req, res, secret, url);
    else if (p === '/bug-meta') work = handleMeta(req, res, secret);
    else if (p === '/resource-restart') work = handleRestart(req, res, secret, ctl);
    else {
      const m = BUG_PATH.exec(p);
      if (m) {
        let id;
        try { id = decodeURIComponent(m[1]); } catch { id = m[1]; }
        work = handleBug(req, res, secret, id);
      } else work = Promise.resolve(send(res, 404, { ok: false, error: 'not found' }));
    }
    work.catch((error) => {
      console.error('[hook] request failed:', error?.message ?? error);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    });
  };
}

export async function startHook({ port = config().hookPort, host = '127.0.0.1', secret = config().bugHookSecret, ctl } = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) throw new Error('BUG_HOOK_SECRET missing or too short');
  if (host !== '127.0.0.1') throw new Error('the bug hook only listens on 127.0.0.1');
  const server = http.createServer(createHookHandler({ secret, ...(ctl ? { ctl } : {}) }));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

