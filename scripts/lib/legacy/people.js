// Part 6: tester-activity.json + tester-of-month.json -> tester_stats (read-only history, one row per Discord id).
// Part 7: every Discord id seen anywhere -> users (legacy=1, role tester), Mods inferred from Mod-only actions -> dev.
import { isId, mapStatus } from './util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

export async function importStats(ctx) {
  const r = ctx.part('stats');
  const a = ctx.src.activity ?? {};
  const per = new Map();
  const get = (id) => { if (!per.has(id)) per.set(id, { source: 'tester-activity.json', seen: null, days: {}, testerOfMonth: [] }); return per.get(id); };
  for (const [id, at] of Object.entries(a.seen ?? {})) if (isId(id)) get(id).seen = at;
  for (const [month, users] of Object.entries(a.days ?? {})) {
    for (const [id, days] of Object.entries(users ?? {})) if (isId(id)) get(id).days[month] = days;
  }
  const tom = ctx.src.tom;
  if (tom?.winnerId && isId(tom.winnerId)) get(tom.winnerId).testerOfMonth.push({ month: tom.lastMonth ?? null, score: tom.score ?? null, at: tom.at ?? null });
  for (const [id, d] of per) {
    d.activeDays = Object.values(d.days).reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0);
    await ctx.w.exec(`INSERT INTO tester_stats (discord_id, data, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`,
      [id, json(d), d.seen ?? ctx.startedAt]);
    ctx.ids.add(id, 'tester-activity');
    r.count('testers');
  }
  const { seen, days, ...rest } = a;
  await ctx.w.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    ['legacy_tester_activity', json({ ...rest, testerOfMonth: tom ?? null, importedAt: ctx.startedAt })]);
}

// Mod-only actions in the old bot (modules/bugs/machine.js panelButtons + planner/testtriage/testprompt): any human status change
// except Works/Not fixed on awaiting_test (anyone) and the reporter's own Fixed; mod override; retest start; prompt abort/run.
export function inferMods(src) {
  const mods = new Map();
  const add = (id, why) => { if (!isId(String(id ?? ''))) return; if (!mods.has(id)) mods.set(id, new Set()); mods.get(id).add(why); };
  for (const [tid, p] of Object.entries(src.posts ?? {})) {
    let prev = 'open';
    for (const h of p.history ?? []) {
      const to = mapStatus(h.status) ?? h.status;
      if (h.by) {
        // Not mod-only: anything → open / needs_manual_review (Not fixed; older bot versions let testers reopen), Works on
        // awaiting_test, and the reporter's own Fixed.
        const testerOk = to === 'open' || to === 'needs_manual_review' || (to === 'fixed' && (prev === 'awaiting_test' || h.by === p.reporterId));
        if (!testerOk) add(h.by, `set ${prev}→${to} on ${tid}`);
      }
      prev = to;
    }
    if (p.modOverride?.by) add(p.modOverride.by, `mod override on ${tid}`);
  }
  for (const [tid, rec] of Object.entries(src.triage?.items ?? {})) {
    if (rec.retest?.byId) add(rec.retest.byId, `started retest of ${tid}`);
  }
  for (const [mid, p] of Object.entries(src.prompts ?? {})) {
    if (p.aborted?.by) add(p.aborted.by, `closed test prompt ${mid}`);
    if (p.run?.by) add(p.run.by, `ran test prompt ${mid} (admin)`);
  }
  return mods;
}

// Every id with where it was seen; names from the shared registry (freshest wins).
export function collectIds(src, ids) {
  for (const [tid, p] of Object.entries(src.posts ?? {})) {
    ids.add(p.reporterId, 'reporter', p.createdAt);
    ids.add(p.statusBy, 'statusBy');
    for (const h of p.history ?? []) ids.add(h.by, 'statusBy', h.at);
    for (const x of p.triaged ?? []) ids.add(x, 'triage');
    for (const x of p.testedBy ?? []) ids.add(x, 'tester');
    for (const n of p.notFixedNotes ?? []) ids.add(n.by, 'tester', n.at);
    for (const t of p.triageLog ?? []) ids.add(t.by, 'statusBy', t.at);
    ids.add(p.modOverride?.by, 'mod');
    for (const i of p.plan?.info ?? []) ids.add(i.by, 'planner');
    void tid;
  }
  for (const rec of Object.values(src.triage?.items ?? {})) {
    for (const w of [...(rec.works ?? []), ...(rec.worksHistory ?? []), ...(rec.feedback ?? [])]) ids.add(w.id, 'tester', w.at);
    ids.add(rec.retest?.byId, 'mod');
  }
  for (const rec of Object.values(src.checklist?.items ?? {})) {
    for (const w of [...(rec.works ?? []), ...(rec.worksHistory ?? []), ...(rec.bugs ?? []), ...(rec.suggestions ?? [])]) ids.add(w.userId, 'tester', w.at);
  }
  for (const p of Object.values(src.prompts ?? {})) {
    ids.add(p.approved?.by, 'prompt');
    ids.add(p.aborted?.by, 'prompt');
    ids.add(p.run?.by, 'prompt');
    for (const c of p.changes ?? []) ids.add(c.by, 'prompt', c.at);
  }
  for (const id of Object.keys(src.activity?.seen ?? {})) ids.add(id, 'tester-activity');
  ids.add(src.tom?.winnerId, 'tester-of-month');
}

// Names recorded in the JSON sources (with their time), lower priority than Discord's current names (fetch time).
export function collectNames(src, names) {
  for (const rec of Object.values(src.triage?.items ?? {})) {
    for (const w of [...(rec.works ?? []), ...(rec.worksHistory ?? []), ...(rec.feedback ?? [])]) names.set(w.id, w.name, w.at);
    if (rec.retest?.byId) names.set(rec.retest.byId, rec.retest.by, rec.retest.since);
  }
  for (const rec of Object.values(src.checklist?.items ?? {})) {
    for (const w of [...(rec.works ?? []), ...(rec.worksHistory ?? []), ...(rec.bugs ?? []), ...(rec.suggestions ?? [])]) {
      // names here are clipped to 24 chars by the bot ("…"): use them only when nothing better exists
      names.set(w.userId, w.name, /…$/.test(w.name ?? '') ? 1 : w.at);
    }
  }
  for (const p of Object.values(src.prompts ?? {})) {
    for (const x of [p.approved, p.aborted, ...(p.changes ?? [])]) if (x?.by) names.set(x.by, x.byName, x.at);
    if (p.run?.by && p.run.byName) names.set(p.run.by, p.run.byName, p.run.at);
  }
  for (const p of Object.values(src.posts ?? {})) for (const i of p.plan?.info ?? []) names.set(i.by, i.byName, i.at);
}

export async function importUsers(ctx) {
  const r = ctx.part('users');
  collectIds(ctx.src, ctx.ids);
  for (const id of ctx.seenAuthors) ctx.ids.add(id, 'message author');
  // message authors already in the DB (from earlier runs of the messages part)
  for (const row of await ctx.w.read('SELECT DISTINCT author_discord_id AS id FROM issue_messages WHERE is_bot = 0 AND legacy_message_id IS NOT NULL AND author_discord_id IS NOT NULL')) ctx.ids.add(String(row.id), 'message author');
  for (const row of await ctx.w.read('SELECT DISTINCT author_discord_id AS id, author_name AS name FROM issue_messages WHERE is_bot = 1 AND author_discord_id IS NOT NULL')) ctx.botIds.add(String(row.id));
  const mods = inferMods(ctx.src);
  let list = [...ctx.ids.map.entries()].filter(([id]) => !ctx.botIds.has(id));
  // Ids no source names: ask Discord (GET /users/:id, read-only, cached). Bots found this way are dropped.
  if (ctx.discord) {
    for (const [id] of list.filter(([x]) => !ctx.names.get(x))) {
      try {
        const u = await ctx.discord.user(id);
        if (u.data?.bot) ctx.botIds.add(id);
        else if (u.data) { ctx.names.set(id, u.data.global_name || u.data.username, u.fetchedAt ?? 0); r.count('namesFromDiscordUser'); }
      } catch (error) { r.fail(id, `user lookup: ${error.message}`); }
    }
    list = list.filter(([id]) => !ctx.botIds.has(id));
  }
  const unnamed = [];
  for (const [id, info] of list) {
    const name = ctx.names.get(id);
    if (!name) unnamed.push(id);
    const role = mods.has(id) ? 'dev' : 'tester';
    await ctx.w.exec(`INSERT INTO users (discord_id, name, role, legacy, created_at) VALUES (?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE name = IF(last_login_at IS NULL, COALESCE(VALUES(name), name), name),
        role = IF(legacy = 1 AND last_login_at IS NULL AND role = 'tester' AND VALUES(role) = 'dev', 'dev', role)`,
    [id, name, role, info.first ?? ctx.startedAt]);
    r.count('users');
    r.count(`role:${role}`);
  }
  if (!ctx.w.dryRun) {
    await ctx.w.exec(`UPDATE issues i JOIN users u ON u.discord_id = i.reporter_discord_id SET i.reporter_name = u.name WHERE i.legacy IS NOT NULL AND u.name IS NOT NULL`);
    await ctx.w.exec(`UPDATE issue_events e JOIN users u ON u.discord_id = e.by_discord_id SET e.by_name = u.name WHERE e.legacy_key IS NOT NULL AND u.name IS NOT NULL`);
    await ctx.w.exec(`UPDATE runs x JOIN users u ON u.discord_id = x.discord_id SET x.name = u.name WHERE x.legacy = 1 AND u.name IS NOT NULL`);
  }
  r.data.mods = [...mods.entries()].filter(([id]) => !ctx.botIds.has(id)).map(([id, why]) => ({ id, name: ctx.names.get(id), evidence: [...why].slice(0, 4), more: Math.max(0, why.size - 4) }));
  r.data.unnamed = unnamed;
  r.data.botsExcluded = [...ctx.botIds];
  if (unnamed.length) r.note(`${unnamed.length} users without any known name (left NULL; filled at first login)`);
}
