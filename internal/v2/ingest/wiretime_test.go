package ingest

// wiretime_test.go covers the ONE timestamp this package renders for the wire.
//
// It lives in its own file because the property it pins is not about the
// pipeline: it is that this package does not have a second opinion about how an
// instant is written. `posted_at` rides in a txn_ingested payload, which the
// TypeScript replay engine decodes, so `wireTime` is one half of a dual-executor
// contract even though nothing here calls the other half.
//
// The check exists because the same defect was live one package over. Before
// this, `wireTime` restated `t.UTC().Truncate(time.Millisecond).
// Format(time.RFC3339Nano)` — correct for every instant the pipeline can
// actually produce, and silently wrong outside years 0000-9999, where Go writes
// "10000-01-01T23:58:59Z" and the TypeScript executor's `canonicalTime` writes
// "+010000-01-01T23:58:59.000Z". Deleting the second renderer is what fixed it;
// this is what stops it growing back. A mutation run put the inline expression
// back and every other test in this package stayed green.

import (
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/norm"
)

func TestWireTimeIsTheSharedRendererAndRefusesWhatTheWireCannotCarry(t *testing.T) {
	// Ordinary instants, rendered exactly. Sub-millisecond precision is dropped
	// because a JavaScript Date cannot hold it, and the trailing zeros go with
	// it because that is what Go's RFC3339Nano does — the documented, harmless
	// half of the two encoders' byte divergence.
	for _, tc := range []struct {
		in   time.Time
		want string
	}{
		{time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC), "2026-06-05T10:00:00Z"},
		{time.Date(2026, 6, 5, 10, 0, 0, 500_000_000, time.UTC), "2026-06-05T10:00:00.5Z"},
		{time.Date(2026, 6, 5, 10, 0, 0, 1_500_000, time.UTC), "2026-06-05T10:00:00.001Z"},
		{time.Date(2026, 6, 5, 10, 0, 0, 1_500, time.UTC), "2026-06-05T10:00:00Z"},
		// An offset is normalised away; the wire carries UTC and a literal Z.
		{time.Date(2026, 6, 5, 14, 0, 0, 0, time.FixedZone("GST", 4*60*60)), "2026-06-05T10:00:00Z"},
		// The legal ends of the four-digit-year range still render.
		{time.Date(9999, 12, 31, 23, 59, 59, 999_000_000, time.UTC), "9999-12-31T23:59:59.999Z"},
		{time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC), "0000-01-01T00:00:00Z"},
	} {
		got, err := wireTime(tc.in)
		if err != nil {
			t.Errorf("wireTime(%v): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("wireTime(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}

	// And the range the wire cannot express is REFUSED rather than rendered in
	// a spelling only one of the two executors uses. Reachable only through a
	// date source with a numeric zone, which no layout has today (see the
	// doc comment on wireTime) — so this is the guard that makes adding such a
	// layout a loud change instead of a silent one.
	for _, bad := range []time.Time{
		time.Date(10000, 1, 1, 23, 58, 59, 0, time.UTC),
		time.Date(-1, 12, 31, 23, 59, 0, 0, time.UTC),
	} {
		got, err := wireTime(bad)
		if err == nil {
			t.Errorf("wireTime(%v) = %q, want a refusal: the TypeScript executor spells this range differently", bad, got)
		} else if !strings.Contains(err.Error(), "four-digit-year") {
			t.Errorf("wireTime(%v) refused without naming the range: %v", bad, err)
		}
	}
}

// TestTxnPayloadRefusesAPostedAtTheWireCannotCarry is the same guard at the
// caller, so the error has a path out of the pipeline rather than being
// swallowed into an empty string.
func TestTxnPayloadRefusesAPostedAtTheWireCannotCarry(t *testing.T) {
	var tr tierResult
	tr.ext.PostedAt = time.Date(10000, 1, 1, 23, 58, 59, 0, time.UTC)
	tr.ext.AmountMinor = 25000
	if _, err := txnPayloadOf(norm.Result{}, tr, time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("txnPayloadOf must refuse a posted_at outside the four-digit-year range")
	} else if !strings.Contains(err.Error(), "posted_at") {
		t.Fatalf("the refusal does not name the field: %v", err)
	}
}
