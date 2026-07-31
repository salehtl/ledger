package corpus

import (
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
)

// corpusPath returns the scratch .backup copy of the v1 database, or skips.
// The corpus is never committed, so every test that needs it is opt-in via
// LEDGER_CORPUS_DB pointing at a root-made `.backup` copy.
func corpusPath(t *testing.T) string {
	t.Helper()
	p := os.Getenv("LEDGER_CORPUS_DB")
	if p == "" {
		t.Skip("LEDGER_CORPUS_DB not set; see docs/superpowers/specs/v2-arc-spike.md for how to make the .backup copy")
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("LEDGER_CORPUS_DB=%s: %v", p, err)
	}
	return p
}

func TestOpenRefusesTheLiveDatabase(t *testing.T) {
	for _, path := range []string{
		"/var/lib/ledger/ledger.db",
		"/var/lib/ledger/ledger.db-wal",
		"/var/lib/ledger/../ledger/ledger.db",
		"/var/lib/ledger",
	} {
		db, err := Open(path)
		if err == nil {
			db.Close()
			t.Fatalf("Open(%q) succeeded; it must refuse the live v1 database", path)
		}
		if !errors.Is(err, ErrLiveDatabase) {
			t.Fatalf("Open(%q) = %v; want ErrLiveDatabase", path, err)
		}
		// The error must name the constraint so a future reader understands why.
		if !strings.Contains(err.Error(), "/var/lib/ledger") {
			t.Fatalf("Open(%q) error %q does not name the forbidden directory", path, err)
		}
	}
}

func TestCountMatchesTheDatabase(t *testing.T) {
	path := corpusPath(t)

	// Independent ground truth: a plain query through database/sql. Asserting
	// against a constant would rot — the live corpus grows every time the v1
	// instance ingests mail (6994 at plan time, 6998 at extraction time).
	raw, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var want int
	if err := raw.QueryRow(`SELECT count(*) FROM ingest_log`).Scan(&want); err != nil {
		t.Fatal(err)
	}

	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	got, err := db.Count()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("Count() = %d, want %d", got, want)
	}
	if got < 6994 {
		t.Fatalf("Count() = %d; the corpus only ever grows and was 6994 at plan time", got)
	}
}

func TestEachStreamsGunzippedRFC822(t *testing.T) {
	db, err := Open(corpusPath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var seen, withHeaders int
	err = db.Each(func(m Message) error {
		seen++
		if len(m.RawBody) == 0 {
			return nil
		}
		if m.RawBody[0] == 0x1f && m.RawBody[1] == 0x8b {
			t.Fatalf("message %d: RawBody still gzipped", m.ID)
		}
		// Real RFC822: CRLF header block terminated by a blank line.
		if i := strings.Index(string(m.RawBody), "\r\n\r\n"); i > 0 {
			withHeaders++
		}
		if seen >= 200 {
			return ErrStop
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != 200 {
		t.Fatalf("Each stopped after %d messages, want 200 (ErrStop must halt cleanly)", seen)
	}
	if withHeaders != 200 {
		t.Fatalf("%d/200 messages had a CRLF header block; raw_body is not byte-exact RFC822", withHeaders)
	}
}
