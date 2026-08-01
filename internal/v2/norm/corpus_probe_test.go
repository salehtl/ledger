package norm

import (
	"os"
	"strings"
	"testing"

	v1 "ledger/internal/parse"
	"ledger/internal/v2/corpus"
)

// TestCorpusDivergenceFromV1IsOnlyTheTrimSet is a PROBE, not the gate. Task 16
// owns the equivalence gate; this measures the same thing while the normalizer
// is being written, so that "only the documented things differ" is a number
// somebody checked rather than a claim somebody made.
//
// It runs the full v1 pipeline — parse.BodyText then parse.Unwrap, exactly as
// internal/parse/processor.go composes them — against Normalize over every
// message in a scratch copy of the v1 corpus, and asserts that the only
// difference is attributable to the trim set.
//
// The check is deliberately NOT an allowlist of message ids. It reduces both
// texts to a canonical form in which each line is trimmed by BOTH sets and
// lines that either set empties are dropped, then requires exact equality. Any
// difference that is not a trim-set difference survives canonicalization and
// fails the test, and the check keeps working as the corpus grows.
//
// The two divergences it tolerates, both deliberate:
//
//  1. The explicit trim set is not Go's strings.TrimSpace. It adds U+FEFF and
//     omits U+0085, U+2000-U+200A and U+202F, so a line made only of those
//     characters is dropped by one implementation and kept by the other. Both
//     directions occur in the corpus.
//  2. The raw-body fallback on a MIME parse failure, which v1 lacks. No corpus
//     message reaches it (0 of 6998 fail to parse), so it contributes nothing
//     to the numbers below — which is exactly why it needs a derived fixture.
func TestCorpusDivergenceFromV1IsOnlyTheTrimSet(t *testing.T) {
	path := os.Getenv("LEDGER_CORPUS_DB")
	if path == "" {
		t.Skip("LEDGER_CORPUS_DB is unset; this probe needs a scratch .backup of the v1 corpus")
	}
	db, err := corpus.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var total, v1Failed, textDiff, subjDiff int
	var diffIDs, unexplained []int64

	err = db.Each(func(m corpus.Message) error {
		total++

		v1Text, berr := v1.BodyText(m.RawBody)
		if berr != nil {
			// v1 gives up and records nothing; v2's raw fallback is expected to
			// differ. Nothing in the corpus reaches this branch today.
			v1Failed++
			return nil
		}
		_, v1Subject, _, v1Body := v1.Unwrap(m.FromAddr, m.Subject, v1Text)

		got, nerr := Normalize(CurrentVersion, m.RawBody, m.ReceivedAt)
		if nerr != nil {
			unexplained = append(unexplained, m.ID)
			return nil
		}
		if got.Subject != v1Subject {
			subjDiff++
			unexplained = append(unexplained, m.ID)
		}
		if got.Text != v1Body {
			textDiff++
			diffIDs = append(diffIDs, m.ID)
			if canonicalLines(got.Text) != canonicalLines(v1Body) {
				unexplained = append(unexplained, m.ID)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Logf("corpus %d messages: %d v1 parse failures, %d text differences %v, "+
		"%d subject differences, %d NOT explained by the trim set",
		total, v1Failed, textDiff, diffIDs, subjDiff, len(unexplained))

	if len(unexplained) > 0 {
		show := unexplained
		if len(show) > 20 {
			show = show[:20]
		}
		t.Fatalf("%d messages diverge from v1 for a reason that is not the trim set: %v",
			len(unexplained), show)
	}
}

// canonicalLines reduces a normalized text to the form both implementations
// must agree on: every line trimmed by BOTH the explicit set and Go's
// strings.TrimSpace, with lines either set empties removed.
func canonicalLines(s string) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if t := trimExplicit(strings.TrimSpace(l)); t != "" {
			out = append(out, t)
		}
	}
	return strings.Join(out, "\n")
}
