package auth

import (
	"crypto/sha256"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
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

// ---------------------------------------------------------------------------
// What an invite row is allowed to remember about a deleted account
// ---------------------------------------------------------------------------

// Deleting an account takes the operator's NOTE about that person with it, and
// takes nobody else's.
//
// 00020, purge.go's notUserLinked classification and deploy/README-v2.md all
// said the same thing — "the link to the person removed … an unattributable
// residue", "what survives is 'some code was spent, and nobody knows by whom'"
// — and all three described `redeemed_by ON DELETE SET NULL` and stopped
// there. `note` is operator free text whose own documented example in 00020 is
// `saleh's brother`, and it survived beside `redeemed_at`, the timestamp of
// that person's sign-up. In a beta of a dozen people that pair names the
// deleted account outright, to precisely the party the row is kept for.
//
// TWO accounts, not one, and the second one's note is checked: a fixture with a
// single deletion cannot tell "cleared the right note" from "cleared every
// note", and the second failure is a silent loss of the operator's whole audit
// trail on an account that was never deleted.
func TestDeletingAnAccountForgetsTheOperatorsNoteAboutThemAndNobodyElses(t *testing.T) {
	pool := pgtest.New(t)

	goneCode := mustMint(t, pool, "saleh's brother")
	stayCode := mustMint(t, pool, "the beta tester from the bank thread")
	outstanding := mustMint(t, pool, "for the colleague who has not signed up yet")

	gone, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-note-gone"), goneCode)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-note-stays"), stayCode); err != nil {
		t.Fatal(err)
	}

	if got := noteOf(t, pool, goneCode); got != "saleh's brother" {
		t.Fatalf("note before deletion = %q; this test cannot see a reaping that never had "+
			"anything to reap", got)
	}

	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, gone); err != nil {
		t.Fatal(err)
	}

	if got := noteOf(t, pool, goneCode); got != "" {
		t.Fatalf("note = %q after the account was deleted: the row still says who spent it, "+
			"which is what 00020, purge.notUserLinked and deploy/README-v2.md all promise it "+
			"does not", got)
	}
	if got := noteOf(t, pool, stayCode); got != "the beta tester from the bank thread" {
		t.Fatalf("a LIVE account's note = %q: deleting one account destroyed another's record", got)
	}
	if got := noteOf(t, pool, outstanding); got != "for the colleague who has not signed up yet" {
		t.Fatalf("an UNREDEEMED code's note = %q: `mint-invite --show` is the only answer to "+
			"'who is this outstanding code for' and it just lost it", got)
	}

	// Everything the operator is promised DOES survive still survives: the row,
	// the spent flag, and the refusal to hand the code out again.
	var redeemedAt *time.Time
	var redeemedBy *uuid.UUID
	if err := pool.QueryRow(bgctx,
		`SELECT redeemed_at, redeemed_by FROM invite_codes WHERE code_hash = $1`,
		inviteCodeHash(goneCode)).Scan(&redeemedAt, &redeemedBy); err != nil {
		t.Fatal(err)
	}
	if redeemedAt == nil {
		t.Fatal("the code came back unredeemed: reaping the note must not un-spend the row")
	}
	if redeemedBy != nil {
		t.Fatalf("redeemed_by = %v, want NULL", *redeemedBy)
	}
	if _, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-note-after"), goneCode); !errors.Is(err, ErrNotInvited) {
		t.Fatalf("err = %v, want ErrNotInvited: reaping the note freed the code", err)
	}
}

// The claim in full, measured against the row rather than against the one
// column somebody remembered: after the account is gone, no text column of the
// invite row contains anything the operator wrote about that person.
//
// This is the version that does not go stale. The three descriptions are about
// the ROW ("nobody knows by whom"), so a future column carrying an email, a
// referrer or a support-ticket id would falsify them exactly as `note` did —
// and would fail here without anybody remembering to come back.
func TestNoTextTheOperatorWroteAboutADeletedAccountSurvivesInTheInviteRow(t *testing.T) {
	pool := pgtest.New(t)
	const secret = "dr aisha, the cardiologist from the clinic"
	code := mustMint(t, pool, secret)
	u, err := UpsertUserInvited(bgctx, pool, appleIdentity("sub-note-scan"), code)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}

	rows, err := pool.Query(bgctx,
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'public' AND table_name = 'invite_codes'
		    AND data_type IN ('text', 'character varying', 'character')
		  ORDER BY column_name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		cols = append(cols, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(cols) == 0 {
		t.Fatal("invite_codes has no text columns at all: this scan is vacuous")
	}
	for _, col := range cols {
		var v *string
		if err := pool.QueryRow(bgctx,
			`SELECT `+col+` FROM invite_codes WHERE code_hash = $1`,
			inviteCodeHash(code)).Scan(&v); err != nil {
			t.Fatal(err)
		}
		if v != nil && strings.Contains(*v, "aisha") {
			t.Fatalf("invite_codes.%s still reads %q after the account was deleted", col, *v)
		}
	}
}

func noteOf(t *testing.T, pool *pgxpool.Pool, code string) string {
	t.Helper()
	var note string
	if err := pool.QueryRow(bgctx,
		`SELECT coalesce(note, '') FROM invite_codes WHERE code_hash = $1`,
		inviteCodeHash(code)).Scan(&note); err != nil {
		t.Fatal(err)
	}
	return note
}

// ---------------------------------------------------------------------------
// Entropy: the one property the whole gate rests on
// ---------------------------------------------------------------------------

// A minted code is 24 characters of RFC 4648 base32 carrying 120 bits, and
// nothing about it is predictable from another one.
//
// This exists because two mutations survived the entire package before it did:
// `inviteCodeBytes = 2` (a SIXTEEN-BIT invite code) and codes minted from an
// incrementing counter rather than crypto/rand, whose first code on a fresh
// deployment is "AEAAAAAAAAAAAAAAAAAAAAAA". Both are catastrophic and both were
// invisible, because the properties the suite checked were distinctness (a
// counter is perfectly distinct) and that the digest is what gets stored (a
// digest of a guessable input is a guessable credential). Unguessability was
// asserted only in a comment, on the same line that would have to change to
// break it.
//
// It matters more here than in most places: `403 not_invited` is a perfect
// oracle. A guesser learns, on every attempt, whether the code they tried
// exists — so entropy is the only thing between this beta and open sign-up.
//
// Every code below is minted through MintInvite, the production entry point, so
// there is no seam between what is measured and what an operator runs.
// The randomness comes from crypto/rand, measured against invite.go's syntax
// tree rather than against its output.
//
// This is the half of unguessability a statistical test CANNOT see.
// TestMintedInviteCodesAreUnguessable samples 256 codes from one process, and
// `math/rand.New(rand.NewSource(1))` passes every statistic it computes —
// uniform per position, pairwise independent, all distinct — while producing
// the SAME 256 codes on every deployment that ever runs the binary. The
// property that fails there is not the distribution, it is the seed, and the
// only place the seed is visible is the import.
//
// So: crypto/rand imported, math/rand not imported at all (in either version),
// and MintInvite actually calling rand.Read rather than importing the good
// package and using something else.
func TestTheInviteCodeSourceIsCryptoRand(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "invite.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}

	imports := map[string]bool{}
	for _, spec := range file.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			t.Fatal(err)
		}
		if spec.Name != nil && spec.Name.Name != "rand" && path == "crypto/rand" {
			t.Fatalf("crypto/rand is imported as %q; this test reads call sites by the name "+
				"`rand`, so rename it back or teach this test the alias", spec.Name.Name)
		}
		imports[path] = true
	}
	if !imports["crypto/rand"] {
		t.Fatal("invite.go does not import crypto/rand: an invite code minted from anything " +
			"else is reproducible by whoever knows the seed, and 403 not_invited tells them " +
			"when they have it right")
	}
	for _, bad := range []string{"math/rand", "math/rand/v2"} {
		if imports[bad] {
			t.Fatalf("invite.go imports %s", bad)
		}
	}

	var mint *ast.FuncDecl
	for _, d := range file.Decls {
		if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == "MintInvite" {
			mint = fn
		}
	}
	if mint == nil {
		t.Fatal("invite.go declares no MintInvite")
	}
	found := false
	ast.Inspect(mint.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "rand" && sel.Sel.Name == "Read" {
			found = true
		}
		return true
	})
	if !found {
		t.Fatal("MintInvite never calls rand.Read: crypto/rand is imported and unused for the " +
			"one value that has to be unpredictable")
	}
}

func TestMintedInviteCodesAreUnguessable(t *testing.T) {
	pool := pgtest.New(t)

	const (
		sample = 256
		// A base32 character is 5 bits; the alphabet is 32 symbols.
		wantChars = 24
		wantBytes = 15
		wantBits  = 120
	)

	codes := make([]string, 0, sample)
	decoded := make([][]byte, 0, sample)
	for i := 0; i < sample; i++ {
		codes = append(codes, mustMint(t, pool, ""))
	}

	// --- Shape. A short code fails HERE, before any statistic: 2 bytes encode
	// to 4 characters, and no amount of sampling is needed to see that.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	for _, code := range codes {
		if len(code) != wantChars {
			t.Fatalf("code %q is %d characters, want %d: %d bits of entropy, not %d",
				code, len(code), wantChars, len(code)*5, wantBits)
		}
		for _, r := range code {
			if !strings.ContainsRune(alphabet, r) {
				t.Fatalf("code %q contains %q, which is not in the base32 alphabet %q "+
					"— the alphabet is narrower than it claims, or the encoding changed",
					code, r, alphabet)
			}
		}
		// Mint and redemption must agree on what "the same code" is, and a
		// freshly minted code is already in normal form.
		if NormalizeInviteCode(code) != code {
			t.Fatalf("NormalizeInviteCode(%q) = %q: a minted code is not in the form it is "+
				"redeemed in", code, NormalizeInviteCode(code))
		}
		raw, err := inviteAlphabet.DecodeString(code)
		if err != nil {
			t.Fatalf("minted code %q does not decode as base32: %v", code, err)
		}
		if len(raw)*8 != wantBits {
			t.Fatalf("code %q carries %d bits, want %d", code, len(raw)*8, wantBits)
		}
		decoded = append(decoded, raw)
	}

	// --- Every position varies. This is the assertion a counter fails, and it
	// is deliberately not "the codes differ" or "no shared prefix": a
	// little-endian counter varies its LEADING bytes fastest, so 256 counter
	// codes have 256 distinct values and 256 distinct 4-character prefixes.
	// What a counter cannot do is vary byte 14.
	//
	// With crypto/rand, 256 draws from 256 values give ~162 distinct on
	// average; the floor below is a quarter of that, and a frozen position
	// scores 1.
	for i := 0; i < wantBytes; i++ {
		seen := map[byte]bool{}
		for _, raw := range decoded {
			seen[raw[i]] = true
		}
		if len(seen) < 64 {
			t.Fatalf("byte %d of the code took only %d distinct values across %d mints: that "+
				"byte is not random, so the code is far short of %d bits",
				i, len(seen), sample, wantBits)
		}
	}
	// The same measurement on the encoded form, which is what a low-entropy
	// ALPHABET would show up in: 32 symbols per position, ~32 expected.
	for i := 0; i < wantChars; i++ {
		seen := map[byte]bool{}
		for _, code := range codes {
			seen[code[i]] = true
		}
		if len(seen) < 16 {
			t.Fatalf("character %d took only %d distinct values across %d mints; the alphabet "+
				"at that position is %d symbols wide, not 32", i, len(seen), sample, len(seen))
		}
	}

	// --- No code is close to any other. Sequential minting is exactly this
	// failure: consecutive counter values share 13 or 14 of their 15 bytes.
	//
	// For crypto/rand the chance that a given pair agrees in 7 or more of 15
	// byte positions is C(15,7)·256⁻⁷ ≈ 9e-14; across the 32,640 pairs here
	// that is ~3e-9, so this is a bound, not a flake.
	const maxShared = 6
	for i := 0; i < len(decoded); i++ {
		for j := i + 1; j < len(decoded); j++ {
			shared := 0
			for k := 0; k < wantBytes; k++ {
				if decoded[i][k] == decoded[j][k] {
					shared++
				}
			}
			if shared > maxShared {
				t.Fatalf("codes %d and %d share %d of %d bytes (%q vs %q): these codes are "+
					"related to each other, which is what a counter or a seeded PRNG looks like",
					i, j, shared, wantBytes, codes[i], codes[j])
			}
		}
	}

	// --- And, as a corollary rather than the headline, they are all distinct.
	seen := map[string]bool{}
	for _, code := range codes {
		if seen[code] {
			t.Fatalf("minted %q twice in %d mints", code, sample)
		}
		seen[code] = true
	}
}
