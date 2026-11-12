// Entry point: migrate, start the panel (127.0.0.1:PANEL_PORT) and the bughook-compatible hook (127.0.0.1:HOOK_PORT),
// then the workers: XP outbox sender, scenario scan + watcher, retest notices, session purge.
import { config } from './config.js';
import { migrate } from './migrate.js';
import { closePool, one } from './db.js';
import { buildApp } from './app.js';
import { startHook, ctlRequest } from './hook.js';
import { startXpWorker } from './xp.js';
import { runScan, startWatcher } from './scenarios/service.js';
import { purgeSessions } from './auth.js';
import { bus } from './events.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const cfg = config();
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) throw new Error('SESSION_SECRET missing or too short');
  if (!cfg.gameSecret || cfg.gameSecret.length < 32) throw new Error('KORA_QA_GAME_SECRET missing or too short');
  await migrate({ log });

  const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.listen({ port: cfg.panelPort, host: '127.0.0.1' });
  log(`[panel] listening on 127.0.0.1:${cfg.panelPort} (${cfg.publicUrl})`);

  let hook = null;
  try {
    hook = await startHook({ port: cfg.hookPort });
    log(`[hook] bughook-compatible API on 127.0.0.1:${cfg.hookPort}`);
  } catch (error) {
    log(`[hook] NOT started: ${error.message}`);
  }

  const stops = [];
  if (cfg.workers) {
    stops.push(startXpWorker());
    runScan().then((s) => log(`[scenarios] scan: ${s.scenarios} scenarios (${s.valid} valid, ${s.invalid} invalid) from ${s.resources.length} resources${s.catalog.error ? `; catalog: ${s.catalog.error}` : ''}`))
      .catch((e) => log(`[scenarios] scan failed: ${e.message}`));
    const w = startWatcher({ onScan: (s) => log(`[scenarios] rescan: ${s.changed} changed, ${s.removed} removed`) });
    stops.push(() => w.stop());
    // In-game "retest ready" notice to the reporter when an issue reaches awaiting_test.
    const onStatus = async (e) => {
      if (e.to !== 'awaiting_test') return;
      try {
        const issue = await one('SELECT title, reporter_discord_id FROM issues WHERE id = ?', [e.issueId]);
        if (!issue?.reporter_discord_id) return;
        await ctlRequest({ cmd: 'notify', discordId: issue.reporter_discord_id, title: 'Retest ready', message: `A fix for "${String(issue.title ?? '').slice(0, 80)}" is live. Open /qa to retest it.` }, { timeoutMs: 5000 });
      } catch { /* FXServer down or kora_qa not started: the retest queue still lists it */ }
    };
    bus.on('status', onStatus);
    stops.push(() => bus.off('status', onStatus));
    const t = setInterval(() => purgeSessions().catch(() => {}), 3600 * 1000);
    t.unref();
    stops.push(() => clearInterval(t));
  }

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    log(`[panel] ${sig}: shutting down`);
    for (const s of stops) try { s(); } catch { /* ignore */ }
    hook?.close();
    await app.close().catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('[panel] failed to start:', error.message);
  await closePool().catch(() => {});
  process.exit(1);
});
