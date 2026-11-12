#!/usr/bin/env node
// Applies the staged legacy conversion to the live resources (PLAN §11 "Output and review"), then validates RES_DIR the
// way the panel scan does.
//
//   node scripts/apply-conversion.mjs [--staging /var/lib/kora-qa/conversion] [--res-dir DIR] [--dry-run]
//
// Per staged resource that exists in RES_DIR:
//   - `git status --porcelain` in the resource (if it is inside a repo) is recorded; nothing is ever stashed/committed/reset.
//   - tests/*.feature and tests/qa.lua are copied into <resource>/tests/. An existing file with the same content is left;
//     an existing file with different content is NOT overwritten (listed as a conflict). kora_qa is never touched.
//   - fxmanifest.lua gets `qa_feature 'tests/*.feature'` appended (with a comment line) when it has no qa_feature line;
//     resources whose fxmanifest.lua already had uncommitted changes are listed.
// New files/dirs get the owner of the resource folder and modes 644/755 (the fixer reads RES_DIR as "other").
// Writes <staging>/apply-report.md and apply-result.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findResourceDirs } from './lib/convert/context.js';
import { discover, loadValidationContext, validateResources } from './lib/scenarios.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const dryRun = args.includes('--dry-run');
const staging = opt('--staging', '/var/lib/kora-qa/conversion');
const resDir = opt('--res-dir', process.env.RES_DIR ?? '/home/DevTestingKora/kora/server/txData/kora dev/resources');
const NEVER = new Set(['kora_qa']);
const MANIFEST_LINES = ['', '-- kora_qa: Gherkin test scenarios (converted legacy tests), see [kora]/kora_qa/README.md', "qa_feature 'tests/*.feature'", ''];

const git = (dir, gitArgs) => {
  try { return execFileSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};

const liveDirs = findResourceDirs(resDir);
const staged = fs.readdirSync(staging, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(staging, e.name, 'tests')))
  .map((e) => e.name).sort();

const result = { at: Date.now(), dryRun, applied: [], stagingOnly: [], skipped: [], conflicts: [], dirtyManifest: [], dirty: [], manifestAdded: [], validation: null };
for (const res of staged) {
  if (NEVER.has(res)) { result.skipped.push({ res, why: 'never applied' }); continue; }
  const live = liveDirs[res];
  if (!live) { result.stagingOnly.push(res); continue; }
  const top = git(live, ['rev-parse', '--show-toplevel'])?.trim() ?? null;
  const porcelain = top ? (git(live, ['status', '--porcelain', '--', '.']) ?? '') : null;
  const dirtyFiles = porcelain ? porcelain.split('\n').filter(Boolean) : [];
  const manifestDirty = dirtyFiles.some((l) => /(^|\/)fxmanifest\.lua$/.test(l.slice(3).trim()) && path.resolve(top, l.slice(3).trim()) === path.join(live, 'fxmanifest.lua'));
  if (dirtyFiles.length) result.dirty.push({ res, repo: top, files: dirtyFiles.length });
  if (manifestDirty) result.dirtyManifest.push(res);

  const st = fs.statSync(live);
  const own = (p) => { try { fs.chownSync(p, st.uid, st.gid); } catch { /* not root */ } };
  const srcTests = path.join(staging, res, 'tests');
  const dstTests = path.join(live, 'tests');
  const done = { res, repo: top ?? '(no git)', copied: [], identical: [], conflicts: [] };
  for (const f of fs.readdirSync(srcTests).filter((f) => f.endsWith('.feature') || f === 'qa.lua').sort()) {
    const src = fs.readFileSync(path.join(srcTests, f));
    const dst = path.join(dstTests, f);
    if (fs.existsSync(dst)) {
      if (fs.readFileSync(dst).equals(src)) done.identical.push(f);
      else { done.conflicts.push(f); result.conflicts.push(`${res}/tests/${f}`); }
      continue;
    }
    if (!dryRun) {
      if (!fs.existsSync(dstTests)) { fs.mkdirSync(dstTests, { mode: 0o755 }); fs.chmodSync(dstTests, 0o755); own(dstTests); }
      fs.writeFileSync(dst, src, { mode: 0o644 });
      fs.chmodSync(dst, 0o644);
      own(dst);
    }
    done.copied.push(f);
  }
  const mf = path.join(live, 'fxmanifest.lua');
  const manifest = fs.readFileSync(mf, 'utf8');
  if (!/^\s*qa_features?\b/m.test(manifest)) {
    if (!dryRun) fs.appendFileSync(mf, (manifest.endsWith('\n') ? '' : '\n') + MANIFEST_LINES.join('\n'));
    result.manifestAdded.push(res);
  }
  result.applied.push(done);
}

// Validate everything the panel would scan (qa_feature opt-in), with the live aliases only.
const resources = discover(resDir);
const ctx = loadValidationContext({ resDir });
const { results, fileErrors } = validateResources(resources, ctx);
const per = {};
for (const r of results) {
  const p = (per[r.scenario.resource] ??= { scenarios: 0, valid: 0, invalid: 0 });
  p.scenarios++;
  if (r.valid) p.valid++; else p.invalid++;
}
const invalid = results.filter((r) => !r.valid).map((r) => ({ id: r.scenario.id, errors: r.errors.map((e) => e.message) }));
result.validation = { resources: resources.length, scenarios: results.length, valid: results.filter((r) => r.valid).length, invalid, fileErrors, per };

const L = ['# Applying the converted legacy tests to the live resources', '', `${new Date(result.at).toISOString()}${dryRun ? ' (DRY RUN — nothing written)' : ''}. RES_DIR: \`${resDir}\`.`, ''];
L.push(`- applied: ${result.applied.length} resources (${result.applied.reduce((n, a) => n + a.copied.length, 0)} files copied, ${result.applied.reduce((n, a) => n + a.identical.length, 0)} already identical)`);
L.push(`- fxmanifest.lua got \`qa_feature 'tests/*.feature'\`: ${result.manifestAdded.length} (${result.manifestAdded.join(', ') || '-'})`);
L.push(`- fxmanifest.lua already had uncommitted changes (line appended anyway): ${result.dirtyManifest.join(', ') || 'none'}`);
L.push(`- conflicts (existing tests/ file with different content, not overwritten): ${result.conflicts.join(', ') || 'none'}`);
L.push(`- staging only (no live resource folder): ${result.stagingOnly.join(', ') || 'none'}`);
L.push(`- skipped: ${result.skipped.map((s) => `${s.res} (${s.why})`).join(', ') || 'none'}`, '');
L.push('## Resources', '', '| resource | repo | copied | identical | conflicts | uncommitted files in resource (before) |', '|---|---|---|---|---|---|');
for (const a of result.applied) L.push(`| ${a.res} | ${a.repo === '(no git)' ? 'no git' : `\`${a.repo}\``} | ${a.copied.join(', ')} | ${a.identical.join(', ')} | ${a.conflicts.join(', ')} | ${result.dirty.find((d) => d.res === a.res)?.files ?? 0} |`);
L.push('', '## Panel scan validation of RES_DIR', '', `${result.validation.resources} opted-in resources, ${result.validation.scenarios} scenarios, ${result.validation.valid} valid, ${invalid.length} invalid, ${fileErrors.length} file errors.`, '');
L.push('| resource | scenarios | valid | invalid |', '|---|---|---|---|');
for (const [r, p] of Object.entries(per).sort()) L.push(`| ${r} | ${p.scenarios} | ${p.valid} | ${p.invalid} |`);
for (const i of invalid) L.push(`- INVALID \`${i.id}\`: ${i.errors.join('; ')}`);
for (const e of fileErrors) L.push(`- FILE ERROR ${e.resource}/${e.file}:${e.line ?? '?'} ${e.message}`);
if (!dryRun) {
  fs.writeFileSync(path.join(staging, 'apply-report.md'), `${L.join('\n')}\n`);
  fs.writeFileSync(path.join(staging, 'apply-result.json'), JSON.stringify(result, null, 1));
}
console.log(L.slice(0, 9).join('\n'));
console.log(`validation: ${result.validation.scenarios} scenarios, ${result.validation.valid} valid, ${invalid.length} invalid, ${fileErrors.length} file errors`);
process.exit(invalid.length || fileErrors.filter((e) => e.file !== 'tests/qa.lua').length ? 1 : 0);
