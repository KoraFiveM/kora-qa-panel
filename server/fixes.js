// Prepared fixes from claude-bugfix (FIX_ROOT/fixes/<issueId>/meta.json, *.patch, applied.json, history/<ts>/) and the
// apply-fix.sh calls (sudo -n, sudoers snippet in deploy/). Reads are best effort: the fixes dir is owned by bugfixer.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { q, json } from './db.js';
import { ISSUE_ID_RE } from './ids.js';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const fixesDir = () => path.join(config().fixRoot, 'fixes');

export function readFixDir(dir) {
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) return null;
  const applied = readJson(path.join(dir, 'applied.json'));
  let patches = [];
  try { patches = fs.readdirSync(dir).filter((f) => f.endsWith('.patch')).sort(); } catch { /* none */ }
  return { meta, applied, patches };
}

// Every current fix (one level deep; history/ holds old attempts). [{ issueId, state, appliedAt, meta }]
export function listFixDirs() {
  let ids = [];
  try { ids = fs.readdirSync(fixesDir()).filter((d) => ISSUE_ID_RE.test(d)); } catch (error) {
    return { error: error.code === 'EACCES' ? `cannot read ${fixesDir()} (permission denied; see deploy/README.md)` : `cannot read ${fixesDir()}: ${error.code ?? error.message}`, fixes: [] };
  }
  const fixes = [];
  for (const id of ids) {
    const f = readFixDir(path.join(fixesDir(), id));
    if (!f) continue;
    fixes.push({ issueId: id, state: f.applied ? 'applied' : 'waiting', appliedAt: f.applied?.appliedAt ?? null, meta: f.meta, patches: f.patches });
  }
  fixes.sort((a, b) => String(b.meta.createdAt ?? '').localeCompare(String(a.meta.createdAt ?? '')));
  return { fixes };
}

export function listHistory(issueId) {
  const dir = path.join(fixesDir(), issueId, 'history');
  let ts = [];
  try { ts = fs.readdirSync(dir).sort(); } catch { return []; }
  return ts.map((t) => {
    const f = readFixDir(path.join(dir, t));
    return f ? { ts: t, meta: f.meta, applied: f.applied, patches: f.patches } : null;
  }).filter(Boolean);
}

export function readPatches(issueId) {
  const dir = path.join(fixesDir(), issueId);
  const f = readFixDir(dir);
  if (!f) return null;
  return f.patches.map((p) => `----- ${p}\n${fs.readFileSync(path.join(dir, p), 'utf8')}`).join('');
}

export function runApplyFix(args, { timeoutMs = 180000 } = {}) {
  const cfg = config();
  const [cmd, argv] = cfg.useSudo ? ['sudo', ['-n', cfg.applyFix, ...args]] : [cfg.applyFix, args];
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// Fix detail: meta + diff. Diff from `apply-fix.sh --show` (what the admin would see in a shell); falls back to reading
// the patch files when sudo is not set up yet.
export async function fixDetail(issueId) {
  if (!ISSUE_ID_RE.test(issueId)) return null;
  const f = readFixDir(path.join(fixesDir(), issueId));
  const shown = await runApplyFix(['--show', issueId], { timeoutMs: 30000 });
  let show = shown.ok ? shown.stdout : null;
  let diff = null;
  if (show) {
    const i = show.indexOf('\n----- ');
    diff = i >= 0 ? show.slice(i + 1) : '';
  } else {
    try { diff = readPatches(issueId); } catch { diff = null; }
  }
  if (!f && !show) return null;
  return {
    issueId, meta: f?.meta ?? null, applied: f?.applied ?? null, state: f?.applied ? 'applied' : 'waiting', patches: f?.patches ?? [],
    show, diff, diffSource: shown.ok ? 'apply-fix --show' : (diff ? 'patch files' : null),
    showError: shown.ok ? null : (shown.stderr || shown.stdout).split('\n').filter(Boolean).slice(-5).join('\n'),
    history: listHistory(issueId).map((h) => ({ ts: h.ts, patchId: h.meta.patchId, model: h.meta.model, risk: h.meta.risk, summary: h.meta.summary, createdAt: h.meta.createdAt, applied: h.applied })),
  };
}

// Mirrors the fix folder (current + history) into the fixes table. Best effort.
export async function syncFixFromDisk(issueId) {
  if (!ISSUE_ID_RE.test(issueId)) return 0;
  const rows = [];
  const cur = readFixDir(path.join(fixesDir(), issueId));
  if (cur) rows.push({ ...cur, isHistory: 0 });
  for (const h of listHistory(issueId)) rows.push({ meta: h.meta, applied: h.applied, patches: h.patches, isHistory: 1 });
  let n = 0;
  for (const r of rows) {
    const m = r.meta;
    if (!m?.patchId) continue;
    await q(`INSERT INTO fixes (issue_id, patch_id, model, risk, summary, details, test_steps, scenario, meta, applied, is_history, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE applied = VALUES(applied), is_history = VALUES(is_history), meta = VALUES(meta)`,
    [issueId, String(m.patchId).slice(0, 64), m.model ?? null, m.risk ?? null, m.summary ?? null, m.details ?? null, m.testSteps ?? null, m.scenario ?? null, json(m), json(r.applied), r.isHistory, Date.parse(m.createdAt ?? '') || Date.now()]);
    n++;
  }
  return n;
}
