# Repository Guidelines

## Project Structure & Module Organization

`cmd/ledger/` contains the CLI entry point and wires the application together. Backend packages live under `internal/`: `store` owns SQLite, `ingest` reads IMAP, `parse` extracts transactions, `categorize` applies rules and AI fallback, and `server` exposes the HTTP/SSE API. The React 19/TypeScript PWA is in `frontend/src/`, organized into `screens/`, `components/`, `hooks/`, `api/`, and pure helpers in `lib/`. Static assets are in `frontend/public/`. Vite writes the committed embedded bundle to `internal/web/dist/`. Deployment material lives in `deploy/`; supporting plans and reviews live in `docs/`.

## Build, Test, and Development Commands

- `cd frontend && bun install`: install pinned frontend dependencies.
- `cd frontend && bun run dev`: start the Vite development server; API URLs remain relative, so run the Go server or configure a proxy.
- `cd frontend && bun run build`: type-check and build the PWA into `internal/web/dist/`.
- `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`: build the static application binary after the frontend.
- `go test ./...` or `go test ./... -race`: run backend tests, optionally with race detection.
- `cd frontend && bun run test`: run the sequential Vitest/jsdom suite.

## Coding Style & Naming Conventions

Format Go with `gofmt`; use conventional Go package and file names. TypeScript uses two-space indentation, semicolons, PascalCase React components, `useX` hooks, and camelCase helpers. Keep components thin by moving decision, formatting, and gesture logic into tested, framework-free `frontend/src/lib/` functions. Consult and update `frontend/src/components/README.md` when changing shared UI components. Store money as integer `int64` fils—never floating point—and keep transaction amounts positive with a separate debit/credit direction.

## Testing Guidelines

Co-locate Go tests as `*_test.go` and frontend tests as `*.test.ts` or `*.test.tsx`. Add focused coverage for parser fallbacks, data persistence, API behavior, and UI edge cases. Run a single backend test with `go test ./internal/parse -run TestCascade`; run one frontend file with `cd frontend && bunx vitest run src/path/File.test.tsx`. Do not re-enable parallel Vitest workers; the configuration intentionally uses one fork.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, often scoped: `feat(ui): ...`, `fix(charts): ...`, `refactor(store): ...`, and `docs: ...`. Keep commits focused and imperative. Pull requests should explain behavior and risk, link relevant issues or plans, list tests run, and include screenshots for visible UI changes. Rebuild and commit `internal/web/dist/` whenever frontend source changes. Never commit secrets; IMAP, AI, and VAPID credentials belong in environment variables, not TOML.
