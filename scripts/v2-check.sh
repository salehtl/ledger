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
# Grows over the course of Phase 1. The client/ step below arrived with Task 10
# rather than waiting for Task 17, because Task 10 shipped the TypeScript half
# of the dual-executor contract and Tasks 11-13 are ALL TypeScript: without it
# the gate cannot see a client-side regression at all. Measured, not assumed —
# of five mutations used to test the conformance mechanism, two are caught only
# by `bun test`. Task 17 owns the final shape of this script (it adds the
# normalizer conformance runner and rewrites the closing line); it should absorb
# this step, not rediscover it.
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

# The TypeScript executor. `bun install` is not run here: a gate that mutates
# the working tree to make itself pass is not a gate, so a missing
# client/node_modules is a hard failure with the fix named.
#
# LEDGER_TEST_POSTGRES_URL is exported above and the subshell inherits it, which
# is what makes client/test/e2e/roundtrip.test.ts RUN here — it creates a
# scratch database in the cluster this script booted, compiles cmd/ledgerd, and
# drives the headless client against the real server over a socket. That file
# skips itself when the variable is unset, so a bare `bun test` stays fast and
# needs no Postgres while the gate exercises the round trip every time. Task 14
# added it; do not "simplify" it into an unconditional skip.
if [[ ! -d client/node_modules ]]; then
	echo "v2-check: client/node_modules is missing; run (cd client && bun install)" >&2
	exit 1
fi
(cd client && bun run typecheck && bun test)

echo "v2-check: OK (go + client)"
