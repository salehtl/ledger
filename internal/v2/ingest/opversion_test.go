package ingest

import (
	"testing"

	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
)

// TestAppendedOpsAreReadableByAV2Client is the deploy blast radius, pinned.
//
// Before this rule the pipeline stamped oplog.SchemaVersion on every op, so the
// moment the schema moved to v3 ordinary transaction traffic hard-stopped every
// un-upgraded client -- and, because the log is append-only, every one of those
// rows carried a v3 floor it never needed, forever. A txn_ingested requires
// nothing past v2 (see txnPayload.schemaVersion), so it must not claim more.
//
// Asserted end to end rather than on the helper, because the property that
// matters is what actually reaches the log.
func TestAppendedOpsAreReadableByAV2Client(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")

	ops := r.hotOps()
	if len(ops) != 1 {
		t.Fatalf("want one hot op, got %d", len(ops))
	}
	if got := ops[0].V; got > 2 {
		t.Fatalf("txn_ingested stamped v%d: a transaction needs nothing past v2, and stamping the build's "+
			"ceiling hard-stops every older client over ordinary traffic -- permanently, since the log is append-only", got)
	}
	if got, want := ops[0].V, ops[0].Type.MinVersion(); got < want {
		t.Fatalf("txn_ingested stamped v%d, below its type minimum v%d", got, want)
	}
}

// TestTxnPayloadVersionIsTheFloorNotTheCeiling covers the half an end-to-end
// test cannot reach, and the half that makes the naive fix wrong.
//
// verified_origin_domain arrived at schema v2 and the TypeScript executor
// REFUSES it below that (replay.ts decodeTxnPayload: "verified_origin_domain
// requires schema v2"). So stamping the TYPE's minimum -- 1 -- on a payload
// carrying that field does not merely under-claim: the op folds to an
// invalid_payload anomaly and the transaction never appears on any device, for
// the life of the log. The floor is the type minimum RAISED by the payload.
func TestTxnPayloadVersionIsTheFloorNotTheCeiling(t *testing.T) {
	bare := txnPayload{AmountMinor: "25000", Currency: "AED", Direction: "debit"}
	if got := bare.schemaVersion(oplog.OpTxnIngested); got != 1 {
		t.Fatalf("a payload with no verified origin wants v%d, got v%d", 1, got)
	}

	attested := bare
	attested.VerifiedOriginDomain = "bank.example"
	if got := attested.schemaVersion(oplog.OpTxnIngested); got != 2 {
		t.Fatalf("verified_origin_domain requires v2, got v%d -- a v1 stamp makes the TypeScript fold "+
			"reject the payload and lose the transaction permanently", got)
	}

	// A type whose own minimum is already above the payload's floor keeps it.
	if got := attested.schemaVersion(oplog.OpTxnDuplicateDisposition); got != 2 {
		t.Fatalf("want v2, got v%d", got)
	}
}
