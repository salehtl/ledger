# M7 verification + deploy

Milestone 7 ships the XP-themed PWA (Dashboard / Review / Transactions / Settings)
plus the M5 API slice it needs (budget engine, `/api/summary`, `/api/budget`,
`/api/categories/{id}` PUT, `/api/rules`, SSE `/api/events`).

## Build order (build-time Bun only; the runtime ships no JS toolchain)

1. `cd frontend && bun install && bun run build`  → writes `internal/web/dist`
2. `cd .. && go build -o ledger ./cmd/ledger`       → embeds `dist/`
3. Restart the systemd service on dinosaur.

## Verified (2026-06-14, local smoke test on :8099)

Built the binary and hit it with an empty config (IMAP + AI disabled):

- `GET /api/health` → `{"status":"ok","db":"ok",...}`
- `GET /api/summary?period=current` → 3 buckets (need/want/saving), `month_progress`, `period`
- `GET /api/budget` → snake_case config defaults (`need_pct:0.5`, …)
- `GET /review` → serves the SPA shell (`index.html`) via the client-route fallback
- `GET /manifest.webmanifest` → PWA manifest
- `GET /icon-192.png` → `image/png` 200

Gates: `bun run test` (8 files, 17 tests) green; `go build ./...` and `go test ./...` green.

## Live update check (manual, against real data)

Confirm a review item in the Review tab and watch the dashboard jars + the review
tab badge update via SSE (`/api/events` emits `tx`; the frontend invalidates the
`summary`/`review`/`transactions` query keys).

## Follow-ups (non-blocking)

- **Icons are placeholders.** The Fugue icon pack download 404'd during the build,
  so `frontend/public/icons/*.png` are transparent 16×16 placeholders and the
  launcher icons are plain Luna-blue/green PNGs. Swap in the real Fugue set
  (CC BY 3.0 — attribution already in `NOTICE` and Settings ▸ About) when network
  access to the pack is available.
- The `internal/budget` projection guard for `month_progress == 0` is unreachable
  via real clocks (cosmetic).
