# kora-qa-panel — install

Nothing in this folder is installed automatically. Run these by hand (as root) when the panel goes live.
`deploy/fixer/` is the separate fixer change set (see `deploy/fixer/NOTES.md`).

| file | goes to |
|---|---|
| `kora-qa-panel.service` | `/etc/systemd/system/kora-qa-panel.service` |
| `sudoers-kora-qa` | `/etc/sudoers.d/kora-qa` (0440) |
| `nginx-qa.conf` | pasted into the `zap.ssite.co.uk` server block in `/etc/nginx/sites-enabled/zap.ssite.co.uk` |

Already done during the build: MariaDB database `kora_qa` + user `kora_qa@localhost`/`@127.0.0.1` (rights on
`kora_qa` and `kora_qa_test` only), `/etc/kora-qa/config.env`, `/etc/kora-qa/secrets.env` (0600, root),
`/var/lib/kora-qa/{files,conversion,import}`, migrations applied.

## 1. User, files, permissions

```sh
useradd --system --home-dir /var/lib/kora-qa --shell /usr/sbin/nologin koraqa
chown -R koraqa:koraqa /var/lib/kora-qa
chown root:koraqa /etc/kora-qa/secrets.env && chmod 0640 /etc/kora-qa/secrets.env
# the Fixes page reads the fixer's folders directly (bugfixer owns them, mode 750):
setfacl -m u:koraqa:rx /var/lib/claude-bugfix /var/lib/claude-bugfix/fixes
setfacl -R -m u:koraqa:rX /var/lib/claude-bugfix/fixes
setfacl -R -d -m u:koraqa:rX /var/lib/claude-bugfix/fixes     # new fix folders too
sudo -u koraqa test -r /var/lib/claude-bugfix/fixes && echo fixes readable
```

`RES_DIR` is world-readable (`other::r-x`), which is all the scenario scanner needs. Without the fixes ACL the
panel still works, but the Fixes page shows "permission denied" and `server-started` holds every issue that
has a fix folder (it can't see `applied.json`), so set it.

## 2. Code + DB

```sh
cd /home/DevTestingKora/kora/kora-qa-panel
pnpm install --prod --frozen-lockfile
sudo -u koraqa node server/migrate.js        # idempotent
# UI (session S5): cd web && pnpm install && pnpm build   -> web/dist, served at /qa/
```

## 3. Secrets to fill in (`/etc/kora-qa/secrets.env`)

- `DISCORD_CLIENT_SECRET` — Developer Portal → the bot's application → OAuth2: copy (or reset) the Client Secret, and
  add the redirect `https://zap.ssite.co.uk/qa/auth/callback`. Until it is set, `/qa/auth/login` shows
  "Login is not set up yet".
- `ADMIN_DISCORD_IDS` — comma list of Discord ids that become admin on login.
- `KORA_QA_GAME_SECRET` → also in the FXServer config as `set kora_qa_secret "<value>"` (never `sets`), plus
  `set kora_qa_panel_url "http://127.0.0.1:47620/qa/game"` and `set kora_qa_enabled 1`.
- `QA_XP_SECRET` → also in communitybot `.env` as `QA_XP_SECRET=<value>` (S3's `/qa-xp` route).
- `BUG_HOOK_SECRET` is already the fixer's value.

Roles from Discord (recommended; Jamie's decision): roles are read from the Kora guild at every login and the OAuth scope
becomes `identify guilds.members.read` (no bot token involved). Set in config.env:

```
DISCORD_GUILD_ID=1565098239345303633
DISCORD_ADMIN_ROLE_IDS=1565106012275351674      # Mod -> admin
DISCORD_TESTER_ROLE_IDS=1565463029506641960     # Early Tester -> tester
DISCORD_DEV_ROLE_IDS=                           # optional -> dev
```

Mod wins over dev over tester; anyone with none of them (or not in the guild) is refused and listed on the Users page.
`ADMIN_DISCORD_IDS` still forces admin. In game, `GET /qa/game/tester` only knows people who have logged into the panel once
(or were imported); others get `allowed:false, reason:'log into the panel once'`.

Without `DISCORD_GUILD_ID`: login policy `OPEN_SIGNUP=0` (config.env) lets in only users already in the `users` table (imported testers,
users added on the Users page) and `ADMIN_DISCORD_IDS`. Refused logins are listed on the Users page.

## 4. sudoers (Apply / Revert / diff on the Fixes page)

```sh
visudo -cf deploy/sudoers-kora-qa && install -m 0440 deploy/sudoers-kora-qa /etc/sudoers.d/kora-qa
sudo -u koraqa sudo -n /opt/claude-bugfix/apply-fix.sh --list | head
```

Without it the Fixes page still shows each diff (read from the `.patch` files), but Apply/Revert answer 502 with
sudo's error.

## 5. systemd

```sh
install -m 0644 deploy/kora-qa-panel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kora-qa-panel
journalctl -u kora-qa-panel -f
curl -s 127.0.0.1:47620/qa/api/me
curl -s -H "Authorization: Bearer $(. /etc/kora-qa/secrets.env; echo $BUG_HOOK_SECRET)" '127.0.0.1:47616/bugs?active=1' | head -c 300
```

## 6. nginx

Paste `nginx-qa.conf` into the `zap.ssite.co.uk` 443 server block, then `nginx -t && systemctl reload nginx`. Check:
`curl -sI https://zap.ssite.co.uk/qa/game/scenarios` → 404, `curl -s https://zap.ssite.co.uk/qa/api/me` → JSON.

## 7. Cut-over (bughook port)

The panel's hook listens on `HOOK_PORT=47616` while communitybot still owns `127.0.0.1:47613`. At cut-over (after the
final import, communitybot's bug modules off — see communitybot/QA-CUTOVER.md):

```sh
sed -i 's/^HOOK_PORT=.*/HOOK_PORT=47613/' /etc/kora-qa/config.env
systemctl restart kora-qa-panel
/opt/claude-bugfix/bugfix.sh --dry-run          # against the panel, before re-enabling claude-bugfix.timer
```

`HOOK_URL` in `/etc/claude-bugfix/config.env` stays `http://127.0.0.1:47613`. For a dry run before cut-over:
`HOOK_URL=http://127.0.0.1:47616 /opt/claude-bugfix/bugfix.sh --dry-run`.

## Ports

| listener | address |
|---|---|
| UI + `/qa/api` + `/qa/auth` + `/qa/files` + `/qa/game` | `127.0.0.1:47620` |
| bughook-compatible API | `127.0.0.1:${HOOK_PORT}` (47616 → 47613 at cut-over) |
