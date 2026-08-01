// Package corpus gives read-only, streaming access to a `.backup` copy of the
// v1 ledger SQLite database.
//
// v1's ingest_log holds the full, gzipped, byte-exact RFC822 of every message
// the live instance has ever received. That is the only source of real,
// DKIM- and ARC-signed bank mail available for testing v2's origin
// verification, so this package exists to turn it into committed fixtures
// (see ./cmd/extract-fixtures) without any test ever reaching for the live
// database.
//
// # The live database is off limits
//
// The v1 service is running. Opening its database file — even read-only, even
// through SQLite's `mode=ro` — takes locks and reads pages that a concurrent
// writer may be mutating, and a corrupted production database is not a
// recoverable mistake. [Open] therefore refuses any path under
// /var/lib/ledger. The sanctioned way in is a root-made snapshot:
//
//	sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '/scratch/corpus.db'"
//	sudo chown "$(id -un)" /scratch/corpus.db
package corpus

import (
	"bytes"
	"compress/gzip"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, registered as "sqlite"
)

// liveDir is the production data directory. Nothing in v2 may read from it.
const liveDir = "/var/lib/ledger"

// ErrLiveDatabase is returned by [Open] for any path under /var/lib/ledger.
var ErrLiveDatabase = errors.New("corpus: refusing to open the live v1 database")

// ErrStop halts [DB.Each] without reporting an error, like filepath.SkipAll.
var ErrStop = errors.New("corpus: stop iteration")

// Message is one row of v1's ingest_log.
type Message struct {
	ID         int64
	ReceivedAt time.Time
	FromAddr   string
	Subject    string
	// RawBody is the original RFC822 message as delivered, gunzipped if it was
	// stored compressed. It is byte-exact: header order, folding and CRLF line
	// endings all survive, which is what makes DKIM and ARC verifiable offline.
	RawBody []byte
}

// DB is a read-only handle on a corpus snapshot.
type DB struct {
	db   *sql.DB
	path string
}

// Open opens a snapshot of the v1 database read-only.
//
// It returns [ErrLiveDatabase] for any path resolving under /var/lib/ledger.
func Open(path string) (*DB, error) {
	if err := checkNotLive(path); err != nil {
		return nil, err
	}
	// mode=ro is belt-and-braces on top of the path check: even a snapshot
	// should never be written by a test.
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("corpus: open %s: %w", path, err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("corpus: open %s: %w", path, err)
	}
	return &DB{db: db, path: path}, nil
}

// checkNotLive rejects paths inside the production data directory.
//
// It compares cleaned absolute paths, so ".." games are caught, and follows
// symlinks when it can, so a symlink pointing into /var/lib/ledger is caught
// too. When the path does not exist yet, the symlink check is skipped and the
// lexical check stands on its own.
func checkNotLive(path string) error {
	candidates := []string{path}
	if abs, err := filepath.Abs(path); err == nil {
		candidates = append(candidates, abs)
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		if abs, err := filepath.Abs(real); err == nil {
			candidates = append(candidates, abs)
		}
	}
	for _, c := range candidates {
		c = filepath.Clean(c)
		if c == liveDir || strings.HasPrefix(c, liveDir+string(filepath.Separator)) {
			return fmt.Errorf("%w: %s is under %s; make a root `.backup` snapshot into scratch first", ErrLiveDatabase, path, liveDir)
		}
	}
	return nil
}

// Close releases the database handle.
func (d *DB) Close() error { return d.db.Close() }

// Path is the snapshot this handle was opened from.
func (d *DB) Path() string { return d.path }

// Count returns the number of rows in ingest_log.
//
// Callers must not hard-code the result: the live corpus grows every time the
// v1 instance ingests mail, so yesterday's count is tomorrow's false failure.
func (d *DB) Count() (int, error) {
	var n int
	if err := d.db.QueryRow(`SELECT count(*) FROM ingest_log`).Scan(&n); err != nil {
		return 0, fmt.Errorf("corpus: count: %w", err)
	}
	return n, nil
}

// Each streams every ingest_log row in id order, oldest first.
//
// The corpus is ~75 MB of compressed mail, so rows are decoded one at a time
// and never accumulated. Returning [ErrStop] from fn ends iteration without an
// error; any other error is returned to the caller.
//
// The Message passed to fn — in particular its RawBody — is only valid for the
// duration of the call. Copy anything you keep.
func (d *DB) Each(fn func(Message) error) error {
	rows, err := d.db.Query(`
		SELECT id, coalesce(received_at, ''), coalesce(from_addr, ''),
		       coalesce(subject, ''), raw_body
		FROM ingest_log
		ORDER BY id`)
	if err != nil {
		return fmt.Errorf("corpus: query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			m       Message
			recv    string
			rawBody []byte
		)
		if err := rows.Scan(&m.ID, &recv, &m.FromAddr, &m.Subject, &rawBody); err != nil {
			return fmt.Errorf("corpus: scan: %w", err)
		}
		if recv != "" {
			// v1 writes RFC3339 UTC; a malformed value is not worth aborting a
			// 7000-row scan over, so it simply leaves ReceivedAt zero.
			if t, err := time.Parse(time.RFC3339, recv); err == nil {
				m.ReceivedAt = t
			}
		}
		body, err := gunzip(rawBody)
		if err != nil {
			return fmt.Errorf("corpus: message %d: %w", m.ID, err)
		}
		m.RawBody = body

		if err := fn(m); err != nil {
			if errors.Is(err, ErrStop) {
				return rows.Err()
			}
			return err
		}
	}
	return rows.Err()
}

// gunzip decompresses b when it carries the gzip magic, and returns it
// untouched otherwise. v1 changed storage format mid-life, so both shapes
// appear in a single corpus.
func gunzip(b []byte) ([]byte, error) {
	if len(b) < 2 || b[0] != 0x1f || b[1] != 0x8b {
		return b, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("gunzip: %w", err)
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		return nil, fmt.Errorf("gunzip: %w", err)
	}
	return out, nil
}

// DefaultPath is the snapshot path from LEDGER_CORPUS_DB, or "" when unset.
func DefaultPath() string { return os.Getenv("LEDGER_CORPUS_DB") }

// Rule is one row of v1's merchant -> category rule table, resolved against the
// categories table so the category arrives as its NAME rather than a foreign
// key into a database v2 does not have.
type Rule struct {
	// MatchType is v1's 'contains' | 'exact' | 'regex'. Every rule in the
	// operator's live corpus is 'contains'; the other two are read faithfully
	// rather than assumed away, so a caller can decide what to do with them
	// (dict refuses 'regex' — see internal/v2/dict).
	MatchType string
	Pattern   string
	Category  string
	// Active mirrors v1's is_active. Inactive rules are returned, not
	// filtered: "the seed skipped 1 of 270 rules" is a fact the operator
	// should read in the output rather than infer from a count that silently
	// does not add up.
	Active bool
}

// Rules returns v1's categorization rules, oldest first.
//
// This is the operator's own accumulated knowledge — every manual and
// AI-confirmed categorization v1 ever wrote back — and it is the seed for v2's
// merchant dictionary (spec §3.6). It is read through this package rather than
// with a direct sql.Open so that it inherits [Open]'s refusal to touch the live
// database: the seed is a one-shot operator command, run by hand, which is
// exactly the situation in which someone points a tool at /var/lib/ledger.
//
// Duplicates are NOT collapsed here. v1's rule table contains both exact
// repeats and genuine conflicts (one pattern mapped to two different categories
// by two different confirmations), and resolving those is a decision for the
// caller with the seed's reconciliation output in front of them, not something
// to hide inside a reader.
func (d *DB) Rules() ([]Rule, error) {
	rows, err := d.db.Query(`
		SELECT r.match_type, r.pattern, c.name, r.is_active
		FROM rules r JOIN categories c ON c.id = r.category_id
		ORDER BY r.id`)
	if err != nil {
		return nil, fmt.Errorf("corpus: rules: %w", err)
	}
	defer rows.Close()
	var out []Rule
	for rows.Next() {
		var r Rule
		var active int
		if err := rows.Scan(&r.MatchType, &r.Pattern, &r.Category, &active); err != nil {
			return nil, fmt.Errorf("corpus: rules: %w", err)
		}
		r.Active = active != 0
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("corpus: rules: %w", err)
	}
	return out, nil
}
