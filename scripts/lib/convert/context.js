// Read-only facts about the live resources, so the model (and the anti-invention checks) only use real names:
// item names, jobs/gangs, chat commands, string literals (notification texts, menu titles, target labels), callbacks.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', 'web', 'html', 'stream', 'docs', 'build', 'dist', '.git', 'images', 'tools']);

export function findResourceDirs(resDir) {
  const out = {};
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (/^\[.*\]$/.test(e.name) && depth < 3) walk(p, depth + 1);
      else if (fs.existsSync(path.join(p, 'fxmanifest.lua'))) out[e.name] ??= p;
    }
  };
  walk(resDir, 0);
  return out;
}

export function listCodeFiles(dir, exts = ['.lua', '.js'], max = 400) {
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= max) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p); }
      else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.min.js')) files.push(p);
    }
  };
  walk(dir);
  return files;
}

const readSafe = (f, max = 400000) => { try { const s = fs.readFileSync(f, 'utf8'); return s.length > max ? s.slice(0, max) : s; } catch { return ''; } };

// Item definitions anywhere in the resources: a `name = 'x'` with a `weight` close by (items.lua-style tables).
export function collectItemNames(resDirs) {
  const names = new Set();
  for (const dir of Object.values(resDirs)) {
    for (const f of listCodeFiles(dir, ['.lua'])) {
      const src = readSafe(f);
      if (!/weight\s*=/.test(src)) continue;
      const lines = src.split('\n');
      lines.forEach((l, i) => {
        const m = /\bname\s*=\s*['"]([a-z0-9_]{2,48})['"]/i.exec(l);
        if (!m) return;
        const win = lines.slice(i, i + 6).join(' ');
        if (/\bweight\s*=/.test(win) && /\blabel\s*=/.test(win)) names.add(m[1].toLowerCase());
      });
    }
  }
  return [...names].sort();
}

// jobs / gangs from kora_core's shared seeds (top-level entries `name = '...'` followed by `label =` on the same line).
export function collectJobsGangs(coreDir) {
  const grab = (file) => {
    const src = readSafe(path.join(coreDir, 'shared', file));
    return [...src.matchAll(/name\s*=\s*'([A-Za-z0-9_-]+)'\s*,\s*label\s*=/g)].map((m) => m[1]);
  };
  return { jobs: [...new Set(grab('jobs.lua'))], gangs: [...new Set(grab('gangs.lua'))] };
}

function literals(src) {
  const out = [];
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){2,200})'|"((?:[^"\\\n]|\\.){2,200})"|\[\[([\s\S]{2,200}?)\]\]/g)) out.push((m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1'));
  return out;
}

// Per-resource facts.
export function resourceFacts(dir, { itemNames = [] } = {}) {
  const files = listCodeFiles(dir);
  const commands = new Set();
  const callbacks = new Set();
  const strings = new Set();
  const notify = [];
  const itemsUsed = new Set();
  const itemSet = new Set(itemNames);
  for (const f of files) {
    const src = readSafe(f);
    for (const m of src.matchAll(/(?:RegisterCommand|commands\.add|addCommand)\(\s*['"]([^'"\s]{1,40})['"]/g)) commands.add(`/${m[1]}`);
    for (const m of src.matchAll(/commands\.add\(\s*\{[^}]*?name\s*=\s*['"]([^'"\s]{1,40})['"]/g)) commands.add(`/${m[1]}`);
    for (const m of src.matchAll(/callback\.register\(\s*['"]([^'"]{1,80})['"]/g)) callbacks.add(m[1]);
    for (const s of literals(src)) {
      strings.add(s);
      if (itemSet.has(s.toLowerCase())) itemsUsed.add(s.toLowerCase());
    }
    for (const line of src.split('\n')) {
      if (!/notify|Notify|message\s*=|Text\./.test(line)) continue;
      for (const s of literals(line)) if (/[a-z]/i.test(s) && / /.test(s) && s.length >= 6 && notify.length < 400) notify.push(s);
    }
  }
  const readme = ['README.md', 'docs.md'].map((n) => readSafe(path.join(dir, n), 4000)).find(Boolean) ?? '';
  const config = readSafe(path.join(dir, 'config.lua'), 9000);
  return {
    dir,
    commands: [...commands].sort(),
    callbacks: [...callbacks].sort(),
    strings,
    notify: [...new Set(notify)].slice(0, 120),
    itemsUsed: [...itemsUsed].sort(),
    readme: readme.slice(0, 3500),
    config: config.slice(0, 8000),
  };
}

// Everything the converter needs from the live tree.
export function loadLiveContext(resDir) {
  const dirs = findResourceDirs(resDir);
  const itemNames = collectItemNames(dirs);
  const { jobs, gangs } = dirs.kora_core ? collectJobsGangs(dirs.kora_core) : { jobs: [], gangs: [] };
  const facts = {};
  const allCommands = new Set();
  const get = (res) => {
    if (!dirs[res]) return null;
    if (!facts[res]) facts[res] = resourceFacts(dirs[res], { itemNames });
    return facts[res];
  };
  for (const res of Object.keys(dirs)) for (const c of get(res).commands) allCommands.add(c);
  return { resDir, dirs, itemNames, jobs, gangs, facts: get, allCommands: [...allCommands].sort(), marks: collectMarks(dirs) };
}

// Kora.qa.mark('<name>', { field = … }) calls in the live code -> [{ name, resource, fields }]
export function collectMarks(resDirs) {
  const out = new Map();
  for (const [res, dir] of Object.entries(resDirs)) {
    for (const f of listCodeFiles(dir, ['.lua'])) {
      const src = readSafe(f);
      for (const m of src.matchAll(/Kora\.qa\.mark\(\s*['"]([^'"]{1,64})['"]\s*(?:,\s*\{([^}]*)\})?/g)) {
        const fields = [...(m[2] ?? '').matchAll(/([A-Za-z_]\w*)\s*=/g)].map((x) => x[1]);
        if (!out.has(m[1])) out.set(m[1], { name: m[1], resource: res, fields: fields.length ? fields : null, note: `fired by ${res}` });
      }
    }
  }
  return [...out.values()];
}
