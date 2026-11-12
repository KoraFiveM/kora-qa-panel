// Prompt + output schema for one batch (~20 tests of one resource). The model writes ONLY the steps.
export const FORBIDDEN_STEPS = new Set(['teleport.coords', 'teleport.coords_heading', 'mark.fires']);

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scenarios'],
  properties: {
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'steps', 'unmapped', 'duplicate_of'],
        properties: {
          id: { type: 'string', description: 'the id of the test exactly as given' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Gherkin step lines, each starting with Given/When/Then/And/But' },
          unmapped: { type: 'array', items: { type: 'string' }, description: 'candidate new catalog step patterns for what you had to write as I manually:/I confirm:' },
          duplicate_of: { type: ['string', 'null'], description: 'checklist items only: id of the game test of the same resource that covers the same behaviour, else null' },
        },
      },
    },
  },
};

export const SYSTEM = `You convert legacy, free-text manual QA tests for a FiveM roleplay server into Gherkin steps for an in-game test runner (kora_qa).
You write ONLY the step lines of each scenario. Tags, the scenario name and the original description are added by a script; do not output them.

Hard rules
1. Every step must match exactly one pattern of the STEP CATALOG you are given (Cucumber Expressions: {string} = a "double-quoted" value, {int} a whole number, {float} a number, {word} one word without quotes, {} anything to the end of the line). Copy the fixed words of a pattern exactly; "a/an/the" means one of those words.
2. Start each line with a keyword: Given for setup, When for actions/observed steps and "I manually:", Then for checks and "I confirm:". Use And for the second and later lines of the same kind. One step per line, no line breaks inside a step.
3. Setup (Given) is ONLY catalog setup steps and ONLY for preconditions the original test states or clearly requires (e.g. "with a vehicle you have keys to", "with at least $500 cash", "as police", "be dead", "use a lockpick" -> I have 1 "lockpick"). Never invent extra preconditions and never invent values the original does not give (plates, metadata values, player ids, amounts, job names): if a value is needed but unknown, that part is manual. If a feature only works when a config option is enabled or a config list is filled and the default is off/empty, do NOT set anything up: write manual steps ("When I manually: check with a dev that Config.X is enabled" is NOT allowed — testers are players; instead "Then I confirm: … (only applies when Config.X is enabled; otherwise mark Pass if nothing happens)" style wording is fine). Respect the caps given. Everything is undone automatically after the run, so never write cleanup steps.
   All setup steps come first, before any When/Then (the runner executes them up front).
   "a {string} is spawned in front of me" leaves the tester on foot next to it; "I am in the driver seat of a {string}" puts them inside. Pick the one matching the test's first action.
   If you write "When I use a/an/the {string}", the tester must own that item: add "Given I have 1 \"<item>\"" unless the original says the item comes from somewhere else.
4. Use only real names: items from ITEMS, jobs/gangs from LISTS, locations ONLY from LOCATION ALIASES (never raw coordinates; if no alias fits, tell the tester where to go with "When I manually: go to …"), commands only from COMMANDS or ones the original text itself mentions. Vehicles: a vehicle alias, or a stock GTA V model name only when the test needs any vehicle (prefer "sultan" for a car, "bati" for a bike). Peds/props: only when the test needs one, stock GTA V model names.
5. Automatic checks only observe the TESTER's own character and screen (the person running the scenario). Anything another player or a Mod sees, hears or receives (their notification, their inventory, their screen) is always "Then I confirm: the other player …". Automatic checks only when they verify exactly what the test expects:
   - notification text: only text quoted in the original test or one of NOTIFICATION TEXTS, copied exactly (a distinctive substring is fine).
   - "the {string} app opens" / "a menu titled {string} opens" / "the {string} callback is called" / "I select the {string} target option": only with names/labels that appear in the original test or the resource context. Otherwise use I confirm:.
   - inventory, money, item count, job, health, vehicle lock checks: fine when the test states the expected outcome.
6. Anything the catalog cannot express becomes a manual step: "When I manually: <imperative instruction>" or "Then I confirm: <observable expected result>". Write in the first person ("I", "my": "Then I confirm: my HUD shows …", never "you"/"your"). Keep the tester-facing wording concrete and short (one action or one expectation per step, max ~200 characters). Do not drop anything: every action and every "Expect:" clause of the original must be covered by some step, in the original order. Things only a human can judge (looks, flicker, layout, sound, smoothness, other players' screens) are always "I confirm:".
7. Steps that need another player or an admin: write what the tester does; the other player's part is "When I manually: ask a second player to …".
8. "I wait N seconds" only when the original asks to wait. Never use "I am at x, y, z" coordinates or "the … mark fires".
9. unmapped: for every I manually:/I confirm: you wrote that a reusable automatic step could have replaced, give one short candidate catalog pattern in Cucumber-expression style (e.g. "the seatbelt indicator is {word}", "the HUD shows {string}"). Use the same wording for the same idea across tests. Empty array when nothing is missing.
10. duplicate_of: only for items marked CHECKLIST. If a GAME TEST of the same resource (from the index you get) already tests the same behaviour (the checklist line would be fully covered by running that game test), give that game test's id and still write steps for the checklist item. Otherwise null. Game tests always null.
Return one entry per input item, same ids, in the same order.`;

function argSummary(def) {
  return (def.args ?? []).map((a) => `${a.name}${a.allow ? `:${a.allow}` : ''}${a.cap ? ` ≤${a.cap}` : ''}`).join(', ');
}

export function catalogText(steps, forbidden = FORBIDDEN_STEPS) {
  const lines = [];
  for (const kind of ['setup', 'observed', 'check', 'manual']) {
    lines.push(`## ${kind}`);
    for (const d of steps.filter((s) => s.kind === kind && !forbidden.has(s.id))) {
      const a = argSummary(d);
      lines.push(`- ${d.pattern}${a ? `   [${a}]` : ''}${d.example ? `   e.g. ${d.example}` : ''}`);
    }
  }
  return lines.join('\n');
}

const capsText = (caps) => JSON.stringify(Object.fromEntries(Object.entries(caps).filter(([k]) => ['maxItemCount', 'maxMoney', 'maxEntities', 'maxWaitSeconds', 'accounts', 'weather', 'inventoryTypes', 'modelDeny', 'metadataDeny', 'itemDeny'].includes(k))));

function aliasText(aliases, labels = {}) {
  const out = [];
  for (const [n, l] of Object.entries(aliases.locations ?? {})) out.push(`- location "${n}"${labels[n] ? ` — ${labels[n]}` : ''}`);
  for (const k of ['vehicles', 'peds', 'props']) for (const [n, m] of Object.entries(aliases[k] ?? {})) out.push(`- ${k.slice(0, -1)} "${n}" = ${typeof m === 'string' ? m : JSON.stringify(m)}`);
  for (const n of Object.keys(aliases.fixtures ?? {})) out.push(`- fixture "${n}"`);
  return out.join('\n') || '(none)';
}

function itemText(entry, spotsByTest) {
  const head = entry.kind === 'checklist'
    ? `### CHECKLIST id=${entry.id}\nName: ${entry.title}\nTest: ${entry.description}`
    : `### GAME TEST id=${entry.id}\nTitle: ${entry.title}${entry.needsAdmin ? '\n(Tester is an admin for this test.)' : ''}${entry.needsPlayers ? `\n(Needs ${entry.needsPlayers} players.)` : ''}${entry.setup ? `\nSetup: ${entry.setup}` : ''}\n${entry.description}`;
  const spots = entry.kind === 'game' ? spotsByTest[entry.id] : null;
  return spots?.length ? `${head}\n(Location alias for this test: ${spots.map((s) => `"${s}"`).join(', ')})` : head;
}

// batch: { resource, entries }, ctx: { steps, caps, aliases, aliasLabels, lists, facts, gameIndex, resourceInfo, spotsByTest }
export function buildPrompt(batch, c) {
  const f = c.facts ?? {};
  const parts = [];
  parts.push(`# STEP CATALOG (only these patterns exist)\n${catalogText(c.steps, c.forbidden ?? FORBIDDEN_STEPS)}`);
  parts.push(`# CAPS\n${capsText(c.caps)}`);
  parts.push(`# LISTS\njobs: ${c.lists.jobs.join(', ')}\ngangs: ${c.lists.gangs.join(', ')}`);
  parts.push(`# RESOURCE ${batch.resource}${c.resourceInfo?.description ? `\n${c.resourceInfo.description}` : ''}`);
  parts.push(`# LOCATION / VEHICLE / PED / PROP ALIASES usable in this resource\n${aliasText(c.aliases, c.aliasLabels)}`);
  parts.push(`# COMMANDS registered by ${batch.resource}\n${(f.commands ?? []).join(' ') || '(none)'}\nOther resources' commands (only if the test needs them): ${(c.otherCommands ?? []).join(' ')}`);
  parts.push(`# ITEMS (item names ${batch.resource} uses; any other must come from this full list)\nused here: ${(f.itemsUsed ?? []).join(', ') || '(none)'}\nall items: ${c.lists.items.join(', ')}`);
  if (f.callbacks?.length) parts.push(`# CALLBACKS\n${f.callbacks.join(', ')}`);
  if (f.notify?.length) parts.push(`# NOTIFICATION TEXTS / UI STRINGS found in the code\n${f.notify.map((s) => `- ${s}`).join('\n')}`);
  if (f.readme) parts.push(`# README (excerpt)\n${f.readme}`);
  if (f.config) parts.push(`# config.lua (excerpt)\n${f.config}`);
  if (batch.entries.some((e) => e.kind === 'checklist') && c.gameIndex?.length) {
    parts.push(`# GAME TEST INDEX for ${batch.resource} (for duplicate_of)\n${c.gameIndex.map((g) => `- ${g.id}: ${g.title}`).join('\n')}`);
  }
  parts.push(`# ITEMS TO CONVERT (${batch.entries.length})\n\n${batch.entries.map((e) => itemText(e, c.spotsByTest ?? {})).join('\n\n')}`);
  if (batch.retry?.length) {
    parts.push(`# YOUR PREVIOUS ATTEMPT FAILED VALIDATION — fix exactly these problems (use I manually:/I confirm: when a value is not allowed)\n${batch.retry.map((r) => `## id=${r.id}\nprevious steps:\n${r.steps.join('\n')}\nerrors:\n${r.errors.map((e) => `- ${e}`).join('\n')}`).join('\n\n')}`);
  }
  return parts.join('\n\n');
}

// ---- v2 (catalog 112 steps + ui-ids): re-conversion of batches that can use the new steps ---------------------------
export const SCHEMA_V2 = JSON.parse(JSON.stringify(SCHEMA));
SCHEMA_V2.properties.scenarios.items.required.push('needs_admin');
SCHEMA_V2.properties.scenarios.items.properties.needs_admin = { type: 'boolean', description: 'true when the tester themself must have admin/Mod permissions to run it (admin commands, console, txAdmin)' };

export const SYSTEM_V2 = `${SYSTEM.replace('Return one entry per input item, same ids, in the same order.', '').replace(
  '8. "I wait N seconds" only when the original asks to wait. Never use "I am at x, y, z" coordinates or "the … mark fires".',
  '8. "I wait N seconds" only when the original asks to wait. "I am at X, Y, Z" only with coordinates the original test itself gives. Mark steps ("the {string} mark fires…") only with marks listed under MARKS.',
)}
11. This is a SECOND PASS. The step catalog grew (keys, engine on/off, chat, HUD/minimap/seatbelt, app open, progress bar, text UI, notification title/type, consoles, armour, metadata changes, driver seat, fuel %). For every item you get the PREVIOUS CONVERSION. Keep it where it is fine; replace "I manually:"/"I confirm:" steps with catalog steps where a catalog step verifies or performs exactly the same thing (e.g. "I manually: press L" -> "When I press the \\"L\\" key"; "I confirm: the minimap hides" -> "Then the minimap should be hidden"). Do not lose any expectation.
   - App ids: "the {string} app opens" / "the {string} app should be open" only with ids from UI IDS. Menu titles: "a menu titled {string} opens" only with titles from UI IDS (a %s/%d placeholder stands for any text — fill in the real value only if the test gives it) or quoted in the test.
   - "the HUD should show {string}", "the F8 console should show {string}", "the F8 console should show no errors" are tester-judged (Pass/Fail) — prefer them over a free "I confirm:" when they fit.
12. Tester-facing steps describe what a PLAYER does (keys, commands, targets, items, walking). Never ask the tester to trigger an internal event/export/callback (e.g. "trigger qbvehiclekeys:client:lockpickUsed"). Phrase it as the player action that causes it; if there is no player path, write the admin command/console instruction a Mod would type and set needs_admin = true.
13. needs_admin: true only when the tester running the scenario must themself have admin/Mod permissions (they run admin commands, need txAdmin/server console). False when a Mod only helps ("ask a Mod to …").
Return one entry per input item, same ids, in the same order.`;

export function uiIdsText(ui, resource) {
  if (!ui) return '';
  const apps = ui.apps ?? [];
  const menus = ui.menus ?? [];
  const own = (x) => x.resource === resource;
  const fmtApp = (a) => `- app "${a.id}"${a.title ? ` (title "${a.title}")` : ''} — ${a.resource}`;
  const fmtMenu = (m) => `- ${m.kind ?? 'menu'} titled "${m.title}"${m.dynamic ? ' (dynamic)' : ''} — ${m.resource}`;
  return `# UI IDS (real AppShell app ids and menu/input titles)\n## ${resource}\n${[...apps.filter(own).map(fmtApp), ...menus.filter(own).map(fmtMenu)].join('\n') || '(none)'}\n## other resources\n${[...apps.filter((a) => !own(a)).map(fmtApp), ...menus.filter((m) => !own(m)).map(fmtMenu)].join('\n')}`;
}

// batch.entries carry .previous (array of step lines) when known.
export function buildPromptV2(batch, c) {
  const base = buildPrompt({ ...batch, retry: null }, { ...c, forbidden: c.forbidden });
  const parts = [base.replace(/# ITEMS TO CONVERT[\s\S]*$/, '').trimEnd()];
  parts.push(uiIdsText(c.ui, batch.resource));
  parts.push(`# MARKS\n${(c.marks ?? []).map((m) => `- "${m.name}"${m.fields ? ` fields: ${m.fields.join(', ')}` : ''} — ${m.note ?? ''}`).join('\n') || '(none)'}`);
  const items = batch.entries.map((e) => {
    const head = buildPrompt({ resource: batch.resource, entries: [e] }, c).replace(/^[\s\S]*# ITEMS TO CONVERT \(1\)\n\n/, '');
    return `${head}\nPREVIOUS CONVERSION:\n${(e.previous ?? []).join('\n') || '(none)'}`;
  });
  parts.push(`# ITEMS TO CONVERT (${batch.entries.length})\n\n${items.join('\n\n')}`);
  if (batch.retry?.length) {
    parts.push(`# YOUR PREVIOUS ATTEMPT FAILED VALIDATION — fix exactly these problems (use I manually:/I confirm: when a value is not allowed)\n${batch.retry.map((r) => `## id=${r.id}\nprevious steps:\n${r.steps.join('\n')}\nerrors:\n${r.errors.map((e) => `- ${e}`).join('\n')}`).join('\n\n')}`);
  }
  return parts.join('\n\n');
}

export const MERGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pairs'],
  properties: { pairs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['checklist_id', 'coverage', 'note'], properties: {
    checklist_id: { type: 'string' }, coverage: { type: 'string', enum: ['full', 'mostly', 'partial'] }, note: { type: 'string' },
  } } } },
};

export const MERGE_SYSTEM = `You review merges of QA checklist lines into game tests of the same FiveM resource. A checklist line was merged into a game test because they looked like duplicates. For each pair decide how much of the checklist line is covered by running the game test:
- full: everything the checklist line asks to verify is verified by the game test.
- mostly: the core behaviour is covered; only a minor detail (a sound, an alias command, a number) is not.
- partial: a significant behaviour, command, role or case in the checklist line is not exercised by the game test (e.g. the checklist also covers "non-admins refused", or "starting" while the game test only covers "locking").
note: one short sentence naming what is not covered (empty for full). Return one entry per pair.`;

export function buildMergePrompt(resource, pairs) {
  return `# RESOURCE ${resource}\n\n${pairs.map((p) => `## PAIR checklist_id=${p.checklist.id}\nCHECKLIST "${p.checklist.title}": ${p.checklist.description}\nGAME TEST ${p.game.id} "${p.game.title}":\n${p.game.description}`).join('\n\n')}`;
}
