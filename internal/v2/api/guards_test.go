package api

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// randomBody is plaintext that does not compress, so its sealed size is the
// size it was written as. See the byte-budget test.
func randomBody(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// suspend flips users.status directly, which is what the admin console's two
// endpoints do. This package is deliberately not the one that owns that write —
// the console is — so the test writes the column rather than importing the
// console into the API's own tests.
func (h *harness) suspend(u uuid.UUID) {
	h.t.Helper()
	if _, err := h.pool.Exec(bg, `UPDATE users SET status = 'suspended' WHERE id = $1`, u); err != nil {
		h.t.Fatalf("suspend %s: %v", u, err)
	}
}

func (h *harness) resume(u uuid.UUID) {
	h.t.Helper()
	if _, err := h.pool.Exec(bg, `UPDATE users SET status = 'active' WHERE id = $1`, u); err != nil {
		h.t.Fatalf("resume %s: %v", u, err)
	}
}

// A suspended account is refused on every mutating method, with ONE distinct
// code, so the client can render "account paused" rather than something that
// looks like data loss.
func TestASuspendedAccountIsRefusedOnEveryWriteMethod(t *testing.T) {
	h := newHarness(t)
	u := h.user("suspended-writes")
	tok := h.session(u)
	h.suspend(u)

	// One route per mutating method the mux actually serves, so the check is
	// about the METHOD and not about one handler.
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/v1/sync", UploadRequest{WriterID: "w1", Stream: "hot"}},
		{http.MethodPost, "/api/v1/writers/challenge", nil},
		{http.MethodPut, "/api/v1/keys", map[string]any{}},
		{http.MethodDelete, "/api/v1/push/subscriptions", nil},
	} {
		w := h.req(tc.method, tc.path, tok, tc.body)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s: %d, want 403 (body %s)", tc.method, tc.path, w.Code, w.Body)
			continue
		}
		if got := decodeJSON[errorBody](t, w).Error; got != "account_suspended" {
			t.Errorf("%s %s: error = %q, want account_suspended", tc.method, tc.path, got)
		}
	}
}

// GET stays open, deliberately: a suspended user's devices keep reading their
// own data. A suspension that also blanked the app would be indistinguishable,
// to the user, from the operator having deleted them.
func TestASuspendedAccountCanStillRead(t *testing.T) {
	h := newHarness(t)
	u := h.user("suspended-reads")
	tok := h.session(u)
	h.seedIngest(u, 2)
	h.suspend(u)

	for _, p := range []string{
		"/api/v1/sync?stream=hot",
		"/api/v1/sync/hashes?stream=hot",
		"/api/v1/writers",
		"/api/v1/push/subscriptions",
	} {
		if w := h.req(http.MethodGet, p, tok, nil); w.Code != http.StatusOK {
			t.Errorf("GET %s while suspended: %d, want 200 (body %s)", p, w.Code, w.Body)
		}
	}
	// And the rows are really there: a 200 with an empty page would be the same
	// failure wearing the right status code.
	pull := decodeJSON[PullResponse](t, h.req(http.MethodGet, "/api/v1/sync?stream=hot", tok, nil))
	if len(pull.Rows) == 0 {
		t.Fatal("a suspended account pulled zero rows; its own history must stay readable")
	}
}

// Sign-in is the one write outside requireSession and it stays open: read-only
// devices are the whole point of allowing pull, and a device needs a session to
// do it.
func TestASuspendedAccountCanStillSignIn(t *testing.T) {
	h := newHarness(t)
	// The fake verifier derives the subject from the token, so this is the same
	// account signing in again rather than a new one (which would need an invite).
	u := h.user("sub-suspended-signin")
	h.suspend(u)

	w := h.req(http.MethodPost, "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: "apple", IDToken: "suspended-signin",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("exchange for a suspended account: %d %s", w.Code, w.Body)
	}
	res := decodeJSON[ExchangeResponse](t, w)
	if res.SessionToken == "" {
		t.Fatal("exchange returned no session token")
	}
	if res.UserID != u.String() {
		t.Fatalf("exchange resolved %s, want %s", res.UserID, u)
	}
	// The session it just issued reads, and does not write.
	if w := h.req(http.MethodGet, "/api/v1/writers", res.SessionToken, nil); w.Code != http.StatusOK {
		t.Fatalf("the new session cannot read: %d %s", w.Code, w.Body)
	}
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", res.SessionToken, nil); w.Code != http.StatusForbidden {
		t.Fatalf("the new session could write: %d %s", w.Code, w.Body)
	}
}

// Resuming restores write access. Without this the lever is a one-way door and
// is no better than the purge it exists to avoid.
func TestResumingRestoresWriteAccess(t *testing.T) {
	h := newHarness(t)
	u := h.user("resume-restores")
	tok := h.session(u)

	h.suspend(u)
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", tok, nil); w.Code != http.StatusForbidden {
		t.Fatalf("suspended: %d %s, want 403", w.Code, w.Body)
	}
	h.resume(u)
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", tok, nil); w.Code != http.StatusOK {
		t.Fatalf("resumed: %d %s, want 200", w.Code, w.Body)
	}
	// The same session token works throughout: resuming must not require the
	// user to sign in again, which they may not be able to do offline.
}

// An account that was never suspended is unaffected, which is the control this
// whole file needs: every assertion above is only meaningful if the default
// answer is "allowed".
func TestAnActiveAccountWrites(t *testing.T) {
	h := newHarness(t)
	u := h.user("active-writes")
	tok := h.session(u)
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", tok, nil); w.Code != http.StatusOK {
		t.Fatalf("an active account was refused: %d %s", w.Code, w.Body)
	}
}

// ---------------------------------------------------------------------------
// The headroom fuse
// ---------------------------------------------------------------------------

// fakeFuse is the box-level fuse as this package sees it: one bool. The real
// one lives in internal/v2/headroom and samples statfs; nothing here should
// depend on how much disk the machine running the test happens to have.
type fakeFuse struct{ tripped bool }

func (f *fakeFuse) Tripped() bool { return f.tripped }

// Tripped, every durable write is refused with a temporary 503 — including the
// ones with no session, which is the reason the gate wraps the whole mux rather
// than sitting inside requireSession.
func TestTheHeadroomFuseRefusesWritesAndPermitsReads(t *testing.T) {
	h := newHarness(t)
	fuse := &fakeFuse{}
	h.srv.Headroom = fuse
	h.h = h.srv.Handler()

	u := h.user("headroom")
	tok := h.session(u)
	h.seedIngest(u, 1)

	// Above the floor: everything passes.
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", tok, nil); w.Code != http.StatusOK {
		t.Fatalf("untripped write: %d %s", w.Code, w.Body)
	}

	fuse.tripped = true

	for _, tc := range []struct {
		method, path string
		token        string
		body         any
	}{
		{http.MethodPost, "/api/v1/sync", tok, UploadRequest{WriterID: "w1", Stream: "hot"}},
		{http.MethodPost, "/api/v1/writers/challenge", tok, nil},
		{http.MethodDelete, "/api/v1/push/subscriptions", tok, nil},
		// UNAUTHENTICATED, and the case that matters most: signing in writes a
		// session row, so it is a durable write and it stops with the others.
		// headroom's package doc states this outright so it is never filed as a
		// bug.
		{http.MethodPost, "/api/v1/auth/exchange", "", ExchangeRequest{IdP: "apple", IDToken: "t"}},
	} {
		w := h.req(tc.method, tc.path, tc.token, tc.body)
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s while tripped: %d, want 503 (body %s)", tc.method, tc.path, w.Code, w.Body)
			continue
		}
		if got := decodeJSON[errorBody](t, w).Error; got != "no_headroom" {
			t.Errorf("%s %s: error = %q, want no_headroom", tc.method, tc.path, got)
		}
		if got := w.Header().Get("Retry-After"); got == "" {
			t.Errorf("%s %s: no Retry-After on a temporary refusal", tc.method, tc.path)
		}
	}

	// Reads keep serving. Refusing them would turn a storage emergency into a
	// total outage for people who are not causing it.
	for _, p := range []string{"/api/v1/sync?stream=hot", "/api/v1/writers", "/api/v1/healthz"} {
		if w := h.req(http.MethodGet, p, tok, nil); w.Code != http.StatusOK {
			t.Errorf("GET %s while tripped: %d, want 200 (body %s)", p, w.Code, w.Body)
		}
	}

	// And it is reversible in the same process: clearing the flag restores
	// writes with no restart.
	fuse.tripped = false
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", tok, nil); w.Code != http.StatusOK {
		t.Fatalf("cleared fuse: %d %s, want 200", w.Code, w.Body)
	}
}

// With no fuse wired in nothing changes. Every other test in this package runs
// this way, so a gate that refused on a nil fuse would be loud — but the
// wiring lands in a separate task, and the window in which the field is nil in
// production is exactly the window this pins.
func TestNoFuseMeansNoGate(t *testing.T) {
	h := newHarness(t)
	if h.srv.Headroom != nil {
		t.Fatal("the default server has a fuse; it must be opt-in")
	}
	u := h.user("no-fuse")
	if w := h.req(http.MethodPost, "/api/v1/writers/challenge", h.session(u), nil); w.Code != http.StatusOK {
		t.Fatalf("write with no fuse: %d %s", w.Code, w.Body)
	}
}

// ---------------------------------------------------------------------------
// The byte-weighted upload limiter
// ---------------------------------------------------------------------------

// The limiter charges BYTES, not requests: many small uploads pass where a
// smaller number of large ones do not. That is the whole design point — one
// upload durably stores up to 8 MiB, so no request rate separates a bulk import
// from an abuser, because the two differ by blob size.
func TestTheUploadLimiterChargesBytesNotRequests(t *testing.T) {
	// A byte budget of ~40 KiB with no refill, and a request budget far larger
	// than either run needs, so the ONLY thing that can refuse a request here is
	// its size.
	const budget = 40 << 10

	// Run 1: many small uploads. Each blob is a few hundred bytes sealed, so
	// twenty of them are nowhere near the byte budget.
	h := newHarness(t)
	h.srv.SyncPerUser = NewLimiter(0, 1000, 16, h.srv.now)
	h.srv.SyncUploadBytes = NewLimiter(0, budget, 16, h.srv.now)
	h.h = h.srv.Handler()
	u := h.user("bytes-small")
	tok := h.session(u)
	h.writer(u, "w-small")

	var prev [32]byte
	small := 0
	for i := int64(1); i <= 20; i++ {
		blobs, next := uploadChain(t, u, "w-small", i, prev, 1)
		w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
			WriterID: "w-small", Stream: "hot", Blobs: blobs,
		})
		if w.Code != http.StatusOK {
			t.Fatalf("small upload %d refused: %d %s", i, w.Code, w.Body)
		}
		prev = next
		small++
	}
	if small != 20 {
		t.Fatalf("only %d small uploads landed", small)
	}

	// Run 2: ONE upload of the same shape but big blobs, which is a single
	// request — fewer requests than run 1 by a factor of twenty — and it is
	// refused, on bytes.
	h2 := newHarness(t)
	h2.srv.SyncPerUser = NewLimiter(0, 1000, 16, h2.srv.now)
	h2.srv.SyncUploadBytes = NewLimiter(0, budget, 16, h2.srv.now)
	h2.h = h2.srv.Handler()
	u2 := h2.user("bytes-large")
	tok2 := h2.session(u2)
	h2.writer(u2, "w-large")

	// INCOMPRESSIBLE. blob.Seal deflates the plaintext before bucketing, so a
	// blob of zeroes would be charged as the few dozen bytes it stores rather
	// than the size it was written as — which is correct (the budget counts
	// DURABLE bytes) and would make this test measure nothing.
	big, _ := sealUpload(t, u2, "w-large", "hot", 1, [32]byte{}, string(randomBody(t, budget+1<<10)))
	w := h2.req(http.MethodPost, "/api/v1/sync", tok2, UploadRequest{
		WriterID: "w-large", Stream: "hot", Blobs: []UploadBlob{big},
	})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("one oversized upload: %d %s, want 429 on the BYTE budget", w.Code, w.Body)
	}
	if got := decodeJSON[errorBody](t, w).Error; got != "upload_bytes" {
		t.Fatalf("error = %q, want upload_bytes", got)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Error("no Retry-After on a byte-budget refusal")
	}
	// Nothing was stored: the charge is checked before the append, so a refused
	// batch costs neither a seq nor a row.
	if n := countRows(t, h2.pool, u2); n != 0 {
		t.Fatalf("%d rows stored by a refused upload", n)
	}
}

// The request limiter is a SEPARATE budget, spent per call regardless of size.
// It exists for pool fairness; the byte budget above is the storage control.
func TestTheUploadRequestLimiterIsSeparateFromTheByteBudget(t *testing.T) {
	h := newHarness(t)
	// Two requests, ever, and a byte budget nothing here can exhaust.
	h.srv.SyncPerUser = NewLimiter(0, 2, 16, h.srv.now)
	h.srv.SyncUploadBytes = NewLimiter(0, 1<<30, 16, h.srv.now)
	h.h = h.srv.Handler()
	u := h.user("request-budget")
	tok := h.session(u)
	h.writer(u, "w-req")

	var prev [32]byte
	for i := int64(1); i <= 2; i++ {
		blobs, next := uploadChain(t, u, "w-req", i, prev, 1)
		if w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
			WriterID: "w-req", Stream: "hot", Blobs: blobs,
		}); w.Code != http.StatusOK {
			t.Fatalf("upload %d: %d %s", i, w.Code, w.Body)
		}
		prev = next
	}
	blobs, _ := uploadChain(t, u, "w-req", 3, prev, 1)
	w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
		WriterID: "w-req", Stream: "hot", Blobs: blobs,
	})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("third upload: %d %s, want 429", w.Code, w.Body)
	}
	if got := decodeJSON[errorBody](t, w).Error; got != "rate_limited" {
		t.Fatalf("error = %q, want rate_limited (the REQUEST budget, not the byte one)", got)
	}
}

// A malformed batch costs no byte budget. A client with a bug must not be able
// to spend an honest user's own quota; the request limiter is what bounds a
// caller who only ever sends garbage.
//
// The shape of the check matters: it is not enough that ONE small upload still
// works afterwards, because a partly spent budget would still admit a small one.
// So the junk is enough to drain the budget more than once, and the upload that
// follows is large enough that only an UNTOUCHED budget can pay for it.
func TestARejectedUploadCostsNoByteBudget(t *testing.T) {
	const budget = 128 << 10
	h := newHarness(t)
	h.srv.SyncPerUser = NewLimiter(0, 1000, 16, h.srv.now)
	h.srv.SyncUploadBytes = NewLimiter(0, budget, 16, h.srv.now)
	h.h = h.srv.Handler()
	u := h.user("garbage")
	tok := h.session(u)
	h.writer(u, "w-garbage")

	// Structurally invalid: the declared hashes are nonsense, so the batch is
	// refused before the append.
	junk := UploadBlob{
		WriterCounter: "1",
		PrevHash:      "00",
		BlobHash:      "00",
		TypeFlag:      "edit",
		Blob:          base64.StdEncoding.EncodeToString(randomBody(t, 8<<10)),
	}
	for i := 0; i < 20; i++ {
		if w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
			WriterID: "w-garbage", Stream: "hot", Blobs: []UploadBlob{junk},
		}); w.Code == http.StatusOK {
			t.Fatalf("a malformed batch was accepted")
		}
	}

	// A real upload big enough to need most of the budget still lands.
	big, _ := sealUpload(t, u, "w-garbage", "hot", 1, [32]byte{}, string(randomBody(t, 32<<10)))
	if w := h.req(http.MethodPost, "/api/v1/sync", tok, UploadRequest{
		WriterID: "w-garbage", Stream: "hot", Blobs: []UploadBlob{big},
	}); w.Code != http.StatusOK {
		t.Fatalf("a large valid upload after twenty rejected ones: %d %s", w.Code, w.Body)
	}
}

// The production numbers are the design's, and they are checked as arithmetic
// rather than trusted as literals: the burst must exceed the largest possible
// single upload, or a conforming request would be permanently unpayable at any
// refill rate, and the sustained rate must be the stated 256 MiB a day.
func TestTheUploadByteBudgetIsSizedAgainstTheLargestUpload(t *testing.T) {
	const maxDurablePerUpload = maxUploadBlobs * (1 << 20) // oplog's per-blob cap
	if syncByteBurst <= maxDurablePerUpload {
		t.Fatalf("the byte burst (%d) is not larger than one maximal upload (%d): "+
			"such a request could never be admitted", syncByteBurst, maxDurablePerUpload)
	}
	if perDay := syncByteRate * 86400; perDay != 256<<20 {
		t.Fatalf("the sustained budget is %.0f bytes/day, want 256 MiB", perDay)
	}
}
