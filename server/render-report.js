// Renders a Report (QA-CONTRACTS §6) to markdown: message 1 of GET /bug/:id for scenario / freeform / retest issues, and
// the "report" block of the panel. Pure: no I/O. Tester text is untrusted; it is fenced or kept on its own lines.

export const STEP_ICON = { passed: '✅', failed: '❌', skipped: '⏭', pending: '❔', unverified: '❔', blocked: '❔' };
export const MAX_TIMELINE = 40;
export const MAX_CONSOLE = 60;

const s = (v) => (v === undefined || v === null ? '' : String(v));
const clip = (v, n) => { const t = s(v); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fence = (text, lang = '') => { const t = s(text); const ticks = t.includes('```') ? '~~~~' : '```'; return `${ticks}${lang}\n${t}\n${ticks}`; };
const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '?');
const time = (at) => { const n = Number(at); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(11, 23) : s(at); };
const shortJson = (v, n = 300) => { if (v === undefined || v === null) return ''; const t = typeof v === 'string' ? v : JSON.stringify(v); return clip(t, n); };

// Item counts by name from an inventory snapshot (array of {name, count|amount}).
function counts(inv) {
  const out = new Map();
  for (const it of Array.isArray(inv) ? inv : []) {
    const name = it?.name ?? it?.item;
    if (!name) continue;
    out.set(name, (out.get(name) ?? 0) + (Number(it.count ?? it.amount ?? 1) || 0));
  }
  return out;
}
export function inventoryDiff(before, after) {
  const a = counts(before);
  const b = counts(after);
  const diff = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(name) ?? 0) - (a.get(name) ?? 0);
    if (d) diff.push({ name, before: a.get(name) ?? 0, after: b.get(name) ?? 0, delta: d });
  }
  return diff.sort((x, y) => x.name.localeCompare(y.name));
}

// issue: { id, title, reporter_name, source, kind } (any of them may be missing); report: the Report object.
// scenario: optional compiled Scenario (adds keywords to the steps); attachments: [url] listed under Screenshots.
export function renderReport({ issue = {}, report, scenario = null, attachments = [] } = {}) {
  const r = report && typeof report === 'object' ? report : {};
  const out = [];
  out.push(`# ${clip(issue.title ?? r.scenario?.name ?? 'Report', 200)}`);
  const facts = [];
  if (issue.reporter_name) facts.push(`**Reporter:** ${clip(issue.reporter_name, 100)}`);
  if (issue.source) facts.push(`**Source:** ${issue.source}`);
  if (r.frequency) facts.push(`**How often:** ${clip(r.frequency, 20)}`);
  if (r.build) facts.push(`**Build:** ${clip(r.build, 80)}`);
  if (facts.length) out.push(facts.join(' · '));

  const steps = Array.isArray(r.steps) ? r.steps : [];
  if (r.scenario || steps.length) {
    const sc = r.scenario ?? {};
    out.push(`## Scenario: ${clip(sc.name ?? scenario?.name ?? '(unnamed)', 300)}`);
    if (sc.id) out.push(`\`${clip(sc.id, 191)}\`${sc.hash ? ` · hash \`${s(sc.hash).slice(0, 10)}\`` : ''}`);
    const kw = new Map((scenario?.steps ?? []).map((st) => [st.idx, st.keyword]));
    const lines = steps.map((st, i) => {
      const idx = st.idx ?? i;
      const icon = STEP_ICON[st.status] ?? '❔';
      const keyword = kw.get(idx) ? `${kw.get(idx)} ` : '';
      const mark = r.failedIdx === idx ? '   <-- failed here' : '';
      return `${icon} ${keyword}${clip(st.text, 500)}${mark}`;
    });
    if (lines.length) out.push(fence(lines.join('\n'), 'gherkin'));
    const failed = steps.find((st) => (st.idx ?? -1) === r.failedIdx) ?? steps.find((st) => st.status === 'failed');
    if (failed?.detail !== undefined && failed?.detail !== null) out.push(`**Failed step detail:**\n${fence(shortJson(failed.detail, 1500), 'json')}`);
  }
  if (r.expected) out.push(`**Expected:**\n${fence(clip(r.expected, 2000))}`);
  if (r.actual) out.push(`**Actual:**\n${fence(clip(r.actual, 2000))}`);
  if (r.note) out.push(`**Tester note:**\n${fence(clip(r.note, 3000))}`);

  const timeline = Array.isArray(r.timeline) ? r.timeline.slice(-MAX_TIMELINE) : [];
  if (timeline.length) {
    out.push(`## Timeline (last ${timeline.length}${Array.isArray(r.timeline) && r.timeline.length > MAX_TIMELINE ? ` of ${r.timeline.length}` : ''})`);
    out.push(fence(timeline.map((t) => `${time(t.at)} [${clip(t.type, 12)}] ${shortJson(t.data, 240)}`).join('\n')));
  }
  const consoleLines = (Array.isArray(r.console) ? r.console : []).filter((c) => c?.error === true || /error|warn|fail|stack|traceback|exception/i.test(`${s(c?.channel)} ${s(c?.line)}`)).slice(-MAX_CONSOLE);
  if (consoleLines.length) {
    out.push('## Console errors');
    out.push(fence(consoleLines.map((c) => `${time(c.at)} [${clip(c.channel, 30)}]${c.error === true ? ' ERROR' : ''} ${clip(c.line, 400)}`).join('\n')));
  }
  const teardown = Array.isArray(r.teardown) ? r.teardown : [];
  const badTeardown = teardown.filter((t) => t && t.ok === false);
  if (teardown.length) {
    out.push(`## Teardown (${teardown.length - badTeardown.length}/${teardown.length} undone)${badTeardown.length ? `\n${badTeardown.map((t) => `- ❌ step ${Number.isInteger(t.idx) ? t.idx + 1 : '?'} ${clip(t.id, 60)}: ${clip(t.error ?? 'failed', 300)}`).join('\n')}` : ''}`);
  }
  const p = r.player;
  if (p && typeof p === 'object') {
    const rows = [];
    if (p.coords) rows.push(`- Coords: ${num(p.coords.x)}, ${num(p.coords.y)}, ${num(p.coords.z)} (h ${num(p.coords.h, 1)})${p.street ? ` · ${clip(p.street, 100)}` : ''}`);
    if (p.vehicle) rows.push(`- Vehicle: ${clip(p.vehicle.model, 40)}${p.vehicle.plate ? ` (${clip(p.vehicle.plate, 12)})` : ''}`);
    if (p.job) rows.push(`- Job: ${clip(p.job.name, 40)} grade ${s(p.job.grade)}${p.job.onduty === false ? ' (off duty)' : ''}`);
    if (p.gang && (p.gang.name ?? p.gang)) rows.push(`- Gang: ${clip(p.gang.name ?? p.gang, 40)}${p.gang.grade !== undefined ? ` grade ${s(p.gang.grade)}` : ''}`);
    if (p.money) rows.push(`- Money: cash ${s(p.money.cash)} · bank ${s(p.money.bank)}${r.moneyBefore ? ` (before the run: cash ${s(r.moneyBefore.cash)} · bank ${s(r.moneyBefore.bank)})` : ''}`);
    else if (r.moneyBefore) rows.push(`- Money before the run: cash ${s(r.moneyBefore.cash)} · bank ${s(r.moneyBefore.bank)}`);
    if (p.routingBucket !== undefined && p.routingBucket !== null) rows.push(`- Routing bucket: ${s(p.routingBucket)}`);
    if (p.health !== undefined || p.armour !== undefined) rows.push(`- Health ${s(p.health)} · armour ${s(p.armour)}`);
    if (rows.length) out.push(`## Player\n${rows.join('\n')}`);
  }
  const diff = inventoryDiff(r.inventoryBefore, r.inventoryAfter);
  if (diff.length) out.push(`## Inventory change\n${diff.map((d) => `- ${clip(d.name, 60)}: ${d.before} → ${d.after} (${d.delta > 0 ? '+' : ''}${d.delta})`).join('\n')}`);
  if (attachments.length) out.push(`## Screenshots\n${attachments.map((u) => `- ${u}`).join('\n')}`);
  else if (r.screenshot && r.screenshot.available === false) out.push(`_No screenshot: ${clip(r.screenshot.reason ?? 'not available', 200)}_`);

  const ctx = {};
  for (const k of ['player', 'moneyBefore', 'resources', 'inventoryBefore', 'inventoryAfter', 'teardown']) if (r[k] !== undefined) ctx[k] = r[k];
  if (Object.keys(ctx).length) {
    let text = JSON.stringify(ctx, null, 1);
    if (text.length > 6000) text = `${text.slice(0, 6000)}\n… (truncated)`;
    out.push(`## Context\n${fence(text, 'json')}`);
  }
  return out.join('\n\n');
}
