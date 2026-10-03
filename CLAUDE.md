# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first: this is the ledger 1.0 repository

**History.** From 2026-08-09 to 2026-08-11 this tree held two apps: ledger 1.0
and ledger 2.0, the multi-user app. **ledger 2.0 was extracted on 2026-08-11
into `github.com/salehtl/ledgerd`** (checkout `/root/Coding/ledgerd`, Go module
`ledgerd`, its `internal/v2/*` flattened to `internal/*`). The tag
**`ledger-v2-final`** marks the split point here: `6c3ee1b`, the commit the
split was taken from. Three doc-only commits followed it before the prune, so
the tree still carried v2 up to `a9b85a6`. The same tag exists in
salehtl/ledgerd on the filtered rewrite of that same split commit, under a
different hash. Prefer the tag name over either hash: this history was rewritten
on 2026-08-12 to purge real transaction data, so every hash quoted before that
date is dead and the ones above are the post-rewrite replacements.

So: **v2 work does not belong here.** If a task mentions `ledgerd`, passkeys,
SMTP ingest, the op log, Postgres, `web/`, `client/` or the conformance suites,
it belongs in `/root/Coding/ledgerd`. This repository builds one binary,
`cmd/ledger`, and one frontend, `frontend/`. Both v2's `ledgerd.service` and
v1's `ledger.service` still run on this box at the same time; a change here can
only ever affect `ledger.service`.

Branches: `main` (this app) · `ledger-v1` (the v1 line as it stood at the
2026-08-09 handover, kept as a marker). The retired v2 Expo client lives at tag
`app-expo-final`, which both repositories carry.

---

## ledger 1.0 — the app, in daily use

**Saleh uses this every day as a PWA on his phone, over the tailnet. It must keep
working.** This is not a retired app kept for history: `dinosaur` is both the dev
box and the production server, so a build you break here is a build that ships
from here, and `/var/lib/ledger/ledger.db` holds real financial data.

A private, self-hosted, real-time budgeting PWA for a single user. One Go binary
watches a dedicated IMAP mailbox, parses each transaction email through a
resilient extraction cascade, categorizes it (rules first, AI only as fallback),
stores it in SQLite, and serves a mobile React PWA showing live budget state
against a 50/30/20 plan.

`budgeting-app-build-plan.md` is the authoritative spec (architecture in §3,
principles in §2, milestones at the end).

### Core principles (do not violate)

- **Deterministic-first extraction.** The cascade runs per-bank template → generic heuristic → **AI check** (classify only). The AI check never extracts fields or writes a transaction: a confident "not a transaction" sets the email aside as `ignored` (raw body kept), and anything else stays `unparsed` with its verdict stored. The sunset Anthropic extractor runs only when `ai.provider = "anthropic"`; what it extracts is *always* low-confidence and routed to the review queue, never auto-trusted. AI is the *primary* tool only for categorizing unknown merchants.
- **Nothing is ever silently dropped, everything recoverable.** Every email's full raw body is retained in `ingest_log`. Anything no tier resolves is tagged `unparsed` and visible in the review queue. A parser break is never permanent loss: fix the parser, reprocess (`/api/reprocess` or `ledger import`), and missing transactions backfill.
- **Self-improving rules.** Every manual or AI-confirmed categorization writes back a merchant→category rule, so known merchants never hit the LLM again.
- **Money is integer minor units.** Always `int64` fils (AED × 100). Never use floats for money. Amounts in `transactions.amount` are always positive; `direction` is `'debit'|'credit'`.
- **Single binary, single process.** No microservices, no broker, no external DB server. The one Go binary holds the ingest worker, HTTP API, SSE stream, and embedded PWA. The PWA bundle is embedded via `embed.FS` — the server **never runs Node** at runtime.
- **Private and least-privilege.** Reachable only over Tailscale, never public. The mailbox is opened read-only (`EXAMINE`). Data leaves the box only on the AI path, behind one master switch. With `ai.provider = "typesafe"` (the default), categorization sends a bare merchant string plus the category names, and the AI check sends an unread email's sender, subject and up to 8 KB of its text. Both go to TypeSafe. Anthropic is sunset: it is called only when `ai.provider = "anthropic"`. Secrets come from env / systemd, never config files.

### Build & run

The frontend builds to static assets that Go embeds, so the frontend must be built **before** `go build`.

```bash
# 1. Build the frontend (outputs to internal/web/dist/, which Go embeds)
cd frontend && bun install && bun run build

# 2. Build the static binary (pure-Go SQLite → no cgo)
CGO_ENABLED=0 go build -o ledger ./cmd/ledger

# Run (config optional; sane defaults apply if omitted)
./ledger -config config.toml
```

`internal/web/dist/` is a committed build artifact. Because parallel sessions run on `main`, **rebuild the dist before finishing or deploying a branch** so the embedded bundle matches the frontend source.

The flake (`flake.nix`, `nix/`) builds the same binary from the committed dist (`nix build`) and exports `nixosModules.default` (`services.ledger`), which kakapo uses. `nix build .#checks.x86_64-linux.module` runs the module's NixOS VM test; dinosaur has no KVM, so QEMU emulates the CPU and a run takes about four minutes. A change to `go.mod`/`go.sum` changes `vendorHash` in `nix/package.nix`: set it to `lib.fakeHash`, build, and copy the `got:` hash.

### CLI subcommands

`cmd/ledger/main.go` dispatches on `os.Args[1]` before flag parsing:

- `ledger import --file X.csv --map map.toml [--dry-run]` — historical CSV/XLSX backfill. Honors the global `auto_categorize` setting; rows land in `needs_review` when it's off. See `docs/map.example.toml`.
- `ledger compact [-config path]` — gzip the raw email bodies in `ingest_log` (`store.CompressRawBodies`), then `VACUUM`. Restartable: a failure reports how many rows converted, and re-running continues.
- `ledger vapid-keys` — generate a VAPID keypair for Web Push (prints env vars).
- `ledger categorize-eval --data-dir <scratch copy> [--limit N] [--model id]` — measure TypeSafe against confirmed history, by confidence band. Needs `LEDGER_TYPESAFE_API_KEY`. Refuses `/var/lib/ledger` (after resolving symlinks) and a directory with no `ledger.db`. Sends every confirmed merchant string to TypeSafe; records no usage.
- `ledger txncheck-eval --data-dir <copy> [--per-class N] [--model id]` — measure the AI check against parser-labelled email, by threshold. Needs `LEDGER_TYPESAFE_API_KEY`. Same `--data-dir` guard as `categorize-eval`. Sends each sample's sender, subject and up to 8 KB of text to TypeSafe; records no usage. Exits 1 when no email got an answer.
- `ledger [-config path]` — default: run the server + ingest worker.

### Architecture

Pipeline: **Ingest → Parse cascade → Categorize → SQLite → (HTTP API + SSE + Push)**. Wiring lives in `cmd/ledger/main.go`.

- **`store`** — owns the SQLite DB. `store.Open` applies `schema.sql` idempotently (embedded), sets `journal_mode=WAL` and `foreign_keys=ON`. Schema is `CREATE TABLE IF NOT EXISTS` + an `addColumn` helper for additive migrations; there is no migration tool. All DB access goes through typed `...Row` structs and methods here.
- **`ingest`** — IMAP worker. Opens the mailbox **read-only** (`EXAMINE`), polls on an interval, writes every message to `ingest_log`, then calls a post-process hook to run the parse cascade over unparsed rows. With `use_idle = true` it also parks in IMAP IDLE between polls so new mail triggers an immediate sync; the poll interval remains the fallback heartbeat.
- **`parse`** — the extraction cascade (`cascade.go`). Tiers: `DIBParser`/`ENBDParser` templates → `HeuristicParser` → AI extractor (`DisabledExtractor` unless `ai.provider = "anthropic"`; sunset) → the AI check (tier 4, `txncheck.go`). The AI check is classify-only: a `TxnChecker` answers `transaction` or `not_transaction` with a confidence, and a `not_transaction` at or above `ai.txn_ignore_threshold` returns `ignored` with `parse_tier = 'ai_check'`; anything else stays `unparsed`. Every verdict is stored in `ingest_log.ai_verdict`/`ai_verdict_conf` and replayed on reprocess under today's threshold, with no new call. A manual reprocess (`/api/reprocess`) also selects the set-aside rows: templates and the heuristic run first, so a fixed parser backfills the transaction, and otherwise the stored verdict replays, so a raised threshold returns the row to `unparsed`. The periodic ingest hook never revisits them, and a template's own `ignored` is never revisited. A row that already owns a transaction is never set aside. A parser may return `ErrIgnoreEmail`, and the cascade then returns `ignored` **immediately** rather than falling through to the heuristic — that fall-through once laundered a clean template rejection into wrong data. `Processor.ProcessPending` selects ingest rows and writes transactions; `reprocess.go` re-runs over already-seen mail.
- **`categorize`** — rules-first categorizer. `Categorize` matches rules (`contains`/`exact`/`regex`, by priority) and falls back to the AI categorizer above a confidence threshold; proposes a write-back rule on confident results. `DisabledAI` is the no-op. `ClassifierCategorizer` (`classifier.go`) is the default AI categorizer: it asks a `classify.Classifier` one choice question, with a `__no_fit__` option. `AnthropicCategorizer` (`ai.go`) is sunset and wired only when `ai.provider = "anthropic"`. Behavior is gated at runtime by app settings — see the categorizer-provider closures in `main.go`.
- **`recur`** — deterministic recurring-charge detection over transaction history. Fixed thresholds (≥3 sightings, ≥4 below a 25-day cadence, nothing tighter than ~weekly, a staleness cut-off), so a re-run over the same history proposes the same schedules. Feeds `/api/scheduled` and `/api/upcoming`; no AI is involved.
- **`aihttp`** — shared HTTP plumbing for every AI provider: `Retrier` (retries, honors `Retry-After` on 429/5xx/529, otherwise backs off exponentially with jitter), the live gate that makes "AI off" mean zero egress, and usage and cost accounting. No provider logic; adapters set auth headers through `Retrier.SetHeaders`. Jev is priced in milli-µUSD (`usage.go`), rounded up per call; an unknown model id costs 0, so a model bump needs a table row or the spend cap goes blind.
- **`classify`** — the provider seam. `Classifier` has `Classify(ctx, Request) (Answer, error)` and `MaxOptions()`; a `Request` is one choice question plus a small text state, and an `Answer` is one of the offered options with a confidence. TypeSafe (`typesafe.go`, Jev model pinned `jev-1.13.0`) is the only adapter. A new provider needs: one adapter in `internal/classify`; one case in the provider switch in `cmd/ledger/main.go`; one case each in `Config.validate()` and `AIConfig.ProviderKey()` in `internal/config/config.go`; a key field in `AIConfig` (`toml:"-"`) plus its env var, read in `Load`; a model config key in `AIConfig`; a price row for the model in `aihttp.PriceMuUSD` or `PriceMilliMuUSD` (without it, the spend cap does not count the provider's calls); and a case in `frontend/src/lib/aiProvider.ts`, which maps every provider other than `"typesafe"` to Anthropic's name and env var. These calls, and the sunset Anthropic ones, are the only network paths data leaves the box on.
- **`server`** — stdlib `net/http` with Go 1.22 method+pattern routing. One file per resource. `/api/events` is the SSE stream via `Hub`; unknown `/api/*` returns 404 so the SPA fallback (`spa.go`) never swallows API calls.
- **`budget`** — 50/30/20 need/want/saving math over confirmed transactions.
- **`monitor`** — rolling per-sender parse-success drift detection; emits `drift_alert` events when a sender drops below `drift_min`. An `ignored` email counts as a parse **success**, not a failure.
- **`push`** — Web Push (VAPID). Active only when `LEDGER_VAPID_PRIVATE`/`LEDGER_VAPID_PUBLIC` are set. A 404/410 from a push service prunes the subscription and records the endpoint in `push_gone`. The PWA re-sends its subscription on every open (`hooks/usePushResync.ts`, `resync: true`); the server refuses a gone endpoint with 410 and the app then drops it locally, so Settings offers "Enable on this device" instead of a false "Enabled". `POST /api/push/test` returns `{"devices": n}`. (On 2026-09-23 Apple returned 410 for the iPhone, and push stayed dead for a week because nothing re-registered.)
- **`config`** — TOML load + env overrides. **Secrets are env-only**, never in the TOML.
- **`importer`** — CSV/XLSX reader, column `map.toml` parsing, normalization, dedup.
- **`web`** — `//go:embed all:dist` of the built PWA.

### The importer's frozen vectors are a CONTRACT FORK

`internal/importer` is live code (`ledger import`). Its `conformance_test.go`
used to read `conformance/import/vectors.json` — the shared contract that kept
this Go importer and a TypeScript twin byte-identical. `conformance/` left with
v2 on 2026-08-11, so the vectors now live at
`internal/importer/testdata/vectors.json` as a **frozen copy**.

Nothing anywhere checks the cross-language agreement any more. salehtl/ledgerd
tests its TypeScript importer against a byte-frozen copy of this package; this
repository tests its living importer against the frozen vectors. **The two can
drift, and no gate will say so.** A change to normalization here is a change to
v1's importer alone, and the vectors are this repository's own regression net,
not a contract with another language.

### Frontend (`frontend/src/`)

React 19 + TypeScript + Vite. TanStack Query/Table (there is no router — routing is the `app/nav.ts` tab state), Tailwind v4, dither-kit (vendored), `vite-plugin-pwa`. `api/` (client + types), `screens/`, `components/` (incl. `swipe/` categorizer deck and `transactions/`), `hooks/`, `app/AppShell.tsx`. State/server-cache via react-query (`queryClient.ts`).

`lib/` holds **pure, framework-free helpers** (money/`fils` formatting, scope math, swipe and pull-to-refresh gesture geometry, transaction filtering) each with a co-located `*.test.ts`. The convention: extract decision logic out of components into a pure `lib/` function and unit-test it there, keeping components thin and gesture/format edge cases covered without rendering. Follow this when adding non-trivial UI logic.

**Motion is Framer Motion** — npm package `motion` (not `framer-motion`), imported from `motion/react`, behind a single `LazyMotion` + `MotionConfig` root in `app/MotionProvider.tsx`. Use `m.*`, never bare `motion.*`: `strict` mode makes the latter throw rather than silently pull the whole feature bundle into the entry chunk. `lib/motion.ts` is the **single source of truth for every duration, curve and spring** — no literal seconds in a component, and a 300ms ceiling that `motion.test.ts` enforces. Reduced motion is applied globally by `MotionConfig reducedMotion="user"` and must not be re-implemented per component (the sole exception is `clipPath`, which Framer's policy doesn't cover — `ProgressBar`/`BudgetPage` gate it with `useReducedMotion()`). Gesture *decisions* stay as pure predicates in `lib/` (`sheetDrag`, `edgeBack`, `rowSwipe`, `swipe`, `toastSwipe`), each taking `(offset, velocity)` from Framer's `onDragEnd` info with co-located tests — Framer's drag cannot be driven meaningfully in jsdom, so the gestures themselves are verified in `harness/gestures.mjs`. Three animations stay in CSS on purpose: the pixel spinner's negative `animation-delay` phase shift, the skeleton pulse, and — the one that matters, because it is a transition on a `transform` — `Switch`'s knob, which is marked `data-css-transition`. `frontend/src/components/README.md` records all three; `harness/audit.mjs` check 9 enforces the rule and honours the marker. **Never put `opacity: 0` in an `initial` prop for content visible on first paint** — `LazyMotion` resolves its features in an effect, so until that chunk lands `m.*` renders straight from `initial` and the content is simply invisible; entrances for first-paint content are transform-only (check 10 catches regressions). Any test rendering an `m.*` must wrap it in `MotionProvider` — unwrapped, it does not throw, it renders *stuck at its initial state*.

`components/dither-kit/` is **vendored source** from the dither-kit shadcn registry (charts, v0.1.0) — not an npm package. Only `core` + `bar-chart` are installed. `palette.ts` is deliberately forked to carry the app's design tokens in light and dark tables; see `components/dither-kit/README.md` before running `shadcn add --diff` against it. dither-kit's bars are vertical-only, so horizontal magnitude bars use `components/charts/DitherFill.tsx`, which renders DOM masked with the `.dither-mask` CSS class (`styles/app.css`) rather than canvas.

`frontend/src/components/README.md` is the **UI component catalog**: every shared component's purpose plus when to use / not use it, and the mobile conventions (44px targets, 16px inputs, `Pressable` for press feedback, Dialog-only overlays) plus the **Motion** section above in full. Check it before building UI; update it in the same commit whenever you add or change a shared component.

---

## Tests

```bash
go test ./...                              # every Go package
go test ./internal/parse/ -run TestCascade # one test
go test ./... -race                        # race detector

cd frontend && bun run test                # the PWA (vitest)
```

**The gate is `go test ./... && cd frontend && bun run test`.** This repository
has no CI service, so that pair is the build.

Go tests live beside the code (`*_test.go`). Frontend tests are `*.test.ts(x)` next to components, run with jsdom.

> Frontend vitest is pinned to a **single, non-parallel fork** (`fileParallelism: false`, `singleFork`) in `vite.config.ts` — the sandbox blocks vitest's default worker spawning, which otherwise silently runs only the first file. Don't "fix" this back to parallel.

Every `X.stories.tsx` has a colocated `X.stories.test.tsx` rendering the same stories via portable stories; `src/test/storybook.test.tsx` renders every story in the repo as a regression net. When you add or change a shared component, update its stories in the same commit.

### Two failure classes this codebase keeps producing

Both were found repeatedly across the build. Check for them in your own work.

1. **A check that cannot fail.** A test that passes because it never ran; a `grep` that returns nothing because the file contains a literal **NUL byte** (three separate instances — grep prints nothing *and* git diffs the file as binary, so sweeps and code reviews both skip it silently); a test double that publishes nothing. **Prove every test bites**: mutate the implementation, watch it fail, revert.
2. **A UI sentence the code does not honour.** Copy that promises something the implementation does not do. Found in every review round.

### UI testing: use the harness, not just vitest

vitest and Storybook test components in isolation. They cannot see a control
under the bottom nav, a field that refuses to stay empty, or a sheet hidden
behind the keyboard.

`frontend/harness/` drives the real PWA in a real browser against the real Go
API on a scratch DB. Full docs: `frontend/harness/README.md`.

```bash
cd frontend
harness/stack.sh up          # scratch DB + seed + Go API (:8099) + vite (:5199)
node harness/shoot.mjs       # screenshot + geometry-audit every screen
node harness/probe.mjs       # open every sheet, type into every input
node harness/ios.mjs         # WebKit + iPhone keyboard geometry
harness/stack.sh reset       # restore fixture data between rounds
```

Never point the harness at production: scratch ports and a scratch DB, never
`:8080`, never `/var/lib/ledger`.

**The method that actually found bugs**, in order of yield:

1. **Fixture data that is hostile on purpose** — `seed.mjs` contains a merchant name wider than the viewport, a 250,000 amount, an unset FX rate, a negative envelope. Bugs hide in the happy path.
2. **Measure laid-out geometry, don't eyeball it** — `audit.mjs` runs in-page and reports elements past the viewport, controls whose centre point hits a *different* element, sub-44px targets, sub-16px inputs, unreachable `overflow-hidden` content.
3. **Type into things** — `probe.mjs` clears every input and checks it stays clear. That is how the `Number("") === 0` springback was found.
4. **Read the screenshots with a critic that has no stake in the code** — the geometry audit cannot judge hierarchy, rhythm or copy.

**Traps that produced false confidence — check these before trusting a green run:**

- **`reducedMotion: "reduce"`** (set by `shoot.mjs` for stable captures) makes `Dialog`/`SettingsPage` skip their slide entirely. A green run says nothing about the animation.
- **Chromium is not Safari.** `env(safe-area-inset-*)` is 0, there is no software keyboard, and `dvh` never shrinks. iOS-only bugs are invisible — use `ios.mjs`.
- **Check which tree vite serves** (`ls -l /proc/<vite-pid>/cwd`). `stack.sh` resolves the repo from its own path, so running it from the main checkout while editing a worktree "verifies" a fix against code that lacks it.
- **Cold-start jank looks like a bug.** Discard the first run before drawing conclusions about timing, and A/B under equally warm conditions.
- **A checker that cries wolf gets ignored.** When you add a deliberate exception to a convention, teach `audit.mjs` about it in the same commit (see `data-dense-target`).

---

## Deploy

`dinosaur` is both this dev box and the production server, so deploy steps run
**locally**. `deploy/README.md` is the runbook.

`ledger.service`, binary `/usr/local/bin/ledger`, binds `127.0.0.1:8080`,
fronted by `tailscale serve /`. Tailnet only. DB `/var/lib/ledger/ledger.db` (0700),
config `/etc/ledger/config.toml`, secrets `/etc/ledger/ledger.env`.

Order: build the frontend, commit `internal/web/dist` if it changed, back up the
database, build the binary, install, restart. Then verify the **running** binary
loaded the new build, not just that health is green.

`ledgerd.service` (ledger 2.0) runs on the same box from a different repository
and a different database. Nothing in this repository can deploy it, and a deploy
from here must not take it down — check both services afterwards.
