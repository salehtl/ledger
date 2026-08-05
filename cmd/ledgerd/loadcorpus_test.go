package main

// Tests for `ledgerd load-corpus`. See loadcorpus.go.
//
// TestMain boots one throwaway Postgres cluster for this package, the same way
// every other v2 package with a database test does. Under scripts/v2-check.sh
// LEDGER_TEST_POSTGRES_URL is already exported, so this reuses the cluster the
// script booted and costs nothing; run standalone it pays one initdb.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/config"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type corpusFixture struct {
	dir        string
	binPath    string
	manPath    string
	man        corpusManifest
	sealer     blob.EncSealer
	plaintexts [][]byte
	records    [][]byte
}

// makeCorpus writes a real, v2-sealed, 1 KB-bucketed corpus for `user` into a
// temp directory, exactly as cmd/gen-phase2-corpus does. Nothing here touches a
// real database or a real transaction; the payloads are fabricated.
func makeCorpus(t *testing.T, user uuid.UUID, n int) corpusFixture {
	t.Helper()
	sealer, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatalf("NewEncSealer: %v", err)
	}
	f := corpusFixture{dir: t.TempDir(), sealer: sealer}
	var buf bytes.Buffer
	for i := 1; i <= n; i++ {
		plain := fmt.Appendf(nil,
			`{"iid":"fixture-%04d","posted_at":"2026-06-%02dT10:00:00Z","amount":%d,"currency":"AED","direction":"debit","merchant":"FIXTURE MERCHANT %d","bucket":"need","status":"confirmed"}`,
			i, (i%28)+1, 1000+i, i)
		env := blob.Envelope{UserID: user, Stream: blob.StreamHot, WriterID: oplog.IngestWriterID, WriterCounter: int64(i)}
		sealed, err := sealer.Seal(env, plain)
		if err != nil {
			t.Fatalf("seal record %d: %v", i, err)
		}
		if sealed.SizeBucket != 1<<10 {
			t.Fatalf("record %d landed in bucket %d, want 1024", i, sealed.SizeBucket)
		}
		buf.Write(sealed.Bytes)
		f.plaintexts = append(f.plaintexts, plain)
		f.records = append(f.records, sealed.Bytes)
	}
	f.binPath = filepath.Join(f.dir, "corpus.bin")
	if err := os.WriteFile(f.binPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		t.Fatal(err)
	}
	f.man = corpusManifest{
		Count:           n,
		RecordSize:      1 << 10,
		EnvelopeVersion: blob.EncVersion,
		Stream:          blob.StreamHot,
		WriterID:        oplog.IngestWriterID,
		UserID:          user.String(),
		RecipientPub:    hex.EncodeToString(sealer.RecipientPub()),
		AADTemplate:     user.String() + "|hot|ingest|<counter>",
		Synthetic:       true,
	}
	f.man.Check.Salt = hex.EncodeToString(salt)
	f.man.Check.DigestAlg = "sha256"
	f.man.Check.Months = map[string]map[string]string{}
	f.manPath = f.writeManifest(t, f.man)
	return f
}

func (f corpusFixture) writeManifest(t *testing.T, m corpusManifest) string {
	t.Helper()
	p := filepath.Join(f.dir, "manifest.json")
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func (f corpusFixture) opts(user uuid.UUID) loadCorpusOptions {
	return loadCorpusOptions{
		UserID:          user,
		Stream:          blob.StreamHot,
		RecordsPath:     f.binPath,
		ManifestPath:    f.manPath,
		EnvelopeVersion: blob.EncVersion,
		Singleton:       true,
	}
}

func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(bg) }()
	sub := make([]byte, 32)
	if _, err := rand.Read(sub); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := tx.QueryRow(bg, `INSERT INTO users (idp, idp_sub_hash) VALUES ('apple', $1) RETURNING id`, sub).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := oplog.EnsureSeqRow(bg, tx, id); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}
	return id
}

// seedClientRows puts a SECOND writer on the same stream before the corpus is
// loaded. Without it this suite could not tell "the loader allocates ingest
// counters per (writer, stream)" from "the loader happens to be the only writer
// and any counter scheme works" — the one-of-something trap.
func seedClientRows(t *testing.T, pool *pgxpool.Pool, user uuid.UUID, writer string, n int) {
	t.Helper()
	var prev [32]byte
	rows := make([]oplog.Row, 0, n)
	for i := 1; i <= n; i++ {
		env := blob.Envelope{UserID: user, Stream: blob.StreamHot, WriterID: writer, WriterCounter: int64(i)}
		sealed, err := blob.PlaintextSealer{}.Seal(env, fmt.Appendf(nil, `{"device":%q,"n":%d}`, writer, i))
		if err != nil {
			t.Fatal(err)
		}
		h := blob.Hash(prev, sealed)
		p := prev
		rows = append(rows, oplog.Row{
			UserID: user, Stream: blob.StreamHot, WriterID: writer, WriterCounter: int64(i),
			TypeFlag: oplog.TypeFlagEdit, Blob: sealed.Bytes, SizeBucket: sealed.SizeBucket,
			PrevHash: p[:], BlobHash: h[:], CreatedAt: time.Unix(1, 0).UTC(),
		})
		prev = h
	}
	if _, err := (&oplog.Appender{Pool: pool}).AppendClient(bg, user, writer, blob.StreamHot, rows); err != nil {
		t.Fatalf("seed client rows: %v", err)
	}
}

// ---------------------------------------------------------------------------
// The gate the whole design turns on
// ---------------------------------------------------------------------------

func TestLoadCorpusRefusesBatchedMode(t *testing.T) {
	o := loadCorpusOptions{UserID: uuid.New(), Singleton: false}
	_, err := loadCorpus(bg, nil, o)
	if !errors.Is(err, ErrBatchedCorpus) {
		t.Fatalf("err = %v, want ErrBatchedCorpus", err)
	}
	// The message must name the caveat, because the next person to want a fast
	// load has to be able to find out why they cannot have one.
	if !strings.Contains(err.Error(), "Caveat 7") {
		t.Fatalf("the refusal does not name RESULTS.md Caveat 7: %v", err)
	}
	if !strings.Contains(err.Error(), "RESULTS.md") {
		t.Fatalf("the refusal does not name RESULTS.md: %v", err)
	}
	// And it must refuse BEFORE touching the database — the nil pool above is
	// the assertion; a driver panic would fail this test.
}

// ---------------------------------------------------------------------------
// The load itself
// ---------------------------------------------------------------------------

func TestLoadCorpusWritesSingletonsThroughTheIngestAppender(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	seedClientRows(t, pool, user, "dev-a", 3)

	const n = 12
	f := makeCorpus(t, user, n)

	res, err := loadCorpus(bg, pool, f.opts(user))
	if err != nil {
		t.Fatalf("loadCorpus: %v", err)
	}
	if res.Loaded != n {
		t.Fatalf("loaded %d, want %d", res.Loaded, n)
	}
	if res.HeadCounter != n {
		t.Fatalf("ingest head counter %d, want %d", res.HeadCounter, n)
	}

	// N records in, N rows out, contiguous ingest counters 1..N — measured by
	// re-reading the table, not by trusting the loader's own tally.
	rows, err := pool.Query(bg,
		`SELECT seq, writer_id, writer_counter, type_flag, size_bucket, blob
		   FROM op_log WHERE user_id = $1 AND stream = 'hot' AND writer_id = 'ingest'
		   ORDER BY writer_counter`, user)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := 0
	var lastSeq int64
	for rows.Next() {
		var seq, counter int64
		var writer, typeFlag string
		var bucket int
		var raw []byte
		if err := rows.Scan(&seq, &writer, &counter, &typeFlag, &bucket, &raw); err != nil {
			t.Fatal(err)
		}
		got++
		if counter != int64(got) {
			t.Fatalf("row %d has counter %d", got, counter)
		}
		if typeFlag != oplog.TypeFlagIngest {
			t.Fatalf("row %d has type_flag %q, want %q", got, typeFlag, oplog.TypeFlagIngest)
		}
		if bucket != 1<<10 || len(raw) != 1<<10 {
			t.Fatalf("row %d: size_bucket %d, %d bytes", got, bucket, len(raw))
		}
		// Byte-identical to the generated record. This is the property that
		// makes the manifest describe what the device will actually receive.
		if !bytes.Equal(raw, f.records[got-1]) {
			t.Fatalf("row %d's stored blob is not the generated record", got)
		}
		if seq <= lastSeq {
			t.Fatalf("row %d: seq %d does not follow %d", got, seq, lastSeq)
		}
		lastSeq = seq
		// And it still opens, to the original plaintext, under the recipient key.
		env := blob.Envelope{UserID: user, Stream: blob.StreamHot, WriterID: oplog.IngestWriterID, WriterCounter: counter}
		plain, err := f.sealer.Open(env, blob.Sealed{Bytes: raw, SizeBucket: bucket})
		if err != nil {
			t.Fatalf("row %d does not open: %v", got, err)
		}
		if !bytes.Equal(plain, f.plaintexts[got-1]) {
			t.Fatalf("row %d opened to the wrong plaintext", got)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if got != n {
		t.Fatalf("%d ingest rows, want %d", got, n)
	}

	// The second writer is untouched: counters are per (writer, stream), which a
	// single-writer fixture could not have shown.
	var devRows int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM op_log WHERE user_id = $1 AND stream='hot' AND writer_id='dev-a'`, user).Scan(&devRows); err != nil {
		t.Fatal(err)
	}
	if devRows != 3 {
		t.Fatalf("dev-a has %d rows, want 3", devRows)
	}
	// Seqs are global per user, so the ingest rows must sit ABOVE the client's.
	if res.FirstSeq <= 3 {
		t.Fatalf("first ingest seq is %d; the three client rows should already have taken 1..3", res.FirstSeq)
	}
}

// A singleton load is 3,683 individual appends in production. Prove the loop
// really does one row per call rather than quietly batching — otherwise
// `fetchMs` is measured against the wrong transport shape and the gate is void.
func TestEveryRecordBecomesItsOwnRow(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	const n = 9
	f := makeCorpus(t, user, n)
	if _, err := loadCorpus(bg, pool, f.opts(user)); err != nil {
		t.Fatalf("loadCorpus: %v", err)
	}
	var distinctSeqs, rowCount int
	if err := pool.QueryRow(bg,
		`SELECT count(DISTINCT seq), count(*) FROM op_log WHERE user_id=$1 AND writer_id='ingest'`, user).
		Scan(&distinctSeqs, &rowCount); err != nil {
		t.Fatal(err)
	}
	if rowCount != n || distinctSeqs != n {
		t.Fatalf("%d rows across %d seqs, want %d and %d", rowCount, distinctSeqs, n, n)
	}
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

func TestLoadCorpusRefusesAMultiUserDatabase(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	other := insertUser(t, pool)
	_ = other
	f := makeCorpus(t, user, 4)
	_, err := loadCorpus(bg, pool, f.opts(user))
	if err == nil || !strings.Contains(err.Error(), "holds 2 users") {
		t.Fatalf("err = %v, want a refusal naming the user count", err)
	}
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM op_log`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d rows were written before the refusal", n)
	}
}

func TestLoadCorpusRefusesAnUnknownUser(t *testing.T) {
	pool := pgtest.New(t)
	insertUser(t, pool)
	ghost := uuid.New()
	f := makeCorpus(t, ghost, 4)
	_, err := loadCorpus(bg, pool, f.opts(ghost))
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("err = %v, want an unknown-user refusal", err)
	}
}

func TestLoadCorpusRefusesANonEmptyIngestChain(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	f := makeCorpus(t, user, 5)
	if _, err := loadCorpus(bg, pool, f.opts(user)); err != nil {
		t.Fatalf("first load: %v", err)
	}
	_, err := loadCorpus(bg, pool, f.opts(user))
	if err == nil || !strings.Contains(err.Error(), "empty chain") {
		t.Fatalf("second load err = %v, want a refusal naming the non-empty chain", err)
	}
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM op_log WHERE writer_id='ingest'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("%d ingest rows after the refused second load, want 5", n)
	}
}

func TestLoadCorpusRefusesACorpusSealedForAnotherUser(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	f := makeCorpus(t, uuid.New(), 4) // sealed for somebody else
	o := f.opts(user)
	_, err := loadCorpus(bg, pool, o)
	if err == nil || !strings.Contains(err.Error(), "was sealed for user") {
		t.Fatalf("err = %v, want a user-mismatch refusal", err)
	}
}

// The generator asserts record_size == 1024. The loader asserts it again,
// because a manifest is a file and files get hand-edited.
func TestLoadCorpusRefusesARecordSizeThatIsNotTheKilobyteBucket(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	f := makeCorpus(t, user, 4)
	m := f.man
	m.RecordSize = 4 << 10
	o := f.opts(user)
	o.ManifestPath = f.writeManifest(t, m)
	_, err := loadCorpus(bg, pool, o)
	if err == nil || !strings.Contains(err.Error(), "want 1024") {
		t.Fatalf("err = %v, want a record-size refusal", err)
	}
}

func TestLoadCorpusRefusesACorpusFileOfTheWrongLength(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	f := makeCorpus(t, user, 4)
	raw, err := os.ReadFile(f.binPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.binPath, raw[:len(raw)-1], 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = loadCorpus(bg, pool, f.opts(user))
	if err == nil || !strings.Contains(err.Error(), "the manifest says") {
		t.Fatalf("err = %v, want a length refusal", err)
	}
}

func TestLoadCorpusRefusesAVersionMismatch(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	f := makeCorpus(t, user, 4)
	o := f.opts(user)
	o.EnvelopeVersion = 1
	_, err := loadCorpus(bg, pool, o)
	if err == nil || !strings.Contains(err.Error(), "envelope version") {
		t.Fatalf("err = %v, want an envelope-version refusal", err)
	}
}

// A record whose bytes have been altered no longer carries the AAD for its
// position, and the pass-through sealer must refuse it rather than storing a
// blob nothing can open.
func TestLoadCorpusRefusesATamperedRecord(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	f := makeCorpus(t, user, 6)
	raw, err := os.ReadFile(f.binPath)
	if err != nil {
		t.Fatal(err)
	}
	// Byte 3 is the first byte of the embedded AAD (version, then a 2-byte
	// length), so this moves the record to a position it was not sealed for.
	raw[3*(1<<10)+3] ^= 0x20
	if err := os.WriteFile(f.binPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = loadCorpus(bg, pool, f.opts(user))
	if err == nil {
		t.Fatal("a tampered record loaded")
	}
	if !strings.Contains(err.Error(), "sealed for") {
		t.Fatalf("err = %v, want a position mismatch", err)
	}
}

func TestPresealedSealerRefusesARecordAtTheWrongPosition(t *testing.T) {
	user := uuid.New()
	s, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatal(err)
	}
	env := func(c int64) blob.Envelope {
		return blob.Envelope{UserID: user, Stream: blob.StreamHot, WriterID: oplog.IngestWriterID, WriterCounter: c}
	}
	r1, err := s.Seal(env(1), []byte(`{"n":1}`))
	if err != nil {
		t.Fatal(err)
	}
	r2, err := s.Seal(env(2), []byte(`{"n":2}`))
	if err != nil {
		t.Fatal(err)
	}
	p := &presealedSealer{records: [][]byte{r1.Bytes, r2.Bytes}, version: blob.EncVersion}

	if _, err := p.Seal(env(1), r1.Bytes); err != nil {
		t.Fatalf("the right record at the right position: %v", err)
	}
	// Record 2's bytes offered at counter 1: the plaintext/record check catches
	// it before the AAD does, and either way it must not be stored.
	if _, err := p.Seal(env(1), r2.Bytes); err == nil {
		t.Fatal("record 2 was accepted at counter 1")
	}
	if _, err := p.Seal(env(3), r1.Bytes); err == nil {
		t.Fatal("a counter past the end of the corpus was accepted")
	}
	if _, err := p.Open(env(1), r1); err == nil {
		t.Fatal("presealedSealer.Open must refuse rather than pretending")
	}
}

// ---------------------------------------------------------------------------
// Wiring — the "written, tested green, never wired" guard
// ---------------------------------------------------------------------------

func TestLoadCorpusIsInTheDispatchTable(t *testing.T) {
	if modeHandlers["load-corpus"] == nil {
		t.Fatal("load-corpus has no dispatch entry; the subcommand is unreachable")
	}
}

// The flags are registered from loadcorpus.go into main.go's FlagSet. If the one
// line in parseArgs that does that is ever dropped, `ledgerd load-corpus --in x`
// fails with "flag provided but not defined" — so parse a real command line
// rather than calling the registrar directly, which would pass either way.
func TestParseArgsAcceptsTheLoadCorpusFlags(t *testing.T) {
	a, err := parseArgs([]string{
		"load-corpus", "--user", "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
		"--in", "/tmp/corpus.bin", "--manifest", "/tmp/manifest.json",
		"--singleton", "--envelope-version", "2", "--stream", "hot",
	})
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if a.mode != "load-corpus" {
		t.Fatalf("mode = %q", a.mode)
	}
	o, err := loadCorpusFlags.options()
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	if o.UserID.String() != "6f9619ff-8b86-d011-b42d-00cf4fc964ff" ||
		o.RecordsPath != "/tmp/corpus.bin" || o.ManifestPath != "/tmp/manifest.json" ||
		!o.Singleton || o.EnvelopeVersion != 2 || o.Stream != "hot" {
		t.Fatalf("options did not carry the command line: %+v", o)
	}
}

// --singleton defaults to false, which is what makes forgetting it an error
// rather than a silently different measurement.
func TestSingletonIsOffByDefault(t *testing.T) {
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	user := ""
	fs.StringVar(&user, "user", "", "")
	registerLoadCorpusFlags(fs, &user)
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if loadCorpusFlags.singleton {
		t.Fatal("--singleton defaults to true; forgetting it would silently produce a batched measurement")
	}
}

func TestRunLoadCorpusRefusesBadArgumentsBeforeTouchingPostgres(t *testing.T) {
	saved := loadCorpusFlags
	t.Cleanup(func() { loadCorpusFlags = saved })
	empty := ""
	loadCorpusFlags = loadCorpusFlagSet{user: &empty}
	// config.Config's DSN is empty, so reaching pg.Open would produce a
	// connection error rather than this one.
	err := modeHandlers["load-corpus"](config.Config{})
	if err == nil || !strings.Contains(err.Error(), "--user is required") {
		t.Fatalf("err = %v, want the argument refusal", err)
	}
	bad := "not-a-uuid"
	loadCorpusFlags = loadCorpusFlagSet{user: &bad}
	if err := modeHandlers["load-corpus"](config.Config{}); err == nil || !strings.Contains(err.Error(), "not-a-uuid") {
		t.Fatalf("err = %v, want a uuid parse refusal", err)
	}
}

// ---------------------------------------------------------------------------
// Cross-checks on the framing the loader depends on
// ---------------------------------------------------------------------------

// oplog.Row.validate calls blob.EmbeddedAAD — the V1 function — on every row it
// stores, including the v2 rows this loader writes. It happens to be correct
// there because it derives BOTH ends of its slice from aadLen. That is
// load-bearing and fragile: branch blob.SealedRegion on version without
// branching blob.EmbeddedAAD and every corpus load starts failing. Pinned here
// so the breakage is a named test rather than a mystery.
func TestTheV1EmbeddedAADReaderStillWorksOnAV2Frame(t *testing.T) {
	user := uuid.New()
	s, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatal(err)
	}
	env := blob.Envelope{UserID: user, Stream: blob.StreamHot, WriterID: oplog.IngestWriterID, WriterCounter: 42}
	sealed, err := s.Seal(env, []byte(`{"n":42}`))
	if err != nil {
		t.Fatal(err)
	}
	v1, err := blob.EmbeddedAAD(sealed.Bytes)
	if err != nil {
		t.Fatalf("blob.EmbeddedAAD on a v2 frame: %v", err)
	}
	v2, err := blob.EmbeddedAADV(sealed.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(v1, v2) || !bytes.Equal(v1, env.AAD()) {
		t.Fatalf("v1 reader %q, v2 reader %q, envelope %q", v1, v2, env.AAD())
	}
}
