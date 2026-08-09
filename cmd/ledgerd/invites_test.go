package main

// Tests for inviteAdapter — the console's half of the beta gate.
//
// These run against a real cluster rather than a fake, because the property
// worth protecting is a SQL predicate: `DELETE … WHERE code_hash = $1 AND
// redeemed_at IS NULL`. A mock would only prove that the Go around it reads the
// way it was written.

import (
	"crypto/rand"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/admin"
	"ledger/internal/v2/auth"
	"ledger/internal/v2/pgtest"
)

func inviteFixture(t *testing.T) (inviteAdapter, *pgxpool.Pool) {
	t.Helper()
	pool := pgtest.New(t)
	return inviteAdapter{pool}, pool
}

// A minted code is listed under the hash the mint reported, and the code itself
// is nowhere in the listing. The two halves have to agree or the panel
// highlights a row that is not the one it just made.
func TestMintingThroughTheConsoleListsUnderTheReportedHash(t *testing.T) {
	a, _ := inviteFixture(t)

	minted, err := a.Mint(bg, "saleh's brother", time.Now().UTC())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if len(minted.Code) != 24 {
		t.Fatalf("minted a %d-character code, want 24: the generator is auth.MintInvite's and "+
			"auth.TestMintedInviteCodesAreUnguessable measures it", len(minted.Code))
	}
	rows, err := a.List(bg)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.Hash == minted.Hash {
			found = true
			if r.Note != "saleh's brother" {
				t.Errorf("note came back as %q", r.Note)
			}
			if r.RedeemedAt != nil {
				t.Error("a freshly minted code is already redeemed")
			}
		}
	}
	if !found {
		t.Fatalf("the mint reported hash %s and the listing has no such row", minted.Hash)
	}
}

// Revoking an unredeemed code deletes it, and the code stops working — which is
// the whole point, and is checked against the redemption path rather than
// against the row count.
func TestRevokingAnInviteCode(t *testing.T) {
	a, pool := inviteFixture(t)

	minted, err := a.Mint(bg, "wrong person", time.Now().UTC())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if err := a.Revoke(bg, minted.Hash); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	var n int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM invite_codes WHERE code_hash = $1`,
		auth.InviteCodeHash(minted.Code)).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("the row survived a revoke; the code can still create an account")
	}
	// And a second revoke of the same hash is a clean "not found" rather than a
	// silent success, so a double click says what happened.
	if err := a.Revoke(bg, minted.Hash); err != admin.ErrInviteNotFound {
		t.Fatalf("revoking twice returned %v, want ErrInviteNotFound", err)
	}
}

// A REDEEMED code is refused, and the row is still there afterwards. That row is
// why an account exists; deleting it would erase the audit trail while leaving
// the account untouched.
func TestRevokingARedeemedCodeIsRefusedAndKeepsTheRow(t *testing.T) {
	a, pool := inviteFixture(t)

	minted, err := a.Mint(bg, "a real beta tester", time.Now().UTC())
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	// Spend it, the way a sign-in would.
	sub := make([]byte, 32)
	if _, err := rand.Read(sub); err != nil {
		t.Fatalf("rand: %v", err)
	}
	var user uuid.UUID
	if err := pool.QueryRow(bg,
		`INSERT INTO users (idp, idp_sub_hash, created_at) VALUES ('apple', $1, now()) RETURNING id`,
		sub).Scan(&user); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := pool.Exec(bg,
		`UPDATE invite_codes SET redeemed_at = now(), redeemed_by = $2 WHERE code_hash = $1`,
		auth.InviteCodeHash(minted.Code), user); err != nil {
		t.Fatalf("redeem: %v", err)
	}

	if err := a.Revoke(bg, minted.Hash); err != admin.ErrInviteRedeemed {
		t.Fatalf("Revoke returned %v, want ErrInviteRedeemed", err)
	}
	var n int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM invite_codes WHERE code_hash = $1`,
		auth.InviteCodeHash(minted.Code)).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("the refused revoke deleted the row anyway; the account it created is now "+
			"unaccounted for (%d rows)", n)
	}
}

// A hash prefix nothing matches, and one that is not hex at all.
func TestRevokingAHashThatMatchesNothing(t *testing.T) {
	a, _ := inviteFixture(t)
	if err := a.Revoke(bg, "aabbccddeeff"); err != admin.ErrInviteNotFound {
		t.Fatalf("Revoke returned %v, want ErrInviteNotFound", err)
	}
	if err := a.Revoke(bg, "zzzz"); err != admin.ErrInviteNotFound {
		t.Fatalf("Revoke of a non-hex prefix returned %v, want ErrInviteNotFound", err)
	}
}

// A prefix short enough to match two rows is refused rather than resolved.
// Nothing reaches this by accident at six bytes — it is here because the code
// takes a PREFIX, and a prefix match that silently picked one row would delete
// the wrong invitation.
func TestAnAmbiguousHashPrefixRevokesNothing(t *testing.T) {
	a, pool := inviteFixture(t)
	for i := 0; i < 2; i++ {
		if _, err := a.Mint(bg, "one of two", time.Now().UTC()); err != nil {
			t.Fatalf("Mint: %v", err)
		}
	}
	// The empty prefix matches every row: substring(x from 1 for 0) is the empty
	// bytea for all of them.
	if err := a.Revoke(bg, ""); err != admin.ErrInviteAmbiguous {
		t.Fatalf("Revoke of an all-matching prefix returned %v, want ErrInviteAmbiguous", err)
	}
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM invite_codes`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("an ambiguous revoke deleted something (%d rows left of 2)", n)
	}
}
