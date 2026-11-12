// Part 2: every message of every imported (not deleted) thread -> issue_messages (oldest first; for forum posts the starter
// message id == thread id), attachments downloaded to FILES/legacy/<threadId>/<attachmentId>-<name> -> issue_attachments.
// Thread metadata goes to issues.legacy.thread; deleted/inaccessible threads to issues.legacy.threadFetch (and the report).
import fs from 'node:fs';
import path from 'node:path';
import { messageText, CONTENT_TYPES } from './discord.js';
import { clip, pool, safeName } from './util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

export const authorName = (a) => clip(a?.global_name || a?.username || null, 100);
export const attachmentRel = (threadId, att) => `legacy/${threadId}/${att.id}-${safeName(att.filename)}`;

export async function importMessages(ctx) {
  const r = ctx.part('messages');
  const ids = Object.keys(ctx.src.posts).filter((id) => !ctx.limitIds || ctx.limitIds.has(id));
  if (!ctx.discord) { r.note('Discord disabled (--no-discord): skipped'); return; }
  let done = 0;
  await pool(ids, ctx.concurrency, async (id) => {
    try {
      await importThread(ctx, r, id);
    } catch (error) {
      r.fail(id, `thread import failed: ${error.message}`);
    }
    if (++done % 25 === 0 || done === ids.length) ctx.log(`[messages] ${done}/${ids.length} threads`);
  });
}

async function importThread(ctx, r, id) {
  const d = ctx.discord;
  const ch = await d.channel(id);
  let msgs = await d.messages(id);
  if (ch.missing || msgs.missing) { r.count('notCached'); return; }
  const fetchErr = msgs.error ?? ch.error ?? null;
  if (fetchErr) {
    r.count('inaccessible');
    r.fail(id, `thread not readable: HTTP ${fetchErr.status}${fetchErr.code ? ` code ${fetchErr.code}` : ''} ${fetchErr.message ?? ''}`.trim());
    await ctx.w.exec(`UPDATE issues SET legacy = JSON_SET(COALESCE(legacy, '{}'), '$.threadFetch', JSON_EXTRACT(?, '$')) WHERE id = ?`, [json({ ...fetchErr, at: msgs.fetchedAt ?? ch.fetchedAt }), id]);
    return;
  }
  const t = ch.data ?? {};
  const thread = { name: t.name ?? null, parentId: t.parent_id ?? null, ownerId: t.owner_id ?? null, archived: t.thread_metadata?.archived ?? null,
    locked: t.thread_metadata?.locked ?? null, archivedAt: t.thread_metadata?.archive_timestamp ?? null, appliedTags: t.applied_tags ?? [],
    messageCount: t.message_count ?? null, fetchedAt: msgs.fetchedAt, guildId: t.guild_id ?? null };
  await ctx.w.exec(`UPDATE issues SET legacy = JSON_REMOVE(JSON_SET(COALESCE(legacy, '{}'), '$.thread', JSON_EXTRACT(?, '$')), '$.threadFetch') WHERE id = ?`, [json(thread), id]);
  // JSON_REMOVE on a missing path is a no-op in MariaDB; keep threadFetch out once the thread reads fine.

  const list = msgs.data ?? [];
  const failedDownloads = [];
  for (const m of list) {
    if (!CONTENT_TYPES.has(m.type)) { r.count('systemSkipped'); continue; }
    const isBot = Boolean(m.author?.bot || m.webhook_id);
    if (!isBot && m.author?.id) ctx.names.set(m.author.id, authorName(m.author), msgs.fetchedAt ?? 0);
    if (!isBot && m.author?.id) ctx.seenAuthors.add(m.author.id);
    if (isBot && m.author?.id) ctx.botIds.add(m.author.id);
    const at = Date.parse(m.timestamp) || null;
    const res = await ctx.w.exec(`INSERT INTO issue_messages (issue_id, author_discord_id, author_name, is_bot, content, created_at, legacy_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), issue_id = VALUES(issue_id), author_discord_id = VALUES(author_discord_id), author_name = VALUES(author_name),
        is_bot = VALUES(is_bot), content = VALUES(content), created_at = VALUES(created_at)`,
    [id, m.author?.id ?? null, authorName(m.author), isBot ? 1 : 0, messageText(m), at, m.id]);
    r.count('messages');
    if (isBot) r.count('botMessages');
    const messageDbId = res.insertId;
    for (const att of m.attachments ?? []) {
      const ok = await importAttachment(ctx, r, id, messageDbId, at, att);
      if (ok !== true) failedDownloads.push({ m, att, messageDbId, at, error: ok });
    }
  }
  // Cached CDN URLs expire: refetch the thread once and retry what failed.
  if (failedDownloads.length && msgs.fromCache && !ctx.dryRun) {
    msgs = await d.messages(id, { force: true });
    const fresh = new Map((msgs.data ?? []).map((m) => [m.id, m]));
    for (const f of failedDownloads) {
      const att = (fresh.get(f.m.id)?.attachments ?? []).find((a) => a.id === f.att.id);
      if (att) await importAttachment(ctx, r, id, f.messageDbId, f.at, att, { last: true });
      else await recordFailedAttachment(ctx, r, id, f.messageDbId, f.at, f.att, 'attachment gone after refetch');
    }
  } else {
    for (const f of failedDownloads) await recordFailedAttachment(ctx, r, id, f.messageDbId, f.at, f.att, f.error ?? 'download failed');
  }
  r.count('threads');
}

async function recordFailedAttachment(ctx, r, threadId, messageDbId, at, att, why) {
  r.fail(threadId, `attachment ${att.id} (${att.filename}): ${why}`);
  r.count('attachmentsFailed');
  await upsertAttachment(ctx, threadId, messageDbId, at, att, null);
}

async function upsertAttachment(ctx, threadId, messageDbId, at, att, rel) {
  const mime = att.content_type ?? null;
  await ctx.w.exec(`INSERT INTO issue_attachments (issue_id, message_id, kind, path, mime, size, original_url, created_at, legacy_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE issue_id = VALUES(issue_id), message_id = VALUES(message_id), kind = VALUES(kind), path = COALESCE(VALUES(path), path),
      mime = VALUES(mime), size = VALUES(size), original_url = VALUES(original_url)`,
  [threadId, messageDbId, /^image\//.test(mime ?? '') ? 'screenshot' : 'file', rel, mime, att.size ?? null, att.url ?? null, at, `att:${att.id}`]);
}

// true = stored (downloaded now or already on disk), else the error text (caller retries / records).
async function importAttachment(ctx, r, threadId, messageDbId, at, att, { last = false } = {}) {
  const rel = attachmentRel(threadId, att);
  const abs = path.join(ctx.filesDir, rel);
  // Downloads land via .part + rename, so an existing file is complete. Its size can differ from att.size (the CDN re-encodes
  // webp), so the row stores the bytes actually on disk.
  let have = 0;
  try { have = fs.statSync(abs).size; } catch { have = 0; }
  if (have && ctx.refresh && !ctx.dryRun) have = 0;
  if (!have) {
    if (ctx.dryRun) { r.count('attachmentsToDownload'); r.count('attachmentBytesToDownload', Number(att.size ?? 0)); await upsertAttachment(ctx, threadId, messageDbId, at, att, rel); return true; }
    try {
      have = (await ctx.discord.download(att.url, abs)).size;
      r.count('attachmentsDownloaded');
    } catch (error) {
      if (last) { await recordFailedAttachment(ctx, r, threadId, messageDbId, at, att, error.message); return true; }
      return error.message || 'download failed';
    }
  } else r.count('attachmentsOnDisk');
  await upsertAttachment(ctx, threadId, messageDbId, at, { ...att, size: have }, rel);
  r.count('attachments');
  return true;
}
