# claude-bugfix vs. the QA panel — what the fixer assumes about the bot

Files here are edited copies of the live fixer (`/opt/claude-bugfix`, `/etc/claude-bugfix/config.env`); nothing live was changed.

| file | diff | what changed |
|---|---|---|
| `prompts/triage-system.md` | `prompts-triage-system.diff` | knows the structured kora_qa report (Gherkin with ✅❌⏭❔, failed step, expected/actual, timeline, console errors, context JSON), all of it untrusted |
| `prompts/fix-system.md` | `prompts-fix-system.diff` | same, plus the optional regression `scenario` (read `[kora]/kora_qa/shared/steps.json`, only catalog patterns or `I manually:` / `I confirm:`, tags `@issue-<id> @regression @<resource>`); summary is shown on the panel, not Discord |
| `schemas/fix.json` | `schemas-fix.diff` | optional `scenario` string (≤ 8000) |
| `bugfix.sh` | `bugfix.diff` | snapshots `*.feature`; `add_scenario` writes `<res>/tests/issue-<id>.feature` into the edited resource and remakes its patch (adds `qa_feature 'tests/*.feature'` to its fxmanifest if missing); `meta.json` gets `scenario`, `scenarioFile`, `scenarioNote`; `IGNORE_TRIAGE_EFFORT=1` support |
| `config.env.new` | `config.env.diff` | all models `claude-sonnet-5-5`, all efforts `medium`, `FINAL_CYCLE=3`, `IGNORE_TRIAGE_EFFORT=1`; `HOOK_URL` unchanged. No secrets in it (secrets.env not copied) |

Install (at cut-over, by hand): `cp` the four files over `/opt/claude-bugfix/…` (keep `.bak` copies) and `config.env.new` over
`/etc/claude-bugfix/config.env`, then `bugfix.sh --dry-run` against the panel before re-enabling `claude-bugfix.timer`.
All four diffs apply cleanly to the live files (checked with `patch -p1` on a copy). `bash -n` passes; `add_scenario` was exercised in
a scratch work dir (added/tagged, wrong tag, two scenarios, over-long line, over MAX_PATCH_LINES → dropped and the resource restored;
the resulting patch passes `git apply -p3 --check`, which is what `apply-fix.sh` runs).

## Scenario in the patch: checks

- `syntax-check` skips `.feature` (unknown type → `SKIP`, exit 0), so `regression_check` passes for it; `fxmanifest.lua` with the
  added `qa_feature` line is still checked by `luac -p` (only counted if the original parsed).
- `patch_gate` (bytes, dist/build, minified, >2000-char lines) and `MAX_PATCH_LINES` are re-run after adding the scenario; if they
  fail, only the scenario is dropped (`scenarioNote`), never the fix.
- Before this change `snapshot_resource` did not copy `.feature` files, so a second fix for the same issue would have produced a
  "new file" patch for a file that already exists live and `apply-fix.sh` would refuse it. Now they are snapshotted.
- `apply-fix.sh` needs no change: `git apply -p3` creates `tests/`; revert deletes the file. Backups only cover existing files.

## What bugfix.sh / apply-fix.sh rely on from the hook (the panel must match)

1. **Hook API** at `HOOK_URL` (`127.0.0.1:47613`), Bearer `BUG_HOOK_SECRET` from `secrets.env`: `GET /bugs?active=1`, `GET /bug/<id>`,
   `POST /bug-status` (with `expect`), `POST /resource-restart` (apply-fix only). `POST /bug-meta` is **not** used by these scripts.
2. **Field names**: `threadId` (ids used as paths `fixes/<id>`, `state/<id>.json`, `locks/<id>.lock`; apply-fix requires
   `^[0-9]{15,25}$`), `title`, `status`, `updatedAt`, `notFixedCount`, `kind`; messages `author`, `isBot`, `createdAt`, `content`,
   `attachments` (array of URL strings).
3. **`updatedAt` is part of the seen-state key** (`status|updatedAt`). The bot sends an ISO string that changes on every status
   change and on thread activity. The panel must send the same type and bump it on comments too, or a reply on an issue won't make
   the fixer look again. Changing the format once (e.g. ms number) just makes every thread "new" once.
4. **`kind`**: `/bugs` items with `kind == "suggestion"` are skipped (batch and `--thread`). Triage's own `kind` (`bug`/`feature`) is
   separate and only lands in `meta.json`.
5. **Mod override**: read from bot messages (`isBot == true`) whose line starts `Mod override:` (the bot posts
   `Mod override: try a fix — <reason>`), else from a top-level `modOverride.reason` in `GET /bug/<id>` (contract §4 doesn't list that
   field). The panel must render `issues.mod_override` as one of those, or overrides silently stop working.
6. **409 texts** parsed: `status changed: expected X, is Y` (it extracts `, is <status>`) and `already marked`. Non-2xx other than
   those = failure; HTTP 000/5xx = "hook down, stop this run".
7. **Statuses posted**: `fix_initiated`, `fix_in_progress`, `fixed_awaiting_restart`, `needs_info` (stored as `info`),
   `needs_manual_review`; apply-fix posts `awaiting_test` (after a restart) and `needs_manual_review` (after revert). `dup` from
   triage is posted as `needs_manual_review` with "Possible duplicate of thread <id>". Candidates: `CANDIDATE_STATUSES=open,confirmed,reopen`
   plus threads this fixer left at `fix_initiated`/`fix_in_progress`.
8. **Retest detection**: `notFixedCount > 0` or an existing `fixes/<id>/meta.json` ⇒ "previous fix did not work"; fix cycle =
   `notFixedCount + 1`, past `FINAL_CYCLE` ⇒ `needs_manual_review` without a run.
9. **Fix folder**: `/var/lib/claude-bugfix/fixes/<id>/{meta.json,*.patch,BUG.md,TRIAGE.md,applied.json,history/}` is the
   interface the panel's Fixes page and import read. `applied.json` is written by apply-fix (root).
10. **Wording only** (harmless): "thread", "the bot", "is communitybot running?" in logs/notes; `apply-fix.sh --restart` comment says
    "via communitybot". The note texts end up on the panel as bot messages.
11. **Attachments** are only listed as URLs in BUG.md (the models have no WebFetch), so the panel's signed URLs are inert text there;
    they are stored in `fixes/<id>/BUG.md` and expire after 7 days.

## Behaviour the bot did around the fixer that the panel takes over

- **fixed_awaiting_restart → awaiting_test**: the bot's restart watch (`fivemrestart.js`) only moved a post when it had **no** patch
  or its patch was applied (`fixes/<id>/applied.json`), and held posts whose resource failed a `/server pull`. Contract §3 says
  "server started → every fixed_awaiting_restart → awaiting_test". Unapplied fixes would then be sent to testers. The panel should
  keep the `applied.json` rule.
- **Instant trigger**: the bot (`autofix.js`, off since 2026-11-07) started `claude-bugfix-thread@<id>.service` on new posts / Not
  fixed. After cut-over only `claude-bugfix.timer` runs (when re-enabled) unless the panel gets a way to start the unit.
- `manualReviewAfter` in the bot's config is **5**; the contract uses 3 and `FINAL_CYCLE=3` matches the contract.

## Other things to know

- **steps.json access**: the services run as user `bugfixer` (no extra groups), which must be able to read
  `RES_DIR/[kora]/kora_qa/shared/steps.json`. Checked 2026-11-09: there are **no ACLs** on `RES_DIR` or `[kora]/` (no access ACL, no
  default ACL). `bugfixer` reads them through plain `other::r-x` (`drwxr-xr-x root root` on every path component), so nothing is
  inherited: `kora_qa/` gets whatever mode its creator's umask gives (root's 022 → fine; 027/077 → unreadable). `kora_qa` didn't
  exist yet when checked. After it is created, verify:
  `sudo -u bugfixer test -r "$RES_DIR/[kora]/kora_qa/shared/steps.json" && echo ok`. If it's unreadable, the model is told to leave
  `scenario` empty (the fix itself is unaffected).
- **PROTECTED_RESOURCES** (`config.env.new`): `monitor,kora_qa`. A protected resource is listed to triage as "PROTECTED: do not
  choose", is refused by bugfix.sh if triage picks it anyway, and `apply-fix.sh` refuses to apply to or restart it. `kora_qa` is
  protected because a bad patch to the runner breaks the tests that are supposed to verify every other fix (and the panel never
  restarts it). `kora_lib` (and `kora_core`) are deliberately **not** protected: today they're fixable by design. The triage prompt
  routes kora_core/kora_lib fixes to the stronger model, and communitybot's auto-apply patches them but never restarts them
  (`autoApply.noRestartResources`). The bot's `fivem.protectedResources` is only `['monitor']`. Protecting kora_lib would turn
  every framework bug into needs_manual_review, which is a policy change for Jamie to make, not a cut-over detail.
- With `IGNORE_TRIAGE_EFFORT=1` and every model set to Sonnet, triage's model/effort picks no longer change anything; triage still
  decides the verdict and resources.
