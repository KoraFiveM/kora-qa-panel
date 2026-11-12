#!/usr/bin/env node
// Converts the communitybot legacy tests (538 game tests + 837 checklist features) to Gherkin (PLAN §11).
// Staging only: writes <out>/<resource>/tests/*.feature + qa.lua, conversion-report.md, mapping.json, results.json.
//
//   node scripts/convert-legacy.mjs [--only kora_hud,kora_vehiclekeys] [--out /var/lib/kora-qa/conversion]
//        [--res-dir DIR] [--bot-dir DIR] [--batch 20] [--concurrency 3] [--budget 2] [--max-calls N] [--offline]
//        [--previous <out>/v1/results.json]   second pass: keep (cached) v1 steps, re-convert only batches the v2 catalog
//                                             / ui-ids can improve (prompt v2), then grade merges (partial -> un-merged)
//
// Claude: Sonnet (claude-sonnet-5-5), effort medium, same CLI + OAuth token as the fixer; responses cached in
// <out>/cache/<hash>.json (re-runs don't re-spend). --offline = cache only, no new calls.
// mapping.json: { v, generatedAt, game: { <legacyId>: <scenarioId>|null }, checklist: { "<resource>:<featureId>": <scenarioId>|null } }
// (written as mapping.partial.json with --only).
import { convert } from './lib/convert/convert.js';

const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

const only = opt('--only');
const res = await convert({
  outDir: opt('--out', '/var/lib/kora-qa/conversion'),
  resDir: opt('--res-dir', process.env.RES_DIR ?? '/home/DevTestingKora/kora/server/txData/kora dev/resources'),
  botDir: opt('--bot-dir', '/home/DiscordBots/communitybot'),
  only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
  batchSize: Number(opt('--batch', 20)),
  concurrency: Math.min(3, Number(opt('--concurrency', 3))),
  budgetUsd: Number(opt('--budget', 2)),
  maxCalls: Number(opt('--max-calls', Infinity)),
  offline: flag('--offline'),
  previous: opt('--previous'),
  uiFile: opt('--ui-ids', '/home/DevTestingKora/kora/server/txData/kora dev/resources/[kora]/kora_qa/shared/ui-ids.json'),
  log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
});
if (args.length) console.error(`ignored arguments: ${args.join(' ')}`);
const count = (s) => res.entries.filter((e) => e.status === s).length;
console.log(`converted ${count('converted')} (manual-only ${res.entries.filter((e) => e.status === 'converted' && e.manualOnly).length}), merged ${count('merged')}, unconvertible ${count('unconvertible')}`);
console.log(`model calls: ${res.stats.calls} new (${res.stats.failed} failed), ${res.stats.cached} cached, new cost $${res.stats.costUsd.toFixed(2)}, total $${res.stats.totalCostUsd.toFixed(2)}`);
if (res.fileErrors.length) { console.log('file validation errors:'); for (const e of res.fileErrors) console.log(`  ${e}`); }
