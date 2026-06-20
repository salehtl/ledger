# ledger

A private, self-hosted, real-time budgeting PWA for a single user.

Banks already email you a notification for every transaction. **ledger** turns
that stream into a live budget: one Go binary watches a dedicated IMAP mailbox,
parses each transaction email, categorizes it (rules first, AI only as a
fallback), stores it in SQLite, and serves a mobile React PWA showing budget
state against a 50/30/20 plan — all behind your private Tailscale network, never
public.

> **Scope:** built for one user on one box (`dinosaur`). It is intentionally not
> multi-tenant, not public, and not a SaaS. Amounts are AED; money is stored as
> integer **fils** (AED × 100), never floats.

## How it works

```
Email (per-transaction bank alerts)
  → IMAP ingest (read-only)        every email's raw body retained, nothing dropped
  → Parse cascade                  per-bank template → generic heuristic → AI (only on failure)
  → Categorize                     merchant→category rules first; AI only for unknown merchants
  → SQLite (single file, WAL)
  → HTTP API + SSE live stream + Web Push
  → Embedded React PWA
```

Design principles (the full list lives in [`CLAUDE.md`](CLAUDE.md)):

- **Deterministic-first.** AI is a *fallback* for extraction (and always
  low-confidence → review queue) and the *primary* tool only for categorizing
  unknown merchants.
- **Nothing is ever silently dropped.** Every email's full raw body is kept in
  `ingest_log`; anything unresolved is tagged `unparsed` and shown in the review
  queue. Fix the parser, reprocess, and missing transactions backfill.
- **Self-improving.** Every confirmed categorization writes back a
  merchant→category rule, so known merchants never hit the LLM again.
- **Single binary, single process.** Ingest worker, HTTP API, SSE, and the
  embedded PWA all live in one static Go binary — no Node at runtime, no broker,
  no external DB server.
- **Private and least-privilege.** Mailbox opened read-only (`EXAMINE`). The
  only data leaving the box is a bare merchant string sent to the AI, and that
  path is disableable. Secrets come from the environment, never config files.

## Features

- Live 50/30/20 budget (need / want / saving) with month progress and projection
- Transaction list with search, filter chips, and date-scope selection
- Swipe-deck review queue for fast categorization
- Manual transaction entry, and reversible **archive / restore** (soft-delete)
- Category management and editable merchant→category rules
- Spending insights (per-category spend, monthly trend)
- Historical CSV/XLSX import
- Parse-success drift monitoring with SSE + Web Push alerts
- Installable PWA (offline shell, pull-to-refresh)

## Quick start

The frontend builds to static assets that Go embeds, so **build the frontend
before `go build`**.

```bash
# 1. Build the frontend (outputs to internal/web/dist/, which Go embeds)
cd frontend && bun install && bun run build && cd ..

# 2. Build the static binary (pure-Go SQLite → CGO disabled)
CGO_ENABLED=0 go build -o ledger ./cmd/ledger

# 3. Run (config optional — sane defaults apply if omitted)
./ledger -config config.toml
```

With no config, defaults are: HTTP on `127.0.0.1:8080`, data dir `/var/lib/ledger`.
Open `http://127.0.0.1:8080/` (or the Tailscale HTTPS URL in production).

`internal/web/dist/` is a **committed build artifact** — rebuild it whenever the
frontend source changes so the embedded bundle stays in sync.

## CLI

`cmd/ledger/main.go` dispatches on the first argument before flag parsing:

| Command | Purpose |
|---|---|
| `ledger [-config path]` | Default: run the server + ingest worker |
| `ledger import --file X.csv --map map.toml [--dry-run]` | Historical CSV/XLSX backfill (see [`docs/map.example.toml`](docs/map.example.toml)) |
| `ledger vapid-keys` | Generate a VAPID keypair for Web Push (prints env vars) |

## Configuration

Non-secret settings come from TOML (`-config path`); **secrets are environment
only** and are never read from the file.

```toml
[server]
listen   = "127.0.0.1:8080"
data_dir = "/var/lib/ledger"

[imap]                       # ingest is enabled only when imap.host is set
host          = "imap.gmail.com"
port          = 993
username      = "you-ledger-mailbox@gmail.com"
auth          = "app_password"
folder        = "INBOX"
read_only     = true
poll_interval = "60s"

[ai]                         # AI is optional and disableable
enabled               = true
model                 = "claude-haiku-4-5-20251001"
auto_accept_threshold = 0.85
allow_ai_extraction   = false
```

Secrets (env / systemd only):

| Variable | Used for |
|---|---|
| `LEDGER_IMAP_APP_PASSWORD` | IMAP login |
| `LEDGER_AI_API_KEY` | Anthropic API (categorization + extraction fallback) |
| `LEDGER_VAPID_PRIVATE` / `LEDGER_VAPID_PUBLIC` | Web Push (optional) |

Runtime behavior (auto-categorize, AI on/off, AI auto-accept, threshold) and the
budget plan are editable live from the PWA Settings screen and stored in the DB.

## HTTP API

Standard library routing (Go 1.22 method+pattern). All endpoints are under
`/api`; unknown `/api/*` returns 404 so the SPA fallback never swallows API calls.

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` |
| Transactions | `GET/POST /api/transactions`, `POST /api/transactions/{id}/categorize`, `POST /api/transactions/{id}/status`, `POST /api/transactions/{id}/archive`, `POST /api/transactions/{id}/restore` |
| Review & categorize | `GET /api/review`, `POST /api/categorize/run`, `POST /api/categorize/stop`, `GET /api/categorize/status`, `POST /api/categorization/clear`, `POST /api/reprocess` |
| Categories & rules | `GET/POST /api/categories`, `PUT/DELETE /api/categories/{id}`, `GET /api/categories/{id}/usage`, `GET/POST /api/rules`, `PUT /api/rules/{id}/active`, `DELETE /api/rules/{id}` |
| Budget & insights | `GET /api/summary`, `GET/PUT /api/budget`, `GET /api/insights/categories`, `GET /api/insights/trend` |
| Settings | `GET/PUT /api/settings` |
| Live & push | `GET /api/events` (SSE), `POST/DELETE /api/push/subscribe`, `GET /api/push/vapid-public` |

## Development

```bash
# Frontend dev server (Vite). The API client uses relative /api URLs and there is
# no dev proxy — run against the Go binary, or add a proxy for pure-vite dev.
cd frontend && bun run dev
```

Pure, framework-free helpers live in `frontend/src/lib/` with co-located
`*.test.ts`; the convention is to extract decision/format logic out of components
into a tested `lib/` function and keep components thin.

## Tests

```bash
go test ./...                # all Go tests
go test ./... -race          # with the race detector
cd frontend && bun run test  # frontend (vitest, jsdom)
```

Go tests live beside the code (`*_test.go`); frontend tests are `*.test.ts(x)`
next to components. Frontend vitest is pinned to a single non-parallel fork (see
`frontend/vite.config.ts`) — don't switch it back to parallel.

## Architecture

The pipeline is wired in `cmd/ledger/main.go`. Packages under `internal/`:

| Package | Responsibility |
|---|---|
| `store` | Owns the SQLite DB; applies `schema.sql` idempotently (WAL, foreign keys on); additive migrations via an `addColumn` helper |
| `ingest` | IMAP worker; opens the mailbox read-only, polls, writes every message to `ingest_log` |
| `parse` | Extraction cascade: bank templates → heuristic → AI extractor; reprocessing |
| `categorize` | Rules-first categorizer with AI fallback and rule write-back |
| `anthropic` | Shared retrying HTTP client for the Anthropic Messages API (the one outbound data path) |
| `server` | `net/http` API, SSE hub, SPA fallback |
| `budget` | 50/30/20 need/want/saving math over confirmed transactions |
| `monitor` | Rolling per-sender parse-success drift detection → alerts |
| `push` | Web Push (VAPID) |
| `config` | TOML load + env overrides (secrets env-only) |
| `importer` | CSV/XLSX reader, column mapping, dedup |
| `web` | `//go:embed` of the built PWA |

Frontend (`frontend/src/`): React 18 + TypeScript + Vite, TanStack
Router/Query/Table, Tailwind v4, recharts, `vite-plugin-pwa`.

## Deployment

ledger runs as a single static binary under systemd, fronted by Tailscale HTTPS
(required — service workers need HTTPS), reachable only from your tailnet. The
full runbook — install, dedicated-mailbox setup, and backups — is in
[`deploy/README.md`](deploy/README.md).

```bash
# Backup is one file:
sqlite3 /var/lib/ledger/ledger.db ".backup '/var/backups/ledger-$(date +%F).db'"
```

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture, principles, and conventions (authoritative for contributors)
- [`budgeting-app-build-plan.md`](budgeting-app-build-plan.md) — the authoritative spec (architecture §3, principles §2, milestones)
- [`deploy/README.md`](deploy/README.md) — deployment runbook
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — per-feature implementation plans
