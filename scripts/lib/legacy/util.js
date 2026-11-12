// Shared helpers for the legacy import: source loading, status mapping, names, the dry-run aware DB writer, small async utils.
import fs from 'node:fs';
import path from 'node:path';
import { normStatus, isStatus } from '../../../server/machine.js';
import { snowflakeTime, ISSUE_ID_RE } from '../../../server/ids.js';

export { ISSUE_ID_RE, snowflakeTime };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clip = (s, n) => (s === null || s === undefined ? null : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
export const isId = (v) => typeof v === 'string' && /^[0-9]{15,25}$/.test(v);
export const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
export const idTime = (id) => (isId(String(id ?? '')) ? snowflakeTime(String(id)) : null);

// fix_attempted -> awaiting_test; anything unknown falls back to open (and is reported by the caller).
export function mapStatus(s) {
  const n = normStatus(String(s ?? ''));
  return isStatus(n) ? n : null;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

// Every communitybot file the import reads. Missing optional files give empty defaults (reported as 0).
export function loadSources(botDir) {
  const p = (...a) => path.join(botDir, ...a);
  const tracker = readJson(p('data', 'bug-tracker.json'));
  return {
    botDir,
    tracker,
    posts: tracker.posts ?? {},
    deleted: tracker.meta?.deletedPosts ?? {},
    triage: readJson(p('data', 'test-triage.json'), { items: {} }),
    triageItems: readJson(p('assets', 'test-triage', 'items.json'), { items: [] }).items ?? [],
    features: readJson(p('assets', 'tester-checklist', 'features.json'), { resources: [] }).resources ?? [],
    checklist: readJson(p('data', 'tester-checklist.json'), { items: {} }),
    spots: readJson(p('data', 'test-spots.json'), null),
    prompts: readJson(p('data', 'test-prompts.json'), { prompts: {} }).prompts ?? {},
    activity: readJson(p('data', 'tester-activity.json'), {}),
    tom: readJson(p('data', 'tester-of-month.json'), null),
    plannerDir: p('data', 'planner'),
  };
}

// Discord id -> freshest display name. `at` decides; equal times keep the first.
export class Names {
  constructor() { this.m = new Map(); }
  set(id, name, at = 0) {
    if (!isId(String(id ?? '')) || typeof name !== 'string' || !name.trim()) return;
    const cur = this.m.get(String(id));
    if (!cur || (at ?? 0) > cur.at) this.m.set(String(id), { name: clip(name.trim(), 100), at: at ?? 0 });
  }
  get(id) { return this.m.get(String(id ?? ''))?.name ?? null; }
}

// Wraps the panel DB module. In dry-run every write is counted (per table) and nothing is sent; reads still hit the DB.
export function makeWriter({ db, dryRun }) {
  const writes = {};
  let fake = 9e15;
  const tableOf = (sql) => /^\s*(?:INSERT(?:\s+IGNORE)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+`?(\w+)/i.exec(sql)?.[1] ?? '?';
  return {
    dryRun,
    writes,
    async exec(sql, params = [], conn = null) {
      const t = tableOf(sql);
      writes[t] = (writes[t] ?? 0) + 1;
      if (dryRun) return { insertId: ++fake, affectedRows: 1 };
      return db.q(sql, params, conn);
    },
    read: (sql, params = [], conn = null) => db.q(sql, params, conn),
    async tx(fn) { return dryRun ? fn(null) : db.tx(fn); },
  };
}

// Runs fn over items with at most `n` in flight; returns results in order. Errors are returned as { error }.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (error) { out[k] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

export const safeName = (s) => String(s ?? 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

export function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { bytes += fs.statSync(p).size; files++; }
    }
  };
  walk(dir);
  return { bytes, files };
}

export const fmtBytes = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GiB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`);
