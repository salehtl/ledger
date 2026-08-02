package dict

// conformance_test.go writes conformance/dict/matching.json and then re-reads
// it, asserting this build still produces it.
//
// # Why the dictionary needs a fixture at all
//
// The server canonicalizes a merchant pattern, decides whether it may exist,
// and ships it to every device. The device canonicalizes a MERCHANT with the
// same rules and decides whether the pattern matches it. Nothing in between
// checks that the two agree, and when they do not the symptom is silence: a
// pattern the operator can see in the moderation queue simply never matches
// anything on a phone, and no error is raised anywhere.
//
// The disagreements are not hypothetical. Writing the TypeScript half turned up
// four, each of which the obvious JavaScript one-liner gets wrong:
//
//   - U+0085 is whitespace to Go's unicode.IsSpace and is NOT in JavaScript's
//     \s, so `.replace(/\s+/g, " ")` keeps it while Go collapses it.
//   - U+FEFF is the mirror image: in \s, not in unicode.IsSpace.
//   - U+0130 lower-cases to ONE code point in Go and to TWO in JavaScript
//     (`i` + U+0307), because strings.ToLower is Unicode's SIMPLE case mapping
//     and String.prototype.toLowerCase is the FULL one.
//   - A capital sigma at the end of a word lower-cases to U+03C2 in JavaScript
//     (the Final_Sigma condition) and to U+03C3 in Go, which has no context.
//
// So this file carries Go's own answers, and client/src/categorize/
// conformance.test.ts compares the device's against them.
//
// # What each section is, and what it can prove
//
//  1. `limits` — the numbers both sides hard-code. The 4-rune `contains` floor
//     is already pinned to the SQL literal by TestTheContainsFloorMatchesTheSQL
//     Literal; this carries it across the language boundary as well, so a
//     device cannot enforce a different floor than the server publishes at.
//
//  2. `space` and `lower` — the two primitives canonicalization is built from,
//     probed one code point at a time. These are the sections that actually
//     catch the four divergences above; a fixture that only carried whole
//     canonicalized strings would catch them too, but would not say WHICH
//     primitive was wrong.
//
//  3. `canonical` — Canonicalize's verdict and output for whole entries,
//     including every refusal it makes. The verdict is a boolean (`ok`) rather
//     than a reason string on purpose: the reason is Go's wording, the device
//     has its own vocabulary of defect codes, and pinning prose across two
//     languages is a rename away from a false failure. What must agree is
//     whether the entry may exist and what it canonicalizes to.
//
//  4. `match` — contains/exact verdicts computed by POSTGRES, using the same
//     expression internal/v2/dict's moderation queue uses for Status.
//     AlsoMatches (`position(pattern IN other) > 0` / equality). That makes the
//     device's matcher answerable to the only server-side matching there is: if
//     they disagree, the moderator's breadth preview is lying about what
//     devices will do with the pattern they are approving.
//
// No Go MATCHER is written here, and deliberately: the server does not
// categorize, and a Go implementation of the device's matcher would be a
// function nothing calls, tested green, drifting from both sides.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

const (
	dictConformancePath = "../../../conformance/dict/matching.json"
	// The same switch internal/v2/tmpl's dialect fixture uses.
	writeFixturesEnv = "LEDGER_WRITE_CONFORMANCE"
)

type dictFixture struct {
	Note      string       `json:"note"`
	Spec      string       `json:"spec"`
	Limits    dictLimits   `json:"limits"`
	Space     []spaceCase  `json:"space"`
	Lower     []lowerCase  `json:"lower"`
	Canonical []canonCase  `json:"canonical"`
	Match     []matchCase  `json:"match"`
	Notes     []engineNote `json:"engine_notes"`
}

type dictLimits struct {
	K                int `json:"k"`
	MinContainsRunes int `json:"min_contains_runes"`
	MinPatternRunes  int `json:"min_pattern_runes"`
	MaxPatternRunes  int `json:"max_pattern_runes"`
	MinCategoryRunes int `json:"min_category_runes"`
	MaxCategoryRunes int `json:"max_category_runes"`
}

// spaceCase is unicode.IsSpace's verdict for one code point.
type spaceCase struct {
	Name    string `json:"name"`
	CP      int    `json:"cp"`
	IsSpace bool   `json:"is_space"`
}

// lowerCase is strings.ToLower's output for one probe string. Base64 because
// several probes differ from their input only in code points that no diff
// renders distinguishably.
type lowerCase struct {
	Name        string `json:"name"`
	InputBase64 string `json:"input_base64"`
	LowerBase64 string `json:"lower_base64"`
}

type canonCase struct {
	Name           string `json:"name"`
	PatternBase64  string `json:"pattern_base64"`
	Match          string `json:"match"`
	CategoryBase64 string `json:"category_base64"`
	// OK is whether Canonicalize accepted the entry. When false the three
	// fields below are empty.
	OK                     bool   `json:"ok"`
	CanonicalPatternBase64 string `json:"canonical_pattern_base64"`
	CanonicalMatch         string `json:"canonical_match"`
	CanonicalCategory      string `json:"canonical_category"`
}

type matchCase struct {
	Name          string `json:"name"`
	Match         string `json:"match"`
	PatternBase64 string `json:"pattern_base64"`
	SubjectBase64 string `json:"subject_base64"`
	Matched       bool   `json:"matched"`
}

type engineNote struct {
	Subject string `json:"subject"`
	Note    string `json:"note"`
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// spaceProbes covers every rune unicode.IsSpace treats as whitespace plus the
// ones a JavaScript author would expect it to. The two that disagree are the
// reason this section exists.
var spaceProbes = []struct {
	name string
	cp   rune
}{
	{"tab", '\t'},
	{"lf", '\n'},
	{"vt", '\v'},
	{"ff", '\f'},
	{"cr", '\r'},
	{"space", ' '},
	{"nel", 0x85},
	{"nbsp", 0xA0},
	{"ogham space mark", 0x1680},
	{"en quad", 0x2000},
	{"hair space", 0x200A},
	{"zero width space", 0x200B},
	{"line separator", 0x2028},
	{"paragraph separator", 0x2029},
	{"narrow nbsp", 0x202F},
	{"medium mathematical space", 0x205F},
	{"ideographic space", 0x3000},
	{"zwnbsp / bom", 0xFEFF},
	{"latin a", 'a'},
}

var lowerProbes = []struct {
	name  string
	input string
}{
	{"ascii", "CARREFOUR"},
	{"turkish dotted capital i", "İ"},
	{"turkish dotless i", "ı"},
	{"greek word ending in sigma", "ΟΔΟΣ"},
	{"greek sigma alone", "Σ"},
	{"kelvin sign", "K"},
	{"angstrom sign", "Å"},
	{"capital sharp s", "ẞ"},
	{"fullwidth carrefour", "ＣＡＲＲＥＦＯＵＲ"},
	{"cyrillic es plus latin", "\u0421ARREFOUR"},
	{"arabic (no case)", "كارفور"},
	{"astral bold capitals", "\U0001D400\U0001D401"},
	{"already lower", "carrefour"},
}

var canonProbes = []struct {
	name     string
	pattern  string
	match    string
	category string
}{
	{"plain", "Carrefour", MatchContains, "Groceries"},
	{"padded and doubled spaces", "  CARREFOUR   Hyper ", MatchContains, "groceries"},
	{"nel between words", "carrefour\u0085hyper", MatchContains, "groceries"},
	{"bom between words", "carrefour\ufeffhyper", MatchContains, "groceries"},
	{"nbsp between words", "carrefour\u00a0hyper", MatchContains, "groceries"},
	{"turkish dotted i", "İSTANBUL", MatchContains, "travel"},
	{"greek final sigma", "ΟΔΟΣ", MatchContains, "travel"},
	{"fullwidth", "ＣＡＲＲＥＦＯＵＲ", MatchContains, "groceries"},
	{"cyrillic homoglyph", "\u0421ARREFOUR", MatchContains, "groceries"},
	{"trailing dot", "carrefour.", MatchContains, "groceries"},
	{"exact two runes", "on", MatchExact, "charity"},
	{"contains two runes (the floor)", "on", MatchContains, "charity"},
	{"contains three runes", "noo", MatchContains, "shopping"},
	{"contains four runes", "noon", MatchContains, "shopping"},
	{"contains four astral runes", "\U0001D400\U0001D401\U0001D402\U0001D403", MatchContains, "shopping"},
	{"contains three astral runes", "\U0001D400\U0001D401\U0001D402", MatchContains, "shopping"},
	{"64-rune pattern", strings.Repeat("a", 64), MatchContains, "shopping"},
	{"65-rune pattern", strings.Repeat("a", 65), MatchContains, "shopping"},
	{"pure punctuation", "----", MatchContains, "shopping"},
	{"zero width space inside", "carre\u200bfour", MatchContains, "shopping"},
	{"two lines", "carrefour\nhyper", MatchContains, "shopping"},
	{"line separator", "carrefour\u2028hyper", MatchContains, "shopping"},
	{"empty pattern", "", MatchContains, "shopping"},
	{"whitespace-only pattern", "   ", MatchContains, "shopping"},
	{"regex match type", "^carrefour", "regex", "groceries"},
	{"unknown match type", "carrefour", "starts_with", "groceries"},
	{"empty match type defaults to contains", "carrefour", "", "groceries"},
	{"category with punctuation", "carrefour", MatchContains, "Groceries & Fresh!"},
	{"category with ampersand", "carrefour", MatchContains, "food & drink"},
	{"one-rune category", "carrefour", MatchContains, "g"},
	{"33-rune category", "carrefour", MatchContains, strings.Repeat("g", 33)},
	{"32-rune category", "carrefour", MatchContains, strings.Repeat("g", 32)},
	{"category leading digit", "carrefour", MatchContains, "1st groceries"},
	{"category leading space", "carrefour", MatchContains, " groceries"},
	{"multiline category", "carrefour", MatchContains, "gro\nceries"},
}

var matchProbes = []struct {
	name    string
	match   string
	pattern string
	subject string
}{
	{"contains hit", MatchContains, "carrefour", "carrefour hyper market"},
	{"contains miss", MatchContains, "carrefour", "noon express"},
	{"contains at the very end", MatchContains, "market", "carrefour hyper market"},
	{"contains whole subject", MatchContains, "carrefour", "carrefour"},
	{"contains longer than subject", MatchContains, "carrefour hyper", "carrefour"},
	{"exact hit", MatchExact, "carrefour", "carrefour"},
	{"exact miss on prefix", MatchExact, "carrefour", "carrefour hyper"},
	{"exact miss on suffix", MatchExact, "carrefour", "hyper carrefour"},
	{"the short pattern against amazon", MatchContains, "on", "amazon"},
	{"the short pattern against noon", MatchContains, "on", "noon"},
	{"the short pattern against talabat online", MatchContains, "on", "talabat online"},
	{"cyrillic pattern against latin subject", MatchContains, "\u0441arrefour", "carrefour hyper"},
	{"latin pattern against cyrillic subject", MatchContains, "carrefour", "\u0441arrefour hyper"},
	{"fullwidth pattern against ascii subject", MatchContains, "ｃａｒｒｅｆｏｕｒ", "carrefour"},
	{"astral pattern hit", MatchContains, "\U0001D400\U0001D401", "shop \U0001D400\U0001D401\U0001D402"},
	{"astral pattern miss across a pair boundary", MatchContains, "\U0001D401\U0001D400", "shop \U0001D400\U0001D401\U0001D402"},
	{"arabic hit", MatchContains, "كارفور", "متجر كارفور"},
	{"bom in subject only", MatchContains, "carrefourhyper", "carrefour\ufeffhyper"},
	{"bom in both", MatchContains, "carrefour\ufeffhyper", "carrefour\ufeffhyper"},
}

// buildDictFixture computes every section from THIS build.
func buildDictFixture(t *testing.T, pool *pgxpool.Pool) dictFixture {
	t.Helper()
	f := dictFixture{
		Note: "Go's own answers for the merchant dictionary's canonicalization, bounds and match " +
			"semantics. Written by internal/v2/dict's TestWriteDictConformanceFixtures; read by " +
			"client/src/categorize/conformance.test.ts. The `match` section is computed by Postgres " +
			"using the same expression dict.List's AlsoMatches uses.",
		Spec: "3.6",
		Limits: dictLimits{
			K:                K,
			MinContainsRunes: minContainsRunes,
			MinPatternRunes:  minPatternRunes,
			MaxPatternRunes:  maxPatternRunes,
			MinCategoryRunes: 2,
			MaxCategoryRunes: maxCategoryRunes,
		},
		Notes: []engineNote{
			{Subject: "U+0085", Note: "whitespace to Go's unicode.IsSpace; NOT in JavaScript's \\s"},
			{Subject: "U+FEFF", Note: "in JavaScript's \\s; NOT whitespace to Go's unicode.IsSpace"},
			{Subject: "U+0130", Note: "strings.ToLower gives one code point; JavaScript's toLowerCase gives i + U+0307"},
			{Subject: "final sigma", Note: "strings.ToLower always gives U+03C3; JavaScript gives U+03C2 at a word end"},
		},
	}
	for _, p := range spaceProbes {
		f.Space = append(f.Space, spaceCase{Name: p.name, CP: int(p.cp), IsSpace: unicode.IsSpace(p.cp)})
	}
	for _, p := range lowerProbes {
		f.Lower = append(f.Lower, lowerCase{
			Name: p.name, InputBase64: b64(p.input), LowerBase64: b64(strings.ToLower(p.input)),
		})
	}
	for _, p := range canonProbes {
		c := canonCase{
			Name: p.name, PatternBase64: b64(p.pattern), Match: p.match, CategoryBase64: b64(p.category),
		}
		out, err := Canonicalize(Entry{Pattern: p.pattern, Match: p.match, Category: p.category})
		if err == nil {
			c.OK = true
			c.CanonicalPatternBase64 = b64(out.Pattern)
			c.CanonicalMatch = out.Match
			c.CanonicalCategory = out.Category
		}
		f.Canonical = append(f.Canonical, c)
	}
	for _, p := range matchProbes {
		f.Match = append(f.Match, matchCase{
			Name: p.name, Match: p.match, PatternBase64: b64(p.pattern), SubjectBase64: b64(p.subject),
			Matched: sqlMatches(t, pool, p.match, p.pattern, p.subject),
		})
	}
	return f
}

// sqlMatches asks Postgres the question dict.List's AlsoMatches LATERAL asks.
//
// The expression is copied from that query rather than paraphrased: it is the
// only server-side matcher that exists, and it is what a moderator's breadth
// preview is computed with.
func sqlMatches(t *testing.T, pool *pgxpool.Pool, match, pattern, subject string) bool {
	t.Helper()
	var got bool
	err := pool.QueryRow(context.Background(), `SELECT CASE WHEN $1 = 'contains'
	    THEN position($2 IN $3) > 0
	    ELSE $3 = $2 END`, match, pattern, subject).Scan(&got)
	if err != nil {
		t.Fatalf("sql match probe (%s, %q, %q): %v", match, pattern, subject, err)
	}
	return got
}

// TestWriteDictConformanceFixtures regenerates the fixture under
// LEDGER_WRITE_CONFORMANCE=1 and otherwise asserts the committed bytes still
// describe this build.
func TestWriteDictConformanceFixtures(t *testing.T) {
	pool := pgtest.New(t)
	f := buildDictFixture(t, pool)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(f); err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := buf.Bytes()

	if os.Getenv(writeFixturesEnv) != "" {
		if err := os.MkdirAll(filepath.Dir(dictConformancePath), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(dictConformancePath, want, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		t.Logf("wrote %s (%d bytes)", dictConformancePath, len(want))
		return
	}

	got, err := os.ReadFile(dictConformancePath)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with %s=1 go test ./internal/v2/dict/)",
			dictConformancePath, err, writeFixturesEnv)
	}
	if !bytes.Equal(bytes.TrimSpace(got), bytes.TrimSpace(want)) {
		t.Fatalf("%s is stale: this build produces different bytes. Regenerate with %s=1 "+
			"go test ./internal/v2/dict/ -run TestWriteDictConformanceFixtures, and expect the "+
			"TypeScript side to fail until it agrees.", dictConformancePath, writeFixturesEnv)
	}
}

// TestTheFixtureCarriesBothSidesOfEveryDivergence fails if a probe set is
// trimmed down to the cases everybody already agrees on.
//
// A conformance fixture whose probes are all uncontroversial is a fixture that
// passes on both a correct implementation and a naive one, which is the failure
// mode this project has hit repeatedly under a different name.
func TestTheFixtureCarriesBothSidesOfEveryDivergence(t *testing.T) {
	pool := pgtest.New(t)
	f := buildDictFixture(t, pool)

	space := map[int]bool{}
	for _, c := range f.Space {
		space[c.CP] = c.IsSpace
	}
	if !space[0x85] {
		t.Error("U+0085 must be whitespace to Go; the probe set has to carry it, since \\s does not")
	}
	if space[0xFEFF] {
		t.Error("U+FEFF must NOT be whitespace to Go; the probe set has to carry it, since \\s does")
	}

	lower := map[string]string{}
	for _, c := range f.Lower {
		lower[c.Name] = c.LowerBase64
	}
	if lower["turkish dotted capital i"] != b64("i") {
		t.Errorf("Go lower-cases U+0130 to a single 'i'; got %q", lower["turkish dotted capital i"])
	}
	if lower["greek word ending in sigma"] != b64("οδοσ") {
		t.Error("Go lower-cases a trailing capital sigma to U+03C3, never to the final form U+03C2")
	}

	accepted, refused := 0, 0
	for _, c := range f.Canonical {
		if c.OK {
			accepted++
		} else {
			refused++
		}
	}
	if accepted == 0 || refused == 0 {
		t.Errorf("the canonicalization probes must contain both verdicts, got %d accepted / %d refused",
			accepted, refused)
	}

	hit, miss := 0, 0
	for _, c := range f.Match {
		if c.Matched {
			hit++
		} else {
			miss++
		}
	}
	if hit == 0 || miss == 0 {
		t.Errorf("the match probes must contain both verdicts, got %d matched / %d not", hit, miss)
	}
}
