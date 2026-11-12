# kora-qa-panel web UI

Vite + React + TypeScript + Tailwind, built to `web/dist` and served by the panel under `/qa/` (SPA fallback).
Look and tokens follow kora_lib/web (shadcn-style components) and kora_theme colours.

```
pnpm build:web            # from the repo root: install + tsc --noEmit + vite build
cd web && pnpm dev        # dev server, proxies /qa/api|auth|files to QA_PANEL_URL (default http://127.0.0.1:47620)
cd web && pnpm theme      # regenerate src/styles/theme-tokens.css after kora_theme/theme.json changes
```

Built strictly against `../docs/API.md`. Notes:
- Routes (basename `/qa`): `/`, `/issues`, `/issues/:id`, `/retests`, `/scenarios` (`?tab=coverage|invalid`), `/scenarios/:id`,
  `/runs`, `/runs/:id`, `/fixes`, `/fixes/:issueId` (dev+, Apply/Revert admin), `/testers`, `/testers/:discordId`, `/users` (admin).
- Buttons on an issue come from `allowedOps`; nav items are hidden by role.
- Issue filters: `state=open|closed` for groups, `status=` for literal statuses (as the API).
- The fix review checklist is the apply-fix skill's "Review" section; the per-item hit counts are a regex scan of added
  diff lines (a hint, not a verdict).
