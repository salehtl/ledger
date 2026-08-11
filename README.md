# ledger

A private, self-hosted, real-time budgeting PWA for one user, reachable only
over Tailscale. One Go binary watches a dedicated IMAP mailbox, parses each
transaction email, categorizes it (rules first, AI only as a fallback), stores
it in SQLite, and serves a mobile React PWA showing live budget state against a
50/30/20 plan.

> **ledger 2.0 lives at `github.com/salehtl/ledgerd` since 2026-08-11.** The
> multi-user app used to share this repository until that date. The tag
> **`ledger-v2-final`** is the split point in both histories: here it marks
> `6c3ee1b`, the commit the split was taken from — three doc-only commits
> followed it before the prune, so the tree still carried v2 up to `a9b85a6`. In
> salehtl/ledgerd the same tag marks the filtered rewrite of that same split
> commit, under a different hash, because filtering rewrites every commit it
> keeps. This repository is ledger 1.0 only now — nothing here builds, tests or
> deploys v2.

> **Scope:** one user on one box (`dinosaur`). Not multi-tenant, not public.
> Amounts are AED; money is stored as integer **fils** (AED × 100), never a
> float.

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

- 50/30/20 budget (need / want / saving) with envelopes and per-category targets
- Accounts and balances, with check-ins and manual adjustments
- Transaction list with search, filters, splits, notes, refund links and CSV export
- Swipe-deck review queue for fast categorization
- Manual transaction entry, and reversible **archive / restore** (soft-delete)
- Category management and editable merchant→category rules
- Projects, and recurring-charge detection with an upcoming list
- Reports: net worth, income vs expense, age of money
- Spending insights (per-category spend, monthly trend) and multi-currency rates
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
| `ledger compact [-config path]` | Compress stored raw email bodies, then `VACUUM` the database |
| `ledger vapid-keys` | Generate a VAPID keypair for Web Push (prints env vars) |

## Configuration

Non-secret settings come from TOML (`-config path`); **secrets are environment
only** and are never read from the file. See
[`config.example.toml`](config.example.toml) for every key.

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
use_idle      = false
poll_interval = "60s"

[ai]                         # AI is optional and disableable
enabled             = true
model               = "claude-haiku-4-5-20251001"
allow_ai_extraction = false

[monitoring]
drift_window = "7d"
drift_min    = 0.80
```

Secrets (env / systemd only):

| Variable | Used for |
|---|---|
| `LEDGER_IMAP_APP_PASSWORD` | IMAP login |
| `LEDGER_AI_API_KEY` | Anthropic API (categorization + extraction fallback) |
| `LEDGER_VAPID_PRIVATE` / `LEDGER_VAPID_PUBLIC` | Web Push (optional) |

Runtime behaviour — auto-categorize, AI on or off, AI auto-accept and its
confidence threshold, the AI spend cap — and the budget plan are edited live
from the PWA Settings screen and stored in the database, not in the TOML.

## HTTP API

Standard library routing (Go 1.22 method+pattern). All endpoints are under
`/api`, and unknown `/api/*` returns 404 so the SPA fallback never swallows API
calls. There are ~85 of them, one file per resource — read
[`internal/server/`](internal/server/) rather than a table here, which went
stale the first week it existed.

## Architecture

The pipeline is wired in `cmd/ledger/main.go`. Packages under `internal/`:

| Package | Responsibility |
|---|---|
| `store` | Owns the SQLite DB; applies `schema.sql` idempotently (WAL, foreign keys on); additive migrations via an `addColumn` helper |
| `ingest` | IMAP worker; opens the mailbox read-only, polls, writes every message to `ingest_log` |
| `parse` | Extraction cascade: bank templates → heuristic → AI extractor; reprocessing |
| `categorize` | Rules-first categorizer with AI fallback and rule write-back |
| `recur` | Deterministic recurring-charge detection over transaction history |
| `anthropic` | Shared retrying HTTP client for the Anthropic Messages API (the one outbound data path) |
| `server` | `net/http` API, SSE hub, SPA fallback |
| `budget` | 50/30/20 need/want/saving math over confirmed transactions |
| `monitor` | Rolling per-sender parse-success drift detection → alerts |
| `push` | Web Push (VAPID) |
| `config` | TOML load + env overrides (secrets env-only) |
| `importer` | CSV/XLSX reader, column mapping, dedup |
| `web` | `//go:embed` of the built PWA |

Frontend (`frontend/src/`): React 19 + TypeScript + Vite, TanStack Query/Table,
Tailwind v4, Motion (`motion/react`), vendored dither-kit charts,
`vite-plugin-pwa`. Pure, framework-free helpers live in `frontend/src/lib/` with
co-located `*.test.ts`; the convention is to move decision, format and gesture
logic out of components into a tested `lib/` function.
`frontend/src/components/README.md` is the shared-component catalog — read it
before building UI.

```bash
# Frontend dev server (Vite). The API client uses relative /api URLs and there is
# no dev proxy — run against the Go binary, or add a proxy for pure-vite dev.
cd frontend && bun run dev
```

## Tests

```bash
go test ./...                # every Go package
go test ./... -race          # with the race detector
cd frontend && bun run test  # the PWA (vitest, jsdom)
```

There is no CI service. The gate is `go test ./...` plus the frontend suite.

Go tests live beside the code (`*_test.go`); frontend tests are `*.test.ts(x)`
next to components. Frontend vitest is pinned to a single non-parallel fork —
don't switch it back to parallel.

## Deployment

`dinosaur` is both the dev box and the production server, so deploy steps run
locally. `ledger.service` binds `127.0.0.1:8080` behind `tailscale serve`, with
SQLite at `/var/lib/ledger/ledger.db`. Runbook:
[`deploy/README.md`](deploy/README.md).

`ledgerd.service` also runs on the same box. It is ledger 2.0 and is built and
deployed from `github.com/salehtl/ledgerd`, not from here. A deploy from this
repository must never take it down.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — architecture, principles and conventions (authoritative for contributors)
- [`AGENTS.md`](AGENTS.md) — the short form of the same
- [`deploy/README.md`](deploy/README.md) — the deployment runbook
- [`docs/superpowers/`](docs/superpowers/) — specs and per-feature implementation plans
- [`budgeting-app-build-plan.md`](budgeting-app-build-plan.md) — the authoritative spec (architecture §3, principles §2, milestones)
