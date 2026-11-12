#!/usr/bin/env node
// Links legacy_tests.scenario_id to the converted scenarios. Idempotent; re-run after any re-scan or re-conversion.
//
//   node scripts/link-legacy-scenarios.mjs [--mapping /var/lib/kora-qa/conversion/mapping.json] [--no-scan] [--dry-run]
//
// 1. Runs the panel's scenario scan (server/scenarios/service.js runScan) so the scenarios table matches RES_DIR.
// 2. Truth = the scanned scenarios' own tags (@legacy:<id>, @checklist:<resource>:<featureId>), valid and not removed.
//    mapping.json (from convert-legacy.mjs) is cross-checked: disagreements are reported, the scanned tag wins.
// 3. legacy_tests ids: game = <id>, checklist = <resource>:<featureId> (import-legacy convention). Only rows whose
//    scenario_id differs are updated; links to scenarios that vanished are cleared.
// Reads the DB from /etc/kora-qa/*.env like the server.
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const dryRun = args.includes('--dry-run');
const noScan = args.includes('--no-scan');
const mappingFile = opt('--mapping', '/var/lib/kora-qa/conversion/mapping.json');

const { q, closePool } = await import('../server/db.js');
const { runScan } = await import('../server/scenarios/service.js');

try {
  if (!noScan) {
    const s = await runScan();
    console.log(`scan: ${s.scenarios} scenarios (${s.valid} valid, ${s.invalid} invalid), ${s.changed} changed, ${s.removed} removed, ${s.resources.length} resources`);
  }
  const rows = await q('SELECT id, legacy_ids, valid, removed FROM scenarios');
  const fromTags = new Map(); // legacy_tests.id -> scenario id
  const dupTags = [];
  for (const r of rows) {
    if (!Number(r.valid) || Number(r.removed)) continue;
    for (const l of r.legacy_ids ?? []) {
      const key = l.startsWith('legacy:') ? l.slice(7) : l.startsWith('checklist:') ? l.slice(10) : null;
      if (!key) continue;
      if (fromTags.has(key) && fromTags.get(key) !== r.id) dupTags.push(`${key}: ${fromTags.get(key)} and ${r.id}`);
      else fromTags.set(key, r.id);
    }
  }
  const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  const fromMap = new Map([...Object.entries(mapping.game ?? {}), ...Object.entries(mapping.checklist ?? {})]);
  const mismatches = [];
  for (const [k, v] of fromMap) if ((v ?? null) !== (fromTags.get(k) ?? null)) mismatches.push(`${k}: mapping ${v ?? 'null'} vs scan ${fromTags.get(k) ?? 'none'}`);

  const legacy = await q('SELECT id, source, scenario_id FROM legacy_tests');
  let set = 0, same = 0, cleared = 0, none = 0;
  const unlinked = [];
  for (const t of legacy) {
    const want = fromTags.get(t.id) ?? null;
    if ((t.scenario_id ?? null) === want) { if (want) same++; else { none++; unlinked.push(`${t.source}:${t.id}`); } continue; }
    if (!dryRun) await q('UPDATE legacy_tests SET scenario_id = ? WHERE id = ?', [want, t.id]);
    if (want) set++; else { cleared++; unlinked.push(`${t.source}:${t.id}`); }
  }
  const known = new Set(legacy.map((t) => t.id));
  const tagsWithoutRow = [...fromTags.keys()].filter((k) => !known.has(k));
  console.log(`${dryRun ? '(dry run) ' : ''}legacy_tests: ${legacy.length} rows; linked now ${set}, already linked ${same}, cleared ${cleared}, without a scenario ${none + cleared}`);
  console.log(`mapping.json vs scan: ${mismatches.length} disagreement(s)${mismatches.length ? `\n  ${mismatches.slice(0, 20).join('\n  ')}` : ''}`);
  if (dupTags.length) console.log(`legacy id tagged on several scenarios: ${dupTags.length}\n  ${dupTags.slice(0, 20).join('\n  ')}`);
  if (tagsWithoutRow.length) console.log(`scenario legacy tags with no legacy_tests row: ${tagsWithoutRow.length} (${tagsWithoutRow.slice(0, 10).join(', ')})`);
  if (unlinked.length) console.log(`legacy tests without a scenario (${unlinked.length}): ${unlinked.slice(0, 40).join(', ')}${unlinked.length > 40 ? ' …' : ''}`);
} finally {
  await closePool();
}
