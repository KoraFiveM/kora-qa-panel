// Part 5: legacy tests and their results.
//   assets/test-triage/items.json (game tests, id = item id) + assets/tester-checklist/features.json (id = "<resource>:<featureId>")
//   -> legacy_tests (scenario_id untouched: the conversion session sets it).
//   data/test-triage.json works[] / worksHistory[] -> runs passed, feedback[] -> runs failed (note = the feedback text copied
//   into the test's Discord post, matched by tester + time), data/tester-checklist.json works/worksHistory -> passed,
//   bugs/suggestions -> failed linked to the bug post (issue). All runs legacy=1, scenario_id NULL, keyed by runs.legacy_key.
//   data/test-spots.json -> kv legacy_spots.
import crypto from 'node:crypto';
import { clip, isId, pool } from './util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
export const runKey = (s) => (s.length <= 100 ? s : `${s.slice(0, 59)}:${crypto.createHash('sha1').update(s).digest('hex')}`);
const MATCH_WINDOW = 15 * 60 * 1000;

async function upsertLegacyTest(ctx, t) {
  await ctx.w.exec(`INSERT INTO legacy_tests (id, source, resource, title, description, data) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE source = VALUES(source), resource = VALUES(resource), title = VALUES(title), description = VALUES(description), data = VALUES(data)`,
  [t.id, t.source, t.resource ?? null, clip(t.title, 300), t.description ?? null, json(t.data)]);
}

async function upsertRun(ctx, r) {
  await ctx.w.exec(`INSERT INTO runs (scenario_id, legacy_test_id, discord_id, name, status, started_at, finished_at, legacy, issue_id, context, note, legacy_key)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE legacy_test_id = VALUES(legacy_test_id), discord_id = VALUES(discord_id), name = VALUES(name), status = VALUES(status),
      started_at = VALUES(started_at), finished_at = VALUES(finished_at), legacy = 1, issue_id = VALUES(issue_id), context = VALUES(context), note = COALESCE(VALUES(note), note)`,
  [r.testId, r.discordId ?? null, clip(r.name ?? null, 100), r.status, r.at ?? null, r.at ?? null, r.issueId ?? null, json(r.context), r.note ?? null, runKey(r.key)]);
}

// Feedback copies in a test's Discord post: bot embeds titled "Feedback" with a "From: <@id>" field.
export function feedbackCopies(messages) {
  const out = [];
  for (const m of messages ?? []) {
    for (const e of m.embeds ?? []) {
      if (e.title !== 'Feedback') continue;
      const from = (e.fields ?? []).find((f) => f.name === 'From')?.value ?? '';
      const uid = /<@!?(\d{15,25})>/.exec(from)?.[1];
      if (!uid) continue;
      out.push({ uid, at: Date.parse(m.timestamp) || 0, text: e.description ?? '', inGame: (e.fields ?? []).find((f) => f.name === 'In game')?.value ?? null, messageId: m.id, viaGame: /in-game/.test(from) });
    }
  }
  return out;
}

// Pairs feedback records with their copies: same tester, nearest time within 15 min, each copy used once.
export function matchFeedback(entries, copies) {
  const used = new Set();
  return entries.map((f) => {
    let best = null;
    for (const c of copies) {
      if (used.has(c) || c.uid !== f.id) continue;
      const d = Math.abs(c.at - (f.at ?? 0));
      if (d <= MATCH_WINDOW && (!best || d < best.d)) best = { c, d };
    }
    if (best) used.add(best.c);
    return best?.c ?? null;
  });
}

const linkedIssue = (text, known) => {
  for (const m of String(text ?? '').matchAll(/(?:channels\/\d+\/|<#)(\d{15,25})/g)) if (known.has(m[1])) return m[1];
  return null;
};

export async function importTests(ctx) {
  const r = ctx.part('tests');
  const known = await ctx.knownIssueIds();
  const triage = ctx.src.triage.items ?? {};
  const want = (id) => !ctx.limitIds || ctx.limitIds.has(id);

  // legacy_tests: game tests
  const gameIds = new Set();
  for (const it of ctx.src.triageItems) {
    gameIds.add(it.id);
    if (!want(it.id)) continue;
    const rec = triage[it.id] ?? {};
    await upsertLegacyTest(ctx, { id: it.id, source: 'game', resource: it.group ?? null, title: it.title, description: it.description ?? null,
      data: { ...it, threadId: rec.threadId ?? null, threadName: rec.threadName ?? null, retired: rec.retired ?? false, round: rec.round ?? 0, retest: rec.retest ?? null, fix: rec.fix ?? null, fixHistory: rec.fixHistory ?? [] } });
    r.count('gameTests');
  }
  for (const [tid, rec] of Object.entries(triage)) {
    if (gameIds.has(tid) || !want(tid)) continue;
    const res = /^([^:]+):/.exec(rec.threadName ?? '')?.[1] ?? null;
    await upsertLegacyTest(ctx, { id: tid, source: 'game', resource: res, title: (rec.threadName ?? tid).replace(/^[^:]+:\s*/, ''), description: null,
      data: { id: tid, notInList: true, threadId: rec.threadId ?? null, threadName: rec.threadName ?? null, retired: rec.retired ?? false } });
    r.count('gameTestsNotInList');
  }
  // legacy_tests: checklist features
  const featIds = new Set();
  for (const res of ctx.src.features) {
    for (const f of res.features ?? []) {
      const id = `${res.resource}:${f.id}`;
      featIds.add(id);
      if (!want(id) && !want(res.resource)) continue;
      await upsertLegacyTest(ctx, { id, source: 'checklist', resource: res.resource, title: f.name ?? f.id, description: f.test ?? null,
        data: { featureId: f.id, ...f, resource: res.resource, folder: res.folder ?? null, category: res.category ?? null, resourceDescription: res.description ?? null,
          threadId: ctx.src.checklist.threads?.[res.resource]?.id ?? null } });
      r.count('checklistFeatures');
    }
  }

  // Feedback texts from the test posts (Discord, cached).
  const copiesByTest = new Map();
  if (ctx.discord) {
    const withFb = Object.entries(triage).filter(([tid, rec]) => want(tid) && rec.threadId && isId(rec.threadId) && (rec.feedback ?? []).length);
    const threads = Object.entries(triage).filter(([tid, rec]) => want(tid) && rec.threadId && isId(rec.threadId));
    // Fetch every test post (also feeds prompts + names), but only feedback ones are needed for notes.
    let done = 0;
    await pool(ctx.fetchAllTestThreads ? threads : withFb, ctx.concurrency, async ([tid, rec]) => {
      const msgs = await ctx.discord.messages(rec.threadId);
      if (msgs.error) r.fail(tid, `test post ${rec.threadId} not readable: HTTP ${msgs.error.status}`);
      else if (!msgs.missing) {
        copiesByTest.set(tid, feedbackCopies(msgs.data));
        for (const m of msgs.data ?? []) if (m.author?.id && !m.author.bot && !m.webhook_id) { ctx.names.set(m.author.id, m.author.global_name || m.author.username, msgs.fetchedAt ?? 0); ctx.seenAuthors.add(m.author.id); }
        r.count('testThreadsRead');
      } else r.count('testThreadsNotCached');
      if (++done % 50 === 0) ctx.log(`[tests] ${done} test posts read`);
    });
  } else r.note('Discord disabled: feedback notes not imported');

  // runs: game tests
  for (const [tid, rec] of Object.entries(triage)) {
    if (!want(tid)) continue;
    const base = { source: 'test-triage', threadId: rec.threadId ?? null };
    for (const w of rec.works ?? []) {
      await upsertRun(ctx, { key: `tt:${tid}:w:${w.id}:${w.at}`, testId: tid, discordId: w.id, name: ctx.names.get(w.id) ?? w.name, status: 'passed', at: w.at,
        context: { ...base, round: rec.round ?? 0, via: w.via ?? 'discord', recordedName: w.name } });
      r.count('runsPassed');
    }
    for (const w of rec.worksHistory ?? []) {
      await upsertRun(ctx, { key: `tt:${tid}:wh:${w.round ?? 0}:${w.id}:${w.at}`, testId: tid, discordId: w.id, name: ctx.names.get(w.id) ?? w.name, status: 'passed', at: w.at,
        context: { ...base, round: w.round ?? 0, clearedAt: w.clearedAt ?? null, clearedByRetest: true, via: w.via ?? 'discord', recordedName: w.name } });
      r.count('runsPassedHistory');
    }
    const fb = rec.feedback ?? [];
    const matched = matchFeedback(fb, copiesByTest.get(tid) ?? []);
    for (let i = 0; i < fb.length; i++) {
      const f = fb[i];
      const c = matched[i];
      if (!c && copiesByTest.has(tid)) {
        r.count('feedbackWithoutText');
        r.fail(tid, `feedback by ${f.id} at ${new Date(f.at).toISOString()}: no copy of the text in the test post (run imported without a note)`);
      }
      await upsertRun(ctx, { key: `tt:${tid}:fb:${f.id}:${f.at}`, testId: tid, discordId: f.id, name: ctx.names.get(f.id) ?? f.name, status: 'failed', at: f.at,
        note: c?.text ?? null, issueId: linkedIssue(c?.text, known),
        context: { ...base, round: rec.round ?? 0, via: f.via ?? 'discord', recordedName: f.name, feedbackMessageId: c?.messageId ?? null, inGame: c?.inGame ?? null } });
      r.count('runsFailed');
      if (c) r.count('feedbackWithText');
    }
  }

  // runs: checklist
  for (const [key, rec] of Object.entries(ctx.src.checklist.items ?? {})) {
    const [res, ...rest] = key.split('/');
    const testId = `${res}:${rest.join('/')}`;
    if (!want(testId) && !want(res)) continue;
    if (!featIds.has(testId)) r.count('checklistResultsNotInList');
    const base = { source: 'tester-checklist', retest: rec.retest ?? null };
    for (const w of rec.works ?? []) {
      await upsertRun(ctx, { key: `cl:${testId}:w:${w.userId}:${w.at}`, testId, discordId: w.userId, name: ctx.names.get(w.userId) ?? w.name, status: 'passed', at: w.at, context: { ...base, recordedName: w.name } });
      r.count('runsPassed');
    }
    for (const w of rec.worksHistory ?? []) {
      await upsertRun(ctx, { key: `cl:${testId}:wh:${w.userId}:${w.at}`, testId, discordId: w.userId, name: ctx.names.get(w.userId) ?? w.name, status: 'passed', at: w.at,
        context: { ...base, clearedAt: w.clearedAt ?? null, clearedByRetest: true, reason: w.reason ?? null, postId: w.postId ?? null, recordedName: w.name } });
      r.count('runsPassedHistory');
    }
    for (const [kind, list] of [['bug', rec.bugs ?? []], ['suggestion', rec.suggestions ?? []]]) {
      for (const b of list) {
        const issueId = b.postId && known.has(b.postId) ? b.postId : null;
        if (b.postId && !issueId) r.count('checklistReportsWithoutIssue');
        const { userId, name, at, ...extra } = b;
        await upsertRun(ctx, { key: `cl:${testId}:${kind}:${userId}:${at}`, testId, discordId: userId, name: ctx.names.get(userId) ?? name, status: 'failed', at, issueId,
          note: `${kind === 'bug' ? 'Bug report' : 'Suggestion'}${issueId ? '' : b.postId ? ` (post ${b.postId}, not imported)` : ''}`,
          context: { ...base, kind, recordedName: name, ...extra } });
        r.count(kind === 'bug' ? 'runsFailedBug' : 'runsFailedSuggestion');
      }
    }
  }

  if (ctx.src.spots) {
    await ctx.w.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['legacy_spots', json({ ...ctx.src.spots, importedAt: ctx.startedAt })]);
    r.count('spots', Object.keys(ctx.src.spots.spots ?? {}).length);
    r.count('spotProposals', Object.keys(ctx.src.spots.proposals ?? {}).length);
  }
}
