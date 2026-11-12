// Test setup: a throwaway database (kora_qa_test), temp data/fix dirs, test secrets. Import this FIRST in every test
// file that touches config or the DB (it sets process.env before config() is first read).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-qa-test-'));

export const SECRETS = {
  BUG_HOOK_SECRET: 'test-hook-secret-0123456789abcdef0123456789abcdef',
  KORA_QA_GAME_SECRET: 'test-game-secret-0123456789abcdef0123456789abcdef',
  QA_XP_SECRET: 'test-xp-secret-0123456789abcdef0123456789abcdef',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
};

Object.assign(process.env, {
  // own throwaway DB per test process (created below, dropped in done()); kora_qa_test itself is left alone
  DB_NAME: process.env.TEST_DB_NAME ?? `kora_qa_test_${process.pid}`,
  DATA_DIR: path.join(TMP, 'data'),
  FIX_ROOT: path.join(TMP, 'fix'),
  RES_DIR: path.join(FIXTURES, 'resources'),
  STEPS_CATALOG: path.join(FIXTURES, 'steps.json'),
  PUBLIC_URL: 'https://example.test/qa',
  FX_CTL_URL: 'http://127.0.0.1:9/kora_qa/ctl',
  BOT_XP_URL: 'http://127.0.0.1:9/qa-xp',
  PROTECTED_RESOURCES: 'monitor',
  APPLY_FIX_SUDO: '0',
  APPLY_FIX: path.join(FIXTURES, 'fake-apply-fix.sh'),
  ADMIN_DISCORD_IDS: '100000000000000001',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: '',
  DEV_LOGIN: '1',
  COOKIE_SECURE: '0',
  KORA_QA_WORKERS: '0',
  QA_SCAN_ALL: '0',
  ...SECRETS,
});
fs.mkdirSync(path.join(TMP, 'data', 'files'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'fix', 'fixes'), { recursive: true });

if (!/^kora_qa_test_\w+$/.test(process.env.DB_NAME)) throw new Error('refusing to run tests against a non-throwaway database (want kora_qa_test_<suffix>)');

// Create the throwaway DB with a pool-less connection (the pool binds to the database).
{
  const mysql = (await import('mysql2/promise')).default;
  const { loadConfig } = await import('../server/config.js');
  const c = loadConfig().db;
  const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
}

const { q, closePool } = await import('../server/db.js');
const { migrate } = await import('../server/migrate.js');

export async function resetDb() {
  const tables = (await q('SHOW TABLES')).map((r) => Object.values(r)[0]);
  await q('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) await q(`DROP TABLE \`${t}\``);
  await q('SET FOREIGN_KEY_CHECKS = 1');
  await migrate({ log: () => {} });
}

let dropped = false;
async function dropDb() {
  if (dropped) return;
  dropped = true;
  try { await q(`DROP DATABASE IF EXISTS \`${process.env.DB_NAME}\``); } catch { /* best effort */ }
}

export async function done() {
  await dropDb();
  await closePool();
  fs.rmSync(TMP, { recursive: true, force: true });
}

export { q };
