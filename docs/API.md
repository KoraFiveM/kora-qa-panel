# kora-qa-panel — HTTP API

Everything the UI (S5) needs. The panel listens on `127.0.0.1:47620` and is mounted at **`/qa`** (public URL
`https://zap.ssite.co.uk/qa/`). Vite `base: '/qa/'`. All UI calls are same-origin `fetch` with the session cookie.

- **Auth**: cookie `kqa_sid` (Path=/qa, HttpOnly, Secure, SameSite=Lax), set by the Discord login. No bearer tokens for the UI.
- **JSON** in and out (`Content-Type: application/json` on POST). Times are **ms epoch numbers** unless noted
  (fix meta `createdAt`/`appliedAt` are ISO strings — they come from the fixer's files).
- **Ids**: issue ids are **strings** of 15–25 digits (never parse them as numbers). Run, message, attachment, event and
  user ids are numbers. Scenario ids are strings `"<resource>:<relpath>:<line>"` — **URL-encode** them in paths.
- **Errors**: non-2xx with `{ "error": "message" }`. `401` not logged in, `403` role too low (or cross-site Origin),
  `404` not found, `409` conflict (status changed / already that status / not allowed in this status), `400` bad input,
  `502` apply-fix failed.
- **Roles**: `tester` < `dev` < `admin`. "role ≥ X" below. Every `/qa/api` route except `/me` needs a login.
- Unknown `GET /qa/*` paths outside `/qa/api|game|auth|files` return the SPA `index.html` (deep links work).
  `web/dist` is looked up per request (no restart after `pnpm build:web`): existing files are served (hashed/`assets/`
  files `Cache-Control: public, max-age=31536000, immutable`, others and `index.html` `no-cache`); a missing
  `/qa/assets/*` or any missing path with a file extension is a plain 404, never index.html.

## Contents
- [Auth](#auth) · [Me & meta](#me--meta) · [Dashboard](#dashboard) · [Issues](#issues) · [Files](#files)
- [Scenarios](#scenarios) · [Runs](#runs) · [Fixes](#fixes) · [Retests](#retests) · [Users](#users) · [Testers](#testers)
- [Shared object shapes](#shared-object-shapes) · [Status machine for the UI](#status-machine-for-the-ui)
- Appendix: [Game API](#appendix-a-game-api-qagame) · [Bughook-compatible API](#appendix-b-bughook-compatible-api-hook_port)

---

## Auth

| route | what |
|---|---|
| `GET /qa/auth/login?next=/qa/issues/123` | Redirects (302) to Discord (`scope=identify guilds.members.read` when `DISCORD_GUILD_ID` is set, else `identify`). `next` must start with `/qa/` (else `/qa/`). If OAuth isn't configured (no client secret) → **503 HTML page** "Login is not set up yet". |
| `GET /qa/auth/callback?code&state` | Discord redirect target. Success → sets `kqa_sid`, 302 to `next`. HTML error pages: 400 (state mismatch / cancelled), 403 ("No access": not on the Kora guild or no mapped role; "Access removed": disabled; permissions not granted; or — without guild roles — account not on the panel; refused attempts are listed on the Users page), 502 (Discord error). |
| `POST /qa/auth/logout` | Deletes the session, clears the cookie → `{ "ok": true }` |
| `GET /qa/auth/dev-login?discordId=…&role=tester\|dev\|admin&name=…&next=…&redirect=0` | **Local testing only**: `DEV_LOGIN=1` and a direct loopback request (never through nginx), else 404. Creates/updates the user, logs in. `redirect=0` → `{ "ok": true, "user": User }` instead of a 302. |

**Roles come from Discord** (when `DISCORD_GUILD_ID` is set): at every login the panel reads the member's roles in the
Kora guild (`GET /api/v10/users/@me/guilds/{guild}/member` with the user's token) and overwrites the stored role:
`DISCORD_ADMIN_ROLE_IDS` (Mod) → admin, else `DISCORD_DEV_ROLE_IDS` → dev, else `DISCORD_TESTER_ROLE_IDS` (Early Tester) → tester;
none (or not in the guild) → refused. `ADMIN_DISCORD_IDS` always makes admin. Disabled users stay disabled. Role changes are
logged (`roleChanges` on `GET /users`). Role edits on the Users page only last until that user's next login in this mode
(`rolesFromDiscord: true` in `/me` and `/users` — show that hint).

UI flow: call `GET /qa/api/me`; if `user` is null show a "Log in with Discord" button linking to `loginUrl`
(add `?next=` + current path). Logout: `POST /qa/auth/logout` then reload.

## Me & meta

### `GET /qa/api/me` (no login needed)
```json
{
  "user": { "id": 2, "discordId": "100000000000000001", "name": "Jamie", "avatar": "a1b2c3", "avatarUrl": "https://cdn.discordapp.com/avatars/100000000000000001/a1b2c3.png?size=64",
            "role": "admin", "legacy": false, "createdAt": 1794255844571, "lastLoginAt": 1794255844571 },
  "rolesFromDiscord": true, "oauthConfigured": true, "devLogin": false, "loginUrl": "/qa/auth/login", "publicUrl": "https://zap.ssite.co.uk/qa"
}
```
`user` is `null` when not logged in.

### `GET /qa/api/meta` (role ≥ tester)
Static lists for filters/labels plus the merged step catalog (for authoring help / step tooltips).
```json
{
  "statuses": [ { "key": "open", "label": "Opened", "closed": false }, { "key": "info", "label": "Needs info", "closed": false },
                { "key": "confirmed", "label": "Confirmed", "closed": false }, { "key": "prompt_ready", "label": "Prompt ready", "closed": false },
                { "key": "prompt_running", "label": "Prompts running", "closed": false }, { "key": "fix_initiated", "label": "Initiated fix", "closed": false },
                { "key": "fix_in_progress", "label": "Attempting fix", "closed": false }, { "key": "fixed_awaiting_restart", "label": "Fix attempted, awaiting restart", "closed": false },
                { "key": "awaiting_test", "label": "Awaiting test", "closed": false }, { "key": "needs_manual_review", "label": "Needs review", "closed": false },
                { "key": "fixed", "label": "Fixed", "closed": true }, { "key": "dup", "label": "Duplicate", "closed": true }, { "key": "wontfix", "label": "Won't fix", "closed": true } ],
  "roles": ["tester", "dev", "admin"], "kinds": ["bug", "suggestion"], "sources": ["discord", "scenario", "freeform", "retest"],
  "runStatuses": ["running", "passed", "failed", "aborted", "blocked"],
  "stepStatuses": ["pending", "passed", "failed", "skipped", "unverified", "blocked"],
  "manualReviewAfter": 3,
  "steps": [ { "id": "items.have", "pattern": "I have {int} {string}", "kind": "setup", "side": "server", "resource": "kora_qa", "priority": 0,
               "description": "Sets the amount of an item in my inventory to exactly N …", "example": "Given I have 3 \"water\"",
               "args": [ { "name": "count", "type": "int", "cap": "maxItemCount", "min": 1 }, { "name": "item", "type": "string", "allow": "items" } ] } ],
  "caps": { "maxItemCount": 50, "maxMoney": 100000, "maxEntities": 6, "maxWaitSeconds": 120, "itemDeny": [], "itemAllow": null, "modelDeny": ["rhino"], "allowCommands": [], "accounts": ["cash", "bank", "crypto"], "metadataDeny": [], "weather": ["CLEAR"], "inventoryTypes": ["player", "trunk"] },
  "catalog": { "source": "…/[kora]/kora_qa/shared/steps.json", "error": null, "count": 77 },
  "registryAt": 1794255844000
}
```
`statuses` is in display order. Step `kind` ∈ `setup|observed|check|manual`.

## Dashboard

### `GET /qa/api/dashboard` (role ≥ tester)
```json
{
  "issuesByStatus": { "open": 1, "info": 0, "confirmed": 1, "prompt_ready": 25, "prompt_running": 0, "fix_initiated": 0, "fix_in_progress": 0,
                      "fixed_awaiting_restart": 0, "awaiting_test": 9, "needs_manual_review": 0, "fixed": 277, "dup": 5, "wontfix": 11 },
  "openTotal": 36, "awaitingTest": 9, "waitingFixes": 1,
  "runsToday": { "total": 1, "passed": 0, "failed": 1 },
  "passRateByResource": [ { "resource": "kora_fishing", "runs": 1, "passed": 0, "failed": 1, "rate": 0 } ],
  "flaky": [ { "scenarioId": "kora_hud:tests/id.feature:3", "name": "/id toggles…", "resource": "kora_hud", "passed": 3, "failed": 1 } ],
  "recentIssues": [ IssueSummary, … ],
  "scan": { "at": 1794255844220, "scenarios": 6, "valid": 5, "invalid": 2, "catalogError": null },
  "xpOutbox": { "pending": 4, "failing": 0 }
}
```
`passRateByResource` and `flaky` cover the last 30 days (non-legacy and legacy runs with a scenario). `rate` is 0..1
or `null`. `flaky` = scenarios with both passes and fails in that window. `recentIssues` = 10 most recently updated.

## Issues

### `GET /qa/api/issues` (role ≥ tester)
Query (all optional):

| param | meaning |
|---|---|
| `status` | comma list of **literal** status keys (`status=open` = only issues whose status is `open`) |
| `state` | `open` = every non-closed status, `closed` = fixed, dup, wontfix (combinable with `status`) |
| `open` | `open=1` = same as `state=open` |
| `kind` | `bug`, `suggestion` (comma list) |
| `source` | `discord`, `scenario`, `freeform`, `retest` (comma list) |
| `resource` | resource name: issues whose scenario is in it or whose fix touches it |
| `reporter` | Discord id |
| `q` | text in title / reporter name; a 15–25 digit value matches the issue id exactly |
| `sort` | `updated` (default) / `created` / `status` (newest first) |
| `page`, `pageSize` | 1-based; pageSize default 50, max 200 |

```json
{ "items": [ { "id": "1569447507069370368", "title": "Selling a fish pays cash — failed: my cash balance should have changed by 50", "kind": "bug",
               "status": "confirmed", "statusLabel": "Confirmed", "source": "scenario",
               "reporter": { "discordId": "300000000000000001", "name": "Tess" },
               "scenarioId": "kora_fishing:tests/selling.feature:8", "runId": 1, "failedStep": 6, "notFixedCount": 0, "fixedPaid": false,
               "createdAt": 1794255844609, "updatedAt": 1794255844649, "statusAt": 1794255844649, "messages": 2, "attachments": 1 } ],
  "total": 1, "page": 1, "pageSize": 50 }
```

### `GET /qa/api/issues/:id` (role ≥ tester)
```json
{
  "issue": { …IssueSummary, "report": Report | null, "modOverride": { "reason": "try the server side", "by": "Jamie", "byDiscordId": "1000…", "at": 1794255844000 } | null,
             "legacy": { …imported Discord metadata… } | null, "url": "https://zap.ssite.co.uk/qa/issues/1569447507069370368" },
  "renderedReport": "# Selling a fish pays cash …\n\n## Scenario: …\n```gherkin\n✅ Given I am at \"pier\"\n❌ Then my cash balance should have changed by 50   <-- failed here\n```…" ,
  "messages": [
    { "id": 1, "author": { "discordId": "100000000000000001", "name": "Jamie" }, "isBot": false, "content": "Reproduced on the pier.", "createdAt": 1794255844641, "attachments": [] },
    { "id": 2, "author": { "discordId": null, "name": "Kora QA" }, "isBot": true,
      "content": "A Mod has **confirmed** this bug. Thanks for the clear report!\nNote: repro ok\n_Changed by Jamie._", "createdAt": 1794255844649, "attachments": [] }
  ],
  "attachments": [ { "id": 1, "messageId": null, "kind": "screenshot", "mime": "image/jpeg", "size": 48213, "url": "/qa/api/files/1",
                     "signedUrl": "https://zap.ssite.co.uk/qa/files/1?t=mwjxedc0.qZsS…", "originalUrl": null, "createdAt": 1794255844633 } ],
  "events": [
    { "id": 1, "at": 1794255844609, "by": { "discordId": "300000000000000001", "name": "Tess" }, "type": "status", "from": null, "to": "open", "note": "created", "data": { "source": "scenario" } },
    { "id": 2, "at": 1794255844609, "by": { "discordId": null, "name": null }, "type": "xp", "from": null, "to": null, "note": "bug_posted → 300000000000000001", "data": { "events": [ { "event": "bug_posted", "discordId": "300000000000000001" } ] } },
    { "id": 4, "at": 1794255844641, "by": { "discordId": "100000000000000001", "name": "Jamie" }, "type": "comment", "from": null, "to": null, "note": "Reproduced on the pier.", "data": { "messageId": 1 } },
    { "id": 5, "at": 1794255844649, "by": { "discordId": "100000000000000001", "name": "Jamie" }, "type": "status", "from": "open", "to": "confirmed", "note": "repro ok", "data": { "op": "confirmed", "system": false } },
    { "id": 9, "at": 1794255999000, "by": { "discordId": null, "name": "claude-bugfix" }, "type": "status", "from": "fix_in_progress", "to": "fixed_awaiting_restart",
      "note": "Fix ready for review (kora_fishing, risk: low, patch 21f8baf71d). Waiting for approval before it goes live.",
      "data": { "op": "fixed_awaiting_restart", "system": true, "hook": "fixed_awaiting_restart",
                "attempt": { "commit": "21f8baf", "patchId": "21f8baf71d", "resource": "kora_fishing", "model": "claude-sonnet-5-5", "summary": "Sell price was nil.", "reasoning": "One-line nil check.", "at": 1794255999000 } } }
  ],
  "fixes": [ { "id": 3, "patchId": "21f8baf71d", "model": "claude-sonnet-5-5", "risk": "low", "summary": "…", "details": "…", "testSteps": "…", "scenario": null, "applied": { "appliedAt": "2026-11-09T10:00:00+00:00", "backupTag": "…" } | null, "isHistory": false, "createdAt": 1794255000000 } ],
  "currentFix": { "state": "waiting", "appliedAt": null, "patchId": "21f8baf71d", "model": "claude-sonnet-5-5", "risk": "low", "summary": "Sell price was nil for fish.", "resources": ["kora_fishing"] } | null,
  "runs": [ Run ],
  "prompts": [ { "id": 1, "kind": "plan", "content": "…markdown…", "meta": {}, "createdAt": 1794255000000 } ],
  "scenario": Scenario (with "steps") | null,
  "allowedOps": ["works", "not_fixed"],
  "promptPreview": { "threadId": "1569447507069370368", "title": "…", "status": "confirmed", "url": "https://zap.ssite.co.uk/qa/issues/1569447507069370368",
                     "messages": [ { "author": "Tess", "isBot": false, "createdAt": "2026-11-09T19:44:04.609Z", "content": "# Selling a fish…(rendered report)", "attachments": ["https://zap.ssite.co.uk/qa/files/1?t=…"] },
                                   { "author": "Jamie", "isBot": false, "createdAt": "2026-11-09T19:44:04.641Z", "content": "Reproduced on the pier.", "attachments": [] } ],
                     "modOverride": { "reason": "…", "by": "Jamie", "at": "2026-11-09T…Z" } }
}
```
- `messages` = comments + bot notices (status changes, fixer notes). The report itself is **not** a message here:
  show `renderedReport` (markdown) or build your own view from `issue.report` (see Report shape) at the top.
- `attachments` = all of the issue's files; those with `messageId: null` belong to the report (screenshots).
  Use `url` in `<img>` (session cookie). `signedUrl` works without a session for 7 days.
- `event.type` ∈ `status|comment|meta|fix|xp|import`. `fix` events carry `data.output` (apply-fix output tail).
- `allowedOps` = the buttons this user may press now: `works`, `not_fixed` (testers, only while `awaiting_test`)
  and target status keys (dev: `confirmed info needs_manual_review open`; admin: every status). See the status machine below.
- `promptPreview` is exactly what the fixer gets from `GET /bug/:id` (`createdAt` is ISO there). Show it raw (JSON or the BUG.md form: `# title`, `## author (createdAt)`, content).
- `currentFix` reads the fixer's folder; `fixes` are DB copies (current + history) synced when the fixer posts `fixed_awaiting_restart` and after Apply/Revert.

### `POST /qa/api/issues/:id/comments` (role ≥ tester)
Request `{ "content": "Me too, every time" }` (1–4000 chars, markdown) → `{ "ok": true, "messageId": 12 }`.
Bumps the issue's `updatedAt`, so the fixer looks at it again.

### `POST /qa/api/issues/:id/status` (role per status)
Request:
```json
{ "status": "confirmed", "note": "repro ok", "expect": "open" }
{ "status": "open", "override": "Try the server side this time: the client is fine." }
```
- `status`: any status key; allowed per role (dev: confirmed/info/needs_manual_review/open; admin: all).
- `note` (optional, ≤500): shown in the bot notice ("Note: …") and on the event.
- `override` (optional, ≤500, **only with `status: "open"`, role ≥ dev**): Mod override for the next automatic fix
  attempt. Stored on the issue (`modOverride`), posted as the bot line `Mod override: try a fix — <reason>` and exposed
  to the fixer. Cleared automatically when a fix becomes ready or the issue closes.
- `expect` (optional): the status the UI showed; if the issue moved on → 409 `status changed: expected X, is Y`.

Response `{ "ok": true, "from": "open", "to": "confirmed", "issue": IssueSummary }`.
Errors: 403 role/status not allowed, 409 `post is already marked Confirmed` / expect mismatch.

### `POST /qa/api/issues/:id/not-fixed` (role ≥ tester, issue must be `awaiting_test`)
`{ "note": "Still no money after selling" }` (required, 1–2000) → adds the note as the user's comment
(`**Not fixed:** …`), then `notFixedCount + 1` and the issue goes back to `open` — or to `needs_manual_review` once
the count reaches `manualReviewAfter` (3).
Response like `/status`: `{ "ok": true, "from": "awaiting_test", "to": "open", "issue": IssueSummary }`. 409 if not awaiting test.

### `POST /qa/api/issues/:id/works` (role ≥ tester, issue must be `awaiting_test`)
`{ "note": "Works now" }` (optional, ≤500) → `awaiting_test` → `fixed`. Response like `/status`.

### `POST /qa/api/issues/:id/meta` (role ≥ dev)
`{ "title": "Fishing: sell broken", "kind": "suggestion" }` (either or both) →
`{ "ok": true, "changed": true, "issue": IssueSummary }`.

## Files

`GET /qa/api/files/:attachmentId` (session) and `GET /qa/files/:attachmentId?t=<token>` (session **or** signed token)
→ the raw file (`image/webp|jpeg|png`), `Cache-Control: private`. 401 without session/valid token, 404 unknown.

## Scenarios

### `GET /qa/api/scenarios` (role ≥ tester)
Query: `resource`, `valid=1|0`, `tag=@smoke`, `q` (name/id), `removed=1` (include removed), `page`, `pageSize` (default 100, max 500).
```json
{
  "items": [ { "id": "kora_fishing:tests/selling.feature:8", "resource": "kora_fishing", "file": "tests/selling.feature", "line": 8,
               "name": "Selling a fish pays cash", "description": "1. Catch a fish and sell it at the shop.\nExpect: cash goes up.",
               "tags": ["@kora_fishing", "@target:3", "@legacy:fish-sell", "@smoke"], "target": 3, "hash": "de33bf1e…", "valid": true, "errors": [],
               "removed": false, "legacyIds": ["legacy:fish-sell"], "updatedAt": 1794255844220,
               "stepCount": 8, "passes": 0, "fails": 1, "distinctPassers": 0,
               "lastResult": { "status": "failed", "at": 1794255844591, "discordId": "300000000000000001" }, "done": false } ],
  "total": 5, "page": 1, "pageSize": 100,
  "resources": [ { "resource": "kora_fishing", "total": 5, "valid": 4, "invalid": 1 } ]
}
```
`passes` = number of passed runs, `distinctPassers` = distinct testers who passed (this is the **target progress**:
show `distinctPassers/target`), `done` = `distinctPassers ≥ target`. `resources` = per-resource counts over all non-removed scenarios.

### `GET /qa/api/scenarios/:id` (role ≥ tester; id URL-encoded)
```json
{ "scenario": { …as above, "steps": [ ScenarioStep ], "passes": 0, "fails": 1, "distinctPassers": 0, "lastResult": {…} },
  "runs": [ { …Run, "steps": [ { "idx": 0, "status": "passed", "at": 1794255844595 }, { "idx": 6, "status": "failed", "at": 1794255844601 } ] } ],
  "issues": [ IssueSummary ],
  "legacyTests": [ { "id": "fish-sell", "source": "game", "resource": "kora_fishing", "title": "…", "description": "…", "data": {} } ] }
```

`runs` = the last 100 runs, newest first; the **20 most recent carry `steps`** (per-step results by scenario step `idx`,
status ∈ stepStatuses) for last-run icons; older runs have no `steps` key. Legacy runs have `steps: []`.

### `GET /qa/api/scenarios/invalid` (role ≥ tester)
Invalid, non-removed scenarios with reasons, plus the last scan summary. A feature file that doesn't parse at all is
one item with `line: 0` and name `(<file> does not parse)`.
```json
{ "items": [ { "id": "kora_fishing:tests/selling.feature:30", …, "valid": false, "steps": [ ScenarioStep ],
               "errors": [ { "idx": 1, "line": 31, "text": "I have 500 \"fish\"", "message": "count 500 is over the cap maxItemCount=50" },
                           { "idx": 6, "line": 36, "text": "I dance the macarena", "message": "no step definition matches this step" } ] },
             { "id": "kora_broken:tests/bad.feature:0", "name": "(tests/bad.feature does not parse)", "errors": [ { "line": 5, "message": "inconsistent cell count within the table" } ], … } ],
  "scan": ScanSummary }
```
Argument errors use exactly kora_qa's wording (`shared/catalog.lua`, same rules on both sides), e.g.
`"500" (count) is over the maxItemCount cap (50)`, `"tank" (model) is on the model denylist`,
`"nowhere" (location) is not a known location alias`, `"x" (item) is on the item denylist`, `cap maxWaitSeconds is not configured`.
Other messages: `no step definition matches this step`, `ambiguous: matches a.b, c.d at priority 0`,
`scenario spawns 8 entities, over the cap maxEntities=6`, tag errors (`@target:0: target must be 1..50`).
`scan.matcherErrors` lists step definitions that fail kora_qa's shape check (`a.b: unknown kind magic`) and are ignored.

### `GET /qa/api/scenarios/coverage` (role ≥ tester)
Every resource under RES_DIR:
```json
{ "items": [ { "resource": "kora_fishing", "path": "[kora]/kora_fishing", "optedIn": true, "featureFiles": 1, "scenarios": 5, "valid": 4 },
             { "resource": "kora_plain", "path": "[kora]/kora_plain", "optedIn": false, "featureFiles": 1, "scenarios": 0, "valid": 0 } ],
  "withoutScenarios": ["kora_plain", "monitor"] }
```
`optedIn` = fxmanifest has `qa_feature`. `featureFiles` counts `tests/*.feature` even when not opted in.

### `POST /qa/api/scenarios/rescan` (role ≥ dev)
`{}` → `{ "ok": true, "scan": ScanSummary }` (also runs automatically on file changes and when kora_qa posts its registry).

ScanSummary:
```json
{ "at": 1794255844856, "ms": 35, "scenarios": 6, "valid": 5, "invalid": 2, "changed": 0, "removed": 0,
  "resources": [ { "name": "kora_fishing", "optedIn": true, "files": 1, "qaLuaError": null } ],
  "catalog": { "source": "…/kora_qa/shared/steps.json", "error": null, "count": 77 }, "registryAt": null,
  "matcherErrors": [], "fileErrors": [ { "resource": "kora_broken", "file": "tests/bad.feature", "line": 5, "message": "inconsistent cell count within the table" } ] }
```

### `GET /qa/api/scenarios/served` (role ≥ dev)
Exactly what kora_qa downloads (`GET /qa/game/scenarios`): `{ "hash": "<sha1>", "scenarios": [ ServedScenario ] }`
(`hash` changes when any scenario or any `passes` count changes).

## Runs

### `GET /qa/api/runs` (role ≥ tester)
Query: `scenarioId`, `discordId`, `status` (comma list), `legacy=0|1`, `resource`, `page`, `pageSize` (default 50, max 200).
```json
{ "items": [ { "id": 1, "scenarioId": "kora_fishing:tests/selling.feature:8", "scenarioHash": "de33bf1e…", "legacyTestId": null,
               "tester": { "discordId": "300000000000000001", "name": "Tess" }, "status": "failed", "startedAt": 1794255844591, "finishedAt": 1794255844609,
               "legacy": false, "issueId": "1569447507069370368", "note": "No money", "scenarioName": "Selling a fish pays cash", "resource": "kora_fishing" } ],
  "total": 1, "page": 1, "pageSize": 50 }
```

### `GET /qa/api/runs/:id` (role ≥ tester)
```json
{ "run": { …Run, "context": Report | { "retestIssueId": "…" } | null },
  "steps": [ { "idx": 0, "text": "I am at \"pier\"", "kind": "setup", "status": "passed", "detail": null, "at": 1794255844595 },
             { "idx": 6, "text": "my cash balance should have changed by 50", "kind": "check", "status": "pending", "detail": null, "at": 1794255844591 } ],
  "scenario": Scenario (with "steps") | null,
  "scenarioChanged": false }
```
`scenarioChanged` = the scenario was edited since this run (hash differs). The timeline / console / player context for
replay are in `run.context` (Report shape).

## Fixes

### `GET /qa/api/fixes?state=waiting|applied` (role ≥ dev)
Fixes prepared by claude-bugfix (one per issue, the current attempt). Omit `state` for all.
```json
{ "error": null,
  "items": [ { "issueId": "1569447507069370368", "state": "waiting", "appliedAt": null, "title": "Selling a fish pays cash", "issueStatus": "fixed_awaiting_restart",
               "kind": "bug", "model": "claude-sonnet-5-5", "risk": "low", "patchId": "21f8baf71d", "createdAt": "2026-11-09T10:00:00+00:00",
               "summary": "Sell price was nil for fish.", "reasoning": "One-line nil check.", "resources": ["kora_fishing"], "patches": ["kora_fishing.patch"],
               "scenarioFile": "kora_fishing/tests/issue-1569447507069370368.feature" } ] }
```
`error` is a string when the fixer's folder can't be read (permissions; see deploy/README.md) — show it.

### `GET /qa/api/fixes/:issueId` (role ≥ dev)
```json
{ "issueId": "1569447507069370368",
  "meta": { "threadId": "…", "title": "…", "model": "claude-sonnet-5-5", "patchId": "21f8baf71d", "createdAt": "2026-11-09T10:00:00+00:00", "kind": "bug",
            "summary": "…", "details": "…", "risk": "low", "testSteps": "…", "reasoning": "…",
            "config_options": [ { "name": "Config.x", "default": "1", "resource": "kora_fishing", "description": "…" } ],
            "resources": [ { "name": "kora_fishing", "path": "/…/[kora]/kora_fishing", "head": "deb4179", "patch": "kora_fishing.patch" } ],
            "scenario": "@issue-… Feature …" , "scenarioFile": "kora_fishing/tests/issue-….feature", "scenarioNote": null },
  "applied": { "appliedAt": "2026-11-09T10:05:00+00:00", "backupTag": "20261109-100500" } | null,
  "state": "waiting", "patches": ["kora_fishing.patch"],
  "show": "# title\nThread … · kind bug · … \n\nWhy …\n\nSummary: …\n\nDetails: …\n\nTest: …\n----- kora_fishing.patch\ndiff --git …",
  "diff": "----- kora_fishing.patch\ndiff --git a/base/kora_fishing/server.lua b/src/kora_fishing/server.lua\n…",
  "diffSource": "apply-fix --show",
  "showError": null,
  "history": [ { "ts": "20261101T000000Z", "patchId": "0a1b2c3d4e", "model": "…", "risk": "medium", "summary": "…", "createdAt": "…", "applied": null } ],
  "issue": IssueSummary | null }
```
- `diff` = one or more `----- <resource>.patch` headers each followed by a unified git diff (paths `base/<res>/…` → `src/<res>/…`).
- `diffSource`: `"apply-fix --show"` (via sudo) or `"patch files"` (fallback when sudo isn't set up; then `show` is null and `showError` says why).
- Show the apply-fix review checklist next to the diff (static UI text).

### `POST /qa/api/fixes/:issueId/apply` and `POST /qa/api/fixes/:issueId/revert` (role admin)
Request `{ "confirm": true, "noRestart": false }` — `confirm: true` is **required** (400 otherwise); `noRestart: true` = Apply/Revert without restarting the resource.
Runs `sudo /opt/claude-bugfix/apply-fix.sh --apply|--revert <id> [--no-restart]` (may take a minute).
```json
200 { "ok": true,  "code": 0, "output": "[2026-11-09 10:05:00] check kora_fishing: ok\n… applied kora_fishing\n… restart kora_fishing: …" }
502 { "ok": false, "code": 1, "output": "… ERROR: aborted: nothing was changed. The live files have moved on …" }
```
apply-fix itself posts the status change (`awaiting_test` after a restart, `needs_manual_review` after revert) through the hook;
refetch the issue afterwards. A `fix` event is added to the issue either way.

## Retests

### `GET /qa/api/retests` (role ≥ tester)
Issues awaiting a retest (oldest first): `{ "items": [ { …IssueSummary, "scenarioName": "Selling a fish pays cash" | null } ] }`.
Testers retest in game (kora_qa lists the same queue) or press Works / Not fixed on the issue page.

## Users

### `GET /qa/api/users` (admin)
```json
{ "items": [ User, … ],
  "pendingLogins": [ { "discordId": "100000000000000055", "name": "stranger", "at": 1794255844000, "reason": "no mapped Discord role" } ],
  "roleChanges": [ { "at": 1794255844000, "discordId": "200000000000000002", "name": "Rae", "from": "tester", "to": "admin", "source": "discord roles" } ],
  "rolesFromDiscord": true }
```
`pendingLogins` = refused logins, newest first; `reason` ∈ `no mapped Discord role` | `not on the panel`. With roles from Discord,
"Add as tester" doesn't help (the next login re-checks the Discord roles) — the person needs the Early Tester role.
`roleChanges` = last 50 role changes made by logins (`from: null` = account created; `source`: `discord roles` | `ADMIN_DISCORD_IDS`).

### `POST /qa/api/users` (admin)
`{ "discordId": "100000000000000055", "name": "stranger", "role": "tester" }` → `{ "ok": true, "user": User }` (creates, or updates the role of an existing user).

### `POST /qa/api/users/pending/:discordId/dismiss` (admin)
`{}` → `{ "ok": true, "dismissed": 1 }` — removes a refused sign-in from `pendingLogins`.

### `POST /qa/api/users/:discordId/disabled` (admin)
`{ "disabled": true }` → `{ "ok": true, "user": User, "sessionsRevoked": 2 }`. Disabling keeps all history (runs, issues,
comments) but revokes the user's sessions, refuses their login (Discord login shows "Access removed") and makes
kora_qa's `GET /tester` answer `allowed:false`. `{ "disabled": false }` re-enables. 409 for yourself or the last enabled admin.
`GET /users` lists disabled users last (`user.disabled: true`).

### `POST /qa/api/users/:discordId/role` (admin)
`{ "role": "dev" }` → `{ "ok": true, "user": User }`. 409 `cannot remove the last admin`.

## Testers

### `GET /qa/api/testers` (role ≥ tester)
```json
{ "items": [ { "discordId": "300000000000000001", "name": "Tess", "role": "tester",
               "runs": { "total": 12, "passed": 10, "failed": 2, "legacy": 8, "lastAt": 1794255844591 },
               "issues": { "reported": 3, "fixed": 2, "closed": 0 },
               "legacyStats": { …imported tester-activity / tester-of-month data… } | null } ] }
```
Sorted by passed runs + reported issues.

### `GET /qa/api/testers/:discordId` (role ≥ tester)
`{ "tester": TesterStats, "recentRuns": [ Run ] (50), "reported": [ IssueSummary ] (50) }`

---

## Shared object shapes

- **User**: `{ id, discordId, name, avatar, avatarUrl, role, legacy, disabled, disabledAt, createdAt, lastLoginAt }`
- **IssueSummary**: `{ id, title, kind, status, statusLabel, source, reporter:{discordId,name}, scenarioId, runId, failedStep, notFixedCount, fixedPaid, createdAt, updatedAt, statusAt }` (+ `messages`, `attachments` counts in lists)
- **Run**: `{ id, scenarioId, scenarioHash, legacyTestId, tester:{discordId,name}, status, startedAt, finishedAt, legacy, issueId, note }`
- **Scenario**: `{ id, resource, file, line, name, description, tags, target, hash, valid, errors, removed, legacyIds, updatedAt }` (+ `steps` where noted)
- **ScenarioStep** (QA-CONTRACTS §6): `{ idx, keyword, text, defId, kind, side, args, docString, dataTable, resolved? }` —
  `defId/kind/side` are `null` for a step that matched nothing; `resolved` holds alias targets
  (`{ "location": {x,y,z,h?,r?} }` with r = radius in metres, or `{ "model": "dinghy" }` when an alias/case changed the model).
- **ServedScenario**: `{ id, resource, name, description, tags, target, needs:{admin, players}, hash, passes, steps:[ScenarioStep] }` — `passes` = distinct testers with a passed run (target progress)
- **Report** (QA-CONTRACTS §6): `{ v, scenario:{id,hash,name}|null, failedIdx, steps:[{idx,text,status,detail}], expected, actual, note,
  frequency: "always|sometimes|once", timeline:[{at,type,data}], console:[{at,channel,line}],
  player:{coords:{x,y,z,h}, street, vehicle:{model,plate}|null, job:{name,grade,onduty}, money:{cash,bank}, health, armour},
  inventoryBefore:[…], inventoryAfter:[…], resources:[{name,version,state}], build,
  screenshot:{available, reason?}, teardown:[{id, idx, ok, error?}], moneyBefore:{cash,bank} }` plus `player.gang:{name,grade}` and
  `player.routingBucket` (S2 extras) — every field may be missing; render defensively.
  Step icons: passed ✅, failed ❌, skipped ⏭, pending/unverified/blocked ❔. Timeline `type` ∈
  `mark|notify|callback|nui|setup|error|console|item|inventory|vehicle|command`. Console entries may carry `error: true` (SCRIPT ERROR lines) — highlight them.
  `teardown` entries with `ok: false` mean a setup could not be undone (worth flagging on the issue page).

## Status machine for the UI

```
open → fix_initiated → fix_in_progress → fixed_awaiting_restart → awaiting_test → fixed      (fixer + apply-fix + server start)
     ↘ info, confirmed, prompt_ready, prompt_running, needs_manual_review, dup, wontfix
awaiting_test --Works--> fixed            awaiting_test --Not fixed--> open (count+1) | needs_manual_review (at 3)
```
- tester: Works / Not fixed (only `awaiting_test`), comment.
- dev: + confirmed, info, needs_manual_review, open (with optional Mod override), meta, rescan, fixes (read).
- admin: everything incl. dup / wontfix / fixed and Apply / Revert, users.
- Use `allowedOps` from the issue detail to decide which buttons to show; labels from `/meta` `statuses`.
- `fixed_awaiting_restart → awaiting_test` happens when kora_qa reports a server start and the fix was applied.

---

## Appendix A: Game API (`/qa/game`)

For kora_qa only (S2). Loopback only (requests with `X-Forwarded-For`/`X-Real-IP` or a non-loopback socket → 404),
`Authorization: Bearer KORA_QA_GAME_SECRET` (401). nginx returns 404 for `/qa/game/`. Not for the UI.

| route | request → response |
|---|---|
| `POST /registry` | `{steps:[StepDef], aliases:{<res>:{locations,vehicles,peds,props,fixtures}}, caps:Caps}` → `{ok:true, steps:n}`; triggers a rescan. Steps failing kora_qa's def check are ignored (listed in the scan's `matcherErrors`). |
| `GET /scenarios` | → `{hash, scenarios:[ServedScenario]}` (valid, not removed, not `@wip`; each with `passes`) |
| `GET /runs?discordId=&limit=` | → `{runs:[{runId, name (scenario name), scenarioId, status, issueId?, at}]}` newest first, limit default 30 (max 100) — kora_qa's "My runs" |
| `GET /tester?discordId=` | → `{allowed:true, role}` for a panel account (role as of the user's last panel login; imported legacy users keep their imported role) · `{allowed:false, role:null, reason:'log into the panel once'}` for unknown ids · `{allowed:false, role:null, reason:'disabled'}` |
| `POST /runs` | `{scenarioId, scenarioHash?, discordId, name, retestIssueId?}` → `{runId}`; 404 unknown/invalid scenario, 409 retest issue not awaiting_test. Creates `pending` run_steps for every step. |
| `POST /runs/:id/steps` | `{idx, status, detail}` → `{ok:true}`; 409 if the run is finished |
| `POST /runs/:id/finish` | `{status:'passed'|'failed'|'aborted'|'blocked', context?:Report, note?}` → `{ok:true}` or `{ok:true, issueId, url}`. Failed + context → new `scenario` issue (screenshots uploaded with `runId` are attached). With `retestIssueId`: passed → Works (fixed), failed → Not fixed with the failing step + rendered report as a comment. Passed → `test_passed` XP (once per tester per scenario version). |
| `POST /issues` | `{discordId, name, title, note, frequency?, kind?, report?}` → `{issueId, url}` (freeform) |
| `POST /uploads?issueId=` or `?runId=` | raw body `image/webp|jpeg|png` (sniffed) ≤ 8 MB → `{attachmentId}`; 415 not an image, 413 too big |
| `GET /retests?discordId=` | → `{retests:[{issueId, title, scenarioId, notFixedCount}]}` |
| `POST /server-started` | `{}` → `{moved:n, held:[issueId]}` — moves `fixed_awaiting_restart` → `awaiting_test` unless the fixer's patch for it is saved but not applied (no `applied.json`) |

## Appendix B: Bughook-compatible API (`127.0.0.1:${HOOK_PORT}`)

For claude-bugfix (unchanged scripts). `Authorization: Bearer BUG_HOOK_SECRET`. Same bodies, status codes and error texts
as communitybot's `modules/bughook.js` (see `test/hook.contract.test.js`, which replays lib.sh's calls).

| route | notes |
|---|---|
| `GET /bugs[?status=a,b][&active=1]` | `{bugs:[{threadId,title,status,updatedAt (ISO string),notFixedCount,kind}]}`; `active=1` drops closed issues whose last status change is > 7 days old; deleted never listed |
| `GET /bug/:id` | `{threadId,title,status,url,messages:[{author,isBot,createdAt (ISO),content,attachments:[url]}], modOverride?:{reason,by,at}}`; for scenario/freeform issues message 1 is the rendered report; max 50 messages, first kept |
| `POST /bug-status` | `{threadId,status,note?,commit?,model?,resource?,summary?,reasoning?,expect?}` → `{ok:true,threadId,status,previous}`; 409 `status changed: expected X, is Y` / `post is already marked <Label>` |
| `POST /bug-meta` | `{threadId,kind?,title?,status?∈open/info/dup/wontfix,note?}` → `{ok,threadId,kind,title,status,changed}` |
| `POST /resource-restart` | `{name}` → `{ok:true,message}`; 403 `protected` (PROTECTED_RESOURCES + kora_qa, or kora_qa's own ctl answers 403 protected resource), 404 unknown resource, 503 kora_qa disabled (`kora_qa_enabled 0`), 502 ctl unreachable / refused the panel's secret (401/403) / other errors |
