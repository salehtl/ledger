package auth

import (
	"crypto/sha256"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

func mustMint(t *testing.T, pool *pgxpool.Pool, note string) string {
	t.Helper()
	code, err := MintInvite(bgctx, pool, note, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func countUsers(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

func TestMintedInviteIsNeverStoredInTheClear(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "saleh's brother")

	var stored []byte
	var note string
	if err := pool.QueryRow(bgctx, `SELECT code_hash, note FROM invite_codes`).Scan(&stored, &note); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), code) {
		t.Fatal("the invite_codes table contains the code itself")
	}
	want := sha256.Sum256([]byte(code))
	if string(stored) != string(want[:]) {
		t.Fatalf("stored hash is not SHA-256 of the code")
	}
	if note != "saleh's brother" {
		t.Fatalf("note = %q, want the operator's words back", note)
	}
}

func TestMintedInvitesAreDistinct(t *testing.T) {
	pool := pgtest.New(t)
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		code := mustMint(t, pool, "")
		if seen[code] {
			t.Fatalf("minted the same code twice: %q", code)
		}
		seen[code] = true
	}
}

// The code is typed by a human off a message. Case and the separators a person
// adds while reading it aloud must not decide whether their account is created.
func TestInviteCodeNormalizationIsForgiving(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "")
	lower := strings.ToLower(code)
	spaced := " " + code[:4] + "-" + code[4:] + "\n"

	if NormalizeInviteCode(lower) != code {
		t.Fatalf("lower-cased code does not normalize back: %q", NormalizeInviteCode(lower))
	}
	if NormalizeInviteCode(spaced) != code {
		t.Fatalf("spaced/dashed code does not normalize back: %q", NormalizeInviteCode(spaced))
	}
	// And it is the NORMALIZED form the redemption keys on, end to end.
	u, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-normalize"), spaced)
	if err != nil {
		t.Fatalf("a spaced code did not redeem: %v", err)
	}
	if u == uuid.Nil {
		t.Fatal("no user created")
	}
}

// An empty string must not normalize into something that matches a row, and
// must not be mistaken for "no code required".
func TestEmptyInviteCodeIsRefused(t *testing.T) {
	pool := pgtest.New(t)
	mustMint(t, pool, "")
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-empty"), ""); !errors.Is(err, ErrNotInvited) {
		t.Fatalf("err = %v, want ErrNotInvited", err)
	}
	if n := countUsers(t, pool); n != 0 {
		t.Fatalf("%d users created by a refused sign-up", n)
	}
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

func TestValidCodeCreatesExactlyOneAccountAndIsMarkedRedeemed(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "the beta tester")

	u, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-first"), code)
	if err != nil {
		t.Fatal(err)
	}
	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("%d users, want exactly 1", n)
	}

	var redeemedAt *time.Time
	var redeemedBy *uuid.UUID
	if err := pool.QueryRow(bgctx,
		`SELECT redeemed_at, redeemed_by FROM invite_codes`).Scan(&redeemedAt, &redeemedBy); err != nil {
		t.Fatal(err)
	}
	if redeemedAt == nil {
		t.Fatal("the code is still unredeemed")
	}
	if redeemedBy == nil || *redeemedBy != u {
		t.Fatalf("redeemed_by = %v, want %v", redeemedBy, u)
	}

	// The counter row and the ingest writer are still created — the invite gate
	// wraps UpsertUser's transaction rather than replacing it.
	var seqs, writers int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM oplog_seq WHERE user_id = $1`, u).Scan(&seqs); err != nil {
		t.Fatal(err)
	}
	if seqs != 1 {
		t.Fatalf("oplog_seq rows = %d, want 1", seqs)
	}
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM writers WHERE user_id = $1 AND writer_id = 'ingest'`, u).Scan(&writers); err != nil {
		t.Fatal(err)
	}
	if writers != 1 {
		t.Fatalf("ingest writer rows = %d, want 1", writers)
	}
}

func TestASpentCodeCreatesNoSecondAccount(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "")
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-one"), code); err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-two"), code); !errors.Is(err, ErrNotInvited) {
		t.Fatalf("err = %v, want ErrNotInvited", err)
	}
	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("%d users, want 1: a spent code created a second account", n)
	}
}

func TestAWrongCodeCreatesNoAccount(t *testing.T) {
	pool := pgtest.New(t)
	mustMint(t, pool, "")
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-wrong"), "AAAAAAAAAAAAAAAAAAAAAAAA"); !errors.Is(err, ErrNotInvited) {
		t.Fatalf("err = %v, want ErrNotInvited", err)
	}
	if n := countUsers(t, pool); n != 0 {
		t.Fatalf("%d users created by a wrong code", n)
	}
}

// The whole point of "gates account CREATION only": a returning user signs in
// with no code and spends nothing.
func TestAnExistingUserSignsInWithNoCode(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "")
	first, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-return"), code)
	if err != nil {
		t.Fatal(err)
	}
	again, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-return"), "")
	if err != nil {
		t.Fatalf("a returning user was refused: %v", err)
	}
	if again != first {
		t.Fatalf("second sign-in returned %v, want %v", again, first)
	}
	var unredeemed int
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM invite_codes WHERE redeemed_at IS NULL`).Scan(&unredeemed); err != nil {
		t.Fatal(err)
	}
	if unredeemed != 0 {
		t.Fatalf("%d unredeemed codes: the returning sign-in should have spent nothing new", unredeemed)
	}
}

// A returning user presenting a still-good code must not burn it. The field is
// ignored entirely, not "used if present".
func TestAReturningUserDoesNotSpendACode(t *testing.T) {
	pool := pgtest.New(t)
	first := mustMint(t, pool, "")
	spare := mustMint(t, pool, "")
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-spare"), first); err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-spare"), spare); err != nil {
		t.Fatal(err)
	}
	var redeemed int
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM invite_codes WHERE redeemed_at IS NOT NULL`).Scan(&redeemed); err != nil {
		t.Fatal(err)
	}
	if redeemed != 1 {
		t.Fatalf("%d codes redeemed, want 1: a returning sign-in spent a spare code", redeemed)
	}
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-other"), spare); err != nil {
		t.Fatalf("the spare code was consumed and can no longer invite anyone: %v", err)
	}
}

// Redemption is atomic: two requests racing on one code produce one account.
func TestConcurrentRedemptionOfOneCodeCreatesOneAccount(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "")

	const racers = 6
	var wg sync.WaitGroup
	var mu sync.Mutex
	var ok, refused int
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-race-"+string(rune('a'+i))), code)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrNotInvited):
				refused++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if ok != 1 {
		t.Fatalf("%d of %d concurrent redemptions succeeded, want exactly 1", ok, racers)
	}
	if refused != racers-1 {
		t.Fatalf("%d refusals, want %d", refused, racers-1)
	}
	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("%d users, want 1", n)
	}
}

// Deleting an account must not put its invite code back into circulation.
func TestDeletingAnAccountDoesNotFreeItsInviteCode(t *testing.T) {
	pool := pgtest.New(t)
	code := mustMint(t, pool, "")
	u, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-deleted"), code)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-after"), code); !errors.Is(err, ErrNotInvited) {
		t.Fatalf("err = %v, want ErrNotInvited: a deleted account freed its code", err)
	}
	// The row is still there, marked spent, with the link to the person gone.
	var redeemedAt *time.Time
	var redeemedBy *uuid.UUID
	if err := pool.QueryRow(bgctx,
		`SELECT redeemed_at, redeemed_by FROM invite_codes`).Scan(&redeemedAt, &redeemedBy); err != nil {
		t.Fatal(err)
	}
	if redeemedAt == nil {
		t.Fatal("the code came back unredeemed")
	}
	if redeemedBy != nil {
		t.Fatalf("redeemed_by = %v, want NULL after the account was deleted", *redeemedBy)
	}
}
