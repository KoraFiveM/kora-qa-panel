// What the fixer sees: GET /bugs and GET /bug/:id bodies (QA-CONTRACTS §4). Shared by the hook and the panel's
// "prompt preview", so the preview is byte-for-byte what the fixer gets.
import { q, one } from './db.js';
import { config } from './config.js';
import { CLOSED, normStatus } from './machine.js';
import { fileUrl } from './files.js';
import { renderReport } from './render-report.js';

export const MAX_MESSAGES = 50;
export const MAX_CONTENT = 4000;
export const MAX_REPORT_CONTENT = 16000;
export const ACTIVE_WINDOW = 7 * 24 * 3600 * 1000;

const iso = (ms) => new Date(Number(ms) || Date.now()).toISOString();

export async function listBugs({ statuses = null, active = false, now = Date.now() } = {}) {
  const rows = await q('SELECT id, title, status, kind, not_fixed_count, updated_at, status_at, created_at FROM issues WHERE deleted = 0 ORDER BY created_at, id');
  return rows
    .map((r) => ({ r, status: normStatus(r.status) || 'open' }))
    .filter(({ r, status }) => !active || !(CLOSED.has(status) && Number(r.status_at ?? r.updated_at ?? 0) < now - ACTIVE_WINDOW))
    .filter(({ status }) => !statuses || statuses.has(status))
    .map(({ r, status }) => ({
      threadId: String(r.id),
      title: r.title ?? null,
      status,
      updatedAt: iso(r.updated_at ?? r.status_at ?? r.created_at),
      notFixedCount: Number(r.not_fixed_count) || 0,
      kind: r.kind === 'suggestion' ? 'suggestion' : 'bug',
    }));
}

const attUrl = (a) => (a.path ? fileUrl(a.id) : a.original_url);

// null when the issue does not exist (or is deleted).
export async function bugView(id) {
  const issue = await one('SELECT * FROM issues WHERE id = ? AND deleted = 0', [id]);
  if (!issue) return null;
  const rows = await q('SELECT id, author_name, author_discord_id, is_bot, content, created_at FROM issue_messages WHERE issue_id = ? ORDER BY created_at, id', [id]);
  const atts = await q('SELECT id, message_id, path, original_url FROM issue_attachments WHERE issue_id = ? ORDER BY id', [id]);
  const byMsg = new Map();
  const loose = [];
  for (const a of atts) {
    const url = attUrl(a);
    if (!url) continue;
    if (a.message_id === null || a.message_id === undefined) loose.push(url);
    else { const k = String(a.message_id); if (!byMsg.has(k)) byMsg.set(k, []); byMsg.get(k).push(url); }
  }
  let msgs = rows.map((m) => ({
    author: m.author_name ?? 'unknown',
    isBot: Boolean(m.is_bot),
    createdAt: iso(m.created_at),
    content: String(m.content ?? '').slice(0, MAX_CONTENT),
    attachments: byMsg.get(String(m.id)) ?? [],
  }));
  if (issue.report) {
    const scenario = issue.scenario_id ? (await one('SELECT steps FROM scenarios WHERE id = ?', [issue.scenario_id]))?.steps : null;
    const content = renderReport({ issue, report: issue.report, scenario: scenario ? { steps: scenario } : null }).slice(0, MAX_REPORT_CONTENT);
    msgs.unshift({ author: issue.reporter_name ?? 'unknown', isBot: false, createdAt: iso(issue.created_at), content, attachments: loose });
  } else if (loose.length && msgs.length) {
    msgs[0].attachments = [...msgs[0].attachments, ...loose];
  }
  if (msgs.length > MAX_MESSAGES) {
    const [first, ...rest] = msgs;
    msgs = [first, ...rest.slice(-(MAX_MESSAGES - 1))];
  }
  const out = {
    threadId: String(issue.id),
    title: issue.title ?? null,
    status: normStatus(issue.status),
    url: `${config().publicUrl}/issues/${issue.id}`,
    messages: msgs,
  };
  if (issue.mod_override) {
    const m = issue.mod_override;
    out.modOverride = typeof m === 'object' ? { reason: m.reason ?? null, by: m.by ?? null, at: m.at ? iso(m.at) : null } : { reason: String(m), by: null, at: null };
  }
  return out;
}
