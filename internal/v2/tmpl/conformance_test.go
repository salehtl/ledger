package tmpl

// conformance_test.go writes conformance/dialect/patterns.json and then
// re-reads it, asserting this build still produces it.
//
// The file is the shared half of the dual-executor contract for the dialect.
// It carries three different kinds of claim, and they are different on purpose:
//
//  1. REJECTED patterns with their reason codes. Task 20's TypeScript
//     validator must reject the same patterns with the same codes. This is
//     validator parity, and it is the only part Go can state alone.
//
//  2. ACCEPTED patterns with PROBE RESULTS — for each pattern, a set of inputs
//     and what Go's engine did with them, group by group. This is the part
//     that matters most and the part a validator-parity check cannot give you:
//     two validators can agree perfectly that a pattern is legal while the two
//     regex engines then disagree about what it matches. The probe corpus is
//     chosen to contain exactly the characters the banned constructs diverge
//     on — CR, U+2028, U+2029, NBSP, VT, U+FEFF, the Kelvin sign, long s —
//     so an accepted pattern is not merely "not obviously unsafe" but measured
//     safe on the inputs that break the unsafe ones.
//
//  3. A CANONICAL definition and its exact bytes, because the hash of a
//     template has to be the same number in both languages.
//
// The probe expectations are produced by Go's engine and consumed by
// JavaScript's, so this direction catches a TypeScript executor that reads
// patterns differently. client/src/tmpl/agreement.test.ts is the reader.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

const (
	dialectConformancePath = "../../../conformance/dialect/patterns.json"
	writeFixturesEnv       = "LEDGER_WRITE_CONFORMANCE"
)

type dialectFixture struct {
	Note          string             `json:"note"`
	Spec          string             `json:"spec"`
	SchemaVersion int                `json:"schema_version"`
	Limits        dialectLimits      `json:"limits"`
	JSCompile     string             `json:"js_compile"`
	GoCompile     string             `json:"go_compile"`
	ProbeInputs   []probeInput       `json:"probe_inputs"`
	Rejected      []rejectedCase     `json:"rejected"`
	Accepted      []acceptedCase     `json:"accepted"`
	ToJS          []toJSCase         `json:"to_js"`
	Canonical     canonicalCase      `json:"canonical"`
	Corpus        corpusDigest       `json:"corpus"`
	EngineNotes   []engineDivergence `json:"engine_notes"`
}

type dialectLimits struct {
	MaxPatternRunes       int `json:"max_pattern_runes"`
	MaxCaptureGroups      int `json:"max_capture_groups"`
	MaxBoundProduct       int `json:"max_bound_product"`
	MaxUnboundedPerBranch int `json:"max_unbounded_per_branch"`
	MaxRepetitionWidth    int `json:"max_repetition_width"`
}

type probeInput struct {
	Name        string `json:"name"`
	InputBase64 string `json:"input_base64"`
}

// corpusDigest is validator parity over a GENERATED corpus rather than over
// hand-picked rows.
//
// Every other claim in this file is a pattern somebody chose, and the person
// who chooses the rows is the person who wrote both validators — so the rows
// agree where the author expected them to. That is the "true by construction"
// shape. This one enumerates the cross product of a small grammar, runs the
// validator over all of it, and records a hash: it agrees only if the two
// implementations are the same FUNCTION over 9,324 shapes, not the same
// intuition over sixty.
//
// It is a hash rather than the rows because the rows are ~400 KB. Checkpoints
// exist so a failure is diagnosable: the TypeScript side compares those first
// and names the first pattern that differs, and only falls back to "the digest
// differs somewhere else" when they all match.
type corpusDigest struct {
	Spec        string             `json:"spec"`
	Size        int                `json:"size"`
	SHA256      string             `json:"sha256"`
	Checkpoints []corpusCheckpoint `json:"checkpoints"`
}

type corpusCheckpoint struct {
	Index   int      `json:"index"`
	Pattern string   `json:"pattern"`
	Codes   []string `json:"codes"`
}

// dialectCorpus is the generator, written as plain nested loops over literal
// arrays so that the TypeScript mirror in client/src/tmpl/dialect.test.ts is a
// transliteration rather than a reimplementation. The ORDER is part of the
// contract: the digest is over the sequence.
//
// The alphabet is chosen for the cost rules — a fixed atom, a class, a negated
// class, an escape, and one Arabic literal so that the two languages are shown
// to agree on a non-ASCII pattern as well — crossed with every quantifier form
// the dialect has an opinion about, then nested and repeated.
func dialectCorpus() []string {
	atoms := []string{`a`, `[a-z]`, `[^\n]`, `\n`, `م`}
	quants := []string{``, `?`, `*`, `+`, `{2}`, `{1,4}`, `{0,2}`, `{2,}`, `{1,32}`}

	var units []string
	for _, a := range atoms {
		for _, q := range quants {
			units = append(units, a+q)
		}
	}
	inner := append([]string(nil), units...)
	for _, u := range units[:12] {
		for _, v := range units[:12] {
			inner = append(inner, u+v)
			inner = append(inner, u+`|`+v)
		}
	}
	var pats []string
	for _, in := range inner {
		pats = append(pats, in)
		for _, q := range quants {
			pats = append(pats, `(?:`+in+`)`+q)
			pats = append(pats, `(?:(?:`+in+`)`+q+`){2}`)
			pats = append(pats, `x(?:`+in+`)`+q+`y`)
		}
	}
	return pats
}

// buildCorpusDigest runs the validator over dialectCorpus and hashes the
// result. The hashed line is pattern, NUL, the codes joined by commas — NUL
// because it cannot occur in a pattern, so no pattern/codes pair can be
// confused with a different one that concatenates to the same bytes.
func buildCorpusDigest() corpusDigest {
	pats := dialectCorpus()
	h := sha256.New()
	d := corpusDigest{
		Spec: "pats = dialectCorpus() in internal/v2/tmpl/conformance_test.go, transliterated in " +
			"client/src/tmpl/dialect.test.ts. sha256 over, for each pattern in order: " +
			"pattern + \"\\x00\" + ValidatePattern(pattern, []).codes.join(\",\") + \"\\n\", as UTF-8.",
		Size: len(pats),
	}
	for i, p := range pats {
		codes := Codes(ValidatePattern(p, nil))
		fmt.Fprintf(h, "%s\x00%s\n", p, strings.Join(codes, ","))
		if i%1000 == 0 {
			d.Checkpoints = append(d.Checkpoints, corpusCheckpoint{Index: i, Pattern: p, Codes: nonNilCodes(codes)})
		}
	}
	d.SHA256 = hex.EncodeToString(h.Sum(nil))
	return d
}

func nonNilCodes(c []string) []string {
	if c == nil {
		return []string{}
	}
	return c
}

type rejectedCase struct {
	Code string `json:"code"`
	// Pattern is a plain JSON string, not base64: this file is read by a human
	// porting the validator, and every pattern here is valid UTF-8 that JSON
	// round-trips exactly.
	Pattern string `json:"pattern"`
	// JSPattern is the text JavaScript would compile, i.e. after ToJS. It
	// matters for the two rows whose rejection JavaScript only sees once the
	// named-group spelling has been rewritten.
	JSPattern string   `json:"js_pattern"`
	Flags     []string `json:"flags"`
	Codes     []string `json:"codes"`
	// JSSyntaxError records whether new RegExp(ToJS(pattern), flags+"u") throws.
	// Where it is true, JavaScript's own parser is a second, free layer of
	// enforcement; where it is false, the dialect is the only thing standing
	// between this pattern and a silent cross-executor difference. Measured,
	// and asserted by the TypeScript side.
	JSSyntaxError bool   `json:"js_syntax_error"`
	Why           string `json:"why"`
}

type acceptedCase struct {
	Name      string   `json:"name"`
	Pattern   string   `json:"pattern"`
	JSPattern string   `json:"js_pattern"`
	Flags     []string `json:"flags"`
	// Why is carried only by the rows whose acceptance is itself the claim —
	// the cost-bound boundary cases, where "this pattern is legal" is the
	// measurement rather than a side effect of the rule it illustrates.
	// omitempty, so the rewrite-of-* and seed-* rows stay as they were.
	Why        string        `json:"why,omitempty"`
	GroupNames []string      `json:"group_names"`
	Probes     []probeResult `json:"probes"`
}

// probeResult is what Go's engine did. Matched plus the full match plus every
// named group, because a pattern that matches in both engines and captures
// different text is the failure this file exists to catch.
type probeResult struct {
	Input  string             `json:"input"`
	Match  bool               `json:"match"`
	Text   *string            `json:"text"`
	Groups map[string]*string `json:"groups"`
}

type toJSCase struct {
	Pattern string `json:"pattern"`
	JS      string `json:"js"`
	Why     string `json:"why"`
}

type canonicalCase struct {
	DefinitionBase64 string `json:"definition_base64"`
	CanonicalBase64  string `json:"canonical_base64"`
	Why              string `json:"why"`
}

type engineDivergence struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
	Flags   string `json:"flags"`
	Input   string `json:"input"`
	Go      string `json:"go"`
	JS      string `json:"js"`
	Note    string `json:"note"`
}

// probeCorpus is deliberately hostile. Every character on which the two
// engines were measured to disagree for some banned construct appears here, so
// an accepted pattern is exercised against the inputs that break the rejected
// ones rather than against a happy path.
func probeCorpus() []struct{ name, in string } {
	return []struct{ name, in string }{
		{"empty", ""},
		{"ascii-amount", "AED 250.00"},
		{"dib-amount-block", "المبلغ\nAED 250.00\nبتاريخ 05-06-2026"},
		{"dib-amount-no-currency", "المبلغ\n250,000.00"},
		{"enbd-alert", "AED 250,000.00 has been withdrawn from your account"},
		{"enbd-alert-lowercase", "aed 250,000.00 has been WITHDRAWN from your account"},
		// The credit anchor is the widest pattern the seed set ships and the
		// one closest to MaxRepetitionWidth, so it gets both of its optional
		// arms exercised: the (?:in)?to that is absent here and present below,
		// and both branches of (?:credited|deposited).
		{"enbd-alert-credit", "AED 250,000.00 has been credited to your account"},
		{"enbd-alert-deposited-into", "aed 1.00 has been DEPOSITED into your account"},
		{"subject-last4", "account ending with 3701"},
		{"carriage-return", "abc\rdef"},
		{"line-separator", "abc\u2028def"},
		{"paragraph-separator", "abc\u2029def"},
		{"no-break-space", "abc\u00a0def"},
		{"vertical-tab", "abc\vdef"},
		{"zero-width-no-break-space", "abc\ufeffdef"},
		{"kelvin-sign", "\u212aelvin AED 1.00"},
		{"latin-small-long-s", "\u017fugar AED 1.00"},
		{"dib-card-block", "\u0627\u0644\u062f\u0641\u0639 \u0627\u0644\u0649\nCARREFOUR DUBAI\n\u0631\u0642\u0645 \u0627\u0644\u0628\u0637\u0627\u0642\u0629\nXXXX1234"},
		// The load-bearing probe for the bare-dot rule's replacement: [^\n] must
		// include \r in BOTH engines, which is exactly what a bare . does not.
		{"dib-merchant-with-cr", "\u0627\u0644\u062f\u0641\u0639 \u0627\u0644\u0649\nCARREFOUR\rDUBAI\n\u0631\u0642\u0645 \u0627\u0644\u0628\u0637\u0627\u0642\u0629\nXXXX1234"},
		{"repeated-a", strings.Repeat("a", 40)},
		{"metacharacters", `a.b [x] (y) {z} \ | ^ $ -`},
		{"trailing-newline", "abc\n"},
	}
}

// jsSyntaxErrorCases names the reject rows for which JavaScript's own parser,
// with the u flag, refuses the pattern outright. Measured against Bun 1.3,
// V8 and WebKit; the TypeScript side asserts every entry, so an engine that
// changes its mind shows up as a failure rather than as silent drift.
var jsSyntaxErrorCases = map[string]bool{
	ReasonEscapeUnicodeClass:     true, // \p{Arabic} needs \p{Script=Arabic} in JS
	ReasonEscapeUnicodeCodepoint: true, // \x{...} is not JS syntax
	ReasonEscapeTextAnchor:       true, // \A
	ReasonEscapeNotAllowed:       true, // \a
	ReasonMalformedEscape:        true, // trailing backslash
	ReasonInlineFlags:            true, // (?i)
	ReasonUnsupportedGroup:       true, // (?P=amt)
	ReasonInvalidGroupName:       true, // (?<0a>x) after ToJS
	ReasonDuplicateGroupName:     true, // (?<v>a)(?<v>b) after ToJS
	ReasonUnbalancedParen:        true, // (a
	ReasonMalformedRepetition:    true, // a{,3}
	ReasonUnterminatedCharClass:  true, // [abc
	ReasonClassLiteralBracket:    true, // [[:alpha:]]
	ReasonNotCompilable:          true, // [z-a]
	// Not a pattern-syntax error but a FLAG error: the flag list is passed to
	// JavaScript verbatim, so ["i","i"] becomes "iiu" and JavaScript rejects a
	// repeated flag. ["m"], by contrast, is a perfectly legal JavaScript flag,
	// which is exactly why banning it has to be the validator's job.
	ReasonDuplicateFlag: true,
}

func buildDialectFixture(t *testing.T) dialectFixture {
	t.Helper()

	f := dialectFixture{
		Note: "Written by internal/v2/tmpl TestWriteDialectConformanceFixtures. " +
			"Regenerate with LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/tmpl/ -run TestWriteDialectConformanceFixtures; " +
			"do not hand-edit. Patterns are plain JSON strings because a human ports the validator from this file; " +
			"probe inputs and captured text are base64 because they deliberately contain CR, U+2028, U+2029, " +
			"U+00A0, U+000B and U+FEFF, which is the point of them. `rejected` pins validator parity: the " +
			"TypeScript validator must reject each pattern with the same reason codes. `accepted` pins ENGINE " +
			"parity, which is the stronger claim: for each pattern, what Go's RE2 matched and captured on every " +
			"probe input, which JavaScript must reproduce exactly.",
		Spec: "docs/superpowers/specs/v2-template-format.md",
		// 2: Task 20 added the multiple_unbounded_quantifiers rule and with it
		// max_unbounded_per_branch, and rewrote the escape_perl_space row's
		// sanctioned rewrite, which the new rule refused.
		//
		// 3: the two BOUNDED cost rules — nested_variable_repetition and
		// repetition_width_too_large — and with them max_repetition_width. Both
		// close a ReDoS hole that MaxBoundProduct is structurally unable to see:
		// (?:[a-z]{8}){8}z and (?:[a-z0-9 ]{1,8}){8}z score identically on it
		// and cost 0.0 ms and 2,178 ms. No previously accepted pattern became
		// rejected: all 72 patterns in seed/*.json and conformance/templates/
		// were re-validated, every `accept` in the dialect table still passes,
		// and the 7,004-message parity corpus still runs 5,719/0/0/0. The
		// widest thing that ships measures 200 against a limit of 1,024.
		//
		// The row set also grew: eight boundary cases that straddle
		// MaxRepetitionWidth by ONE, in both directions, so the constant is
		// pinned rather than only the direction of the inequality.
		SchemaVersion: 3,
		Limits: dialectLimits{
			MaxPatternRunes:       MaxPatternRunes,
			MaxCaptureGroups:      MaxCaptureGroups,
			MaxBoundProduct:       MaxBoundProduct,
			MaxUnboundedPerBranch: MaxUnboundedPerBranch,
			MaxRepetitionWidth:    MaxRepetitionWidth,
		},
		GoCompile: `regexp.Compile(flagsContain("i") ? "(?i)"+p : p)`,
		JSCompile: `new RegExp(toJS(p), flags.join("") + "u")`,
		Canonical: canonicalCase{
			Why: "Canonical() is key-sorted, total (no omitempty) and escaped exactly as JSON.stringify " +
				"escapes: Go's encoding/json escapes &, < and > by default, and escapes U+2028/U+2029 even " +
				"with SetEscapeHTML(false), while JSON.stringify does neither.",
		},
		EngineNotes: measuredDivergences(),
		Corpus:      buildCorpusDigest(),
	}

	for _, p := range probeCorpus() {
		f.ProbeInputs = append(f.ProbeInputs, probeInput{
			Name:        p.name,
			InputBase64: base64.StdEncoding.EncodeToString([]byte(p.in)),
		})
	}

	// Every row of the dialect table contributes both a rejected case and an
	// accepted one, so the two lists cannot drift apart from the rules.
	for _, r := range dialectRules() {
		errs := ValidatePattern(r.reject, r.rejectFlags)
		f.Rejected = append(f.Rejected, rejectedCase{
			Code:          r.code,
			Pattern:       r.reject,
			JSPattern:     ToJS(r.reject),
			Flags:         nonNil(r.rejectFlags),
			Codes:         Codes(errs),
			JSSyntaxError: jsSyntaxErrorCases[r.code],
			Why:           r.divergence,
		})
		f.Accepted = append(f.Accepted, acceptedCaseFor(t, "rewrite-of-"+r.code, r.accept, r.acceptFlags))
	}

	// The two BOUNDED cost rules are bounds on a NUMBER, and the row-per-rule
	// table above states only their direction: every one of its rejects is
	// orders of magnitude past the limit, so a mirror that used 4,096 or 900
	// instead of 1,024 would reproduce it exactly. These straddle the limit by
	// one on each side, in both engines, so the constant itself is the contract.
	//
	// They also pin the ARITHMETIC, which the limits block cannot: alternation
	// branches sum where concatenation multiplies, an unbounded quantifier
	// counts one rather than infinity, and a group repeated at most once
	// multiplies nothing. A mirror that got any of those wrong lands on a
	// different side of at least one of these rows.
	for _, b := range []struct {
		code string // "" means the pattern must be ACCEPTED
		name string
		pat  string
		why  string
	}{
		{"", "width-exactly-at-the-limit", `[0-9]{1,32}[0-9]{1,32}z`,
			"width 1,024 = MaxRepetitionWidth exactly, and 1,858 ms against 2,000,000 digits in " +
				"Bun 1.3.14 — the most expensive pattern the dialect admits"},
		{ReasonRepetitionWidthTooLarge, "width-one-over-the-limit", `[0-9]{1,25}[0-9]{1,41}z`,
			"width 1,025: 25 x 41. One more than the row above, and the only difference between them"},
		{"", "width-branches-sum-they-do-not-multiply", `x{0,24}x{0,19}|y{0,24}y{0,19}`,
			"two branches of 500. A mirror that MULTIPLIED alternatives would see 250,000 and refuse it"},
		{ReasonRepetitionWidthTooLarge, "width-branches-sum-they-are-not-maxed", `x{0,24}x{0,24}|y{0,24}y{0,24}`,
			"two branches of 625 sum to 1,250. A mirror that took the MAX across branches would see " +
				"625 and accept it"},
		{"", "width-an-unbounded-quantifier-counts-one", `[^\n]+[a-z]{1,32}[a-z]{1,32}`,
			"if + counted as infinity this would be refused, and the DIB merchant anchor with it"},
		{ReasonNestedVariableRepetition, "nested-repeats-twice", `(?:[0-9]{1,4}){2}`,
			"TWO is where a repetition starts multiplying. Width is only 16 here, so the width rule " +
				"does not fire and this row isolates the nesting one"},
		{"", "nested-repeats-at-most-once", `(?:[0-9]{1,4}){0,1}`,
			"one repetition multiplies nothing. ([0-9]{1,4})? is the dialect's own rewrite for " +
				"([0-9]+)?, so a mirror that refused this would make unbounded_inside_quantified_group " +
				"inexpressible"},
		{"", "nested-fixed-width-interior", `(?:[a-z]{8}){8}`,
			"the SAME bound product of 64 as (?:[a-z0-9 ]{1,8}){8}, and 0.0 ms against the same subject"},
		{ReasonNestedVariableRepetition, "nested-variability-from-an-unbounded-interior", `(?:a+){2}`,
			"an UNBOUNDED interior makes its group variable, so BOTH codes are emitted and in this order. " +
				"The verdict was never in doubt — unbounded_inside_quantified_group alone refuses it — but " +
				"the code list is the contract, and a Go mutation that dropped the second code survived the " +
				"entire suite until this row existed"},
	} {
		if b.code == "" {
			if errs := ValidatePattern(b.pat, nil); len(errs) != 0 {
				t.Fatalf("boundary case %s must be accepted: %v", b.name, Codes(errs))
			}
			c := acceptedCaseFor(t, b.name, b.pat, nil)
			c.Why = b.why
			f.Accepted = append(f.Accepted, c)
			continue
		}
		errs := ValidatePattern(b.pat, nil)
		if !hasCode(errs, b.code) {
			t.Fatalf("boundary case %s must be rejected with %s: %v", b.name, b.code, Codes(errs))
		}
		f.Rejected = append(f.Rejected, rejectedCase{
			Code:      b.code,
			Pattern:   b.pat,
			JSPattern: ToJS(b.pat),
			Flags:     nonNil(nil),
			Codes:     Codes(errs),
			Why:       b.why,
		})
	}

	// The seed shapes, which are the patterns Task 21 actually ships.
	for _, s := range []struct {
		name  string
		pat   string
		flags []string
	}{
		{"seed-dib-amount", `المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`, nil},
		{"seed-dib-date", `بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})`, nil},
		{"seed-dib-merchant", `الدفع الى\n(?P<v>[^\n]+)`, nil},
		{"seed-dib-card", `رقم البطاقة\n(?P<v>[^ \n]+)`, nil},
		{"seed-enbd-alert-debit", `(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n](?:withdrawn|debited)[ \n]from your account`, []string{"i"}},
		// Verbatim from seed/enbd.alert.v1.json, and the WIDEST pattern the seed
		// set ships: 200, against a limit of 1,024. It is here because the two
		// bounded cost rules are the only rules in this dialect that a real
		// template can come close to failing, so the closest one is the row
		// that has to be checked in both engines rather than only in Go.
		{"seed-enbd-alert-credit-widest-shipping-pattern",
			`(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n](?:credited|deposited)[ \n](?:in)?to your account`,
			[]string{"i"}},
		{"seed-dib-account-transfer", `المعاملة\n[^\n]*(?:TRNSFER|TRANSFER)`, nil},
		{"seed-enbd-alert-last4", `account ending with (?P<v>[0-9]{4})`, []string{"i"}},
		{"seed-dib-direction-override", `DEBIT$`, []string{"i"}},
		// Not a seed, but the adversarial ToJS shape: an ESCAPED paren followed
		// by ?P<. It is dialect-valid, so it goes through the full probe
		// machinery and the two engines are compared on it directly rather
		// than only on a string-rewrite assertion.
		{"tojs-escaped-paren-not-a-named-group", `a\(?P<v`, nil},
	} {
		if errs := ValidatePattern(s.pat, s.flags); len(errs) != 0 {
			t.Fatalf("seed shape %s must be accepted: %v", s.name, errs)
		}
		f.Accepted = append(f.Accepted, acceptedCaseFor(t, s.name, s.pat, s.flags))
	}

	f.ToJS = []toJSCase{
		{Pattern: `(?P<amt>[0-9]+)`, JS: ToJS(`(?P<amt>[0-9]+)`), Why: "the rewrite"},
		{Pattern: `(?P<a>x)(?P<b>y)`, JS: ToJS(`(?P<a>x)(?P<b>y)`), Why: "every group, not only the first"},
		{Pattern: `(?:a)`, JS: ToJS(`(?:a)`), Why: "a non-capturing group is untouched"},
		{Pattern: `a\(?P<v`, JS: ToJS(`a\(?P<v`),
			Why: `an ESCAPED paren followed by ?P< is not a named group; a string replace would corrupt it`},
		{Pattern: `[(?P<x]`, JS: ToJS(`[(?P<x]`), Why: "inside a character class it is five literals"},
	}

	d := mustParse(t, validDefinitionJSON)
	canon, err := d.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	f.Canonical.DefinitionBase64 = base64.StdEncoding.EncodeToString([]byte(validDefinitionJSON))
	f.Canonical.CanonicalBase64 = base64.StdEncoding.EncodeToString(canon)
	return f
}

func acceptedCaseFor(t *testing.T, name, pattern string, flags []string) acceptedCase {
	t.Helper()
	re, err := CompileGo(pattern, flags)
	if err != nil {
		t.Fatalf("accepted pattern %q does not compile: %v", pattern, err)
	}
	c := acceptedCase{
		Name:       name,
		Pattern:    pattern,
		JSPattern:  ToJS(pattern),
		Flags:      nonNil(flags),
		GroupNames: nonNilNames(re),
	}
	for _, p := range probeCorpus() {
		c.Probes = append(c.Probes, probeOne(re, p.name, p.in))
	}
	return c
}

func probeOne(re *regexp.Regexp, name, in string) probeResult {
	r := probeResult{Input: name, Groups: map[string]*string{}}
	idx := re.FindStringSubmatchIndex(in)
	names := re.SubexpNames()
	for _, n := range names {
		if n != "" {
			r.Groups[n] = nil
		}
	}
	if idx == nil {
		return r
	}
	r.Match = true
	r.Text = b64ptr(in[idx[0]:idx[1]])
	for gi, n := range names {
		if n == "" {
			continue
		}
		// A group that did not participate is nil; a group that matched the
		// empty string is the empty string. Conflating the two is how an
		// EmptyGroups diagnostic goes wrong.
		if 2*gi+1 < len(idx) && idx[2*gi] >= 0 {
			r.Groups[n] = b64ptr(in[idx[2*gi]:idx[2*gi+1]])
		}
	}
	return r
}

func b64ptr(s string) *string {
	e := base64.StdEncoding.EncodeToString([]byte(s))
	return &e
}

func nonNil(ss []string) []string {
	if ss == nil {
		return []string{}
	}
	return ss
}

func nonNilNames(re *regexp.Regexp) []string {
	out := []string{}
	for _, n := range re.SubexpNames() {
		if n != "" {
			out = append(out, n)
		}
	}
	return out
}

// measuredDivergences is the evidence behind the ban list: every row was run in
// Go 1.25 and in JavaScript (Bun 1.3, V8 151 and WebKit 26.5 via Playwright)
// during Task 18. It is documentation with a machine-readable shape, not an
// assertion — the assertions are the rejected/accepted lists above.
func measuredDivergences() []engineDivergence {
	return []engineDivergence{
		{Name: `\s on U+00A0`, Pattern: `\s`, Flags: "u", Input: "U+00A0", Go: "false", JS: "true",
			Note: `Go's \s is [\t\n\f\r ]`},
		{Name: `\s on U+000B`, Pattern: `\s`, Flags: "u", Input: "U+000B", Go: "false", JS: "true",
			Note: "the vertical tab is ASCII, so this divergence does not need exotic input"},
		{Name: `\s on U+FEFF`, Pattern: `\s`, Flags: "u", Input: "U+FEFF", Go: "false", JS: "true", Note: ""},
		{Name: `\s on U+2028`, Pattern: `\s`, Flags: "u", Input: "U+2028", Go: "false", JS: "true", Note: ""},
		{Name: `. on CR`, Pattern: `^.$`, Flags: "u", Input: "\\r", Go: "true", JS: "false",
			Note: "(.+) appears in five of the six v1 seed anchors, which is why the bare dot is banned rather than documented"},
		{Name: `. on U+2028`, Pattern: `^.$`, Flags: "u", Input: "U+2028", Go: "true", JS: "false", Note: ""},
		{Name: `. on U+2029`, Pattern: `^.$`, Flags: "u", Input: "U+2029", Go: "true", JS: "false", Note: ""},
		{Name: `\b with i on U+212A`, Pattern: `\bk`, Flags: "iu", Input: "U+212A", Go: "false", JS: "true",
			Note: "JavaScript's word set gains U+017F and U+212A when i and u are both set; Go's never does"},
		{Name: `\p{Arabic}`, Pattern: `\p{Arabic}`, Flags: "u", Input: "U+0645", Go: "true", JS: "SyntaxError",
			Note: "JS spells it \\p{Script=Arabic}, which Go in turn rejects; this corpus is Arabic"},
		{Name: `\a`, Pattern: `\a`, Flags: "u", Input: "U+0007", Go: "true", JS: "SyntaxError",
			Note: "not on the spec's ban list; caught because the escape set is a whitelist"},
		{Name: `[[:alpha:]]`, Pattern: `^[[:alpha:]]+$`, Flags: "u", Input: "abc", Go: "true", JS: "SyntaxError",
			Note: "without the u flag JS reads it as a class of [ : a l p h followed by literals, silently"},
		{Name: `i without u, literal`, Pattern: `k`, Flags: "i", Input: "U+212A", Go: "true", JS: "false",
			Note: "THE reason the u flag is mandatory on the JavaScript side; with iu both say true"},
		{Name: `i without u, \w`, Pattern: `\w`, Flags: "i", Input: "U+212A", Go: "true", JS: "false",
			Note: "same cause; with iu both say true"},
		{Name: `^ and $ without m`, Pattern: `abc$`, Flags: "u", Input: `"abc\n"`, Go: "false", JS: "false",
			Note: "an AGREEMENT, recorded because Perl and Python disagree with both: neither Go nor JS " +
				"matches $ before a trailing newline, which is what makes the m flag ban free"},
		// Not engine DIVERGENCES but engine COSTS: the same pattern on the same
		// input, RE2 versus a backtracking engine. They are the evidence behind
		// multiple_unbounded_quantifiers, and they belong here because the whole
		// point of that rule is that Go alone cannot feel the harm.
		{Name: `cost: [0-9]+[0-9]+z`, Pattern: `[0-9]+[0-9]+z`, Flags: "u", Input: `"1" x 800`,
			Go: "microseconds", JS: "86 ms in Bun 1.3.14",
			Note: "two unbounded quantifiers that consume the same characters is O(n^2) in a backtracking engine"},
		{Name: `cost: [0-9]+[0-9]+[0-9]+[0-9]+z`, Pattern: `[0-9]+[0-9]+[0-9]+[0-9]+z`, Flags: "u", Input: `"1" x 400`,
			Go: "microseconds", JS: "88,191 ms in Bun 1.3.14",
			Note: "88 SECONDS on a 400-character attacker-chosen input; this is the measurement the rule was written for"},
		{Name: `cost: [^\n]+X[^\n]+Y`, Pattern: `[^\n]+X[^\n]+Y`, Flags: "u", Input: `"aX" x 4000`,
			Go: "microseconds", JS: "31,680 ms in Bun 1.3.14",
			Note: "separating the two quantifiers with a MANDATORY literal does not make the shape cheap, " +
				"it only changes which input triggers it — which is why the rule counts rather than looking for adjacency"},
		{Name: `cost: [0-9]{1,64}[0-9]+z`, Pattern: `[0-9]{1,64}[0-9]+z`, Flags: "u", Input: `"1" x 51200`,
			Go: "microseconds", JS: "73,810 ms in Bun 1.3.14",
			Note: "bounding one of the two is NOT the sanctioned rewrite: the bound becomes the constant. " +
				"Collapsing them is: [0-9]+[0-9]+ is [0-9]{2,}"},
		{Name: `cost: [0-9]+z (the residual)`, Pattern: `[0-9]+z`, Flags: "u", Input: `"1" x 200000`,
			Go: "microseconds", JS: "17,935 ms in Bun 1.3.14",
			Note: "ONE unbounded quantifier is still quadratic, and the dialect allows it. What keeps the real " +
				"templates cheap is their leading literal anchor: the DIB merchant anchor on a hostile 1 MB body " +
				"is 1.9 ms. See TestKNOWNASingleUnboundedQuantifierIsStillQuadraticInJavaScript"},
		{Name: `bun: [a-z] with iu on U+212A`, Pattern: `[a-z]`, Flags: "iu", Input: "U+212A",
			Go: "true", JS: "true in V8 and WebKit, FALSE in Bun 1.3.14",
			Note: "A BUN BUG, not a dialect issue: Go, V8 and WebKit 26.5 all match, so the shipping client " +
				"(a browser) agrees with the server and no rule is needed. It matters only because `bun test` " +
				"is this repository's gate, so a conformance probe that relied on case-insensitive folding of " +
				"a class RANGE into a non-ASCII code point would fail in CI while the real client was correct. " +
				"client/src/tmpl/agreement.test.ts pins it so a Bun fix is noticed rather than silently changing " +
				"what the gate means."},
	}
}

// TestWriteDialectConformanceFixtures regenerates the committed file.
//
//	LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/tmpl/ -run TestWriteDialectConformanceFixtures
func TestWriteDialectConformanceFixtures(t *testing.T) {
	if os.Getenv(writeFixturesEnv) == "" {
		t.Skipf("set %s=1 to regenerate %s", writeFixturesEnv, dialectConformancePath)
	}
	b, err := encodeDialectFixture(buildDialectFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dialectConformancePath, b, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s (%d bytes)", dialectConformancePath, len(b))
}

// TestDialectConformanceFixturesAreWhatThisBuildProduces is the guard against
// the committed file going stale. Without it a change to a reason code would
// leave TypeScript checking itself against a snapshot of a validator that no
// longer exists.
func TestDialectConformanceFixturesAreWhatThisBuildProduces(t *testing.T) {
	want, err := encodeDialectFixture(buildDialectFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dialectConformancePath)
	if err != nil {
		t.Fatalf("%v; regenerate with %s=1 go test ./internal/v2/tmpl/ -run TestWriteDialectConformanceFixtures", err, writeFixturesEnv)
	}
	if !bytes.Equal(bytes.TrimSpace(got), bytes.TrimSpace(want)) {
		t.Fatalf("%s is stale: this build produces different bytes. Regenerate with\n"+
			"  %s=1 go test ./internal/v2/tmpl/ -run TestWriteDialectConformanceFixtures",
			dialectConformancePath, writeFixturesEnv)
	}
}

func encodeDialectFixture(f dialectFixture) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	if err := e.Encode(f); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// The fixture is only worth anything if the accepted patterns really do
// exercise the hostile inputs, so assert that the corpus is not inert.
func TestTheProbeCorpusActuallyExercisesTheAcceptedPatterns(t *testing.T) {
	f := buildDialectFixture(t)
	matches := 0
	for _, a := range f.Accepted {
		for _, p := range a.Probes {
			if p.Match {
				matches++
			}
		}
	}
	if matches < len(f.Accepted) {
		t.Fatalf("only %d probe matches across %d accepted patterns; the corpus is not exercising them",
			matches, len(f.Accepted))
	}
	// And every named group of every seed shape must be captured by at least
	// one probe, or the fixture proves nothing about capture agreement.
	for _, a := range f.Accepted {
		if !strings.HasPrefix(a.Name, "seed-") {
			continue
		}
		for _, g := range a.GroupNames {
			captured := false
			for _, p := range a.Probes {
				if p.Groups[g] != nil {
					captured = true
				}
			}
			if !captured {
				t.Errorf("no probe input makes %s capture group %q, so the fixture cannot compare it", a.Name, g)
			}
		}
	}
}

func TestCompileGoAppliesTheIFlag(t *testing.T) {
	re, err := CompileGo(`aed`, []string{"i"})
	if err != nil {
		t.Fatal(err)
	}
	if !re.MatchString("AED") {
		t.Error(`flags ["i"] must make the pattern case-insensitive`)
	}
	re, err = CompileGo(`aed`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if re.MatchString("AED") {
		t.Error("no flags must stay case-sensitive")
	}
}
