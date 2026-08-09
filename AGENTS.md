# Repository Guidelines

## This tree holds TWO apps

Since 2026-08-09, `main` is **ledger 2.0**, the multi-user app. The v1 single-user
app is still here, still deployed, and still used every day. Decide which app your
task belongs to before you edit anything — the two share a module and a git
history, and little else.

| | **ledger 2.0 (v2)** | **ledger 1.0 (v1)** |
|---|---|---|
| Binary | `cmd/ledgerd` | `cmd/ledger` |
| Backend | `internal/v2/**` | `internal/**` (not `v2`) |
| Frontend | `web/` | `frontend/` |
| Embedded bundle | `internal/v2/webui/dist` | `internal/web/dist` |
| Database | PostgreSQL (`ledger_v2`) | SQLite |
| Ingest | SMTP `:25`, users forward mail | IMAP, one mailbox, read-only |
| Reach | public (`app.sirdab.ae`) | tailnet only |
| Gate | `scripts/v2-check.sh` | `go test ./...` + frontend vitest |

Branches: `main` (both apps) · `ledger-v1` (the v1 line at handover) ·
`v2-wip-2026-08-05` (v2 integration, currently equal to `main`).

`CLAUDE.md` is the long form of all of this. Read it before a first change.

## Project Structure & Module Organization

**Shared / neither app.** `client/` is a TypeScript library whose normalizer and
template executor must produce **byte-identical** output to their Go twins in
`internal/v2/norm` and `internal/v2/tmpl`; `conformance/` holds the cross-executor
fixtures that prove it. `app/` is the **abandoned** Expo native client — do not
extend it. `deploy/` holds runbooks (`README.md` for v1, `README-v2.md` for v2);
plans and specs live in `docs/superpowers/`.

**v2.** `cmd/ledgerd/` is the entry point and dispatches on `os.Args[1]` **before**
flag parsing, so the mode always comes first. Backend packages live in
`internal/v2/`: `api` (HTTP + sync), `auth` (passkeys, sessions), `pg` (pool +
goose migrations), `oplog`, `smtpd`/`ingest`/`origin`/`arc` (mail receipt and
origin verification), `quarantine`, `norm`/`tmpl`/`heuristic` (parsing), `dict`,
`admin` (tailnet-only operator console), `pushv2`, `purge`, `relay`, `config`,
`verify`, `webui` (the embedded bundle), `pgtest`. The PWA is `web/src/`, with
the local-first engine in `web/src/v2/`. Vite writes the committed bundle to
`internal/v2/webui/dist/`.

**v1.** `cmd/ledger/` is the entry point. Backend packages live under `internal/`:
`store` owns SQLite, `ingest` reads IMAP, `parse` extracts transactions,
`categorize` applies rules and AI fallback, `server` exposes the HTTP/SSE API. The
React 19/TypeScript PWA is in `frontend/src/`, organized into `screens/`,
`components/`, `hooks/`, `api/`, and pure helpers in `lib/`. Static assets are in
`frontend/public/`. Vite writes the committed bundle to `internal/web/dist/`.

## Build, Test, and Development Commands

The frontend is embedded in the binary, so **build the frontend before `go build`**
in both apps.

**v2**

- `cd web && bun install`: install pinned dependencies.
- `cd web && bun run build`: type-check (app and service worker) and build into `internal/v2/webui/dist/`.
- `CGO_ENABLED=0 go build -o ledgerd ./cmd/ledgerd`: build the binary after the web app.
- `bash scripts/v2-check.sh`: **the gate**. This repo has no CI service, so this script is the build. It boots one throwaway Postgres cluster, then runs the Go tests, the `client/` tests, the web tests and the cross-executor conformance suites.
- `cd web && bun run test` / `cd client && bun test`: the two suites on their own.

**v1**

- `cd frontend && bun install`: install pinned dependencies.
- `cd frontend && bun run dev`: start Vite; API URLs are relative, so run the Go server or configure a proxy.
- `cd frontend && bun run build`: type-check and build into `internal/web/dist/`.
- `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`: build the binary after the frontend.
- `cd frontend && bun run test`: the sequential Vitest/jsdom suite.

**Both:** `go test ./...` covers every Go package in the tree, for both apps.

## Coding Style & Naming Conventions

Format Go with `gofmt`; use conventional Go package and file names. TypeScript uses
two-space indentation, semicolons, PascalCase React components, `useX` hooks, and
camelCase helpers. Keep components thin by moving decision, formatting, and gesture
logic into tested, framework-free `lib/` functions. Consult and update
`frontend/src/components/README.md` when changing shared v1 UI components. Store
money as integer minor units — `int64`, never floating point — and keep transaction
amounts positive with a separate debit/credit direction. In-app copy is plain and
short: simple words, one idea per sentence.

## Testing Guidelines

Co-locate Go tests as `*_test.go` and frontend tests as `*.test.ts` or `*.test.tsx`.
Add focused coverage for parser fallbacks, data persistence, API behavior, and UI
edge cases. Run a single backend test with `go test ./internal/parse -run TestCascade`
or `go test ./internal/v2/api/`; run one frontend file with
`cd web && bunx vitest run src/path/File.test.tsx`. Do not re-enable parallel Vitest
workers; the configuration intentionally uses one fork.

**Prove every test can fail.** Mutate the implementation, watch the test fail, then
revert. Two failure classes recur in this codebase and both defeat a green run:

1. **A check that cannot fail** — a test that never ran; a `grep` that finds nothing
   because the file contains a literal **NUL byte** (git also diffs such a file as
   binary, so sweeps and code reviews skip it silently); a double that publishes
   nothing.
2. **A UI sentence the code does not honour** — copy promising what the
   implementation does not do.

vitest cannot see a control under the bottom nav or a sheet behind the keyboard.
v1 has `frontend/harness/` for that. **v2's coverage is partial**: `web/harness/`
was forked with the tree and most of it still drives v1, so a naive run there goes
green against code that was never loaded. `web/harness/v2settings.mjs` is the one
runner that reaches the v2 product. Never point a harness at production.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, often scoped: `feat(v2): ...`,
`fix(api): ...`, `refactor(store): ...`, `docs: ...`. Keep commits focused and
imperative. Pull requests should explain behavior and risk, link relevant plans,
list tests run, and include screenshots for visible UI changes.

**Concurrent sessions share one git index.** Never `git add -A` or `git commit -a`.
Stage explicit pathspecs, and run `git diff --cached --name-only` immediately before
every commit to confirm you are committing only your own files.

**Rebuild and commit the embedded bundle whenever frontend source changes** —
`internal/web/dist/` for v1, `internal/v2/webui/dist/` for v2. For v2 this is not
optional and the gate will not catch it: `scripts/v2-check.sh` builds the web bundle
into a temp directory by design, so the committed bundle never refreshes and the
tree stays clean either way. On 2026-08-09 a fully green gate shipped a binary still
serving the previous Settings screen.

Never commit secrets. IMAP, AI, VAPID, admin, relay and database credentials belong
in environment variables, not TOML; v2's config loader rejects the file outright if
a secret appears in it.
