# Repository Guidelines

## This repository is ledger 1.0

It held two apps between 2026-08-09 and 2026-08-11. **ledger 2.0 was extracted
on 2026-08-11 into `github.com/salehtl/ledgerd`** (checkout
`/root/Coding/ledgerd`). The tag `ledger-v2-final` marks the split point here:
`c21a1fe`, the last commit that still held v2.

v2 work belongs in the other repository — anything about `ledgerd`, passkeys,
SMTP ingest, the op log, Postgres or the cross-executor conformance suites. This
repository builds one binary (`cmd/ledger`) and one frontend (`frontend/`), and
`CLAUDE.md` is the long form of everything below. Read it before a first change.

Branches: `main` · `ledger-v1` (the v1 line at the 2026-08-09 handover, kept as
a marker). The retired v2 Expo client lives at tag `app-expo-final`.

## Project Structure & Module Organization

`cmd/ledger/` is the entry point, and it dispatches on the first argument
(`import`, `compact`, `vapid-keys`; no argument runs the server). Backend
packages live under `internal/`: `store` owns SQLite, `ingest` reads IMAP,
`parse` extracts transactions, `categorize` applies rules and AI fallback,
`recur` detects recurring charges, `server` exposes the HTTP/SSE API, `importer`
reads CSV/XLSX. The React 19/TypeScript PWA is in `frontend/src/`, organized into
`screens/`, `components/`, `hooks/`, `api/`, and pure helpers in `lib/`. Static
assets are in `frontend/public/`. Vite writes the committed bundle to
`internal/web/dist/`. `deploy/README.md` is the runbook; plans and specs live in
`docs/superpowers/`.

## Build, Test, and Development Commands

The frontend is embedded in the binary, so **build the frontend before `go build`**.

- `cd frontend && bun install`: install pinned dependencies.
- `cd frontend && bun run dev`: start Vite; API URLs are relative, so run the Go server or configure a proxy.
- `cd frontend && bun run build`: type-check and build into `internal/web/dist/`.
- `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`: build the binary after the frontend.
- `cd frontend && bun run test`: the sequential Vitest/jsdom suite.
- `go test ./...`: every Go package.

**The gate is `go test ./... && cd frontend && bun run test`.** There is no CI
service, so that pair is the build.

## Coding Style & Naming Conventions

Format Go with `gofmt`; use conventional Go package and file names. TypeScript uses
two-space indentation, semicolons, PascalCase React components, `useX` hooks, and
camelCase helpers. Keep components thin by moving decision, formatting, and gesture
logic into tested, framework-free `lib/` functions. Consult and update
`frontend/src/components/README.md` when changing shared UI components. Store
money as integer minor units — `int64`, never floating point — and keep transaction
amounts positive with a separate debit/credit direction. In-app copy is plain and
short: simple words, one idea per sentence.

## Testing Guidelines

Co-locate Go tests as `*_test.go` and frontend tests as `*.test.ts` or `*.test.tsx`.
Add focused coverage for parser fallbacks, data persistence, API behavior, and UI
edge cases. Run a single backend test with `go test ./internal/parse -run TestCascade`;
run one frontend file with `cd frontend && bunx vitest run src/path/File.test.tsx`.
Do not re-enable parallel Vitest workers; the configuration intentionally uses one
fork.

`internal/importer/testdata/vectors.json` is a **frozen** copy of vectors that
used to be a cross-language contract with a TypeScript importer. That contract
forked on 2026-08-11 and nothing checks it any more — see the CONTRACT FORK
section in `CLAUDE.md` before changing normalization.

**Prove every test can fail.** Mutate the implementation, watch the test fail, then
revert. Two failure classes recur in this codebase and both defeat a green run:

1. **A check that cannot fail** — a test that never ran; a `grep` that finds nothing
   because the file contains a literal **NUL byte** (git also diffs such a file as
   binary, so sweeps and code reviews skip it silently); a double that publishes
   nothing.
2. **A UI sentence the code does not honour** — copy promising what the
   implementation does not do.

vitest cannot see a control under the bottom nav or a sheet behind the keyboard.
`frontend/harness/` exists for that: `stack.sh up` brings up a scratch DB, seed
data, the Go API and vite; `shoot.mjs` screenshots and geometry-audits every
screen; `probe.mjs` types into every input; `ios.mjs` covers WebKit and iPhone
keyboard geometry; `gestures.mjs` drives the drag gestures jsdom cannot. Full
docs: `frontend/harness/README.md`. Never point the harness at production —
scratch ports and a scratch DB, never `:8080`, never `/var/lib/ledger`.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, often scoped: `feat(api): ...`,
`fix(parse): ...`, `refactor(store): ...`, `docs: ...`. Keep commits focused and
imperative. Pull requests should explain behavior and risk, link relevant plans,
list tests run, and include screenshots for visible UI changes.

**Concurrent sessions share one git index.** Never `git add -A` or `git commit -a`.
Stage explicit pathspecs, and run `git diff --cached --name-only` immediately before
every commit to confirm you are committing only your own files.

**Rebuild and commit `internal/web/dist/` whenever frontend source changes** —
it is a committed build artifact, and a stale bundle ships an old UI from a green
tree.

Never commit secrets. IMAP, AI and VAPID credentials belong in environment
variables, not TOML.
