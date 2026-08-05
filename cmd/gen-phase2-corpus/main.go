//go:build phase2corpus

// Command gen-phase2-corpus builds the Phase 2 benchmark corpus.
//
// # Build-tagged on purpose, and NOT a _test.go file
//
// It is behind `//go:build phase2corpus` so `go build ./...`, `go vet ./...` and
// `go test ./...` never trip it — it reads a database and writes files, which is
// not what any of those three should do. An earlier draft of the Phase 2 plan
// made it `internal/v2/blob/phase3vectors_test.go`: a generator disguised as a
// test, which read /var/lib/ledger and wrote committed artifacts. Its own test
// file carries the same tag; run it with
//
//	go test -tags phase2corpus ./cmd/gen-phase2-corpus/
//
// # What may be written where — read this before adding an output
//
// The corpus is derived from three years of the operator's real bank mail. This
// repository has a `gh pr create` workflow, so a committed corpus is that
// history one push away from GitHub.
//
//   - corpus.bin, corpus.db, recipient.key and the ops fixture are the real
//     data and a private key. They go to $W (spike/phase2/work, gitignored in
//     its entirety) and are never committed, never copied into conformance/, and
//     never printed to a terminal whose output ends up in a task report.
//   - manifest.json IS committed, and carries counts, sizes, public keys and
//     SALTED SHA-256 DIGESTS of the monthly bucket totals. Never the totals
//     themselves: a monthly need/want/saving figure is a real AED amount, and it
//     is small enough to guess at, which is why the digest is salted rather than
//     bare. The salt is committed because it is not a secret — it exists so the
//     digest is not a rainbow-table lookup of a four-figure number.
//   - vectors.json IS committed and is SYNTHETIC ONLY (--synthetic), from a
//     seeded PRNG with fabricated merchants and amounts. A fabricated record
//     pins the format exactly as well as a real one does.
//
// An earlier draft of the plan committed the sealed corpus and a vectors.json
// holding ten real transactions in cleartext. That is the finding this comment
// exists to prevent; it is recorded rather than quietly fixed.
//
// # Never open the live database directly
//
// /var/lib/ledger/ledger.db is the LIVE v1 production database on this box. The
// only acceptable route to its contents is a root-made read-only backup into
// scratch:
//
//	sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup $W/corpus.db"
//	sudo chown "$(id -un)" "$W/corpus.db"
//
// This program refuses a --db path under /var/lib/ledger for exactly that
// reason.
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
)

func main() {
	log.SetFlags(0)
	var (
		dbPath    = flag.String("db", "", "path to a root-made .backup copy of the v1 SQLite database")
		outPath   = flag.String("out", "", "where to write corpus.bin (must be under spike/phase2/work)")
		keyOut    = flag.String("key-out", "", "where to write the recipient private key, hex (never committed)")
		manOut    = flag.String("manifest", "", "where to write manifest.json (this one IS committed)")
		vecOut    = flag.String("vectors", "", "where to write synthetic vectors.json (--synthetic only)")
		opsOut    = flag.String("ops-out", "", "where to write the Task 1b op-log fixture (never committed)")
		userStr   = flag.String("user", "", "the account UUID the corpus is sealed for; it is bound into every AAD")
		synthetic = flag.Bool("synthetic", false, "generate fabricated records from --seed instead of reading --db")
		seed      = flag.Uint64("seed", 20260802, "PRNG seed for --synthetic")
		count     = flag.Int("count", 0, "--synthetic: how many records to generate (default 10 with --vectors, else 3683)")
		maxMerch  = flag.Int("max-merchant", 200, "truncate merchant_raw to this many bytes, as spike/phase0/blobgen did")
	)
	flag.Parse()

	if err := run(genArgs{
		dbPath: *dbPath, outPath: *outPath, keyOut: *keyOut, manOut: *manOut,
		vecOut: *vecOut, opsOut: *opsOut, userStr: *userStr,
		synthetic: *synthetic, seed: *seed, count: *count, maxMerchant: *maxMerch,
	}); err != nil {
		log.Fatalf("gen-phase2-corpus: %v", err)
	}
}

type genArgs struct {
	dbPath, outPath, keyOut, manOut, vecOut, opsOut, userStr string
	synthetic                                                bool
	seed                                                     uint64
	count, maxMerchant                                       int
}

func run(a genArgs) error {
	if a.userStr == "" {
		return fmt.Errorf("--user is required: the account UUID is bound into every record's AAD, so a corpus " +
			"generated without it can never be loaded")
	}
	user, err := uuid.Parse(a.userStr)
	if err != nil {
		return fmt.Errorf("--user %q: %w", a.userStr, err)
	}
	if a.synthetic == (a.dbPath != "") {
		return fmt.Errorf("give exactly one of --db or --synthetic")
	}
	if a.dbPath != "" {
		abs, err := filepath.Abs(a.dbPath)
		if err != nil {
			return err
		}
		if strings.HasPrefix(abs, "/var/lib/ledger") {
			return fmt.Errorf("%s is the LIVE v1 production database. Make a root .backup copy into "+
				"spike/phase2/work first and point --db at that", abs)
		}
	}
	if a.count == 0 {
		if a.synthetic && a.vecOut != "" && a.outPath == "" {
			a.count = 10
		} else {
			a.count = defaultCorpusSize
		}
	}

	var rows []txnRow
	if a.synthetic {
		rows = syntheticRows(a.seed, a.count)
	} else {
		rows, err = readV1Rows(a.dbPath, a.maxMerchant)
		if err != nil {
			return err
		}
	}
	if len(rows) == 0 {
		return fmt.Errorf("no source rows")
	}

	sealer, err := blob.NewEncSealer(nil)
	if err != nil {
		return err
	}

	// The op-log fixture comes first, because the monthly `home` digests are
	// computed from ITS rates. One generator, one fixture, one set of digests —
	// the plan's own note that a corpus of transaction records alone carries no
	// home_currency_set and no rate_set, so a currency-correct check against it
	// would be unsatisfiable.
	fixture := buildOpFixture(rows, a.seed)

	records, err := sealRecords(sealer, user, rows)
	if err != nil {
		return err
	}

	if a.outPath != "" {
		if err := writeRecords(a.outPath, records); err != nil {
			return err
		}
		log.Printf("wrote %d records of %d bytes to %s", len(records), recordSize, a.outPath)
	}
	if a.keyOut != "" {
		if err := writeSecret(a.keyOut, hex.EncodeToString(sealer.RecipientPriv())+"\n"); err != nil {
			return err
		}
		log.Printf("wrote the recipient private key to %s — NEVER commit this, never paste it into a report", a.keyOut)
	}
	if a.opsOut != "" {
		if err := writeJSON(a.opsOut, fixture, 0o600); err != nil {
			return err
		}
		log.Printf("wrote %d ops to %s", len(fixture.Entries), a.opsOut)
	}
	if a.manOut != "" {
		man, err := buildManifest(user, sealer, records, rows, fixture, a.synthetic)
		if err != nil {
			return err
		}
		if err := writeJSON(a.manOut, man, 0o644); err != nil {
			return err
		}
		log.Printf("wrote the manifest to %s (counts, sizes, public keys and SALTED digests only)", a.manOut)
	}
	if a.vecOut != "" {
		if !a.synthetic {
			return fmt.Errorf("--vectors requires --synthetic: committed vectors must never contain a real " +
				"merchant or a real amount")
		}
		v, err := buildVectors(sealer, user, rows, records)
		if err != nil {
			return err
		}
		if err := writeJSON(a.vecOut, v, 0o644); err != nil {
			return err
		}
		log.Printf("wrote %d synthetic vectors to %s", len(v.Vectors), a.vecOut)
	}
	return nil
}
