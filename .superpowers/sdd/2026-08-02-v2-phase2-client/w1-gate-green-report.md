# Gate Green Report: v2 Ingest Test Fixes

**Status:** DONE

**Commit SHA:** `daba1cddef369bc7a394f129088e1573d21dddba`

## Summary

Fixed three failing Go tests in `internal/v2/ingest/reprocess_test.go` that were left stale by the SchemaVersion 1→2 bump (2026-08-03 session).

## Issues & Fixes

### 1. TestReprocessSupersedeRecomputesFXAtItsOwnPosition
**Problem:** Test asserted a closed set of allowed payload fields that predated `verified_origin_domain`.

**Root Cause:** Production code deliberately sets `verified_origin_domain` on supersede payloads (from `origin.Decide()` domain resolution path). Test's allowed-field set was stale.

**Fix:** Added `"verified_origin_domain": true` to the allowed fields map. Verified via code inspection: field is legitimately set by `reprocess.go:399` when re-evaluating trust for a supersede.

### 2. TestReprocessSkipsAClientBlobThisBuildCannotRead
**Problem:** Test created a client blob at version 2 to mean "unreadable by this build". Version 2 is now current (SchemaVersion=2), so it reads fine and the test asserted the opposite of its name.

**Fix:** Added `newerVersion()` helper returning `strconv.Itoa(oplog.SchemaVersion + 1)`. Changed hardcoded `"v":2` to `"v":` + newerVersion() + `` in both blob-version tests. Follows ffed895 precedent exactly.

### 3. TestReprocessFailsOnAServerBlobThisBuildCannotRead
**Problem:** Same as #2 — constructed unreadable blob at version 2, which is no longer unreadable.

**Fix:** Applied same `newerVersion()` arithmetic fix.

## Verification

**Gate Result:** ✓ PASS (exit code 0)
- Go tests: all pass
- Client tests: 2350 tests, 0 failures, 65.87s
- Conformance: dual-executor OK
- Covered: `./internal/v2/ingest` + full client + conformance suite

**Pre-existing failures:** None detected outside scope.

## Design Decisions

**verified_origin_domain conclusion:** LEGITIMATE PRODUCTION FIELD. The supersede payload MUST carry `verified_origin_domain` because:
1. Reprocess re-evaluates trust via `origin.Decide()` on the stored email
2. The new domain resolution may differ from the original ingest (e.g., if DKIM setup changed)
3. The corrected transaction must record the verified domain at its NEW position in the log
4. This is a deliberate design choice, not a defect

The test's closed-set guard was protecting against accidental field leakage; that protection still works — it now correctly allows the one new field the production code intentionally emits.
