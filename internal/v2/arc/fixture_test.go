package arc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The recorded map Task 2 extracted. It is the one the exit test will drive
// real signed corpus mail against, so this test reads THAT file rather than a
// synthetic one: a fixture file whose shape drifted from the loader would be
// discovered on the exit test and nowhere earlier.
const recordedDNS = "../origin/testdata/dns.json"

func TestFixtureLookupServesTheRecordedRecords(t *testing.T) {
	lookup, n, err := FixtureLookup(recordedDNS)
	if err != nil {
		t.Fatalf("FixtureLookup(%s) = %v", recordedDNS, err)
	}
	if n == 0 {
		t.Fatal("the recorded DNS fixture holds no records")
	}
	// A selector the corpus actually uses. Read from the file rather than
	// hard-coded, so a re-record cannot make this test a lie.
	name := anyName(t, recordedDNS)
	recs, err := lookup(context.Background(), name)
	if err != nil {
		t.Fatalf("lookup(%q) = %v", name, err)
	}
	if len(recs) == 0 {
		t.Fatalf("lookup(%q) returned no records", name)
	}
}

// A name that is not in the recording must answer ErrNoKey and never fall
// through to a live resolver. The whole point of the flag is that verification
// is deterministic and offline; a silent fallback would make a test pass or
// fail depending on the network.
func TestFixtureLookupRefusesAnUnrecordedName(t *testing.T) {
	lookup, _, err := FixtureLookup(recordedDNS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lookup(context.Background(), "nothing._domainkey.example.invalid"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("lookup of an unrecorded name = %v, want ErrNoKey", err)
	}
}

func TestFixtureLookupRejectsAMissingOrMalformedFile(t *testing.T) {
	if _, _, err := FixtureLookup(filepath.Join(t.TempDir(), "absent.json")); err == nil {
		t.Fatal("FixtureLookup of a missing file returned no error")
	}
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"a": "not-a-list"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := FixtureLookup(bad); err == nil {
		t.Fatal("FixtureLookup of a malformed file returned no error")
	}
}

func anyName(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m, err := decodeFixtures(b)
	if err != nil {
		t.Fatal(err)
	}
	for name, recs := range m {
		if len(recs) > 0 {
			return name
		}
	}
	t.Fatal("no usable name in the recorded fixture")
	return ""
}
