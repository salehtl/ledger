package tmpl

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// codesOf flattens the validator's errors to their stable reason codes, which
// is the only part of an error the TypeScript mirror (Task 20) has to agree on.
func codesOf(errs []error) []string { return Codes(errs) }

func hasCode(errs []error, code string) bool {
	for _, c := range codesOf(errs) {
		if c == code {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// The dialect table itself.
//
// One row per rule. Each row carries BOTH directions: a pattern that must be
// rejected with that row's code, and the sanctioned rewrite that must be
// accepted. A ban with no accepted counterpart is a ban that makes templates
// inexpressible — the exact defect that shipped in the first draft of this
// plan — so the table is structured to make that impossible to write down.
// ---------------------------------------------------------------------------

type dialectRule struct {
	code         string
	reject       string
	rejectFlags  []string
	accept       string
	acceptFlags  []string
	divergence   string // the measured Go/JS difference, or the cost bound
	rejectIsLong bool   // reject/accept built at runtime rather than literal
}

func dialectRules() []dialectRule {
	long := strings.Repeat("a", MaxPatternRunes+1)
	ok := strings.Repeat("a", MaxPatternRunes)
	nine := strings.Repeat("(a)", MaxCaptureGroups+1)
	eight := strings.Repeat("(a)", MaxCaptureGroups)

	return []dialectRule{
		{code: ReasonEmptyPattern, reject: ``, accept: `a`,
			divergence: "an empty pattern matches everything; never intended"},
		{code: ReasonPatternTooLong, reject: long, accept: ok, rejectIsLong: true,
			divergence: "bounded cost"},
		{code: ReasonTooManyCaptureGroups, reject: nine, accept: eight, rejectIsLong: true,
			divergence: "bounded cost"},
		{code: ReasonEscapePerlSpace, reject: `AED\s+([0-9]+)`, accept: `AED[ \n]+[0-9]+`,
			divergence: `Go \s is [\t\n\f\r ]; JS \s additionally matches \v, U+00A0, U+FEFF and the Unicode space separators`},
		{code: ReasonEscapeWordBoundary, reject: `\bAED\b`, accept: `AED`,
			divergence: `with the i flag JS's word set gains U+017F and U+212A, Go's does not: (?i)\bk vs /\bk/iu on U+212A is false in Go, true in JS`},
		{code: ReasonEscapeUnicodeClass, reject: `\p{Arabic}`, accept: `[\x41-\x5a]`,
			divergence: `Go accepts \p{Arabic} and rejects \p{Script=Arabic}; JS under u does the exact opposite`},
		{code: ReasonEscapeUnicodeCodepoint, reject: `\x{0623}`, accept: `\x41`,
			divergence: `\x{...} is a SyntaxError in JS under u; \u{...} does not compile in Go`},
		{code: ReasonEscapeTextAnchor, reject: `\Ax`, accept: `^x`,
			divergence: `\A, \z and \Z compile in Go and are a SyntaxError in JS`},
		{code: ReasonEscapeBackreference, reject: `(a)\1`, accept: `(a)a`,
			divergence: "backreferences are absent from RE2 and unbounded in JS"},
		{code: ReasonEscapeNotAllowed, reject: `\a`, accept: `\t`,
			divergence: `\a is BEL in Go and a SyntaxError in JS under u; the escape set is a whitelist, so every such escape is caught, not only the named ones`},
		{code: ReasonMalformedEscape, reject: `a\`, accept: `a\\`,
			divergence: "a trailing backslash is not a pattern"},
		{code: ReasonInlineFlags, reject: `(?i)aed`, accept: `aed`, acceptFlags: []string{"i"},
			divergence: "JS has no inline flag groups; declare flags on the Extract entry"},
		{code: ReasonLookaround, reject: `(?=x)`, accept: `x`,
			divergence: "lookaround is a backtracking construct and RE2 lacks it"},
		{code: ReasonNamedGroupJSSyntax, reject: `(?<amt>[0-9])`, accept: `(?P<amt>[0-9])`,
			divergence: "one stored spelling only, so ToJS is total and the stored text is what Go runs"},
		{code: ReasonUnsupportedGroup, reject: `(?P=amt)`, accept: `(?P<amt>[0-9])`,
			divergence: "(?P=, (?P> and (?# exist in Go or PCRE and not in JS"},
		{code: ReasonInvalidGroupName, reject: `(?P<0a>x)`, accept: `(?P<a0>x)`,
			divergence: `Go accepts (?P<0a>...); JS under u rejects it. Go rejects (?<a$b>...); JS accepts it`},
		{code: ReasonDuplicateGroupName, reject: `(?P<v>a)(?P<v>b)`, accept: `(?P<v>a)(?P<w>b)`,
			divergence: "Go accepts duplicate capture names, JS rejects them"},
		{code: ReasonUnbalancedParen, reject: `(a`, accept: `(a)`,
			divergence: "structural"},
		{code: ReasonBareDot, reject: `Debit Amount:\n(.+)`, accept: `Debit Amount:\n([^\n]+)`,
			divergence: `Go's . matches \r, U+2028 and U+2029; JS's does not`},
		{code: ReasonGroupUnboundedQuantifier, reject: `(ab)+c`, accept: `(ab)?c`,
			divergence: "an unbounded quantifier on a group is the catastrophic-backtracking shape"},
		{code: ReasonUnboundedInsideQuantifiedGroup, reject: `([0-9]+)?`, accept: `([0-9]{1,4})?`,
			divergence: "(a+)+ nesting turns bounded work exponential in a backtracking engine"},
		{code: ReasonBoundProductTooLarge, reject: `((a{4}){4}){5}`, accept: `((a{4}){4}){4}`,
			divergence: "bounded match length"},
		{code: ReasonMalformedRepetition, reject: `a{,3}`, accept: `a{0,3}`,
			divergence: "Go reads a{,3} as five literal characters; JS under u makes it a SyntaxError"},
		{code: ReasonEmptyCharClass, reject: `[]`, accept: `[a]`,
			divergence: "Go rejects []; JS under u reads it as a class that never matches"},
		{code: ReasonUnterminatedCharClass, reject: `[abc`, accept: `[abc]`,
			divergence: "structural"},
		{code: ReasonClassLiteralBracket, reject: `[[:alpha:]]`, accept: `[a-zA-Z]`,
			divergence: "Go compiles [[:alpha:]] as a POSIX class; JS under u makes it a SyntaxError, and without u it silently means something else"},
		{code: ReasonFlagNotAllowed, reject: `x`, rejectFlags: []string{"m"}, accept: `x`, acceptFlags: []string{"i"},
			divergence: `JS's m treats \r, U+2028 and U+2029 as line terminators for ^/$ and Go's does not`},
		{code: ReasonDuplicateFlag, reject: `x`, rejectFlags: []string{"i", "i"}, accept: `x`, acceptFlags: []string{"i"},
			divergence: "a flag list is a set; a repeat is an authoring mistake"},
		{code: ReasonNotCompilable, reject: `[z-a]`, accept: `[a-z]`,
			divergence: "the structural scanner is not a parser; Go's own compiler is the backstop"},
	}
}

func TestEveryDialectRuleRejectsItsConstructAndAcceptsItsRewrite(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range dialectRules() {
		if seen[r.code] {
			t.Errorf("duplicate rule code %q in the table", r.code)
		}
		seen[r.code] = true

		errs := ValidatePattern(r.reject, r.rejectFlags)
		if !hasCode(errs, r.code) {
			name := r.reject
			if r.rejectIsLong {
				name = "<generated>"
			}
			t.Errorf("rule %s: pattern %q flags %v must be rejected with that code, got %v",
				r.code, name, r.rejectFlags, codesOf(errs))
		}

		if errs := ValidatePattern(r.accept, r.acceptFlags); len(errs) != 0 {
			name := r.accept
			if r.rejectIsLong {
				name = "<generated>"
			}
			t.Errorf("rule %s: sanctioned rewrite %q flags %v must be accepted, got %v",
				r.code, name, r.acceptFlags, codesOf(errs))
		}
	}

	for _, c := range AllReasonCodes() {
		if !seen[c] {
			t.Errorf("reason code %q is defined but has no row in the dialect table (so it has no accept/reject pair)", c)
		}
	}
}

// TestValidatePatternRejectsTheDivergentAndUnsafeConstructs is the brief's own
// list, kept verbatim so a refactor of the table above cannot quietly drop it.
func TestValidatePatternRejectsTheDivergentAndUnsafeConstructs(t *testing.T) {
	for _, p := range []string{
		`AED\s+([0-9]+)`, `\bAED\b`, `(?i)aed`, `(?=x)`, `(a)\1`,
		`\p{Arabic}`, `\x{0623}`, `\Ax`,
		`(ab)+c`, `(ab)*c`, `(ab){2,}c`, // unbounded quantifier on a group
		`([0-9]+)?`, `(a|b*)?`, // unbounded quantifier INSIDE a quantified group
		`Debit Amount:\n(.+)`, // bare dot
		strings.Repeat("a", MaxPatternRunes+1),
	} {
		if errs := ValidatePattern(p, nil); len(errs) == 0 {
			t.Errorf("pattern %q must be rejected", p)
		}
	}
	if errs := ValidatePattern(`x`, []string{"m"}); len(errs) == 0 {
		t.Error(`flag "m" must be rejected`)
	}
}

// TestValidatePatternAcceptsTheSeedShapes is the acceptance test the first
// draft of this plan could not satisfy: four v1 patterns (dib.go:21,
// enbd_alert.go:25, enbd_alert.go:26, fields.go:13) use the optional
// currency-prefix shape, which needs `?` applied to a group.
func TestValidatePatternAcceptsTheSeedShapes(t *testing.T) {
	for _, p := range []string{
		`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]*\.[0-9]{2})`,
		`Debit Amount:\n(?P<amt>[^\n]+)`,
		`account ending with (?P<v>[0-9]{4})`,
		`بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})`,
		`(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]*\.[0-9]{2})[ \n]has been[ \n](?:withdrawn|debited)[ \n]from your account`,
	} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("pattern %q rejected: %v", p, errs)
		}
	}
}

// The seed patterns that carry the i flag (Task 21 converts v1's `(?i)` prefix
// to `"flags":["i"]`) must also pass.
func TestValidatePatternAcceptsTheSeedShapesUnderTheIFlag(t *testing.T) {
	for _, p := range []string{
		`(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]*\.[0-9]{2})[ \n]has been[ \n](?:credited|deposited)[ \n](?:in)?to your account`,
		`account ending with (?P<v>[0-9]{4})`,
		`DEBIT$`,
	} {
		if errs := ValidatePattern(p, []string{"i"}); len(errs) != 0 {
			t.Errorf("pattern %q with flags [i] rejected: %v", p, errs)
		}
	}
}

// The bounded-quantifier-on-a-group rule is the one that was corrected, so it
// gets its own test rather than only a table row.
func TestBoundedQuantifiersOnAGroupAreAllowedAndUnboundedOnesAreNot(t *testing.T) {
	for _, p := range []string{`(ab)?`, `(ab){2,3}`, `(ab){3}`, `(?:[A-Z]{3} )?`, `(?P<ccy>[A-Z]{3} )?`} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("bounded group quantifier %q must be allowed: %v", p, errs)
		}
	}
	for _, p := range []string{`(ab)*`, `(ab)+`, `(ab){2,}`, `(?:ab)*`} {
		if !hasCode(ValidatePattern(p, nil), ReasonGroupUnboundedQuantifier) {
			t.Errorf("unbounded group quantifier %q must be rejected", p)
		}
	}
}

func TestUnboundedInsideAQuantifiedGroupIsRejectedAtEveryDepth(t *testing.T) {
	for _, p := range []string{`([0-9]+)?`, `(a|b*)?`, `((a+))?`, `((a+){2}){2}`, `(a[b-c]*d){1,2}`} {
		if !hasCode(ValidatePattern(p, nil), ReasonUnboundedInsideQuantifiedGroup) {
			t.Errorf("%q nests an unbounded quantifier in a quantified group and must be rejected: %v",
				p, codesOf(ValidatePattern(p, nil)))
		}
	}
	// The same shapes are fine when the enclosing group is NOT quantified —
	// which is what every seed amount anchor relies on.
	for _, p := range []string{`([0-9]+)`, `(a|b*)`, `(?P<amt>[0-9][0-9,]*\.[0-9]{2})`} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q has no quantified group and must be accepted: %v", p, errs)
		}
	}
}

func TestBoundProductIsMeasuredAlongTheNestingPath(t *testing.T) {
	for _, p := range []string{`((a{4}){4}){4}`, `a{64}`, `(a{8}){8}`} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q is exactly at the bound and must be accepted: %v", p, errs)
		}
	}
	for _, p := range []string{`((a{4}){4}){5}`, `a{65}`, `(a{9}){8}`} {
		if !hasCode(ValidatePattern(p, nil), ReasonBoundProductTooLarge) {
			t.Errorf("%q exceeds the bound product and must be rejected: %v", p, codesOf(ValidatePattern(p, nil)))
		}
	}
}

// A bare dot must be recognised as a dot and nothing else must be mistaken for
// one — the scanner tracks escape and character-class state for this reason.
func TestBareDotDetectionTracksEscapeAndClassState(t *testing.T) {
	for _, p := range []string{`a.b`, `[a]. `, `(?P<v>.)`} {
		if !hasCode(ValidatePattern(p, nil), ReasonBareDot) {
			t.Errorf("%q contains a bare dot and must be rejected", p)
		}
	}
	for _, p := range []string{`a\.b`, `[.]`, `[a.b]`, `[^\n]`, `\.`} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q contains no bare dot and must be accepted: %v", p, errs)
		}
	}
}

func TestValidatePatternReportsTheOffendingOffset(t *testing.T) {
	errs := ValidatePattern(`المبلغ\s`, nil)
	if len(errs) != 1 {
		t.Fatalf("want one error, got %v", errs)
	}
	pe, okType := errs[0].(*PatternError)
	if !okType {
		t.Fatalf("want *PatternError, got %T", errs[0])
	}
	// Offsets are RUNE indices, not byte indices, so the TypeScript mirror can
	// reproduce them from [...p] without knowing anything about UTF-8.
	if pe.Offset != 6 {
		t.Errorf("offset = %d, want 6 (rune index of the backslash)", pe.Offset)
	}
	if !strings.Contains(pe.Error(), ReasonEscapePerlSpace) {
		t.Errorf("Error() must name the reason code, got %q", pe.Error())
	}
}

func TestToJSRewritesNamedGroups(t *testing.T) {
	if got := ToJS(`(?P<amt>[0-9]+)`); got != `(?<amt>[0-9]+)` {
		t.Fatalf("got %q", got)
	}
}

// ToJS is a scanner, not a string replace: `\(` followed by `?P<` is an escaped
// paren, an optional quantifier and three literals. A ReplaceAll would corrupt
// it into a named group and change what JavaScript runs.
func TestToJSDoesNotRewriteAnEscapedParenFollowedByPAngle(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`(?P<amt>[0-9]+)`, `(?<amt>[0-9]+)`},
		{`a\(?P<v`, `a\(?P<v`},
		{`[(?P<x]`, `[(?P<x]`},
		{`(?P<a>x)(?P<b>y)`, `(?<a>x)(?<b>y)`},
		{`(?:a)`, `(?:a)`},
		{`\\(?P<v>x)`, `\\(?<v>x)`},
	} {
		if got := ToJS(tc.in); got != tc.want {
			t.Errorf("ToJS(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Every pattern the dialect accepts must still be a pattern Go can run, and the
// rewrite must still be a pattern Go can run — a ToJS that produced garbage
// would be invisible to the Go tests alone.
func TestEveryAcceptedPatternCompilesInGo(t *testing.T) {
	for _, r := range dialectRules() {
		if _, err := regexp.Compile(r.accept); err != nil {
			t.Errorf("accepted pattern %q does not compile in Go: %v", r.accept, err)
		}
	}
}

// The spec document is where a human learns the dialect, and a ban whose
// reason is only in a Go comment is a ban the next person will "simplify"
// away. Keep them in step.
func TestEveryReasonCodeIsDocumentedInTheSpec(t *testing.T) {
	const spec = "../../../docs/superpowers/specs/v2-template-format.md"
	b, err := os.ReadFile(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range AllReasonCodes() {
		if !strings.Contains(string(b), c) {
			t.Errorf("reason code %q has no row in %s", c, spec)
		}
	}
}
