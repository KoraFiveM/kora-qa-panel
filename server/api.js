// UI REST API under <base>/api (JSON). Session cookie auth; roles per QA-CONTRACTS §3. Documented in docs/API.md.
import fs from 'node:fs';
import { config } from './config.js';
import { q, one, tx, json } from './db.js';
import { sessionUser, userView, oauthConfigured } from './auth.js';
import { STATUS_ORDER, STATUS_LABELS, CLOSED, allowedOps, canSet, hasRole, isStatus, normStatus } from './machine.js';
import { transition, addMessage, getIssue } from './issues.js';
import { bugView } from './bugview.js';
import { renderReport } from './render-report.js';
import { verifyFileToken, filePath, fileUrl } from './files.js';
import { listFixDirs, fixDetail, runApplyFix, syncFixFromDisk } from './fixes.js';
import { runScan, servedScenarios, getRegistry, buildContext } from './scenarios/service.js';
import { discover } from './scenarios/scan.js';
import { ISSUE_ID_RE } from './ids.js';
import { emit } from './events.js';

const DAY = 24 * 3600 * 1000;
const RUN_STEPS_FOR = 20;
const DISCORD_ID_RE = /^\d{15,25}$/;
const err = (reply, code, error) => reply.code(code).send({ error });
const intIn = (v, d, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const csv = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function issueSummary(r) {
  return {
    id: String(r.id), title: r.title, kind: r.kind, status: normStatus(r.status), statusLabel: STATUS_LABELS[normStatus(r.status)] ?? r.status, source: r.source,
    reporter: { discordId: r.reporter_discord_id, name: r.reporter_name }, scenarioId: r.scenario_id, runId: r.run_id === null ? null : Number(r.run_id),
    failedStep: r.failed_step, notFixedCount: Number(r.not_fixed_count) || 0, fixedPaid: Boolean(r.fixed_paid),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), statusAt: Number(r.status_at),
    ...(r.messages !== undefined ? { messages: Number(r.messages) } : {}), ...(r.attachments !== undefined ? { attachments: Number(r.attachments) } : {}),
  };
}
const attachmentView = (a) => ({ id: Number(a.id), messageId: a.message_id === null ? null : Number(a.message_id), kind: a.kind, mime: a.mime, size: a.size, url: a.path ? `${config().basePath}/api/files/${a.id}` : a.original_url, signedUrl: a.path ? fileUrl(a.id) : null, originalUrl: a.original_url, createdAt: Number(a.created_at) });
const eventView = (e) => ({ id: Number(e.id), at: Number(e.at), by: { discordId: e.by_discord_id, name: e.by_name }, type: e.type, from: e.from_status, to: e.to_status, note: e.note, data: e.data });
const runView = (r) => ({ id: Number(r.id), scenarioId: r.scenario_id, scenarioHash: r.scenario_hash, legacyTestId: r.legacy_test_id, tester: { discordId: r.discord_id, name: r.name }, status: r.status, startedAt: Number(r.started_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at), legacy: Boolean(r.legacy), issueId: r.issue_id ? String(r.issue_id) : null, note: r.note });
const scenarioView = (s, extra = {}) => ({ id: s.id, resource: s.resource, file: s.file, line: s.line, name: s.name, description: s.description, tags: s.tags ?? [], target: s.target, hash: s.hash, valid: Boolean(s.valid), errors: s.errors ?? [], removed: Boolean(s.removed), legacyIds: s.legacy_ids ?? [], updatedAt: Number(s.updated_at), ...extra });

// Files: session, or a signed ?t= token (what GET /bug/:id hands the fixer). Mounted at <base>/api/files/:id and <base>/files/:id.
export async function serveFile(req, reply) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return err(reply, 404, 'not found');
  const tokenOk = req.query?.t && verifyFileToken(id, req.query.t);
  if (!tokenOk && !(await sessionUser(req))) return err(reply, 401, 'not logged in');
  const a = await one('SELECT * FROM issue_attachments WHERE id = ?', [id]);
  const abs = a?.path ? filePath(a.path) : null;
  if (!abs || !fs.existsSync(abs)) return err(reply, 404, 'not found');
  reply.header('Content-Type', a.mime ?? 'application/octet-stream').header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', 'inline').header('Content-Security-Policy', "default-src 'none'");
  return reply.send(fs.createReadStream(abs));
}

export function apiRoutes(app, { applyFix = runApplyFix } = {}) {
  const base = config().basePath;
  const publicOrigin = new URL(config().publicUrl).origin;
  app.get(`${base}/files/:id`, serveFile);

  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      // CSRF belt: SameSite=Lax already blocks cross-site POSTs with the cookie; also refuse a foreign Origin.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && origin !== publicOrigin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return err(reply, 403, 'cross-site request refused');
      }
      req.user = await sessionUser(req);
    });
    const need = (role) => async (req, reply) => {
      if (!req.user) return err(reply, 401, 'not logged in');
      if (!hasRole(req.user.role, role)) return err(reply, 403, `needs role ${role}`);
    };
    const actorOf = (req) => ({ discordId: req.user.discord_id, name: req.user.name, role: req.user.role });

    api.get('/me', async (req) => ({ user: userView(req.user), rolesFromDiscord: Boolean(config().discordGuildId), oauthConfigured: oauthConfigured(), devLogin: config().devLogin, loginUrl: `${base}/auth/login`, publicUrl: config().publicUrl }));

    api.get('/files/:id', serveFile);

    api.get('/meta', { preHandler: need('tester') }, async () => {
      const registry = await getRegistry();
      const { ctx, catalog } = buildContext({ registry, resources: [] });
      return {
        statuses: STATUS_ORDER.map((s) => ({ key: s, label: STATUS_LABELS[s], closed: CLOSED.has(s) })),
        roles: ['tester', 'dev', 'admin'], kinds: ['bug', 'suggestion'], sources: ['discord', 'scenario', 'freeform', 'retest'],
        runStatuses: ['running', 'passed', 'failed', 'aborted', 'blocked'], stepStatuses: ['pending', 'passed', 'failed', 'skipped', 'unverified', 'blocked'],
        manualReviewAfter: config().manualReviewAfter,
        steps: ctx.steps.map((s) => ({ id: s.id, pattern: s.pattern, kind: s.kind, side: s.side, resource: s.resource, priority: s.priority ?? 0, description: s.description ?? '', example: s.example ?? null, args: s.args ?? [] })),
        caps: ctx.caps, catalog, registryAt: registry?.updatedAt ?? null,
      };
    });

    api.get('/dashboard', { preHandler: need('tester') }, async () => {
      const now = Date.now();
      const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
      for (const r of await q('SELECT status, COUNT(*) AS n FROM issues WHERE deleted = 0 GROUP BY status')) byStatus[normStatus(r.status)] = (byStatus[normStatus(r.status)] ?? 0) + Number(r.n);
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const runsToday = await one("SELECT COUNT(*) AS total, SUM(status = 'passed') AS passed, SUM(status = 'failed') AS failed FROM runs WHERE started_at >= ? AND legacy = 0", [today.getTime()]);
      const per = await q(`SELECT s.resource, COUNT(*) AS runs, SUM(r.status = 'passed') AS passed, SUM(r.status = 'failed') AS failed
        FROM runs r JOIN scenarios s ON s.id = r.scenario_id WHERE r.started_at >= ? AND r.status IN ('passed','failed') GROUP BY s.resource ORDER BY s.resource`, [now - 30 * DAY]);
      const flaky = await q(`SELECT r.scenario_id, s.name, s.resource, SUM(r.status = 'passed') AS passed, SUM(r.status = 'failed') AS failed
        FROM runs r LEFT JOIN scenarios s ON s.id = r.scenario_id WHERE r.started_at >= ? AND r.status IN ('passed','failed') AND r.scenario_id IS NOT NULL
        GROUP BY r.scenario_id, s.name, s.resource HAVING passed > 0 AND failed > 0 ORDER BY failed DESC LIMIT 20`, [now - 30 * DAY]);
      const recent = await q('SELECT * FROM issues WHERE deleted = 0 ORDER BY updated_at DESC LIMIT 10');
      const scan = (await one("SELECT v FROM kv WHERE k = 'scan'"))?.v ?? null;
      const xp = await one('SELECT COUNT(*) AS pending, SUM(attempts > 0) AS failing FROM xp_outbox WHERE sent_at IS NULL');
      return {
        issuesByStatus: byStatus,
        openTotal: Object.entries(byStatus).filter(([k]) => !CLOSED.has(k)).reduce((a, [, n]) => a + n, 0),
        awaitingTest: byStatus.awaiting_test, waitingFixes: listFixDirs().fixes.filter((f) => f.state === 'waiting').length,
        runsToday: { total: Number(runsToday.total) || 0, passed: Number(runsToday.passed) || 0, failed: Number(runsToday.failed) || 0 },
        passRateByResource: per.map((r) => ({ resource: r.resource, runs: Number(r.runs), passed: Number(r.passed), failed: Number(r.failed), rate: Number(r.runs) ? Number(r.passed) / Number(r.runs) : null })),
        flaky: flaky.map((r) => ({ scenarioId: r.scenario_id, name: r.name, resource: r.resource, passed: Number(r.passed), failed: Number(r.failed) })),
        recentIssues: recent.map(issueSummary),
        scan: scan ? { at: scan.at, scenarios: scan.scenarios, valid: scan.valid, invalid: scan.invalid, catalogError: scan.catalog?.error ?? null } : null,
        xpOutbox: { pending: Number(xp.pending) || 0, failing: Number(xp.failing) || 0 },
      };
    });

    // ---- issues ----
    api.get('/issues', { preHandler: need('tester') }, async (req) => {
      const qs = req.query ?? {};
      const where = ['i.deleted = 0'];
      const params = [];
      // status = literal status keys; state=open|closed (or open=1) = the groups. status=closed (not a status key) is still
      // read as the closed group for one release.
      const statuses = csv(qs.status).filter(isStatus);
      const state = qs.state === 'open' || qs.open === '1' ? 'open' : qs.state === 'closed' || qs.status === 'closed' ? 'closed' : null;
      if (state) { where.push(`i.status ${state === 'open' ? 'NOT IN' : 'IN'} (${[...CLOSED].map(() => '?').join(',')})`); params.push(...CLOSED); }
      if (statuses.length) { where.push(`i.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
      const kinds = csv(qs.kind).filter((k) => k === 'bug' || k === 'suggestion');
      if (kinds.length) { where.push(`i.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
      const sources = csv(qs.source).filter((s) => ['discord', 'scenario', 'freeform', 'retest'].includes(s));
      if (sources.length) { where.push(`i.source IN (${sources.map(() => '?').join(',')})`); params.push(...sources); }
      if (typeof qs.resource === 'string' && /^[\w.-]{1,64}$/.test(qs.resource)) {
        where.push('(i.scenario_id LIKE ? OR EXISTS (SELECT 1 FROM fixes f WHERE f.issue_id = i.id AND JSON_SEARCH(f.meta, \'one\', ?, NULL, \'$.resources[*].name\') IS NOT NULL))');
        params.push(`${qs.resource}:%`, qs.resource);
      }
      if (typeof qs.reporter === 'string' && DISCORD_ID_RE.test(qs.reporter)) { where.push('i.reporter_discord_id = ?'); params.push(qs.reporter); }
      if (typeof qs.q === 'string' && qs.q.trim()) {
        const term = qs.q.trim().slice(0, 100);
        if (/^\d{15,25}$/.test(term)) { where.push('i.id = ?'); params.push(term); } else { where.push('(i.title LIKE ? OR i.reporter_name LIKE ?)'); params.push(`%${term}%`, `%${term}%`); }
      }
      const page = intIn(qs.page, 1, 1, 100000);
      const pageSize = intIn(qs.pageSize, 50, 1, 200);
      const sort = { updated: 'i.updated_at DESC', created: 'i.created_at DESC', status: 'i.status_at DESC' }[qs.sort] ?? 'i.updated_at DESC';
      const w = where.join(' AND ');
      const total = Number((await one(`SELECT COUNT(*) AS n FROM issues i WHERE ${w}`, params)).n);
      const rows = await q(`SELECT i.*, (SELECT COUNT(*) FROM issue_messages m WHERE m.issue_id = i.id) AS messages, (SELECT COUNT(*) FROM issue_attachments a WHERE a.issue_id = i.id) AS attachments
        FROM issues i WHERE ${w} ORDER BY ${sort}, i.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
      return { items: rows.map(issueSummary), total, page, pageSize };
    });

    api.get('/issues/:id', { preHandler: need('tester') }, async (req, reply) => {
      const id = String(req.params.id);
      if (!ISSUE_ID_RE.test(id)) return err(reply, 400, 'bad issue id');
      const issue = await getIssue(id);
      if (!issue) return err(reply, 404, 'issue not found');
      const [messages, atts, events, fixes, runs, prompts] = await Promise.all([
        q('SELECT * FROM issue_messages WHERE issue_id = ? ORDER BY created_at, id', [id]),
        q('SELECT * FROM issue_attachments WHERE issue_id = ? ORDER BY id', [id]),
        q('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY at, id', [id]),
        q('SELECT * FROM fixes WHERE issue_id = ? ORDER BY created_at DESC', [id]),
        q('SELECT * FROM runs WHERE issue_id = ? OR id = ? ORDER BY started_at DESC', [id, issue.run_id ?? 0]),
        q('SELECT id, kind, content, meta, created_at FROM issue_prompts WHERE issue_id = ? ORDER BY created_at DESC', [id]),
      ]);
      const scenario = issue.scenario_id ? await one('SELECT * FROM scenarios WHERE id = ?', [issue.scenario_id]) : null;
      const attV = atts.map(attachmentView);
      const fixDir = listFixDirs().fixes.find((f) => f.issueId === id) ?? null;
      return {
        issue: { ...issueSummary(issue), report: issue.report, modOverride: issue.mod_override, legacy: issue.legacy, url: `${config().publicUrl}/issues/${id}` },
        renderedReport: issue.report ? renderReport({ issue, report: issue.report, scenario: scenario ? { steps: scenario.steps } : null }) : null,
        messages: messages.map((m) => ({ id: Number(m.id), author: { discordId: m.author_discord_id, name: m.author_name }, isBot: Boolean(m.is_bot), content: m.content, createdAt: Number(m.created_at), attachments: attV.filter((a) => a.messageId === Number(m.id)) })),
        attachments: attV,
        events: events.map(eventView),
        fixes: fixes.map((f) => ({ id: Number(f.id), patchId: f.patch_id, model: f.model, risk: f.risk, summary: f.summary, details: f.details, testSteps: f.test_steps, scenario: f.scenario, applied: f.applied, isHistory: Boolean(f.is_history), createdAt: Number(f.created_at) })),
        currentFix: fixDir ? { state: fixDir.state, appliedAt: fixDir.appliedAt, patchId: fixDir.meta.patchId, model: fixDir.meta.model, risk: fixDir.meta.risk, summary: fixDir.meta.summary, resources: (fixDir.meta.resources ?? []).map((r) => r.name) } : null,
        runs: runs.map(runView),
        prompts: prompts.map((p) => ({ id: Number(p.id), kind: p.kind, content: p.content, meta: p.meta, createdAt: Number(p.created_at) })),
        scenario: scenario ? scenarioView(scenario, { steps: scenario.steps }) : null,
        allowedOps: allowedOps({ role: req.user.role, from: issue.status }),
        promptPreview: await bugView(id),
      };
    });

    api.post('/issues/:id/comments', { preHandler: need('tester') }, async (req, reply) => {
      const id = String(req.params.id);
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      if (!content || content.length > 4000) return err(reply, 400, 'content must be 1 to 4000 characters');
      if (!ISSUE_ID_RE.test(id) || !(await getIssue(id))) return err(reply, 404, 'issue not found');
      const messageId = await addMessage({ issueId: id, discordId: req.user.discord_id, name: req.user.name, content });
      return { ok: true, messageId: Number(messageId) };
    });

    const doTransition = async (req, reply, op, { note = null, override = null, detail = '' } = {}) => {
      const id = String(req.params.id);
      if (!ISSUE_ID_RE.test(id)) return err(reply, 400, 'bad issue id');
      const expect = typeof req.body?.expect === 'string' ? req.body.expect : undefined;
      const out = await transition({ issueId: id, op, actor: actorOf(req), enforce: true, expect, note, override, detail });
      if (!out.ok) return err(reply, { notfound: 404, denied: 403, expect: 409, same: 409 }[out.code] ?? 400, out.error);
      return { ok: true, from: out.from, to: out.to, issue: issueSummary(out.issue) };
    };

    api.post('/issues/:id/status', { preHandler: need('tester') }, async (req, reply) => {
      const { status, note, override } = req.body ?? {};
      if (typeof status !== 'string' || !isStatus(status)) return err(reply, 400, `status must be one of: ${STATUS_ORDER.join(', ')}`);
      if (note !== undefined && (typeof note !== 'string' || note.length > 500)) return err(reply, 400, 'note must be at most 500 characters');
      if (override !== undefined && (typeof override !== 'string' || override.length > 500 || status !== 'open')) return err(reply, 400, 'override is a reason (≤500 chars) and only goes with status open');
      if (override && !hasRole(req.user.role, 'dev')) return err(reply, 403, 'needs role dev');
      const clean = typeof note === 'string' ? note.trim() : '';
      return doTransition(req, reply, status, { note: clean || null, override: override?.trim() || null, detail: clean ? `Note: ${clean}` : '' });
    });

    api.post('/issues/:id/not-fixed', { preHandler: need('tester') }, async (req, reply) => {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
      if (!note || note.length > 2000) return err(reply, 400, 'say what did not work (note, 1 to 2000 characters)');
      const id = String(req.params.id);
      const issue = ISSUE_ID_RE.test(id) ? await getIssue(id) : null;
      if (!issue) return err(reply, 404, 'issue not found');
      if (!canSet({ role: req.user.role, op: 'not_fixed', from: issue.status })) return err(reply, 409, `issue is ${issue.status}; Not fixed only applies while awaiting test`);
      await addMessage({ issueId: id, discordId: req.user.discord_id, name: req.user.name, content: `**Not fixed:** ${note}` });
      return doTransition(req, reply, 'not_fixed', { note });
    });

    api.post('/issues/:id/works', { preHandler: need('tester') }, async (req, reply) => {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      return doTransition(req, reply, 'works', { note: note || null, detail: note ? `Note: ${note}` : '' });
    });

    api.post('/issues/:id/meta', { preHandler: need('dev') }, async (req, reply) => {
      const id = String(req.params.id);
      const { title, kind } = req.body ?? {};
      const name = title === undefined ? undefined : String(title).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (name !== undefined && (!name || name.length > 200)) return err(reply, 400, 'title must be 1 to 200 characters');
      if (kind !== undefined && kind !== 'bug' && kind !== 'suggestion') return err(reply, 400, "kind must be 'bug' or 'suggestion'");
      if (name === undefined && kind === undefined) return err(reply, 400, 'nothing to change');
      const out = await tx(async (conn) => {
        const issue = await getIssue(id, conn, { lock: true });
        if (!issue) return null;
        const changes = [];
        const sets = [];
        const ps = [];
        if (name !== undefined && name !== issue.title) { sets.push('title = ?'); ps.push(name); changes.push(`title → ${name}`); }
        if (kind !== undefined && kind !== issue.kind) { sets.push('kind = ?'); ps.push(kind); changes.push(`kind → ${kind}`); }
        if (sets.length) {
          const at = Date.now();
          await conn.query(`UPDATE issues SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...ps, at, id]);
          await conn.query('INSERT INTO issue_events (issue_id, at, by_discord_id, by_name, type, note, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, at, req.user.discord_id, req.user.name, 'meta', changes.join('; '), json({ changes })]);
        }
        return { changes, issue: await getIssue(id, conn) };
      });
      if (!out) return err(reply, 404, 'issue not found');
      if (out.changes.length) emit('issue', { issueId: id });
      return { ok: true, changed: out.changes.length > 0, issue: issueSummary(out.issue) };
    });

    // ---- scenarios ----
    const lastRuns = async (ids) => {
      if (!ids.length) return new Map();
      const rows = await q(`SELECT scenario_id, scenario_hash, status, discord_id, started_at FROM runs WHERE scenario_id IN (${ids.map(() => '?').join(',')}) AND status IN ('passed','failed') ORDER BY started_at`, ids);
      const m = new Map();
      for (const r of rows) {
        const x = m.get(r.scenario_id) ?? { passes: 0, fails: 0, passers: new Set(), last: null };
        if (r.status === 'passed') { x.passes++; x.passers.add(r.discord_id); } else x.fails++;
        x.last = { status: r.status, at: Number(r.started_at), discordId: r.discord_id };
        m.set(r.scenario_id, x);
      }
      return m;
    };

    api.get('/scenarios', { preHandler: need('tester') }, async (req) => {
      const qs = req.query ?? {};
      const where = ['1=1'];
      const ps = [];
      if (qs.removed !== '1') where.push('removed = 0');
      if (typeof qs.resource === 'string' && qs.resource) { where.push('resource = ?'); ps.push(qs.resource); }
      if (qs.valid === '1' || qs.valid === '0') { where.push('valid = ?'); ps.push(Number(qs.valid)); }
      if (typeof qs.tag === 'string' && /^@[\w:.-]+$/.test(qs.tag)) { where.push('JSON_CONTAINS(tags, ?)'); ps.push(JSON.stringify(qs.tag)); }
      if (typeof qs.q === 'string' && qs.q.trim()) { where.push('(name LIKE ? OR id LIKE ?)'); ps.push(`%${qs.q.trim()}%`, `%${qs.q.trim()}%`); }
      const page = intIn(qs.page, 1, 1, 100000);
      const pageSize = intIn(qs.pageSize, 100, 1, 500);
      const w = where.join(' AND ');
      const total = Number((await one(`SELECT COUNT(*) AS n FROM scenarios WHERE ${w}`, ps)).n);
      const rows = await q(`SELECT * FROM scenarios WHERE ${w} ORDER BY resource, file, line LIMIT ? OFFSET ?`, [...ps, pageSize, (page - 1) * pageSize]);
      const stats = await lastRuns(rows.map((r) => r.id));
      const byResource = await q('SELECT resource, COUNT(*) AS total, SUM(valid = 1) AS valid, SUM(valid = 0) AS invalid FROM scenarios WHERE removed = 0 GROUP BY resource ORDER BY resource');
      return {
        items: rows.map((r) => {
          const st = stats.get(r.id);
          return scenarioView(r, { steps: undefined, stepCount: (r.steps ?? []).length, passes: st?.passes ?? 0, fails: st?.fails ?? 0, distinctPassers: st?.passers.size ?? 0, lastResult: st?.last ?? null, done: (st?.passers.size ?? 0) >= (r.target ?? 1) });
        }),
        total, page, pageSize,
        resources: byResource.map((r) => ({ resource: r.resource, total: Number(r.total), valid: Number(r.valid), invalid: Number(r.invalid) })),
      };
    });

    api.get('/scenarios/invalid', { preHandler: need('tester') }, async () => {
      const rows = await q('SELECT * FROM scenarios WHERE valid = 0 AND removed = 0 ORDER BY resource, file, line');
      const scan = (await one("SELECT v FROM kv WHERE k = 'scan'"))?.v ?? null;
      return { items: rows.map((r) => scenarioView(r, { steps: r.steps })), scan };
    });

    api.get('/scenarios/coverage', { preHandler: need('tester') }, async () => {
      const resources = discover(config().resDir, { scanAll: true });
      const counts = new Map((await q('SELECT resource, COUNT(*) AS total, SUM(valid = 1) AS valid FROM scenarios WHERE removed = 0 GROUP BY resource')).map((r) => [r.resource, r]));
      const { findResources } = await import('./scenarios/scan.js');
      const all = findResources(config().resDir);
      const opted = new Map(resources.map((r) => [r.name, r]));
      const items = all.map((r) => {
        const c = counts.get(r.name);
        return { resource: r.name, path: r.dir.slice(config().resDir.length + 1), optedIn: Boolean(opted.get(r.name)?.optedIn), featureFiles: opted.get(r.name)?.files.length ?? 0, scenarios: Number(c?.total ?? 0), valid: Number(c?.valid ?? 0) };
      });
      return { items, withoutScenarios: items.filter((i) => !i.scenarios).map((i) => i.resource) };
    });

    api.post('/scenarios/rescan', { preHandler: need('dev') }, async () => ({ ok: true, scan: await runScan() }));
    api.get('/scenarios/served', { preHandler: need('dev') }, async () => servedScenarios());

    api.get('/scenarios/:id', { preHandler: need('tester') }, async (req, reply) => {
      const s = await one('SELECT * FROM scenarios WHERE id = ?', [String(req.params.id)]);
      if (!s) return err(reply, 404, 'scenario not found');
      const runs = await q('SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at DESC LIMIT 100', [s.id]);
      const issues = await q('SELECT * FROM issues WHERE scenario_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 100', [s.id]);
      const legacy = await q('SELECT * FROM legacy_tests WHERE scenario_id = ?', [s.id]);
      const st = (await lastRuns([s.id])).get(s.id);
      // Per-step results for the most recent RUN_STEPS_FOR runs (last-run icons on the scenario page).
      const withSteps = runs.slice(0, RUN_STEPS_FOR).map((r) => r.id);
      const stepRows = withSteps.length ? await q(`SELECT run_id, idx, status, at FROM run_steps WHERE run_id IN (${withSteps.map(() => '?').join(',')}) ORDER BY run_id, idx`, withSteps) : [];
      const stepsByRun = new Map();
      for (const x of stepRows) { const k = Number(x.run_id); if (!stepsByRun.has(k)) stepsByRun.set(k, []); stepsByRun.get(k).push({ idx: x.idx, status: x.status, at: Number(x.at) }); }
      return {
        scenario: scenarioView(s, { steps: s.steps ?? [], passes: st?.passes ?? 0, fails: st?.fails ?? 0, distinctPassers: st?.passers.size ?? 0, lastResult: st?.last ?? null }),
        runs: runs.map((r) => (stepsByRun.has(Number(r.id)) || withSteps.includes(r.id) ? { ...runView(r), steps: stepsByRun.get(Number(r.id)) ?? [] } : runView(r))),
        issues: issues.map(issueSummary),
        legacyTests: legacy.map((l) => ({ id: l.id, source: l.source, resource: l.resource, title: l.title, description: l.description, data: l.data })),
      };
    });

    // ---- runs ----
    api.get('/runs', { preHandler: need('tester') }, async (req) => {
      const qs = req.query ?? {};
      const where = ['1=1'];
      const ps = [];
      if (typeof qs.scenarioId === 'string' && qs.scenarioId) { where.push('r.scenario_id = ?'); ps.push(qs.scenarioId); }
      if (typeof qs.discordId === 'string' && DISCORD_ID_RE.test(qs.discordId)) { where.push('r.discord_id = ?'); ps.push(qs.discordId); }
      const sts = csv(qs.status).filter((s) => ['running', 'passed', 'failed', 'aborted', 'blocked'].includes(s));
      if (sts.length) { where.push(`r.status IN (${sts.map(() => '?').join(',')})`); ps.push(...sts); }
      if (qs.legacy === '0' || qs.legacy === '1') { where.push('r.legacy = ?'); ps.push(Number(qs.legacy)); }
      if (typeof qs.resource === 'string' && qs.resource) { where.push('r.scenario_id LIKE ?'); ps.push(`${qs.resource}:%`); }
      const page = intIn(qs.page, 1, 1, 100000);
      const pageSize = intIn(qs.pageSize, 50, 1, 200);
      const w = where.join(' AND ');
      const total = Number((await one(`SELECT COUNT(*) AS n FROM runs r WHERE ${w}`, ps)).n);
      const rows = await q(`SELECT r.*, s.name AS scenario_name, s.resource AS scenario_resource FROM runs r LEFT JOIN scenarios s ON s.id = r.scenario_id WHERE ${w} ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`, [...ps, pageSize, (page - 1) * pageSize]);
      return { items: rows.map((r) => ({ ...runView(r), scenarioName: r.scenario_name, resource: r.scenario_resource })), total, page, pageSize };
    });

    api.get('/runs/:id', { preHandler: need('tester') }, async (req, reply) => {
      const r = await one('SELECT * FROM runs WHERE id = ?', [Number(req.params.id) || 0]);
      if (!r) return err(reply, 404, 'run not found');
      const steps = await q('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx', [r.id]);
      const s = r.scenario_id ? await one('SELECT * FROM scenarios WHERE id = ?', [r.scenario_id]) : null;
      return {
        run: { ...runView(r), context: r.context },
        steps: steps.map((x) => ({ idx: x.idx, text: x.text, kind: x.kind, status: x.status, detail: x.detail, at: Number(x.at) })),
        scenario: s ? scenarioView(s, { steps: s.steps ?? [] }) : null,
        scenarioChanged: Boolean(s && r.scenario_hash && s.hash !== r.scenario_hash),
      };
    });

    // ---- fixes ----
    api.get('/fixes', { preHandler: need('dev') }, async (req) => {
      const { fixes, error } = listFixDirs();
      const state = ['waiting', 'applied'].includes(req.query?.state) ? req.query.state : null;
      const list = fixes.filter((f) => !state || f.state === state);
      const ids = list.map((f) => f.issueId);
      const issues = ids.length ? new Map((await q(`SELECT * FROM issues WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map((i) => [String(i.id), i])) : new Map();
      return {
        error: error ?? null,
        items: list.map((f) => {
          const i = issues.get(f.issueId);
          return { issueId: f.issueId, state: f.state, appliedAt: f.appliedAt, title: f.meta.title ?? i?.title ?? null, issueStatus: i ? normStatus(i.status) : null, kind: f.meta.kind ?? 'bug', model: f.meta.model, risk: f.meta.risk, patchId: f.meta.patchId, createdAt: f.meta.createdAt, summary: f.meta.summary, reasoning: f.meta.reasoning ?? null, resources: (f.meta.resources ?? []).map((r) => r.name), patches: f.patches, scenarioFile: f.meta.scenarioFile ?? null };
        }),
      };
    });

    api.get('/fixes/:id', { preHandler: need('dev') }, async (req, reply) => {
      const id = String(req.params.id);
      if (!ISSUE_ID_RE.test(id)) return err(reply, 400, 'bad issue id');
      const d = await fixDetail(id);
      if (!d) return err(reply, 404, 'no prepared fix for this issue');
      const issue = await getIssue(id);
      return { ...d, issue: issue ? issueSummary(issue) : null };
    });

    const fixAction = (mode) => async (req, reply) => {
      const id = String(req.params.id);
      if (!ISSUE_ID_RE.test(id)) return err(reply, 400, 'bad issue id');
      if (req.body?.confirm !== true) return err(reply, 400, 'set "confirm": true to run this');
      const args = [mode === 'apply' ? '--apply' : '--revert', id, ...(req.body?.noRestart === true ? ['--no-restart'] : [])];
      const out = await applyFix(args);
      const output = `${out.stdout}${out.stderr}`.slice(-20000);
      const at = Date.now();
      if (await getIssue(id)) {
        await q('INSERT INTO issue_events (issue_id, at, by_discord_id, by_name, type, note, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, at, req.user.discord_id, req.user.name, 'fix', `${mode}${req.body?.noRestart ? ' (no restart)' : ''}: ${out.ok ? 'ok' : `failed (exit ${out.code})`}`, json({ mode, noRestart: req.body?.noRestart === true, ok: out.ok, code: out.code, output: output.slice(-4000) })]);
        await q('UPDATE issues SET updated_at = ? WHERE id = ?', [at, id]);
        syncFixFromDisk(id).catch(() => {});
      }
      return reply.code(out.ok ? 200 : 502).send({ ok: out.ok, code: out.code, output });
    };
    api.post('/fixes/:id/apply', { preHandler: need('admin') }, fixAction('apply'));
    api.post('/fixes/:id/revert', { preHandler: need('admin') }, fixAction('revert'));

    // ---- retests ----
    api.get('/retests', { preHandler: need('tester') }, async () => {
      const rows = await q("SELECT i.*, s.name AS scenario_name FROM issues i LEFT JOIN scenarios s ON s.id = i.scenario_id WHERE i.status = 'awaiting_test' AND i.deleted = 0 ORDER BY i.status_at");
      return { items: rows.map((r) => ({ ...issueSummary(r), scenarioName: r.scenario_name ?? null })) };
    });

    // ---- users ----
    api.get('/users', { preHandler: need('admin') }, async () => {
      const rows = await q('SELECT * FROM users ORDER BY disabled, role DESC, name');
      const pending = (await one("SELECT v FROM kv WHERE k = 'pending_logins'"))?.v ?? [];
      const roleChanges = (await one("SELECT v FROM kv WHERE k = 'role_changes'"))?.v ?? [];
      // In guild-role mode a refused person may have an (imported) account without a mapped role: keep them listed.
      return { items: rows.map(userView), pendingLogins: pending.filter((p) => p.reason === 'no mapped Discord role' || !rows.some((r) => r.discord_id === p.discordId)), roleChanges: roleChanges.slice(0, 50), rolesFromDiscord: Boolean(config().discordGuildId) };
    });

    api.post('/users/pending/:discordId/dismiss', { preHandler: need('admin') }, async (req) => {
      const did = String(req.params.discordId);
      const pending = (await one("SELECT v FROM kv WHERE k = 'pending_logins'"))?.v ?? [];
      const left = pending.filter((p) => p.discordId !== did);
      await q("INSERT INTO kv (k, v) VALUES ('pending_logins', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(left)]);
      return { ok: true, dismissed: pending.length - left.length };
    });

    // Disable (keeps history; revokes sessions; no login; not a tester in game) or re-enable a user.
    api.post('/users/:discordId/disabled', { preHandler: need('admin') }, async (req, reply) => {
      const did = String(req.params.discordId);
      const disabled = req.body?.disabled;
      if (typeof disabled !== 'boolean') return err(reply, 400, 'disabled must be true or false');
      const u = await one('SELECT * FROM users WHERE discord_id = ?', [did]);
      if (!u) return err(reply, 404, 'user not found');
      if (disabled && u.id === req.user.id) return err(reply, 409, 'you cannot disable yourself');
      if (disabled && u.role === 'admin' && Number((await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")).n) <= 1) return err(reply, 409, 'cannot disable the last admin');
      await q('UPDATE users SET disabled = ?, disabled_at = ? WHERE id = ?', [disabled ? 1 : 0, disabled ? Date.now() : null, u.id]);
      let revoked = 0;
      if (disabled) revoked = (await q('DELETE FROM sessions WHERE user_id = ?', [u.id])).affectedRows;
      return { ok: true, user: userView(await one('SELECT * FROM users WHERE id = ?', [u.id])), sessionsRevoked: revoked };
    });

    api.post('/users', { preHandler: need('admin') }, async (req, reply) => {
      const { discordId, name, role } = req.body ?? {};
      if (!DISCORD_ID_RE.test(String(discordId ?? ''))) return err(reply, 400, 'discordId must be a Discord id');
      if (role !== undefined && !['tester', 'dev', 'admin'].includes(role)) return err(reply, 400, 'role must be tester, dev or admin');
      await q('INSERT INTO users (discord_id, name, role, legacy, created_at) VALUES (?, ?, ?, 0, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), name = COALESCE(VALUES(name), name)', [String(discordId), typeof name === 'string' ? name.slice(0, 100) : null, role ?? 'tester', Date.now()]);
      return { ok: true, user: userView(await one('SELECT * FROM users WHERE discord_id = ?', [String(discordId)])) };
    });

    api.post('/users/:discordId/role', { preHandler: need('admin') }, async (req, reply) => {
      const did = String(req.params.discordId);
      const role = req.body?.role;
      if (!['tester', 'dev', 'admin'].includes(role)) return err(reply, 400, 'role must be tester, dev or admin');
      const u = await one('SELECT * FROM users WHERE discord_id = ?', [did]);
      if (!u) return err(reply, 404, 'user not found');
      if (u.role === 'admin' && role !== 'admin' && Number((await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")).n) <= 1) return err(reply, 409, 'cannot remove the last admin');
      await q('UPDATE users SET role = ? WHERE id = ?', [role, u.id]);
      return { ok: true, user: userView(await one('SELECT * FROM users WHERE id = ?', [u.id])) };
    });

    // ---- testers ----
    const testerStats = async (discordId = null) => {
      const w = discordId ? 'WHERE discord_id = ?' : '';
      const ps = discordId ? [discordId] : [];
      const runs = await q(`SELECT discord_id, MAX(name) AS name, SUM(status = 'passed') AS passed, SUM(status = 'failed') AS failed, COUNT(*) AS total, SUM(legacy = 1) AS legacy, MAX(started_at) AS last_at FROM runs ${w} GROUP BY discord_id`, ps);
      const issues = await q(`SELECT reporter_discord_id AS discord_id, COUNT(*) AS reported, SUM(status = 'fixed') AS fixed, SUM(status IN ('dup','wontfix')) AS closed FROM issues WHERE deleted = 0 AND reporter_discord_id IS NOT NULL ${discordId ? 'AND reporter_discord_id = ?' : ''} GROUP BY reporter_discord_id`, ps);
      const legacy = await q(`SELECT discord_id, data FROM tester_stats ${w}`, ps);
      const users = await q(`SELECT * FROM users ${w}`, ps);
      const m = new Map();
      const get = (id) => { if (!m.has(id)) m.set(id, { discordId: id, name: null, role: null, runs: { total: 0, passed: 0, failed: 0, legacy: 0, lastAt: null }, issues: { reported: 0, fixed: 0, closed: 0 }, legacyStats: null }); return m.get(id); };
      for (const u of users) Object.assign(get(u.discord_id), { name: u.name, role: u.role });
      for (const r of runs) { const x = get(r.discord_id); x.name ??= r.name; x.runs = { total: Number(r.total), passed: Number(r.passed), failed: Number(r.failed), legacy: Number(r.legacy), lastAt: r.last_at === null ? null : Number(r.last_at) }; }
      for (const r of issues) get(r.discord_id).issues = { reported: Number(r.reported), fixed: Number(r.fixed), closed: Number(r.closed) };
      for (const r of legacy) get(r.discord_id).legacyStats = r.data;
      return [...m.values()].filter((x) => x.runs.total || x.issues.reported || x.legacyStats || x.role).sort((a, b) => b.runs.passed + b.issues.reported - (a.runs.passed + a.issues.reported));
    };
    api.get('/testers', { preHandler: need('tester') }, async () => ({ items: await testerStats() }));
    api.get('/testers/:discordId', { preHandler: need('tester') }, async (req, reply) => {
      const did = String(req.params.discordId);
      if (!DISCORD_ID_RE.test(did)) return err(reply, 400, 'bad discord id');
      const [s] = await testerStats(did);
      if (!s) return err(reply, 404, 'no such tester');
      const recentRuns = await q('SELECT * FROM runs WHERE discord_id = ? ORDER BY started_at DESC LIMIT 50', [did]);
      const reported = await q('SELECT * FROM issues WHERE reporter_discord_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 50', [did]);
      return { tester: s, recentRuns: recentRuns.map(runView), reported: reported.map(issueSummary) };
    });

    api.setNotFoundHandler((req, reply) => err(reply, 404, 'no such API route'));
  }, { prefix: `${base}/api` });
}
