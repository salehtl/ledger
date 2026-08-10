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

# --- v1/v2 binary dependency-graph fence ------------------------------------
# The two binaries share a module, a go.mod and a git history, and are meant
# to share almost nothing else (see CLAUDE.md's "two apps" section): a v2
# change never belongs in internal/parse, and a v1 change never belongs in
# internal/v2. This asserts that boundary holds by construction — every task
# from here on, not just the ones that remember to check by hand.
#
# `go list -deps` walks each binary's actual BUILD graph, which is exactly
# the thing that matters and exactly why the three `internal/parse` imports
# inside internal/v2/norm/corpus_test.go, internal/v2/norm/corpus_probe_test.go
# and internal/v2/tmpl/seed/corpus_gate_test.go (the sanctioned
# parse-equivalence gate, comparing v2's corpus tooling against v1's own
# parser) need no special case below: `go list -deps` (without `-test`) never
# follows a _test.go file's imports at all, so a sanctioned test-only import
# cannot even reach this list, whether or not anyone remembers it is
# sanctioned.
#
# PIPEFAIL TRAP: this script runs `set -euo pipefail`, so a `grep` with no
# match anywhere in a pipeline kills the whole script. The naive spelling of
# this check — `go list -deps ./cmd/ledgerd | grep internal/parse` — treats
# "found nothing" (the passing case, every clean run) as a pipeline failure,
# so it would fail the gate every time the boundary holds. Patching that with
# `|| true` "fixes" the crash but throws away the exit status entirely, so the
# check can never fail again even the day someone actually adds the import —
# a check that cannot fail is worse than no check, per the standing rule.
# `comm -12` on two sorted, file-backed lists sidesteps both failure modes:
# it exits 0 whether or not the intersection is empty, so the pass/fail
# decision below is an explicit string test on its captured output, never a
# pipeline's aggregate exit code.
v2_deps="$(go list -deps ./cmd/ledgerd)"
v1_deps="$(go list -deps ./cmd/ledger)"
v2_deps_file="$(mktemp)"
v1_deps_file="$(mktemp)"
grep '^ledger/' <<<"$v2_deps" | sort >"$v2_deps_file"
grep '^ledger/' <<<"$v1_deps" | sort >"$v1_deps_file"
shared_deps="$(comm -12 "$v2_deps_file" "$v1_deps_file")"
rm -f "$v2_deps_file" "$v1_deps_file"
if [[ -n "$shared_deps" ]]; then
	echo "v2-check: cmd/ledgerd and cmd/ledger share package(s) in their binary" >&2
	echo "dependency graphs. These are supposed to be DISJOINT (see CLAUDE.md's" >&2
	echo "\"two apps\" section); a v2 change must never reach into a v1 package" >&2
	echo "and a v1 change must never reach into internal/v2. Shared package(s):" >&2
	echo "$shared_deps" >&2
	exit 1
fi

PG_STOP=""
# The scratch bundle directory the web guards build into (see the bottom of this
# script). Cleaned up on any exit, including a failing one, so a gate that stops
# early does not leave a ~2 MB bundle behind in /tmp on every run.
WEB_OUT=""
cleanup() {
	[[ -n "$WEB_OUT" ]] && rm -rf "$WEB_OUT"
	[[ -n "$PG_STOP" ]] && $PG_STOP || true
}
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
# internal/importer is the Go executor of conformance/import/vectors.json
# (paired with client/src/importer); it must run in this gate despite being a v1 package.
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

# app/ (Expo) was removed 2026-08-10; preserved at tag app-expo-final. See
# docs/superpowers/specs/2026-08-07-v2-pwa-direction.md for why.

# The PWA client. Same rule as client/: no `bun install` here, so a missing
# web/node_modules is a hard failure with the fix named rather than a gate
# that mutates the tree to pass.
if [[ ! -d web/node_modules ]]; then
	echo "v2-check: web/node_modules is missing; run (cd web && bun install)" >&2
	exit 1
fi
(cd web && bun run test)

# `bun run build` (`tsc -b && vite build`), not just `bun run test`: it is the
# only thing that exercises the two guards that keep client/'s engine safe to
# import from a browser bundle. `tsc -b` is TYPECHECK-ONLY, so it is the only
# path that can catch a stray `Bun.*` reference under web/src (there is
# nothing for it to resolve against — see web/tsconfig.json's "paths"
# comment). The bundler guard — a hard failure if anyone imports
# `@ledger/client/platform` or `@ledger/client/store/open` into browser code,
# because those statically pull in `node:zlib`/`node:crypto`/`bun:sqlite` — is
# `vite build`'s job (see vite.config.ts's alias comment); `bun run test`
# never runs Rollup, so it cannot see that failure either. Task 3 added this
# line after finding the gap.
#
# It builds into a THROWAWAY directory. `internal/v2/webui/dist` is a tracked
# artifact the deploy step owns, and a gate that rewrites it dirties the working
# tree on every run — after which the checkout silently disagrees with what is
# deployed and `git status` stops being usable as a signal. Both guards run
# either way: they are `tsc -b` and Rollup, and neither cares where the output
# lands. `LEDGER_WEB_OUT_DIR` is read by web/vite.config.ts and has no other
# caller; the deploy build passes no override and writes the committed artifact.
WEB_OUT="$(mktemp -d)"
(cd web && LEDGER_WEB_OUT_DIR="$WEB_OUT" bun run build)

echo "v2-check: OK (go + client + web + conformance)"
