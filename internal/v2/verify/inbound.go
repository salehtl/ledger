package verify

// The staleness gate on [BlindSpots].
//
// # Why this file exists
//
// The blind-spot list was prose. It was accurate when it was written and stale
// one commit later: the relay landed a second inbound mode that writes a message
// to disk and no parse_diagnostics row at all, so its mail is invisible to
// inbound_total — and nothing failed, because nothing held the list to the code.
//
// A list of "what this instrument cannot see" that only a careful reader keeps
// honest is not a safety property, it is a comment. So the one dimension that
// can be enumerated FROM THE SOURCE is enumerated from the source: every way a
// message enters this system is an implementation of smtpd.Handler, and
// [InboundPaths] must classify each one as either writing diagnostics or being
// a named blind spot. A third delivery mode cannot arrive silently.
//
// # What this gate does NOT prove
//
// It proves every DELIVERY PATH is classified. It does not prove the
// classification is true, and it says nothing about the refusal paths inside
// smtpd — those are still prose, still re-derived by hand from go-smtp's source,
// and still the larger half of the list. This closes the failure that actually
// happened rather than claiming to close the category.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// InboundPath classifies one implementation of smtpd.Handler.
type InboundPath struct {
	// Package is where the handler lives, for an operator reading a failure.
	Package string
	// WritesDiagnostics is true when mail arriving through this path produces a
	// parse_diagnostics row, and is therefore counted in inbound_total.
	WritesDiagnostics bool
	// BlindSpot names the [BlindSpots] entry covering this path when it does
	// NOT write diagnostics. Required in that case, empty otherwise.
	BlindSpot string
}

// InboundPaths classifies every smtpd.Handler in the tree.
//
// Keyed by the receiver TYPE NAME, which is what the scanner can see without
// building the packages — internal/v2/relay imports internal/v2/smtpd, and a
// verifier that imported both to reflect over them would drag the whole server
// into a package whose job is to read counts.
var InboundPaths = map[string]InboundPath{
	// The primary. Every arrival writes a row; this is what inbound_total
	// counts, and everything else in this file is about what does not.
	"Pipeline": {Package: "internal/v2/ingest", WritesDiagnostics: true},

	// The backup MX. It spools to disk and drains to the primary later, and it
	// deliberately has no database at all — a second box on the internet holding
	// a copy of the schema is the thing the design refuses. So its mail is
	// counted when (and only when) it reaches the primary.
	"Relay": {
		Package:   "internal/v2/relay",
		BlindSpot: "relay_spool_writes_no_diagnostics",
	},
}

// deliverRe matches an implementation of smtpd.Handler.
//
// Matching source text rather than types is a deliberate trade: it cannot be
// fooled by anything a reviewer would not also miss, it needs no build, and its
// failure mode is caught by the test asserting that the two KNOWN handlers are
// found — so a regex that silently matched nothing cannot produce a green run.
var deliverRe = regexp.MustCompile(
	`func \(\w+ \*?(\w+)\) Deliver\(ctx context\.Context, d (smtpd\.)?Delivery\) error`)

// inboundHandlers returns the receiver type names of every smtpd.Handler
// implementation under root, sorted.
//
// Test files are skipped: a fake handler in a test is not a way mail enters
// production, and counting them would make this gate fire on every new test.
func inboundHandlers(root string) ([]string, error) {
	seen := map[string]bool{}
	err := filepath.WalkDir(filepath.Join(root, "v2"), func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range deliverRe.FindAllStringSubmatch(string(src), -1) {
			seen[m[1]] = true
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("verify: scan for inbound handlers: %w", err)
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}
