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
# by `bun test`.
#
# Task 17 added the normalizer, and with it the cross-executor conformance
# runner (client/src/norm/conformance.test.ts). That runner is why the `bun test`
# step is not optional: the Go and TypeScript normalizers must produce
# byte-identical output, and this script is the only thing that checks it. A
# mutation battery of 16 plausible normalizer defects was used to confirm the
# suite can actually fail — all 16 are caught here, and 8 of them are invisible
# to the full 7,002-message corpus, so `go test` alone would have passed every
# one of them.
#
# What this script does NOT run is the full-corpus cross-executor diff: it needs
# a snapshot of the operator's live v1 mailbox, which most checkouts do not have.
# It is a measurement, reproduced deliberately:
#
#   LEDGER_CORPUS_DB=$S/corpus.db LEDGER_CROSSEXEC_OUT=$S/go-corpus.jsonl \
#     go test ./internal/v2/norm/ -run TestWriteCrossExecutorCorpus -timeout 20m
#   (cd client && bun run scripts/crossexec.ts $S/go-corpus.jsonl)
#
# Task 20 added the same pair for the TEMPLATE executor. The committed fixtures
# (conformance/templates/) sample 500 messages per template out of 6,868; the
# full run below is 13,798 (template, message) pairs and was zero-disagreement
# when it landed:
#
#   LEDGER_CORPUS_DB=$S/corpus.db LEDGER_CROSSEXEC_OUT=$S/go-templates.jsonl \
#     go test ./internal/v2/tmpl/ -run TestWriteCrossExecutorTemplates -timeout 20m
#   (cd client && bun run scripts/crossexec-tmpl.ts $S/go-templates.jsonl)
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
go test -count=1 ./internal/importer

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
(cd client && bun run typecheck && bun test src/diag/structure.test.ts && bun test)

# The Expo React Native app. Phase 2 tasks 3 and 9-27 built every screen of
# this app and, until now, nothing here checked any of it: the client/ step
# above only covers the shared TypeScript executor, not the app that consumes
# it. Measured before this step existed: the gate reported exit 0 while
# `cd app && bun test` alone gave 518 pass / 1 fail (bootstrap.test.ts, a
# stale test fixture that didn't know about a dictionary sync call a prior
# task had wired into bootstrap). That is exactly the failure mode this step
# closes — code landing in app/ with nothing to catch it. Same rule as
# client/: no `bun install` here, so a missing app/node_modules is a hard
# failure with the fix named rather than a gate that mutates the tree to pass.
#
# The 13 *.rn-test.tsx mounted-component tests run under jest, not bun test.
# They were landing ungated until now — bun test covers *.test.ts but not the
# React Native mounted renders in *.rn-test.tsx, including
# RuntimeNavigation.rn-test.tsx which verifies the app wires into itself. That
# is a second hole of exactly this shape: code shipping with nothing to catch
# it. Both test suites run via `test:all` in app/package.json.
if [[ ! -d app/node_modules ]]; then
	echo "v2-check: app/node_modules is missing; run (cd app && bun install)" >&2
	exit 1
fi
(cd app && bun run typecheck && bun run test:all)

echo "v2-check: OK (go + client + app + conformance)"
