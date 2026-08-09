package api

// What an account at its cumulative op-log ceiling is told. It used to be told
// "500 internal": the append refused on policy grounds and writeAppendErr had
// no case for it, so the one answer a user could act on was rendered as the
// server being broken.

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"ledger/internal/v2/budget"
)

func setOplogCeiling(t *testing.T, h *harness, bytes int64) {
	t.Helper()
	if _, err := h.pool.Exec(bg,
		`UPDATE account_limits SET oplog_bytes = $1 WHERE user_id IS NULL`, bytes); err != nil {
		t.Fatal(err)
	}
}

func refusalCount(t *testing.T, h *harness, u uuid.UUID, resource string) int64 {
	t.Helper()
	var n int64
	if err := h.pool.QueryRow(bg,
		`SELECT coalesce(sum(count), 0) FROM account_refusals WHERE user_id = $1 AND resource = $2`,
		u, resource).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The whole defect, end to end: a full account is answered 413 account_full
// with its own numbers, not 500 internal.
func TestAnUploadOverTheAccountCeilingIs413AndNot500(t *testing.T) {
	h := newHarness(t)
	u := h.user("full")
	tok := h.session(u)
	h.writer(u, "w1")
	setOplogCeiling(t, h, 1)

	blobs, _ := uploadChain(t, u, "w1", 1, [32]byte{}, 1)
	w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
		WriterID: "w1", Stream: "hot", Blobs: blobs,
	})
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("an upload over the ceiling: %d %s, want 413", w.Code, w.Body)
	}
	body := decodeJSON[errorBody](t, w)
	if body.Error != "account_full" {
		t.Fatalf("error = %q, want account_full", body.Error)
	}
	if body.Budget == nil {
		t.Fatal("no budget numbers on the refusal; the client can only say 'sync failed'")
	}
	if body.Budget.Limit != 1 {
		t.Fatalf("budget.limit = %d, want the ceiling (1)", body.Budget.Limit)
	}
	if body.Budget.Have != 0 {
		t.Fatalf("budget.have = %d, want 0: this account holds nothing yet", body.Budget.Have)
	}
	if body.Budget.Delta <= body.Budget.Limit {
		t.Fatalf("budget.delta = %d, want the bytes this upload asked for (more than the ceiling)",
			body.Budget.Delta)
	}
	if body.Budget.Resource != budget.ResourceOplogHotBytes {
		t.Fatalf("budget.resource = %q, want %q", body.Budget.Resource, budget.ResourceOplogHotBytes)
	}
	if n := countRows(t, h.pool, u); n != 0 {
		t.Fatalf("%d rows stored by a refused upload", n)
	}
	// The receipt, written outside the transaction that was rolled back. A
	// refusal nobody records is the silent drop account_refusals exists to
	// prevent.
	if n := refusalCount(t, h, u, budget.ResourceOplogHotBytes); n != 1 {
		t.Fatalf("account_refusals[oplog_hot_bytes] = %d, want 1", n)
	}
}

// The ceiling and the limiter must stay DISTINGUISHABLE, because a client's
// remedy differs. 429 upload_bytes means "too soon" — the same batch succeeds
// later, and Retry-After says roughly when. 413 account_full means "too much" —
// the same batch never succeeds until something is deleted or the ceiling is
// raised, and a client that retried it on a timer would retry forever.
func TestTheCeilingAndTheUploadLimiterAreDifferentAnswers(t *testing.T) {
	h := newHarness(t)
	u := h.user("shaped")
	tok := h.session(u)
	h.writer(u, "w1")
	// A byte budget of zero refuses before the append; the ceiling is wide
	// open, so this can only be the limiter.
	h.srv.SyncUploadBytes = NewLimiter(0, 1, 16, h.srv.now)
	h.h = h.srv.Handler()

	blobs, _ := uploadChain(t, u, "w1", 1, [32]byte{}, 1)
	w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
		WriterID: "w1", Stream: "hot", Blobs: blobs,
	})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("the limiter answered %d %s, want 429", w.Code, w.Body)
	}
	if got := decodeJSON[errorBody](t, w); got.Error != "upload_bytes" || got.Budget != nil {
		t.Fatalf("limiter refusal = %+v, want upload_bytes with no ceiling numbers", got)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Error("no Retry-After on the limiter's refusal: it is the one that IS worth retrying")
	}
}

// Every other answer keeps the field absent, so a client can key on its
// presence. A budget object on a chain break would be meaningless noise in the
// one error the spec makes a non-dismissable hard stop.
func TestOnlyTheCeilingRefusalCarriesBudgetNumbers(t *testing.T) {
	h := newHarness(t)
	u := h.user("chained")
	tok := h.session(u)
	h.writer(u, "w1")

	// A batch that starts above the empty head: a chain break, not a budget
	// refusal.
	blobs, _ := uploadChain(t, u, "w1", 5, [32]byte{}, 1)
	w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
		WriterID: "w1", Stream: "hot", Blobs: blobs,
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("a chain break answered %d %s, want 409", w.Code, w.Body)
	}
	if got := decodeJSON[errorBody](t, w); got.Budget != nil {
		t.Fatalf("a chain break carried budget numbers: %+v", got.Budget)
	}
}
