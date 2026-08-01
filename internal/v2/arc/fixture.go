package arc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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
		if v, ok := records[name]; ok && len(v) > 0 {
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
	return records, nil
}
