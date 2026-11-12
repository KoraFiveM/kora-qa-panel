// Read-only Discord REST client for the import: plain fetch with `Authorization: Bot <token>` (no gateway), per-route rate
// limit buckets from the X-RateLimit-* headers, 429 retry_after (global too), 5xx backoff, and a file cache of raw responses
// (DATA_DIR/import/discord-cache) so re-runs don't refetch unless refresh. Only GETs exist here: nothing can write to Discord.
import fs from 'node:fs';
import path from 'node:path';
import { sleep as realSleep } from './util.js';

const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://zap.ssite.co.uk/qa, 1.0) kora-qa-import';

export class DiscordError extends Error {
  constructor(status, code, message) {
    super(`discord ${status}${code ? ` (${code})` : ''}: ${message ?? ''}`.trim());
    this.status = status;
    this.code = code ?? null;
  }
}

// 403/404 are permanent for our purposes (deleted thread, no access) and are cached; anything else is retried / rethrown.
export const isPermanent = (e) => e instanceof DiscordError && (e.status === 403 || e.status === 404);

const cmpId = (a, b) => { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

export function createDiscord({ token, fetchImpl = globalThis.fetch, cacheDir, refresh = false, offline = false, writeCache = true,
  maxRetries = 6, sleep = realSleep, now = Date.now, log = () => {} }) {
  if (!offline && !token) throw new Error('no Discord bot token');
  const stats = { requests: 0, cacheHits: 0, cacheMisses: 0, rateLimited: 0, globalRateLimited: 0, waitedMs: 0, preemptiveWaits: 0, retries5xx: 0, downloads: 0, downloadBytes: 0, downloadFailures: 0, maxRetryAfterMs: 0 };
  const buckets = new Map();
  let globalUntil = 0;

  const wait = async (ms, why) => {
    if (ms <= 0) return;
    stats.waitedMs += ms;
    if (why === 'pre') stats.preemptiveWaits++;
    await sleep(ms);
  };

  async function request(pathname) {
    const route = pathname.split('?')[0];
    for (let attempt = 0; ; attempt++) {
      await wait(globalUntil - now(), 'global');
      const b = buckets.get(route);
      if (b && b.remaining <= 0 && b.resetAt > now()) await wait(b.resetAt - now() + 50, 'pre');
      let res;
      try {
        res = await fetchImpl(`${API}${pathname}`, { headers: { Authorization: `Bot ${token}`, 'User-Agent': UA } });
      } catch (error) {
        if (attempt >= maxRetries) throw new Error(`discord network error on ${route}: ${error.message}`);
        await wait(1000 * 2 ** Math.min(attempt, 5));
        continue;
      }
      stats.requests++;
      const h = (k) => res.headers?.get?.(k) ?? null;
      const remaining = h('x-ratelimit-remaining');
      const resetAfter = h('x-ratelimit-reset-after');
      if (remaining !== null && resetAfter !== null) buckets.set(route, { remaining: Number(remaining), resetAt: now() + Number(resetAfter) * 1000 });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const ra = Number(body.retry_after ?? h('retry-after') ?? 1);
        const ms = Math.ceil((Number.isFinite(ra) ? ra : 1) * 1000) + 100;
        stats.rateLimited++;
        stats.maxRetryAfterMs = Math.max(stats.maxRetryAfterMs, ms);
        if (body.global || h('x-ratelimit-global')) { stats.globalRateLimited++; globalUntil = now() + ms; }
        log(`[discord] 429 on ${route}, waiting ${ms} ms${body.global ? ' (global)' : ''}`);
        if (attempt >= maxRetries + 4) throw new DiscordError(429, null, 'rate limited too many times');
        await wait(Math.min(ms, 120000), 'retry');
        continue;
      }
      if (res.status >= 500) {
        stats.retries5xx++;
        if (attempt >= maxRetries) throw new DiscordError(res.status, null, 'server error');
        await wait(1000 * 2 ** Math.min(attempt, 5));
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new DiscordError(res.status, body.code, body.message);
      }
      return res.json();
    }
  }

  const cacheFile = (kind, id) => path.join(cacheDir, `${kind}-${id}.json`);
  const readCache = (kind, id) => {
    try { return JSON.parse(fs.readFileSync(cacheFile(kind, id), 'utf8')); } catch { return null; }
  };
  const saveCache = (kind, id, value) => {
    if (!writeCache) return;
    fs.mkdirSync(cacheDir, { recursive: true });
    const f = cacheFile(kind, id);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(value));
    fs.renameSync(`${f}.tmp`, f);
  };

  // -> { fetchedAt, data } | { fetchedAt, error:{status,code,message} } | { missing:true } (offline, not cached). fromCache marks hits.
  async function cached(kind, id, fetcher, { force = false } = {}) {
    if (!(refresh || force)) {
      const c = readCache(kind, id);
      if (c) { stats.cacheHits++; return { ...c, fromCache: true }; }
    }
    if (offline) { const c = readCache(kind, id); return c ? { ...c, fromCache: true } : { missing: true }; }
    stats.cacheMisses++;
    try {
      const value = { fetchedAt: now(), data: await fetcher() };
      saveCache(kind, id, value);
      return value;
    } catch (error) {
      if (!isPermanent(error)) throw error;
      const value = { fetchedAt: now(), error: { status: error.status, code: error.code, message: error.message } };
      saveCache(kind, id, value);
      return value;
    }
  }

  const channel = (id, opts) => cached('channel', id, () => request(`/channels/${id}`), opts);
  const user = (id, opts) => cached('user', id, () => request(`/users/${id}`), opts);

  // Every message of a channel/thread, oldest first (paged forward with after=).
  const messages = (id, opts) => cached('messages', id, async () => {
    const all = new Map();
    let after = '0';
    for (;;) {
      const page = await request(`/channels/${id}/messages?limit=100&after=${after}`);
      if (!Array.isArray(page) || !page.length) break;
      for (const m of page) all.set(m.id, m);
      after = page.map((m) => m.id).sort(cmpId).at(-1);
      if (page.length < 100) break;
    }
    return [...all.values()].sort((a, b) => cmpId(a.id, b.id));
  }, opts);

  // Downloads a CDN attachment (no auth header) to abs via a temp file. -> { size, mime }. Throws { status } on HTTP errors.
  async function download(url, abs) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
      } catch (error) {
        if (attempt >= 3) { stats.downloadFailures++; throw Object.assign(new Error(`download failed: ${error.message}`), { status: 0 }); }
        await wait(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 4) { stats.downloadFailures++; throw Object.assign(new Error(`download HTTP ${res.status}`), { status: res.status }); }
        const ra = Number(res.headers?.get?.('retry-after') ?? 1);
        if (res.status === 429) stats.rateLimited++;
        await wait((Number.isFinite(ra) ? ra : 1) * 1000 + 250 * attempt, 'retry');
        continue;
      }
      if (!res.ok) { stats.downloadFailures++; throw Object.assign(new Error(`download HTTP ${res.status}`), { status: res.status }); }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(`${abs}.part`, buf, { mode: 0o640 });
      fs.renameSync(`${abs}.part`, abs);
      stats.downloads++;
      stats.downloadBytes += buf.length;
      return { size: buf.length, mime: res.headers?.get?.('content-type') ?? null };
    }
  }

  // Fetches a small text attachment (fix prompt .md) into memory.
  async function fetchText(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw Object.assign(new Error(`download HTTP ${res.status}`), { status: res.status });
    stats.downloads++;
    const t = await res.text();
    stats.downloadBytes += Buffer.byteLength(t);
    return t;
  }

  return { request, channel, user, messages, download, fetchText, stats, readCache };
}

// Plain text of a message for the panel: content + embeds (title, description, fields, footer) + Components V2 text displays.
export function messageText(m) {
  const parts = [];
  if (m.content) parts.push(m.content);
  for (const e of m.embeds ?? []) {
    const lines = [];
    if (e.author?.name) lines.push(`_${e.author.name}_`);
    if (e.title) lines.push(`**${e.title}**`);
    if (e.description) lines.push(e.description);
    for (const f of e.fields ?? []) lines.push(`**${f.name}:** ${f.value}`);
    if (e.footer?.text) lines.push(`-# ${e.footer.text}`);
    if (lines.length) parts.push(lines.join('\n'));
  }
  const walk = (cs) => {
    for (const c of cs ?? []) {
      if (c.type === 10 && c.content) parts.push(c.content);
      if (c.components) walk(c.components);
      if (c.accessory?.type === 10 && c.accessory.content) parts.push(c.accessory.content);
    }
  };
  walk(m.components);
  return parts.join('\n\n');
}

// Message types that carry user/bot content (default, reply, slash command, context menu). System notices are skipped.
export const CONTENT_TYPES = new Set([0, 19, 20, 23]);
