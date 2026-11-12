// Legacy test sources (communitybot) -> normalised records the converter works on.
//   game:      assets/test-triage/items.json   {items:[{id,title,group,target,description,setup?,needsAdmin?,needsPlayers?,bug?,tp?}]}
//   checklist: assets/tester-checklist/features.json {resources:[{resource,folder,category,description,features:[{id,name,test}]}]}
//   spots:     data/test-spots.json {v, spots:{<testId>:[spot]}, proposals:{<testId>:[spot+source]}}
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BOT_DIR = '/home/DiscordBots/communitybot';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function slug(s) {
  return String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

const WORDS = { two: 2, three: 3, four: 4, five: 5 };
// "Needs 2 testers …" / "Needs a Mod and 2 testers" / "Needs 4 or more testers" in the description's first lines.
export function playersFromText(text) {
  const m = /^\s*Needs (?:a Mod and |a Mod, )?(\d+|two|three|four|five) (?:or more )?(?:testers|players|people)\b/im.exec(String(text ?? ''));
  if (!m) return null;
  const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
  return n > 1 ? Math.min(32, n) : null;
}

// The tester themself needs admin/Mod rights: a game test whose "Needs …" line asks for a Mod/dev/admin, or a
// checklist line written "as admin" / "admin-only" ("staff" only in kora_admin, elsewhere it means business staff).
export function adminFromText(text, { kind = 'game', resource = '' } = {}) {
  const t = String(text ?? '');
  if (kind === 'game') return /^\s*Needs (?:a Mod|a dev|an admin|admin|staff)\b/im.test(t);
  if (/\b(?:as (?:an? )?(?:admin|mod)\b|admin[- ]only|requires? admin|\(admin\)|with admin (?:perms|permissions|access|rights))/i.test(t)) return true;
  return resource === 'kora_admin' && /\bas staff\b/i.test(t);
}

// Normalises one game test. Unknown extra fields are kept in `raw`. needsPlayers: the field, else derived from the
// description's "Needs N testers" line (needsPlayersDerived = true).
export function normalizeGame(t) {
  const field = Number(t.needsPlayers) > 1 ? Math.min(32, Math.floor(Number(t.needsPlayers))) : null;
  const derived = field ? null : playersFromText(t.description);
  const needsPlayers = field ?? derived;
  return {
    kind: 'game',
    key: String(t.id),
    id: String(t.id),
    resource: String(t.group),
    title: String(t.title ?? t.id).trim(),
    description: String(t.description ?? '').replace(/\r/g, ''),
    setup: t.setup ? String(t.setup).replace(/\r/g, '') : null,
    target: Number.isInteger(Number(t.target)) && Number(t.target) >= 1 ? Math.min(50, Number(t.target)) : 1,
    needsAdmin: !!t.needsAdmin || adminFromText(t.description),
    needsAdminDerived: !t.needsAdmin && adminFromText(t.description),
    needsPlayers,
    needsPlayersDerived: !!derived,
    bug: !!t.bug,
    tp: Array.isArray(t.tp) ? t.tp : [],
    raw: t,
  };
}

export function normalizeChecklist(res, f) {
  return {
    kind: 'checklist',
    key: `checklist:${res.resource}:${f.id}`,
    id: String(f.id),
    resource: String(res.resource),
    category: String(res.category ?? 'Uncategorised'),
    needsAdmin: adminFromText(f.test, { kind: 'checklist', resource: res.resource }),
    needsAdminDerived: adminFromText(f.test, { kind: 'checklist', resource: res.resource }),
    title: String(f.name ?? f.id).trim(),
    description: String(f.test ?? '').replace(/\r/g, ''),
    raw: f,
  };
}

export function loadSources(botDir = DEFAULT_BOT_DIR) {
  const items = readJson(path.join(botDir, 'assets', 'test-triage', 'items.json'));
  const features = readJson(path.join(botDir, 'assets', 'tester-checklist', 'features.json'));
  let spots = { spots: {}, proposals: {} };
  try { spots = readJson(path.join(botDir, 'data', 'test-spots.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const game = (Array.isArray(items) ? items : items.items ?? []).map(normalizeGame);
  const checklist = [];
  const resourceInfo = {};
  for (const r of features.resources ?? []) {
    resourceInfo[r.resource] = { category: r.category, description: r.description, folder: r.folder };
    for (const f of r.features ?? []) checklist.push(normalizeChecklist(r, f));
  }
  const seen = new Set();
  for (const t of [...game, ...checklist]) {
    if (seen.has(t.key)) throw new Error(`duplicate legacy id ${t.key}`);
    seen.add(t.key);
  }
  return { game, checklist, resourceInfo, spots: { spots: spots.spots ?? {}, proposals: spots.proposals ?? {} } };
}
