package arc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// FixtureLookup builds a [LookupTXT] from a recorded `dns.json` — the map Task
// 2's fixture extractor writes, `{"<name>": ["<txt record>", ...], ...}` — and
// returns it alongside the number of names it holds.
//
// # Why a recording, and why it must never fall through
//
// DKIM and ARC verification resolve a selector's public key over DNS. A test
// that did that live would depend on records the corpus's senders are free to
// rotate or retire, so it would start failing on a date nobody chose, for a
// reason that looks like a crypto bug. The recording makes verification
// deterministic and offline.
//
// A name that is not in the recording answers [ErrNoKey] and NEVER consults a
// resolver. A silent fallback would reintroduce exactly the dependency this
// exists to remove, and would do it invisibly — the test would pass on a
// networked machine and fail on an isolated one.
//
// # Matching names the way a resolver does
//
// A recording that stands in for DNS has to answer the questions DNS would
// answer, or every test using it runs against semantics that do not ship. DNS
// labels are case-insensitive (RFC 4343) and a trailing root dot names the same
// node; a Go map is neither, and go-msgauth builds its query straight out of a
// signature's d= and s= without folding either. So d=EmiratesNBD.com resolved
// in production and answered ErrNoKey here — a divergence in the safe
// direction, and still a recording that was deterministic about the wrong
// thing. Both the keys and the queried name are lowercased and stripped of a
// trailing dot.
//
// # Concurrency
//
// The returned function only reads the map, which is built once and never
// written again, so it is safe for concurrent use with no lock. That matters
// for its intended callers: an SMTP receiver verifies several messages at once.
func FixtureLookup(path string) (LookupTXT, int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, fmt.Errorf("arc: read dns fixtures: %w", err)
	}
	records, err := decodeFixtures(raw)
	if err != nil {
		return nil, 0, fmt.Errorf("arc: dns fixtures %s: %w", path, err)
	}
	return func(_ context.Context, name string) ([]string, error) {
		if v, ok := records[dnsName(name)]; ok && len(v) > 0 {
			return v, nil
		}
		return nil, ErrNoKey
	}, len(records), nil
}

func decodeFixtures(raw []byte) (map[string][]string, error) {
	var records map[string][]string
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, err
	}
	// Fold on the way in as well as on the way out: the recording is generated
	// from whatever d= and s= the corpus messages carry, and two spellings of
	// one name must not become two entries.
	folded := make(map[string][]string, len(records))
	for name, recs := range records {
		folded[dnsName(name)] = recs
	}
	return folded, nil
}

// dnsName is the form two spellings of the same DNS name agree on.
func dnsName(name string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
}
