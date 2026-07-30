# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**ledger** is a private, self-hosted, real-time budgeting PWA for a single user. The event source is the per-transaction emails banks already send: a single Go binary watches a dedicated IMAP mailbox, parses each transaction email through a resilient extraction cascade, categorizes it (rules-first, AI only as fallback), stores it in SQLite, and serves a mobile React PWA showing live budget state against a 50/30/20 plan.

`budgeting-app-build-plan.md` is the authoritative spec (architecture in §3, principles in §2, milestones at the end). Per-milestone implementation plans live in `docs/superpowers/plans/`. Read the relevant plan before extending a feature area.

## Core principles (do not violate)

- **Deterministic-first extraction.** The parse cascade runs per-bank template → generic heuristic → AI (only on failure). AI-extracted transactions are *always* low-confidence and routed to the review queue, never auto-trusted. AI is the *primary* tool only for categorizing unknown merchants.
- **Nothing is ever silently dropped, everything recoverable.** Every email's full raw body is retained in `ingest_log`. Anything no tier resolves is tagged `unparsed` and visible in the review queue. A parser break is never permanent loss: fix the parser, reprocess (`/api/reprocess` or `ledger import`), and missing transactions backfill.
- **Self-improving rules.** Every manual or AI-confirmed categorization writes back a merchant→category rule, so known merchants never hit the LLM again.
- **Money is integer minor units.** Always `int64` fils (AED × 100). Never use floats for money. Amounts in `transactions.amount` are always positive; `direction` is `'debit'|'credit'`.
- **Single binary, single process.** No microservices, no broker, no external DB server. The one Go binary holds the ingest worker, HTTP API, SSE stream, and embedded PWA. The PWA bundle is embedded via `embed.FS` — the server **never runs Node** at runtime.
- **Private and least-privilege.** Runs only on the `dinosaur` box, reachable only over Tailscale, never public. The mailbox is opened read-only (`EXAMINE`). The only data that leaves the box is a bare merchant string to the AI, and that path is disableable. Secrets come from env / systemd, never config files.

## Build & run

The frontend builds to static assets that Go embeds, so the frontend must be built **before** `go build`.

```bash
# 1. Build the frontend (outputs to internal/web/dist/, which Go embeds)
cd frontend && bun install && bun run build

# 2. Build the static binary (pure-Go SQLite → no cgo)
CGO_ENABLED=0 go build -o ledger ./cmd/ledger

# Run (config optional; sane defaults apply if omitted)
./ledger -config config.toml
```

`internal/web/dist/` is a committed build artifact. Because parallel sessions run on `main`, **rebuild the combined dist before finishing or deploying a branch** so the embedded bundle matches the frontend source.

### Frontend dev

```bash
cd frontend
bun run dev        # Vite dev server
bun run test       # vitest (run mode)
bun run storybook        # design-system docs + component workbench (port 6006)
bun run build-storybook  # static build (storybook-static/, gitignored)
```

Every `X.stories.tsx` has a colocated `X.stories.test.tsx` rendering the same stories
via portable stories; `src/test/storybook.test.tsx` renders every story in the repo as
a regression net. When you add or change a shared component, update its stories in the
same commit.

The API client uses relative URLs (`/api/...`); there is no dev proxy configured — run against the Go binary or add one if doing pure-vite dev.

## Tests

```bash
go test ./...                              # all Go tests
go test ./internal/parse/                  # one package
go test ./internal/parse/ -run TestCascade # one test
go test ./... -race                        # race detector

cd frontend && bun run test                # frontend (vitest)
cd frontend && bunx vitest run path/to/File.test.tsx   # one file
```

Go tests live beside the code (`*_test.go`). Frontend tests are `*.test.ts(x)` next to components, run with jsdom.

> Frontend vitest is pinned to a **single, non-parallel fork** (`fileParallelism: false`, `singleFork`) in `vite.config.ts` — the sandbox blocks vitest's default worker spawning, which otherwise silently runs only the first file. Don't "fix" this back to parallel.

### UI testing: use the harness, not just vitest

vitest and Storybook test components in isolation. They cannot see a control
under the bottom nav, a field that refuses to stay empty, or a sheet hidden
behind the keyboard. **Any change to a screen, sheet or shared UI primitive
should be checked with `frontend/harness/`**, which drives the real PWA in a
real browser against the real Go API on a scratch DB. Full docs:
`frontend/harness/README.md`.

```bash
cd frontend
harness/stack.sh up          # scratch DB + seed + Go API (:8099) + vite (:5199)
node harness/shoot.mjs       # screenshot + geometry-audit every screen
node harness/probe.mjs       # open every sheet, type into every input
node harness/ios.mjs         # WebKit + iPhone keyboard geometry
harness/stack.sh reset       # restore fixture data between rounds
```

Never points at production: scratch ports and a scratch DB, never `:8080` or
`/var/lib/ledger`.

**The method that actually found bugs**, in order of yield:

1. **Fixture data that is hostile on purpose** — `seed.mjs` contains a merchant
   name wider than the viewport, a 250,000 amount, an unset FX rate, a negative
   envelope. Bugs hide in the happy path.
2. **Measure laid-out geometry, don't eyeball it** — `audit.mjs` runs in-page
   and reports elements past the viewport, controls whose centre point hits a
   *different* element, sub-44px targets, sub-16px inputs, unreachable
   `overflow-hidden` content.
3. **Type into things** — `probe.mjs` clears every input and checks it stays
   clear. That is how the `Number("") === 0` springback was found.
4. **Read the screenshots with a critic that has no stake in the code** — the
   geometry audit cannot judge hierarchy, rhythm or copy.

**Traps that produced false confidence — check these before trusting a green run:**

- **`reducedMotion: "reduce"`** (set by `shoot.mjs` for stable captures) makes
  `Dialog`/`SettingsPage` skip their slide entirely. A green run says nothing
  about the animation.
- **Chromium is not Safari.** `env(safe-area-inset-*)` is 0, there is no
  software keyboard, and `dvh` never shrinks. iOS-only bugs are invisible —
  use `ios.mjs`.
- **Check which tree vite serves** (`ls -l /proc/<vite-pid>/cwd`). `stack.sh`
  resolves the repo from its own path, so running it from the main checkout
  while editing a worktree "verifies" a fix against code that lacks it.
- **Cold-start jank looks like a bug.** Discard the first run before drawing
  conclusions about timing, and A/B under equally warm conditions.
- **A checker that cries wolf gets ignored.** When you add a deliberate
  exception to a convention, teach `audit.mjs` about it in the same commit
  (see `data-dense-target`).

## CLI subcommands

`cmd/ledger/main.go` dispatches on `os.Args[1]` before flag parsing:

- `ledger import --file X.csv --map map.toml [--dry-run]` — historical CSV/XLSX backfill. Honors the global `auto_categorize` setting; rows land in `needs_review` when it's off. See `docs/map.example.toml`.
- `ledger vapid-keys` — generate a VAPID keypair for Web Push (prints env vars).
- `ledger [-config path]` — default: run the server + ingest worker.

## Architecture

Pipeline: **Ingest → Parse cascade → Categorize → SQLite → (HTTP API + SSE + Push)**. Wiring lives in `cmd/ledger/main.go`.

### Packages (`internal/`)

- **`store`** — owns the SQLite DB. `store.Open` applies `schema.sql` idempotently (embedded), sets `journal_mode=WAL` and `foreign_keys=ON`. Schema is `CREATE TABLE IF NOT EXISTS` + an `addColumn` helper for additive migrations; there is no migration tool. All DB access goes through typed `...Row` structs and methods here.
- **`ingest`** — IMAP worker. Opens the mailbox **read-only** (`EXAMINE`), polls on an interval, writes every message to `ingest_log`, then calls a post-process hook to run the parse cascade over unparsed rows. With `use_idle = true` it also parks in IMAP IDLE between polls so new mail triggers an immediate sync; the poll interval remains the fallback heartbeat.
- **`parse`** — the extraction cascade (`cascade.go`). Tiers: `DIBParser`/`ENBDParser` templates → `HeuristicParser` → AI extractor (`DisabledExtractor` when off). `Processor.ProcessPending` selects ingest rows and writes transactions; `reprocess.go` re-runs over already-seen mail (e.g. after fixing a parser). `body.go`/`fields.go` handle MIME/field extraction.
- **`categorize`** — rules-first categorizer. `Categorize` matches rules (`contains`/`exact`/`regex`, by priority) and falls back to the AI categorizer above a confidence threshold; proposes a write-back rule on confident results. `DisabledAI` is the no-op. Behavior is gated at runtime by app settings (`AutoCategorize`, `AIEnabled`, `AIAutoAccept`, `AIThreshold`) — see the categorizer-provider closures in `main.go`.
- **`anthropic`** — shared retrying HTTP client for the Anthropic Messages API, used by both `parse/ai.go` (extraction fallback) and `categorize/ai.go` (merchant categorization). `Retrier` honors `Retry-After` on 429/5xx/529 and otherwise backs off exponentially with jitter, so bulk categorization throttles instead of hammering the API. This is the one network path that data leaves the box on.
- **`server`** — stdlib `net/http` with Go 1.22 method+pattern routing (`s.mux.HandleFunc("GET /api/...")`). One file per resource (transactions, review, rules, categories, settings, budget, insights, push, events). `/api/events` is the SSE stream via `Hub`; unknown `/api/*` returns 404 so the SPA fallback (`spa.go`) never swallows API calls.
- **`budget`** — 50/30/20 need/want/saving math over confirmed transactions.
- **`monitor`** — rolling per-sender parse-success drift detection; emits `drift_alert` SSE/push events when a sender drops below `drift_min`.
- **`push`** — Web Push (VAPID). Active only when `LEDGER_VAPID_PRIVATE`/`LEDGER_VAPID_PUBLIC` are set.
- **`config`** — TOML load (`BurntSushi/toml`) + env overrides. **Secrets are env-only** (`LEDGER_IMAP_APP_PASSWORD`, `LEDGER_AI_API_KEY`, VAPID keys), never in the TOML.
- **`importer`** — CSV/XLSX reader, column `map.toml` parsing, normalization, dedup; shared by the `import` subcommand.
- **`web`** — `//go:embed all:dist` of the built PWA.

### Frontend (`frontend/src/`)

React 19 + TypeScript + Vite. TanStack Router/Query/Table, Tailwind v4, dither-kit (vendored), `vite-plugin-pwa`. `api/` (client + types), `screens/`, `components/` (incl. `swipe/` categorizer deck and `transactions/`), `hooks/`, `app/AppShell.tsx`. State/server-cache via react-query (`queryClient.ts`).

`lib/` holds **pure, framework-free helpers** (money/`fils` formatting, scope math, swipe and pull-to-refresh gesture geometry, transaction filtering) each with a co-located `*.test.ts`. The convention: extract decision logic out of components into a pure `lib/` function and unit-test it there, keeping components thin and gesture/format edge cases covered without rendering. Follow this when adding non-trivial UI logic.

`components/dither-kit/` is **vendored source** from the dither-kit shadcn
registry (charts, v0.1.0) — not an npm package. Only `core` + `bar-chart` are
installed. `palette.ts` is deliberately forked to carry the app's design tokens
in light and dark tables; see `components/dither-kit/README.md` before running
`shadcn add --diff` against it. dither-kit's bars are vertical-only, so
horizontal magnitude bars use `components/charts/DitherFill.tsx`, which renders
DOM masked with the `.dither-mask` CSS class (`styles/app.css`) — the same dot
texture `components/ui/ProgressBar.tsx` uses — rather than canvas.

`frontend/src/components/README.md` is the **UI component catalog**: every shared component's purpose plus when to use / not use it, and the mobile conventions (44px targets, 16px inputs, `.press` feedback, Dialog-only overlays). Check it before building UI; update it in the same commit whenever you add or change a shared component.

## Deploy

`dinosaur` is both this dev box and the production server, so deploy steps run **locally**. Single static binary + systemd (`deploy/ledger.service`, hardened sandbox) + Tailscale HTTPS (required — service workers need HTTPS). Full runbook, dedicated-mailbox setup, and backup commands are in `deploy/README.md`. The service binds `127.0.0.1:8080`; `tailscale serve` fronts HTTPS. DB and config: `/var/lib/ledger/ledger.db` (0700), `/etc/ledger/config.toml`, secrets in `/etc/ledger/ledger.env`.
