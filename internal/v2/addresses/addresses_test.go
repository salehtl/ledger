package addresses

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

const testSuffix = "@in.example.test"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{
		IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// newAddresses builds an Addresses on a µs-truncated frozen clock. Postgres
// stores timestamptz at microsecond precision, so a clock carrying nanoseconds
// makes "exactly at the deadline" unrepresentable in the database and turns the
// grace-boundary assertions below into sub-microsecond coin flips.
func newAddresses(t *testing.T, pool *pgxpool.Pool) (*Addresses, *time.Time) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	a := &Addresses{
		Pool:   pool,
		Suffix: testSuffix,
		Grace:  DefaultGrace,
		Now:    func() time.Time { return now },
	}
	return a, &now
}

type countingReader struct {
	R io.Reader
	N int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.R.Read(p)
	c.N += n
	return n, err
}

// ---------------------------------------------------------------------------
// Token entropy: the source and the encoding
// ---------------------------------------------------------------------------

func TestTokenIsSixteenCryptoRandomBytesInBase32(t *testing.T) {
	// The point of spec §3.2:46 is >=128 bits of entropy. A test that only
	// checks len(tok)==26 and "no collisions in 1000 draws" passes for a
	// generator with a 20-character constant prefix and 6 random characters, so
	// this tests the SOURCE and the ENCODING instead.
	var known [16]byte
	for i := range known {
		known[i] = byte(i)
	}
	tok, err := NewTokenFrom(bytes.NewReader(known[:]))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(known[:]))
	if tok != want {
		t.Fatalf("encoding drift: got %q want %q", tok, want)
	}
	if len(tok) != TokenChars {
		t.Fatalf("want %d chars, got %d", TokenChars, len(tok))
	}

	// Exactly 16 bytes are consumed — not 8 padded, not 32 truncated.
	r := &countingReader{R: rand.Reader}
	if _, err := NewTokenFrom(r); err != nil {
		t.Fatal(err)
	}
	if r.N != TokenBytes {
		t.Fatalf("read %d bytes from the entropy source, want %d", r.N, TokenBytes)
	}

	// A short read is an error, never a short token.
	if _, err := NewTokenFrom(bytes.NewReader(known[:8])); err == nil {
		t.Fatal("a truncated entropy source must be an error")
	}

	// One flipped input bit changes the token (the encoding is injective).
	flipped := known
	flipped[15] ^= 1
	other, err := NewTokenFrom(bytes.NewReader(flipped[:]))
	if err != nil {
		t.Fatal(err)
	}
	if other == tok {
		t.Fatal("encoding is not injective")
	}

	// Every character is in the lower-case RFC 4648 base32 alphabet, which is
	// what the local_part CHECK constraint in the migration pins.
	for _, c := range tok {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyz234567", c) {
			t.Fatalf("token %q contains %q, outside the lower-case base32 alphabet", tok, c)
		}
	}
}

// TestNewTokenDrawsFromCryptoRand closes the one hole the byte-level test above
// cannot reach. NewTokenFrom is injectable and therefore fully testable, but
// NewToken — the function every production path actually calls — picks its own
// reader, and nothing observable at runtime distinguishes crypto/rand from a
// seeded math/rand. So the source is asserted against the SOURCE CODE: the
// package must import crypto/rand, must import no math/rand, and NewToken must
// be a straight delegation to NewTokenFrom(rand.Reader).
//
// The regression this exists for is concrete: "make the token generator
// deterministic so the tests are stable" is a plausible-sounding change that
// silently drops the address space from 2^128 to the seed's width, and no
// output-distribution test would notice.
func TestNewTokenDrawsFromCryptoRand(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	var (
		cryptoRandName string
		newToken       *ast.FuncDecl
		newTokenFile   *ast.File
	)
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			for _, imp := range file.Imports {
				path := strings.Trim(imp.Path.Value, `"`)
				if path == "math/rand" || strings.HasPrefix(path, "math/rand/") {
					t.Fatalf("%s imports %q: the inbound-address token is a >=128-bit "+
						"security parameter and must come from crypto/rand", name, path)
				}
			}
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if ok && fn.Recv == nil && fn.Name.Name == "NewToken" {
					newToken, newTokenFile = fn, file
				}
			}
		}
	}
	if newToken == nil {
		t.Fatal("no NewToken function found in the package source")
	}
	for _, imp := range newTokenFile.Imports {
		if strings.Trim(imp.Path.Value, `"`) != "crypto/rand" {
			continue
		}
		cryptoRandName = "rand"
		if imp.Name != nil {
			cryptoRandName = imp.Name.Name
		}
	}
	if cryptoRandName == "" {
		t.Fatal("the file declaring NewToken does not import crypto/rand")
	}
	var body strings.Builder
	if err := printer.Fprint(&body, fset, newToken.Body); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("NewTokenFrom(%s.Reader)", cryptoRandName)
	if !strings.Contains(body.String(), want) {
		t.Fatalf("NewToken must delegate to %s; body is:\n%s", want, body.String())
	}
}

func TestNewTokenProducesDistinctWellFormedTokens(t *testing.T) {
	// Weak on its own — see TestTokenIsSixteenCryptoRandomBytesInBase32 for why
	// a uniqueness sweep proves almost nothing about entropy. It is kept as a
	// smoke test that NewToken is wired up at all.
	seen := make(map[string]bool, 512)
	for i := 0; i < 512; i++ {
		tok, err := NewToken()
		if err != nil {
			t.Fatal(err)
		}
		if len(tok) != TokenChars {
			t.Fatalf("token %q is %d chars, want %d", tok, len(tok), TokenChars)
		}
		if seen[tok] {
			t.Fatalf("NewToken repeated %q within %d draws", tok, i)
		}
		seen[tok] = true
	}
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

func TestIssueMintsAPrefixedLocalPart(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)

	local, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(local, LocalPartPrefix) {
		t.Fatalf("local part %q does not start with %q", local, LocalPartPrefix)
	}
	if len(local) != len(LocalPartPrefix)+TokenChars {
		t.Fatalf("local part %q is %d chars", local, len(local))
	}
	if got := a.Address(local); got != local+testSuffix {
		t.Fatalf("Address(%q) = %q", local, got)
	}
	got, grace, err := a.Resolve(bg, local+testSuffix)
	if err != nil {
		t.Fatal(err)
	}
	if got != u {
		t.Fatalf("resolved to %s, want %s", got, u)
	}
	if grace {
		t.Fatal("a freshly issued address must not be reported as in-grace")
	}
}

func TestOnlyOneActiveAddressPerUser(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)

	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	_, err := a.Issue(bg, u)
	if !errors.Is(err, ErrActiveAddressExists) {
		t.Fatalf("second Issue: got %v, want ErrActiveAddressExists", err)
	}
}

// TestTheDatabaseRefusesTwoActiveAddresses proves the invariant is held by the
// partial unique index and not merely by the Go code above it: a repair script,
// a future code path, or a bug that skips Issue must still be unable to leave a
// user with two live mail slots.
func TestTheDatabaseRefusesTwoActiveAddresses(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	const ins = `INSERT INTO inbound_addresses (local_part, user_id, created_at) VALUES ($1,$2,now())`
	if _, err := pool.Exec(bg, ins, "u-aaaaaaaaaaaaaaaaaaaaaaaaaa", u); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(bg, ins, "u-bbbbbbbbbbbbbbbbbbbbbbbbbb", u)
	if err == nil {
		t.Fatal("the database accepted a second active address for one user")
	}
	if !strings.Contains(err.Error(), "inbound_addresses_one_active") {
		t.Fatalf("expected the partial unique index to refuse it, got: %v", err)
	}
}

// TestTheDatabaseRefusesAMalformedLocalPart pins the address shape at the
// database, where nothing can route around it. The local part is what an
// attacker-controlled RCPT TO is matched against, so a row whose local part is
// not `u-<26 base32 chars>` would be an address this system can never have
// issued and must never be able to store.
func TestTheDatabaseRefusesAMalformedLocalPart(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	for _, bad := range []string{
		"aaaaaaaaaaaaaaaaaaaaaaaaaa",           // no prefix
		"u-AAAAAAAAAAAAAAAAAAAAAAAAAA",         // upper case
		"u-aaaaaaaaaaaaaaaaaaaaaaaaa",          // 25 chars
		"u-aaaaaaaaaaaaaaaaaaaaaaaaaaa",        // 27 chars
		"u-aaaaaaaa1aaaaaaaaaaaaaaaaa",         // '1' is not in base32
		"u-aaaaaaaaaaaaaaaaaaaaaaaa@x",         // an address, not a local part
		"u-aaaaaaaaaaaaaaaaaaaaaaaaaa postfix", // trailing junk
	} {
		_, err := pool.Exec(bg,
			`INSERT INTO inbound_addresses (local_part, user_id, created_at) VALUES ($1,$2,now())`,
			bad, u)
		if err == nil {
			t.Fatalf("the database accepted the malformed local part %q", bad)
		}
	}
}

func TestDeletingAUserRemovesTheirAddresses(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Rotate(bg, u); err != nil {
		t.Fatal(err)
	}
	// Two rows now, linked by rotated_from — the self-reference must not block
	// the account-deletion cascade (spec §3.10).
	if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatalf("deleting the user left addresses behind: %v", err)
	}
	var n int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM inbound_addresses WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d addresses survived the user", n)
	}
}

// ---------------------------------------------------------------------------
// Rotation and the grace window
// ---------------------------------------------------------------------------

func TestRotationKeepsTheOldAddressForSevenDays(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)

	old, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	fresh, until, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if fresh == old {
		t.Fatal("rotation must mint a new token")
	}
	if want := now.Add(DefaultGrace); !until.Equal(want) {
		t.Fatalf("grace deadline %s, want %s (7 days, spec §3.2)", until, want)
	}
	if got, grace, err := a.Resolve(bg, old+testSuffix); err != nil || got != u {
		t.Fatalf("old address must still resolve during grace: %v", err)
	} else if !grace {
		t.Fatal("the old address must be reported as in-grace, so the trust lane can honour its allowlist")
	}
	if got, grace, err := a.Resolve(bg, fresh+testSuffix); err != nil || got != u {
		t.Fatalf("new address must resolve: %v", err)
	} else if grace {
		t.Fatal("the new address is not in grace")
	}

	*now = until.Add(time.Second)
	if _, _, err := a.Resolve(bg, old+testSuffix); err == nil {
		t.Fatal("old address must stop resolving after the grace window")
	}
	if _, _, err := a.Resolve(bg, fresh+testSuffix); err != nil {
		t.Fatalf("the new address must keep resolving forever: %v", err)
	}
}

// TestTheGraceWindowBoundaryIsExact walks the deadline instant by instant. An
// off-by-one here is not cosmetic: one microsecond early silently drops bank
// mail the user was promised would still arrive, and "expires_at is checked
// with >= instead of >" is exactly the kind of edit that passes a test which
// only samples "well inside" and "well outside".
func TestTheGraceWindowBoundaryIsExact(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)

	old, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	cutover := *now
	_, until, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name  string
		at    time.Time
		grace bool // resolves, in grace
	}{
		{"at the cutover instant", cutover, true},
		{"one microsecond after the cutover", cutover.Add(time.Microsecond), true},
		{"one day in", cutover.Add(24 * time.Hour), true},
		{"one microsecond before the deadline", until.Add(-time.Microsecond), true},
		{"exactly at the deadline", until, false},
		{"one microsecond past the deadline", until.Add(time.Microsecond), false},
		{"a year past the deadline", until.Add(365 * 24 * time.Hour), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			*now = tc.at
			got, grace, err := a.Resolve(bg, old+testSuffix)
			if !tc.grace {
				if !errors.Is(err, ErrUnknownRecipient) {
					t.Fatalf("want ErrUnknownRecipient at %s, got (%s, %v, %v)", tc.at, got, grace, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("want the old address to resolve at %s: %v", tc.at, err)
			}
			if got != u {
				t.Fatalf("resolved to %s, want %s", got, u)
			}
			if !grace {
				t.Fatal("want isGrace=true for a rotated address inside its window")
			}
		})
	}
}

// TestTheCountdownAndTheReceiverAgreeOnTheDeadline walks the SAME boundary
// through the app-facing path. Resolve (the SMTP side) and Predecessor (which
// drives the "your old address stops working on X" countdown) must switch over
// at the identical instant: a UI that still shows an address as live after the
// receiver has begun rejecting mail to it tells the user their bank forward is
// fine while it is silently dropping messages.
//
// This exists because mutation testing found the two had separate copies of the
// comparison, and flipping one of them passed the entire suite.
func TestTheCountdownAndTheReceiverAgreeOnTheDeadline(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)
	old, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	_, until, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	cur, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	for _, at := range []time.Time{
		until.Add(-time.Hour),
		until.Add(-time.Microsecond),
		until,
		until.Add(time.Microsecond),
		until.Add(time.Hour),
	} {
		*now = at
		_, _, resolveErr := a.Resolve(bg, old+testSuffix)
		receiverAccepts := resolveErr == nil
		if resolveErr != nil && !errors.Is(resolveErr, ErrUnknownRecipient) {
			t.Fatalf("at %s: %v", at, resolveErr)
		}
		prev, uiShowsLive, err := a.Predecessor(bg, cur)
		if err != nil {
			t.Fatalf("at %s: %v", at, err)
		}
		if prev.LocalPart != old && uiShowsLive {
			t.Fatalf("at %s: the countdown names %q, not the retired address %q", at, prev.LocalPart, old)
		}
		if receiverAccepts != uiShowsLive {
			t.Fatalf("at %s: the receiver accepts=%v but the countdown shows live=%v",
				at, receiverAccepts, uiShowsLive)
		}
	}
}

// TestRotationRecordsTheCutoverForTheTrustLane pins the schema half of spec
// §3.2's promise that "during the grace, mail from origins that were
// allowlisted on the old address retains trusted status". The trust lane lands
// in a later task; what must exist NOW is the linkage it will read — which
// address superseded which, and exactly when the cutover happened — because
// retrofitting a predecessor pointer onto rows already written is not possible.
func TestRotationRecordsTheCutoverForTheTrustLane(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)

	old, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	cutover := now.Add(time.Hour)
	*now = cutover
	fresh, until, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	cur, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if cur.LocalPart != fresh {
		t.Fatalf("Current() = %q, want the new address %q", cur.LocalPart, fresh)
	}
	if cur.RotatedFrom != old {
		t.Fatalf("the active address records RotatedFrom %q, want %q", cur.RotatedFrom, old)
	}
	if !cur.ExpiresAt.IsZero() {
		t.Fatalf("the active address must not carry an expiry, got %s", cur.ExpiresAt)
	}

	prev, err := a.Lookup(bg, old)
	if err != nil {
		t.Fatal(err)
	}
	if !prev.RotatedAt.Equal(cutover) {
		t.Fatalf("predecessor RotatedAt = %s, want the cutover %s", prev.RotatedAt, cutover)
	}
	if !prev.ExpiresAt.Equal(until) {
		t.Fatalf("predecessor ExpiresAt = %s, want %s", prev.ExpiresAt, until)
	}
	if prev.UserID != u {
		t.Fatalf("predecessor belongs to %s, want %s", prev.UserID, u)
	}
}

func TestRotateWithoutAnActiveAddressIsRefused(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, _, err := a.Rotate(bg, u); !errors.Is(err, ErrNoActiveAddress) {
		t.Fatalf("got %v, want ErrNoActiveAddress", err)
	}
}

func TestRepeatedRotationChainsWithoutClobberingEarlierGrace(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)

	first, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	second, firstUntil, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Hour)
	third, secondUntil, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if !secondUntil.After(firstUntil) {
		t.Fatal("the second rotation must start its own grace window")
	}
	// All three still route to the user: the first is still inside its own,
	// earlier window. A rotation must not shorten or extend a window already
	// running for a different address.
	for _, local := range []string{first, second, third} {
		if got, _, err := a.Resolve(bg, local+testSuffix); err != nil || got != u {
			t.Fatalf("%q should still resolve: %v", local, err)
		}
	}
	// Past the FIRST deadline only the later two survive.
	*now = firstUntil
	if _, _, err := a.Resolve(bg, first+testSuffix); !errors.Is(err, ErrUnknownRecipient) {
		t.Fatalf("first address should have lapsed: %v", err)
	}
	if _, _, err := a.Resolve(bg, second+testSuffix); err != nil {
		t.Fatalf("second address is still inside its own window: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Resolve: what it refuses, and how it refuses it
// ---------------------------------------------------------------------------

func TestResolveRejectsAnAddressOutsideOurDomain(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	local, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	for _, rcpt := range []string{
		local + "@evil.test",
		local + "@in.example.test.evil.test", // suffix-extension
		local + "@example.test",              // the parent domain, not the mail subdomain
		local + "@in.example.tes",
		local + "@@in.example.test",
		local, // no domain at all
		local + "+tag" + testSuffix,
		local + ".x" + testSuffix,
		"x" + local + testSuffix,
	} {
		if _, _, err := a.Resolve(bg, rcpt); !errors.Is(err, ErrUnknownRecipient) {
			t.Fatalf("Resolve(%q) = %v, want ErrUnknownRecipient", rcpt, err)
		}
	}
}

func TestResolveAcceptsTheAddressAsSMTPMayPresentIt(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	local, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	// A forwarder or a bank may upper-case any of it, and the SMTP layer may
	// hand the path over still wrapped in angle brackets or padded. None of
	// those is a different mailbox, and treating them as one loses real mail.
	for _, rcpt := range []string{
		local + testSuffix,
		strings.ToUpper(local + testSuffix),
		local + strings.ToUpper(testSuffix),
		"<" + local + testSuffix + ">",
		"  " + local + testSuffix + "  ",
	} {
		got, _, err := a.Resolve(bg, rcpt)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", rcpt, err)
		}
		if got != u {
			t.Fatalf("Resolve(%q) = %s, want %s", rcpt, got, u)
		}
	}
}

// TestEveryRecipientRejectionIsTheSameError is the enumeration-oracle guard at
// this layer. Task 24's receiver turns any error from Resolve into one SMTP
// rejection, but it can only do that safely if Resolve does not hand it
// distinguishable errors in the first place: a caller that switched on
// "expired" versus "no such address" would rebuild the oracle one level up.
func TestEveryRecipientRejectionIsTheSameError(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)
	lapsed, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	_, until, err := a.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	*now = until.Add(time.Hour)

	cases := map[string]string{
		"never existed":     "u-zzzzzzzzzzzzzzzzzzzzzzzzzz" + testSuffix,
		"lapsed grace":      lapsed + testSuffix,
		"wrong domain":      lapsed + "@evil.test",
		"malformed local":   "u-not-a-token" + testSuffix,
		"empty":             "",
		"suffix only":       testSuffix,
		"no local part":     "@in.example.test",
		"plus tag":          lapsed + "+tag" + testSuffix,
		"another user's??":  "u-aaaaaaaaaaaaaaaaaaaaaaaaaa" + testSuffix,
		"sql-ish":           "u-' OR 1=1 --" + testSuffix,
		"unicode homoglyph": "u-аaaaaaaaaaaaaaaaaaaaaaaaaa" + testSuffix,
	}
	var texts []string
	for name, rcpt := range cases {
		_, _, err := a.Resolve(bg, rcpt)
		if !errors.Is(err, ErrUnknownRecipient) {
			t.Fatalf("%s: Resolve(%q) = %v, want ErrUnknownRecipient", name, rcpt, err)
		}
		texts = append(texts, err.Error())
	}
	for i, got := range texts {
		if got != texts[0] {
			t.Fatalf("rejection %d reads %q but the first reads %q: a caller can tell them apart",
				i, got, texts[0])
		}
	}
	if strings.Contains(texts[0], "expire") || strings.Contains(texts[0], "grace") {
		t.Fatalf("the rejection text describes the reason: %q", texts[0])
	}
}

// TestResolveDoesTheSameDatabaseWorkForKnownAndUnknownRecipients is the
// structural half of the "a lookup must not be an oracle" requirement.
//
// Wall-clock timing tests are flaky and prove little on a shared box, so the
// property asserted here is the one that ACTUALLY drives the timing difference
// an attacker could measure: both paths must issue the same queries, in the
// same number, with byte-identical SQL. An implementation that (say) probed a
// second table only after a hit, or short-circuited before the query on a miss,
// would be visible here immediately and invisible to an error-shape test.
//
// The pool is warmed before counting: pgxpool connects lazily, so an unwarmed
// first call would attribute connection setup to whichever path ran first.
func TestResolveDoesTheSameDatabaseWorkForKnownAndUnknownRecipients(t *testing.T) {
	pool := pgtest.New(t)
	base, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	known, err := base.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	tracer := &recordingTracer{}
	cfg, err := pgxpool.ParseConfig(pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	cfg.MinConns, cfg.MaxConns = 1, 1
	cfg.ConnConfig.Tracer = tracer
	traced, err := pgxpool.NewWithConfig(bg, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer traced.Close()

	a := &Addresses{Pool: traced, Suffix: testSuffix, Grace: DefaultGrace, Now: base.Now}

	// Warm: establish the connection and let pgx populate its statement cache
	// for this SQL, so neither measured run pays a one-off cost.
	for i := 0; i < 3; i++ {
		_, _, _ = a.Resolve(bg, known+testSuffix)
		_, _, _ = a.Resolve(bg, "u-zzzzzzzzzzzzzzzzzzzzzzzzzz"+testSuffix)
	}

	tracer.reset()
	if _, _, err := a.Resolve(bg, known+testSuffix); err != nil {
		t.Fatal(err)
	}
	hit := tracer.take()

	tracer.reset()
	if _, _, err := a.Resolve(bg, "u-zzzzzzzzzzzzzzzzzzzzzzzzzz"+testSuffix); !errors.Is(err, ErrUnknownRecipient) {
		t.Fatalf("want ErrUnknownRecipient, got %v", err)
	}
	miss := tracer.take()

	if len(hit) != 1 {
		t.Fatalf("a resolve should be exactly one query, got %d: %q", len(hit), hit)
	}
	if len(miss) != len(hit) {
		t.Fatalf("known recipient issued %d queries, unknown issued %d: %q vs %q",
			len(hit), len(miss), hit, miss)
	}
	for i := range hit {
		if hit[i] != miss[i] {
			t.Fatalf("query %d differs between hit and miss:\n hit: %q\nmiss: %q", i, hit[i], miss[i])
		}
	}
}

type recordingTracer struct {
	mu   sync.Mutex
	sqls []string
}

func (r *recordingTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	r.mu.Lock()
	r.sqls = append(r.sqls, d.SQL)
	r.mu.Unlock()
	return ctx
}

func (r *recordingTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (r *recordingTracer) reset() {
	r.mu.Lock()
	r.sqls = nil
	r.mu.Unlock()
}

func (r *recordingTracer) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := append([]string(nil), r.sqls...)
	return out
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

func TestConcurrentIssueNeverRepeatsATokenOrDoublesUpAUser(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)

	const users = 24
	ids := make([]uuid.UUID, users)
	for i := range ids {
		ids[i] = insertUser(t, pool)
	}
	// Warm the pool: pgxpool connects lazily, so without this the goroutines
	// below spend their first moments serialised on connection setup and the
	// concurrency this test exists to create never actually happens.
	warm(t, pool)

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		local = make([]string, 0, users)
		errs  []error
	)
	start := make(chan struct{})
	for _, id := range ids {
		wg.Add(1)
		go func(id uuid.UUID) {
			defer wg.Done()
			<-start
			l, err := a.Issue(bg, id)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			local = append(local, l)
		}(id)
	}
	close(start)
	wg.Wait()

	if len(errs) > 0 {
		t.Fatalf("concurrent Issue for distinct users must all succeed: %v", errs)
	}
	seen := map[string]bool{}
	for _, l := range local {
		if seen[l] {
			t.Fatalf("two users were issued the same local part %q", l)
		}
		seen[l] = true
	}
	if len(seen) != users {
		t.Fatalf("got %d distinct addresses for %d users", len(seen), users)
	}
}

// TestConcurrentIssueForOneUserYieldsExactlyOneAddress is the race the partial
// unique index exists for: two devices hitting GET /api/v1/address at the same
// moment on a brand-new account.
func TestConcurrentIssueForOneUserYieldsExactlyOneAddress(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	warm(t, pool)

	const n = 12
	var (
		wg sync.WaitGroup
		mu sync.Mutex
		ok int
	)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := a.Issue(bg, u)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrActiveAddressExists):
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if ok != 1 {
		t.Fatalf("%d concurrent Issue calls succeeded, want exactly 1", ok)
	}
	if got := countActive(t, pool, u); got != 1 {
		t.Fatalf("%d active addresses, want 1", got)
	}
}

// TestEnsureIsIdempotentUnderConcurrency covers the path the HTTP GET actually
// takes: Ensure must converge on ONE address rather than returning an error to
// whichever device lost the race.
func TestEnsureIsIdempotentUnderConcurrency(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	warm(t, pool)

	const n = 12
	var (
		wg  sync.WaitGroup
		mu  sync.Mutex
		got = map[string]int{}
	)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			addr, err := a.Ensure(bg, u)
			if err != nil {
				t.Errorf("Ensure: %v", err)
				return
			}
			mu.Lock()
			got[addr.LocalPart]++
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()

	if len(got) != 1 {
		t.Fatalf("Ensure returned %d distinct addresses: %v", len(got), got)
	}
	if n := countActive(t, pool, u); n != 1 {
		t.Fatalf("%d active addresses, want 1", n)
	}
}

// TestConcurrentRotationNeverLeavesTheUserWithoutAnAddress is the atomicity
// assertion a reader can actually observe. Under READ COMMITTED every statement
// takes a fresh snapshot, so an implementation that expired the old row and
// then inserted the new one in two separate autocommitted statements would let
// this observer catch the gap — and a message arriving in that window would be
// rejected at RCPT with no address to route it to.
func TestConcurrentRotationNeverLeavesTheUserWithoutAnAddress(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	warm(t, pool)

	const rotations = 16
	done := make(chan struct{})
	observed := make(chan int, 1)
	go func() {
		worst := 1
		for {
			select {
			case <-done:
				observed <- worst
				return
			default:
			}
			if n := countActiveNoFatal(pool, u); n != 1 {
				worst = n
			}
		}
	}()

	var wg sync.WaitGroup
	var mu sync.Mutex
	var errs []error
	for i := 0; i < rotations; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := a.Rotate(bg, u); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	close(done)

	if len(errs) > 0 {
		t.Fatalf("concurrent rotations failed: %v", errs)
	}
	if worst := <-observed; worst != 1 {
		t.Fatalf("an observer saw %d active addresses mid-rotation; the cutover is not atomic", worst)
	}
	if n := countActive(t, pool, u); n != 1 {
		t.Fatalf("%d active addresses after %d rotations, want 1", n, rotations)
	}
	var total int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM inbound_addresses WHERE user_id = $1`, u).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != rotations+1 {
		t.Fatalf("%d addresses recorded, want %d (one issued + one per rotation)", total, rotations+1)
	}
}

// TestAFailedRotationLeavesTheOldAddressActive is the deterministic half of the
// atomicity claim: the observer test above can only catch a gap it happens to
// sample, this one forces the failure. The token source is poisoned so the
// INSERT of the replacement cannot succeed; the old address must come out of it
// untouched — still active, still resolving — rather than expired with nothing
// to take its place.
func TestAFailedRotationLeavesTheOldAddressActive(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)
	old, err := a.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	// Every attempt mints a local part that is already taken, so the insert
	// fails on the primary key however many times Rotate retries.
	other := insertUser(t, pool)
	taken, err := a.Issue(bg, other)
	if err != nil {
		t.Fatal(err)
	}
	a.NewToken = func() (string, error) { return strings.TrimPrefix(taken, LocalPartPrefix), nil }

	if _, _, err := a.Rotate(bg, u); err == nil {
		t.Fatal("rotation should have failed on a colliding local part")
	}

	if n := countActive(t, pool, u); n != 1 {
		t.Fatalf("%d active addresses after a failed rotation, want 1", n)
	}
	cur, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if cur.LocalPart != old {
		t.Fatalf("active address is %q, want the original %q", cur.LocalPart, old)
	}
	*now = now.Add(DefaultGrace + time.Hour)
	if got, grace, err := a.Resolve(bg, old+testSuffix); err != nil || got != u || grace {
		t.Fatalf("the original address must still be active, not in a grace window: (%s,%v,%v)", got, grace, err)
	}
}

// TestIssueSurvivesATransientTokenCollision documents the other side of the
// same retry: a collision is astronomically unlikely at 128 bits, but if one
// happens it is the server's problem to retry, never the user's to see.
func TestIssueSurvivesATransientTokenCollision(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	other := insertUser(t, pool)
	taken, err := a.Issue(bg, other)
	if err != nil {
		t.Fatal(err)
	}
	u := insertUser(t, pool)
	var calls int
	a.NewToken = func() (string, error) {
		calls++
		if calls == 1 {
			return strings.TrimPrefix(taken, LocalPartPrefix), nil
		}
		return NewToken()
	}
	local, err := a.Issue(bg, u)
	if err != nil {
		t.Fatalf("Issue should have retried past the collision: %v", err)
	}
	if local == taken {
		t.Fatal("Issue handed out an address that already belonged to another user")
	}
	if calls < 2 {
		t.Fatalf("the token source was called %d times; the collision was not retried", calls)
	}
}

func warm(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var one int
			_ = pool.QueryRow(bg, `SELECT 1`).Scan(&one)
		}()
	}
	wg.Wait()
}

func countActive(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM inbound_addresses WHERE user_id = $1 AND expires_at IS NULL`,
		u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func countActiveNoFatal(pool *pgxpool.Pool, u uuid.UUID) int {
	var n int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM inbound_addresses WHERE user_id = $1 AND expires_at IS NULL`,
		u).Scan(&n); err != nil {
		return 1 // a query error is not evidence about atomicity
	}
	return n
}

// ---------------------------------------------------------------------------
// Rotation authorization: key possession, not a session
// ---------------------------------------------------------------------------

// enrollWriter registers a device writer through auth's real capability path,
// so the roster row this package reads is one the rest of the system would
// accept — a hand-planted row would not prove that.
//
// authorizer signs the enrollment. Passing none self-signs, which auth accepts
// exactly once per account (the TOFU bootstrap); every writer after the first
// must be authorized by an already-enrolled key.
func enrollWriter(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id string, authorizer ...ed25519.PrivateKey) ed25519.PrivateKey {
	t.Helper()
	w := &auth.Writers{Pool: pool}
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := w.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	signer := priv
	if len(authorizer) > 0 {
		signer = authorizer[0]
	}
	sig := ed25519.Sign(signer, auth.RegistrationMessage(nonce, id, pub))
	if err := w.Register(bg, u, id, pub, nonce, sig); err != nil {
		t.Fatal(err)
	}
	return priv
}

func TestRotateAuthorizedRequiresProofOfKeyPossession(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	priv := enrollWriter(t, pool, u, "phone")
	cur, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("a garbage signature is refused", func(t *testing.T) {
		nonce, err := a.RotationChallenge(bg, u)
		if err != nil {
			t.Fatal(err)
		}
		sig := make([]byte, ed25519.SignatureSize)
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sig); !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("got %v, want ErrNotAuthorized", err)
		}
	})

	t.Run("an unenrolled key is refused", func(t *testing.T) {
		nonce, err := a.RotationChallenge(bg, u)
		if err != nil {
			t.Fatal(err)
		}
		_, stranger, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		sig := ed25519.Sign(stranger, RotationMessage(nonce, u, cur.LocalPart))
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sig); !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("got %v, want ErrNotAuthorized", err)
		}
	})

	t.Run("an enrolled key rotates", func(t *testing.T) {
		nonce, err := a.RotationChallenge(bg, u)
		if err != nil {
			t.Fatal(err)
		}
		sig := ed25519.Sign(priv, RotationMessage(nonce, u, cur.LocalPart))
		fresh, until, err := a.RotateAuthorized(bg, u, nonce, sig)
		if err != nil {
			t.Fatalf("a signature by an enrolled key must authorize a rotation: %v", err)
		}
		if fresh == cur.LocalPart || until.IsZero() {
			t.Fatalf("rotation did not take effect: %q %s", fresh, until)
		}
	})
}

func TestARotationChallengeIsSingleUseUserScopedAndExpiring(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	priv := enrollWriter(t, pool, u, "phone")

	sign := func(nonce []byte, user uuid.UUID, key ed25519.PrivateKey) []byte {
		cur, err := a.Current(bg, user)
		if err != nil {
			t.Fatal(err)
		}
		return ed25519.Sign(key, RotationMessage(nonce, user, cur.LocalPart))
	}

	t.Run("replay is refused", func(t *testing.T) {
		nonce, err := a.RotationChallenge(bg, u)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sign(nonce, u, priv)); err != nil {
			t.Fatal(err)
		}
		// The same nonce, freshly signed over the NEW current address, so the
		// only thing standing in the way is single use.
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sign(nonce, u, priv)); !errors.Is(err, ErrRotationRejected) {
			t.Fatalf("a spent challenge must not authorize a second rotation: %v", err)
		}
	})

	t.Run("a failed attempt still spends the challenge", func(t *testing.T) {
		nonce, err := a.RotationChallenge(bg, u)
		if err != nil {
			t.Fatal(err)
		}
		bad := make([]byte, ed25519.SignatureSize)
		if _, _, err := a.RotateAuthorized(bg, u, nonce, bad); !errors.Is(err, ErrNotAuthorized) {
			t.Fatal(err)
		}
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sign(nonce, u, priv)); !errors.Is(err, ErrRotationRejected) {
			t.Fatal("one challenge must buy exactly one attempt, not unlimited retries")
		}
	})

	t.Run("another account's challenge is worthless", func(t *testing.T) {
		v := insertUser(t, pool)
		if _, err := a.Issue(bg, v); err != nil {
			t.Fatal(err)
		}
		enrollWriter(t, pool, v, "phone")
		nonce, err := a.RotationChallenge(bg, v)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sign(nonce, u, priv)); !errors.Is(err, ErrRotationRejected) {
			t.Fatalf("a challenge minted for another user must not work here: %v", err)
		}
	})

	t.Run("an expired challenge is refused", func(t *testing.T) {
		nonce, err := a.RotationChallenge(bg, u)
		if err != nil {
			t.Fatal(err)
		}
		sig := sign(nonce, u, priv)
		*now = now.Add(ChallengeTTL + time.Second)
		if _, _, err := a.RotateAuthorized(bg, u, nonce, sig); !errors.Is(err, ErrRotationRejected) {
			t.Fatalf("an expired challenge must not authorize a rotation: %v", err)
		}
	})
}

// TestARotationSignatureAuthorizesExactlyOneCutover closes the gap between
// "the signed message names the address being retired" and "the transaction
// retires that address". Without pinning it, a rotation that lands between the
// signature check and the write would mean a signature made to retire address
// X silently retired address Y instead — the binding in RotationMessage would
// read as a defence and be none.
func TestARotationSignatureAuthorizesExactlyOneCutover(t *testing.T) {
	pool := pgtest.New(t)
	a, now := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	priv := enrollWriter(t, pool, u, "phone")

	authorized, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := a.RotationChallenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, RotationMessage(nonce, u, authorized.LocalPart))

	// The window this test is aimed at is INSIDE RotateAuthorized: between the
	// read of the current address (which the signature is checked against) and
	// the write that retires it. Rotating beforehand instead would prove
	// nothing, because RotateAuthorized re-reads the current address and the
	// signature check alone would then reject — the test would pass with the
	// pinning removed. So the interleaving is forced from the clock, which
	// RotateAuthorized calls after it has read the address and before it takes
	// the row lock to write.
	racer := &Addresses{Pool: pool, Suffix: testSuffix, Grace: DefaultGrace,
		Now: func() time.Time { return *now }}
	var fired bool
	a.Now = func() time.Time {
		if !fired {
			fired = true
			if _, _, err := racer.Rotate(bg, u); err != nil {
				t.Errorf("racing rotation: %v", err)
			}
		}
		return *now
	}

	_, _, err = a.RotateAuthorized(bg, u, nonce, sig)
	if !fired {
		t.Fatal("the racing rotation never ran; this test proves nothing")
	}
	if !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a signature naming %q must not retire whatever happens to be active: %v",
			authorized.LocalPart, err)
	}
	// The address the racer installed is untouched: the stale signature bought
	// nothing at all.
	after, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if after.LocalPart == authorized.LocalPart {
		t.Fatal("the racing rotation did not take effect; the window was never opened")
	}
	if !after.Active() || after.RotatedFrom != authorized.LocalPart {
		t.Fatalf("expected the racer's address to still be active, got %+v", after)
	}
}

func TestARevokedKeyCannotAuthorizeARotation(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	keep := enrollWriter(t, pool, u, "keep")
	gone := enrollWriter(t, pool, u, "gone", keep)

	w := &auth.Writers{Pool: pool}
	nonce, err := w.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Revoke(bg, u, "gone", nonce, ed25519.Sign(keep, auth.RevocationMessage(nonce, "gone"))); err != nil {
		t.Fatal(err)
	}

	cur, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	rn, err := a.RotationChallenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(gone, RotationMessage(rn, u, cur.LocalPart))
	if _, _, err := a.RotateAuthorized(bg, u, rn, sig); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a revoked device must not be able to rotate the mail slot: %v", err)
	}
}

// TestTheRotationMessageIsDomainSeparated stops a signature collected in one
// context from being spendable in another. Without a distinct prefix, a
// "retire this device" or "enroll this writer" signature over the same nonce
// would also authorize giving the account a new mail slot.
func TestTheRotationMessageIsDomainSeparated(t *testing.T) {
	nonce := bytes.Repeat([]byte{7}, ChallengeNonceBytes)
	u := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	local := "u-aaaaaaaaaaaaaaaaaaaaaaaaaa"
	msg := RotationMessage(nonce, u, local)

	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, other := range map[string][]byte{
		"writer registration": auth.RegistrationMessage(nonce, local, pub),
		"writer revocation":   auth.RevocationMessage(nonce, local),
	} {
		if bytes.Equal(msg, other) {
			t.Fatalf("the rotation message is identical to the %s message", name)
		}
		if bytes.HasPrefix(msg, other[:16]) {
			t.Fatalf("the rotation message shares a domain prefix with the %s message", name)
		}
	}
	if !bytes.HasPrefix(msg, []byte(rotationDomain)) {
		t.Fatal("the rotation message must carry its own domain prefix")
	}
	// It binds the account and the address being retired, so a captured
	// signature cannot be re-aimed at a different cutover.
	if bytes.Equal(msg, RotationMessage(nonce, uuid.MustParse("00000000-0000-4000-8000-000000000002"), local)) {
		t.Fatal("the message does not bind the user id")
	}
	if bytes.Equal(msg, RotationMessage(nonce, u, "u-bbbbbbbbbbbbbbbbbbbbbbbbbb")) {
		t.Fatal("the message does not bind the address being rotated away from")
	}
}

// TestARotationChallengeIsNotAWriterChallenge keeps the two challenge stores
// separate. Sharing one table would mean a nonce minted for the far more
// freely available writer-registration flow could be spent as the second half
// of a rotation authorization.
func TestARotationChallengeIsNotAWriterChallenge(t *testing.T) {
	pool := pgtest.New(t)
	a, _ := newAddresses(t, pool)
	u := insertUser(t, pool)
	if _, err := a.Issue(bg, u); err != nil {
		t.Fatal(err)
	}
	priv := enrollWriter(t, pool, u, "phone")
	cur, err := a.Current(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	w := &auth.Writers{Pool: pool}
	nonce, err := w.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, RotationMessage(nonce, u, cur.LocalPart))
	if _, _, err := a.RotateAuthorized(bg, u, nonce, sig); !errors.Is(err, ErrRotationRejected) {
		t.Fatalf("a writer challenge must not authorize an address rotation: %v", err)
	}

	// And the converse: a rotation nonce must not enroll a writer.
	rn, err := a.RotationChallenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	pub, other, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	rsig := ed25519.Sign(other, auth.RegistrationMessage(rn, "sneak", pub))
	if err := w.Register(bg, u, "sneak", pub, rn, rsig); !errors.Is(err, auth.ErrRegistrationRejected) {
		t.Fatalf("a rotation challenge must not enroll a writer: %v", err)
	}
}
