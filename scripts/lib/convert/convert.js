// The conversion pipeline (PLAN §11). Deterministic: sources, tags, descriptions, aliases, files, mapping, report.
// Claude (Sonnet, medium) only writes steps, per batch of ~20 tests of one resource.
import fs from 'node:fs';
import path from 'node:path';
import { loadValidationContext, validateFeatureText, mergeAliases } from '../scenarios.js';
import { loadSources } from './sources.js';
import { loadLiveContext } from './context.js';
import { buildLocationAliases, renderQaLua } from './spots.js';
import { SYSTEM, SCHEMA, buildPrompt, SYSTEM_V2, SCHEMA_V2, buildPromptV2, MERGE_SYSTEM, MERGE_SCHEMA, buildMergePrompt } from './prompt.js';
import { makeRunner, pool, MODEL, EFFORT } from './claude.js';
import { parseSteps, checkScenario, classify } from './check.js';
import { gameTags, checklistTags, descriptionBlock, renderFeature, gameFile, checklistFile } from './render.js';
import { rankPhrases, renderReport } from './report.js';

export function makeBatches(resource, entries, size = 20) {
  const n = Math.max(1, Math.ceil(entries.length / size));
  const per = Math.ceil(entries.length / n);
  const out = [];
  for (let i = 0; i < entries.length; i += per) out.push({ resource, index: out.length, entries: entries.slice(i, i + per) });
  return out;
}

const sourceText = (e) => [e.title, e.setup, e.description].filter(Boolean).join('\n');

// Manual text / unmapped phrases the v2 catalog (keys, engine, chat, HUD, minimap, seatbelt, apps, menus, progress,
// text UI, notifications, consoles, armour, metadata, driver seat, fuel, target marks) may now automate.
export const COVERABLE = new RegExp([
  String.raw`\bpress(?:es|ing)? (?:the )?(?:[A-Z][A-Z0-9]{0,5}|F\d{1,2}|Escape|Enter|Tab|Home|Backspace|Space(?:bar)?|left alt|right alt)\b(?! to)`,
  String.raw`\bengine\b.{0,30}\b(?:on|off|start|starts|running|runs|stall|stalls|stops)\b|\b(?:start|turn on|turn off|stop)s? the engine\b`,
  String.raw`\bchat\b.{0,40}\b(?:shows?|message|says|reads|appears)\b`,
  String.raw`\b(?:HUD|minimap)\b.{0,40}\b(?:hidden|hides?|visible|shows?|disappears?|appears?|goes away|comes back)\b`,
  String.raw`\bseat ?belt\b`, String.raw`\bprogress ?bar\b`, String.raw`\btext ?UI\b|\[E\]|help text|interaction prompt`,
  String.raw`\bnotification\b.{0,40}\b(?:titled|title|error|success|warning|info|red|green)\b`,
  String.raw`\bF8\b|\bserver console\b`, String.raw`\barmou?r\b.{0,20}\b(?:\d+|full|empty|goes|drops|fills)\b`,
  String.raw`\b(?:hunger|thirst|stress)\b.{0,30}\b(?:up|down|rises?|drops?|increases?|decreases?|goes)\b`,
  String.raw`\bdriver seat\b`, String.raw`\b(?:deleted|despawns?|disappears)\b`, String.raw`\bfuel\b.{0,20}(?:\d+ ?%|level|gauge)`,
  String.raw`\b(?:select|pick|choose) (?:the )?["'][^"']+["'] (?:target )?option\b|\btarget option\b`,
].join('|'), 'i');
// app/menu wording only counts for a resource that has known ui ids
export const UI_WORDING = /\b(?:app|panel|menu|window|tablet|UI|NUI|dialog|screen)\b.{0,30}\b(?:opens?|shows?|appears?|closes?|is open)\b|\bopens? (?:the |a |an )?[\w' ]{0,30}\b(?:app|panel|menu|window|tablet|UI|dialog|screen)\b/i;

export function loadPrevious(file, renames = {}) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = new Map();
  for (const r of rows) {
    let steps = r.steps ?? null;
    const rn = renames[r.resource] ?? {};
    if (steps) steps = steps.map((l) => Object.entries(rn).reduce((acc, [a, b]) => acc.split(`"${a}"`).join(`"${b}"`), l));
    out.set(r.key, { steps, unmapped: r.unmapped ?? [], duplicateOf: r.duplicateOf ?? null, status: r.status, manualOnly: r.manualOnly });
  }
  return out;
}

// Step-shape metrics for before/after: lines like "Then I confirm: x".
export function stepMetrics(rows, matcher) {
  const out = { scenarios: 0, manualOnly: 0, steps: 0, manualSteps: 0, autoSteps: 0, unmappedTotal: 0, unmappedDistinct: 0 };
  const distinct = new Set();
  for (const r of rows) {
    for (const u of r.unmapped ?? []) { out.unmappedTotal++; distinct.add(String(u).trim().toLowerCase()); }
    if (r.status !== 'converted' || !r.steps) continue;
    out.scenarios++;
    let manual = 0;
    for (const l of r.steps) {
      const text = String(l).replace(/^(Given|When|Then|And|But|\*)\s+/, '');
      const kind = matcher.match(text).def?.kind;
      out.steps++;
      if (kind === 'manual') manual++;
    }
    out.manualSteps += manual;
    out.autoSteps += r.steps.length - manual;
    if (manual === r.steps.length) out.manualOnly++;
  }
  out.unmappedDistinct = distinct.size;
  return out;
}

export async function convert(opts) {
  const {
    outDir, resDir, botDir, only = null, batchSize = 20, concurrency = 3, budgetUsd = 2, offline = false,
    maxCalls = Infinity, log = console.log, runner: injectedRunner = null, write = true,
    previous = null, uiFile = null, mergeReview = !!previous,
  } = opts;
  const src = loadSources(botDir);
  const live = loadLiveContext(resDir);
  const all = [...src.game, ...src.checklist];
  const resourceNames = [...new Set(all.map((e) => e.resource))].filter((r) => !only || only.includes(r)).sort();
  const notes = [];

  // 1. spots -> staging qa.lua (before the validation context, which reads the staging tree)
  const { byResource: locs, byTest: spotsByTest, renames } = buildLocationAliases(src.game, src.spots);
  for (const [res, rn] of Object.entries(renames)) for (const [a, b] of Object.entries(rn)) notes.push(`${res}: location alias "${a}" renamed to "${b}" (the spot label did not name a place).`);
  const prev = previous ? loadPrevious(previous, renames) : null;
  const ui = uiFile && fs.existsSync(uiFile) ? JSON.parse(fs.readFileSync(uiFile, 'utf8')) : null;
  for (const res of resourceNames) {
    const dir = path.join(outDir, res, 'tests');
    if (write) {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.feature') || f === 'qa.lua') fs.unlinkSync(path.join(dir, f));
      if (locs[res]) fs.writeFileSync(path.join(dir, 'qa.lua'), renderQaLua(res, locs[res]));
    }
    if (live.dirs[res] && fs.existsSync(path.join(live.dirs[res], 'tests', 'qa.lua'))) notes.push(`${res} already has a live tests/qa.lua; merge the staging one into it instead of replacing it.`);
    if (!live.dirs[res]) notes.push(`${res}: no live resource folder found (context limited to the legacy text).`);
  }
  const derived = src.game.filter((g) => g.needsPlayersDerived && resourceNames.includes(g.resource));
  if (derived.length) notes.push(`@needs:players:<n> derived from the "Needs N testers" line for ${derived.length} game tests: ${derived.map((g) => `${g.id}(${g.needsPlayers})`).join(', ')}.`);
  const lists = { items: live.itemNames, jobs: live.jobs, gangs: live.gangs };
  const ctx = loadValidationContext({ resDir, stagingDir: write ? outDir : null, extraAliases: write ? {} : Object.fromEntries(Object.entries(locs).map(([r, l]) => [r, { locations: l }])) });
  if (ctx.catalog.error) throw new Error(`step catalog: ${ctx.catalog.error}`);
  ctx.lists = lists;
  ctx.defs = new Map(ctx.steps.map((d) => [d.id, d]));
  ctx.sharedLocations = Object.keys(ctx.aliases.kora_qa?.locations ?? {});
  if (prev) { ctx.ui = ui; ctx.marks = live.marks.map((m) => m.name); }
  const v2Forbidden = new Set(live.marks.length ? [] : ['mark.fires', 'mark.fires_with', 'mark.fires_within']);
  const tagsFor = (e, modelAdmin = false) => {
    const admin = e.needsAdmin || modelAdmin;
    if (e.kind === 'game') return gameTags({ ...e, needsAdmin: admin });
    return [`@${e.resource}`, ...checklistTags(e), ...(admin ? ['@needs:admin'] : [])];
  };
  const aliasesFor = (res) => mergeAliases(ctx.aliases.kora_qa, ctx.aliases[res]);

  let runner = injectedRunner;
  if (!runner) runner = makeRunner({ workDir: outDir, budgetUsd, offline, log });
  let callsLeft = maxCalls;

  const entryState = new Map(); // key -> state
  const batches = [];
  for (const res of resourceNames) {
    const es = all.filter((e) => e.resource === res);
    for (const e of es) entryState.set(e.key, { ...e, status: 'pending', steps: null, errors: [], unmapped: [], duplicateOf: null, attempts: 0, source: null, modelAdmin: false });
    batches.push(...makeBatches(res, es, batchSize));
  }
  log(`${resourceNames.length} resources, ${entryState.size} legacy tests, ${batches.length} batches`);

  const promptCtx = (res) => {
    const aliases = aliasesFor(res);
    const labels = Object.fromEntries(Object.entries(locs[res] ?? {}).map(([n, l]) => [n, `${l.label}${l.proposed ? ' (proposed spot)' : ''}`]));
    const f = live.facts(res);
    return {
      steps: ctx.steps, caps: ctx.caps, aliases, aliasLabels: labels, lists, facts: f,
      otherCommands: live.allCommands.filter((c) => !(f?.commands ?? []).includes(c)),
      resourceInfo: src.resourceInfo[res], spotsByTest, ui, marks: live.marks, forbidden: prev ? v2Forbidden : undefined,
      gameIndex: src.game.filter((g) => g.resource === res).map((g) => ({ id: g.id, title: g.title })),
    };
  };

  const evaluate = (res, out, entries) => {
    const f = live.facts(res);
    const byId = new Map((out?.scenarios ?? []).map((s) => [String(s.id), s]));
    const failed = [];
    for (const e of entries) {
      const st = entryState.get(e.key);
      st.attempts++;
      const got = byId.get(e.id);
      if (!got) { st.errors = ['the model returned nothing for this id']; st.lastSteps = []; failed.push(st); continue; }
      st.unmapped = got.unmapped ?? [];
      st.duplicateOf = e.kind === 'checklist' && got.duplicate_of ? String(got.duplicate_of) : null;
      st.modelAdmin = !!got.needs_admin;
      const { steps, errors } = parseSteps(got.steps, ctx.matcher);
      st.lastSteps = got.steps ?? [];
      const sc = { tags: tagsFor(e, st.modelAdmin), name: e.title, description: descriptionBlock(e), steps, sourceText: sourceText(e), ownLocations: e.kind === 'game' ? spotsByTest[e.id] ?? [] : [] };
      const chk = checkScenario(sc, { resource: res, ctx, facts: f, allCommands: live.allCommands });
      const errs = [...errors, ...chk.errors];
      if (!steps.length) errs.push('no steps');
      if (errs.length) { st.errors = [...new Set(errs)]; failed.push(st); continue; }
      st.status = 'ok';
      st.steps = steps;
      st.errors = [];
      st.source = prev ? 'v2' : 'v1';
      Object.assign(st, classify(steps));
    }
    return failed;
  };

  // Previous (v1) steps re-checked under the current catalog/checks. -> { steps, errors }
  const checkPrevious = (e, p) => {
    if (!p?.steps?.length) return { steps: [], errors: ['no previous steps'] };
    const { steps, errors } = parseSteps(p.steps, ctx.matcher);
    const sc = { tags: tagsFor(e), name: e.title, description: descriptionBlock(e), steps, sourceText: sourceText(e), ownLocations: e.kind === 'game' ? spotsByTest[e.id] ?? [] : [] };
    const chk = checkScenario(sc, { resource: e.resource, ctx, facts: live.facts(e.resource), allCommands: live.allCommands });
    return { steps, errors: [...errors, ...chk.errors] };
  };
  const usePrevious = (st, p, steps, source) => {
    Object.assign(st, { status: 'ok', steps, errors: [], unmapped: p.unmapped, duplicateOf: p.duplicateOf, source }, classify(steps));
  };
  const hasUi = (res) => !!ui && [...(ui.apps ?? []), ...(ui.menus ?? [])].some((x) => x.resource === res);
  const benefits = (e, p, chk) => {
    if (chk.errors.length) return `fails new checks: ${chk.errors[0]}`;
    const manual = chk.steps.filter((x) => x.kind === 'manual').map((x) => x.text);
    const texts = [...manual, ...(p.unmapped ?? [])];
    const hit = texts.find((t) => COVERABLE.test(t));
    if (hit) return `v2 step may cover: "${hit.slice(0, 80)}"`;
    const uiHit = hasUi(e.resource) && texts.find((t) => UI_WORDING.test(t));
    if (uiHit) return `ui-ids may cover: "${uiHit.slice(0, 80)}"`;
    return null;
  };
  const batchLog = [];

  const runBatch = async (b, { system, schema, build, label, fallback }) => {
    const pc = promptCtx(b.resource);
    const fail = (e, reason) => { const st = entryState.get(e.key); if (fallback?.(st)) return; Object.assign(st, { status: 'unconvertible', reason }); };
    if (callsLeft-- <= 0 && !offline) { for (const e of b.entries) fail(e, 'skipped: --max-calls reached'); return; }
    const r1 = await runner.run({ system, prompt: build(b, pc), schema, label });
    if (!r1.output) { for (const e of b.entries) fail(e, `model call failed: ${r1.error}`); return; }
    const failed = evaluate(b.resource, r1.output, b.entries);
    if (!failed.length) return;
    const retry = { ...b, entries: b.entries.filter((e) => failed.some((f) => f.key === e.key)) };
    retry.retry = failed.map((f) => ({ id: f.id, steps: f.lastSteps, errors: f.errors }));
    const r2 = await runner.run({ system, prompt: build(retry, pc), schema, label: `${label} retry` });
    if (!r2.output) { for (const f of failed) fail(f, `retry call failed: ${r2.error}; first errors: ${f.errors.join('; ')}`); return; }
    const still = evaluate(b.resource, r2.output, retry.entries);
    for (const f of still) fail(f, f.errors.join('; '));
  };

  await pool(batches, Math.min(3, Math.max(1, concurrency)), async (b) => {
    const label = `${b.resource}#${b.index}`;
    if (!prev) return runBatch(b, { system: SYSTEM, schema: SCHEMA, build: buildPrompt, label });
    // second pass: re-convert only batches that can benefit; the rest keep their (cached) v1 steps
    const checked = b.entries.map((e) => { const p = prev.get(e.key); return { e, p, chk: checkPrevious(e, p) }; });
    const why = checked.map((c) => ({ key: c.e.key, why: c.p ? benefits(c.e, c.p, c.chk) : 'no previous conversion' })).filter((x) => x.why);
    if (!why.length) {
      for (const c of checked) usePrevious(entryState.get(c.e.key), c.p, c.chk.steps, 'v1');
      batchLog.push({ label, reconverted: false });
      return;
    }
    batchLog.push({ label, reconverted: true, reasons: why });
    const prevOk = new Map(checked.filter((c) => c.p && !c.chk.errors.length).map((c) => [c.e.key, c]));
    const vb = { ...b, entries: b.entries.map((e) => ({ ...e, previous: prev.get(e.key)?.steps ?? [] })) };
    await runBatch(vb, {
      system: SYSTEM_V2, schema: SCHEMA_V2, build: buildPromptV2, label: `${label} v2`,
      fallback: (st) => { const c = prevOk.get(st.key); if (!c) return false; usePrevious(st, c.p, c.chk.steps, 'v1-fallback'); st.fallbackReason = st.errors.join('; '); return true; },
    });
  });

  // 1b. merge review (second pass): grade every checklist -> game test merge; partial overlaps are un-merged.
  const mergeGrades = new Map();
  if (mergeReview) {
    const byRes = new Map();
    for (const st of entryState.values()) {
      if (st.kind !== 'checklist' || !st.duplicateOf || st.status !== 'ok') continue;
      const g = entryState.get(st.duplicateOf);
      if (!g || g.kind !== 'game' || g.resource !== st.resource || g.status !== 'ok') continue;
      if (!byRes.has(st.resource)) byRes.set(st.resource, []);
      byRes.get(st.resource).push({ checklist: st, game: g });
    }
    await pool([...byRes.entries()], Math.min(3, Math.max(1, concurrency)), async ([res, pairs]) => {
      const r = await runner.run({ system: MERGE_SYSTEM, prompt: buildMergePrompt(res, pairs), schema: MERGE_SCHEMA, label: `${res} merge-review` });
      for (const p of r.output?.pairs ?? []) mergeGrades.set(`checklist:${res}:${p.checklist_id}`, { coverage: p.coverage, note: p.note });
      if (!r.output) notes.push(`${res}: merge review failed (${r.error}); merges kept as decided in batch`);
    });
  }

  // 2. merges (model decided, script applies): checklist duplicate of a converted game test of the same resource
  for (const st of entryState.values()) {
    if (st.kind !== 'checklist' || !st.duplicateOf) continue;
    const g = entryState.get(st.duplicateOf);
    if (g && g.kind === 'game' && g.resource === st.resource && g.status === 'ok' && st.status !== 'unconvertible') {
      const grade = mergeGrades.get(st.key);
      st.mergeGrade = grade ?? null;
      if (grade?.coverage === 'partial') { st.unmerged = { into: g.key, note: grade.note }; continue; }
      st.status = 'merged';
      st.mergedKey = g.key;
      (g.merged ??= []).push(st);
    }
  }

  // 3. files
  const mapping = { v: 1, generatedAt: Date.now(), game: {}, checklist: {} };
  const resources = [];
  const fileErrors = [];
  for (const res of resourceNames) {
    const es = [...entryState.values()].filter((e) => e.resource === res);
    const groups = new Map();
    for (const e of es) {
      if (e.status !== 'ok') continue;
      const fl = e.kind === 'game' ? gameFile(res) : checklistFile(res, e.category);
      if (!groups.has(fl.file)) groups.set(fl.file, { ...fl, scenarios: [] });
      const tags = tagsFor(e, e.modelAdmin);
      for (const m of e.merged ?? []) tags.push(...checklistTags(m).filter((t) => !tags.includes(t)));
      if (e.manualOnly) tags.push('@manual');
      groups.get(fl.file).scenarios.push({ key: e.key, tags, name: e.title, description: descriptionBlock(e, e.merged ?? []), steps: e.steps });
    }
    const files = [];
    for (const g of groups.values()) {
      const { text, scenarioLines } = renderFeature({
        title: g.title,
        header: ['Converted from the communitybot legacy tests by kora-qa-panel/scripts/convert-legacy.mjs.', 'The """ block under each Scenario is the original test text, verbatim. Review before applying.'],
        scenarios: g.scenarios,
      });
      const v = validateFeatureText(text, { resource: res, file: g.file, ctx });
      const byLine = new Map(v.results.map((r) => [r.line, r]));
      for (const sc of g.scenarios) {
        const line = scenarioLines[sc.key];
        const r = byLine.get(line);
        const st = entryState.get(sc.key);
        if (!r || !r.valid) { fileErrors.push(`${res}/${g.file}:${line} ${sc.key}: ${r ? r.errors.map((e) => e.message).join('; ') : 'scenario not found at expected line'}`); continue; }
        st.status = 'converted';
        st.scenarioId = r.scenario.id;
        for (const m of st.merged ?? []) { m.mergedInto = r.scenario.id; m.scenarioId = r.scenario.id; }
      }
      if (v.errors.length) fileErrors.push(`${res}/${g.file}: ${v.errors.map((e) => e.message).join('; ')}`);
      if (write) fs.writeFileSync(path.join(outDir, res, g.file), `${text.trimEnd()}\n`);
      files.push(g.file);
    }
    if (locs[res]) files.push('tests/qa.lua');
    resources.push({ name: res, files });
  }
  for (const st of entryState.values()) {
    if (st.status === 'ok') { st.status = 'unconvertible'; st.reason = 'failed whole-file validation'; }
    if (st.status === 'pending') { st.status = 'unconvertible'; st.reason = st.reason ?? 'not processed'; }
    const id = st.status === 'converted' || st.status === 'merged' ? st.scenarioId ?? null : null;
    if (st.kind === 'game') mapping.game[st.id] = id; else mapping.checklist[`${st.resource}:${st.id}`] = id;
  }

  const entries = [...entryState.values()];
  const ranked = rankPhrases(entries.filter((e) => e.status === 'converted' || e.status === 'merged'));
  const patterns = new Set(ctx.steps.map((d) => d.pattern.toLowerCase()));
  const phrases = ranked.filter((p) => !patterns.has(p.phrase.toLowerCase()));
  const existing = ranked.filter((p) => patterns.has(p.phrase.toLowerCase()));
  const s = runner.stats;
  const stats = { model: MODEL, effort: EFFORT, calls: s.calls, cached: s.cached, failed: s.failed, costUsd: s.costUsd, totalCostUsd: s.costUsd + s.cachedCostUsd };
  if (fileErrors.length) notes.push(...fileErrors.map((e) => `file validation: ${e}`));
  const sections = [];
  if (prev) {
    const rowsNow = entries.map((e) => ({ status: e.status, unmapped: e.unmapped, steps: e.steps?.map((x) => `${x.keyword} ${x.text}`) ?? null }));
    const before = stepMetrics([...prev.values()], ctx.matcher);
    const after = stepMetrics(rowsNow, ctx.matcher);
    const prevPhrases = rankPhrases([...prev.values()].map((p) => ({ ...p, resource: '-' })));
    const v1Unmapped = prevPhrases.filter((p) => !patterns.has(p.phrase.toLowerCase())).length;
    const S = [];
    S.push('## Second pass (catalog v2, 112 steps + ui-ids) — before / after', '');
    S.push('| metric | v1 | v2 |', '|---|---|---|');
    for (const [k, label] of [['scenarios', 'scenarios'], ['manualOnly', 'manual-only scenarios'], ['steps', 'steps'], ['autoSteps', 'automatic steps (setup/observed/check)'], ['manualSteps', 'manual steps (incl. named manual)'], ['unmappedTotal', 'unmapped phrases (total)'], ['unmappedDistinct', 'unmapped phrases (distinct)']]) S.push(`| ${label} | ${before[k]} | ${after[k]} |`);
    S.push(`| unmapped phrases not matching any catalog step (distinct) | ${v1Unmapped} | ${phrases.length} |`);
    S.push(`| merged checklist features | ${[...prev.values()].filter((p) => p.status === 'merged').length} | ${entries.filter((e) => e.status === 'merged').length} |`, '');
    const re = batchLog.filter((b) => b.reconverted);
    S.push(`Batches: ${batchLog.length}; re-converted with the v2 prompt: ${re.length}; kept from the v1 cache: ${batchLog.length - re.length}.`, '');
    S.push('<details><summary>Re-converted batches and why</summary>', '');
    for (const b of re) S.push(`- ${b.label}: ${b.reasons.slice(0, 3).map((r) => `${r.key} (${r.why.slice(0, 120)})`).join('; ')}${b.reasons.length > 3 ? ` … +${b.reasons.length - 3}` : ''}`);
    S.push('', '</details>', '');
    const fb = entries.filter((e) => e.source === 'v1-fallback');
    if (fb.length) { S.push('### Kept v1 steps after the v2 attempt failed validation twice', ''); for (const e of fb) S.push(`- \`${e.key}\`: ${String(e.fallbackReason ?? '').slice(0, 300)}`); S.push(''); }
    const un = entries.filter((e) => e.unmerged);
    S.push('### Merges un-done (partial overlap — the checklist line now has its own scenario)', '');
    if (!un.length) S.push('None.');
    for (const e of un) S.push(`- \`${e.key}\` (${e.title}) was merged into \`${e.unmerged.into}\`: ${e.unmerged.note}`);
    S.push('', '### Merges kept but only mostly overlapping (review)', '');
    const mostly = entries.filter((e) => e.status === 'merged' && e.mergeGrade?.coverage === 'mostly');
    if (!mostly.length) S.push('None.');
    for (const e of mostly) S.push(`- \`${e.key}\` → \`${e.mergedInto}\`: ${e.mergeGrade.note}`);
    S.push('', '### @needs:admin', '');
    const adm = entries.filter((e) => (e.needsAdmin || e.modelAdmin) && (e.status === 'converted' || e.status === 'merged'));
    S.push(`${adm.length} legacy tests carry @needs:admin: ${adm.filter((e) => e.needsAdminDerived).length} from the text ("Needs a Mod/dev…" / "as admin"), ${adm.filter((e) => !e.needsAdminDerived && e.modelAdmin).length} judged by the model (tester runs admin commands/console).`, '');
    S.push(adm.map((e) => `\`${e.key}\``).join(', '), '');
    sections.push(S.join('\n'));
  }
  const report = renderReport({ generatedAt: Date.now(), resources, entries, phrases, stats, notes, existing, sections });
  if (write) {
    fs.writeFileSync(path.join(outDir, 'conversion-report.md'), report);
    fs.writeFileSync(path.join(outDir, only ? `mapping.partial.json` : 'mapping.json'), `${JSON.stringify(mapping, null, 1)}\n`);
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(entries.map((e) => ({
      key: e.key, kind: e.kind, resource: e.resource, title: e.title, status: e.status, scenarioId: e.scenarioId ?? null,
      mergedInto: e.mergedInto ?? null, duplicateOf: e.duplicateOf, manualOnly: !!e.manualOnly, setupSteps: e.setupSteps ?? [],
      unmapped: e.unmapped, reason: e.reason ?? null, attempts: e.attempts, source: e.source, needsAdmin: !!(e.needsAdmin || e.modelAdmin),
      mergeGrade: e.mergeGrade ?? null, unmerged: e.unmerged ?? null, steps: e.steps?.map((x) => `${x.keyword} ${x.text}`) ?? null,
    })), null, 1));
  }
  if (write) fs.writeFileSync(path.join(outDir, 'unmapped-phrases.json'), JSON.stringify({ suggestions: phrases, existingUnusable: existing }, null, 1));
  return { entries, mapping, report, stats, phrases, existing, resources, fileErrors };
}
