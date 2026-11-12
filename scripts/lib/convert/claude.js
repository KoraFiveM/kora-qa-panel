// Claude CLI runner, same binary/auth as the fixer (run_claude in /opt/claude-bugfix/bugfix.sh): `claude -p` with
// structured JSON output. Model is pinned to Sonnet, effort medium. No tools. Every response is cached by a hash of
// everything that shapes it, so re-runs never re-spend.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MODEL = 'claude-sonnet-5-5';
export const EFFORT = 'medium';
export const CLAUDE_BIN = '/var/lib/claude-bugfix/.local/bin/claude';
export const SECRETS_FILE = '/etc/claude-bugfix/secrets.env';

// Reads one key from an env file without ever printing it.
export function readSecret(file, key) {
  const src = fs.readFileSync(file, 'utf8');
  const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(src);
  if (!m) throw new Error(`${key} not found in ${file}`);
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

export function cacheKey({ system, prompt, schema, model = MODEL, effort = EFFORT }) {
  return crypto.createHash('sha256').update(JSON.stringify({ v: 1, model, effort, system, prompt, schema })).digest('hex').slice(0, 32);
}

export function makeRunner({ workDir, budgetUsd = 2, timeoutMs = 15 * 60 * 1000, bin = CLAUDE_BIN, secretsFile = SECRETS_FILE, offline = false, log = () => {} }) {
  const cacheDir = path.join(workDir, 'cache');
  const home = path.join(workDir, '.home');
  const cwd = path.join(workDir, '.cwd');
  for (const d of [cacheDir, home, cwd]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  let token = null;
  const stats = { calls: 0, cached: 0, failed: 0, costUsd: 0, cachedCostUsd: 0 };

  async function run({ system, prompt, schema, label }) {
    const key = cacheKey({ system, prompt, schema });
    const file = path.join(cacheDir, `${key}.json`);
    if (fs.existsSync(file)) {
      const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
      stats.cached++;
      stats.cachedCostUsd += Number(hit.response?.total_cost_usd) || 0;
      return { key, cached: true, output: hit.response.structured_output, response: hit.response };
    }
    if (offline) return { key, cached: false, output: null, error: 'offline: not in cache' };
    token ??= readSecret(secretsFile, 'CLAUDE_CODE_OAUTH_TOKEN');
    const sysFile = path.join(cwd, `system-${key}.md`);
    fs.writeFileSync(sysFile, system, { mode: 0o600 });
    const args = ['-p', '--model', MODEL, '--effort', EFFORT, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--system-prompt-file', sysFile, '--max-budget-usd', String(budgetUsd), '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--permission-prompts', 'none'];
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CODE_OAUTH_TOKEN: token, LANG: 'C.UTF-8' };
    const started = Date.now();
    log(`claude ${label}: start (${prompt.length} chars)`);
    stats.calls++;
    const res = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); err += '\n[timeout]'; }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
      child.stdin.end(prompt);
    });
    try { fs.unlinkSync(sysFile); } catch { /* ignore */ }
    let response = null;
    try { response = JSON.parse(res.out); } catch { /* handled below */ }
    const cost = Number(response?.total_cost_usd) || 0;
    stats.costUsd += cost;
    if (!response?.structured_output || response.is_error) {
      stats.failed++;
      const why = response?.result ?? (res.err.split('\n').filter(Boolean).slice(-3).join(' | ') || `exit ${res.code}`);
      log(`claude ${label}: FAILED (${String(why).slice(0, 300)})`);
      fs.writeFileSync(path.join(cacheDir, `${key}.failed.json`), JSON.stringify({ label, at: Date.now(), code: res.code, response, stderr: res.err.slice(-4000) }, null, 1));
      return { key, cached: false, output: null, error: String(why).slice(0, 500), cost };
    }
    fs.writeFileSync(file, JSON.stringify({ label, at: Date.now(), ms: Date.now() - started, model: MODEL, effort: EFFORT, prompt, response }, null, 1));
    log(`claude ${label}: done in ${Math.round((Date.now() - started) / 1000)}s, $${cost.toFixed(4)}`);
    return { key, cached: false, output: response.structured_output, response, cost };
  }

  return { run, stats };
}

// Runs async fns with at most `limit` in flight.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
