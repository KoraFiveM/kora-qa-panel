// Applies migrations/NNN_name.sql in order, once each (recorded in schema_migrations). Usage: node server/migrate.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool, q } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Splits on ; at line ends, ignoring -- comments. Good enough for our plain DDL files.
export function splitSql(text) {
  const clean = text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return clean.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

export async function migrate({ log = console.log } = {}) {
  getPool();
  await q('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(191) PRIMARY KEY, applied_at BIGINT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  const done = new Set((await q('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    for (const stmt of splitSql(fs.readFileSync(path.join(dir, f), 'utf8'))) await q(stmt);
    await q('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [f, Date.now()]);
    applied.push(f);
    log(`[migrate] applied ${f}`);
  }
  if (!applied.length) log('[migrate] up to date');
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => closePool()).catch(async (error) => {
    console.error('[migrate] failed:', error.message);
    await closePool().catch(() => {});
    process.exit(1);
  });
}
