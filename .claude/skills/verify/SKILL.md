---
name: verify
description: Build, launch, and drive the ledger PWA end-to-end on an isolated scratch instance to verify a change at its real surface.
---

# Verifying ledger changes at runtime

Two apps share this tree (see root `CLAUDE.md`). Everything below "Build"
through the end of this file is **v1** (`cmd/ledger`, `frontend/`). For **v2**
(`cmd/ledgerd`, `web/`), skip to the "v2" section at the bottom.

## Build (frontend must precede Go — the bundle is embedded)

```bash
cd frontend && bun run build          # tsc -b && vite build → internal/web/dist/
cd .. && CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```

## Launch isolated (never the prod DB — default config opens /var/lib/ledger on :8080)

```toml
# scratch config.toml
[server]
listen = "127.0.0.1:18091"
data_dir = "/path/to/scratch/dir"
```

```bash
env -u LEDGER_AI_API_KEY ./ledger -config scratch.toml &   # unset key → AI stays off
curl -s http://127.0.0.1:18091/api/health                  # {"status":"ok",...}
```

No IMAP config → ingest disabled, which is what you want.

## Seed data

Accounts/projects via API (`POST /api/accounts`, `POST /api/projects`).
Review-queue transactions directly (sqlite3 CLI is installed; WAL allows it
while the app runs — the store sets busy_timeout):

```sql
INSERT INTO transactions (posted_at, amount, currency, direction, merchant_raw,
  last4, status, confidence, fingerprint, source, created_at, updated_at)
VALUES ('2026-07-20T14:00:00Z', 12500, 'AED', 'debit', 'MERCHANT', '4821',
  'needs_review', 0.97, 'fp-unique-1', 'email', '2026-07-20T14:00:00Z', '2026-07-20T14:00:00Z');
```

`fingerprint` must be unique. Reset between UI runs:
`UPDATE transactions SET status='needs_review', category_id=NULL, project_id=NULL; DELETE FROM rules;`

## Drive the UI headless

Playwright chromium is cached at
`/root/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`.
`bun add playwright-core` in a scratch dir, `chromium.launch({ executablePath })`,
viewport 390×844. Gotchas learned the hard way:

- Nav items match by accessible name: `page.locator("nav").getByText(/review/i)`.
- Swipe cards: `getByTestId("swipe-card")`; drag with `mouse.down()` + stepped
  `mouse.move` (~30ms apart) past 80px, or a 2-step fast move ≥24px for a flick.
- Dialogs dismiss via `getByTestId("dialog-scrim")` click (Escape targeting is
  unreliable), position `{x:10,y:10}`.
- jsdom tests can't catch pointer-capture click-retargeting bugs — toasts,
  drag surfaces with buttons inside need a real-browser pass.

## v2 (`cmd/ledgerd`, `web/`)

v2 has only partial harness coverage. Full docs: `web/harness/README.md`.

```bash
cd web
harness/v2stack.sh up                 # scratch Postgres + ledgerd + vite, prints an invite
node harness/v2settings.mjs <invite>  # walks sign-in, screenshots + audits Settings
node harness/recovery.mjs <invite>    # clears site data, restores keys from twelve words
harness/v2stack.sh down
```

`v2stack.sh up` starts `ledgerd` with **`--dns-fixtures`**, serving recorded
DKIM/ARC records offline so the corpus's signed bank mail verifies — without
it every message the harness posts reads as `unauthenticated` and no script
can reach the product. Any new v2 runner or stack script must pass it too.

Screens beyond Settings, recovery, the vault (`vault.mjs`) and the operator
sign-up/recover path (`operator.mjs`) rest on vitest alone — a real gap, not
a choice. Never point a v2 harness run at production: scratch ports (8123
API, 5177 UI) against a throwaway Postgres cluster under `/tmp`, never `:443`
and never the running `ledgerd` service.
