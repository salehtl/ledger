package api

import (
	"net/http"
	"testing"
	"time"

	"ledger/internal/v2/purge"
)

// A device has to be able to tell "sign in again" from "there is nothing to
// sign in to", because only the second one may make it wipe local data.
//
// The account is destroyed through the REAL purge, not by deleting rows this
// test picked: the whole hazard 00021 exists for is that the state the naive
// check looks for ("session resolves, user row missing") is unreachable in
// production, and a test that arranged that state by hand would pass over it.
func TestADeletedAccountAnswers410AndAnExpiredSessionStill401(t *testing.T) {
	h := newHarness(t)
	u := h.user("sub-doomed")
	tok := h.session(u)
	wantStatus(t, h.req("GET", "/api/v1/writers", tok, nil), http.StatusOK)

	if _, err := purge.Purge(bg, h.pool, nil, u); err != nil {
		t.Fatalf("purge: %v", err)
	}

	w := h.req("GET", "/api/v1/writers", tok, nil)
	wantStatus(t, w, http.StatusGone)
	if got := w.Body.String(); got != `{"error":"account_deleted"}` {
		t.Fatalf("body = %s, want the byte-identical account_deleted answer", got)
	}
	// Every authenticated route, not just the one the client happened to call.
	for _, path := range []string{"/api/v1/sync?stream=hot", "/api/v1/sync/hashes?stream=hot", "/api/v1/key-history"} {
		if code := h.req("GET", path, tok, nil).Code; code != http.StatusGone {
			t.Fatalf("%s answered %d, want 410", path, code)
		}
	}
}

func TestAnExpiredSessionIsStillA401(t *testing.T) {
	// The case a client must NOT wipe on, and the common one. If this ever
	// becomes a 410, every routine token expiry destroys an offline user's
	// outbox.
	h := newHarness(t)
	u := h.user("sub-expiring")
	tok := h.session(u)
	wantStatus(t, h.req("GET", "/api/v1/writers", tok, nil), http.StatusOK)

	if _, err := h.pool.Exec(bg,
		`UPDATE sessions SET expires_at = $1 WHERE user_id = $2`,
		time.Now().Add(-time.Hour), u); err != nil {
		t.Fatal(err)
	}
	w := h.req("GET", "/api/v1/writers", tok, nil)
	wantStatus(t, w, http.StatusUnauthorized)
	if got := w.Body.String(); got != `{"error":"unauthorized"}` {
		t.Fatalf("the 401 body changed to %q", got)
	}
}

// An unknown token is a 401 and must never be answered as a deleted account:
// that would confirm to an unauthenticated caller that a guessed token was once
// real.
func TestAnUnknownTokenIsA401(t *testing.T) {
	h := newHarness(t)
	w := h.req("GET", "/api/v1/writers", "not-a-token-anyone-issued", nil)
	wantStatus(t, w, http.StatusUnauthorized)
}
