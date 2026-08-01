package quarantine

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/auth"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// newStore builds a Store on a frozen, µs-truncated clock. Postgres stores
// timestamptz at microsecond precision, so a clock carrying nanoseconds makes
// "exactly at the deadline" unrepresentable in the database and turns every
// boundary assertion below into a sub-microsecond coin flip.
func newStore(t *testing.T) (*Store, *time.Time, *pgxpool.Pool) {
	t.Helper()
	pool := pgtest.New(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	s := &Store{
		Pool:       pool,
		TTL:        DefaultTTL,
		WarnBefore: DefaultWarnBefore,
		Now:        func() time.Time { return now },
	}
	return s, &now, pool
}

func ingestID(seed string) []byte {
	sum := sha256.Sum256([]byte(seed))
	return sum[:]
}

// item is a plain, DKIM-verified arrival from a bank we do not yet trust.
func item(u uuid.UUID, at time.Time, seed string) Item {
	return Item{
		UserID:      u,
		IngestID:    ingestID(seed),
		ReceivedAt:  at,
		OuterDomain: "dib.ae",
		DKIM:        ResultPass,
		ARC:         ResultNone,
		Blob:        []byte("From: alerts@dib.ae\r\nSubject: alert\r\n\r\n" + seed),
	}
}

// forwarded is an arrival through the user's own mailbox whose inner origin the
// bank's own surviving signature attests.
func forwarded(u uuid.UUID, at time.Time, seed string) Item {
	it := item(u, at, seed)
	it.OuterDomain = "gmail.com"
	it.InnerDomain = "dib.ae"
	it.Attested = true
	it.AttestedBy = AttestedByDirectDKIM
	return it
}

func hold(t *testing.T, s *Store, it Item) Item {
	t.Helper()
	if err := s.Hold(bg, it); err != nil {
		t.Fatalf("hold: %v", err)
	}
	return it
}

func listAll(t *testing.T, s *Store, u uuid.UUID) []Item {
	t.Helper()
	items, err := s.List(bg, u, Cursor{}, 100, false)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return items
}

func countRows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// The table is outside the op log
// ---------------------------------------------------------------------------

func TestQuarantineHasNoChainColumns(t *testing.T) {
	_, _, pool := newStore(t)
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM information_schema.columns
	  WHERE table_name='quarantine' AND column_name IN ('seq','blob_hash','prev_hash','writer_counter')`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("quarantine must stay outside the op log and its chains")
	}
}

func TestHoldNeverWritesToTheOpLog(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))
	if n := countRows(t, pool, "op_log"); n != 0 {
		t.Fatalf("holding a message appended %d op(s); quarantined mail enters the chains only on confirmation", n)
	}
}

func TestHoldIsIdempotentForARedeliveredMessage(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := item(u, *now, "a")
	hold(t, s, it)
	// An SMTP retry is normal traffic, not a second message.
	hold(t, s, it)
	if got := len(listAll(t, s, u)); got != 1 {
		t.Fatalf("a redelivered message is held %d times, want 1", got)
	}
}

func TestHoldRefusesAnInnerOriginWithNoAttestation(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := item(u, *now, "a")
	it.InnerDomain = "dib.ae" // claimed, with nothing behind it
	if err := s.Hold(bg, it); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("an unattested inner origin can only have come from body text; err = %v", err)
	}
}

// ---------------------------------------------------------------------------
// The drop policy (spec §2): nothing is dropped without a user-visible notice
// ---------------------------------------------------------------------------

func TestExpiryWarnsBeforeDeleting(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))

	// Day 23 of 30: inside the 7-day warning window, nothing due.
	*now = now.Add(23 * 24 * time.Hour)
	warned, deleted, err := s.ExpireDue(bg)
	if err != nil {
		t.Fatal(err)
	}
	if warned != 1 || deleted != 0 {
		t.Fatalf("day 23: warned=%d deleted=%d, want 1 and 0", warned, deleted)
	}
	items := listAll(t, s, u)
	if len(items) != 1 || items[0].WarnedAt == nil {
		t.Fatalf("the client must be able to see the warning: %+v", items)
	}

	// Day 31: warned a full window ago, so it goes.
	*now = now.Add(8 * 24 * time.Hour)
	warned, deleted, err = s.ExpireDue(bg)
	if err != nil {
		t.Fatal(err)
	}
	if warned != 0 || deleted != 1 {
		t.Fatalf("day 31: warned=%d deleted=%d, want 0 and 1", warned, deleted)
	}
	if got := len(listAll(t, s, u)); got != 0 {
		t.Fatalf("%d items survived expiry", got)
	}
}

func TestUnwarnedItemIsNeverDeleted(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	// Received 40 days ago: already past its TTL and never warned, because
	// nothing swept while it sat there.
	hold(t, s, item(u, now.Add(-40*24*time.Hour), "a"))

	warned, deleted, err := s.ExpireDue(bg)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 0 {
		t.Fatalf("deleted %d unwarned item(s): a client that has not synced in a month must not be pruned out from under", deleted)
	}
	if warned != 1 {
		t.Fatalf("warned=%d, want 1: an overdue item is warned, not dropped", warned)
	}
	if got := len(listAll(t, s, u)); got != 1 {
		t.Fatalf("%d items left, want 1", got)
	}
}

func TestALateWarningStillBuysTheFullWarningWindow(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, now.Add(-40*24*time.Hour), "a"))

	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 0 {
		t.Fatalf("first sweep: deleted=%d err=%v", deleted, err)
	}
	// One hour later the item is past expires_at AND warned — but the warning
	// has been visible for an hour, which is not the notice §2 promises.
	*now = now.Add(time.Hour)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 0 {
		t.Fatalf("an hour after a late warning: deleted=%d err=%v, want 0", deleted, err)
	}
	// A full warning window after the warning, it may go.
	*now = now.Add(DefaultWarnBefore)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 1 {
		t.Fatalf("a full window after a late warning: deleted=%d err=%v, want 1", deleted, err)
	}
}

func TestWarningBoundaryIsExactlyWarnBeforeExpiry(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	received := *now
	hold(t, s, item(u, received, "a"))

	// One microsecond before the window opens.
	*now = received.Add(DefaultTTL - DefaultWarnBefore - time.Microsecond)
	if warned, _, err := s.ExpireDue(bg); err != nil || warned != 0 {
		t.Fatalf("1µs early: warned=%d err=%v, want 0", warned, err)
	}
	// Exactly at it: inclusive.
	*now = now.Add(time.Microsecond)
	if warned, _, err := s.ExpireDue(bg); err != nil || warned != 1 {
		t.Fatalf("at the boundary: warned=%d err=%v, want 1", warned, err)
	}
}

func TestDeletionBoundaryIsExactlyTheExpiry(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	received := *now
	hold(t, s, item(u, received, "a"))

	// Warn on time, so deletion is governed by expires_at alone.
	*now = received.Add(DefaultTTL - DefaultWarnBefore)
	if warned, _, err := s.ExpireDue(bg); err != nil || warned != 1 {
		t.Fatalf("warn: warned=%d err=%v", warned, err)
	}
	*now = received.Add(DefaultTTL - time.Microsecond)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 0 {
		t.Fatalf("1µs early: deleted=%d err=%v, want 0", deleted, err)
	}
	*now = now.Add(time.Microsecond)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 1 {
		t.Fatalf("at the expiry: deleted=%d err=%v, want 1", deleted, err)
	}
}

func TestExpiryLeavesATraceTheUserCanRead(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := hold(t, s, item(u, *now, "a"))

	*now = now.Add(23 * 24 * time.Hour)
	if _, _, err := s.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(8 * 24 * time.Hour)
	if _, _, err := s.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}

	rem, err := s.Removals(bg, u, Cursor{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rem) != 1 {
		t.Fatalf("%d removal records, want 1: a deletion with no record is exactly the silent drop §2 forbids", len(rem))
	}
	switch {
	case rem[0].Reason != ReasonExpired:
		t.Fatalf("reason %q, want %q", rem[0].Reason, ReasonExpired)
	case string(rem[0].IngestID) != string(it.IngestID):
		t.Fatal("the record does not name the message that was removed")
	case rem[0].WarnedAt == nil:
		t.Fatal("an expiry record with no warning instant cannot prove the user was told")
	case rem[0].OuterDomain != "dib.ae":
		t.Fatalf("outer domain %q lost", rem[0].OuterDomain)
	}
}

func TestTheDatabaseRefusesAnUntracedRemovalWhenGoIsBypassed(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))

	_, err := pool.Exec(bg, `DELETE FROM quarantine WHERE user_id = $1`, u)
	if err == nil {
		t.Fatal("a bare DELETE removed quarantined mail with no record of it")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "quarantine_removals") {
		t.Fatalf("the refusal should name what is missing: %v", err)
	}
	if got := len(listAll(t, s, u)); got != 1 {
		t.Fatalf("%d items left after the refused delete, want 1", got)
	}
}

func TestTheDatabaseRefusesAnExpiryRecordWithNoWarning(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))

	_, err := pool.Exec(bg, `INSERT INTO quarantine_removals
	  (id, quarantine_id, user_id, ingest_id, received_at, expires_at, warned_at, removed_at,
	   reason, outer_domain, inner_domain, attested, size_bucket)
	  SELECT gen_random_uuid(), id, user_id, ingest_id, received_at, expires_at, NULL, $2,
	         'expired', outer_domain, inner_domain, attested, size_bucket
	    FROM quarantine WHERE user_id = $1`, u, *now)
	if err == nil {
		t.Fatal("an 'expired' removal record with no warned_at was accepted: the promise is that expiry is warned first")
	}
}

func TestAccountDeletionTakesQuarantineWithItWithoutTripping(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))
	hold(t, s, item(u, *now, "b"))

	// §3.10's purge is a legitimate removal with no per-message notice: the
	// account and everything in it is going, at the user's own request.
	if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatalf("account deletion must not be blocked by the drop-policy trigger: %v", err)
	}
	if n := countRows(t, pool, "quarantine"); n != 0 {
		t.Fatalf("%d quarantine rows survived account deletion", n)
	}
}

func TestPromotionLeavesATraceToo(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := hold(t, s, item(u, *now, "a"))

	n, err := s.Promote(bg, u, [][]byte{it.IngestID})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("promoted %d, want 1", n)
	}
	if got := len(listAll(t, s, u)); got != 0 {
		t.Fatalf("%d items still held after promotion", got)
	}
	rem, err := s.Removals(bg, u, Cursor{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rem) != 1 || rem[0].Reason != ReasonPromoted {
		t.Fatalf("promotion must be recorded as a removal with its own reason: %+v", rem)
	}
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

func TestConfirmReturnsEveryHeldIngestIDForThatOrigin(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	want := map[string]bool{}
	for _, seed := range []string{"a", "b", "c"} {
		it := hold(t, s, item(u, *now, seed))
		want[string(it.IngestID)] = true
	}
	// A message from a different bank must not come along.
	other := item(u, *now, "d")
	other.OuterDomain = "emiratesnbd.com"
	hold(t, s, other)

	ids, err := s.Confirm(bg, u, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 {
		t.Fatalf("confirm returned %d ingest ids, want 3", len(ids))
	}
	for _, id := range ids {
		if !want[string(id)] {
			t.Fatal("confirm returned an ingest id from another origin")
		}
	}
	ok, err := s.Allowlisted(bg, u, "dib.ae", ScopeOuter)
	if err != nil || !ok {
		t.Fatalf("confirm did not write the allowlist row: ok=%v err=%v", ok, err)
	}
}

func TestConfirmRefusesAForwarderDomainAsOuter(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, forwarded(u, *now, "a"))

	if _, err := s.Confirm(bg, u, "gmail.com", ScopeOuter); !errors.Is(err, ErrForwarderDomain) {
		t.Fatalf("allowlisting a forwarder as an outer origin is exactly what §3.2:51 forbids; err = %v", err)
	}
	if ok, err := s.Allowlisted(bg, u, "gmail.com", ScopeOuter); err != nil || ok {
		t.Fatal("the refused confirmation still wrote an allowlist row")
	}
	// The inner scope is the path the user is meant to take, and it works.
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeInner); err != nil {
		t.Fatal(err)
	}
}

// TestNoForwarderCanBeConfirmedAsAnOuterOrigin walks the whole list, and its
// subdomains, through BOTH gates.
//
// It exists because the first version of this package kept its own copy of the
// list, and the copy was a list of the wrong thing: the domains users have
// MAILBOXES at rather than the domains that SIGN their mail. It refused
// "gmail.com" and accepted "google.com" — the same §3.2:51 bypass, spelled
// differently, and durable because a CHECK constraint carried it. Reading the
// list from origin is the fix; walking every entry of it here is what keeps the
// fix honest.
func TestNoForwarderCanBeConfirmedAsAnOuterOrigin(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	for _, d := range origin.ForwarderDomains {
		for _, candidate := range []string{d, "mail." + d} {
			// A held, attested message from that origin, so nothing but the
			// forwarder rule can be what refuses the confirmation.
			it := forwarded(u, *now, candidate)
			it.OuterDomain = candidate
			hold(t, s, it)

			if _, err := s.Confirm(bg, u, candidate, ScopeOuter); !errors.Is(err, ErrForwarderDomain) {
				t.Fatalf("%s was accepted as an outer origin: %v", candidate, err)
			}
			if ok, _ := s.Allowlisted(bg, u, candidate, ScopeOuter); ok {
				t.Fatalf("%s reached the allowlist anyway", candidate)
			}
			// And the database refuses it too, so a row that bypasses this
			// package is not a standing bypass either.
			if _, err := pool.Exec(bg,
				`INSERT INTO sender_allowlist (user_id, domain, scope, created_at) VALUES ($1,$2,'outer',$3)`,
				u, candidate, *now); err == nil {
				t.Fatalf("a repair script could allowlist %s as an outer origin", candidate)
			}
		}
	}
	// The control: a bank is not a forwarder, at either gate.
	hold(t, s, item(u, *now, "bank"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
		t.Fatalf("the rule is too wide: %v", err)
	}
}

// TestTheTrustLaneRefusesAForwarderOuterEntryToo is the belt to Confirm's
// brace. origin.Decide never honours a forwarder as an outer origin whatever
// the table says, so the two halves are asserted together here rather than each
// assuming the other.
func TestTheTrustLaneRefusesAForwarderOuterEntryToo(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "bank"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}

	// A genuine bank entry is honoured...
	d, err := origin.Decide(bg, s, u, origin.Origin{Outer: "dib.ae", DKIM: origin.SigPass})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Trusted || d.Scope != ScopeOuter {
		t.Fatalf("a confirmed bank was not trusted: %+v", d)
	}
	// ...and a forwarder is not, even though this store is the thing being
	// asked.
	d, err = origin.Decide(bg, s, u, origin.Origin{Outer: "google.com", DKIM: origin.SigPass})
	if err != nil {
		t.Fatal(err)
	}
	if d.Trusted {
		t.Fatalf("the trust lane trusted a forwarder as an outer origin: %+v", d)
	}
}

func TestConfirmInnerRequiresAnAttestedItem(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	// A forward whose inner signature did not survive: the only thing naming
	// the bank is body text, and body text is not evidence.
	it := item(u, *now, "a")
	it.OuterDomain = "gmail.com"
	hold(t, s, it)

	if _, err := s.Confirm(bg, u, "dib.ae", ScopeInner); !errors.Is(err, ErrNoAttestedOrigin) {
		t.Fatalf("an inner origin with no attestation must not be trustable; err = %v", err)
	}
	if ok, _ := s.Allowlisted(bg, u, "dib.ae", ScopeInner); ok {
		t.Fatal("the refused confirmation still wrote an allowlist row")
	}

	// The other half of the argument, and the reason Confirm's `AND attested`
	// is a belt beside a brace rather than the only guard: a row naming an
	// inner origin it cannot prove is UNSTORABLE, so there is no row for a
	// confirmation to match even if the query forgot to ask. Bypassing Go
	// entirely does not get one in.
	if _, err := pool.Exec(bg, `UPDATE quarantine SET inner_domain = 'dib.ae' WHERE user_id = $1`, u); err == nil {
		t.Fatal("an unattested inner origin was storable: its only possible source is body text")
	}
}

func TestConfirmRefusesAnOuterDomainThatWasNeverVerified(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := item(u, *now, "a")
	it.OuterDomain = UnverifiedPrefix + "dib.ae" // the envelope said so; nothing signed it
	it.DKIM = ResultNone
	hold(t, s, it)

	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); !errors.Is(err, ErrNoVerifiedOrigin) {
		t.Fatalf("§3.2:54: promotion requires a verified signature; err = %v", err)
	}
	// And the prefix itself is not a domain anybody may allowlist.
	if _, err := s.Confirm(bg, u, UnverifiedPrefix+"dib.ae", ScopeOuter); !errors.Is(err, ErrInvalidDomain) {
		t.Fatalf("the unverified marker must not be allowlistable; err = %v", err)
	}
}

func TestConfirmIsScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	hold(t, s, item(a, *now, "a"))
	hold(t, s, item(b, *now, "b"))

	ids, err := s.Confirm(bg, a, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 {
		t.Fatalf("confirm crossed the account boundary: %d ids", len(ids))
	}
	if ok, _ := s.Allowlisted(bg, b, "dib.ae", ScopeOuter); ok {
		t.Fatal("one user's confirmation allowlisted the origin for another")
	}
}

func TestConfirmIsIdempotent(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))

	first, err := s.Confirm(bg, u, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Confirm(bg, u, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatalf("confirming twice must not fail: %v", err)
	}
	if len(first) != len(second) {
		t.Fatalf("confirm is not idempotent: %d then %d ids", len(first), len(second))
	}
	if n := countRows(t, pool, "sender_allowlist"); n != 1 {
		t.Fatalf("%d allowlist rows, want 1", n)
	}
}

func TestConfirmRejectsAnUnknownScope(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))
	if _, err := s.Confirm(bg, u, "dib.ae", "either"); !errors.Is(err, ErrUnknownScope) {
		t.Fatalf("err = %v", err)
	}
}

func TestTheDatabaseRefusesAForwarderOuterAllowlistWhenGoIsBypassed(t *testing.T) {
	_, now, pool := newStore(t)
	u := insertUser(t, pool)
	// google.com, not gmail.com: this is the exact value origin.Origin.Outer
	// holds for a Gmail forward, and the one the first version of this
	// constraint accepted.
	for _, d := range []string{"gmail.com", "google.com", "microsoft.com", "mail.google.com"} {
		if _, err := pool.Exec(bg,
			`INSERT INTO sender_allowlist (user_id, domain, scope, created_at) VALUES ($1,$2,'outer',$3)`,
			u, d, *now); err == nil {
			t.Fatalf("a repair script could allowlist %s as an outer origin", d)
		}
	}
	// The inner scope is legitimate for the same domain: a user may genuinely
	// bank with a domain we also see as a forwarder for someone else.
	if _, err := pool.Exec(bg,
		`INSERT INTO sender_allowlist (user_id, domain, scope, created_at) VALUES ($1,'gmail.com','inner',$2)`, u, *now); err != nil {
		t.Fatalf("the constraint is too wide: %v", err)
	}
}

// TestTheSQLForwarderListMatchesOrigin keeps the CHECK constraint in step with
// origin.ForwarderDomains, which is the single source. The behavioural test
// above proves the constraint refuses today's list; this one fails the moment a
// domain is added to Go without a migration, which is the drift that would
// otherwise sit unnoticed until someone confirmed the new one.
func TestTheSQLForwarderListMatchesOrigin(t *testing.T) {
	_, _, pool := newStore(t)
	var def string
	if err := pool.QueryRow(bg, `SELECT pg_get_constraintdef(oid) FROM pg_constraint
	  WHERE conname = 'sender_allowlist_no_forwarder_as_outer'`).Scan(&def); err != nil {
		t.Fatal(err)
	}
	// The constraint is a regex: (^|\.)(a\.com|b\.com|...)$
	alt := regexp.MustCompile(`\(\^\|\\\.\)\(([^)]*)\)\$`).FindStringSubmatch(def)
	if alt == nil {
		t.Fatalf("could not read the forwarder alternation out of: %s", def)
	}
	inSQL := strings.Split(strings.ReplaceAll(alt[1], `\.`, "."), "|")
	want := append([]string(nil), origin.ForwarderDomains...)
	sort.Strings(want)
	sort.Strings(inSQL)
	if strings.Join(want, ",") != strings.Join(inSQL, ",") {
		t.Fatalf("SQL forwarder list %v does not match origin.ForwarderDomains %v", inSQL, want)
	}
}

// ---------------------------------------------------------------------------
// The trust carried across an address rotation (spec §3.2:46)
// ---------------------------------------------------------------------------

// TestTrustSurvivesTwoRotationsInsideTheGrace is the reason sender_allowlist is
// keyed by USER and not by address.
//
// §3.2:46 promises that during the 7-day grace, mail arriving on a retired
// address keeps the trusted status its origins earned. addresses.Predecessor
// walks exactly ONE hop, so a user who rotates twice in a week has two live
// grace windows and only the newest is reported — anything that resolved trust
// by walking that link would silently demote the oldest address's senders to
// quarantine. Keying the allowlist by user removes the walk entirely: there is
// no chain to get wrong.
func TestTrustSurvivesTwoRotationsInsideTheGrace(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	addr := &addresses.Addresses{
		Pool:   pool,
		Suffix: "@in.example.test",
		Grace:  addresses.DefaultGrace,
		Now:    func() time.Time { return *now },
	}
	first, err := addr.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	hold(t, s, item(u, *now, "a"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}

	// Two rotations inside one grace window: three addresses, two of them
	// retired and both still accepting.
	*now = now.Add(24 * time.Hour)
	if _, _, err := addr.Rotate(bg, u); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(24 * time.Hour)
	if _, _, err := addr.Rotate(bg, u); err != nil {
		t.Fatal(err)
	}

	// Mail on the OLDEST address still resolves to the account...
	owner, grace, err := addr.Resolve(bg, addr.Address(first))
	if err != nil {
		t.Fatalf("the oldest address is still inside its grace: %v", err)
	}
	if owner != u || !grace {
		t.Fatalf("resolve returned owner=%s grace=%v", owner, grace)
	}
	// ...and the trust decision for it reads the same allowlist as any other.
	ok, err := s.Allowlisted(bg, owner, "dib.ae", ScopeOuter)
	if err != nil || !ok {
		t.Fatalf("trust did not carry across two rotations: ok=%v err=%v", ok, err)
	}
}

// ---------------------------------------------------------------------------
// The sync channel
// ---------------------------------------------------------------------------

func TestListIsScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	hold(t, s, item(a, *now, "a"))
	hold(t, s, item(b, *now, "b"))
	if got := len(listAll(t, s, a)); got != 1 {
		t.Fatalf("user A sees %d items, want 1", got)
	}
}

// TestListDoesNotDropItemsThatShareAReceivedAt walks the page boundary with a
// timestamp-only cursor, which is where a "WHERE received_at > $after" channel
// loses mail: a batch that arrives in the same microsecond straddles the page.
func TestListDoesNotDropItemsThatShareAReceivedAt(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	const n = 5
	for i := 0; i < n; i++ {
		hold(t, s, item(u, *now, fmt.Sprintf("same-%d", i)))
	}

	seen := map[string]bool{}
	cur := Cursor{}
	for page := 0; page < 10; page++ {
		items, err := s.List(bg, u, cur, 2, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(items) == 0 {
			break
		}
		for _, it := range items {
			seen[string(it.IngestID)] = true
		}
		last := items[len(items)-1]
		cur = Cursor{At: last.ReceivedAt, ID: last.ID}
	}
	if len(seen) != n {
		t.Fatalf("paging saw %d of %d items that share a received_at", len(seen), n)
	}
}

func TestListOmitsTheBlobUnlessAsked(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))

	items, err := s.List(bg, u, Cursor{}, 10, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Blob != nil {
		t.Fatalf("the default listing must not carry the message: %+v", items)
	}
	items, err = s.List(bg, u, Cursor{}, 10, true)
	if err != nil {
		t.Fatal(err)
	}
	// Gmail's own forward-verification mail quarantines like everything else,
	// and onboarding reads the link out of it (§3.2:47).
	if len(items) != 1 || !strings.Contains(string(items[0].Blob), "alerts@dib.ae") {
		t.Fatalf("include-blob must return the raw message: %+v", items)
	}
}

func TestCountsReportActionNeededAndTheWarnedSubset(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, now.Add(-25*24*time.Hour), "old"))
	hold(t, s, item(u, *now, "new"))
	if _, _, err := s.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}

	held, warned, err := s.Counts(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	// Every quarantined arrival is "action needed" (§3.2:56); the warned subset
	// is the one with a deadline attached.
	if held != 2 || warned != 1 {
		t.Fatalf("held=%d warned=%d, want 2 and 1", held, warned)
	}
}

func TestHeldReturnsTheRawBodiesForReingest(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := hold(t, s, item(u, *now, "a"))
	hold(t, s, item(u, *now, "b"))

	got, err := s.Held(bg, u, [][]byte{it.IngestID})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || string(got[0].Blob) != string(it.Blob) {
		t.Fatalf("Held must return the exact raw message Task 30 re-ingests: %+v", got)
	}
}

// ---------------------------------------------------------------------------
// Quarantine never pushes
// ---------------------------------------------------------------------------

// TestQuarantineHasNoPathToPush is a source-level check because that is the
// level the promise lives at: §3.2:56 says quarantined blobs never trigger
// push, and the only durable way to hold that is for this package to be unable
// to reach a pusher at all.
func TestQuarantineHasNoPathToPush(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			for _, imp := range file.Imports {
				if strings.Contains(strings.ToLower(imp.Path.Value), "push") {
					t.Fatalf("%s imports %s: quarantined mail must have no notification channel", name, imp.Path.Value)
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

// TestConcurrentSweepsRemoveEachItemExactlyOnce runs several sweeps at once,
// which is what a restart overlapping a running instance looks like.
//
// The pool is WARMED first. pgxpool opens connections lazily, so goroutines
// that all start by acquiring a fresh connection serialize behind the dial and
// never overlap — which has made two prior concurrency tests pass against
// implementations that had no concurrency control at all.
func TestConcurrentSweepsRemoveEachItemExactlyOnce(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	const items = 20
	for i := 0; i < items; i++ {
		hold(t, s, item(u, now.Add(-40*24*time.Hour), fmt.Sprintf("i%d", i)))
	}
	// Warn them all, then step past the point where they may go.
	if _, _, err := s.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(DefaultWarnBefore)

	const workers = 4
	conns := make([]*pgxpool.Conn, 0, workers)
	for i := 0; i < workers; i++ {
		c, err := pool.Acquire(bg)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		c.Release()
	}

	var (
		mu      sync.Mutex
		total   int
		firstEr error
		wg      sync.WaitGroup
		start   = make(chan struct{})
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, deleted, err := s.ExpireDue(bg)
			mu.Lock()
			defer mu.Unlock()
			total += deleted
			if err != nil && firstEr == nil {
				firstEr = err
			}
		}()
	}
	close(start)
	wg.Wait()
	if firstEr != nil {
		t.Fatal(firstEr)
	}
	if total != items {
		t.Fatalf("concurrent sweeps reported %d deletions for %d items", total, items)
	}
	if n := countRows(t, pool, "quarantine_removals"); n != items {
		t.Fatalf("%d removal records for %d deletions", n, items)
	}
	if n := countRows(t, pool, "quarantine"); n != 0 {
		t.Fatalf("%d items left", n)
	}
}

// ---------------------------------------------------------------------------
// The envelope sender
// ---------------------------------------------------------------------------

// TestTheEnvelopeSenderSurvivesForReingest is the reason the column exists. The
// SMTP envelope arrives out of band and is nowhere in the stored message, so a
// row that keeps only the blob has destroyed it — and origin.ResolveWithEnvelope
// needs it to tell an ALIGNED signature from a bank's signature that survived a
// forward. Without it, Task 30's re-ingest of confirmed mail could resolve the
// same message as LESS trusted than when it arrived.
func TestTheEnvelopeSenderSurvivesForReingest(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := forwarded(u, *now, "a")
	it.EnvelopeFrom = "<bounce+xyz@googlemail.com>"
	hold(t, s, it)

	held, err := s.Held(bg, u, [][]byte{it.IngestID})
	if err != nil {
		t.Fatal(err)
	}
	if len(held) != 1 || held[0].EnvelopeFrom != it.EnvelopeFrom {
		t.Fatalf("the envelope sender did not survive: %+v", held)
	}
	// And a re-resolve gets the same envelope the first resolve saw.
	if got := listAll(t, s, u); len(got) != 1 || got[0].EnvelopeFrom != it.EnvelopeFrom {
		t.Fatalf("list dropped the envelope sender: %+v", got)
	}
}

func TestANullSenderIsStorable(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	// A bounce arrives with MAIL FROM:<>, which smtpd reports as "". It is
	// legitimate and must not be mistaken for a missing field.
	hold(t, s, item(u, *now, "a"))
	if got := listAll(t, s, u); len(got) != 1 || got[0].EnvelopeFrom != "" {
		t.Fatalf("%+v", got)
	}
}

func TestAForgedEnvelopeSenderCannotCarryALogLine(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := item(u, *now, "a")
	it.EnvelopeFrom = "ok@dib.ae\r\nX-Forged: yes"
	if err := s.Hold(bg, it); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("a return path with a newline was accepted: %v", err)
	}
	it.EnvelopeFrom = "a@" + strings.Repeat("x", MaxEnvelopeFrom) + ".test"
	if err := s.Hold(bg, it); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("an oversize return path was accepted: %v", err)
	}
}

// ---------------------------------------------------------------------------
// The scoping every one of these queries depends on
//
// Each test below dies to ONE mutation of ONE clause. They are here because
// every clause they pin survived the suite that shipped with this store: an
// unpinned WHERE is not a property, it is a coincidence that has not been
// tested yet, and three of these clauses are the account boundary itself.
// ---------------------------------------------------------------------------

// TestAllowlistedMatchesTheWholeDomain: `domain = $2` and nothing looser. A
// prefix or suffix match on an entry for dib.ae would admit dib.ae.attacker.com
// — a domain the attacker owns outright — into the trusted lane.
func TestAllowlistedMatchesTheWholeDomain(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}
	for _, lookalike := range []string{"dib.ae.attacker.com", "notdib.ae", "dib.aero", "ib.ae"} {
		ok, err := s.Allowlisted(bg, u, lookalike, ScopeOuter)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("%q is trusted by an allowlist entry for dib.ae", lookalike)
		}
	}
	if ok, err := s.Allowlisted(bg, u, "dib.ae", ScopeOuter); err != nil || !ok {
		t.Fatalf("the confirmed domain itself is not allowlisted (ok=%v err=%v)", ok, err)
	}
}

// TestAllowlistedIsScopedToTheScope: dropping `scope = $3` silently converts an
// inner confirmation into an outer one, which is §3.2:51's foot-gun reached
// without the user ever asking for it.
func TestAllowlistedIsScopedToTheScope(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, forwarded(u, *now, "a"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeInner); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Allowlisted(bg, u, "dib.ae", ScopeOuter); err != nil || ok {
		t.Fatalf("an INNER confirmation allowlisted the domain as an OUTER origin (ok=%v err=%v)", ok, err)
	}
	if ok, err := s.Allowlisted(bg, u, "dib.ae", ScopeInner); err != nil || !ok {
		t.Fatalf("the inner confirmation did not take (ok=%v err=%v)", ok, err)
	}
}

// TestHeldIsScopedToTheUser is the worst of these to get wrong, and the one the
// existing cross-user tests could not see because they never held a message at
// all. Two accounts can hold the SAME bytes — one bank, two customers, one alert
// template — so `ingest_id = ANY($2)` alone matches both rows. Two callers rely
// on it: reprocess reads the raw body out of the row it gets back, and
// ingest.Pipeline.alreadyHandled treats a hit as "this user has already seen
// this", so another account's copy would make the victim's own mail a duplicate
// and discard it silently.
func TestHeldIsScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	shared := ingestID("one message, two customers")

	for _, u := range []uuid.UUID{a, b} {
		it := item(u, *now, "x")
		it.IngestID = shared
		it.Blob = []byte("From: alerts@dib.ae\r\n\r\nfor " + u.String())
		hold(t, s, it)
	}

	held, err := s.Held(bg, a, [][]byte{shared})
	if err != nil {
		t.Fatal(err)
	}
	if len(held) != 1 {
		t.Fatalf("Held returned %d rows for one user's copy of a shared message", len(held))
	}
	if held[0].UserID != a {
		t.Fatalf("Held returned another account's row (%s, want %s)", held[0].UserID, a)
	}
	if !strings.Contains(string(held[0].Blob), a.String()) {
		t.Fatalf("Held returned another account's plaintext: %q", held[0].Blob)
	}
}

// TestIsHeldIsScopedToTheUser: the existence check the arrival path runs on
// EVERY inbound message carries the same boundary as the read it replaced.
func TestIsHeldIsScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	it := item(a, *now, "a")
	hold(t, s, it)

	ok, err := s.IsHeld(bg, a, it.IngestID)
	if err != nil || !ok {
		t.Fatalf("IsHeld(owner) = %v, %v", ok, err)
	}
	ok, err = s.IsHeld(bg, b, it.IngestID)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("one account's held message answers another account's existence check")
	}
	ok, err = s.IsHeld(bg, a, ingestID("never arrived"))
	if err != nil || ok {
		t.Fatalf("IsHeld(unknown) = %v, %v", ok, err)
	}
}

// TestPromoteIsScopedToTheUser: without `user_id = $1` a confirmation on one
// account deletes another account's held mail, and the removal record it leaves
// names the victim's own user id — a drop that looks accounted for.
func TestPromoteIsScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	shared := ingestID("one message, two customers")
	for _, u := range []uuid.UUID{a, b} {
		it := item(u, *now, "x")
		it.IngestID = shared
		hold(t, s, it)
	}

	n, err := s.Promote(bg, a, [][]byte{shared})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("Promote removed %d rows for one account's copy", n)
	}
	if got := len(listAll(t, s, b)); got != 1 {
		t.Fatalf("one account's promotion removed another account's mail (%d rows left)", got)
	}
}

// TestCountsAreScopedToTheUser: the watchdog's "action needed" number is per
// account, and a count that includes strangers' mail is a badge nobody can clear.
func TestCountsAreScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	hold(t, s, item(a, *now, "a1"))
	hold(t, s, item(a, now.Add(-25*24*time.Hour), "a2"))
	hold(t, s, item(b, *now, "b1"))
	hold(t, s, item(b, now.Add(-25*24*time.Hour), "b2"))
	if _, _, err := s.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}

	held, warned, err := s.Counts(bg, a)
	if err != nil {
		t.Fatal(err)
	}
	if held != 2 || warned != 1 {
		t.Fatalf("Counts(a) = held %d, warned %d; want 2 and 1 — the other account's mail is being counted", held, warned)
	}
}

// TestRemovalsAreScopedToTheUser: this is the channel that answers "what
// happened to the mail I never got to?", so an unscoped read hands one account
// the digests, hostnames and timings of another's.
func TestRemovalsAreScopedToTheUser(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	itA := hold(t, s, item(a, *now, "a"))
	itB := hold(t, s, item(b, *now, "b"))
	if _, err := s.Promote(bg, a, [][]byte{itA.IngestID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Promote(bg, b, [][]byte{itB.IngestID}); err != nil {
		t.Fatal(err)
	}

	got, err := s.Removals(bg, a, Cursor{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("Removals(a) returned %d records, want only this account's one", len(got))
	}
	if got[0].UserID != a {
		t.Fatalf("Removals(a) returned another account's record (%s)", got[0].UserID)
	}
}

// TestConfirmLowerCasesTheDomain. The stored domain is lower case, the client
// may send whatever the sheet rendered, and without the normalization the
// hostname grammar refuses an upper-case domain outright — so this fails CLOSED,
// as "your bank cannot be trusted", which is the failure nobody debugs.
func TestConfirmLowerCasesTheDomain(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := hold(t, s, item(u, *now, "a"))

	ids, err := s.Confirm(bg, u, "  DIB.AE  ", ScopeOuter)
	if err != nil {
		t.Fatalf("confirming DIB.AE was refused: %v", err)
	}
	if len(ids) != 1 || string(ids[0]) != string(it.IngestID) {
		t.Fatalf("confirm returned %d ids", len(ids))
	}
	if ok, err := s.Allowlisted(bg, u, "DIB.AE", ScopeOuter); err != nil || !ok {
		t.Fatalf("the entry is not readable by the spelling that wrote it (ok=%v err=%v)", ok, err)
	}
	if n := countRows(t, pool, "sender_allowlist"); n != 1 {
		t.Fatalf("%d allowlist rows, want 1 — a second spelling wrote a second entry", n)
	}
}

// ---------------------------------------------------------------------------
// Confirming an origin that is already trusted
// ---------------------------------------------------------------------------

// TestConfirmingAnAlreadyTrustedOriginIsNotARefusal. Confirm reported "no held
// message proves this origin" once the mail it released had been promoted —
// which is the state a SUCCESSFUL confirmation leaves. A double-tap, a retry
// after a lost response, or one more pass of the documented `remaining > 0`
// loop then answered 409 "there is nothing to trust yet" about an origin that
// is on the allowlist, on the single step spec §3.2 calls out as onboarding.
func TestConfirmingAnAlreadyTrustedOriginIsNotARefusal(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))

	ids, err := s.Confirm(bg, u, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatal(err)
	}
	// Exactly what Task 30's re-ingest does with them.
	if _, err := s.Promote(bg, u, ids); err != nil {
		t.Fatal(err)
	}

	again, err := s.Confirm(bg, u, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatalf("re-confirming a trusted origin whose mail is all promoted: %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("nothing is held, so nothing is released: %d ids", len(again))
	}
	if n := countRows(t, pool, "sender_allowlist"); n != 1 {
		t.Fatalf("%d allowlist rows, want 1", n)
	}
	// The inner scope of the same domain is a DIFFERENT assertion and is still
	// unproven, so it is still refused.
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeInner); !errors.Is(err, ErrNoAttestedOrigin) {
		t.Fatalf("an unproven inner origin must still be refused: %v", err)
	}
}

func TestConfirmNeverWritesToTheOpLog(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, "op_log"); n != 0 {
		t.Fatalf("confirming appended %d op(s); the RE-INGEST enters the chains, never the confirmation", n)
	}
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

// TestRevokeUndoesAConfirmation. A user who trusts a lookalike — dib-alerts.ae,
// or a punycode A-label the hostname grammar admits — had no way back: nothing
// in the tree deleted a sender_allowlist row except deleting the account.
func TestRevokeUndoesAConfirmation(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	hold(t, s, item(u, *now, "a"))
	if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}

	removed, err := s.Revoke(bg, u, "DIB.AE", ScopeOuter)
	if err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Fatal("revoking a confirmed origin removed nothing")
	}
	if ok, err := s.Allowlisted(bg, u, "dib.ae", ScopeOuter); err != nil || ok {
		t.Fatalf("the origin is still trusted after revocation (ok=%v err=%v)", ok, err)
	}
	// Idempotent, and it says so rather than erroring.
	removed, err = s.Revoke(bg, u, "dib.ae", ScopeOuter)
	if err != nil {
		t.Fatal(err)
	}
	if removed {
		t.Fatal("the second revocation reported removing a row that was already gone")
	}
}

func TestRevokeIsScopedToTheUserAndTheScope(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	for _, u := range []uuid.UUID{a, b} {
		it := item(u, *now, "x")
		it.IngestID = ingestID("shared-" + u.String())
		hold(t, s, it)
		if _, err := s.Confirm(bg, u, "dib.ae", ScopeOuter); err != nil {
			t.Fatal(err)
		}
	}
	hold(t, s, forwarded(a, *now, "f"))
	if _, err := s.Confirm(bg, a, "dib.ae", ScopeInner); err != nil {
		t.Fatal(err)
	}

	if _, err := s.Revoke(bg, a, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Allowlisted(bg, b, "dib.ae", ScopeOuter); !ok {
		t.Fatal("one account's revocation removed another account's entry")
	}
	if ok, _ := s.Allowlisted(bg, a, "dib.ae", ScopeInner); !ok {
		t.Fatal("revoking the outer scope removed the inner one")
	}
}

func TestRevokeRefusesWhatConfirmRefuses(t *testing.T) {
	s, _, pool := newStore(t)
	u := insertUser(t, pool)
	if _, err := s.Revoke(bg, u, "dib.ae", "either"); !errors.Is(err, ErrUnknownScope) {
		t.Fatalf("scope = %v", err)
	}
	if _, err := s.Revoke(bg, u, "not a hostname", ScopeOuter); !errors.Is(err, ErrInvalidDomain) {
		t.Fatalf("domain = %v", err)
	}
}

// TestAllowlistedOriginsIsWhatMakesRevocationReachable. The same argument the
// push-token list route was added for: a delete that needs a value only the
// server holds is a delete the user cannot perform.
func TestAllowlistedOriginsIsWhatMakesRevocationReachable(t *testing.T) {
	s, now, pool := newStore(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	hold(t, s, item(a, *now, "a"))
	hold(t, s, forwarded(a, *now, "f"))
	hold(t, s, item(b, *now, "b"))
	if _, err := s.Confirm(bg, a, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Confirm(bg, a, "dib.ae", ScopeInner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Confirm(bg, b, "dib.ae", ScopeOuter); err != nil {
		t.Fatal(err)
	}

	got, err := s.AllowlistedOrigins(bg, a)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("%d entries for an account with two confirmations: %+v", len(got), got)
	}
	for _, e := range got {
		if e.Domain != "dib.ae" || e.CreatedAt.IsZero() {
			t.Fatalf("entry does not describe what was confirmed: %+v", e)
		}
	}
	if got[0].Scope == got[1].Scope {
		t.Fatalf("the two scopes are not distinguishable: %+v", got)
	}
}

// ---------------------------------------------------------------------------
// The byte budget, and the two definitions that must not drift
// ---------------------------------------------------------------------------

// TestListPageIsBoundedByBytesInTheDatabase. The row limit is the wrong
// instrument the moment a row can be a megabyte: ?include_blob=1&limit=200 is
// 200 MB of blobs, and the budget has to be applied where the rows are SELECTED
// rather than after they have all been materialized — pgx drains a result set
// it stops scanning, so a Go-side budget bounds what this process retains and
// nothing else. Same rule, same reason, as oplog.readPageSQL.
func TestListPageIsBoundedByBytesInTheDatabase(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	for i := 0; i < 6; i++ {
		it := item(u, now.Add(time.Duration(i)*time.Second), fmt.Sprintf("big%d", i))
		it.Blob = append(it.Blob, make([]byte, 2000)...)
		hold(t, s, it)
	}

	items, truncated, err := s.ListPage(bg, u, Cursor{}, 100, true, 3*4096)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("a 3-bucket budget returned %d rows of 6", len(items))
	}
	if !truncated {
		t.Fatal("a page cut by the byte budget must say so, or the caller reports it as complete")
	}
	// And the page resumes exactly where it stopped: a page boundary is not a
	// place mail is allowed to disappear.
	rest, truncated, err := s.ListPage(bg, u, Cursor{At: items[2].ReceivedAt, ID: items[2].ID}, 100, true, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != 3 || truncated {
		t.Fatalf("the rest of the lane is %d rows (truncated=%v), want 3", len(rest), truncated)
	}
}

// TestListAlwaysReturnsARowHoweverBigItIs is oplog.readPageSQL's `rn = 1`: a
// budget that could refuse the head of the page leaves a client unable to
// advance its cursor past one oversized message, forever.
func TestListAlwaysReturnsARowHoweverBigItIs(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	it := item(u, *now, "huge")
	it.Blob = append(it.Blob, make([]byte, 5000)...)
	hold(t, s, it)

	items, _, err := s.ListPage(bg, u, Cursor{}, 100, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || len(items[0].Blob) == 0 {
		t.Fatalf("a blob larger than the whole budget is unreachable: %d rows", len(items))
	}
}

// TestTheAttestationMethodsMatchOrigin. These constants are declared twice —
// here, because a store should not depend on the verifier to name what it was
// handed, and in origin, which produces them. Two spellings of one value is the
// shape of the forwarder-list bug that actually bit this package: a copy that
// was wrong within the day and durable because it was also a CHECK constraint.
func TestTheAttestationMethodsMatchOrigin(t *testing.T) {
	if AttestedByDirectDKIM != origin.AttestedByDKIM {
		t.Fatalf("direct-DKIM attestation is %q here and %q in origin", AttestedByDirectDKIM, origin.AttestedByDKIM)
	}
	if AttestedByARC != origin.AttestedByARC {
		t.Fatalf("ARC attestation is %q here and %q in origin", AttestedByARC, origin.AttestedByARC)
	}
}

// TestValidateMirrorsTheHostnameLengthCaps. validate says it mirrors the CHECK
// constraints; it omitted their length caps, so an over-long domain was refused
// by the database as a 500 rather than by this package as an ErrInvalidItem.
func TestValidateMirrorsTheHostnameLengthCaps(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)

	// Every label is legal, so only the total length can refuse these: a regex
	// anchored on LABEL length accepts a name of any number of them.
	tooLongForOuter := strings.Repeat("ab.", 89) + "test" // 271 > MaxOuterDomain
	tooLongForInner := strings.Repeat("ab.", 85) + "test" // 259 > MaxDomain, <= MaxOuterDomain

	it := item(u, *now, "a")
	it.OuterDomain = tooLongForOuter
	if err := s.Hold(bg, it); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("a %d-byte outer domain was not refused by validate: %v", len(tooLongForOuter), err)
	}
	it = forwarded(u, *now, "b")
	it.InnerDomain = tooLongForInner
	if err := s.Hold(bg, it); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("a %d-byte inner domain was not refused by validate: %v", len(tooLongForInner), err)
	}
	// The outer column carries UnverifiedPrefix in the same 264 bytes, so a
	// plain 259-byte hostname is legal there and must not be refused.
	it = item(u, *now, "c")
	it.OuterDomain = tooLongForInner
	if err := s.Hold(bg, it); err != nil {
		t.Fatalf("a %d-byte outer domain is inside the column's cap: %v", len(tooLongForInner), err)
	}
}
