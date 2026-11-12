// The pure part of the issue status machine (port of communitybot modules/bugs/machine.js, QA-CONTRACTS §3):
// statuses, hook verbs, labels and notes, who may set what, the Not fixed rule and the XP rules. No I/O.

export const STATUS_ORDER = ['open', 'info', 'confirmed', 'prompt_ready', 'prompt_running', 'fix_initiated', 'fix_in_progress', 'fixed_awaiting_restart', 'awaiting_test', 'needs_manual_review', 'fixed', 'dup', 'wontfix'];
export const CLOSED = new Set(['fixed', 'dup', 'wontfix']);
export const STILL_OPEN = new Set(STATUS_ORDER.filter((s) => !CLOSED.has(s)));
export const MANUAL_REVIEW_AFTER = 3;

const LEGACY_STATUS = { fix_attempted: 'awaiting_test' };
export const normStatus = (key) => (Object.hasOwn(LEGACY_STATUS, key) ? LEGACY_STATUS[key] : key);
export const isClosed = (s) => CLOSED.has(normStatus(s));
export const isStatus = (s) => STATUS_ORDER.includes(s);

// Hook verb -> stored status (POST /bug-status), exactly communitybot's HOOK_ACTIONS.
export const HOOK_ACTIONS = {
  prompt_ready: 'prompt_ready', fix_initiated: 'fix_initiated', fix_in_progress: 'fix_in_progress',
  fixed_awaiting_restart: 'fixed_awaiting_restart', awaiting_test: 'awaiting_test', fix_attempted: 'awaiting_test',
  fixed: 'fixed', needs_info: 'info', needs_manual_review: 'needs_manual_review', reopen: 'open',
};
export const HOOK_ACTION_KEYS = Object.keys(HOOK_ACTIONS);

// `expect` accepts stored status keys and the hook verbs for them.
const EXPECT_ALIASES = { needs_info: 'info', reopen: 'open' };
export function parseExpect(value) {
  if (value === undefined || value === null) return { expect: undefined };
  if (typeof value !== 'string') return { error: 'expect must be a status string' };
  const key = normStatus(EXPECT_ALIASES[value] ?? value);
  if (!STATUS_ORDER.includes(key)) return { error: `expect must be one of: ${STATUS_ORDER.join(', ')}` };
  return { expect: key };
}

// Display names (communitybot config.bugTracker.tags + labels).
const TAGS = { open: 'Opened', confirmed: 'Confirmed', info: 'Needs info', prompt_ready: 'Prompt ready', prompt_running: 'Prompt running', fix_initiated: 'Initiated fix', fix_in_progress: 'Attempting fix', fixed_awaiting_restart: 'Fix ready', awaiting_test: 'Awaiting test', needs_manual_review: 'Needs review', fixed: 'Fixed', dup: 'Duplicate', wontfix: "Won't fix" };
const LABELS = { open: 'Opened', prompt_running: 'Prompts running', fix_initiated: 'Initiated fix', fix_in_progress: 'Attempting fix', fixed_awaiting_restart: 'Fix attempted, awaiting restart', awaiting_test: 'Awaiting test', needs_manual_review: 'Needs review' };
export const statusName = (key) => LABELS[normStatus(key)] ?? TAGS[normStatus(key)] ?? String(key);
export const STATUS_LABELS = Object.fromEntries(STATUS_ORDER.map((s) => [s, statusName(s)]));

// The notice the bot posted in the thread for each status (kept so the fixer sees the same history it always saw).
export const NOTES = {
  open: 'This report is **opened** again.',
  confirmed: 'A Mod has **confirmed** this bug. Thanks for the clear report!',
  info: 'We need a bit more **information** to look into this. Add the detail as a comment on the panel.',
  prompt_ready: 'Claude has written a **fix prompt** for this report. A developer will pick it up.',
  prompt_running: 'A developer started the **fix prompt**. This moves to **Fix ready** when it is done.',
  fix_initiated: 'Claude is looking at this report to pick a model and effort for the fix.',
  fix_in_progress: 'Attempting an automatic fix for this now.',
  fixed_awaiting_restart: 'A fix has been **attempted**. It goes live once it is applied and the resource restarts.',
  awaiting_test: 'The server has restarted with this fix. Please test it and press **Works** if it does, or **Not fixed** (and say what did not work) if it does not.',
  needs_manual_review: 'This needs a **manual review** before another attempt.',
  fixed: 'This bug is **fixed**. Thanks for reporting it!',
  dup: 'This looks like a **duplicate** of another report, so it is being closed.',
  wontfix: "This one is marked **won't fix**. Thanks for taking the time to report it.",
};
export const notFixedEscalationNote = (n) => `This fix has been marked **Not fixed** ${n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`}, so it needs a **manual review** before another attempt.`;

// UI permissions. role: 'tester'|'dev'|'admin'. op: a target status, or 'not_fixed' | 'works'.
const DEV_SET = new Set(['confirmed', 'info', 'needs_manual_review', 'open']);
export const ROLE_RANK = { tester: 1, dev: 2, admin: 3 };
export const hasRole = (role, min) => (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[min] ?? 99);

export function canSet({ role, op, from }) {
  if (op === 'not_fixed' || op === 'works') return normStatus(from) === 'awaiting_test' && hasRole(role, 'tester');
  if (!isStatus(op)) return false;
  if (role === 'admin') return true;
  if (role === 'dev') return DEV_SET.has(op);
  return false;
}
// What the UI may offer for a status and role (for buttons).
export function allowedOps({ role, from }) {
  const ops = [];
  if (canSet({ role, op: 'works', from })) ops.push('works');
  if (canSet({ role, op: 'not_fixed', from })) ops.push('not_fixed');
  for (const s of STATUS_ORDER) if (s !== normStatus(from) && canSet({ role, op: s, from })) ops.push(s);
  return ops;
}

// The transition rule. op: target status | 'not_fixed' | 'works'. Returns { to, notFixedCount?, testing, escalated } or { error }.
export function decide({ from, op, notFixedCount = 0, manualReviewAfter = MANUAL_REVIEW_AFTER }) {
  const current = normStatus(from);
  if (op === 'works') {
    if (current !== 'awaiting_test') return { error: 'only an issue awaiting test can be marked as working' };
    return { to: 'fixed', testing: true };
  }
  if (op === 'not_fixed') {
    if (current !== 'awaiting_test') return { error: 'only an issue awaiting test can be marked Not fixed' };
    const count = (notFixedCount ?? 0) + 1;
    const escalated = manualReviewAfter > 0 && count >= manualReviewAfter;
    return { to: escalated ? 'needs_manual_review' : 'open', notFixedCount: count, testing: true, escalated };
  }
  const to = normStatus(op);
  if (!isStatus(to)) return { error: `unknown status ${op}` };
  return { to, testing: false };
}

const NO_TRIAGE_XP = new Set(['prompt_ready', 'prompt_running', 'fix_initiated', 'fix_in_progress', 'fixed_awaiting_restart', 'awaiting_test']);

// XP events (QA-CONTRACTS §7 + changes: bug_posted is emitted by createIssue) for one transition. Idempotency per (issueId, event, discordId) is the outbox's unique key, so
// "once per issue" rules need no flags except fixed_paid (imported issues already paid). Returns { events:[{event, discordId}], setFixedPaid }.
//   bug_confirmed: -> confirmed, reporter.           bug_fixed: -> fixed, reporter, unless fixed_paid.
//   bug_revoked: -> dup, reporter (communitybot revokeBugPost: dup only, takes the bug_posted XP back; the bot dedupes).
//   bug_triaged: a person's (dev/admin, or a tester's Works / Not fixed) status change on someone else's issue, not to a fixer status.
export function xpFor({ from, to, reporterId, actorId = null, actorRole = null, system = false, testing = false, fixedPaid = false }) {
  const events = [];
  let setFixedPaid = false;
  if (to === 'confirmed' && reporterId) events.push({ event: 'bug_confirmed', discordId: reporterId });
  if (to === 'fixed' && reporterId && !fixedPaid) { events.push({ event: 'bug_fixed', discordId: reporterId }); setFixedPaid = true; }
  if (to === 'dup' && from !== 'dup' && reporterId) events.push({ event: 'bug_revoked', discordId: reporterId });
  if (!system && actorId && actorId !== reporterId) {
    if (testing || ((actorRole === 'dev' || actorRole === 'admin') && !NO_TRIAGE_XP.has(to))) events.push({ event: 'bug_triaged', discordId: actorId });
  }
  return { events, setFixedPaid };
}

// Plain one-line text (communitybot bughook cleanText minus the Discord-specific escaping): no control characters.
export function cleanText(text) {
  return String(text).replace(/[\x00-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
