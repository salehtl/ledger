package main

// loadcorpus.go — `ledgerd load-corpus`, the sealed-corpus loader.
//
// # Why this exists at all
//
// Task 1 and Task 28 both measure a cold restore of ~3,683 ingest singletons.
// Neither is executable without this command, and an earlier draft of the Phase
// 2 plan assumed the corpus could simply be pulled from a running server. It
// cannot:
//
//   - P3 brings up an EMPTY database.
//   - POST /api/v1/sync caps an upload at 8 blobs / 12 MiB.
//   - The server rejects a client authoring as the `ingest` writer with 403.
//   - The only path that creates ingest singletons is real SMTP delivery, and
//     nothing is going to deliver 3,683 messages.
//
// The obvious workaround — client-authoring the corpus — batches into ~5 blobs,
// which measures `fetchMs` against a BATCHED transport. That is
// spike/phase0/RESULTS.md Caveat 7 verbatim: the exact error Phase 0 made and
// the one the whole gate exists to avoid repeating. Hence --singleton is not
// optional and [ErrBatchedCorpus] names the caveat.
//
// # How it stays honest
//
// It writes through [oplog.Appender.AppendIngest] — the same function the SMTP
// pipeline calls — so seq allocation, per-stream counters and the ingest chain
// are computed by production code and the resulting rows are indistinguishable
// from real arrivals to every reader. It does NOT touch the HTTP layer, so
// neither the 403 nor the 8-blob page cap applies.
//
// It does not seal anything either. The records arrive pre-sealed at envelope
// framing version 2 (blob.EncSealer, a BENCHMARK instrument — see
// internal/v2/blob/encv2.go), because the whole point of the gate is to measure
// against Phase 3's shape rather than against Phase 2's plaintext gunzip. The
// sealer this command hands the appender is a pass-through that asserts each
// record was sealed for exactly the position the appender assigned it.
//
// # Guards
//
// Admin-only in the only sense a CLI can be: it runs on the box, against the
// configured DSN, and it REFUSES a database holding more than one user. That is
// the guard that matters — a benchmark corpus loaded into a multi-user beta
// database would put 3,683 fabricated ingest rows into somebody's account.

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/config"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pg"
)

// ErrBatchedCorpus is returned when the caller asks for anything other than
// singleton loading. Its text names the caveat on purpose: the next person to
// want a fast load needs to read why they cannot have one.
var ErrBatchedCorpus = errors.New(
	"load-corpus: --singleton is not optional in Phase 2. Batched loading measures fetchMs against a " +
		"batched transport, which is spike/phase0/RESULTS.md Caveat 7 — \"only the crypto shape was modeled " +
		"faithfully; the transport shape was not\" — the exact error the Phase 2 gate exists to avoid " +
		"repeating. If you genuinely need a batched corpus for something else, add a separate mode and say " +
		"in its own doc comment that its numbers may not be used for T_rest")

// corpusManifest is the committed description of a generated corpus. It carries
// counts, sizes, public keys and SALTED DIGESTS — never an amount, never a
// merchant. See cmd/gen-phase2-corpus for how it is produced and
// conformance/crypto/README.md for why the digests are salted.
type corpusManifest struct {
	Count           int    `json:"count"`
	RecordSize      int    `json:"record_size"`
	EnvelopeVersion int    `json:"envelope_version"`
	Stream          string `json:"stream"`
	WriterID        string `json:"writer_id"`
	UserID          string `json:"user_id"`
	RecipientPub    string `json:"recipient_pub"`
	AADTemplate     string `json:"aad_template"`
	Synthetic       bool   `json:"synthetic"`
	Check           struct {
		Salt      string                       `json:"salt"`
		DigestAlg string                       `json:"digest_alg"`
		Months    map[string]map[string]string `json:"months"`
	} `json:"check"`
}

type loadCorpusOptions struct {
	UserID          uuid.UUID
	Stream          string
	RecordsPath     string
	ManifestPath    string
	EnvelopeVersion int
	// Singleton must be true. See ErrBatchedCorpus.
	Singleton bool
	// Progress, if set, is called every ProgressEvery records.
	Progress      func(done, total int)
	ProgressEvery int
}

type loadCorpusResult struct {
	Loaded      int
	RecordSize  int
	FirstSeq    int64
	LastSeq     int64
	HeadCounter int64
	Elapsed     time.Duration
}

// runLoadCorpus is the dispatch entry. It is deliberately thin: everything
// worth testing is in [loadCorpus], which takes an explicit options struct and
// a pool, so cmd/ledgerd's tests can drive it against a scratch cluster without
// going near a command line.
func runLoadCorpus(cfg config.Config) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	opts, err := loadCorpusFlags.options()
	if err != nil {
		return err
	}
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd load-corpus: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd load-corpus: migrate: %w", err)
	}

	opts.ProgressEvery = 250
	opts.Progress = func(done, total int) { log.Printf("ledgerd load-corpus: %d/%d records", done, total) }

	res, err := loadCorpus(ctx, pool, opts)
	if err != nil {
		return err
	}
	log.Printf("ledgerd load-corpus: loaded %d records of %d bytes as %s|%s singletons, seq %d..%d, head counter %d, in %s",
		res.Loaded, res.RecordSize, oplog.IngestWriterID, opts.Stream, res.FirstSeq, res.LastSeq, res.HeadCounter, res.Elapsed.Round(time.Millisecond))
	return nil
}

// loadCorpus is the whole command. Every guard it applies is stated in the
// package comment; the order below is the order they must run in, because each
// one makes the next one's error message meaningful.
func loadCorpus(ctx context.Context, pool *pgxpool.Pool, opts loadCorpusOptions) (loadCorpusResult, error) {
	started := time.Now()
	if !opts.Singleton {
		return loadCorpusResult{}, ErrBatchedCorpus
	}
	if opts.Stream == "" {
		opts.Stream = blob.StreamHot
	}
	if opts.Stream != blob.StreamHot {
		// Not a limitation worth lifting speculatively: the cold stream carries
		// raw email bodies (invariant I16) and a cold corpus would be a
		// different measurement with different bucket sizes.
		return loadCorpusResult{}, fmt.Errorf("load-corpus: stream is %q; the benchmark corpus is %q only", opts.Stream, blob.StreamHot)
	}
	if opts.EnvelopeVersion == 0 {
		opts.EnvelopeVersion = blob.EncVersion
	}
	if _, err := blob.FrameLayoutFor(byte(opts.EnvelopeVersion)); err != nil {
		return loadCorpusResult{}, fmt.Errorf("load-corpus: --envelope-version %d: %w", opts.EnvelopeVersion, err)
	}
	if opts.UserID == uuid.Nil {
		return loadCorpusResult{}, errors.New("load-corpus: --user is required")
	}

	man, err := readCorpusManifest(opts.ManifestPath)
	if err != nil {
		return loadCorpusResult{}, err
	}
	if man.EnvelopeVersion != opts.EnvelopeVersion {
		return loadCorpusResult{}, fmt.Errorf("load-corpus: manifest says envelope version %d, --envelope-version says %d",
			man.EnvelopeVersion, opts.EnvelopeVersion)
	}
	// The AAD binds the user id, so a corpus generated for one account cannot be
	// loaded into another. Caught here, with a sentence, rather than 3,683 times
	// as "blob was sealed for position ...".
	if man.UserID != opts.UserID.String() {
		return loadCorpusResult{}, fmt.Errorf("load-corpus: the corpus was sealed for user %s but --user is %s; "+
			"regenerate it with --user %s", man.UserID, opts.UserID, opts.UserID)
	}
	if man.Stream != "" && man.Stream != opts.Stream {
		return loadCorpusResult{}, fmt.Errorf("load-corpus: manifest stream is %q, --stream is %q", man.Stream, opts.Stream)
	}

	records, err := readCorpusRecords(opts.RecordsPath, man)
	if err != nil {
		return loadCorpusResult{}, err
	}

	if err := refuseMultiUser(ctx, pool, opts.UserID); err != nil {
		return loadCorpusResult{}, err
	}

	app := &oplog.Appender{Pool: pool}
	head, _, err := app.Head(ctx, opts.UserID, oplog.IngestWriterID, opts.Stream)
	if err != nil {
		return loadCorpusResult{}, fmt.Errorf("load-corpus: read ingest head: %w", err)
	}
	if head != 0 {
		// Each record's AAD names its counter, so the corpus can only be loaded
		// onto an empty chain. Loading onto a non-empty one would fail at record
		// 1 anyway (oplog.Row.validate rejects a blob sealed for another
		// position); refusing up front says why.
		return loadCorpusResult{}, fmt.Errorf("load-corpus: %s|%s already has %d records; the corpus is sealed at "+
			"counters 1..%d and can only be loaded onto an empty chain — purge the user and re-create it",
			oplog.IngestWriterID, opts.Stream, head, len(records))
	}

	// The pass-through sealer. Keyed on the counter the appender assigns rather
	// than on a call index, so a retried or aborted transaction cannot slide the
	// corpus by one record.
	sealer := &presealedSealer{records: records, version: byte(opts.EnvelopeVersion)}

	res := loadCorpusResult{RecordSize: man.RecordSize}
	for i := range records {
		seqs, err := (&oplog.Appender{Pool: pool, Sealer: sealer}).AppendIngest(ctx, opts.UserID, []oplog.IngestBlob{{
			Stream: opts.Stream,
			// The "plaintext" IS the pre-sealed record: presealedSealer returns
			// it unchanged after asserting it belongs at the position the
			// appender chose. Passing a placeholder instead would mean the
			// appender's own length guards checked nothing real.
			Plaintext: records[i],
			CreatedAt: time.Unix(0, 0).UTC().Add(time.Duration(i) * time.Second),
		}})
		if err != nil {
			return res, fmt.Errorf("load-corpus: append record %d/%d: %w", i+1, len(records), err)
		}
		if len(seqs) != 1 {
			return res, fmt.Errorf("load-corpus: record %d: appender returned %d seqs, want 1", i+1, len(seqs))
		}
		if res.FirstSeq == 0 {
			res.FirstSeq = seqs[0]
		}
		res.LastSeq = seqs[0]
		res.Loaded++
		if opts.Progress != nil && opts.ProgressEvery > 0 && res.Loaded%opts.ProgressEvery == 0 {
			opts.Progress(res.Loaded, len(records))
		}
	}
	if sealer.used != len(records) {
		return res, fmt.Errorf("load-corpus: the sealer was called %d times for %d records", sealer.used, len(records))
	}

	// Read the chain back and verify it from genesis. This is the check that
	// makes the load trustworthy, and it is deliberately not derived from
	// anything the write path computed: it re-reads the stored rows and re-runs
	// production's own oplog.VerifyChain over them.
	if err := verifyLoadedChain(ctx, pool, opts, len(records)); err != nil {
		return res, err
	}
	hc, _, err := app.Head(ctx, opts.UserID, oplog.IngestWriterID, opts.Stream)
	if err != nil {
		return res, fmt.Errorf("load-corpus: read head after load: %w", err)
	}
	res.HeadCounter = hc
	res.Elapsed = time.Since(started)
	return res, nil
}

// verifyLoadedChain re-reads every stored row and asserts three independent
// things: that there are exactly N of them, that their ingest counters are
// contiguous 1..N, and that oplog.VerifyChain accepts them from genesis.
func verifyLoadedChain(ctx context.Context, pool *pgxpool.Pool, opts loadCorpusOptions, want int) error {
	var rows []oplog.Row
	after := int64(0)
	for {
		// maxBytes is generous but finite: 3,683 KiB of blobs is ~3.7 MB and a
		// single unbounded read would be the same fetch-storm shape the Phase 0
		// post-mortem blames for a >500 MB RSS.
		page, err := oplog.Read(ctx, pool, opts.UserID, opts.Stream, after, 500, 8<<20)
		if err != nil {
			return fmt.Errorf("load-corpus: read back: %w", err)
		}
		if len(page) == 0 {
			break
		}
		after = page[len(page)-1].Seq
		// Filtered to the ingest writer, because a stream carries every writer's
		// rows and the device may well have authored some of its own. Chains are
		// per (writer_id, stream) — verifying a mixed set from genesis would
		// report a break that is not there.
		for _, r := range page {
			if r.WriterID == oplog.IngestWriterID {
				rows = append(rows, r)
			}
		}
	}
	if len(rows) != want {
		return fmt.Errorf("load-corpus: %d ingest rows stored, %d records loaded", len(rows), want)
	}
	for i, r := range rows {
		if r.WriterCounter != int64(i+1) {
			return fmt.Errorf("load-corpus: row %d has counter %d, want %d: the ingest counters are not contiguous",
				i, r.WriterCounter, i+1)
		}
	}
	if err := oplog.VerifyChain(rows, 0, blob.ZeroHash); err != nil {
		return fmt.Errorf("load-corpus: the loaded chain does not verify from genesis: %w", err)
	}
	return nil
}

// refuseMultiUser is the guard that stops a benchmark corpus landing in a beta
// account. It counts users rather than checking a flag, because a flag is
// something an operator sets wrong at 11pm.
func refuseMultiUser(ctx context.Context, pool *pgxpool.Pool, target uuid.UUID) error {
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return fmt.Errorf("load-corpus: count users: %w", err)
	}
	if n == 0 {
		return errors.New("load-corpus: this database has no users; sign in on the device first")
	}
	if n > 1 {
		return fmt.Errorf("load-corpus: this database holds %d users. load-corpus writes %s singletons and is a "+
			"BENCHMARK instrument; it refuses to run anywhere that could be a real deployment", n, oplog.IngestWriterID)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, target).Scan(&exists); err != nil {
		return fmt.Errorf("load-corpus: look up user: %w", err)
	}
	if !exists {
		return fmt.Errorf("load-corpus: user %s does not exist in this database", target)
	}
	return nil
}

func readCorpusManifest(path string) (corpusManifest, error) {
	if path == "" {
		return corpusManifest{}, errors.New("load-corpus: --manifest is required")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return corpusManifest{}, fmt.Errorf("load-corpus: read manifest: %w", err)
	}
	var m corpusManifest
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return corpusManifest{}, fmt.Errorf("load-corpus: parse manifest %s: %w", path, err)
	}
	switch {
	case m.Count <= 0:
		return corpusManifest{}, fmt.Errorf("load-corpus: manifest count is %d", m.Count)
	case m.RecordSize <= 0:
		return corpusManifest{}, fmt.Errorf("load-corpus: manifest record_size is %d", m.RecordSize)
	case m.WriterID != oplog.IngestWriterID:
		return corpusManifest{}, fmt.Errorf("load-corpus: manifest writer_id is %q, want %q", m.WriterID, oplog.IngestWriterID)
	}
	if _, err := hex.DecodeString(m.RecipientPub); err != nil || len(m.RecipientPub) != 64 {
		return corpusManifest{}, fmt.Errorf("load-corpus: manifest recipient_pub is not 32 hex-encoded bytes")
	}
	return m, nil
}

// readCorpusRecords slices a fixed-width corpus file into records and checks
// every one of them against the manifest before a single row is written.
//
// The fixed width is asserted, not assumed: the plan's own review found an
// earlier draft claiming records were both "1 KB-bucket-padded" and
// "fixed-width", which are only compatible if every record really does land in
// the 1 KB bucket. A mixed-width corpus would silently invalidate the offsets
// array the native batch API is driven by and every per-blob figure derived
// from it.
func readCorpusRecords(path string, man corpusManifest) ([][]byte, error) {
	if path == "" {
		return nil, errors.New("load-corpus: --in is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("load-corpus: read corpus: %w", err)
	}
	if man.RecordSize != 1<<10 {
		return nil, fmt.Errorf("load-corpus: manifest record_size is %d, want 1024: every benchmark record must "+
			"land in the 1 KB bucket or the offsets array is meaningless", man.RecordSize)
	}
	if len(raw) != man.Count*man.RecordSize {
		return nil, fmt.Errorf("load-corpus: %s is %d bytes; the manifest says %d records of %d bytes (%d)",
			path, len(raw), man.Count, man.RecordSize, man.Count*man.RecordSize)
	}
	out := make([][]byte, man.Count)
	for i := range out {
		out[i] = raw[i*man.RecordSize : (i+1)*man.RecordSize]
		if got := int(out[i][0]); got != man.EnvelopeVersion {
			return nil, fmt.Errorf("load-corpus: record %d has envelope version %d, manifest says %d", i, got, man.EnvelopeVersion)
		}
	}
	return out, nil
}

// presealedSealer hands the appender bytes that are already framed and sealed.
//
// It is a blob.Sealer so that AppendIngest — production's own function, with
// production's seq allocation, counter allocation and chain computation — does
// the writing. The Seal method's only real work is refusing to hand back a
// record that was sealed for a different position than the appender asked for.
type presealedSealer struct {
	records [][]byte
	version byte
	used    int
}

var _ blob.Sealer = (*presealedSealer)(nil)

func (p *presealedSealer) Seal(e blob.Envelope, plaintext []byte) (blob.Sealed, error) {
	i := e.WriterCounter - 1
	if i < 0 || i >= int64(len(p.records)) {
		return blob.Sealed{}, fmt.Errorf("load-corpus: the appender assigned counter %d; the corpus has %d records",
			e.WriterCounter, len(p.records))
	}
	rec := p.records[i]
	// The caller passed the record itself; if these differ the loop and the
	// counter have come apart and the corpus would be stored out of order.
	if !bytes.Equal(plaintext, rec) {
		return blob.Sealed{}, fmt.Errorf("load-corpus: record %d does not match the plaintext offered at counter %d",
			i, e.WriterCounter)
	}
	if rec[0] != p.version {
		return blob.Sealed{}, fmt.Errorf("load-corpus: record %d is envelope version %d, want %d", i, rec[0], p.version)
	}
	aad, err := blob.EmbeddedAADV(rec)
	if err != nil {
		return blob.Sealed{}, fmt.Errorf("load-corpus: record %d framing: %w", i, err)
	}
	if want := e.AAD(); !bytes.Equal(aad, want) {
		return blob.Sealed{}, fmt.Errorf("load-corpus: record %d was sealed for %q but the appender assigned %q",
			i, aad, want)
	}
	p.used++
	return blob.Sealed{Bytes: rec, SizeBucket: len(rec)}, nil
}

// Open is never called on this path. It refuses rather than returning the
// framed bytes, because a caller that reached for it has confused a
// pass-through with a sealer.
func (p *presealedSealer) Open(blob.Envelope, blob.Sealed) ([]byte, error) {
	return nil, errors.New("load-corpus: presealedSealer cannot open; use blob.EncSealer with the recipient key")
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

// loadCorpusFlags holds this mode's own command line. It lives here rather than
// in main.go's args struct so that cmd/ledgerd/main.go carries exactly two added
// lines for this whole feature — the modeHandlers entry and the one call below.
// That file is edited by several concurrent sessions and every line of it this
// task touches is a line that can sweep somebody else's work.
//
// The flags are registered into main.go's ONE FlagSet rather than a second,
// mode-specific parser, because a second parser would be a second place the
// "mode comes first" rule has to be reimplemented — see parseArgs' doc comment.
type loadCorpusFlagSet struct {
	// user aliases main.go's shared --user flag. It is a POINTER because
	// registration happens before parsing: the value is read in options(), which
	// runs from the handler, long after fs.Parse has filled it in.
	user            *string
	in              string
	manifest        string
	stream          string
	singleton       bool
	envelopeVersion int
}

var loadCorpusFlags loadCorpusFlagSet

// registerLoadCorpusFlags is called from parseArgs with the shared FlagSet and a
// pointer to the shared --user flag.
func registerLoadCorpusFlags(fs *flag.FlagSet, user *string) {
	loadCorpusFlags.user = user
	fs.StringVar(&loadCorpusFlags.in, "in", "",
		"load-corpus: path to the generated corpus.bin (never a committed file; see spike/phase2/)")
	fs.StringVar(&loadCorpusFlags.manifest, "manifest", "",
		"load-corpus: path to the corpus manifest.json")
	fs.StringVar(&loadCorpusFlags.stream, "stream", blob.StreamHot,
		"load-corpus: which stream to write (hot only)")
	fs.BoolVar(&loadCorpusFlags.singleton, "singleton", false,
		"load-corpus: REQUIRED — write one blob per record, the shape RESULTS.md Caveat 7 says must be measured")
	fs.IntVar(&loadCorpusFlags.envelopeVersion, "envelope-version", blob.EncVersion,
		"load-corpus: the envelope framing version the corpus was generated at")
}

func (f *loadCorpusFlagSet) options() (loadCorpusOptions, error) {
	if f.user == nil || *f.user == "" {
		return loadCorpusOptions{}, errors.New("ledgerd load-corpus: --user is required")
	}
	id, err := uuid.Parse(*f.user)
	if err != nil {
		return loadCorpusOptions{}, fmt.Errorf("ledgerd load-corpus: --user %q: %w", *f.user, err)
	}
	return loadCorpusOptions{
		UserID:          id,
		Stream:          f.stream,
		RecordsPath:     f.in,
		ManifestPath:    f.manifest,
		EnvelopeVersion: f.envelopeVersion,
		Singleton:       f.singleton,
	}, nil
}
