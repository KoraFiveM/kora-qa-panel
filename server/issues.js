// Issues: create, comment, and transition() — the only way an issue's status changes. Each transition writes the
// status, one issue_events row, a bot notice message and its XP outbox rows in ONE transaction (QA-CONTRACTS §3, §7).
import { tx, q, one, json } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { snowflake } from './ids.js';
import { emit } from './events.js';
import { config } from './config.js';
import { NOTES, canSet, decide, isClosed, normStatus, notFixedEscalationNote, statusName, xpFor } from './machine.js';

export const BOT_NAME = 'Kora QA';
export const PLAYER_SOURCES = new Set(['scenario', 'freeform', 'retest']);

const now = () => Date.now();

export async function getIssue(id, conn = null, { lock = false } = {}) {
  return one(`SELECT * FROM issues WHERE id = ? AND deleted = 0${lock ? ' FOR UPDATE' : ''}`, [id], conn);
}

async function insertXp(conn, issueId, events, at) {
  const written = [];
  for (const e of events) {
    const [r] = await conn.query('INSERT IGNORE INTO xp_outbox (discord_id, event, issue_id, at) VALUES (?, ?, ?, ?)', [e.discordId, e.event, String(issueId), at]);
    if (r.affectedRows) written.push(e);
  }
  return written;
}

export async function addXpEvents(conn, issueId, events, at = now()) {
  const written = await insertXp(conn, issueId, events, at);
  if (written.length) {
    await conn.query('INSERT INTO issue_events (issue_id, at, type, note, data) VALUES (?, ?, ?, ?, ?)',
      [String(issueId).slice(0, 25), at, 'xp', written.map((e) => `${e.event} → ${e.discordId}`).join(', '), json({ events: written })]);
  }
  return written;
}

function changedLine({ actor, system, auto }) {
  if (system) return `_Changed automatically${auto ? ` (${auto})` : ''}._`;
  return actor?.name ? `_Changed by ${actor.name}._` : '_Changed on the panel._';
}

// Options:
//   issueId; op: target status | 'not_fixed' | 'works'; actor: { discordId, name, role } (null for system)
//   system: hook/fixer/server (no permission check, no triage XP, Not fixed never counted)
//   enforce: check canSet(actor.role); expect: compare-and-set on the current status; allowSame: re-apply the same status
//   note: free text on the event; detail: extra lines for the bot notice; data: extra JSON on the event
//   mutate(conn, issue, step): extra updates inside the same transaction; auto: wording for a system change
//   override: Mod override reason (only with op 'open'): stored in mod_override and posted as a "Mod override:" bot line
// Returns { ok:true, from, to, issue, xp } or { ok:false, code:'notfound'|'expect'|'same'|'denied', error, current }.
export async function transition(opts) {
  const { issueId, op, actor = null, system = false, enforce = false, expect, allowSame = false, note = null, detail = '', data = null, mutate = null, auto = '' } = opts;
  const override = opts.override ? String(opts.override).replace(/\s+/g, ' ').trim().slice(0, 500) : null;
  const at = now();
  const result = await tx(async (conn) => {
    const issue = await getIssue(issueId, conn, { lock: true });
    if (!issue) return { ok: false, code: 'notfound', error: 'issue not found' };
    const from = normStatus(issue.status);
    if (expect !== undefined && expect !== null && normStatus(expect) !== from) {
      return { ok: false, code: 'expect', current: from, error: `status changed: expected ${normStatus(expect)}, is ${from}` };
    }
    if (enforce && !system && !canSet({ role: actor?.role, op, from })) {
      return { ok: false, code: 'denied', current: from, error: `your role (${actor?.role ?? 'none'}) cannot do ${op} on an issue that is ${statusName(from)}` };
    }
    const step = decide({ from, op, notFixedCount: issue.not_fixed_count, manualReviewAfter: system ? 0 : config().manualReviewAfter });
    if (step.error) return { ok: false, code: 'denied', current: from, error: step.error };
    if (system && (op === 'not_fixed')) step.notFixedCount = undefined; // the fixer never counts as a tester
    if (!allowSame && step.to === from) return { ok: false, code: 'same', current: from, error: `post is already marked ${statusName(from)}` };

    const xp = xpFor({ from, to: step.to, reporterId: issue.reporter_discord_id, actorId: actor?.discordId ?? null, actorRole: actor?.role ?? null, system, testing: step.testing, fixedPaid: Boolean(issue.fixed_paid) });

    const sets = ['status = ?', 'status_at = ?', 'updated_at = ?'];
    const params = [step.to, at, at];
    if (step.notFixedCount !== undefined) { sets.push('not_fixed_count = ?'); params.push(step.notFixedCount); }
    if (xp.setFixedPaid) sets.push('fixed_paid = 1');
    if (override && step.to === 'open') { sets.push('mod_override = ?'); params.push(json({ reason: override, by: actor?.name ?? null, byDiscordId: actor?.discordId ?? null, at })); }
    else if (issue.mod_override && (step.to === 'fixed_awaiting_restart' || isClosed(step.to))) sets.push('mod_override = NULL');
    await conn.query(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, [...params, issue.id]);

    const evData = { op, system, ...(step.notFixedCount !== undefined ? { notFixedCount: step.notFixedCount } : {}), ...(data ?? {}) };
    await conn.query('INSERT INTO issue_events (issue_id, at, by_discord_id, by_name, type, from_status, to_status, note, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [issue.id, at, system ? null : (actor?.discordId ?? null), system ? (actor?.name ?? null) : (actor?.name ?? null), 'status', from, step.to, note, json(evData)]);

    const base = step.escalated ? notFixedEscalationNote(step.notFixedCount) : NOTES[step.to];
    const lines = [base];
    if (op === 'not_fixed' && !step.escalated) lines[0] = `Marked **Not fixed** (${step.notFixedCount}×). This report is **opened** again.`;
    if (op === 'works') lines[0] = 'A tester confirmed the fix **works**. This bug is **fixed**.';
    // bugfix.sh reads the latest bot line starting "Mod override:" (communitybot's wording).
    if (override && step.to === 'open') lines.push(`Mod override: try a fix — ${override}`);
    if (detail) lines.push(detail);
    lines.push(changedLine({ actor, system, auto }));
    await conn.query('INSERT INTO issue_messages (issue_id, author_discord_id, author_name, is_bot, content, created_at) VALUES (?, NULL, ?, 1, ?, ?)', [issue.id, BOT_NAME, lines.join('\n'), at]);

    if (mutate) await mutate(conn, issue, step);
    const written = await addXpEvents(conn, issue.id, xp.events, at);
    const updated = await getIssue(issue.id, conn);
    return { ok: true, from, to: step.to, issue: updated, xp: written };
  });
  if (result.ok) {
    emit('status', { issueId: String(issueId), from: result.from, to: result.to, op, system, actor });
    if (result.xp.length) emit('xp', {});
  }
  return result;
}

// New issue. Returns the row. message: optional first comment (freeform note goes in the report instead).
export async function createIssue({ source, title, kind = 'bug', reporterDiscordId = null, reporterName = null, scenarioId = null, runId = null, failedStep = null, report = null, legacy = null, status = 'open', id = null, conn = null, at = now() }) {
  const issueId = id ?? snowflake(at);
  let xpWritten = [];
  const work = async (c) => {
    await c.query(`INSERT INTO issues (id, title, kind, status, source, reporter_discord_id, reporter_name, scenario_id, run_id, failed_step, report, legacy, created_at, updated_at, status_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueId, String(title ?? 'Untitled').slice(0, 200), kind === 'suggestion' ? 'suggestion' : 'bug', status, source, reporterDiscordId, reporterName ? String(reporterName).slice(0, 100) : null, scenarioId, runId, failedStep, json(report), json(legacy), at, at, at]);
    await c.query('INSERT INTO issue_events (issue_id, at, by_discord_id, by_name, type, from_status, to_status, note, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [issueId, at, reporterDiscordId, reporterName, 'status', null, status, 'created', json({ source })]);
    // A player's report (scenario failure / freeform / retest) pays the reporter's bug-post XP; imported issues never do.
    if (reporterDiscordId && PLAYER_SOURCES.has(source) && !legacy) xpWritten = await addXpEvents(c, issueId, [{ event: 'bug_posted', discordId: reporterDiscordId }], at);
    return getIssue(issueId, c);
  };
  const row = conn ? await work(conn) : await tx(work);
  emit('issue', { issueId, created: true });
  if (xpWritten.length) emit('xp', {});
  return row;
}

export async function addMessage({ issueId, discordId = null, name = null, content, isBot = false, conn = null, at = now() }) {
  const work = async (c) => {
    const [r] = await c.query('INSERT INTO issue_messages (issue_id, author_discord_id, author_name, is_bot, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [issueId, discordId, name ? String(name).slice(0, 100) : null, isBot ? 1 : 0, content, at]);
    await c.query('UPDATE issues SET updated_at = ? WHERE id = ?', [at, issueId]);
    await c.query('INSERT INTO issue_events (issue_id, at, by_discord_id, by_name, type, note, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [issueId, at, discordId, name, 'comment', String(content).slice(0, 200), json({ messageId: r.insertId })]);
    return r.insertId;
  };
  const id = conn ? await work(conn) : await tx(work);
  emit('issue', { issueId });
  return id;
}

// A fix claude-bugfix saved as a patch (FIX_ROOT/fixes/<id>/ with a top-level meta.json or *.patch) is only live once
// apply-fix.sh --apply wrote applied.json (it is moved into history/ with the patch when a new fix replaces it, so a top-level
// applied.json always belongs to the current patch). No saved patch (fixed by hand) = not held back. Port of communitybot
// fivemrestart.js patchPending. An unreadable fix folder holds the issue back (safer than sending an unapplied fix to testers).
export function patchPending(issueId, fixRoot = config().fixRoot) {
  const dir = path.join(fixRoot, 'fixes', String(issueId));
  let top;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
  if (!top.some((e) => e.isFile() && (e.name === 'meta.json' || e.name.endsWith('.patch')))) return false;
  try {
    const appliedAt = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8'))?.appliedAt);
    return !Number.isFinite(appliedAt);
  } catch {
    return true;
  }
}

// Server started: fixed_awaiting_restart -> awaiting_test for every issue whose fix is live (see patchPending).
export async function serverStarted({ isPending = patchPending } = {}) {
  const rows = await q("SELECT id FROM issues WHERE status = 'fixed_awaiting_restart' AND deleted = 0 ORDER BY status_at, id");
  let moved = 0;
  const held = [];
  for (const r of rows) {
    if (isPending(r.id)) { held.push(String(r.id)); continue; }
    const out = await transition({ issueId: r.id, op: 'awaiting_test', system: true, auto: 'the server restarted with the fix', expect: 'fixed_awaiting_restart', actor: { name: 'server' } });
    if (out.ok) moved++;
  }
  return { moved, held };
}
