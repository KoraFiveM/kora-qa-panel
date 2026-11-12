// mysql2/promise pool + transaction helper. JSON columns come back parsed (typeCast below); BIGINTs as strings when
// they exceed 2^53 (supportBigNumbers), else numbers.
import mysql from 'mysql2/promise';
import { config } from './config.js';

let pool = null;

function typeCast(field, next) {
  if (field.type === 'JSON') {
    const s = field.string('utf8');
    if (s === null) return null;
    try { return JSON.parse(s); } catch { return s; }
  }
  return next();
}

export function getPool(cfg = config().db) {
  if (pool) return pool;
  pool = mysql.createPool({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    connectionLimit: 10, charset: 'utf8mb4_unicode_ci', supportBigNumbers: true, bigNumberStrings: false,
    typeCast, multipleStatements: false, timezone: 'Z',
  });
  return pool;
}

export async function closePool() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

// Rows. Accepts a connection (inside tx) or uses the pool.
export async function q(sql, params = [], conn = null) {
  const [rows] = await (conn ?? getPool()).query(sql, params);
  return rows;
}
export async function one(sql, params = [], conn = null) {
  const rows = await q(sql, params, conn);
  return rows[0] ?? null;
}

// Runs fn(conn) inside a transaction. Retries deadlocks a few times.
export async function tx(fn) {
  for (let attempt = 0; ; attempt++) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (error) {
      try { await conn.rollback(); } catch { /* ignore */ }
      if ((error?.code === 'ER_LOCK_DEADLOCK' || error?.errno === 1213) && attempt < 3) continue;
      throw error;
    } finally {
      conn.release();
    }
  }
}

export const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
