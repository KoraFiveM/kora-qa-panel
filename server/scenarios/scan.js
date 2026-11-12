// Finds opted-in feature files under RES_DIR (QA-CONTRACTS §6): a resource opts in with `qa_feature 'tests/*.feature'`
// in its fxmanifest (QA_SCAN_ALL=1 also takes any tests/*.feature). Pure filesystem; no DB.
import fs from 'node:fs';
import path from 'node:path';
import { readQaLua } from './catalog.js';
import { validateFeatureText } from './validate.js';

const SKIP_DIRS = new Set(['node_modules', '.git']);

// [{ name, dir }] for every folder holding fxmanifest.lua, up to `depth` levels below resDir. First name wins.
export function findResources(resDir, depth = 4) {
  const out = [];
  const seen = new Set();
  const walk = (dir, d) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'fxmanifest.lua')) {
      const name = path.basename(dir);
      if (!seen.has(name)) { seen.add(name); out.push({ name, dir }); }
      return;
    }
    if (d >= depth) return;
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
  };
  walk(resDir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Globs declared with qa_feature / qa_features in fxmanifest text (comments ignored).
export function qaFeatureGlobs(manifest) {
  const text = String(manifest).replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');
  const globs = [];
  for (const m of text.matchAll(/\bqa_feature\s*\(?\s*(['"])([^'"\n]+)\1/g)) globs.push(m[2]);
  for (const m of text.matchAll(/\bqa_features?\s*\(?\s*\{([^}]*)\}/g)) for (const s of m[1].matchAll(/(['"])([^'"\n]+)\1/g)) globs.push(s[2]);
  return [...new Set(globs)];
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Relative paths (posix) of .feature files matching the glob inside dir. Never leaves dir.
export function expandGlob(dir, glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.startsWith('/') || g.split('/').includes('..')) return [];
  const staticPart = g.split('/').filter((p, i, a) => i < a.length - 1 && !/[*?]/.test(p));
  let prefix = [];
  for (const p of staticPart) { if (/[*?]/.test(p)) break; prefix.push(p); }
  const re = globToRegex(g);
  const out = [];
  const walk = (rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 6 && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(r, depth + 1);
      else if (e.isFile() && e.name.endsWith('.feature') && re.test(r)) out.push(r);
    }
  };
  walk(prefix.join('/'), 0);
  return out.sort();
}

// [{ name, dir, files:[rel], qaLua:{aliases,error}, manifestError? }] for opted-in resources.
export function discover(resDir, { scanAll = false } = {}) {
  const out = [];
  for (const r of findResources(resDir)) {
    let manifest = '';
    try { manifest = fs.readFileSync(path.join(r.dir, 'fxmanifest.lua'), 'utf8'); } catch { /* unreadable */ }
    const globs = qaFeatureGlobs(manifest);
    if (scanAll && !globs.includes('tests/*.feature')) globs.push('tests/*.feature');
    const files = [...new Set(globs.flatMap((g) => expandGlob(r.dir, g)))].sort();
    const hasQaLua = fs.existsSync(path.join(r.dir, 'tests', 'qa.lua'));
    if (!globs.length && !hasQaLua) continue;
    out.push({ name: r.name, dir: r.dir, globs, optedIn: qaFeatureGlobs(manifest).length > 0, files, qaLua: readQaLua(r.dir) });
  }
  return out;
}

// Validates every discovered file with ctx (validate.makeContext). -> { results, fileErrors:[{resource, file, line, message}] }
export function validateResources(resources, ctx) {
  const results = [];
  const fileErrors = [];
  for (const r of resources) {
    if (r.qaLua?.error) fileErrors.push({ resource: r.name, file: 'tests/qa.lua', line: null, message: r.qaLua.error });
    for (const file of r.files) {
      let text;
      try { text = fs.readFileSync(path.join(r.dir, file), 'utf8'); } catch (error) { fileErrors.push({ resource: r.name, file, line: null, message: `unreadable: ${error.code ?? error.message}` }); continue; }
      const v = validateFeatureText(text, { resource: r.name, file, ctx });
      for (const e of v.errors) fileErrors.push({ resource: r.name, file, ...e });
      results.push(...v.results);
    }
  }
  return { results, fileErrors };
}
