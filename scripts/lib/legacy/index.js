// Legacy import orchestrator: runs the parts in order against the panel DB (server/db.js pool), collects counts/failures and
// writes the markdown report. Used by scripts/import-legacy.mjs and test/import.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { createDiscord } from './discord.js';
import { importIssues } from './issues.js';
import { importMessages } from './messages.js';
import { importFixes } from './fixes.js';
import { importPrompts } from './prompts.js';
import { importTests } from './tests.js';
import { importStats, importUsers, collectNames } from './people.js';
import { Names, makeWriter, loadSources, isId, dirSize, fmtBytes } from './util.js';

export const PARTS = ['issues', 'messages', 'fixes', 'prompts', 'tests', 'stats', 'users'];
const RUNNERS = { issues: importIssues, messages: importMessages, fixes: importFixes, prompts: importPrompts, tests: importTests, stats: importStats, users: importUsers };
const TABLES = ['issues', 'issue_events', 'issue_messages', 'issue_attachments', 'fixes', 'issue_prompts', 'legacy_tests', 'runs', 'tester_stats', 'users', 'kv', 'xp_outbox'];

class Ids {
  constructor() { this.map = new Map(); }
  add(id, source, at = null) {
    if (!isId(String(id ?? ''))) return;
    const k = String(id);
    const cur = this.map.get(k) ?? { sources: new Set(), first: null };
    cur.sources.add(source);
    if (at && (!cur.first || at < cur.first)) cur.first = at;
    this.map.set(k, cur);
  }
}

class PartReport {
  constructor(name) { this.name = name; this.counts = {}; this.failures = []; this.notes = []; this.data = {}; this.ms = 0; }
  count(k, n = 1) { this.counts[k] = (this.counts[k] ?? 0) + n; }
  fail(id, why) { this.failures.push({ id: String(id), why }); }
  note(t) { this.notes.push(t); }
}

// Names already in Discord message caches (current Discord names, at = fetch time) - so a run without network still gets them.
function namesFromCache(cacheDir, names, seenAuthors, botIds) {
  let files = [];
  try { files = fs.readdirSync(cacheDir).filter((f) => f.startsWith('messages-') && f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')); } catch { continue; }
    for (const m of c.data ?? []) {
      const a = m.author;
      if (!a?.id) continue;
      if (a.bot || m.webhook_id) { botIds.add(a.id); continue; }
      names.set(a.id, a.global_name || a.username, c.fetchedAt ?? 0);
      seenAuthors.add(a.id);
    }
  }
}

export async function runImport(opts) {
  const {
    db, botDir, fixRoot, dataDir, dryRun = false, only = null, token = null, fetchImpl = globalThis.fetch, refresh = false, discord: useDiscord = true,
    concurrency = 3, log = (s) => process.stderr.write(`${s}\n`), limitIds = null, fetchAllTestThreads = true, sleep, now = Date.now, dbName = null, writeReport = true,
  } = opts;
  const t0 = now();
  const parts = only ? PARTS.filter((p) => only.includes(p)) : PARTS;
  const bad = (only ?? []).filter((p) => !PARTS.includes(p));
  if (bad.length) throw new Error(`unknown part(s): ${bad.join(', ')} (parts: ${PARTS.join(', ')})`);
  const importDir = path.join(dataDir, 'import');
  const cacheDir = path.join(importDir, 'discord-cache');
  const filesDir = path.join(dataDir, 'files');
  const src = loadSources(botDir);
  const w = makeWriter({ db, dryRun });
  const names = new Names();
  const discordNeeded = parts.some((p) => ['messages', 'prompts', 'tests', 'users'].includes(p));
  const discord = useDiscord && discordNeeded
    ? createDiscord({ token, fetchImpl, cacheDir, refresh, offline: dryRun, writeCache: !dryRun, log, ...(sleep ? { sleep } : {}), now })
    : null;

  const reports = {};
  const ctx = {
    src, w, db, discord, names, dryRun, refresh, concurrency, log, fixRoot, filesDir, cacheDir, limitIds, fetchAllTestThreads,
    startedAt: t0, ids: new Ids(), seenAuthors: new Set(), botIds: new Set(),
    part: (n) => (reports[n] ??= new PartReport(n)),
    // ids that are (or, in a dry run, would be) issues
    async knownIssueIds() {
      const s = new Set((await w.read('SELECT id FROM issues')).map((x) => String(x.id)));
      if (dryRun) for (const id of [...Object.keys(src.posts), ...Object.keys(src.deleted)]) s.add(id);
      return s;
    },
  };
  collectNames(src, names);
  namesFromCache(cacheDir, names, ctx.seenAuthors, ctx.botIds);

  const countTables = async () => {
    const out = {};
    for (const t of TABLES) out[t] = Number((await w.read(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
    out.legacy_runs = Number((await w.read('SELECT COUNT(*) AS n FROM runs WHERE legacy = 1'))[0].n);
    // the real invariant: no XP row may point at an imported issue (other writers - the live panel, a test suite on the
    // shared _test DB - can change xp_outbox's total while the import runs)
    out.xp_outbox_for_imported = Number((await w.read('SELECT COUNT(*) AS n FROM xp_outbox x JOIN issues i ON i.id = x.issue_id WHERE i.legacy IS NOT NULL'))[0].n);
    return out;
  };
  const before = await countTables();
  log(`[import] ${dryRun ? 'DRY RUN, ' : ''}db=${dbName ?? '?'} parts=${parts.join(',')} discord=${discord ? (dryRun ? 'cache only' : 'on') : 'off'}`);
  for (const p of parts) {
    const r = ctx.part(p);
    const ts = now();
    log(`[import] part ${p} …`);
    try {
      await RUNNERS[p](ctx);
    } catch (error) {
      r.fail('-', `part aborted: ${error.stack ?? error.message}`);
      log(`[import] part ${p} FAILED: ${error.message}`);
    }
    r.ms = now() - ts;
    log(`[import] part ${p} done in ${(r.ms / 1000).toFixed(1)} s: ${JSON.stringify(r.counts)}${r.failures.length ? ` · ${r.failures.length} failures` : ''}`);
  }
  const after = await countTables();
  const disk = dirSize(path.join(filesDir, 'legacy'));
  const summary = { dryRun, db: dbName, parts, startedAt: t0, ms: now() - t0, before, after, writes: w.writes, discord: discord?.stats ?? null, disk, reports };
  if (writeReport) {
    const md = renderReport(summary);
    let file = null;
    try {
      fs.mkdirSync(importDir, { recursive: true });
      file = path.join(importDir, `report-${new Date(t0).toISOString().replace(/[:.]/g, '-')}${dryRun ? '-dry' : ''}.md`);
      fs.writeFileSync(file, md);
    } catch (error) { log(`[import] cannot write report: ${error.message}`); }
    summary.reportFile = file;
  }
  return summary;
}

export function renderReport(s) {
  const L = [];
  L.push(`# Legacy import report — ${new Date(s.startedAt).toISOString()}${s.dryRun ? ' (DRY RUN: nothing written)' : ''}`, '');
  L.push(`- Database: \`${s.db ?? '?'}\` · parts: ${s.parts.join(', ')} · runtime: ${(s.ms / 1000).toFixed(1)} s`);
  L.push(`- Attachments on disk (files/legacy): ${s.disk.files} files, ${fmtBytes(s.disk.bytes)}`);
  if (s.discord) {
    const d = s.discord;
    L.push(`- Discord: ${d.requests} API requests, ${d.cacheHits} cache hits, ${d.rateLimited} × 429 (${d.globalRateLimited} global, max retry_after ${d.maxRetryAfterMs} ms), ${d.preemptiveWaits} bucket waits, ${(d.waitedMs / 1000).toFixed(1)} s waited, ${d.retries5xx} 5xx retries; ${d.downloads} downloads (${fmtBytes(d.downloadBytes)}), ${d.downloadFailures} download failures`);
  }
  L.push('', '## Table counts', '', '| table | before | after | Δ | write statements |', '|---|---:|---:|---:|---:|');
  for (const t of Object.keys(s.after)) L.push(`| ${t} | ${s.before[t]} | ${s.after[t]} | ${s.after[t] - s.before[t]} | ${s.writes[t] ?? 0} |`);
  if (s.after.xp_outbox_for_imported) L.push('', `**WARNING: ${s.after.xp_outbox_for_imported} xp_outbox rows reference imported issues; the import never writes xp_outbox.**`);
  if (s.after.xp_outbox !== s.before.xp_outbox) L.push('', `Note: xp_outbox changed ${s.before.xp_outbox} → ${s.after.xp_outbox} during the run (the import wrote ${s.writes.xp_outbox ?? 0}; another writer was active on this DB).`);
  for (const r of Object.values(s.reports)) {
    L.push('', `## ${r.name} (${(r.ms / 1000).toFixed(1)} s)`, '');
    for (const [k, v] of Object.entries(r.counts)) L.push(`- ${k}: ${v}`);
    for (const n of r.notes) L.push(`- note: ${n}`);
    if (r.name === 'users') {
      if (r.data.mods?.length) {
        L.push('', '### Users marked dev (Mod-only actions in the old bot)', '');
        for (const m of r.data.mods) L.push(`- ${m.id} ${m.name ?? '(no name)'} — ${m.evidence.join('; ')}${m.more ? ` (+${m.more} more)` : ''}`);
      }
      L.push('', 'Mod/admin membership itself is not stored offline in communitybot (only role names in config.js); everyone without Mod-only actions stays `tester`. Fix roles in the panel (Users) or via ADMIN_DISCORD_IDS.');
      if (r.data.unnamed?.length) L.push('', `Without a name: ${r.data.unnamed.join(', ')}`);
      if (r.data.botsExcluded?.length) L.push('', `Bot/webhook ids excluded: ${r.data.botsExcluded.join(', ')}`);
    }
    if (r.failures.length) {
      L.push('', `### Failures / skipped (${r.failures.length})`, '');
      for (const f of r.failures.slice(0, 400)) L.push(`- \`${f.id}\` ${f.why}`);
      if (r.failures.length > 400) L.push(`- … ${r.failures.length - 400} more`);
    }
  }
  return `${L.join('\n')}\n`;
}
