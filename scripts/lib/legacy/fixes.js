// Part 3: claude-bugfix fix folders (FIX_ROOT/fixes/<threadId>/meta.json, applied.json, history/<ts>/) -> fixes. Same row
// shape as server/fixes.js syncFixFromDisk; patches stay on disk (meta._import lists them). Only for ids that exist as issues.
import fs from 'node:fs';
import path from 'node:path';
import { isId } from './util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const MD_MAX = 64 * 1024;

function readDir(dir) {
  let meta = null;
  let applied = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') return { error: `meta.json: ${error.message}` }; }
  try { applied = JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8')); } catch { applied = null; }
  let files = [];
  try { files = fs.readdirSync(dir); } catch (error) { return { error: error.message }; }
  const md = {};
  for (const f of ['TRIAGE.md', 'BUG.md']) {
    try { const t = fs.readFileSync(path.join(dir, f), 'utf8'); md[f] = t.length > MD_MAX ? `${t.slice(0, MD_MAX)}\n…(clipped)` : t; } catch { /* none */ }
  }
  return { meta, applied, patches: files.filter((f) => f.endsWith('.patch')).sort(), md };
}

// "20261106T224213Z" -> ms
const tsTime = (ts) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };

export async function importFixes(ctx) {
  const r = ctx.part('fixes');
  const root = path.join(ctx.fixRoot, 'fixes');
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => isId(d)).sort(); } catch (error) { r.fail(root, `cannot read: ${error.message}`); return; }
  const known = await ctx.knownIssueIds();
  for (const id of dirs) {
    if (ctx.limitIds && !ctx.limitIds.has(id)) continue;
    if (!known.has(id)) { r.count('orphanDirs'); r.fail(id, 'fix folder has no matching issue (not imported)'); continue; }
    const rows = [];
    const cur = readDir(path.join(root, id));
    if (cur.error) r.fail(id, cur.error);
    else if (cur.meta) rows.push({ ...cur, isHistory: 0, ts: null });
    let hist = [];
    try { hist = fs.readdirSync(path.join(root, id, 'history')).sort(); } catch { hist = []; }
    for (const ts of hist) {
      const h = readDir(path.join(root, id, 'history', ts));
      if (h.error) { r.fail(`${id}/history/${ts}`, h.error); continue; }
      if (!h.meta) { r.fail(`${id}/history/${ts}`, 'no meta.json'); continue; }
      rows.push({ ...h, isHistory: 1, ts });
    }
    const used = new Set();
    for (const row of rows) {
      const m = row.meta;
      let patchId = String(m.patchId ?? (row.ts ? `history-${row.ts}` : 'unknown')).slice(0, 48);
      if (used.has(patchId)) patchId = `${patchId}@${row.ts ?? 'current'}`.slice(0, 64);
      used.add(patchId);
      const meta = { ...m, _import: { dir: row.ts ? `fixes/${id}/history/${row.ts}` : `fixes/${id}`, patches: row.patches, historyTs: row.ts, files: row.md } };
      const created = Date.parse(m.createdAt ?? '') || tsTime(row.ts ?? '') || null;
      await ctx.w.exec(`INSERT INTO fixes (issue_id, patch_id, model, risk, summary, details, test_steps, scenario, meta, applied, is_history, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE model = VALUES(model), risk = VALUES(risk), summary = VALUES(summary), details = VALUES(details), test_steps = VALUES(test_steps),
          scenario = VALUES(scenario), meta = VALUES(meta), applied = VALUES(applied), is_history = VALUES(is_history), created_at = VALUES(created_at)`,
      [id, patchId, m.model ?? null, m.risk ?? null, m.summary ?? null, m.details ?? null, m.testSteps ?? null, m.scenario ?? null, json(meta), json(row.applied), row.isHistory, created]);
      r.count(row.isHistory ? 'history' : 'current');
      if (row.applied) r.count('applied');
    }
    r.count('dirs');
  }
}
