// Discord OAuth2 (identify) code flow, sessions, roles. Routes under <base>/auth. Cookie: Path=<base>, HttpOnly,
// Secure, SameSite=Lax. The cookie holds a random token; the sessions table stores its sha256 (a DB leak is no login).
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, one } from './db.js';

export const SESSION_COOKIE = 'kqa_sid';
export const STATE_COOKIE = 'kqa_state';
export const SESSION_TTL = 30 * 24 * 3600 * 1000;
const DISCORD = 'https://discord.com';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', config().sessionSecret).update(String(s)).digest('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(addr ?? ''));
// Came straight from a local process, not through nginx (which adds X-Forwarded-For / X-Real-IP).
export const isDirectLoopback = (req) => isLoopback(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];

export const oauthConfigured = () => Boolean(config().discordClientId && config().discordClientSecret);
const redirectUri = () => `${config().publicUrl}/auth/callback`;

function cookieOpts(path, maxAgeMs) {
  return { path, httpOnly: true, secure: config().cookieSecure, sameSite: 'lax', ...(maxAgeMs !== undefined ? { maxAge: Math.floor(maxAgeMs / 1000) } : {}) };
}

export function userView(u) {
  if (!u) return null;
  return { id: Number(u.id), discordId: u.discord_id, name: u.name, avatar: u.avatar, avatarUrl: avatarUrl(u), role: u.role, legacy: Boolean(u.legacy), disabled: Boolean(u.disabled), disabledAt: u.disabled_at ?? null, createdAt: u.created_at, lastLoginAt: u.last_login_at };
}
export function avatarUrl(u) {
  if (!u?.avatar) return null;
  if (/^https?:\/\//.test(u.avatar)) return u.avatar;
  return `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=64`;
}

export async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await q('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha(token), userId, now, now + SESSION_TTL]);
  res.setCookie(SESSION_COOKIE, token, cookieOpts(config().basePath, SESSION_TTL));
  return token;
}

export async function sessionUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0', [sha(token), Date.now()]);
  return row ?? null;
}

export const guildRolesOn = () => Boolean(config().discordGuildId);
export const oauthScope = () => (guildRolesOn() ? 'identify guilds.members.read' : 'identify');

// Discord role ids -> panel role. Admin wins, then dev, then tester; null = no mapped role.
export function mapDiscordRoles(roleIds, cfg = config()) {
  const has = (ids) => ids.some((id) => roleIds.includes(id));
  if (has(cfg.discordAdminRoleIds)) return 'admin';
  if (has(cfg.discordDevRoleIds)) return 'dev';
  if (has(cfg.discordTesterRoleIds)) return 'tester';
  return null;
}

async function listRefused(discordId, name, reason, now) {
  const pending = (await one("SELECT v FROM kv WHERE k = 'pending_logins'"))?.v ?? [];
  const list = [{ discordId, name, at: now, reason }, ...pending.filter((p) => p.discordId !== discordId)].slice(0, 50);
  await q("INSERT INTO kv (k, v) VALUES ('pending_logins', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(list)]);
}

async function logRoleChange(entry) {
  console.log(`[auth] role of ${entry.discordId} (${entry.name ?? '?'}) ${entry.from ?? '(new)'} -> ${entry.to} (${entry.source})`);
  const cur = (await one("SELECT v FROM kv WHERE k = 'role_changes'"))?.v ?? [];
  await q("INSERT INTO kv (k, v) VALUES ('role_changes', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify([entry, ...cur].slice(0, 200))]);
}

// Upserts the user on login. Returns { user } or { rejected: true, reason, disabled? }.
//   discordRole: the role mapped from the member's Discord roles (guild mode; null = no mapped role), undefined = guild mode off.
//   Guild mode: the stored role is overwritten on every login (changes logged in kv role_changes); ADMIN_DISCORD_IDS always
//   wins; no mapped role -> refused. Off: only known users (or allowNew / ADMIN_DISCORD_IDS) get in, role kept.
export async function loginUser({ discordId, name, avatar, discordRole }, { allowNew = config().openSignup } = {}) {
  const now = Date.now();
  const admin = config().adminDiscordIds.includes(discordId);
  const existing = await one('SELECT * FROM users WHERE discord_id = ?', [discordId]);
  if (existing?.disabled) return { rejected: true, disabled: true, reason: 'disabled' };
  let role;
  if (discordRole !== undefined) {
    role = admin ? 'admin' : discordRole;
    if (!role) {
      await listRefused(discordId, name, 'no mapped Discord role', now);
      return { rejected: true, reason: 'norole' };
    }
  } else {
    if (!existing && !admin && !allowNew) {
      await listRefused(discordId, name, 'not on the panel', now);
      return { rejected: true, reason: 'unknown' };
    }
    role = admin ? 'admin' : (existing?.role ?? 'tester');
  }
  if (!existing) {
    await q('INSERT INTO users (discord_id, name, avatar, role, legacy, created_at, last_login_at) VALUES (?, ?, ?, ?, 0, ?, ?)', [discordId, name, avatar, role, now, now]);
    if (discordRole !== undefined) await logRoleChange({ at: now, discordId, name, from: null, to: role, source: admin ? 'ADMIN_DISCORD_IDS' : 'discord roles' });
  } else {
    await q('UPDATE users SET name = ?, avatar = ?, last_login_at = ?, role = ? WHERE id = ?', [name ?? existing.name, avatar ?? existing.avatar, now, role, existing.id]);
    if (existing.role !== role) await logRoleChange({ at: now, discordId, name: name ?? existing.name, from: existing.role, to: role, source: admin ? 'ADMIN_DISCORD_IDS' : 'discord roles' });
  }
  return { user: await one('SELECT * FROM users WHERE discord_id = ?', [discordId]) };
}

function page(title, body, status = 200) {
  return { status, html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:520px;padding:32px;background:#171a21;border-radius:12px}a{color:#7aa2ff}code{background:#222;padding:2px 6px;border-radius:4px}</style>
</head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>` };
}
const sendPage = (reply, p) => reply.code(p.status).type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(p.html);

const safeNext = (n) => (typeof n === 'string' && n.startsWith(`${config().basePath}/`) && !n.startsWith('//') && !/[\r\n\\]/.test(n) ? n : `${config().basePath}/`);

export function authRoutes(app, { fetchFn = fetch } = {}) {
  const base = config().basePath;

  app.get(`${base}/auth/login`, async (req, reply) => {
    if (!oauthConfigured()) {
      return sendPage(reply, page('Login is not set up yet', `<p>Discord OAuth is <b>not configured</b> on this panel: <code>DISCORD_CLIENT_SECRET</code> is empty in <code>/etc/kora-qa/secrets.env</code>.</p>
<p>An admin needs to copy the Client Secret of the bot's Discord application (Developer Portal → OAuth2) and add the redirect <code>${esc(redirectUri())}</code>, then restart the panel.</p>`, 503));
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const next = safeNext(req.query?.next);
    const value = `${nonce}.${Buffer.from(next).toString('base64url')}.${hmac(`${nonce}.${next}`)}`;
    reply.setCookie(STATE_COOKIE, value, cookieOpts(`${base}/auth`, 10 * 60 * 1000));
    const u = new URL(`${DISCORD}/oauth2/authorize`);
    u.search = new URLSearchParams({ client_id: config().discordClientId, redirect_uri: redirectUri(), response_type: 'code', scope: oauthScope(), state: nonce, prompt: 'none' }).toString();
    return reply.redirect(u.toString(), 302);
  });

  app.get(`${base}/auth/callback`, async (req, reply) => {
    if (!oauthConfigured()) return sendPage(reply, page('Login is not set up yet', '<p>Discord OAuth is not configured.</p>', 503));
    const { code, state, error } = req.query ?? {};
    const cookie = String(req.cookies?.[STATE_COOKIE] ?? '');
    reply.clearCookie(STATE_COOKIE, { path: `${base}/auth` });
    if (error) return sendPage(reply, page('Login cancelled', `<p>Discord said: ${esc(error)}.</p><p><a href="${esc(base)}/auth/login">Try again</a></p>`, 400));
    const [nonce, nextB64, sig] = cookie.split('.');
    const next = nextB64 ? Buffer.from(nextB64, 'base64url').toString() : '';
    const okSig = sig && nonce && crypto.timingSafeEqual(Buffer.from(sha(sig)), Buffer.from(sha(hmac(`${nonce}.${next}`))));
    if (!okSig || typeof state !== 'string' || state !== nonce || typeof code !== 'string' || !code) {
      return sendPage(reply, page('Login failed', `<p>The login state did not match (expired, or opened in another browser).</p><p><a href="${esc(base)}/auth/login">Try again</a></p>`, 400));
    }
    let profile;
    let discordRole;
    try {
      const tok = await fetchFn(`${DISCORD}/api/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config().discordClientId, client_secret: config().discordClientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri() }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      const tj = await tok.json().catch(() => ({}));
      if (!tok.ok || !tj.access_token) throw new Error(`token exchange failed (HTTP ${tok.status})`);
      const me = await fetchFn(`${DISCORD}/api/users/@me`, { headers: { Authorization: `Bearer ${tj.access_token}` }, signal: AbortSignal.timeout(10000) });
      profile = await me.json();
      if (!me.ok || !/^\d{15,25}$/.test(String(profile?.id))) throw new Error(`profile fetch failed (HTTP ${me.status})`);
      if (guildRolesOn()) {
        const mr = await fetchFn(`${DISCORD}/api/v10/users/@me/guilds/${config().discordGuildId}/member`, { headers: { Authorization: `Bearer ${tj.access_token}` }, signal: AbortSignal.timeout(10000) });
        if (mr.status === 404) discordRole = null; // not a member of the guild
        else if (mr.status === 401 || mr.status === 403) { const err = new Error(`member fetch refused (HTTP ${mr.status}); was guilds.members.read granted?`); err.page = 'scope'; throw err; }
        else if (!mr.ok) throw new Error(`member fetch failed (HTTP ${mr.status})`);
        else {
          const member = await mr.json();
          discordRole = mapDiscordRoles(Array.isArray(member?.roles) ? member.roles.map(String) : []);
        }
      }
    } catch (e) {
      if (e.page === 'scope') {
        req.log.warn(`[auth] ${e.message}`);
        return sendPage(reply, page('Login failed', `<p>The panel needs to see your roles on the Kora Discord server. Please log in again and allow the requested permissions.</p><p><a href="${esc(base)}/auth/login">Try again</a></p>`, 403));
      }
      req.log.warn(`[auth] ${e.message}`);
      return sendPage(reply, page('Login failed', `<p>Could not complete the Discord login.</p><p><a href="${esc(base)}/auth/login">Try again</a></p>`, 502));
    }
    const out = await loginUser({ discordId: String(profile.id), name: String(profile.global_name ?? profile.username ?? 'unknown').slice(0, 100), avatar: profile.avatar ? String(profile.avatar).slice(0, 200) : null, discordRole });
    if (out.disabled) return sendPage(reply, page('Access removed', '<p>Your access to the QA panel has been disabled by an admin.</p>', 403));
    if (out.reason === 'norole') {
      return sendPage(reply, page('No access', `<p>The QA panel is for the Kora Discord server's <b>Early Testers</b> and <b>Mods</b>. Your account (<code>${esc(profile.id)}</code>) is not on the server or has neither role.</p><p>If you just got the role, <a href="${esc(base)}/auth/login">log in again</a>.</p>`, 403));
    }
    if (out.rejected) {
      return sendPage(reply, page('Not on the panel yet', `<p>Your Discord account (<code>${esc(profile.id)}</code>) is not a tester on this panel yet. Ask an admin to add you; your login attempt is listed for them.</p>`, 403));
    }
    await createSession(out.user.id, reply);
    return reply.redirect(safeNext(next), 302);
  });

  app.post(`${base}/auth/logout`, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await q('DELETE FROM sessions WHERE id = ?', [sha(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: base });
    return { ok: true };
  });

  // Local testing only: DEV_LOGIN=1 and a direct loopback request (never through nginx).
  app.get(`${base}/auth/dev-login`, async (req, reply) => {
    if (!config().devLogin || !isDirectLoopback(req)) return reply.code(404).send({ error: 'not found' });
    const discordId = String(req.query?.discordId ?? '');
    if (!/^\d{15,25}$/.test(discordId)) return reply.code(400).send({ error: 'discordId must be a Discord id' });
    const role = ['tester', 'dev', 'admin'].includes(req.query?.role) ? req.query.role : null;
    const out = await loginUser({ discordId, name: String(req.query?.name ?? `dev-${discordId.slice(-4)}`).slice(0, 100), avatar: null }, { allowNew: true });
    if (out.rejected) return reply.code(403).send({ error: 'user is disabled' });
    if (role) await q('UPDATE users SET role = ? WHERE id = ?', [role, out.user.id]);
    await createSession(out.user.id, reply);
    if (req.query?.redirect === '0') return { ok: true, user: userView(await one('SELECT * FROM users WHERE id = ?', [out.user.id])) };
    return reply.redirect(safeNext(req.query?.next), 302);
  });
}

export async function purgeSessions() {
  await q('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
}
