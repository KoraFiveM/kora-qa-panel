// Loads /etc/kora-qa/config.env and secrets.env (KEY=VALUE, optional quotes, # comments). process.env wins, so systemd's
// EnvironmentFile and tests can override anything. KORA_QA_CONFIG_DIR changes the directory (tests point it at a temp dir).
import fs from 'node:fs';
import path from 'node:path';

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const dir = env.KORA_QA_CONFIG_DIR ?? '/etc/kora-qa';
  const files = env.KORA_QA_NO_ENV_FILES === '1' ? {} : { ...readEnvFile(path.join(dir, 'config.env')), ...readEnvFile(path.join(dir, 'secrets.env')) };
  const e = { ...files, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) };
  const publicUrl = String(e.PUBLIC_URL ?? 'https://zap.ssite.co.uk/qa').replace(/\/+$/, '');
  return {
    panelPort: num(e.PANEL_PORT, 47620),
    hookPort: num(e.HOOK_PORT, 47616),
    host: '127.0.0.1',
    publicUrl,
    basePath: new URL(publicUrl).pathname.replace(/\/+$/, '') || '/qa',
    db: { host: e.DB_HOST ?? '127.0.0.1', port: num(e.DB_PORT, 3306), database: e.DB_NAME ?? 'kora_qa', user: e.DB_USER ?? 'kora_qa', password: e.DB_PASSWORD ?? '' },
    resDir: e.RES_DIR ?? '/home/DevTestingKora/kora/server/txData/kora dev/resources',
    fixRoot: e.FIX_ROOT ?? '/var/lib/claude-bugfix',
    applyFix: e.APPLY_FIX ?? '/opt/claude-bugfix/apply-fix.sh',
    fxCtlUrl: e.FX_CTL_URL ?? 'http://127.0.0.1:30120/kora_qa/ctl',
    botXpUrl: e.BOT_XP_URL ?? 'http://127.0.0.1:31291/qa-xp',
    dataDir: e.DATA_DIR ?? '/var/lib/kora-qa',
    get filesDir() { return path.join(this.dataDir, 'files'); },
    protectedResources: [...new Set([...list(e.PROTECTED_RESOURCES), 'kora_qa'])],
    scanAll: e.QA_SCAN_ALL === '1',
    devLogin: e.DEV_LOGIN === '1',
    openSignup: e.OPEN_SIGNUP === '1', // 1 = any Discord account may log in (as tester); else only known users + ADMIN_DISCORD_IDS
    discordClientId: e.DISCORD_CLIENT_ID ?? '',
    discordClientSecret: e.DISCORD_CLIENT_SECRET ?? '',
    sessionSecret: e.SESSION_SECRET ?? '',
    bugHookSecret: e.BUG_HOOK_SECRET ?? '',
    gameSecret: e.KORA_QA_GAME_SECRET ?? '',
    xpSecret: e.QA_XP_SECRET ?? '',
    adminDiscordIds: list(e.ADMIN_DISCORD_IDS),
    // Roles from Discord at every login (empty DISCORD_GUILD_ID = off: only known users + ADMIN_DISCORD_IDS, scope identify).
    discordGuildId: e.DISCORD_GUILD_ID ?? '',
    discordAdminRoleIds: list(e.DISCORD_ADMIN_ROLE_IDS),
    discordDevRoleIds: list(e.DISCORD_DEV_ROLE_IDS),
    discordTesterRoleIds: list(e.DISCORD_TESTER_ROLE_IDS),
    manualReviewAfter: num(e.MANUAL_REVIEW_AFTER, 3),
    stepsCatalog: e.STEPS_CATALOG ?? null, // default: RES_DIR/[kora]/kora_qa/shared/steps.json
    useSudo: e.APPLY_FIX_SUDO !== '0',
    cookieSecure: e.COOKIE_SECURE !== '0',
    workers: e.KORA_QA_WORKERS !== '0',
  };
}

let current = null;
export const config = () => (current ??= loadConfig());
export const setConfig = (c) => { current = c; return c; };
