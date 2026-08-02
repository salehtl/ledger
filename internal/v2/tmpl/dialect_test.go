package tmpl

import (
	"encoding/json"
	"os"
	"path/filepath"
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
		{code: ReasonEscapePerlSpace, reject: `AED\s+([0-9]+)`, accept: `AED[ \n]{1,4}([0-9]+)`,
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
		{code: ReasonMultipleUnboundedQuantifiers, reject: `[0-9]+[0-9]+z`, accept: `[0-9]{2,}z`,
			divergence: "the POLYNOMIAL backtracking shape: n^k for k unbounded quantifiers that can consume " +
				"the same characters. MEASURED in Bun 1.3.14: [0-9]+[0-9]+z is 86 ms on 800 characters, " +
				"[0-9]+[0-9]+[0-9]+[0-9]+z is 88,191 ms on 400, and separating them with a mandatory literal " +
				"does not help ([^\\n]+X[^\\n]+Y is 31,680 ms on 8,000). Go's RE2 does not backtrack and is " +
				"unaffected, so this is a CLIENT-side cost rule, not an engine divergence"},
		{code: ReasonNestedVariableRepetition, reject: `(?:[0-9]{1,4}){4}`, accept: `[0-9]{4,16}`,
			divergence: "the BOUNDED analogue of unbounded_inside_quantified_group, and the hole it left: a " +
				"group that repeats more than once re-splits its own contents on every repeat, so a " +
				"variable-length interior is raised to the power of the repeat count. MEASURED in Bun 1.3.14 " +
				"on a 512-rune subject: (?:[a-z0-9 ]{1,8}){8}z is 2,178 ms and (?:(?:[a-z]{1,4}){4}){4}z is " +
				"1,948 ms, while (?:[a-z]{8}){8}z — the SAME bound product of 64, fixed-width interior — is " +
				"0.0 ms, which is why no tightening of MaxBoundProduct separates them. '?' and {0,1} are " +
				"exempt: one repetition multiplies nothing, and ([0-9]{1,4})? is this table's own rewrite for " +
				"([0-9]+)?. RE2 does not backtrack, so this is a client-side cost rule"},
		{code: ReasonRepetitionWidthTooLarge, reject: `[0-9]{1,16}[0-9]{1,16}[0-9]{1,16}z`, accept: `[0-9]{3,48}z`,
			divergence: "the same explosion reached by CONCATENATION rather than nesting, which no nesting " +
				"rule can see: three sibling runs nest nothing and quantify no group. MEASURED in Bun 1.3.14: " +
				"eight sibling [a-z]{1,8} runs took 7,140 ms on a 512-character body, and " +
				"[0-9]{1,64}[0-9]{1,64}z took 8,711 ms at MaxBodyBytes (2,000,000 digits) — measured there, " +
				"not extrapolated from a smaller run. The bound is the number of ways one branch can split " +
				"the same input, which is what MaxBoundProduct (a bound on match LENGTH) does not measure. " +
				"1,024 is exactly the widest collapsible pair MaxBoundProduct still permits: {1,a}{1,b} " +
				"collapses to {2,a+b}, a+b <= 64 maximises a*b at 32*32; the widest pattern the seed set " +
				"actually ships is 200, and the widest this rule ADMITS still costs 1,858 ms at MaxBodyBytes"},
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
		`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`,
		`Debit Amount:\n(?P<amt>[^\n]+)`,
		`account ending with (?P<v>[0-9]{4})`,
		`بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})`,
		`(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n](?:withdrawn|debited)[ \n]from your account`,
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
		`(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n](?:credited|deposited)[ \n](?:in)?to your account`,
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
	for _, p := range []string{`([0-9]+)`, `(a|b*)`, `(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q has no quantified group and must be accepted: %v", p, errs)
		}
	}
}

// The polynomial-backtracking rule, added in Task 20 to close a gap Task 19
// MEASURED and pinned rather than fixed.
//
// Task 18's two nesting rules stop the EXPONENTIAL (a+)+ shape. They do not
// stop the POLYNOMIAL one — several unbounded quantifiers that can consume the
// same characters — which Go's RE2 is immune to and JavaScript is not. Measured
// in Bun 1.3.14 with `new RegExp(p, "u").test(input)`:
//
//	[0-9]+[0-9]+z               "1"x800          86 ms
//	[0-9]+[0-9]+[0-9]+z         "1"x800      17,274 ms
//	[0-9]+[0-9]+[0-9]+[0-9]+z   "1"x400      88,191 ms
//	[^\n]+X[^\n]+Y              "aX"x4000    31,680 ms
//	[^\n]+X[^\n]+Y[^\n]+Z       "aXbY"x500   33,373 ms
//
// The last two are why the rule COUNTS unbounded quantifiers rather than
// looking for adjacent ones: separating them with a mandatory literal does not
// make the shape cheap, it only requires an input in which the separators
// match. One per alternation branch is the bound, because a branch is the unit
// the engine explores.
func TestMultipleUnboundedQuantifiersInOneBranchAreRejected(t *testing.T) {
	for _, p := range []string{
		`[0-9]+[0-9]+z`,                  // adjacent, identical classes
		`[0-9]+[0-9]+[0-9]+[0-9]+z`,      // the 88-second shape
		`[^\n]+X[^\n]+Y`,                 // separated by a mandatory literal
		`[^\n]+X[^\n]+Y[^\n]+Z`,          // and again
		`(?P<v>[0-9]+)[0-9]+z`,           // one of them inside a capture group
		`[0-9]+[a-z]*[0-9]+z`,            // three, one of them nullable
		`(a+)(b+)`,                       // one per group, same branch
		`(a+|b)c+`,                       // group's worst branch plus a sibling
		`[0-9]{2,}[0-9]{3,}z`,            // {n,} is unbounded too
		`[0-9]+[0-9a-z]+z`,               // overlapping, not identical
		`(?:a+)(?:b+)`,                   // non-capturing changes nothing
		`[0-9a-z]*[0-9]*[0-9a-z]*[0-9]*`, // four
	} {
		if !hasCode(ValidatePattern(p, nil), ReasonMultipleUnboundedQuantifiers) {
			t.Errorf("%q has more than one unbounded quantifier in a branch and must be rejected: %v",
				p, codesOf(ValidatePattern(p, nil)))
		}
	}

	// One per BRANCH is the bound, not one per pattern: alternation branches are
	// explored independently, so `a+|b+` costs what `a+` costs. Every seed anchor
	// this corpus needs has exactly one.
	for _, p := range []string{
		`[0-9]{2,}z`,      // the sanctioned rewrite of [0-9]+[0-9]+z
		`[0-9]+z|[a-z]+q`, // one per branch
		`(a+|b+)c`,
		`(?:[0-9]+|[a-z]+)X`,
		`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`,
		`الدفع الى\n(?P<v>[^\n]+)`,
		`المعاملة\n[^\n]*DEBIT(?:\n|$)`,
		// Bounded quantifiers do not count toward THIS bound. They are counted
		// by MaxRepetitionWidth instead, and this row used to be
		// `[0-9]{1,64}[0-9]{1,64}z` — width 4,096, and 827 ms on 200,000 digits
		// in Bun 1.3.14, and 8,711 ms measured at MaxBodyBytes. The claim
		// being made here is "bounded quantifiers are not unbounded ones", and
		// it is made with a pair that is genuinely cheap (2.7 ms on the same
		// 200,000 digits) rather than with one that is a DoS by another name.
		`[0-9]{1,4}[0-9]{1,4}z`,
	} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q has at most one unbounded quantifier per branch and must be accepted: %v", p, errs)
		}
	}
}

// The two BOUNDED cost rules, which close the hole Task 20 measured on the
// categorization path and deliberately left open here.
//
// Task 18's two nesting rules stop the exponential (a+)+ shape and Task 20's
// MaxUnboundedPerBranch stops the polynomial one. Neither says anything about a
// pattern built entirely out of BOUNDED quantifiers, and MaxBoundProduct — a
// product of quantifier UPPER bounds — bounds how long a match may be, not how
// many ways it may be assembled. Measured in Bun 1.3.14 with re.exec against
// "a" x 512 — a subject that FAILS to match, which is what a backtracking
// engine pays for — and every one of these PASSED the dialect before these two
// rules existed:
//
//	pattern                            width   anchored/512   unanchored/512
//	(?:[a-z]{8}){8}z                        1        0.0 ms          0.0 ms
//	(?:[a-z0-9 ]{1,4}){8}z             65,536        0.3 ms        131.0 ms
//	(?:[a-z0-9 ]{1,8}){8}z         16,777,216       54.9 ms      2,178.0 ms
//	(?:(?:[a-z]{1,4}){4}){4}z       4.3 x 10^9    2,146.7 ms      1,948.0 ms
//	[a-z]{1,8} x8, CONCATENATED    16,777,216       16.3 ms      7,140.0 ms
//
// The first two rows have the SAME bound product (64), which is the whole
// argument for a second bound: 0.0 ms and 131 ms are indistinguishable to the
// number this dialect was calibrated on. The last row is why the width bound
// exists as well as the nesting one — eight siblings nest nothing. The fourth
// is why an anchor is not a defence: ^...$ made it no cheaper at all.
func TestVariableRepetitionInsideARepeatedGroupIsRejected(t *testing.T) {
	for _, p := range []string{
		`(?:[a-z0-9 ]{1,8}){8}z`,    // 2,178 ms unanchored
		`(?:(?:[a-z]{1,4}){4}){4}z`, // 1,948 ms unanchored, 2,147 ms even ANCHORED
		`(?:[a-z0-9 ]{1,4}){8}z`,    // 131 ms unanchored, and only 0.3 ms anchored
		// The next three are measured on "a" x 60 with a forced-fail 'z'
		// suffix, because as written they match at offset 0 and cost nothing.
		// Sixty characters is the point: these are EXPONENTIAL, so the subject
		// that hurts is tiny rather than large.
		`(?:a?){60}`,                // 1,094 ms: '?' on the INTERIOR is variable
		`(?:a|aa){30}`,              // 684 ms: so is an alternation of unequal lengths
		`(?:a|){40}`,                // 1,499 ms: so is an empty branch
		`(?:[)]{1,4}x){4}`,          // a ')' inside a class does not close a group
		`(?:[\]a]{1,4}){4}`,         // nor does an escaped ']' end one
		`(?:a{1,4}?){4}`,            // lazy is the same shape
		`(?P<v>[0-9]{1,4}){2}`,      // a capture group is a group
		`(?:(?:a|bcd)x){2}`,         // the variability is one level down
		`(?:[0-9]{1,4}){2,4}`,       // a RANGE on the outer group repeats too
		`(?:[0-9]{1,4}){0,2}`,       // ...including one that may repeat zero times
		`(?:(?:[0-9]{1,4})?x?y){2}`, // nested optionals
		`(?:[0-9]{1,4}\-[0-9]{2}){3}`,
	} {
		if !hasCode(ValidatePattern(p, nil), ReasonNestedVariableRepetition) {
			t.Errorf("%q repeats a variable-length group and must be rejected: %v",
				p, codesOf(ValidatePattern(p, nil)))
		}
	}

	// The controls, and they are not decoration: a rule that refused all of
	// these would be a rule that makes the corpus inexpressible. Every one is
	// either a shipping seed shape or this table's own sanctioned rewrite.
	for _, p := range []string{
		`(?:[a-z]{8}){8}`,   // fixed-width interior, same bound product as the first reject
		`[a-z]{1,64}`,       // variable, but nothing repeats it
		`([0-9]{1,4})?`,     // THE sanctioned rewrite for ([0-9]+)? — '?' repeats at most once
		`([0-9]{1,4}){0,1}`, // the same thing spelled out
		`([0-9]{1,4}){1}`,   // and repeated exactly once
		`(?:ab|cd){8}`,      // an alternation of EQUAL lengths is fixed-width
		`[0-9]{4,16}`,       // the sanctioned rewrite for (?:[0-9]{1,4}){4}
		`(ab){2,3}`,
		`((a{4}){4}){4}`,
		`\(a{1,4}\){4}`,    // an ESCAPED paren opens no group
		`(?:[a{1,4}]x){4}`, // a quantifier-shaped run inside a class is literal text
		`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`,
		`(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n](?:withdrawn|debited)[ \n]from your account`,
	} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q does not repeat a variable-length group and must be accepted: %v", p, codesOf(errs))
		}
	}
}

// The sanctioned rewrite has to be a rewrite. A ban whose replacement means
// something else silently changes what a template extracts, which is the defect
// the accept/reject table exists to prevent — so the two are run against the
// same inputs and compared, not merely both accepted.
func TestTheRewritesForTheBoundedCostRulesMeanTheSameThing(t *testing.T) {
	for _, pair := range []struct{ banned, rewrite string }{
		{`(?:[0-9]{1,4}){4}`, `[0-9]{4,16}`},
		{`[0-9]{1,16}[0-9]{1,16}[0-9]{1,16}z`, `[0-9]{3,48}z`},
	} {
		a := regexp.MustCompile(pair.banned)
		b := regexp.MustCompile(pair.rewrite)
		for _, s := range []string{
			"", "z", "1", "12", "123", "1234", "12345", "1z", "12z", "123z", "1234z",
			strings.Repeat("9", 15), strings.Repeat("9", 16), strings.Repeat("9", 17),
			strings.Repeat("9", 47) + "z", strings.Repeat("9", 48) + "z", strings.Repeat("9", 49) + "z",
			"a1234b", "١٢٣٤",
		} {
			if got, want := b.FindString(s), a.FindString(s); got != want {
				t.Errorf("%q vs %q on %q: rewrite matched %q, banned matched %q",
					pair.rewrite, pair.banned, s, got, want)
			}
		}
	}
}

func TestTheBacktrackingWidthOfOneBranchIsBounded(t *testing.T) {
	for _, p := range []string{
		`[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}z`, // 7,140 ms
		`[0-9]{1,64}[0-9]{1,64}z`,  // 8,711 ms at MaxBodyBytes
		`[0-9]{1,25}[0-9]{1,41}z`,  // 1,025 — ONE over the limit; see the pair below
		`x{0,24}x{0,24}x{0,24}`,    // 15,625
		`(?:a|bcd){20}`,            // an alternation is a choice too
		`a?a?a?a?a?a?a?a?a?a?a?bz`, // 2,048: eleven CONCATENATED optionals, no group at all
	} {
		if !hasCode(ValidatePattern(p, nil), ReasonRepetitionWidthTooLarge) {
			t.Errorf("%q can split one branch more than %d ways and must be rejected: %v",
				p, MaxRepetitionWidth, codesOf(ValidatePattern(p, nil)))
		}
	}
	for _, p := range []string{
		`[0-9]{1,4}[0-9]{1,4}z`,   // 16
		`x{0,24}x{0,24}`,          // 625
		`[0-9]{1,25}[0-9]{1,40}z`, // 1,000
		`[0-9]{1,32}[0-9]{1,32}z`, // exactly 1,024, the widest MaxBoundProduct permits a collapsible pair
		`[0-9]{3,48}z`,            // the sanctioned rewrite
		`a?a?a?a?a?a?a?a?a?a?bz`,  // 1,024: ten concatenated optionals, one short of the reject above
		`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})`, // 50
		`الدفع الى\n(?P<v>[^\n]+)`,                                        // an UNBOUNDED quantifier counts 1, not infinity
		// The widest pattern the seed set actually ships, at 200. It is the one
		// row here whose acceptance is not a matter of taste: refusing it would
		// mean no ENBD credit alert parses at all.
		`(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n](?:credited|deposited)[ \n](?:in)?to your account`,
	} {
		if errs := ValidatePattern(p, nil); len(errs) != 0 {
			t.Errorf("%q is within the width bound and must be accepted: %v", p, codesOf(errs))
		}
	}

	// The bound, measured from BOTH sides at one. Every accept/reject list in
	// this file would still pass with the limit at 900 or at 4,096 — a pair
	// that straddles it by exactly one is what makes the NUMBER load-bearing
	// rather than the direction of the inequality.
	if w := patternWidth(t, `[0-9]{1,32}[0-9]{1,32}z`); w != MaxRepetitionWidth {
		t.Errorf("[0-9]{1,32}[0-9]{1,32}z should measure exactly %d wide, got %d", MaxRepetitionWidth, w)
	}
	if w := patternWidth(t, `[0-9]{1,25}[0-9]{1,41}z`); w != MaxRepetitionWidth+1 {
		t.Errorf("[0-9]{1,25}[0-9]{1,41}z should measure exactly %d wide, got %d", MaxRepetitionWidth+1, w)
	}

	// Alternation branches ADD and concatenation MULTIPLIES, which is the
	// difference between "the engine tries one branch at a time" and "the
	// engine tries every combination". Two branches of width 625 is 1,250 and
	// is refused; a pattern that took the max would report 625 and be accepted,
	// which is the mutation this pair exists to catch.
	if !hasCode(ValidatePattern(`x{0,24}x{0,24}|y{0,24}y{0,24}`, nil), ReasonRepetitionWidthTooLarge) {
		t.Error("two branches of width 625 must SUM to 1,250 and be refused; a scanner that took the " +
			"MAX across branches would report 625 and accept it")
	}
	if errs := ValidatePattern(`x{0,24}x{0,19}|y{0,24}y{0,19}`, nil); len(errs) != 0 {
		t.Errorf("two branches of width 500 sum to 1,000 and must be accepted: %v", codesOf(errs))
	}
}

// An UNBOUNDED interior makes its group variable, and that has to be VISIBLE.
//
// The verdict on these was never in doubt — unbounded_inside_quantified_group
// refuses every one of them on its own, and a mutation that stopped the length
// accumulator from saturating on `+` was measured against 9,072 generated
// patterns without flipping a single one from rejected to accepted. What it DID
// change was the code list, and the code list is the two-engine contract: Go
// and TypeScript must not merely agree that a pattern is bad, they must agree
// on why. Nothing pinned this combination, so the mutation survived the whole
// suite including the conformance fixture. This is what closes it.
func TestAnUnboundedInteriorAlsoMakesItsGroupVariable(t *testing.T) {
	for _, tc := range []struct {
		pat  string
		want []string
	}{
		{`(?:a+){2}`, []string{ReasonUnboundedInsideQuantifiedGroup, ReasonNestedVariableRepetition}},
		{`(?:[^\n]+x){2}`, []string{ReasonUnboundedInsideQuantifiedGroup, ReasonNestedVariableRepetition}},
		{`(?:a{2,}){4}`, []string{ReasonUnboundedInsideQuantifiedGroup, ReasonNestedVariableRepetition}},
		// ...and one repetition still multiplies nothing, even here.
		{`(?:a+)?`, []string{ReasonUnboundedInsideQuantifiedGroup}},
	} {
		got := codesOf(ValidatePattern(tc.pat, nil))
		if strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Errorf("%q: got %v, want %v", tc.pat, got, tc.want)
		}
	}
}

// patternWidth is the scanner's own width accumulator, read directly. The two
// cost rules report a yes/no, and a yes/no cannot distinguish "1,024" from
// "anything at all under the limit" — so the boundary tests read the number.
func patternWidth(t *testing.T, p string) int {
	t.Helper()
	v := &patternScanner{src: []rune(p)}
	v.scan()
	return v.stack[0].width
}

// TestTheShippingSeedsHaveHeadroomUnderTheWidthBound is the check the ReDoS fix
// could not be made without, kept so that the NEXT template is checked too.
//
// It reads seed/*.json off disk rather than taking a list: a hard-coded copy of
// the patterns would keep passing after someone adds a fifth seed, which is
// precisely the case where "would this bound refuse a real template?" needs an
// answer. Every pattern must be accepted, and the widest must stay well under
// the limit — a seed that landed at 1,020 would pass the accept check while
// leaving the next parser fix nowhere to go.
//
// A failure here is NOT a licence to raise MaxRepetitionWidth. It means a
// template the bank's mail actually needs is at the edge, which is a migration
// question (publish the collapsed rewrite, bump the template version) rather
// than a constant to edit.
func TestTheShippingSeedsHaveHeadroomUnderTheWidthBound(t *testing.T) {
	pats := seedPatterns(t)
	// A directory that yielded nothing would make every assertion below
	// vacuous, which is the failure mode this whole file exists to avoid.
	if len(pats) < 15 {
		t.Fatalf("found only %d patterns in seed/*.json; the walker is not reading the seeds", len(pats))
	}
	widest, widestPat := 0, ""
	for _, p := range pats {
		if errs := ValidatePattern(p, []string{"i"}); len(errs) != 0 {
			t.Errorf("SHIPPING SEED REFUSED: %q -> %v. This needs a migration, not a rule.", p, codesOf(errs))
		}
		if w := patternWidth(t, p); w > widest {
			widest, widestPat = w, p
		}
	}
	t.Logf("%d seed patterns; widest is %d (%q); the limit is %d", len(pats), widest, widestPat, MaxRepetitionWidth)
	// 200 is the ENBD credit anchor. Pinned exactly, because a change to the
	// width arithmetic that halved every measurement would leave every accept
	// and reject in this file green.
	if widest != 200 {
		t.Errorf("the widest shipping seed measures %d wide (%q); it was 200 when the bound was set. "+
			"Either a seed changed or the width arithmetic did — both need the bound re-argued",
			widest, widestPat)
	}
	if widest*4 > MaxRepetitionWidth {
		t.Errorf("the widest seed is %d and the limit is %d: less than 4x headroom is too little "+
			"for the next parser fix", widest, MaxRepetitionWidth)
	}
}

// seedPatterns walks seed/*.json and returns every regex in them. The seed
// package imports this one, so it cannot be imported back; the files are read
// as JSON instead, which is also what makes this a check on what SHIPS rather
// than on a Go literal that agrees with it.
func seedPatterns(t *testing.T) []string {
	t.Helper()
	names, err := filepath.Glob("seed/*.json")
	if err != nil || len(names) == 0 {
		t.Fatalf("seed/*.json: %v (matched %d)", err, len(names))
	}
	var out []string
	var walk func(any)
	walk = func(n any) {
		switch v := n.(type) {
		case []any:
			for _, e := range v {
				walk(e)
			}
		case map[string]any:
			for k, e := range v {
				if s, ok := e.(string); ok && k == "pattern" {
					out = append(out, s)
					continue
				}
				if arr, ok := e.([]any); ok && k == "patterns" {
					for _, p := range arr {
						if s, ok := p.(string); ok {
							out = append(out, s)
						}
					}
					continue
				}
				walk(e)
			}
		}
	}
	for _, n := range names {
		b, err := os.ReadFile(n)
		if err != nil {
			t.Fatal(err)
		}
		var doc any
		if err := json.Unmarshal(b, &doc); err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		walk(doc)
	}
	return out
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
