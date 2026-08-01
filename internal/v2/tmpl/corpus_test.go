package tmpl

// corpus_test.go writes conformance/templates/*.json — the shared half of the
// dual-executor contract for the EXECUTOR, as conformance/dialect/patterns.json
// is for the dialect.
//
// The dialect fixture proves the two validators agree about which patterns are
// legal, and the two engines agree about what those patterns match. Neither
// claim says anything about the executor built on top: first-entry-wins,
// override, on_match, the typed conversions, the three date layouts, the
// empty-group diagnostic and the required-field gate are all decisions ABOVE
// the regex engine, and every one of them is a place two hand-written
// implementations can differ while every regex in the template behaves
// identically.
//
// So this file runs the published seed templates over the operator's real v1
// mail — the same 7,002-message corpus the normalizer conformance is cut from —
// and records what Go's executor produced, field by field. The TypeScript side
// (client/src/tmpl/conformance.test.ts) re-runs the same inputs and demands the
// same answer. Neither side recomputes the other's expectation.
//
// # Why the inputs are already normalized
//
// A case carries norm.Result.Subject and norm.Result.Text, not raw RFC822. The
// normalizer has its own conformance set (conformance/normalizer/) which pins
// Go and TypeScript to byte-identical output over the same corpus; feeding raw
// mail in here would make every template disagreement indistinguishable from a
// normalizer disagreement. Two layers, two fixtures, two failures that name
// themselves.
//
// # Why one file per template rather than one per case
//
// The brief sketched one JSON file per case, each carrying its own copy of the
// definition. At the 500-case cap that is 1,500 files and about a megabyte of
// duplicated definition, in a directory nobody can read. One file per template
// carries the definition once and keeps `ls` meaningful; the TypeScript runner
// still declares one `test()` per case, so a failure still names the single
// message that broke.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/corpus"
	"ledger/internal/v2/norm"
)

const (
	templateConformanceDir = "../../../conformance/templates"
	// templateFixtureCap bounds the cases written per template. The cap exists
	// so the committed set stays reviewable, NOT because it is the whole check:
	// crossexec_test.go exports every message the corpus holds, and Task 21's
	// gate is the full corpus. Sampling is by even stride over the corpus in id
	// order, which is chronological, so the three years are represented in
	// proportion rather than the fixture being three months of whatever sorted
	// first.
	templateFixtureCap = 500
)

// seedTemplateFiles are the published seed templates, in the order their files
// are written. Named explicitly rather than globbed: a regeneration must not
// silently pick up a template someone dropped into testdata/.
var seedTemplateFiles = []string{
	"dib.card.v1.json",
	"dib.account.v1.json",
	"enbd.alert.v1.json",
}

// templateFixture is one committed file.
type templateFixture struct {
	Note          string `json:"note"`
	Spec          string `json:"spec"`
	SchemaVersion int    `json:"schema_version"`
	Template      string `json:"template"`
	// Kind is "corpus" (real v1 mail, regenerated only from a snapshot of the
	// operator's mailbox) or "synthetic" (hand-written inputs for the shapes
	// the corpus contains none of, regenerable anywhere). The distinction is
	// worth carrying: a suite of only the second kind proves the executor
	// agrees with itself about inputs someone imagined.
	Kind              string `json:"kind"`
	NormalizerVersion int    `json:"normalizer_version"`
	// Definition is the template's own JSON, verbatim from testdata, so a case
	// is executable with nothing else.
	Definition json.RawMessage `json:"definition"`
	Cases      []templateCase  `json:"cases"`
}

type templateCase struct {
	Name   string `json:"name"`
	Source string `json:"source"`
	// Subject and body are base64 for the same reason the normalizer fixtures
	// are: they carry CR, U+FEFF, bidi controls and Arabic, and a JSON string
	// is not the place to find out which of those a reviewer's editor rewrote.
	SubjectBase64        string         `json:"subject_base64"`
	NormalizedBodyBase64 string         `json:"normalized_body_base64"`
	Expect               templateExpect `json:"expect"`
}

// templateExpect is what Go's executor produced. Every field is recorded on
// every case, including the ones where the template did NOT match: an
// executor that returns a partial extraction where the other returns a zero
// one is a difference the diagnostics ledger would report differently, and
// checking only the matched cases would not see it.
type templateExpect struct {
	Matched bool `json:"matched"`
	// Error is the sentinel Execute returned, as a stable string. "" means nil.
	Error string `json:"error"`
	// AmountMinor is a DECIMAL STRING. int64 does not survive JSON in
	// JavaScript — 9,007,199,254,740,993 parses to ...992 — and the TypeScript
	// executor produces a BigInt, so the wire form is the one both can read
	// exactly.
	AmountMinor string `json:"amount_minor"`
	Currency    string `json:"currency"`
	Direction   string `json:"direction"`
	// PostedAt is RFC3339 in UTC, or "" for the zero time (date_from=email, or
	// a body date nothing produced).
	PostedAt    string   `json:"posted_at"`
	Merchant    string   `json:"merchant"`
	Last4       string   `json:"last4"`
	IsTransfer  bool     `json:"is_transfer"`
	EmptyGroups []string `json:"empty_groups"`
}

// errorKind maps Execute's error to the stable string the fixture stores.
func errorKind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrNoMatch):
		return "no_match"
	case errors.Is(err, ErrMissingField):
		return "missing_field"
	case errors.Is(err, ErrTooLarge):
		return "too_large"
	case errors.Is(err, ErrDefinition):
		return "definition"
	default:
		return "other"
	}
}

func expectOf(e Extraction, err error) templateExpect {
	posted := ""
	if !e.PostedAt.IsZero() {
		posted = e.PostedAt.UTC().Format(time.RFC3339)
	}
	groups := e.EmptyGroups
	if groups == nil {
		groups = []string{}
	}
	return templateExpect{
		Matched:     e.Matched,
		Error:       errorKind(err),
		AmountMinor: strconv.FormatInt(e.AmountMinor, 10),
		Currency:    e.Currency,
		Direction:   e.Direction,
		PostedAt:    posted,
		Merchant:    e.Merchant,
		Last4:       e.Last4,
		IsTransfer:  e.IsTransfer,
		EmptyGroups: groups,
	}
}

// senderDomain pulls the domain out of a v1 ingest_log from_addr.
//
// This is NOT the trusted-lane check: v1 stored the From header, which is
// content. It is only used here to decide which template a corpus message is
// worth running, and running the wrong template merely produces a no-match
// case. The real gate is MatchesSenderDomain over the DKIM/ARC-verified domain,
// and TestMatchesSenderDomainIsASuffixMatchOnLabelBoundaries covers it.
func senderDomain(fromAddr string) string {
	at := strings.LastIndex(fromAddr, "@")
	if at < 0 {
		return ""
	}
	d := strings.TrimSpace(fromAddr[at+1:])
	d = strings.TrimSuffix(strings.Trim(d, "<>"), ".")
	return asciiLower(d)
}

// sampleEvenly picks at most limit values from ids by an even stride, always
// keeping the first and last so the fixture spans the whole corpus rather than
// its middle.
func sampleEvenly(ids []int64, limit int) []int64 {
	if len(ids) <= limit || limit <= 0 {
		return ids
	}
	out := make([]int64, 0, limit)
	// Fixed-point stride so the picks are spread across the whole range and the
	// result is exactly cap long regardless of len(ids).
	for i := 0; i < limit; i++ {
		j := int(int64(i) * int64(len(ids)-1) / int64(limit-1))
		out = append(out, ids[j])
	}
	return out
}

// TestWriteTemplateFixtures regenerates conformance/templates/*.json from a
// scratch .backup copy of the v1 corpus.
//
//	LEDGER_WRITE_CONFORMANCE=1 LEDGER_CORPUS_DB=/scratch/corpus.db \
//	  go test ./internal/v2/tmpl/ -run TestWriteTemplateFixtures -timeout 20m -v
func TestWriteTemplateFixtures(t *testing.T) {
	if os.Getenv(writeFixturesEnv) == "" {
		t.Skipf("%s is unset; fixtures are committed and regenerated deliberately", writeFixturesEnv)
	}
	path := os.Getenv("LEDGER_CORPUS_DB")
	if path == "" {
		t.Skip("LEDGER_CORPUS_DB is unset; see internal/v2/corpus for how to make the .backup copy")
	}
	db, err := corpus.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	defs, raws := loadSeedTemplates(t)

	// Pass 1: which corpus ids each template is worth running, decided on the
	// sender domain alone so nothing is decompressed twice.
	eligible := make([][]int64, len(defs))
	if err := db.Each(func(m corpus.Message) error {
		dom := senderDomain(m.FromAddr)
		for i, d := range defs {
			if MatchesSenderDomain(d, dom) {
				eligible[i] = append(eligible[i], m.ID)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	wanted := map[int64]bool{}
	picked := make([][]int64, len(defs))
	for i := range defs {
		picked[i] = sampleEvenly(eligible[i], templateFixtureCap)
		for _, id := range picked[i] {
			wanted[id] = true
		}
	}

	// Pass 2: normalize the sampled messages once each, whatever templates want
	// them.
	type msg struct {
		subject string
		body    string
		normErr error
	}
	byID := map[int64]msg{}
	if err := db.Each(func(m corpus.Message) error {
		if !wanted[m.ID] {
			return nil
		}
		r, err := norm.Normalize(norm.CurrentVersion, m.RawBody, m.ReceivedAt)
		byID[m.ID] = msg{subject: r.Subject, body: r.Text, normErr: err}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(templateConformanceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i, d := range defs {
		f := templateFixture{
			Note: "Written by internal/v2/tmpl TestWriteTemplateFixtures over the operator's v1 mail corpus. " +
				"Regenerate with LEDGER_WRITE_CONFORMANCE=1 LEDGER_CORPUS_DB=... go test ./internal/v2/tmpl/ " +
				"-run TestWriteTemplateFixtures; do not hand-edit. `expect` is LITERAL Go executor output, never " +
				"recomputed by the reader: a conformance harness that derives its own expectation cannot see a " +
				"defect in the thing it is checking. Subject and body are the NORMALIZED forms (norm.Result.Subject " +
				"and norm.Result.Text), base64 because they carry CR, U+FEFF, bidi controls and Arabic.",
			Spec:              "docs/superpowers/specs/v2-template-format.md",
			SchemaVersion:     1,
			Template:          d.ID,
			Kind:              "corpus",
			NormalizerVersion: norm.CurrentVersion,
			Definition:        raws[i],
			Cases:             []templateCase{},
		}
		skipped := 0
		for _, id := range picked[i] {
			m := byID[id]
			if m.normErr != nil {
				// A message the normalizer refuses never reaches a template, so
				// it is not a template conformance case.
				skipped++
				continue
			}
			e, execErr := Execute(d, m.subject, m.body)
			f.Cases = append(f.Cases, templateCase{
				Name:                 fmt.Sprintf("%s/%06d", d.ID, id),
				Source:               fmt.Sprintf("v1 corpus ingest_log id %d, normalized with norm v%d", id, norm.CurrentVersion),
				SubjectBase64:        base64.StdEncoding.EncodeToString([]byte(m.subject)),
				NormalizedBodyBase64: base64.StdEncoding.EncodeToString([]byte(m.body)),
				Expect:               expectOf(e, execErr),
			})
		}
		out := filepath.Join(templateConformanceDir, "corpus-"+d.ID+".json")
		b, err := encodeTemplateFixture(f)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Fatal(err)
		}
		matched := 0
		for _, c := range f.Cases {
			if c.Expect.Matched {
				matched++
			}
		}
		t.Logf("%s: %d eligible, %d sampled, %d written (%d matched, %d unreadable by the normalizer), %d bytes",
			d.ID, len(eligible[i]), len(picked[i]), len(f.Cases), matched, skipped, len(b))
	}
}

func loadSeedTemplates(t *testing.T) ([]Definition, []json.RawMessage) {
	t.Helper()
	defs := make([]Definition, 0, len(seedTemplateFiles))
	raws := make([]json.RawMessage, 0, len(seedTemplateFiles))
	for _, name := range seedTemplateFiles {
		b, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		d, err := ParseDefinition(b)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := ValidateForPublish(d); err != nil {
			t.Fatalf("%s: a fixture may only be written from a PUBLISHABLE template: %v", name, err)
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, b); err != nil {
			t.Fatal(err)
		}
		defs = append(defs, d)
		raws = append(raws, json.RawMessage(compact.Bytes()))
	}
	return defs, raws
}

func encodeTemplateFixture(f templateFixture) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	if err := e.Encode(f); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// TestTemplateFixturesAreWhatThisBuildProduces is the guard against the
// committed set going stale, and it needs NO corpus: every case carries its own
// inputs, so the whole file can be re-executed from what is in the repository.
//
// Without it, a change to a conversion rule would leave the TypeScript executor
// checking itself against a snapshot of a Go executor that no longer exists —
// and it would keep passing, because both sides read the same stale file.
func TestTemplateFixturesAreWhatThisBuildProduces(t *testing.T) {
	files := readTemplateFixtures(t)
	// Every seed template must have a corpus file: a synthetic-only set would
	// prove the executor agrees with itself on inputs someone imagined.
	haveCorpus := map[string]bool{}
	for _, f := range files {
		if f.Kind == "corpus" {
			haveCorpus[f.Template] = true
		}
	}
	for _, name := range seedTemplateFiles {
		id := strings.TrimSuffix(name, ".json")
		if !haveCorpus[id] {
			t.Errorf("no corpus fixture for %s", id)
		}
	}
	total, matched := 0, 0
	for _, f := range files {
		d, err := ParseDefinition(f.Definition)
		if err != nil {
			t.Fatalf("%s: %v", f.Template, err)
		}
		if d.ID != f.Template {
			t.Errorf("%s: definition id is %q", f.Template, d.ID)
		}
		c, err := Compile(d)
		if err != nil {
			t.Fatalf("%s: %v", f.Template, err)
		}
		for _, tc := range f.Cases {
			subject := decodeB64(t, tc.SubjectBase64)
			body := decodeB64(t, tc.NormalizedBodyBase64)
			e, execErr := c.Execute(subject, body)
			got := expectOf(e, execErr)
			if !sameExpect(got, tc.Expect) {
				t.Fatalf("%s is stale: %s\n got %+v\nwant %+v\nregenerate with\n"+
					"  %s=1 LEDGER_CORPUS_DB=... go test ./internal/v2/tmpl/ -run TestWriteTemplateFixtures",
					f.Template, tc.Name, got, tc.Expect, writeFixturesEnv)
			}
			total++
			if tc.Expect.Matched {
				matched++
			}
		}
	}
	// A fixture set that matched nothing would pass every assertion above while
	// proving nothing about extraction.
	if matched < 100 {
		t.Fatalf("only %d of %d cases matched; the fixture set is not exercising extraction", matched, total)
	}
	t.Logf("%d cases across %d templates, %d matched", total, len(files), matched)
}

// TestTemplateFixturesCoverEveryFieldAndEveryFailureMode is the check that the
// committed set is worth running. A conformance corpus that happens to contain
// only successful card purchases would agree perfectly and say nothing about
// the date fallback, the empty-group diagnostic or the required-field gate.
func TestTemplateFixturesCoverEveryFieldAndEveryFailureMode(t *testing.T) {
	files := readTemplateFixtures(t)
	var (
		amounts, dates, merchants, last4s, credits, debits, transfers int
		emptyGroups, noMatch, missingField                            int
	)
	for _, f := range files {
		for _, c := range f.Cases {
			x := c.Expect
			if x.Currency != "" {
				amounts++
			}
			if x.PostedAt != "" {
				dates++
			}
			if x.Merchant != "" {
				merchants++
			}
			if x.Last4 != "" {
				last4s++
			}
			switch x.Direction {
			case "credit":
				credits++
			case "debit":
				debits++
			}
			if x.IsTransfer {
				transfers++
			}
			if len(x.EmptyGroups) > 0 {
				emptyGroups++
			}
			switch x.Error {
			case "no_match":
				noMatch++
			case "missing_field":
				missingField++
			}
		}
	}
	for _, c := range []struct {
		name string
		n    int
	}{
		{"amounts", amounts}, {"body dates", dates}, {"merchants", merchants},
		{"last4s", last4s}, {"credits", credits}, {"debits", debits},
		{"is_transfer", transfers}, {"empty capture groups", emptyGroups},
		{"gated-out (no_match)", noMatch}, {"required-field failures", missingField},
	} {
		if c.n == 0 {
			t.Errorf("no committed case exercises %s; the two executors cannot be compared on it", c.name)
		}
	}
	t.Logf("amounts=%d dates=%d merchants=%d last4=%d credit=%d debit=%d transfer=%d empty_groups=%d no_match=%d missing_field=%d",
		amounts, dates, merchants, last4s, credits, debits, transfers, emptyGroups, noMatch, missingField)
}

func readTemplateFixtures(t *testing.T) []templateFixture {
	t.Helper()
	names, err := filepath.Glob(filepath.Join(templateConformanceDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	out := make([]templateFixture, 0, len(names))
	for _, n := range names {
		b, err := os.ReadFile(n)
		if err != nil {
			t.Fatal(err)
		}
		var f templateFixture
		if err := json.Unmarshal(b, &f); err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		if len(f.Cases) == 0 {
			t.Fatalf("%s has no cases", n)
		}
		out = append(out, f)
	}
	return out
}

func decodeB64(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sameExpect(a, b templateExpect) bool {
	if a.Matched != b.Matched || a.Error != b.Error || a.AmountMinor != b.AmountMinor ||
		a.Currency != b.Currency || a.Direction != b.Direction || a.PostedAt != b.PostedAt ||
		a.Merchant != b.Merchant || a.Last4 != b.Last4 || a.IsTransfer != b.IsTransfer ||
		len(a.EmptyGroups) != len(b.EmptyGroups) {
		return false
	}
	for i := range a.EmptyGroups {
		if a.EmptyGroups[i] != b.EmptyGroups[i] {
			return false
		}
	}
	return true
}
