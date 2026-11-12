// Validation of generated steps: the panel's validator (gherkin parse, catalog match, priorities, caps, aliases,
// `allow` lists) plus conversion-only anti-invention rules (no raw coordinates, commands/texts/names must exist).
import { validateFeatureText } from '../scenarios.js';
import { FORBIDDEN_STEPS } from './prompt.js';
import { renderFeature, splitStep, normaliseKeywords, keywordFor } from './render.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s ]+/g, ' ').trim();

// Normalises the model's lines to [{keyword, text}] and returns line-level problems.
export function parseSteps(lines, matcher) {
  const steps = [];
  const errors = [];
  for (const raw of lines ?? []) {
    const parts = String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of parts) {
      const st = splitStep(line);
      if (!st) { errors.push(`"${line.slice(0, 120)}": must start with Given/When/Then/And/But`); continue; }
      const m = matcher.match(st.text);
      const kind = m.def?.kind ?? null;
      steps.push({ base: kind ? keywordFor(kind, st.text) : (st.keyword === 'And' || st.keyword === 'But' || st.keyword === '*' ? 'When' : st.keyword), text: st.text, defId: m.def?.id ?? null, kind });
    }
  }
  return { steps: normaliseKeywords(steps), errors };
}

// Extra rules on a validated scenario (steps carry defId/args).
const STOP = new Set(['shop', 'store', 'station', 'area', 'entrance', 'spot', 'the', 'and', 'point', 'points']);
export const aliasWords = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));

// Coordinates are allowed only when the original text gives them (x and y, whole-number part).
export function coordsInText(args, text) {
  const nums = [...String(text ?? '').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Math.trunc(Number(m[0])));
  return [args[0], args[1]].every((v) => nums.includes(Math.trunc(Number(v))));
}

// sharedLocations: alias names that come from kora_qa (generic, not this resource's spots) -> only usable when the
// test names that place. ownLocations: aliases assigned to this very test (always fine).
// Internal event / export names in a tester-facing manual step ("trigger qbvehiclekeys:client:lockpickUsed").
export const INTERNAL_EVENT = /\b[\w-]+:(?:client|server|cl|sv):[\w:.-]+|\bTrigger(?:Server|Client)?Event\b|\bexports\.[\w-]+|\b(?:trigger|fire|emit)s?\b[^.]{0,40}\bevent\b/i;

const menuMatches = (menus, v) => (menus ?? []).some((m) => {
  if (!m.dynamic) return String(m.title).toLowerCase() === String(v).toLowerCase();
  const re = new RegExp(`^${String(m.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%[sd]/g, '.+')}$`, 'i');
  return re.test(String(v));
});

// An admin/Mod console or command instruction may name events/exports (there is no player path for those).
export const adminConsole = (text, needsAdmin) => (needsAdmin || /\b(?:Mod|dev|admin|staff)\b/i.test(text)) && (/\bconsole\b|txAdmin|runcode|(?:^|\s)\/[a-z]\w*/i.test(text) || /\b(?:Mod|dev|admin)\b.{0,20}\b(?:saw|sees|watch(?:es|ed)?|logs?)\b/i.test(text));

// ui: ui-ids.json ({apps, menus}); marks: known mark names; needsAdmin: the scenario is tagged @needs:admin.
export function extraChecks(scenario, { facts, allCommands, sourceText, defs = null, lists = null, sharedLocations = [], ownLocations = [], ui = null, marks = null, needsAdmin = false }) {
  const errors = [];
  for (const st of scenario.steps) {
    const def = defs?.get(st.defId);
    (def?.args ?? []).forEach((spec, i) => {
      const list = lists?.[spec.allow];
      const v = st.args?.[i];
      if (Array.isArray(list) && list.length && v !== undefined && !list.some((x) => String(x).toLowerCase() === String(v).toLowerCase())) {
        errors.push(`"${st.text.slice(0, 100)}": unknown ${spec.allow.replace(/s$/, '')} "${v}" (not defined in the resources)`);
      }
    });
  }
  const src = norm(sourceText);
  const inCode = (v) => {
    const n = norm(v);
    if (!n) return false;
    for (const s of facts?.strings ?? []) if (norm(s).includes(n)) return true;
    return false;
  };
  const exactInCode = (v) => !!facts?.strings?.has?.(v);
  const firstOther = scenario.steps.findIndex((st) => st.kind !== 'setup');
  const lateSetup = firstOther < 0 ? [] : scenario.steps.slice(firstOther).filter((st) => st.kind === 'setup');
  for (const st of lateSetup) errors.push(`"${st.text.slice(0, 100)}": setup steps must all come first, before any action or check (move it up or make it manual)`);
  for (const st of scenario.steps) {
    const at = `"${st.text.slice(0, 100)}"`;
    if ((st.defId === 'teleport.coords' || st.defId === 'teleport.coords_heading')) {
      if (!coordsInText(st.args ?? [], sourceText)) errors.push(`${at}: coordinates are only allowed when the original test gives them; use a location alias or I manually:`);
      continue;
    }
    if (/^mark\./.test(st.defId) && marks) {
      if (!marks.includes(String(st.args?.[0]))) errors.push(`${at}: mark "${st.args?.[0]}" does not exist (known: ${marks.join(', ') || 'none'})`);
      continue;
    }
    if (st.kind === 'manual' && INTERNAL_EVENT.test(st.text) && !adminConsole(st.text, needsAdmin)) {
      errors.push(`${at}: testers can't trigger internal events/exports; describe the player action that causes it, or (no player path) give the admin command/console line and set needs_admin`);
    }
    if (FORBIDDEN_STEPS.has(st.defId)) { errors.push(`${at}: ${st.defId} is not allowed in converted tests (use I manually:/I confirm:)`); continue; }
    const def = defs?.get(st.defId);
    (def?.args ?? []).forEach((spec, i) => {
      if (spec.allow !== 'locations') return;
      const name = String(st.args?.[i] ?? '');
      if (ownLocations.includes(name) || !sharedLocations.includes(name)) return;
      if (!aliasWords(name).some((w) => src.includes(w))) errors.push(`${at}: "${name}" is a generic test location; use it only when the test names that place. Otherwise use "I am at X, Y, Z" with coordinates the test itself gives, or I manually: go to <the place the test names>`);
    });
    const v = st.args?.[0];
    switch (st.defId) {
      case 'command.run': {
        const cmd = `/${String(v).replace(/^\//, '').split(/\s+/)[0]}`.toLowerCase();
        const known = (allCommands ?? []).some((c) => c.toLowerCase() === cmd);
        if (!known && !src.includes(cmd)) errors.push(`${at}: command ${cmd} is not registered by any resource and not mentioned in the test`);
        break;
      }
      case 'nui.menu':
        if (!menuMatches(ui?.menus, v) && !src.includes(norm(v)) && !inCode(v)) errors.push(`${at}: menu title "${v}" is not in UI IDS, the test or the resource code — use I confirm:`);
        break;
      case 'nui.app': case 'nui.app_open':
        if (!(ui?.apps ?? []).some((a) => a.id === v) && !exactInCode(v) && !src.includes(norm(v))) errors.push(`${at}: "${v}" is not an app id from UI IDS — use I confirm:`);
        break;
      case 'notify.contains': case 'target.option': case 'notify.titled': case 'chat.shows': case 'textui.shows': case 'progress.labelled': case 'console.server_shows':
        if (!src.includes(norm(v)) && !inCode(v)) errors.push(`${at}: text "${v}" appears neither in the test nor in the resource code — use I confirm:`);
        break;
      case 'callback.called':
        if (!exactInCode(v) && !src.includes(norm(v))) errors.push(`${at}: "${v}" is not a name found in the resource code — use I confirm:`);
        break;
      default:
    }
  }
  return errors;
}

// Validates one scenario on its own (wrapped in a throwaway feature). -> { ok, errors:[string], result }
export function checkScenario(sc, { resource, ctx, facts, allCommands }) {
  const { text } = renderFeature({ title: 'check', scenarios: [{ ...sc, key: 'x' }] });
  const v = validateFeatureText(text, { resource, file: 'tests/check.feature', ctx });
  const errors = [];
  for (const e of v.errors) errors.push(`parse: ${e.message}`);
  const r = v.results[0];
  if (!r && !v.errors.length) errors.push('no scenario produced');
  if (r) {
    for (const e of r.errors) errors.push(`${e.text ? `"${e.text.slice(0, 100)}": ` : ''}${e.message}`);
    errors.push(...extraChecks(r.scenario, { facts, allCommands, sourceText: sc.sourceText, defs: ctx.defs, lists: ctx.lists, sharedLocations: ctx.sharedLocations ?? [], ownLocations: sc.ownLocations ?? [], ui: ctx.ui ?? null, marks: ctx.marks ?? null, needsAdmin: (sc.tags ?? []).includes('@needs:admin') }));
  }
  return { ok: errors.length === 0, errors, result: r };
}

export function classify(steps) {
  const kinds = steps.map((s) => s.kind);
  const manual = kinds.filter((k) => k === 'manual').length;
  return { manualOnly: steps.length > 0 && manual === steps.length, setupSteps: steps.filter((s) => s.kind === 'setup').map((s) => s.text), auto: steps.length - manual };
}
