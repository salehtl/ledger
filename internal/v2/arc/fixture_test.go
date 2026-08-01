package arc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
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

// The recording stands in for a resolver, so it has to answer the questions a
// resolver would answer the same way. DNS labels are case-insensitive (RFC 4343)
// and a trailing root dot names the same node, and go-msgauth builds its query
// straight out of the signature's d= and s= with no folding of either — so
// d=EmiratesNBD.com or d=emiratesnbd.com. resolve in production and used to miss
// here, turning a verifiable message into a temperror for tests only. Divergence
// was in the safe direction, but it meant every test in dkim_test.go ran against
// different semantics from the ones that ship.
func TestFixtureLookupMatchesNamesTheWayDNSDoes(t *testing.T) {
	lookup, _, err := FixtureLookup(recordedDNS)
	if err != nil {
		t.Fatal(err)
	}
	name := anyName(t, recordedDNS)
	want, err := lookup(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{
		strings.ToUpper(name),
		strings.ToTitle(name),
		name + ".",
		strings.ToUpper(name) + ".",
	} {
		got, err := lookup(context.Background(), variant)
		if err != nil {
			t.Fatalf("lookup(%q) = %v, want the same answer as %q", variant, err, name)
		}
		if !slices.Equal(got, want) {
			t.Fatalf("lookup(%q) = %v, want %v", variant, got, want)
		}
	}
}

// A recording whose keys are written in mixed case must serve them too: the
// file is generated from whatever d= the corpus messages carry.
func TestFixtureLookupNormalizesTheRecordingItself(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dns.json")
	if err := os.WriteFile(path, []byte(`{"S1._DomainKey.Example.COM.": ["v=DKIM1; p=AA"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lookup, n, err := FixtureLookup(path)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("got %d records, want 1", n)
	}
	if _, err := lookup(context.Background(), "s1._domainkey.example.com"); err != nil {
		t.Fatalf("lookup = %v, want the record", err)
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
