// Part 4: fix prompts. data/test-prompts.json (prompts posted in #test-discussion threads, i.e. legacy tests, content = the
// .md attachment of that Discord message) and data/planner/<threadId>/ (planner work files per bug thread) -> issue_prompts,
// keyed by legacy_key (tp:<messageId> / pl:<threadId>:<file>).
import fs from 'node:fs';
import path from 'node:path';
import { isId } from './util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const PLANNER_KINDS = { 'BUG.md': 'plan_bug', 'OTHER_BUGS.md': 'plan_other_bugs', 'RESOURCES.md': 'plan_resources' };

async function upsertPrompt(ctx, p) {
  await ctx.w.exec(`INSERT INTO issue_prompts (issue_id, legacy_test_id, kind, content, meta, created_at, legacy_key) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE issue_id = VALUES(issue_id), legacy_test_id = VALUES(legacy_test_id), kind = VALUES(kind),
      content = COALESCE(VALUES(content), content), meta = VALUES(meta), created_at = VALUES(created_at)`,
  [p.issueId ?? null, p.legacyTestId ?? null, p.kind, p.content ?? null, json(p.meta), p.at ?? null, p.key]);
}

// The .md attachment of a prompt message. Cached message lists may carry expired CDN URLs: refetch once on failure.
async function promptContent(ctx, threadId, messageId) {
  const d = ctx.discord;
  if (!d) return { error: 'Discord disabled' };
  let msgs = await d.messages(threadId);
  if (msgs.missing) return { error: 'not cached (dry run)' };
  for (let pass = 0; pass < 2; pass++) {
    if (msgs.error) return { error: `thread not readable: HTTP ${msgs.error.status}` };
    const m = (msgs.data ?? []).find((x) => x.id === messageId);
    if (!m) return { error: 'prompt message not found in thread' };
    const att = (m.attachments ?? []).find((a) => /\.md$/i.test(a.filename ?? '')) ?? (m.attachments ?? [])[0];
    if (!att) return { error: 'prompt message has no attachment', text: m.content ?? null };
    if (ctx.dryRun) return { error: null, text: null, attachment: att.filename };
    try {
      return { text: await d.fetchText(att.url), attachment: att.filename };
    } catch (error) {
      if (pass === 0 && msgs.fromCache) { msgs = await d.messages(threadId, { force: true }); continue; }
      return { error: error.message };
    }
  }
  return { error: 'unreachable' };
}

export async function importPrompts(ctx) {
  const r = ctx.part('prompts');
  const known = await ctx.knownIssueIds();
  const testByThread = new Map(Object.entries(ctx.src.triage.items ?? {}).map(([tid, rec]) => [rec.threadId, tid]));

  for (const [messageId, p] of Object.entries(ctx.src.prompts)) {
    const issueId = known.has(p.threadId) ? p.threadId : null;
    const legacyTestId = testByThread.get(p.threadId) ?? null;
    if (ctx.limitIds && !ctx.limitIds.has(p.threadId) && !ctx.limitIds.has(legacyTestId)) continue;
    if (!issueId && !legacyTestId) r.fail(messageId, `prompt thread ${p.threadId} is neither an issue nor a legacy test thread (kept unlinked)`);
    const stored = ctx.refresh ? null : (await ctx.w.read('SELECT meta FROM issue_prompts WHERE legacy_key = ? AND content IS NOT NULL', [`tp:${messageId}`]))[0];
    const c = stored ? { text: null, attachment: stored.meta?.attachment ?? null, stored: true } : await promptContent(ctx, p.threadId, messageId);
    if (c.error && !ctx.dryRun) r.fail(messageId, `prompt content: ${c.error}`);
    const { file, at, ...rest } = p;
    await upsertPrompt(ctx, { key: `tp:${messageId}`, issueId, legacyTestId, kind: 'test_prompt', content: c.text ?? null, at: at ?? null,
      meta: { source: 'test-prompts.json', messageId, file, attachment: c.attachment ?? null, ...rest, ...(c.error ? { contentError: c.error } : {}) } });
    r.count('testPrompts');
    if (c.text || c.stored) r.count('testPromptsWithContent');
  }

  let dirs = [];
  try { dirs = fs.readdirSync(ctx.src.plannerDir).filter(isId).sort(); } catch { dirs = []; }
  for (const id of dirs) {
    if (ctx.limitIds && !ctx.limitIds.has(id)) continue;
    if (!known.has(id)) { r.fail(id, 'planner folder has no matching issue (skipped)'); r.count('plannerOrphans'); continue; }
    const dir = path.join(ctx.src.plannerDir, id);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const fm = /^fix-prompt-\d+(?:-v(\d+))?\.md$/.exec(f);
      const kind = fm ? 'plan_prompt' : PLANNER_KINDS[f] ?? 'plan_file';
      const short = fm ? `fix-prompt-v${fm[1] ?? 1}` : f.replace(/\.md$/, '');
      const st = fs.statSync(path.join(dir, f));
      await upsertPrompt(ctx, { key: `pl:${id}:${short}`.slice(0, 64), issueId: id, kind, content: fs.readFileSync(path.join(dir, f), 'utf8'), at: Math.round(st.mtimeMs),
        meta: { source: 'planner', file: `data/planner/${id}/${f}`, version: fm ? Number(fm[1] ?? 1) : null, size: st.size } });
      r.count(kind);
    }
  }
}
