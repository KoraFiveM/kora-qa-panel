// Game API (QA-CONTRACTS §5): kora_qa <-> panel under <base>/game. Loopback only (and never via nginx: requests carrying
// X-Forwarded-For / X-Real-IP are refused), Bearer KORA_QA_GAME_SECRET, JSON.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, one, tx, json } from './db.js';
import { isDirectLoopback } from './auth.js';
import { createIssue, addMessage, transition, getIssue, addXpEvents, serverStarted } from './issues.js';
import { saveRegistry, runScan, servedScenarios } from './scenarios/service.js';
import { sniffImage, storeFile } from './files.js';
import { emit } from './events.js';
import { renderReport } from './render-report.js';
import { ISSUE_ID_RE } from './ids.js';

export const MAX_UPLOAD = 8 * 1024 * 1024;
const DISCORD_ID_RE = /^\d{15,25}$/;
const RUN_STATUSES = new Set(['passed', 'failed', 'aborted', 'blocked']);
const STEP_STATUSES = new Set(['pending', 'passed', 'failed', 'skipped', 'unverified', 'blocked']);

const bad = (reply, msg, code = 400) => reply.code(code).send({ ok: false, error: msg });
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

function bearerOk(header, secret) {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  const a = crypto.createHash('sha256').update(m ? m[1] : '').digest();
  const b = crypto.createHash('sha256').update(String(secret ?? '')).digest();
  return crypto.timingSafeEqual(a, b) && Boolean(m) && Boolean(secret);
}

async function userRole(discordId) {
  return (await one('SELECT role, name FROM users WHERE discord_id = ? AND disabled = 0', [discordId])) ?? null;
}

// Pending uploads for a run that has no issue yet (attached when the run's issue is created).
async function takeRunUploads(conn, runId, issueId) {
  const row = await one('SELECT v FROM kv WHERE k = ? FOR UPDATE', [`run_uploads:${runId}`], conn);
  const ids = Array.isArray(row?.v) ? row.v : [];
  if (ids.length) await conn.query(`UPDATE issue_attachments SET issue_id = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND issue_id IS NULL`, [issueId, ...ids]);
  await conn.query('DELETE FROM kv WHERE k = ?', [`run_uploads:${runId}`]);
  return ids.length;
}

export function testKey(run) {
  return run.scenario_hash ? `test:${run.scenario_hash}` : `run:${run.id}`;
}

export function gameRoutes(app) {
  const base = `${config().basePath}/game`;

  app.register(async (g) => {
    g.addHook('onRequest', async (req, reply) => {
      if (!isDirectLoopback(req)) return reply.code(404).send({ ok: false, error: 'not found' });
      if (!bearerOk(req.headers.authorization, config().gameSecret)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    });
    g.addContentTypeParser(['image/webp', 'image/jpeg', 'image/png', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

    g.post('/registry', async (req, reply) => {
      const b = req.body;
      if (!b || typeof b !== 'object' || !Array.isArray(b.steps)) return bad(reply, 'body must be {steps:[StepDef], aliases, caps}');
      const steps = b.steps.filter((s) => s && typeof s.id === 'string' && typeof s.pattern === 'string' && s.id.length <= 100 && s.pattern.length <= 300);
      const aliases = b.aliases && typeof b.aliases === 'object' && !Array.isArray(b.aliases) ? b.aliases : {};
      const caps = b.caps && typeof b.caps === 'object' && !Array.isArray(b.caps) ? b.caps : {};
      await saveRegistry({ steps, aliases, caps });
      runScan().catch((e) => req.log.error(`[scenarios] scan after registry failed: ${e.message}`));
      return { ok: true, steps: steps.length };
    });

    g.get('/scenarios', async () => servedScenarios());

    // Panel role as stored at the user's last panel login (roles are only refreshed from Discord at login; imported legacy
    // users keep their imported role). Unknown ids are not testers until they log into the panel once.
    g.get('/tester', async (req, reply) => {
      const id = String(req.query?.discordId ?? '');
      if (!DISCORD_ID_RE.test(id)) return bad(reply, 'discordId must be a Discord id');
      const u = await one('SELECT role, disabled FROM users WHERE discord_id = ?', [id]);
      if (!u) return { allowed: false, role: null, reason: 'log into the panel once' };
      if (Number(u.disabled)) return { allowed: false, role: null, reason: 'disabled' };
      return { allowed: true, role: u.role };
    });

    g.post('/runs', async (req, reply) => {
      const { scenarioId, scenarioHash, discordId, name, retestIssueId } = req.body ?? {};
      if (typeof scenarioId !== 'string' || !scenarioId || scenarioId.length > 191) return bad(reply, 'scenarioId required');
      if (!DISCORD_ID_RE.test(String(discordId ?? ''))) return bad(reply, 'discordId must be a Discord id');
      const sc = await one('SELECT id, hash, steps, valid, removed FROM scenarios WHERE id = ?', [scenarioId]);
      if (!sc || Number(sc.removed) || !Number(sc.valid)) return bad(reply, 'unknown or invalid scenario', 404);
      if (retestIssueId !== undefined && retestIssueId !== null) {
        if (!ISSUE_ID_RE.test(String(retestIssueId))) return bad(reply, 'retestIssueId must be an issue id');
        const issue = await getIssue(String(retestIssueId));
        if (!issue) return bad(reply, 'retest issue not found', 404);
        if (issue.status !== 'awaiting_test') return bad(reply, `issue is ${issue.status}, not awaiting_test`, 409);
      }
      const at = Date.now();
      const runId = await tx(async (conn) => {
        const [r] = await conn.query('INSERT INTO runs (scenario_id, scenario_hash, discord_id, name, status, started_at, legacy, context) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
          [scenarioId, typeof scenarioHash === 'string' ? scenarioHash.slice(0, 40) : sc.hash, String(discordId), str(name, 100), 'running', at, json(retestIssueId ? { retestIssueId: String(retestIssueId) } : null)]);
        for (const st of sc.steps ?? []) {
          await conn.query('INSERT INTO run_steps (run_id, idx, text, kind, status, detail, at) VALUES (?, ?, ?, ?, ?, NULL, ?)', [r.insertId, st.idx, String(st.text).slice(0, 500), st.kind ?? null, 'pending', at]);
        }
        return r.insertId;
      });
      emit('run', { runId, started: true });
      return { runId };
    });

    g.post('/runs/:id/steps', async (req, reply) => {
      const runId = Number(req.params.id);
      const { idx, status, detail } = req.body ?? {};
      if (!Number.isInteger(idx) || idx < 0 || idx > 500) return bad(reply, 'idx must be a step index');
      if (!STEP_STATUSES.has(status)) return bad(reply, `status must be one of: ${[...STEP_STATUSES].join(', ')}`);
      const run = await one('SELECT id, status FROM runs WHERE id = ?', [runId]);
      if (!run) return bad(reply, 'run not found', 404);
      if (run.status !== 'running') return bad(reply, `run is ${run.status}`, 409);
      const text = (await one('SELECT text FROM run_steps WHERE run_id = ? AND idx = ?', [runId, idx]))?.text ?? `(step ${idx})`;
      const d = detail === undefined ? null : JSON.stringify(detail).length > 20000 ? { truncated: true } : detail;
      await q(`INSERT INTO run_steps (run_id, idx, text, kind, status, detail, at) VALUES (?, ?, ?, NULL, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status), detail = VALUES(detail), at = VALUES(at)`, [runId, idx, text, status, json(d), Date.now()]);
      return { ok: true };
    });

    g.post('/runs/:id/finish', async (req, reply) => {
      const runId = Number(req.params.id);
      const { status, context, note } = req.body ?? {};
      if (!RUN_STATUSES.has(status)) return bad(reply, `status must be one of: ${[...RUN_STATUSES].join(', ')}`);
      if (context !== undefined && context !== null && (typeof context !== 'object' || Array.isArray(context))) return bad(reply, 'context must be a Report object');
      if (context && JSON.stringify(context).length > 2_000_000) return bad(reply, 'context too large', 413);
      const run = await one('SELECT * FROM runs WHERE id = ?', [runId]);
      if (!run) return bad(reply, 'run not found', 404);
      if (run.status !== 'running') return bad(reply, `run is already ${run.status}`, 409);
      const at = Date.now();
      const retestIssueId = run.context?.retestIssueId ?? null;
      const tester = await userRole(run.discord_id);
      const actor = { discordId: run.discord_id, name: run.name ?? tester?.name ?? null, role: tester?.role ?? 'tester' };
      const sc = run.scenario_id ? await one('SELECT id, name, resource, steps FROM scenarios WHERE id = ?', [run.scenario_id]) : null;
      const cleanNote = typeof note === 'string' ? note.slice(0, 2000) : null;
      await q('UPDATE runs SET status = ?, finished_at = ?, context = ?, note = ? WHERE id = ?', [status, at, json(context ? { ...context, ...(retestIssueId ? { retestIssueId } : {}) } : run.context), cleanNote, runId]);

      let issueId = null;
      if (status === 'passed') {
        await tx((conn) => addXpEvents(conn, testKey(run), [{ event: 'test_passed', discordId: run.discord_id }], at));
        emit('xp', {});
      }
      if (retestIssueId && (status === 'passed' || status === 'failed')) {
        issueId = retestIssueId;
        await q('UPDATE runs SET issue_id = ? WHERE id = ?', [issueId, runId]);
        if (status === 'passed') {
          await transition({ issueId, op: 'works', actor, expect: 'awaiting_test', note: cleanNote, detail: `Retest passed in game (run #${runId}).`, data: { runId } });
        } else {
          const failed = context?.steps?.find((s) => s.idx === context?.failedIdx) ?? context?.steps?.find((s) => s.status === 'failed');
          const lines = [`**Retest failed** in game (run #${runId})${failed ? ` at step ${failed.idx + 1}: \`${String(failed.text).slice(0, 300)}\`` : ''}.`];
          if (cleanNote) lines.push(`Tester note: ${cleanNote}`);
          if (context) lines.push('', renderReport({ issue: { title: sc?.name ?? 'Retest' }, report: context, scenario: sc ? { steps: sc.steps } : null }));
          await tx(async (conn) => {
            const msgId = await addMessage({ issueId, discordId: actor.discordId, name: actor.name, content: lines.join('\n').slice(0, 16000), conn, at });
            const ids = (await one('SELECT v FROM kv WHERE k = ?', [`run_uploads:${runId}`], conn))?.v ?? [];
            if (ids.length) await conn.query(`UPDATE issue_attachments SET issue_id = ?, message_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [issueId, msgId, ...ids]);
            await conn.query('DELETE FROM kv WHERE k = ?', [`run_uploads:${runId}`]);
          });
          await transition({ issueId, op: 'not_fixed', actor, expect: 'awaiting_test', note: cleanNote, detail: failed ? `Failing step: ${String(failed.text).slice(0, 300)}` : '', data: { runId, failedIdx: context?.failedIdx ?? null } });
        }
      } else if (status === 'failed' && context) {
        const failedIdx = Number.isInteger(context.failedIdx) ? context.failedIdx : null;
        const failed = context.steps?.find((s) => s.idx === failedIdx);
        const title = `${sc?.name ?? 'Scenario'}${failed ? ` — failed: ${failed.text}` : ' — failed'}`.slice(0, 200);
        const issue = await tx(async (conn) => {
          const row = await createIssue({ source: 'scenario', title, reporterDiscordId: run.discord_id, reporterName: actor.name, scenarioId: run.scenario_id, runId, failedStep: failedIdx, report: { ...context, ...(cleanNote && !context.note ? { note: cleanNote } : {}) }, conn, at });
          await conn.query('UPDATE runs SET issue_id = ? WHERE id = ?', [row.id, runId]);
          await takeRunUploads(conn, runId, row.id);
          await addXpEvents(conn, row.id, [{ event: 'test_failed_report', discordId: run.discord_id }], at);
          return row;
        });
        issueId = String(issue.id);
        emit('xp', {});
      }
      emit('run', { runId, status });
      return issueId ? { ok: true, issueId, url: `${config().publicUrl}/issues/${issueId}` } : { ok: true };
    });

    g.post('/issues', async (req, reply) => {
      const { discordId, name, title, note, frequency, kind, report } = req.body ?? {};
      if (!DISCORD_ID_RE.test(String(discordId ?? ''))) return bad(reply, 'discordId must be a Discord id');
      const t = typeof title === 'string' ? title.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (!t || t.length > 200) return bad(reply, 'title must be 1 to 200 characters');
      if (typeof note !== 'string' || !note.trim() || note.length > 4000) return bad(reply, 'note must be 1 to 4000 characters');
      if (frequency !== undefined && !['always', 'sometimes', 'once'].includes(frequency)) return bad(reply, 'frequency must be always, sometimes or once');
      if (kind !== undefined && kind !== 'bug' && kind !== 'suggestion') return bad(reply, "kind must be 'bug' or 'suggestion'");
      if (report !== undefined && report !== null && (typeof report !== 'object' || Array.isArray(report))) return bad(reply, 'report must be a Report object');
      if (report && JSON.stringify(report).length > 2_000_000) return bad(reply, 'report too large', 413);
      const r = { v: 1, scenario: null, failedIdx: null, steps: [], ...(report ?? {}), note: note.trim(), frequency: frequency ?? report?.frequency ?? null };
      const issue = await createIssue({ source: 'freeform', title: t, kind: kind ?? 'bug', reporterDiscordId: String(discordId), reporterName: str(name, 100), report: r });
      return { issueId: String(issue.id), url: `${config().publicUrl}/issues/${issue.id}` };
    });

    g.post('/uploads', async (req, reply) => {
      const issueId = req.query?.issueId ? String(req.query.issueId) : null;
      const runId = req.query?.runId ? Number(req.query.runId) : null;
      if (!issueId && !runId) return bad(reply, 'give issueId or runId');
      if (issueId && !ISSUE_ID_RE.test(issueId)) return bad(reply, 'issueId must be an issue id');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return bad(reply, 'body must be the raw image');
      const mime = sniffImage(buf);
      if (!mime) return bad(reply, 'body must be a webp, jpeg or png image', 415);
      if (issueId && !(await getIssue(issueId))) return bad(reply, 'issue not found', 404);
      let target = issueId;
      if (!target && runId) {
        const run = await one('SELECT id, issue_id FROM runs WHERE id = ?', [runId]);
        if (!run) return bad(reply, 'run not found', 404);
        target = run.issue_id ? String(run.issue_id) : null;
      }
      const { rel } = storeFile(buf, mime);
      const at = Date.now();
      const attachmentId = await tx(async (conn) => {
        const [r] = await conn.query('INSERT INTO issue_attachments (issue_id, message_id, kind, path, mime, size, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)', [target, 'screenshot', rel, mime, buf.length, at]);
        if (target) await conn.query('UPDATE issues SET updated_at = ? WHERE id = ?', [at, target]);
        else {
          const row = await one('SELECT v FROM kv WHERE k = ? FOR UPDATE', [`run_uploads:${runId}`], conn);
          await conn.query('INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [`run_uploads:${runId}`, json([...(row?.v ?? []), r.insertId])]);
        }
        return r.insertId;
      });
      if (target) emit('issue', { issueId: target });
      return { attachmentId: Number(attachmentId) };
    });

    // "My runs" in game (S2 falls back to a local history on 404).
    g.get('/runs', async (req, reply) => {
      const id = String(req.query?.discordId ?? '');
      if (!DISCORD_ID_RE.test(id)) return bad(reply, 'discordId must be a Discord id');
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 30));
      const rows = await q(`SELECT r.id, r.scenario_id, r.status, r.issue_id, r.started_at, r.finished_at, s.name AS scenario_name
        FROM runs r LEFT JOIN scenarios s ON s.id = r.scenario_id WHERE r.discord_id = ? ORDER BY r.started_at DESC, r.id DESC LIMIT ?`, [id, limit]);
      return {
        runs: rows.map((r) => ({
          runId: Number(r.id), name: r.scenario_name ?? r.scenario_id ?? '(scenario)', scenarioId: r.scenario_id, status: r.status,
          ...(r.issue_id ? { issueId: String(r.issue_id) } : {}), at: Number(r.finished_at ?? r.started_at),
        })),
      };
    });

    g.get('/retests', async (req, reply) => {
      const id = req.query?.discordId ? String(req.query.discordId) : null;
      if (id && !DISCORD_ID_RE.test(id)) return bad(reply, 'discordId must be a Discord id');
      const rows = await q("SELECT id, title, scenario_id, not_fixed_count FROM issues WHERE status = 'awaiting_test' AND deleted = 0 ORDER BY status_at");
      return { retests: rows.map((r) => ({ issueId: String(r.id), title: r.title, scenarioId: r.scenario_id ?? null, notFixedCount: Number(r.not_fixed_count) || 0 })) };
    });

    g.post('/server-started', async () => {
      const { moved, held } = await serverStarted();
      return { moved, held };
    });
  }, { prefix: base });
}
