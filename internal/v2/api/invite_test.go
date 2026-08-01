package api

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"ledger/internal/v2/auth"
)

// invite mints one code against this harness's database, exactly as
// `ledgerd mint-invite` does.
func (h *harness) invite(note string) string {
	h.t.Helper()
	code, err := auth.MintInvite(bg, h.pool, note, time.Now().UTC())
	if err != nil {
		h.t.Fatal(err)
	}
	return code
}

func TestSignUpNeedsAnInviteCode(t *testing.T) {
	h := newHarness(t)
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
	wantStatus(t, w, http.StatusForbidden)
	if got := w.Body.String(); got != `{"error":"not_invited"}` {
		t.Fatalf("body = %s, want the byte-identical not_invited answer", got)
	}
	if n := h.countUsers(t); n != 0 {
		t.Fatalf("%d accounts created without an invite", n)
	}
}

func TestAValidInviteCreatesExactlyOneAccountAndSpendsTheCode(t *testing.T) {
	h := newHarness(t)
	code := h.invite("the first beta tester")
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "tok", InviteCode: code,
	})
	wantStatus(t, w, http.StatusOK)
	out := decodeJSON[ExchangeResponse](t, w)
	if out.SessionToken == "" || out.UserID == "" {
		t.Fatalf("exchange returned %+v", out)
	}
	if n := h.countUsers(t); n != 1 {
		t.Fatalf("%d accounts, want exactly 1", n)
	}
	// The session works, so the account is whole (counter row, ingest writer).
	wantStatus(t, h.req("GET", "/api/v1/sync?stream=hot", out.SessionToken, nil), http.StatusOK)

	var unredeemed int
	if err := h.pool.QueryRow(bg,
		`SELECT count(*) FROM invite_codes WHERE redeemed_at IS NULL`).Scan(&unredeemed); err != nil {
		t.Fatal(err)
	}
	if unredeemed != 0 {
		t.Fatal("the code was not marked redeemed")
	}
}

func TestASpentInviteIsRefusedAndCreatesNoAccount(t *testing.T) {
	h := newHarness(t)
	code := h.invite("")
	wantStatus(t, h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "one", InviteCode: code,
	}), http.StatusOK)

	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "two", InviteCode: code,
	})
	wantStatus(t, w, http.StatusForbidden)
	if got := w.Body.String(); got != `{"error":"not_invited"}` {
		t.Fatalf("body = %s", got)
	}
	if n := h.countUsers(t); n != 1 {
		t.Fatalf("%d accounts, want 1: a spent code created a second one", n)
	}
}

func TestAWrongInviteIsRefused(t *testing.T) {
	h := newHarness(t)
	h.invite("")
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "tok", InviteCode: "ZZZZZZZZZZZZZZZZZZZZZZZZ",
	})
	wantStatus(t, w, http.StatusForbidden)
	if n := h.countUsers(t); n != 0 {
		t.Fatalf("%d accounts created by a wrong code", n)
	}
}

// The gate is on CREATION. A user who already has an account signs in with no
// code, for ever — a beta gate that logged existing users out of their own
// ledger would be worse than an open sign-up.
func TestAnExistingAccountSignsInWithNoInvite(t *testing.T) {
	h := newHarness(t)
	u := h.user("sub-tok")
	w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{IdP: auth.IdPApple, IDToken: "tok"})
	wantStatus(t, w, http.StatusOK)
	if got := decodeJSON[ExchangeResponse](t, w).UserID; got != u.String() {
		t.Fatalf("user id = %s, want %s", got, u)
	}
}

// A returning user presenting a live code must not burn it: the field is
// ignored entirely, not "spent if present".
func TestAnExistingAccountDoesNotSpendAnInvite(t *testing.T) {
	h := newHarness(t)
	h.user("sub-tok")
	code := h.invite("")
	wantStatus(t, h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "tok", InviteCode: code,
	}), http.StatusOK)

	// Still spendable by the person it was meant for.
	wantStatus(t, h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "someone-else", InviteCode: code,
	}), http.StatusOK)
}

// not_invited is the ONLY distinguishable rejection on this endpoint. Every
// credential failure stays the byte-identical 401 it was, so the gate does not
// become an oracle for which tokens verify.
func TestNotInvitedIsTheOnlyDistinguishableRejection(t *testing.T) {
	h := newHarness(t)
	var answers []string
	for _, err := range []error{auth.ErrSignature, auth.ErrExpired, auth.ErrAudience, auth.ErrIssuer, auth.ErrNoSubject} {
		h.apple.err = err
		w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
			IdP: auth.IdPApple, IDToken: "tok", InviteCode: "ZZZZZZZZZZZZZZZZZZZZZZZZ",
		})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%v returned %d, want 401 — a bad credential must not be answered as an invite problem", err, w.Code)
		}
		answers = append(answers, w.Body.String())
	}
	for i, a := range answers {
		if a != answers[0] {
			t.Fatalf("rejection %d answered %q, the first answered %q", i, a, answers[0])
		}
	}
	if answers[0] != `{"error":"unauthorized"}` {
		t.Fatalf("the 401 body changed to %q", answers[0])
	}
}

// Two devices racing on one code produce one account and one session.
func TestConcurrentSignUpsOnOneCodeCreateOneAccount(t *testing.T) {
	h := newHarness(t)
	code := h.invite("")

	const racers = 6
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			w := h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
				IdP: auth.IdPApple, IDToken: "racer-" + string(rune('a'+i)), InviteCode: code,
			})
			mu.Lock()
			defer mu.Unlock()
			codes[w.Code]++
		}(i)
	}
	close(start)
	wg.Wait()

	if codes[http.StatusOK] != 1 {
		t.Fatalf("%d of %d concurrent sign-ups succeeded, want exactly 1 (all: %v)", codes[http.StatusOK], racers, codes)
	}
	if codes[http.StatusForbidden] != racers-1 {
		t.Fatalf("%d refusals, want %d (all: %v)", codes[http.StatusForbidden], racers-1, codes)
	}
	if n := h.countUsers(t); n != 1 {
		t.Fatalf("%d accounts, want 1", n)
	}
}

// A rejected sign-up must not leave the identity half-provisioned: no counter
// row, no ingest writer, nothing for a later sign-in to inherit.
func TestARefusedSignUpLeavesNothingBehind(t *testing.T) {
	h := newHarness(t)
	wantStatus(t, h.req("POST", "/api/v1/auth/exchange", "", ExchangeRequest{
		IdP: auth.IdPApple, IDToken: "tok",
	}), http.StatusForbidden)
	for _, table := range []string{"users", "oplog_seq", "writers", "sessions"} {
		var n int
		if err := h.pool.QueryRow(bg, `SELECT count(*) FROM `+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s holds %d rows after a refused sign-up", table, n)
		}
	}
}
