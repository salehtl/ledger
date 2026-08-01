package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// countingReprocessor records what it was handed and can be made to fail, so a
// test can reach the Incomplete path without breaking the pipeline.
type countingReprocessor struct {
	batches [][][]byte
	report  Report
	err     error
}

func (r *countingReprocessor) Reprocess(_ context.Context, _ uuid.UUID, ids [][]byte) (Report, error) {
	r.batches = append(r.batches, ids)
	return r.report, r.err
}

// Confirming a sender re-ingests held mail inside a user-facing request. It was
// the one write path in this API with no budget at all, and it is by some
// distance the most expensive thing a session can ask for: up to 500 messages
// through the whole parse cascade, synchronously.
func TestQuarantineConfirmIsRateLimitedPerUser(t *testing.T) {
	h := newQHarness(t)
	u := h.user("sub-confirm-limit")
	session := h.session(u)
	// No refill during the test: the burst is the whole budget.
	h.srv.QuarantinePerUser = NewLimiter(0, 3, 128, time.Now)
	h.h = h.srv.Handler()

	served, limited := 0, 0
	for i := 0; i < 12; i++ {
		h.hold(t, u, "confirm-limit-"+string(rune('a'+i)), nil)
		rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
			ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
		switch rec.Code {
		case http.StatusOK:
			served++
		case http.StatusTooManyRequests:
			limited++
		default:
			t.Fatalf("request %d answered %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if served != 3 {
		t.Fatalf("%d confirmations served, want exactly the burst of 3", served)
	}
	if limited != 9 {
		t.Fatalf("%d refusals, want 9", limited)
	}
}

// The budget is the address/account one: 1/minute sustained, burst 10. A
// mismatch here is not cosmetic — it is the difference between a limit shaped
// for a rare, deliberate user action and one shaped for a poll.
func TestQuarantineBudgetMatchesTheAddressAndAccountBudgets(t *testing.T) {
	if quarantineRate != addressRate || quarantineBurst != addressBurst {
		t.Fatalf("quarantine budget is %v/%v, want the address budget %v/%v",
			quarantineRate, quarantineBurst, addressRate, addressBurst)
	}
	if quarantineRate != accountRate || quarantineBurst != accountBurst {
		t.Fatalf("quarantine budget is %v/%v, want the account budget %v/%v",
			quarantineRate, quarantineBurst, accountRate, accountBurst)
	}
}

// A Server built field-by-field must still be limited: the limiter has to be
// filled in by Handler like every other one, or the production path is
// unlimited while the test that sets it by hand passes.
func TestQuarantineLimiterIsFilledInByHandler(t *testing.T) {
	h := newQHarness(t)
	if h.srv.QuarantinePerUser == nil {
		t.Fatal("Handler() left QuarantinePerUser nil: the route is unlimited in production")
	}
}

// Incomplete and Remaining have to survive the JSON round trip, because they
// are the only way a client learns that the confirmation released more mail
// than one request re-ingested and that it must come back.
func TestConfirmReportsIncompleteAndRemainingToTheClient(t *testing.T) {
	h := newQHarness(t)
	u := h.user("sub-incomplete")
	session := h.session(u)
	for _, seed := range []string{"a", "b", "c"} {
		h.hold(t, u, "incomplete-"+seed, nil)
	}
	rp := &countingReprocessor{err: errors.New("the cascade fell over")}
	h.srv.Reprocessor = rp
	h.srv.MaxReingestPerConfirm = 2
	h.h = h.srv.Handler()

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", rec.Code, rec.Body.String())
	}
	// Read the WIRE, not the struct: a field renamed or dropped from the JSON
	// tag is invisible to a typed decode of our own type.
	var raw struct {
		Reingest struct {
			Incomplete bool `json:"incomplete"`
			Remaining  int  `json:"remaining"`
		} `json:"reingest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if !raw.Reingest.Incomplete {
		t.Fatal("a failed re-ingest did not set incomplete on the wire")
	}
	if raw.Reingest.Remaining != 1 {
		t.Fatalf("remaining = %d, want 1 (3 released, batch cap 2)", raw.Reingest.Remaining)
	}
	if len(rp.batches) != 1 || len(rp.batches[0]) != 2 {
		t.Fatalf("the reprocessor saw %v, want one batch of 2", rp.batches)
	}
}

// A confirmation that succeeds and releases nothing more must NOT claim to be
// incomplete: a client that paged on a false flag would loop.
func TestACompleteConfirmSaysSo(t *testing.T) {
	h := newQHarness(t)
	u := h.user("sub-complete")
	session := h.session(u)
	h.hold(t, u, "complete-a", nil)
	h.srv.Reprocessor = &countingReprocessor{}
	h.h = h.srv.Handler()

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ConfirmSenderResponse](t, rec)
	if out.Reingest == nil {
		t.Fatal("no reingest report")
	}
	if out.Reingest.Incomplete || out.Reingest.Remaining != 0 {
		t.Fatalf("a complete confirmation reported %+v", out.Reingest)
	}
}
