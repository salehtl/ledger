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

eval "$(go run ./internal/v2/pgtest/cmd/boot)"   # prints LEDGER_TEST_POSTGRES_URL= and PG_STOP=
export LEDGER_TEST_POSTGRES_URL

go vet ./internal/v2/...
go test ./internal/v2/...

echo "v2-check: OK (go)"
