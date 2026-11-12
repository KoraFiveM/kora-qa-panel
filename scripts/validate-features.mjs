#!/usr/bin/env node
// Validates feature files the way the panel does (gherkin parse, step catalog match, priorities, caps, aliases).
//   node scripts/validate-features.mjs <file-or-dir>... [--res-dir DIR] [--staging DIR] [--catalog steps.json] [--json]
// A file's resource is the folder above its tests/ dir (…/<resource>/tests/x.feature). Exit 1 if anything is invalid.
import fs from 'node:fs';
import path from 'node:path';
import { loadValidationContext, validateFeatureText } from './lib/scenarios.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const asJson = args.includes('--json') ? (args.splice(args.indexOf('--json'), 1), true) : false;
const resDir = opt('--res-dir') ?? process.env.RES_DIR ?? '/home/DevTestingKora/kora/server/txData/kora dev/resources';
const stagingDir = opt('--staging');
const catalogFile = opt('--catalog');
if (!args.length) { console.error('usage: validate-features.mjs <file-or-dir>... [--res-dir DIR] [--staging DIR] [--catalog FILE] [--json]'); process.exit(2); }

const files = [];
const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); else if (p.endsWith('.feature')) files.push(p); };
for (const a of args) walk(a);
const ctx = loadValidationContext({ resDir, stagingDir, catalogFile });
if (ctx.catalog.error) console.error(`warning: ${ctx.catalog.error} (only the manual fallbacks are known)`);
const report = [];
let bad = 0;
for (const f of files) {
  const parts = path.resolve(f).split(path.sep);
  const ti = parts.lastIndexOf('tests');
  const resource = ti > 0 ? parts[ti - 1] : path.basename(path.dirname(f));
  const rel = ti > 0 ? parts.slice(ti).join('/') : path.basename(f);
  const v = validateFeatureText(fs.readFileSync(f, 'utf8'), { resource, file: rel, ctx });
  if (!v.ok) bad++;
  report.push({ file: f, resource, ok: v.ok, errors: v.errors, scenarios: v.results.map((r) => ({ id: r.scenario.id, name: r.scenario.name, valid: r.valid, errors: r.errors })) });
}
if (asJson) console.log(JSON.stringify(report, null, 1));
else for (const r of report) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file}`);
  for (const e of r.errors) console.log(`     line ${e.line ?? '?'}: ${e.message}`);
  for (const s of r.scenarios.filter((x) => !x.valid)) for (const e of s.errors) console.log(`     ${s.id} step ${e.idx ?? '-'}: ${e.message}${e.text ? `  [${e.text}]` : ''}`);
}
process.exit(bad ? 1 : 0);
