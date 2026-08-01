// Package seed holds the four published bank templates v2 starts from.
//
// They are the declarative port of v1's three Go parsers — internal/parse's
// DIBParser, ENBDParser and ENBDAlertParser — and the whole point of the port
// is that a bank format is data from here on: a broken anchor is fixed by
// publishing a new template version from the admin console, not by shipping a
// binary.
//
// # Four templates, three parsers
//
// v1's DIBParser handles two unrelated layouts behind one Matches, choosing
// between them with `isCard := strings.Contains(textBody, "إشعار مشتريات")` and
// an early return. That branch is control flow, and control flow is exactly
// what a declarative template does not have, so it becomes two templates whose
// Match blocks are each other's complement:
//
//	dib.card.v1     body_contains:     ["إشعار مشتريات"]
//	dib.account.v1  body_not_contains: ["إشعار مشتريات"]
//
// The pair is total and disjoint by construction: every DIB message reaches
// exactly one of them, which is what makes them equivalent to the branch rather
// than merely similar to it.
//
// # The Arabic anchors are copied, never typed
//
// internal/v2/tmpl/seed/gen: the JSON in this directory was produced by
// extracting the anchor literals out of internal/parse/dib.go's own source, so
// no anchor in this package has ever passed through a keyboard. A well-meaning
// spelling fix while copying — `الدفع إلى` for DIB's actual, hamza-less
// `الدفع الى` — produces a template that compiles, validates, publishes and
// then silently matches nothing across all 6,864 DIB messages in the corpus.
// TestSeedAnchorsAreByteIdenticalToV1 re-derives them from dib.go on every run
// so a later hand-edit cannot reintroduce that.
//
// # What makes these correct
//
// Not review. corpus_gate_test.go runs both implementations — v1's real
// Cascade and this package's templates through tmpl.Execute — over every
// message in a snapshot of the operator's three-year mailbox and requires
// identical output on all eight extracted fields. That gate is spec §3.5's
// ship condition for Phase 1, and docs/superpowers/specs/v2-seed-validation.md
// records the run.
package seed

import (
	"embed"
	"fmt"
	"io/fs"
	"path"
	"sort"

	"ledger/internal/v2/tmpl"
)

//go:embed *.json
var files embed.FS

// IDs are the four published template ids, in the order [Seed] returns them.
//
// dib.card.v1 precedes dib.account.v1 because that is the order v1's DIBParser
// tests them in; the two are mutually exclusive, so the order is documentation
// rather than behaviour. enbd.transfer.v1 precedes enbd.alert.v1 for the same
// reason — v1's Cascade lists ENBDParser before ENBDAlertParser.
var IDs = []string{
	"dib.card.v1",
	"dib.account.v1",
	"enbd.transfer.v1",
	"enbd.alert.v1",
}

// Seed returns the published seed set.
//
// It panics if any definition fails [tmpl.ValidateForPublish]. That is the
// right failure for embedded data: these files ship inside the binary, a
// definition that cannot be published is a definition no caller can do
// anything with, and the alternative — returning an error every caller
// forwards — turns a build-time fact into a runtime branch nobody tests.
// TestSeedDefinitionsArePublishable proves the panic is unreachable for the
// files as committed.
func Seed() []tmpl.Definition {
	defs, err := load()
	if err != nil {
		panic("seed: " + err.Error())
	}
	return defs
}

// Raw returns each seed's JSON exactly as committed, keyed by template id.
//
// The bytes, not the parsed form: the admin console shows an operator the
// template they would edit, and re-encoding a Definition would show them
// something else — key order, whitespace and the escaping of every Arabic
// anchor are all Go's choices, not the file's.
func Raw() map[string][]byte {
	out := make(map[string][]byte, len(IDs))
	for _, id := range IDs {
		b, err := files.ReadFile(id + ".json")
		if err != nil {
			panic("seed: " + err.Error())
		}
		out[id] = b
	}
	return out
}

// load reads, parses and validates every embedded definition.
func load() ([]tmpl.Definition, error) {
	names, err := fileNames()
	if err != nil {
		return nil, err
	}
	// The directory listing and IDs must agree in BOTH directions. A file
	// dropped in here that IDs does not name would ship unreviewed; an id IDs
	// names with no file would silently shrink the published set.
	want := append([]string(nil), IDs...)
	sort.Strings(want)
	if len(names) != len(want) {
		return nil, fmt.Errorf("the directory holds %v but IDs names %v", names, IDs)
	}
	for i := range names {
		if names[i] != want[i]+".json" {
			return nil, fmt.Errorf("the directory holds %v but IDs names %v", names, IDs)
		}
	}

	defs := make([]tmpl.Definition, 0, len(IDs))
	for _, id := range IDs {
		b, err := files.ReadFile(id + ".json")
		if err != nil {
			return nil, err
		}
		d, err := tmpl.ParseDefinition(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", id, err)
		}
		if d.ID != id {
			return nil, fmt.Errorf("%s.json declares id %q", id, d.ID)
		}
		if err := tmpl.ValidateForPublish(d); err != nil {
			return nil, fmt.Errorf("%s: %w", id, err)
		}
		defs = append(defs, d)
	}
	return defs, nil
}

// fileNames lists the embedded JSON files, sorted.
func fileNames() ([]string, error) {
	var out []string
	err := fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			out = append(out, path.Base(p))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}
