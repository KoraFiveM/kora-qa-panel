# kora-qa-panel

QA panel for the Kora dev server: issues + status machine, bughook-compatible API for claude-bugfix, Gherkin scenario
scan/validation, game API for the `kora_qa` resource, Discord login, XP outbox to communitybot. See
`../PLAN-kora_qa.md`, `../QA-CONTRACTS.md`, `docs/API.md` (every route), `deploy/README.md` (install).

```
server/
  index.js          entry: migrate, panel on 127.0.0.1:PANEL_PORT, hook on 127.0.0.1:HOOK_PORT, workers
  app.js            Fastify app: /qa/auth, /qa/api, /qa/game, /qa/files, web/dist + SPA fallback
  config.js db.js ids.js migrate.js events.js
  machine.js        statuses, hook verbs, permissions, Not fixed rule, XP rules (pure)
  issues.js         transition() (status + event + bot notice + XP outbox in one tx), createIssue, addMessage, serverStarted
  hook.js           bughook-compatible API (GET /bugs, GET /bug/:id, POST /bug-status, /bug-meta, /resource-restart)
  bugview.js        the /bugs and /bug/:id bodies (also the panel's prompt preview)
  game.js           kora_qa API (registry, scenarios, runs, issues, uploads, retests, server-started)
  api.js auth.js    UI REST API, Discord OAuth + sessions
  fixes.js          claude-bugfix fix folders + sudo apply-fix.sh
  xp.js             XP outbox sender (backoff)
  files.js render-report.js
  scenarios/        lua.js catalog.js compile.js matcher.js validate.js scan.js (DB-free) · service.js (DB, watcher) · index.js (public API)
scripts/
  lib/scenarios.js  re-export of server/scenarios for scripts (conversion)
  lib/db.js         DB + issue helpers for scripts (import)
  validate-features.mjs   CLI: validate .feature files like the panel does
migrations/         NNN_name.sql, applied by `node server/migrate.js`
deploy/             systemd unit, sudoers, nginx snippet, install README (not installed); fixer/ = S3's fixer changes
test/               node:test suites (pnpm test) + fixtures (resources tree, steps.json snapshot, fake apply-fix)
```

Run: `pnpm install && node server/migrate.js && node server/index.js` (reads `/etc/kora-qa/*.env`; env vars override).
Test: `pnpm test` (uses database `kora_qa_test`, temp dirs; replays the fixer's lib.sh calls against the hook).
Validate features: `node scripts/validate-features.mjs <dir|file>... [--staging DIR] [--json]`.
