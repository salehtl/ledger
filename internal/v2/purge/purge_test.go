package purge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/dict"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// Seeding a user into EVERY table that references them
// ---------------------------------------------------------------------------
//
// The seeders below are keyed by table name and are looked up from the set
// UserScopedTables DISCOVERS, never from a list written here. A table added by
// a later task therefore fails seedAFullyPopulatedUser with "no seeder for
// user-scoped table X" long before it can fail silently in production, which is
// the whole point of discovering the set rather than enumerating it.
//
// They are raw INSERTs rather than calls into auth/oplog/quarantine/... on
// purpose: this file is a test ABOUT THE SCHEMA. Going through the packages
// would mean a table whose package has no writer yet (or whose writer stops
// being called) quietly contributes no row, and the completeness proof would
// pass by never having populated the table it claims to have emptied.

type seeder func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID)

var seeders = map[string]seeder{
	"public.sessions": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
		               VALUES ($2, $1, now(), now() + interval '1 hour')`, u, randBytes(t, 32))
	},
	"public.oplog_seq": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO oplog_seq (user_id, next_seq) VALUES ($1, 3)
		               ON CONFLICT (user_id) DO UPDATE SET next_seq = 3`, u)
	},
	"public.op_log": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		for seq := 1; seq <= 2; seq++ {
			exec(t, pool, `INSERT INTO op_log
			  (user_id, seq, stream, writer_id, writer_counter, type_flag,
			   blob, size_bucket, blob_hash, prev_hash)
			  VALUES ($1, $2, 'hot', 'ingest-1', $2, 'ingest', $3, 1024, $4, $5)`,
				u, seq, make([]byte, 1024), randBytes(t, 32), make([]byte, 32))
		}
	},
	"public.writers": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO writers (user_id, writer_id, kind, pubkey, registered_at)
		               VALUES ($1, 'device-1', 'device', $2, now())`, u, devicePub(t, u))
	},
	"public.key_history": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO key_history (user_id, writer_id, pubkey, event, at)
		               VALUES ($1, 'device-1', $2, 'registered', now())`, u, devicePub(t, u))
	},
	"public.writer_challenges": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO writer_challenges (nonce, user_id, issued_at, expires_at)
		               VALUES ($2, $1, now(), now() + interval '5 minutes')`, u, randBytes(t, 32))
	},
	"public.inbound_addresses": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		// TWO of them, one retired inside its grace window and chained to the
		// other. Task 22's Predecessor is one hop, so a live account can hold
		// several inbound addresses; a purge that walked the chain instead of
		// the user id would leave the oldest behind.
		old, cur := localPart(t), localPart(t)
		exec(t, pool, `INSERT INTO inbound_addresses (local_part, user_id, created_at, expires_at, rotated_at)
		               VALUES ($2, $1, now(), now() + interval '7 days', now())`, u, old)
		exec(t, pool, `INSERT INTO inbound_addresses (local_part, user_id, created_at, rotated_from)
		               VALUES ($2, $1, now(), $3)`, u, cur, old)
	},
	"public.address_rotation_challenges": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO address_rotation_challenges (nonce, user_id, issued_at, expires_at)
		               VALUES ($2, $1, now(), now() + interval '5 minutes')`, u, randBytes(t, 32))
	},
	"public.account_deletion_challenges": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO account_deletion_challenges (nonce, user_id, issued_at, expires_at)
		               VALUES ($2, $1, now(), now() + interval '5 minutes')`, u, randBytes(t, 32))
	},
	"public.donated_samples": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		// Both shapes Task 31 permits: a consented body, and the content-free
		// report. They have their OWN retention deadline (expires_at) and their
		// own consent identifier, and neither is a reason for them to outlive
		// the account — a donation is still the donor's data.
		exec(t, pool, `INSERT INTO donated_samples
		  (user_id, sender_domain, structure_sig, ingest_id, raw, received_at, consent,
		   consented_at, created_at, expires_at)
		  VALUES ($1, 'dib.ae', $2, $3, $4, now(), 'donate-sample-v1', now(), now(),
		          now() + interval '90 days')`,
			u, "0123456789abcdef0123456789abcdef", randBytes(t, 32), []byte("From: a@dib.ae\r\n\r\nhi"))
		exec(t, pool, `INSERT INTO donated_samples
		  (user_id, sender_domain, structure_sig, created_at, expires_at)
		  VALUES ($1, 'enbd.com', $2, now(), now() + interval '90 days')`,
			u, "fedcba9876543210fedcba9876543210")
	},
	"public.parse_diagnostics": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO parse_diagnostics
		  (user_id, event, ingest_id, received_at, sender_domain, dkim_result, arc_result,
		   normalizer_version, matched, tier, body_size_bucket, structure_sig, outcome)
		  VALUES ($1, 'arrival', $2, now(), 'dib.ae', 'pass', 'none', 1, false, 'none', 1024, '', 'quarantined')`,
			u, randBytes(t, 32))
	},
	// An operator's judgement about one person's unparsed mail. It is
	// user-scoped in the schema precisely so it is discovered here and leaves
	// with the account — an adjudication that outlived the user would be a
	// record about somebody who asked to be forgotten.
	"public.parse_rate_adjudications": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO parse_rate_adjudications (ingest_id, user_id, verdict)
		               VALUES ($2, $1, 'transaction')`, u, randBytes(t, 32))
	},
	"public.quarantine": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO quarantine
		  (user_id, ingest_id, received_at, expires_at, outer_domain, dkim, arc, size_bucket, blob)
		  VALUES ($1, $2, now(), now() + interval '30 days', 'dib.ae', 'pass', 'none', 1024, $3)`,
			u, randBytes(t, 32), []byte("held"))
	},
	"public.quarantine_removals": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO quarantine_removals
		  (quarantine_id, user_id, ingest_id, received_at, expires_at, warned_at, removed_at,
		   reason, outer_domain, attested, size_bucket)
		  VALUES (gen_random_uuid(), $1, $2, now(), now() + interval '30 days', now(), now(),
		          'expired', 'dib.ae', false, 1024)`, u, randBytes(t, 32))
	},
	"public.sender_allowlist": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO sender_allowlist (user_id, domain, scope, created_at)
		               VALUES ($1, 'dib.ae', 'outer', now())`, u)
	},
	// A push token now names the device writer and the session that registered
	// it (00019), so that revoking either stops the notifications. Both are
	// seeded here rather than worked around: a row with no links is one the
	// schema no longer admits, and seeding one would test a shape production
	// cannot produce.
	"public.push_tokens": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO writers (user_id, writer_id, kind, pubkey, registered_at)
		               VALUES ($1, 'push-device', 'device', $2, now())
		               ON CONFLICT DO NOTHING`, u, randBytes(t, 32))
		exec(t, pool, `INSERT INTO sessions (token_hash, user_id, expires_at)
		               VALUES ($2, $1, now() + interval '1 day')
		               ON CONFLICT DO NOTHING`, u, randBytes(t, 32))
		exec(t, pool, `INSERT INTO push_tokens (user_id, token, platform, writer_id, session_hash)
		               SELECT $1, $2, 'ios', 'push-device', token_hash
		                 FROM sessions WHERE user_id = $1 LIMIT 1`,
			u, "ExponentPushToken["+u.String()+"]")
	},
	"public.user_consent": func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO user_consent (user_id, document, signed_at, retention_until)
		               VALUES ($1, 'alpha-plaintext-v1', now(), now() + interval '90 days')
		               ON CONFLICT (user_id) DO NOTHING`, u)
	},
}

func newUser(t *testing.T, pool *pgxpool.Pool, sub string) uuid.UUID {
	t.Helper()
	sum := sha256.Sum256([]byte(sub))
	var u uuid.UUID
	if err := pool.QueryRow(bg,
		`INSERT INTO users (idp, idp_sub_hash, created_at) VALUES ('apple', $1, now()) RETURNING id`,
		sum[:]).Scan(&u); err != nil {
		t.Fatalf("create user %q: %v", sub, err)
	}
	return u
}

// seedAFullyPopulatedUser puts at least one row for a fresh user in EVERY
// relation the schema says references them, and fails loudly if it cannot.
//
// A materialized view is skipped rather than seeded: nothing can INSERT into
// one. It is populated by whatever it selects from, which is what makes it a
// stored copy, and the matview tests below build their own.
func seedAFullyPopulatedUser(t *testing.T, pool *pgxpool.Pool, sub string) uuid.UUID {
	t.Helper()
	u := newUser(t, pool, sub)
	rels, err := UserScopedTables(bg, pool)
	if err != nil {
		t.Fatal(err)
	}
	var seeded []Relation
	for _, r := range rels {
		if r.Kind == 'm' {
			continue
		}
		seed, ok := seeders[r.String()]
		if !ok {
			t.Fatalf("no seeder for user-scoped %s %q: this test proves a purge empties "+
				"every relation that references a user, and it cannot prove it for one it "+
				"never populated. Add a seeder to purge_test.go's `seeders` map.", r.KindName(), r)
		}
		seed(t, pool, u)
		seeded = append(seeded, r)
	}
	// Seeded is not the same as present: an INSERT with ON CONFLICT DO NOTHING,
	// or a seeder that writes to the wrong table, would leave the completeness
	// assertion below vacuously true.
	for _, r := range seeded {
		if n := rowsFor(t, pool, r, u); n == 0 {
			t.Fatalf("seeder for %q left no row for the user", r)
		}
	}
	return u
}

func rowsFor(t *testing.T, pool *pgxpool.Pool, r Relation, u uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM `+r.SQL()+` WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", r, err)
	}
	return n
}

// rel is the Relation for a plain table in `public`, for the tests that name
// one directly.
func rel(name string) Relation { return Relation{Schema: "public", Name: name, Kind: 'r'} }

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(bg, sql, args...); err != nil {
		t.Fatalf("%s: %v", firstLine(sql), err)
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

func randBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// deviceKey returns a stable Ed25519 keypair per user. It must be stable
// because writers and key_history are seeded separately and the pair has to
// look like one enrollment — and because a test that signs with it needs the
// private half of the key the roster holds.
var (
	keyMu   sync.Mutex
	devKeys = map[uuid.UUID]ed25519.PrivateKey{}
)

func deviceKey(t *testing.T, u uuid.UUID) ed25519.PrivateKey {
	t.Helper()
	keyMu.Lock()
	defer keyMu.Unlock()
	if k, ok := devKeys[u]; ok {
		return k
	}
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	devKeys[u] = priv
	return priv
}

func devicePub(t *testing.T, u uuid.UUID) []byte {
	t.Helper()
	return deviceKey(t, u).Public().(ed25519.PublicKey)
}

// localPart mints a value matching inbound_addresses' `u-[a-z2-7]{26}` shape.
func localPart(t *testing.T) string {
	t.Helper()
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	b := randBytes(t, 26)
	out := make([]byte, 26)
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return "u-" + string(out)
}

// testDict is a Dict with a real HMAC key, so submissions are recoverable by
// ForgetSubmitter the same way production's are.
func testDict(t *testing.T, pool *pgxpool.Pool) *dict.Dict {
	t.Helper()
	return &dict.Dict{Pool: pool, HMACKey: randBytes(t, 32)}
}

func submitDictEntry(t *testing.T, d *dict.Dict, u uuid.UUID, pattern string) {
	t.Helper()
	if err := d.Submit(bg, u, pattern, "groceries"); err != nil {
		t.Fatalf("submit %q: %v", pattern, err)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", firstLine(sql), err)
	}
	return n
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

func TestPurgeLeavesNoRowInAnyUserScopedTable(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	submitDictEntry(t, d, u, "carrefour")

	rep, err := Purge(bg, pool, d, u)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}

	rels, err := UserScopedTables(bg, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(rels) < 9 {
		t.Fatalf("expected to discover the user-scoped relations, found %v", rels)
	}
	for _, r := range rels {
		if n := rowsFor(t, pool, r, u); n != 0 {
			t.Fatalf("%s %s still holds %d rows for the purged user", r.KindName(), r, n)
		}
		if _, ok := rep.Rows[r.String()]; !ok {
			t.Fatalf("report does not account for %s: %+v", r, rep.Rows)
		}
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 0 {
		t.Fatal("the users row itself must be gone")
	}
	if !slices.Contains(rep.Users, u) {
		t.Fatalf("report does not name the purged user: %+v", rep.Users)
	}
}

// A purge that only iterates user_id columns silently leaves dict_submissions
// behind: it is keyed by a salted HMAC, so schema discovery cannot see it.
func TestPurgeAlsoClearsTablesWithNoUserIDColumn(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	submitDictEntry(t, d, u, "carrefour")
	submitDictEntry(t, d, u, "spinneys")
	if n := countRows(t, pool, `SELECT count(*) FROM dict_submissions`); n != 2 {
		t.Fatalf("precondition: dict_submissions holds %d rows, want 2", n)
	}

	rep, err := Purge(bg, pool, d, u)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM dict_submissions`); n != 0 {
		t.Fatalf("dict_submissions still holds %d rows for the purged user", n)
	}
	if rep.DictSubmissions != 2 {
		t.Fatalf("report says %d dictionary submissions were forgotten, want 2", rep.DictSubmissions)
	}
}

// smtp_rejections is the OTHER table with no user_id, and the answer for it is
// "nothing to delete" rather than "forgot about it". Asserted deliberately: a
// per-day counter is not user-linked and cannot be, so a purge must leave it
// alone — including another user's counts on the same day.
func TestPurgeLeavesTheAggregateRejectionCountsAlone(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	exec(t, pool, `INSERT INTO smtp_rejections (day, reason, count) VALUES (current_date, 'unknown_rcpt', 7)`)

	if _, err := Purge(bg, pool, d, u); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n := countRows(t, pool, `SELECT count FROM smtp_rejections WHERE reason = 'unknown_rcpt'`); n != 7 {
		t.Fatalf("smtp_rejections count is %d, want 7 — it is an aggregate with no user to purge", n)
	}
}

// Every table in the database is classified: user-scoped (discovered), handled
// without a user_id column, or deliberately not user-linked. A table added by a
// later task lands in none of those and fails here — and, by the same call
// inside Purge, refuses to purge at all rather than purging incompletely.
func TestEveryTableIsClassified(t *testing.T) {
	pool := pgtest.New(t)
	c, err := Classify(bg, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Unclassified) != 0 {
		t.Fatalf("unclassified tables %v: a table this purge does not know about is a table "+
			"a deleted user's rows can survive in. Either give it a user_id column (it is then "+
			"discovered automatically), or add it to purge.go's handledWithoutUserID / "+
			"notUserLinked with the reason.", c.Unclassified)
	}
	for _, want := range []string{
		"public.op_log", "public.quarantine", "public.sessions",
		"public.push_tokens", "public.user_consent",
	} {
		if !slices.ContainsFunc(c.UserScoped, func(r Relation) bool { return r.String() == want }) {
			t.Fatalf("%s is not classified as user-scoped: %+v", want, c)
		}
	}
	if !slices.Contains(c.HandledWithoutUserID, "public.dict_submissions") {
		t.Fatalf("dict_submissions is not classified as handled-without-user_id: %+v", c)
	}
	if !slices.Contains(c.NotUserLinked, "public.smtp_rejections") {
		t.Fatalf("smtp_rejections is not classified as not-user-linked: %+v", c)
	}
}

func TestPurgeRefusesWhenATableIsUnclassified(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	// A future task's table, with no user_id and no classification.
	exec(t, pool, `CREATE TABLE later_task_notes (id bigserial PRIMARY KEY, note text)`)

	_, err := Purge(bg, pool, d, u)
	if err == nil {
		t.Fatal("purge succeeded with an unclassified table present")
	}
	if !strings.Contains(err.Error(), "later_task_notes") {
		t.Fatalf("error does not name the unclassified table: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 1 {
		t.Fatal("a refused purge must leave the account intact, not half-deleted")
	}
}

// ---------------------------------------------------------------------------
// The three object classes information_schema could not see
// ---------------------------------------------------------------------------
//
// Discovery used to read information_schema.tables scoped to `public`. That was
// blind to a materialized view (not listed there AT ALL), to any other schema,
// and to anything the current role lacks privileges on (information_schema is
// privilege-filtered). In each case the relation was neither purged NOR
// reported, and Purge returned success — the worst possible combination for a
// function whose entire job is to be exhaustive. These four tests are the
// regression net; see relationFilter in purge.go.

// The one the spec plans to create. §5: "the existing PWA may additionally
// serve alphas via a temporary server-side materialized view." A matview over
// op_log is a stored COPY of the user's plaintext blobs, it survives the
// cascade untouched because nothing cascades into a query result, and it cannot
// be DELETEd from. Refreshing it is the only way its copy goes away.
func TestPurgeReachesAMaterializedViewOverUserData(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	bystander := seedAFullyPopulatedUser(t, pool, "leave-me")
	exec(t, pool, `CREATE MATERIALIZED VIEW user_blob_archive AS
	                 SELECT user_id, seq, blob FROM op_log`)

	mv := Relation{Schema: "public", Name: "user_blob_archive", Kind: 'm'}
	if n := rowsFor(t, pool, mv, u); n == 0 {
		t.Fatal("precondition: the matview holds none of the user's rows")
	}
	// Discovery must SEE it. This is the assertion information_schema failed.
	rels, err := UserScopedTables(bg, pool)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(rels, func(r Relation) bool { return r.String() == mv.String() }) {
		t.Fatalf("discovery did not find the materialized view: %v", rels)
	}

	rep, err := Purge(bg, pool, d, u)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n := rowsFor(t, pool, mv, u); n != 0 {
		t.Fatalf("the materialized view still holds %d rows of the purged user's plaintext blobs", n)
	}
	if !slices.Contains(rep.RefreshedViews, mv.String()) {
		t.Fatalf("report does not name the refreshed view: %+v", rep.RefreshedViews)
	}
	// Refreshing is not a euphemism for emptying: everyone else's rows are back.
	if n := rowsFor(t, pool, mv, bystander); n == 0 {
		t.Fatal("the refresh dropped the bystander's rows too")
	}
}

// A matview with no user_id is still a relation nobody has classified, and the
// old query could not see it to say so.
func TestPurgeRefusesAnUnclassifiedMaterializedView(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	exec(t, pool, `CREATE MATERIALIZED VIEW sender_counts AS
	                 SELECT outer_domain, count(*) AS n FROM quarantine GROUP BY outer_domain`)

	_, err := Purge(bg, pool, d, u)
	if err == nil {
		t.Fatal("purge succeeded with an unclassified materialized view present")
	}
	if !strings.Contains(err.Error(), "sender_counts") ||
		!strings.Contains(err.Error(), "materialized view") {
		t.Fatalf("error does not name the view and its kind: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 1 {
		t.Fatal("a refused purge must leave the account intact")
	}
}

// `archive.op_log_2026` — the obvious thing a DBA creates, in the obvious place
// a `WHERE table_schema = 'public'` filter cannot see.
func TestPurgeReachesATableOutsideThePublicSchema(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	exec(t, pool, `CREATE SCHEMA archive`)
	exec(t, pool, `CREATE TABLE archive.op_log_2026 (
	                 id bigserial PRIMARY KEY,
	                 user_id uuid NOT NULL,
	                 blob bytea NOT NULL)`)
	seeders["archive.op_log_2026"] = func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO archive.op_log_2026 (user_id, blob) VALUES ($1, $2)`,
			u, []byte("archived plaintext"))
	}
	t.Cleanup(func() { delete(seeders, "archive.op_log_2026") })

	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	archived := Relation{Schema: "archive", Name: "op_log_2026", Kind: 'r'}
	if n := rowsFor(t, pool, archived, u); n != 1 {
		t.Fatalf("precondition: the archive holds %d rows, want 1", n)
	}

	rep, err := Purge(bg, pool, d, u)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n := rowsFor(t, pool, archived, u); n != 0 {
		t.Fatalf("archive.op_log_2026 still holds %d rows of the purged user's plaintext", n)
	}
	if !slices.Contains(rep.SweptWithoutCascade, "archive.op_log_2026") {
		t.Fatalf("report does not flag the out-of-schema table: %+v", rep.SweptWithoutCascade)
	}
	// The qualified name is what the report keys on. An unqualified "op_log_2026"
	// would collide with a public table of the same name.
	if _, ok := rep.Rows["archive.op_log_2026"]; !ok {
		t.Fatalf("report keys are not schema-qualified: %+v", rep.Rows)
	}
}

// information_schema shows only what the current role has privileges on, and
// plan D5 mandates a NON-OWNER `ledger_runtime` that `ledgerd purge-user` opens
// the DSN as. So a relation that role cannot touch used to be absent from the
// list — silently, with no report and no error. It must now be DISCOVERED, and
// the count against it must fail loudly rather than being skipped.
func TestPurgeSeesARelationTheRoleCannotRead(t *testing.T) {
	pool := pgtest.New(t)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	exec(t, pool, `CREATE TABLE hidden_user_notes (
	                 id bigserial PRIMARY KEY,
	                 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	                 note text NOT NULL)`)
	exec(t, pool, `INSERT INTO hidden_user_notes (user_id, note) VALUES ($1, 'x')`, u)

	role := fmt.Sprintf("t_runtime_%d", time.Now().UnixNano())
	exec(t, pool, `CREATE ROLE `+role+` LOGIN`)
	exec(t, pool, `GRANT USAGE ON SCHEMA public TO `+role)
	exec(t, pool, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO `+role)
	exec(t, pool, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO `+role)
	// The one relation the runtime role is not allowed to see into.
	exec(t, pool, `REVOKE ALL ON hidden_user_notes FROM `+role)

	runtime := poolAs(t, pool, role)

	// Blind spot 3, directly: pg_class is not privilege-filtered.
	rels, err := UserScopedTables(bg, runtime)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(rels, func(r Relation) bool { return r.String() == "public.hidden_user_notes" }) {
		t.Fatalf("the runtime role's discovery cannot see a relation it lacks privileges on: %v", rels)
	}

	_, err = Purge(bg, runtime, &dict.Dict{Pool: runtime}, u)
	if err == nil {
		t.Fatal("purge succeeded as a role that cannot read one of the user's tables")
	}
	if !strings.Contains(err.Error(), "hidden_user_notes") {
		t.Fatalf("error does not name the unreadable relation: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 1 {
		t.Fatal("a refused purge must leave the account intact")
	}
}

// poolAs opens a second pool on the same database as a different role. The
// throwaway cluster runs with `-A trust` over a unix socket, so no password is
// involved; the role name is unique per test because roles are cluster-wide
// while databases are not.
func poolAs(t *testing.T, admin *pgxpool.Pool, role string) *pgxpool.Pool {
	t.Helper()
	cc := admin.Config().ConnConfig
	q := url.Values{}
	q.Set("host", cc.Host) // a socket directory; must be escaped, not concatenated
	q.Set("port", strconv.Itoa(int(cc.Port)))
	q.Set("sslmode", "disable")
	dsn := "postgres://" + role + "@/" + cc.Database + "?" + q.Encode()
	p, err := pgxpool.New(bg, dsn)
	if err != nil {
		t.Fatalf("connect as %s: %v", role, err)
	}
	t.Cleanup(p.Close)
	return p
}

// A user_id column with no foreign key at all is one way a later task can leave
// rows behind: nothing cascades into it. The sweep catches it, and says so in
// the report rather than quietly covering for the schema.
func TestPurgeSweepsAUserScopedTableWithNoForeignKey(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	exec(t, pool, `CREATE TABLE later_task_rows (
	                 id bigserial PRIMARY KEY,
	                 user_id uuid NOT NULL,
	                 note text NOT NULL)`)
	seeders["public.later_task_rows"] = func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
		exec(t, pool, `INSERT INTO later_task_rows (user_id, note) VALUES ($1, 'x')`, u)
	}
	t.Cleanup(func() { delete(seeders, "public.later_task_rows") })

	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	rep, err := Purge(bg, pool, d, u)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n := rowsFor(t, pool, rel("later_task_rows"), u); n != 0 {
		t.Fatalf("later_task_rows still holds %d rows", n)
	}
	if !slices.Contains(rep.SweptWithoutCascade, "public.later_task_rows") {
		t.Fatalf("report does not flag the missing cascade: %+v", rep.SweptWithoutCascade)
	}
}

// The other two shapes of a user_id foreign key that is not ON DELETE CASCADE.
// SET NULL is the dangerous one: the rows survive with a blanked user_id, so
// every count-by-user_id in this package reads zero and a purge that trusted
// them would report complete success over data it had not deleted. Both are
// refused BEFORE anything is touched.
func TestPurgeRefusesAUserIDForeignKeyThatDoesNotCascade(t *testing.T) {
	for _, tc := range []struct{ name, action, wants string }{
		{name: "set null", action: "ON DELETE SET NULL", wants: "SET NULL"},
		{name: "no action", action: "", wants: "NO ACTION"},
		{name: "restrict", action: "ON DELETE RESTRICT", wants: "RESTRICT"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := pgtest.New(t)
			d := testDict(t, pool)
			exec(t, pool, `CREATE TABLE later_task_rows (
			                 id bigserial PRIMARY KEY,
			                 user_id uuid REFERENCES users(id) `+tc.action+`,
			                 note text NOT NULL)`)
			seeders["public.later_task_rows"] = func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) {
				exec(t, pool, `INSERT INTO later_task_rows (user_id, note) VALUES ($1, 'x')`, u)
			}
			t.Cleanup(func() { delete(seeders, "public.later_task_rows") })

			u := seedAFullyPopulatedUser(t, pool, "purge-me")
			_, err := Purge(bg, pool, d, u)
			if err == nil {
				t.Fatal("purge succeeded against a foreign key that does not cascade")
			}
			if !errors.Is(err, ErrIncomplete) {
				t.Fatalf("error is not ErrIncomplete: %v", err)
			}
			if !strings.Contains(err.Error(), "later_task_rows") || !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("error does not name the table and its action: %v", err)
			}
			if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 1 {
				t.Fatal("a refused purge must leave the account intact")
			}
		})
	}
}

func TestPurgeDoesNotTouchOtherUsers(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	victim := seedAFullyPopulatedUser(t, pool, "purge-me")
	bystander := seedAFullyPopulatedUser(t, pool, "leave-me")
	submitDictEntry(t, d, victim, "carrefour")
	submitDictEntry(t, d, bystander, "carrefour")

	if _, err := Purge(bg, pool, d, victim); err != nil {
		t.Fatalf("purge: %v", err)
	}

	rels, err := UserScopedTables(bg, pool)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rels {
		if n := rowsFor(t, pool, r, bystander); n == 0 {
			t.Fatalf("%s lost the bystander's rows", r)
		}
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, bystander); n != 1 {
		t.Fatal("the bystander's account is gone")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM dict_submissions`); n != 1 {
		t.Fatalf("dict_submissions holds %d rows, want the bystander's 1", n)
	}
}

// The quarantine trigger refuses any removal with no removal record. Account
// deletion is its one documented exemption, detected by the users row already
// being gone, so the purge has to arrive through the RI cascade and not with a
// DELETE of its own while the account still exists.
func TestPurgeSatisfiesTheQuarantineAndKeyHistoryTriggers(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")

	// Precondition: the triggers really are armed for a live account.
	if _, err := pool.Exec(bg, `DELETE FROM quarantine WHERE user_id = $1`, u); err == nil {
		t.Fatal("precondition: quarantine let an untraced delete through")
	}
	if _, err := pool.Exec(bg, `DELETE FROM key_history WHERE user_id = $1`, u); err == nil {
		t.Fatal("precondition: key_history let a delete through for a live user")
	}

	if _, err := Purge(bg, pool, d, u); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM quarantine_removals WHERE user_id = $1`, u); n != 0 {
		t.Fatal("the purge left a removal record behind: a record that outlives the purge")
	}
}

func TestPurgeIsIdempotentAndReportsAnUnknownUserAsNothingToDo(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "purge-me")
	if _, err := Purge(bg, pool, d, u); err != nil {
		t.Fatalf("first purge: %v", err)
	}
	rep, err := Purge(bg, pool, d, u)
	if err != nil {
		t.Fatalf("second purge: %v", err)
	}
	if len(rep.Users) != 0 {
		t.Fatalf("second purge claims to have deleted %v", rep.Users)
	}
}

// Without the HMAC key the purge cannot recompute the submitter pseudonyms, so
// it cannot prove it forgot them. Empty table: nothing to forget, proceed.
// Non-empty: refuse, loudly, naming the missing secret.
func TestPurgeWithoutADictKeyRefusesOnlyWhenSubmissionsExist(t *testing.T) {
	pool := pgtest.New(t)
	keyless := &dict.Dict{Pool: pool}

	clean := seedAFullyPopulatedUser(t, pool, "no-submissions")
	if _, err := Purge(bg, pool, keyless, clean); err != nil {
		t.Fatalf("purge with an empty dict_submissions: %v", err)
	}

	keyed := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "has-submissions")
	submitDictEntry(t, keyed, u, "carrefour")
	_, err := Purge(bg, pool, keyless, u)
	if err == nil {
		t.Fatal("purge succeeded without the key needed to forget the submitter")
	}
	if !strings.Contains(err.Error(), "LEDGER_DICT_HMAC_KEY") {
		t.Fatalf("error does not name the missing secret: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 1 {
		t.Fatal("a refused purge must leave the account intact")
	}
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

func TestEnforceRetentionPurgesOnlyUsersPastTheirDeadline(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	now := time.Now()

	overdue := seedAFullyPopulatedUser(t, pool, "overdue")
	current := seedAFullyPopulatedUser(t, pool, "current")
	if err := RecordConsent(bg, pool, overdue, "alpha-plaintext-v1", now.Add(-100*24*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := RecordConsent(bg, pool, current, "alpha-plaintext-v1", now.Add(-time.Hour), now.Add(30*24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	rep, err := EnforceRetention(bg, pool, d, now)
	if err != nil {
		t.Fatalf("enforce: %v", err)
	}
	if !slices.Contains(rep.Users, overdue) || slices.Contains(rep.Users, current) {
		t.Fatalf("enforce purged %v, want exactly [%s]", rep.Users, overdue)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, overdue); n != 0 {
		t.Fatal("the overdue account survived")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, current); n != 1 {
		t.Fatal("an account still inside its retention window was purged")
	}
}

// The measured failure this test exists for: EnforceRetention was correct and
// INERT. Nothing anywhere wrote user_consent, so a sweep a century past every
// deadline purged zero accounts and reported one as having no record. The fix
// was a caller (`ledgerd record-consent`); this pins the whole loop — record,
// list, enforce — so the enforcer can never again be the only half that exists.
func TestTheRecordedDeadlineIsWhatTheSweepActsOn(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "alpha-tester")
	signed := time.Now().Add(-180 * 24 * time.Hour)
	deadline := signed.Add(90 * 24 * time.Hour) // already past

	// The seeder writes a consent row like any other user-scoped table; drop it
	// to get back to the state a real account starts in, which is the state the
	// review measured: no record anywhere.
	exec(t, pool, `DELETE FROM user_consent WHERE user_id = $1`, u)

	// Nothing on file: the sweep must refuse to act and say so.
	before, err := EnforceRetention(bg, pool, d, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Users) != 0 || !slices.Contains(before.WithoutConsentRecord, u) {
		t.Fatalf("with no record on file the sweep must report and skip, got %+v", before)
	}

	if err := RecordConsent(bg, pool, u, "alpha-plaintext-v1", signed, deadline); err != nil {
		t.Fatal(err)
	}
	due, err := DueForRetention(bg, pool, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(due, u) {
		t.Fatalf("DueForRetention did not list the overdue account: %v", due)
	}

	after, err := EnforceRetention(bg, pool, d, time.Now())
	if err != nil {
		t.Fatalf("enforce: %v", err)
	}
	if !slices.Contains(after.Users, u) {
		t.Fatalf("the sweep purged %v, want the overdue account %s", after.Users, u)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, u); n != 0 {
		t.Fatal("the account survived its own retention deadline")
	}
}

// Re-consenting replaces the deadline rather than adding a second, ambiguous
// one — which is what makes extending an alpha's window possible at all.
func TestRecordConsentReplacesTheDeadline(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := seedAFullyPopulatedUser(t, pool, "alpha-tester")
	now := time.Now()
	if err := RecordConsent(bg, pool, u, "alpha-plaintext-v1", now.Add(-time.Hour), now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := RecordConsent(bg, pool, u, "alpha-plaintext-v2", now, now.Add(90*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM user_consent WHERE user_id = $1`, u); n != 1 {
		t.Fatalf("user_consent holds %d rows for one account; two deadlines is a question with no answer", n)
	}
	rep, err := EnforceRetention(bg, pool, d, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Users) != 0 {
		t.Fatalf("the extended account was purged against its OLD deadline: %v", rep.Users)
	}
}

// A user with no consent row has no recorded deadline. Purging them would turn
// a bug in the onboarding path into mass deletion, so they are REPORTED, and a
// report nobody reads is the operator's problem — silence would be ours.
func TestEnforceRetentionReportsUsersWithNoConsentRecordAndPurgesNothing(t *testing.T) {
	pool := pgtest.New(t)
	d := testDict(t, pool)
	u := newUser(t, pool, "never-consented")

	rep, err := EnforceRetention(bg, pool, d, time.Now())
	if err != nil {
		t.Fatalf("enforce: %v", err)
	}
	if len(rep.Users) != 0 {
		t.Fatalf("enforce purged %v with no consent record on file", rep.Users)
	}
	if !slices.Contains(rep.WithoutConsentRecord, u) {
		t.Fatalf("report does not name the user with no consent record: %+v", rep.WithoutConsentRecord)
	}
}

// ---------------------------------------------------------------------------
// The deletion challenge (spec §3.4's key-possession factor)
// ---------------------------------------------------------------------------

func TestChallengeAuthorizesOnlyAnEnrolledLiveKey(t *testing.T) {
	pool := pgtest.New(t)
	u := seedAFullyPopulatedUser(t, pool, "delete-me")
	c := &Challenges{Pool: pool}

	// The seeded roster key: writers + key_history share it.
	priv := deviceKey(t, u)

	nonce, err := c.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, DeletionMessage(nonce, u))
	if err := c.Authorize(bg, u, nonce, sig); err != nil {
		t.Fatalf("authorize with an enrolled key: %v", err)
	}

	// Replay: the nonce is single use.
	if err := c.Authorize(bg, u, nonce, sig); !errors.Is(err, ErrDeletionRejected) {
		t.Fatalf("replay = %v, want ErrDeletionRejected", err)
	}
}

func TestChallengeRefusesAnUnenrolledKey(t *testing.T) {
	pool := pgtest.New(t)
	u := seedAFullyPopulatedUser(t, pool, "delete-me")
	c := &Challenges{Pool: pool}

	_, stranger, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := c.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(stranger, DeletionMessage(nonce, u))
	if err := c.Authorize(bg, u, nonce, sig); !errors.Is(err, ErrDeletionRejected) {
		t.Fatalf("authorize with an unenrolled key = %v, want ErrDeletionRejected", err)
	}
}

func TestChallengeRefusesARevokedKey(t *testing.T) {
	pool := pgtest.New(t)
	u := seedAFullyPopulatedUser(t, pool, "delete-me")
	exec(t, pool, `UPDATE writers SET revoked_at = now() WHERE user_id = $1`, u)
	c := &Challenges{Pool: pool}

	priv := deviceKey(t, u)
	nonce, err := c.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, DeletionMessage(nonce, u))
	if err := c.Authorize(bg, u, nonce, sig); !errors.Is(err, ErrDeletionRejected) {
		t.Fatalf("authorize with a revoked key = %v, want ErrDeletionRejected", err)
	}
}

func TestChallengeRefusesAnotherAccountsNonce(t *testing.T) {
	pool := pgtest.New(t)
	mine := seedAFullyPopulatedUser(t, pool, "mine")
	theirs := seedAFullyPopulatedUser(t, pool, "theirs")
	c := &Challenges{Pool: pool}

	nonce, err := c.Issue(bg, theirs)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(deviceKey(t, mine), DeletionMessage(nonce, mine))
	if err := c.Authorize(bg, mine, nonce, sig); !errors.Is(err, ErrDeletionRejected) {
		t.Fatalf("authorize with another account's nonce = %v, want ErrDeletionRejected", err)
	}
}

func TestChallengeRefusesAnExpiredNonce(t *testing.T) {
	pool := pgtest.New(t)
	u := seedAFullyPopulatedUser(t, pool, "delete-me")
	now := time.Now()
	c := &Challenges{Pool: pool, Now: func() time.Time { return now }}

	nonce, err := c.Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	c.Now = func() time.Time { return now.Add(ChallengeTTL + time.Second) }
	sig := ed25519.Sign(deviceKey(t, u), DeletionMessage(nonce, u))
	if err := c.Authorize(bg, u, nonce, sig); !errors.Is(err, ErrDeletionRejected) {
		t.Fatalf("authorize with an expired nonce = %v, want ErrDeletionRejected", err)
	}
}

// A signature made for a writer registration or an address rotation must not
// delete the account. Two independent rails: the nonce comes from a different
// table, and the message carries its own domain prefix.
func TestDeletionMessageIsDomainSeparated(t *testing.T) {
	u := uuid.New()
	nonce := make([]byte, ChallengeNonceBytes)
	msg := DeletionMessage(nonce, u)
	if !strings.HasPrefix(string(msg), "ledger/v2 account-delete") {
		t.Fatalf("DeletionMessage has no domain prefix: %q", msg[:32])
	}
	other := DeletionMessage(nonce, uuid.New())
	if string(msg) == string(other) {
		t.Fatal("DeletionMessage does not bind the user id")
	}
}
