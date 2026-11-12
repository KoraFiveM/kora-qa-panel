#!/usr/bin/env node
// Imports communitybot's bug tracker, Discord threads (read-only REST), claude-bugfix fixes, prompts, legacy tests/results,
// tester stats and people into the panel DB. Idempotent (upserts keyed by original ids); re-run until cut-over.
//
//   node scripts/import-legacy.mjs [--dry-run] [--only=issues,messages,fixes,prompts,tests,stats,users] [--db=kora_qa_test]
//        [--refresh] [--no-discord] [--concurrency=3] [--bot-dir=/home/DiscordBots/communitybot] [--fix-root=/var/lib/claude-bugfix]
//        [--data-dir=/var/lib/kora-qa] [--no-migrate]
//
// --dry-run   counts what would be written; no DB writes, no Discord requests (uses the response cache only), no downloads.
// --refresh   refetch Discord responses even when cached (DATA_DIR/import/discord-cache).
// Report: DATA_DIR/import/report-<ts>.md. Discord bot token: DISCORD_TOKEN from <bot-dir>/.env (never printed).
// Never writes xp_outbox, never goes through transition(): imported history pays no XP.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`bad argument: ${a}`); process.exit(2); }
  return [m[1], m[2] ?? true];
}));
const KNOWN = ['dry-run', 'only', 'db', 'refresh', 'no-discord', 'concurrency', 'bot-dir', 'fix-root', 'data-dir', 'no-migrate', 'help'];
const unknown = Object.keys(args).filter((k) => !KNOWN.includes(k));
if (args.help || unknown.length) {
  if (unknown.length) console.error(`unknown option(s): ${unknown.join(', ')}`);
  console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(unknown.length ? 2 : 0);
}
if (typeof args.db === 'string') process.env.DB_NAME = args.db;
if (typeof args['fix-root'] === 'string') process.env.FIX_ROOT = args['fix-root'];
if (typeof args['data-dir'] === 'string') process.env.DATA_DIR = args['data-dir'];

const { config, closePool, q, tx, migrate } = await import('./lib/db.js');
const { runImport } = await import('./lib/legacy/index.js');
const { parseEnv } = await import('../server/config.js');

const cfg = config();
const botDir = typeof args['bot-dir'] === 'string' ? args['bot-dir'] : '/home/DiscordBots/communitybot';
const dryRun = Boolean(args['dry-run']);
const useDiscord = !args['no-discord'];
let token = null;
if (useDiscord && !dryRun) {
  try { token = parseEnv(fs.readFileSync(path.join(botDir, '.env'), 'utf8')).DISCORD_TOKEN || null; } catch { token = null; }
  if (!token) { console.error(`no DISCORD_TOKEN in ${path.join(botDir, '.env')} (use --no-discord to skip thread messages)`); process.exit(1); }
}

try {
  if (!dryRun && !args['no-migrate']) await migrate({ log: (s) => console.error(s) });
  const s = await runImport({
    db: { q, tx }, botDir, fixRoot: cfg.fixRoot, dataDir: cfg.dataDir, dryRun, token, discord: useDiscord, refresh: Boolean(args.refresh),
    only: typeof args.only === 'string' ? args.only.split(',').map((x) => x.trim()).filter(Boolean) : null,
    concurrency: Math.max(1, Math.min(8, Number(args.concurrency ?? 3) || 3)), dbName: cfg.db.database,
  });
  const fails = Object.values(s.reports).reduce((n, r) => n + r.failures.length, 0);
  console.log(`import ${dryRun ? '(dry run) ' : ''}done in ${(s.ms / 1000).toFixed(1)} s · ${fails} failures/skips · report: ${s.reportFile ?? '(not written)'}`);
  for (const r of Object.values(s.reports)) console.log(`  ${r.name.padEnd(9)} ${JSON.stringify(r.counts)}${r.failures.length ? ` · ${r.failures.length} failures` : ''}`);
  if (s.after.xp_outbox_for_imported) console.log(`  WARNING: ${s.after.xp_outbox_for_imported} xp_outbox rows reference imported issues`);
  else if (s.after.xp_outbox !== s.before.xp_outbox) console.log('  note: xp_outbox changed during the run, not by the import (another writer on this DB)');
  await closePool();
} catch (error) {
  console.error(`import failed: ${error.stack ?? error.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}
