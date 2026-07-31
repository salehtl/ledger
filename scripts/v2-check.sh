#!/usr/bin/env bash
# v2-check.sh — the v2 pre-merge gate. This repo has no CI service, so
# "disagreement fails the build" means this script IS the build; every v2
# task from here on ends by running it.
#
# Boots exactly ONE throwaway Postgres cluster for the whole run and exports
# LEDGER_TEST_POSTGRES_URL, so the ~20 v2 packages that will exist by the end
# of Phase 1 share it instead of each paying its own initdb (each package's
# TestMain still boots its own cluster when this variable is unset — see
# internal/v2/pgtest/pgtest.go — so `go test ./internal/v2/pg/` alone
# continues to work with no setup).
#
# Grows over the course of Phase 1: client/ (bun) and conformance/ steps land
# in later tasks (see Task 17 in
# docs/superpowers/plans/2026-08-01-v2-phase1-backend.md) and get appended
# here, not written from scratch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PG_STOP=""
cleanup() { [[ -n "$PG_STOP" ]] && $PG_STOP || true; }
trap cleanup EXIT

# `eval "$(go run ...)"` alone does NOT fail loudly if `go run` fails: a
# failed boot writes its error to stderr and exits 1 with EMPTY stdout, so
# the substitution yields "", `eval ""` trivially succeeds (exit 0), and
# `set -e` never sees a nonzero status — the script would silently continue
# with LEDGER_TEST_POSTGRES_URL unset and fall back to one initdb per
# package, exactly what this script exists to avoid. Capturing into a
# variable and checking `go run`'s own exit status explicitly closes that
# gap; boot's stderr (the actual error) still streams straight to the
# terminal since only stdout is captured here.
BOOT_OUT="$(go run ./internal/v2/pgtest/cmd/boot)" || {
	echo "v2-check: failed to boot postgres cluster (see error above)" >&2
	exit 1
}
eval "$BOOT_OUT"   # sets LEDGER_TEST_POSTGRES_URL= and PG_STOP=
export LEDGER_TEST_POSTGRES_URL

# -count=1 defeats the test cache. Without it, a `go test` that already
# passed against a *previous* cluster can report a cached pass without ever
# touching the cluster this run just booted — silently correct-looking on a
# script whose whole job is "no, actually run it."
#
# cmd/ledgerd is included alongside internal/v2/...: it dispatches on config
# modes via a table that must stay in sync with internal/v2/config's own
# list (see cmd/ledgerd/main_test.go), and it is the one package outside
# internal/v2/ this plan modifies repeatedly (Tasks 9, 24, 32-36 all edit
# its dispatch). A gate that didn't run its tests would let that drift ship
# unnoticed on every one of those tasks.
go vet ./internal/v2/... ./cmd/ledgerd
go test -count=1 ./internal/v2/... ./cmd/ledgerd

echo "v2-check: OK (go)"
