# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first: there are TWO apps in this tree

Since 2026-08-09, `main` is **ledger 2.0**, the multi-user app. The v1 single-user
app did not go away. Both live in this one tree and both run on the box right now.

| | **ledger 2.0 (v2)** | **ledger 1.0 (v1)** |
|---|---|---|
| Binary | `cmd/ledgerd` | `cmd/ledger` |
| Backend | `internal/v2/**` | `internal/**` (not `v2`) |
| Frontend | `web/` | `frontend/` |
| Embedded bundle | `internal/v2/webui/dist` | `internal/web/dist` |
| Database | PostgreSQL (`ledger_v2`) | SQLite (`/var/lib/ledger/ledger.db`) |
| Event source | SMTP on `:25`, users forward mail | IMAP, one mailbox, read-only |
| Reach | **public**: `app.sirdab.ae`, `api.sirdab.ae` | tailnet only |
| Service | `ledgerd.service` | `ledger.service` |
| Gate | `scripts/v2-check.sh` | `go test ./...` + `cd frontend && bun run test` |

**Work out which app a task belongs to before you touch anything.** The two share
a module, a `go.mod` and a git history, and almost nothing else. A v2 change never
belongs in `internal/parse`, and a v1 change never belongs in `internal/v2`.

Branches: `main` (both apps, v2 is the product) · `ledger-v1` (the v1 line as it
stood at the handover) · `v2-wip-2026-08-05` (the v2 integration branch, currently
the same commit as `main`).

`client/` is neither app: it is the shared TypeScript library that must agree
byte-for-byte with the Go side (see "Dual executors" below). The abandoned Expo
native client that used to sit in `app/` was **deleted on 2026-08-10** and is
kept at the tag `app-expo-final` (pushed to `origin`) — check it out there if you
ever need it; do not restore it into the tree.

---

## ledger 2.0 — what it is

A self-hosted, multi-user budgeting PWA for a small closed beta. Users sign up with
a **passkey**, receive their own inbound mail address, and forward their banks'
per-transaction emails to it. `ledgerd` receives that mail over SMTP, verifies its
origin, parses it, and appends the result to an **append-only op log** that syncs to
every device the user owns. The React PWA is embedded in the binary.

Authoritative reading, in this order: `docs/superpowers/specs/2026-08-07-v2-pwa-direction.md`
(the PWA direction), then the phase plans in `docs/superpowers/plans/`
(`2026-08-01-v2-phase1-backend`, `2026-08-02-v2-phase2-client`, `2026-08-08-phase3-crypto`).
`deploy/README-v2.md` is the operator runbook and is written to be read at 2am.
Read the relevant plan before you extend a feature area.

### Core principles (do not violate)

- **The client is the only reader of a user's data.** Phase 3 seals the op log:
  the server receives a **sealed blob** and holds no key. It checks framing, the
  claimed position and the hash chain, and nothing else. Never write a feature
  that needs the server to read a transaction, an amount or a merchant. Anything
  that assumes otherwise breaks the moment sealing lands.
- **The op log is append-only, and nothing validates its payload server-side.**
  One client bug is therefore permanent: a malformed op becomes an anomaly on
  every device, forever. Treat op authoring as the highest-risk code in the repo.
- **Two roles on the database.** `ledger_migrate` owns the schema; `ledger_runtime`
  serves and is never the owner. This is a security boundary, not tidiness —
  `key_history` is append-only by trigger, and disabling a trigger needs only
  ownership. **Migrations apply out of band as `ledger_migrate`, before the new
  binary starts.** The running service cannot migrate itself.
- **Push payloads are content-free.** "New activity" and nothing more. A body
  composed on the server from user data rebuilds the plaintext path that the
  encryption removes.
- **The admin console is tailnet-only, permanently.** It shows operational data
  only — never transactions, amounts or balances, because after sealing the
  server cannot read them anyway. `config.CheckAdminBind` and
  `TestTheAdminConsoleIsNotMountedOnThePublicListener` exist to stop a regression
  here; both must keep passing, unmodified.
- **Mail is never silently dropped.** Anything unverified or unparsed is held in
  `quarantine` and is visible to the user, with the hold announced before expiry.
- **Money is integer minor units.** `int64` minor units, never a float. Amounts
  are positive; direction is separate.
- **Secrets are environment-only** — never in the TOML. `Load` rejects the file
  if they appear there.

### Dual executors: Go and TypeScript must agree byte-for-byte

The normalizer and the template executor exist **twice** — in `internal/v2/norm`
and `internal/v2/tmpl` on the Go side, and in `client/src/` on the TypeScript
side. They must produce identical output. `scripts/v2-check.sh` runs the
cross-executor conformance suites (`conformance/`), and that is the only thing
that checks it. `go test` alone passes mutations the conformance runner catches.
If you change one executor, change both, and run the gate.

### Packages (`internal/v2/`)

All 28 of them: `api` (HTTP + sync), `auth` (passkeys, sessions), `pg` (Postgres
pool + goose migrations), `pgtx` (the two pgx transaction helpers every store
used to copy; a leaf package that never imports `pg`), `oplog` (the log format),
`blob` (the on-the-wire envelope, size buckets and chain hash — the Phase 3 swap
point), `smtpd` + `ingest` + `origin` + `arc` (mail receipt and origin
verification), `addresses` (the per-user inbound mail slot and its rotation),
`quarantine`, `norm` + `tmpl` + `heuristic` (parsing), `dict` (merchant
dictionary), `samples` (the donated-sample queue every publish is regression
tested against), `diag` (the deliberately unencrypted, non-content parse
diagnostics), `admin` (the operator console), `pushv2` (Web Push), `purge`
(account deletion), `relay` (backup MX), `corpus` (read-only streaming over a
`.backup` snapshot of the v1 SQLite database), `config`, `verify` (a self-audit
the binary runs on itself), `webui` (the embedded bundle), and two test-only
packages, `pgtest` (throwaway clusters) and `authtest` (a scriptable software
WebAuthn authenticator).

### Build & run (v2)

The web app builds into the directory Go embeds, so build it **before** `go build`.

```bash
cd web && bun install && bun run build     # writes ../internal/v2/webui/dist/
CGO_ENABLED=0 go build -o ledgerd ./cmd/ledgerd
```

`cmd/ledgerd/main.go` dispatches on `os.Args[1]` **before** flag parsing — the mode
always comes first. Eleven modes: `serve`, `relay`, `verify`, `seed-dictionary`,
`seed-templates`, `purge-user`, `record-consent`, `parse-rate`, `mint-invite`,
`load-corpus` (loads a pre-sealed benchmark corpus; refuses a database with more
than one user), `vapid-keys` (mints a Web Push key pair; the one mode dispatched
before `config.Load`). The dispatch table is `modeHandlers`, and
`checkModeHandlers()` panics on every invocation if it disagrees with
`config.Modes()`, so the two cannot drift.

### The gate (v2)

```bash
bash scripts/v2-check.sh     # this repo has no CI; this script IS the build
```

It boots one throwaway Postgres cluster for the whole run, then runs the Go tests,
the `client/` tests, the web tests and the cross-executor conformance suites.

> **A green gate does NOT mean the deployed UI is current.** `v2-check.sh` builds
> the web bundle into a **temp directory** by design, so it never refreshes
> `internal/v2/webui/dist` and the tree stays clean either way. On 2026-08-09 a
> fully green gate shipped a binary still serving the previous Settings screen.
> Before any deploy: `cd web && bun run build`, confirm `git status` shows the
> change, commit it, then build the binary — and prove it landed in the binary
> itself, not in the tree:
> `strings -a ./ledgerd | grep -c '<a-marker-from-the-new-code>'`.

---

## ledger 1.0 — still running, still supported

Saleh uses v1 every day as a PWA on his phone, over the tailnet. **It must keep
working.** Do not delete it, and do not break its build.

A private, self-hosted, real-time budgeting PWA for a single user. One Go binary
watches a dedicated IMAP mailbox, parses each transaction email through a
resilient extraction cascade, categorizes it (rules first, AI only as fallback),
stores it in SQLite, and serves a mobile React PWA showing live budget state
against a 50/30/20 plan.

`budgeting-app-build-plan.md` is the authoritative v1 spec (architecture in §3,
principles in §2, milestones at the end).

### Core principles (do not violate)

- **Deterministic-first extraction.** The parse cascade runs per-bank template → generic heuristic → AI (only on failure). AI-extracted transactions are *always* low-confidence and routed to the review queue, never auto-trusted. AI is the *primary* tool only for categorizing unknown merchants.
- **Nothing is ever silently dropped, everything recoverable.** Every email's full raw body is retained in `ingest_log`. Anything no tier resolves is tagged `unparsed` and visible in the review queue. A parser break is never permanent loss: fix the parser, reprocess (`/api/reprocess` or `ledger import`), and missing transactions backfill.
- **Self-improving rules.** Every manual or AI-confirmed categorization writes back a merchant→category rule, so known merchants never hit the LLM again.
- **Money is integer minor units.** Always `int64` fils (AED × 100). Never use floats for money. Amounts in `transactions.amount` are always positive; `direction` is `'debit'|'credit'`.
- **Single binary, single process.** No microservices, no broker, no external DB server. The one Go binary holds the ingest worker, HTTP API, SSE stream, and embedded PWA. The PWA bundle is embedded via `embed.FS` — the server **never runs Node** at runtime.
- **Private and least-privilege.** Reachable only over Tailscale, never public. The mailbox is opened read-only (`EXAMINE`). The only data that leaves the box is a bare merchant string to the AI, and that path is disableable. Secrets come from env / systemd, never config files.

### Build & run (v1)

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

### CLI subcommands (v1)

`cmd/ledger/main.go` dispatches on `os.Args[1]` before flag parsing:

- `ledger import --file X.csv --map map.toml [--dry-run]` — historical CSV/XLSX backfill. Honors the global `auto_categorize` setting; rows land in `needs_review` when it's off. See `docs/map.example.toml`.
- `ledger compact [-config path]` — gzip the raw email bodies in `ingest_log` (`store.CompressRawBodies`), then `VACUUM`. Restartable: a failure reports how many rows converted, and re-running continues.
- `ledger vapid-keys` — generate a VAPID keypair for Web Push (prints env vars).
- `ledger [-config path]` — default: run the server + ingest worker.

### Architecture (v1)

Pipeline: **Ingest → Parse cascade → Categorize → SQLite → (HTTP API + SSE + Push)**. Wiring lives in `cmd/ledger/main.go`.

- **`store`** — owns the SQLite DB. `store.Open` applies `schema.sql` idempotently (embedded), sets `journal_mode=WAL` and `foreign_keys=ON`. Schema is `CREATE TABLE IF NOT EXISTS` + an `addColumn` helper for additive migrations; there is no migration tool. All DB access goes through typed `...Row` structs and methods here.
- **`ingest`** — IMAP worker. Opens the mailbox **read-only** (`EXAMINE`), polls on an interval, writes every message to `ingest_log`, then calls a post-process hook to run the parse cascade over unparsed rows. With `use_idle = true` it also parks in IMAP IDLE between polls so new mail triggers an immediate sync; the poll interval remains the fallback heartbeat.
- **`parse`** — the extraction cascade (`cascade.go`). Tiers: `DIBParser`/`ENBDParser` templates → `HeuristicParser` → AI extractor (`DisabledExtractor` when off). A parser may return `ErrIgnoreEmail`, and the cascade then returns `ignored` **immediately** rather than falling through to the heuristic — that fall-through once laundered a clean template rejection into wrong data. `Processor.ProcessPending` selects ingest rows and writes transactions; `reprocess.go` re-runs over already-seen mail.
- **`categorize`** — rules-first categorizer. `Categorize` matches rules (`contains`/`exact`/`regex`, by priority) and falls back to the AI categorizer above a confidence threshold; proposes a write-back rule on confident results. `DisabledAI` is the no-op. Behavior is gated at runtime by app settings — see the categorizer-provider closures in `main.go`.
- **`recur`** — deterministic recurring-charge detection over transaction history. Fixed thresholds (≥3 sightings, ≥4 below a 25-day cadence, nothing tighter than ~weekly, a staleness cut-off), so a re-run over the same history proposes the same schedules. Feeds `/api/scheduled` and `/api/upcoming`; no AI is involved.
- **`anthropic`** — shared retrying HTTP client for the Anthropic Messages API, used by both `parse/ai.go` and `categorize/ai.go`. `Retrier` honors `Retry-After` on 429/5xx/529 and otherwise backs off exponentially with jitter. This is the one network path that data leaves the box on.
- **`server`** — stdlib `net/http` with Go 1.22 method+pattern routing. One file per resource. `/api/events` is the SSE stream via `Hub`; unknown `/api/*` returns 404 so the SPA fallback (`spa.go`) never swallows API calls.
- **`budget`** — 50/30/20 need/want/saving math over confirmed transactions.
- **`monitor`** — rolling per-sender parse-success drift detection; emits `drift_alert` events when a sender drops below `drift_min`. An `ignored` email counts as a parse **success**, not a failure.
- **`push`** — Web Push (VAPID). Active only when `LEDGER_VAPID_PRIVATE`/`LEDGER_VAPID_PUBLIC` are set.
- **`config`** — TOML load + env overrides. **Secrets are env-only**, never in the TOML.
- **`importer`** — CSV/XLSX reader, column `map.toml` parsing, normalization, dedup.
- **`web`** — `//go:embed all:dist` of the built PWA.

### Frontend (`frontend/src/`) — v1

React 19 + TypeScript + Vite. TanStack Query/Table (there is no router — routing is the `app/nav.ts` tab state), Tailwind v4, dither-kit (vendored), `vite-plugin-pwa`. `api/` (client + types), `screens/`, `components/` (incl. `swipe/` categorizer deck and `transactions/`), `hooks/`, `app/AppShell.tsx`. State/server-cache via react-query (`queryClient.ts`).

`lib/` holds **pure, framework-free helpers** (money/`fils` formatting, scope math, swipe and pull-to-refresh gesture geometry, transaction filtering) each with a co-located `*.test.ts`. The convention: extract decision logic out of components into a pure `lib/` function and unit-test it there, keeping components thin and gesture/format edge cases covered without rendering. Follow this when adding non-trivial UI logic.

**Motion is Framer Motion** — npm package `motion` (not `framer-motion`), imported from `motion/react`, behind a single `LazyMotion` + `MotionConfig` root in `app/MotionProvider.tsx`. Use `m.*`, never bare `motion.*`: `strict` mode makes the latter throw rather than silently pull the whole feature bundle into the entry chunk. `lib/motion.ts` is the **single source of truth for every duration, curve and spring** — no literal seconds in a component, and a 300ms ceiling that `motion.test.ts` enforces. Reduced motion is applied globally by `MotionConfig reducedMotion="user"` and must not be re-implemented per component (the sole exception is `clipPath`, which Framer's policy doesn't cover — `ProgressBar`/`BudgetPage` gate it with `useReducedMotion()`). Gesture *decisions* stay as pure predicates in `lib/` (`sheetDrag`, `edgeBack`, `rowSwipe`, `swipe`, `toastSwipe`), each taking `(offset, velocity)` from Framer's `onDragEnd` info with co-located tests — Framer's drag cannot be driven meaningfully in jsdom, so the gestures themselves are verified in `harness/gestures.mjs`. Three animations stay in CSS on purpose: the pixel spinner's negative `animation-delay` phase shift, the skeleton pulse, and — the one that matters, because it is a transition on a `transform` — `Switch`'s knob, which is marked `data-css-transition`. `frontend/src/components/README.md` records all three; `harness/audit.mjs` check 9 enforces the rule and honours the marker. **Never put `opacity: 0` in an `initial` prop for content visible on first paint** — `LazyMotion` resolves its features in an effect, so until that chunk lands `m.*` renders straight from `initial` and the content is simply invisible; entrances for first-paint content are transform-only (check 10 catches regressions). Any test rendering an `m.*` must wrap it in `MotionProvider` — unwrapped, it does not throw, it renders *stuck at its initial state*.

`components/dither-kit/` is **vendored source** from the dither-kit shadcn registry (charts, v0.1.0) — not an npm package. Only `core` + `bar-chart` are installed. `palette.ts` is deliberately forked to carry the app's design tokens in light and dark tables; see `components/dither-kit/README.md` before running `shadcn add --diff` against it. dither-kit's bars are vertical-only, so horizontal magnitude bars use `components/charts/DitherFill.tsx`, which renders DOM masked with the `.dither-mask` CSS class (`styles/app.css`) rather than canvas.

`frontend/src/components/README.md` is the **UI component catalog**: every shared component's purpose plus when to use / not use it, and the mobile conventions (44px targets, 16px inputs, `Pressable` for press feedback, Dialog-only overlays) plus the **Motion** section above in full. Check it before building UI; update it in the same commit whenever you add or change a shared component.

---

## Tests

```bash
go test ./...                              # every Go package, BOTH apps
go test ./internal/v2/api/                 # one v2 package
go test ./internal/parse/ -run TestCascade # one v1 test
go test ./... -race                        # race detector

cd web && bun run test                     # v2 frontend (vitest)
cd frontend && bun run test                # v1 frontend (vitest)
cd client && bun test                      # the shared TS library
bash scripts/v2-check.sh                   # the v2 gate, everything at once
```

Go tests live beside the code (`*_test.go`). Frontend tests are `*.test.ts(x)` next to components, run with jsdom.

> Frontend vitest is pinned to a **single, non-parallel fork** (`fileParallelism: false`, `singleFork`) in `vite.config.ts` — the sandbox blocks vitest's default worker spawning, which otherwise silently runs only the first file. Don't "fix" this back to parallel.

Every `X.stories.tsx` has a colocated `X.stories.test.tsx` rendering the same stories via portable stories; `src/test/storybook.test.tsx` renders every story in the repo as a regression net. When you add or change a shared component, update its stories in the same commit.

### Two failure classes this codebase keeps producing

Both were found repeatedly across the v2 build. Check for them in your own work.

1. **A check that cannot fail.** A test that passes because it never ran; a `grep` that returns nothing because the file contains a literal **NUL byte** (three separate instances — grep prints nothing *and* git diffs the file as binary, so sweeps and code reviews both skip it silently); a test double that publishes nothing. **Prove every test bites**: mutate the implementation, watch it fail, revert.
2. **A UI sentence the code does not honour.** Copy that promises something the implementation does not do. Found in every review round on the v2 branch.

### UI testing: use the harness, not just vitest

vitest and Storybook test components in isolation. They cannot see a control
under the bottom nav, a field that refuses to stay empty, or a sheet hidden
behind the keyboard.

**v1** uses `frontend/harness/`, which drives the real PWA in a real browser
against the real Go API on a scratch DB. Full docs: `frontend/harness/README.md`.

```bash
cd frontend
harness/stack.sh up          # scratch DB + seed + Go API (:8099) + vite (:5199)
node harness/shoot.mjs       # screenshot + geometry-audit every screen
node harness/probe.mjs       # open every sheet, type into every input
node harness/ios.mjs         # WebKit + iPhone keyboard geometry
harness/stack.sh reset       # restore fixture data between rounds
```

**v2 has only partial harness coverage, and this is a real gap.** The nine v1
forks that used to sit in `web/harness/` are gone — that directory is v2-only
now. Four runners reach the real product. Three walk the real sign-in
ceremony (BootGate is the only door): `v2settings.mjs` covers Settings,
`recovery.mjs` covers fresh-device recovery, and `operator.mjs` covers the
operator's own WebKit-only path. `vault.mjs` covers the key vault round trip
in both Chromium and WebKit and is the exception — it needs no server, invite
or passkey, only a page on the origin. Screens beyond those four rest on
vitest alone. If you build a v2 runner, `v2stack.sh` must pass
`--dns-fixtures`, or every message the harness posts is `unauthenticated` and
no script can reach the product at all.

Never point a harness at production: scratch ports and a scratch DB, never
`:8080`, never `:443`, never `/var/lib/ledger`.

**The method that actually found bugs**, in order of yield. It was learned on v1
and it transfers, but **every file named below is a `frontend/harness/` (v1)
file** — `seed.mjs`, `probe.mjs`, `shoot.mjs`, `ios.mjs` and `stack.sh` do not
exist in `web/harness/`, and `audit.mjs` is the only one that exists in both. If
you arrived here from the v2 paragraph, the v2 runners are the four named there:

1. **Fixture data that is hostile on purpose** — `seed.mjs` contains a merchant name wider than the viewport, a 250,000 amount, an unset FX rate, a negative envelope. Bugs hide in the happy path.
2. **Measure laid-out geometry, don't eyeball it** — `audit.mjs` runs in-page and reports elements past the viewport, controls whose centre point hits a *different* element, sub-44px targets, sub-16px inputs, unreachable `overflow-hidden` content.
3. **Type into things** — `probe.mjs` clears every input and checks it stays clear. That is how the `Number("") === 0` springback was found.
4. **Read the screenshots with a critic that has no stake in the code** — the geometry audit cannot judge hierarchy, rhythm or copy.

**Traps that produced false confidence — check these before trusting a green run:**

- **`reducedMotion: "reduce"`** (set by `shoot.mjs` for stable captures) makes `Dialog`/`SettingsPage` skip their slide entirely. A green run says nothing about the animation.
- **Chromium is not Safari.** `env(safe-area-inset-*)` is 0, there is no software keyboard, and `dvh` never shrinks. iOS-only bugs are invisible — use `ios.mjs`.
- **Check which tree vite serves** (`ls -l /proc/<vite-pid>/cwd`). Both `stack.sh` and `v2stack.sh` resolve the repo from their own path, so running one from the main checkout while editing a worktree "verifies" a fix against code that lacks it.
- **Cold-start jank looks like a bug.** Discard the first run before drawing conclusions about timing, and A/B under equally warm conditions.
- **A checker that cries wolf gets ignored.** When you add a deliberate exception to a convention, teach `audit.mjs` about it in the same commit (see `data-dense-target`).

---

## Deploy

`dinosaur` is both this dev box and the production server, so deploy steps run
**locally**. Both services run at the same time. `deploy/README-v2.md` is the v2
runbook; `deploy/README.md` is v1's.

**v1** — `ledger.service`, binary `/usr/local/bin/ledger`, binds `127.0.0.1:8080`,
fronted by `tailscale serve /`. Tailnet only. DB `/var/lib/ledger/ledger.db` (0700),
config `/etc/ledger/config.toml`, secrets `/etc/ledger/ledger.env`.

**v2** — `ledgerd.service`, binary `/usr/local/bin/ledgerd`. **Public**: binds
`:443` for `app.sirdab.ae` / `api.sirdab.ae` and SMTP on `*:25`. Admin console on
`127.0.0.1:8079`, reached over the tailnet at
`https://dinosaur.marmoset-paradise.ts.net:8445/admin/ui/` via `tailscale serve`.
Config `/etc/ledger-v2/config.toml`, secrets `/etc/ledger-v2/ledgerd.env`,
Postgres database `ledger_v2`.

### The v2 deploy order, which is not optional

1. `cd web && bun run build`, then **commit** `internal/v2/webui/dist` if it changed.
2. Back up: `sudo -u postgres pg_dump -Fc -d ledger_v2 | sudo tee /var/backups/<name>.dump`.
   `/var/backups` is root-owned, so `sudo -u postgres` alone **cannot write there** —
   pipe through `sudo tee`. Rehearse a risky migration on a scratch restore first.
3. **Apply migrations out of band as `ledger_migrate`**, before the new binary. The
   service connects as `ledger_runtime` and cannot own the schema.
4. `CGO_ENABLED=0 go build -o ledgerd ./cmd/ledgerd`, install, restart.
5. Verify the **running** binary, not just that health is green:
   `sudo sha256sum /proc/$(systemctl show -p MainPID --value ledgerd)/exe /usr/local/bin/ledgerd`.
   Compare hashes, not inodes — the service's hardened mount namespace reports a
   different inode for the same file.
6. Check both apps afterwards. A v2 deploy must never take v1 down.
