// Part 1: bug-tracker.json posts -> issues (+ status history, Not fixed notes, triage log, override, attempts -> issue_events),
// meta.deletedPosts -> issues deleted=1 (metadata only). Written directly (never through transition()): no xp_outbox rows,
// no bug_posted, no bot messages. Upserts keyed by thread id / event legacy_key.
import { clip, idTime, isId, mapStatus } from './util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

async function upsertEvent(ctx, conn, e) {
  return ctx.w.exec(`INSERT INTO issue_events (issue_id, at, by_discord_id, by_name, type, from_status, to_status, note, data, legacy_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE at = VALUES(at), by_discord_id = VALUES(by_discord_id), by_name = COALESCE(VALUES(by_name), by_name), type = VALUES(type),
      from_status = VALUES(from_status), to_status = VALUES(to_status), note = VALUES(note), data = VALUES(data)`,
  [e.issueId, e.at ?? null, e.by ?? null, e.by ? ctx.names.get(e.by) : null, e.type, e.from ?? null, e.to ?? null, e.note ?? null, json(e.data), e.key], conn);
}

// The events an imported post produces, in order. Pure (exported for tests).
export function postEvents(id, p, { unknown = () => {} } = {}) {
  const ev = [];
  const created = p.createdAt ?? idTime(id);
  ev.push({ key: `imp:${id}:posted`, type: 'import', at: created, by: p.reporterId ?? null, to: 'open', note: 'Posted on Discord', data: { threadId: id, controlId: p.controlId ?? null, source: p.source ?? null } });
  let prev = 'open';
  (p.history ?? []).forEach((h, i) => {
    const to = mapStatus(h.status);
    if (!to) unknown(h.status);
    const t = to ?? 'open';
    ev.push({ key: `st:${id}:${i}`, type: 'status', at: h.at ?? null, by: h.by ?? null, from: prev, to: t, data: { legacy: true, ...(h.status !== t ? { raw: h.status } : {}) } });
    prev = t;
  });
  const final = mapStatus(p.status) ?? 'open';
  if (!(p.history ?? []).length && final !== 'open') {
    ev.push({ key: `st:${id}:final`, type: 'status', at: p.statusAt ?? created, by: p.statusBy ?? null, from: 'open', to: final, data: { legacy: true, synthesized: true } });
  }
  (p.notFixedNotes ?? []).forEach((n, i) => ev.push({ key: `nfn:${id}:${i}`, type: 'comment', at: n.at ?? null, by: n.by ?? null, note: n.text ?? null, data: { legacy: true, notFixedNote: true } }));
  (p.triageLog ?? []).forEach((t, i) => ev.push({ key: `tl:${id}:${i}`, type: 'meta', at: t.at ?? null, by: t.by ?? null, note: (t.changes ?? []).join('; ') || null, data: { legacy: true, triageLog: t } }));
  if (p.modOverride) ev.push({ key: `mo:${id}`, type: 'meta', at: p.modOverride.at ?? null, by: p.modOverride.by ?? null, note: `Mod override: try a fix — ${p.modOverride.reason ?? ''}`.trim(), data: { legacy: true, modOverride: p.modOverride } });
  if (p.lastAttempt) ev.push({ key: `la:${id}`, type: 'fix', at: p.lastAttempt.at ?? null, note: p.lastAttempt.summary ?? null, data: { legacy: true, lastAttempt: p.lastAttempt } });
  if (p.autoApply) ev.push({ key: `aa:${id}`, type: 'fix', at: p.autoApply.at ?? null, note: `Auto-apply ${p.autoApply.ok ? 'ok' : 'failed'} (${p.autoApply.patchId ?? '?'})`, data: { legacy: true, autoApply: p.autoApply } });
  return ev;
}

export async function importIssues(ctx) {
  const r = ctx.part('issues');
  const { posts, deleted } = ctx.src;
  const unknownStatus = new Set();
  let n = 0;
  const existing = new Map((await ctx.w.read('SELECT id, legacy IS NULL AS native FROM issues')).map((x) => [String(x.id), Boolean(x.native)]));

  for (const [id, p] of Object.entries(posts)) {
    if (!isId(id)) { r.fail(id, 'thread id is not a 15-25 digit id'); continue; }
    if (existing.get(id) === true) { r.fail(id, 'an issue with this id was created on the panel; not overwritten'); continue; }
    const status = mapStatus(p.status);
    if (!status) { unknownStatus.add(p.status); r.fail(id, `unknown status ${p.status}, imported as open`); }
    const created = p.createdAt ?? idTime(id);
    const statusAt = p.statusAt ?? created;
    const kind = p.kind === 'suggestion' ? 'suggestion' : 'bug';
    const events = postEvents(id, p, { unknown: (s) => unknownStatus.add(s) });
    await ctx.w.tx(async (conn) => {
      await ctx.w.exec(`INSERT INTO issues (id, title, kind, status, source, reporter_discord_id, reporter_name, not_fixed_count, mod_override, legacy,
          fixed_paid, deleted, created_at, updated_at, status_at)
        VALUES (?, ?, ?, ?, 'discord', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON DUPLICATE KEY UPDATE title = VALUES(title), kind = VALUES(kind), status = VALUES(status), reporter_discord_id = VALUES(reporter_discord_id),
          reporter_name = COALESCE(VALUES(reporter_name), reporter_name), not_fixed_count = VALUES(not_fixed_count), mod_override = VALUES(mod_override),
          legacy = JSON_MERGE_PATCH(VALUES(legacy), JSON_OBJECT('thread', JSON_EXTRACT(COALESCE(legacy, '{}'), '$.thread'), 'threadFetch', JSON_EXTRACT(COALESCE(legacy, '{}'), '$.threadFetch'))),
          fixed_paid = VALUES(fixed_paid), deleted = 0, created_at = VALUES(created_at), updated_at = VALUES(updated_at), status_at = VALUES(status_at)`,
      [id, clip(p.title ?? '(untitled)', 200), kind, status ?? 'open', p.reporterId ?? null, ctx.names.get(p.reporterId), Number(p.notFixedCount ?? 0),
        json(p.modOverride ? { reason: p.modOverride.reason ?? null, by: p.modOverride.by ?? null, at: p.modOverride.at ?? null } : null),
        json({ ...p, importedFrom: 'bug-tracker.json' }), p.fixedPaid ? 1 : 0, created, p.updatedAt ?? statusAt, statusAt], conn);
      for (const e of events) await upsertEvent(ctx, conn, { ...e, issueId: id });
      await ctx.w.exec(`INSERT INTO issue_events (issue_id, at, type, note, data, legacy_key) VALUES (?, ?, 'import', ?, ?, ?)
        ON DUPLICATE KEY UPDATE data = JSON_SET(data, '$.lastRunAt', ?)`,
      [id, ctx.startedAt, 'Imported from the Discord bug tracker', json({ by: 'import-legacy', lastRunAt: ctx.startedAt }), `imp:${id}:imported`, ctx.startedAt], conn);
    });
    r.count('issues');
    r.count('events', events.length + 1);
    r.count(`status:${status ?? 'open'}`);
    r.count(`kind:${kind}`);
    if (++n % 50 === 0) ctx.log(`[issues] ${n}/${Object.keys(posts).length}`);
  }

  for (const [id, d] of Object.entries(deleted)) {
    if (!isId(id)) { r.fail(id, 'deleted post id is not a 15-25 digit id'); continue; }
    if (posts[id]) continue;
    if (existing.get(id) === true) { r.fail(id, 'an issue with this id was created on the panel; not overwritten'); continue; }
    const status = mapStatus(d.status) ?? 'open';
    const created = idTime(id);
    await ctx.w.exec(`INSERT INTO issues (id, title, kind, status, source, legacy, deleted, created_at, updated_at, status_at)
      VALUES (?, ?, 'bug', ?, 'discord', ?, 1, ?, ?, ?)
      ON DUPLICATE KEY UPDATE title = VALUES(title), status = VALUES(status), legacy = VALUES(legacy), deleted = 1, updated_at = VALUES(updated_at)`,
    [id, clip(d.title ?? '(deleted)', 200), status, json({ deletedPost: d, importedFrom: 'bug-tracker.json meta.deletedPosts' }), created, d.deletedAt ?? created, d.deletedAt ?? created]);
    await ctx.w.exec(`INSERT INTO issue_events (issue_id, at, type, note, data, legacy_key) VALUES (?, ?, 'import', ?, ?, ?)
      ON DUPLICATE KEY UPDATE note = VALUES(note), data = VALUES(data)`,
    [id, d.deletedAt ?? created, 'Discord post was deleted; imported as metadata only', json({ legacy: true, deletedPost: d }), `imp:${id}:deleted`]);
    r.count('deleted');
  }
  if (unknownStatus.size) r.note(`unknown statuses mapped to open: ${[...unknownStatus].join(', ')}`);
}
