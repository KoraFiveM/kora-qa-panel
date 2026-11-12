// XP outbox sender (QA-CONTRACTS §7). Pending rows (sent_at NULL) are POSTed to BOT_XP_URL with exponential backoff per
// row (5s, 10s, 20s ... capped at 30 min) until the bot answers 200 {ok:true}. The bot is idempotent per (issueId, event,
// discordId), so a retry after a lost answer is harmless.
import { q } from './db.js';
import { config } from './config.js';
import { bus } from './events.js';

export const BASE_DELAY = 5000;
export const MAX_DELAY = 30 * 60 * 1000;
export const backoff = (attempts) => Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.max(0, attempts - 1));

const nextAt = new Map(); // outbox id -> earliest next try (ms)

export async function sendOne(row, { url = config().botXpUrl, secret = config().xpSecret, fetchFn = fetch } = {}) {
  const body = JSON.stringify({ discordId: row.discord_id, event: row.event, issueId: row.issue_id, at: Number(row.at) });
  const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  if (res.status !== 200 || !parsed?.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return parsed;
}

// One pass over due rows. Returns { sent, failed }.
export async function flushOutbox({ now = Date.now(), limit = 50, ...opts } = {}) {
  const rows = await q('SELECT * FROM xp_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?', [limit]);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if ((nextAt.get(row.id) ?? 0) > now) continue;
    try {
      await sendOne(row, opts);
      await q('UPDATE xp_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?', [Date.now(), row.id]);
      nextAt.delete(row.id);
      sent++;
    } catch (error) {
      const attempts = (row.attempts ?? 0) + 1;
      await q('UPDATE xp_outbox SET attempts = ?, last_error = ? WHERE id = ?', [attempts, String(error?.message ?? error).slice(0, 1000), row.id]);
      nextAt.set(row.id, Date.now() + backoff(attempts));
      failed++;
    }
  }
  return { sent, failed };
}

export function startXpWorker({ intervalMs = 5000, log = console } = {}) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await flushOutbox(); } catch (error) { log.error?.('[xp] flush failed:', error?.message ?? error); }
    running = false;
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const onXp = () => { setImmediate(tick); };
  bus.on('xp', onXp);
  setImmediate(tick);
  return () => { stopped = true; clearInterval(timer); bus.off('xp', onXp); };
}

export const _resetBackoff = () => nextAt.clear();
