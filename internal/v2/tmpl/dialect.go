package tmpl

// dialect.go is the publish-time gate on template regular expressions.
//
// A published template is data: it is written by a human in an admin console,
// stored server-side, shipped to every device, and then run by TWO independent
// engines — Go's RE2 (internal/v2/tmpl) and JavaScript's RegExp (client/). The
// pattern text is stored once and both engines run that same text, so any
// construct the two engines read differently is a silent cross-executor
// disagreement: the server extracts an amount the client does not, or vice
// versa, and neither side reports an error.
//
// The dialect is the subset of RE2 on which the two engines were MEASURED to
// agree. Every ban below has a reason code, a row in the table in
// docs/superpowers/specs/v2-template-format.md naming the engine difference,
// and a pair of tests in dialect_test.go: one showing the construct is
// rejected, one showing the sanctioned rewrite is accepted. That pairing is
// deliberate — the first draft of this plan banned "a quantifier applied
// directly after `)`" with no accepted counterpart, which made the four v1
// optional-currency-prefix patterns inexpressible and its own acceptance test
// unsatisfiable.
//
// The second reason for the dialect is cost. The inbound path is
// attacker-writable: anyone who learns a user's inbound address can send mail
// whose body is chosen to maximise the cost of matching. Go's RE2 cannot
// backtrack, but JavaScript's engine can, and it runs on the user's phone. So
// the unbounded group quantifiers — `(X)*`, `(X)+`, `(X){n,}` — and any
// unbounded quantifier nested inside a quantified group are refused. `(X)?`
// and `(X){n,m}` are allowed: they are bounded, cannot backtrack
// catastrophically, and the corpus needs them.
//
// Those two rules stop the EXPONENTIAL shape. They do not stop the POLYNOMIAL
// one, and Task 19 measured what that costs before Task 20 closed it: two
// unbounded quantifiers in one branch is O(n^2) work, three is O(n^3), and
// `[0-9]+[0-9]+[0-9]+[0-9]+z` spent 88 SECONDS on a 400-character input in Bun
// 1.3.14 while Go's RE2 finished it in microseconds. Separating them with a
// mandatory literal does not help — `[^\n]+X[^\n]+Y` took 31.7 s on 8,000
// characters of "aX" — it only changes which input triggers it. Hence
// MaxUnboundedPerBranch: at most ONE unbounded quantifier along any one
// concatenation path, counted per alternation branch because that is the unit
// a backtracking engine explores. Every seed anchor in this corpus has exactly
// one, and two adjacent ones always collapse: `[0-9]+[0-9]+` is `[0-9]{2,}`.
//
// What this does NOT bound is the cost of the one quantifier it still allows,
// which is quadratic in a backtracking engine whenever the match fails:
// `[0-9]+z` on 200,000 digits took 17.9 s in Bun. Whether a real template is
// cheap is therefore a property of the TEMPLATE, not of the dialect, and there
// are two ways to have it — a mandatory literal prefix, so the engine's prefix
// scan discards almost every start position, or a bounded run, so each start
// position is cheap.
//
// That distinction is not theoretical. The DIB anchors have the first property
// (the merchant anchor against a hostile 1 MB body is 1.9 ms). The ENBD alert
// anchor as v1 wrote it had NEITHER: its first mandatory atom is `[0-9]`, so
// the engine tries every digit in the body, and its `[0-9,]*` backtracked the
// whole remaining run at each one — 333,859 ms on a 1 MB body, on the user's
// phone, from one message that RE2 finishes in microseconds. Task 20 found it
// only by timing the seeds in the client engine, and fixed it by bounding the
// run to `[0-9,]{0,24}`, which covers every amount an int64 can hold and
// produces byte-identical extractions across all 13,798 corpus rows.
//
// The dialect cannot express "must have a literal prefix" without making that
// ENBD anchor inexpressible, which is the defect the accept/reject table exists
// to prevent. So the bound is enforced where it can be measured:
// client/src/tmpl/cost.test.ts times every published template against hostile
// bodies, and TestKNOWNASingleUnboundedQuantifierIsStillQuadraticInJavaScript
// records why that file has to exist.
//
// The validator is a hand-written scanner over the pattern rather than a regex
// over a regex, because it must track character-class and escape state (so
// `[.]` and `\.` are not mistaken for a bare `.`) and group nesting with each
// group's quantifier (so "unbounded inside quantified" can be decided at all).
// After the structural checks pass, the pattern is additionally handed to
// regexp.Compile, so a shape the scanner does not model still cannot ship.

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Cost bounds. All three are counted in RUNES, not bytes, so the TypeScript
// mirror can reproduce them from [...p] with no knowledge of UTF-8. The Arabic
// anchors this corpus needs are 2 bytes per rune, which would otherwise make
// the Go and TypeScript length limits different limits.
const (
	// MaxPatternRunes bounds the pattern text itself.
	MaxPatternRunes = 512
	// MaxCaptureGroups bounds the submatch vector.
	MaxCaptureGroups = 8
	// MaxBoundProduct bounds the product of {n,m} upper bounds along any one
	// nesting path, and with it the maximum length a match can have.
	MaxBoundProduct = 64
	// MaxUnboundedPerBranch bounds how many unbounded quantifiers may appear in
	// one alternation branch. See the polynomial-backtracking note above.
	MaxUnboundedPerBranch = 1
)

// Reason codes. These are the contract with the TypeScript mirror (Task 20),
// which must reject the same pattern with the same code; they are compared
// mechanically through conformance/dialect/patterns.json. Treat them as a wire
// format: add codes, never rename them.
const (
	ReasonEmptyPattern                   = "empty_pattern"
	ReasonPatternTooLong                 = "pattern_too_long"
	ReasonTooManyCaptureGroups           = "too_many_capture_groups"
	ReasonEscapePerlSpace                = "escape_perl_space"
	ReasonEscapeWordBoundary             = "escape_word_boundary"
	ReasonEscapeUnicodeClass             = "escape_unicode_class"
	ReasonEscapeUnicodeCodepoint         = "escape_unicode_codepoint"
	ReasonEscapeTextAnchor               = "escape_text_anchor"
	ReasonEscapeBackreference            = "escape_backreference"
	ReasonEscapeNotAllowed               = "escape_not_allowed"
	ReasonMalformedEscape                = "malformed_escape"
	ReasonInlineFlags                    = "inline_flags"
	ReasonLookaround                     = "lookaround"
	ReasonNamedGroupJSSyntax             = "named_group_js_syntax"
	ReasonUnsupportedGroup               = "unsupported_group"
	ReasonInvalidGroupName               = "invalid_group_name"
	ReasonDuplicateGroupName             = "duplicate_group_name"
	ReasonUnbalancedParen                = "unbalanced_paren"
	ReasonBareDot                        = "bare_dot"
	ReasonGroupUnboundedQuantifier       = "group_unbounded_quantifier"
	ReasonUnboundedInsideQuantifiedGroup = "unbounded_inside_quantified_group"
	ReasonMultipleUnboundedQuantifiers   = "multiple_unbounded_quantifiers"
	ReasonBoundProductTooLarge           = "bound_product_too_large"
	ReasonMalformedRepetition            = "malformed_repetition"
	ReasonEmptyCharClass                 = "empty_character_class"
	ReasonUnterminatedCharClass          = "unterminated_character_class"
	ReasonClassLiteralBracket            = "class_literal_bracket"
	ReasonFlagNotAllowed                 = "flag_not_allowed"
	ReasonDuplicateFlag                  = "duplicate_flag"
	ReasonNotCompilable                  = "not_compilable"
)

// AllReasonCodes lists every code the validator can emit. dialect_test.go
// asserts that each one has a row in the dialect table carrying both a
// rejected construct and its accepted rewrite, so a ban can never be added
// without an expressible alternative.
func AllReasonCodes() []string {
	return []string{
		ReasonEmptyPattern, ReasonPatternTooLong, ReasonTooManyCaptureGroups,
		ReasonEscapePerlSpace, ReasonEscapeWordBoundary, ReasonEscapeUnicodeClass,
		ReasonEscapeUnicodeCodepoint, ReasonEscapeTextAnchor, ReasonEscapeBackreference,
		ReasonEscapeNotAllowed, ReasonMalformedEscape, ReasonInlineFlags, ReasonLookaround,
		ReasonNamedGroupJSSyntax, ReasonUnsupportedGroup, ReasonInvalidGroupName,
		ReasonDuplicateGroupName, ReasonUnbalancedParen, ReasonBareDot,
		ReasonGroupUnboundedQuantifier, ReasonUnboundedInsideQuantifiedGroup,
		ReasonMultipleUnboundedQuantifiers, ReasonBoundProductTooLarge, ReasonMalformedRepetition, ReasonEmptyCharClass,
		ReasonUnterminatedCharClass, ReasonClassLiteralBracket, ReasonFlagNotAllowed,
		ReasonDuplicateFlag, ReasonNotCompilable,
	}
}

// PatternError is one dialect violation. Offset is a RUNE index into the
// pattern (see the note on the cost bounds above).
type PatternError struct {
	Code    string
	Offset  int
	Message string
}

func (e *PatternError) Error() string {
	return fmt.Sprintf("%s at %d: %s", e.Code, e.Offset, e.Message)
}

// Codes reduces a validator result to its reason codes. This is the form the
// TypeScript mirror compares against.
func Codes(errs []error) []string {
	out := make([]string, 0, len(errs))
	for _, err := range errs {
		var pe *PatternError
		if errors.As(err, &pe) {
			out = append(out, pe.Code)
			continue
		}
		out = append(out, err.Error())
	}
	return out
}

// escapeWhitelist is every single-character escape MEASURED to mean the same
// thing in Go's RE2 and in JavaScript compiled with the u flag. A whitelist,
// not a blacklist: the banned list in the spec names the escapes that are
// known-divergent, but an escape nobody thought about (\a is BEL in Go and a
// SyntaxError in JS) must fail closed rather than fall through.
const escapeWhitelist = `nrtfv` + `dDwW` + `\.+*?()[]{}|^$/`

// escapeClassOnly is allowed inside a character class and nowhere else. Under
// the u flag JavaScript's IdentityEscape outside a class is restricted to the
// SyntaxCharacters and "/", so `\-` at top level is a SyntaxError there while
// Go accepts it.
const escapeClassOnly = `-`

var groupNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ValidatePattern reports every way p (compiled with flags) violates the
// dialect. An empty result means the pattern is safe to publish: both engines
// were measured to agree on every construct it contains, and its match cost is
// bounded.
func ValidatePattern(p string, flags []string) []error {
	v := &patternScanner{src: []rune(p)}
	v.checkFlags(flags)
	v.scan()
	if len(v.errs) == 0 {
		// The scanner models the dialect, not the whole grammar. Go's own
		// parser is the backstop for everything it does not model, such as a
		// reversed character-class range.
		if _, err := CompileGo(p, flags); err != nil {
			v.add(0, ReasonNotCompilable, "does not compile in Go RE2: "+err.Error())
		}
	}
	return v.errs
}

// CompileGo compiles a stored pattern for the Go executor, applying the
// declared flags.
//
// Stored patterns carry no inline flags — the dialect bans them because
// JavaScript has none — so "i" is applied here, as the (?i) prefix that is
// Go's only spelling of it. The JavaScript side is the mirror of this
// function: new RegExp(ToJS(p), flags.join("") + "u"). The trailing "u" there
// is not optional and is the whole reason the two engines fold case the same
// way; see docs/superpowers/specs/v2-template-format.md.
//
// Both executors go through their own one of these, so "how a flag is applied"
// has exactly one implementation per language rather than one per call site.
func CompileGo(p string, flags []string) (*regexp.Regexp, error) {
	prefix := ""
	for _, f := range flags {
		if f == "i" {
			prefix = "(?i)"
		}
	}
	return regexp.Compile(prefix + p)
}

// ToJS rewrites a stored pattern into the text JavaScript must compile:
// (?P<name>...) becomes (?<name>...). Nothing else changes, which is the
// point — the published text is what both engines run.
//
// It is a scanner rather than a string replace because `\(` followed by `?P<`
// is an escaped parenthesis, an optional quantifier and three literal
// characters; a ReplaceAll would turn that into a named group and silently
// change what JavaScript matches.
func ToJS(p string) string {
	r := []rune(p)
	var b strings.Builder
	b.Grow(len(p))
	inClass := false
	for i := 0; i < len(r); i++ {
		c := r[i]
		if c == '\\' {
			b.WriteRune(c)
			if i+1 < len(r) {
				i++
				b.WriteRune(r[i])
			}
			continue
		}
		if inClass {
			if c == ']' {
				inClass = false
			}
			b.WriteRune(c)
			continue
		}
		switch {
		case c == '[':
			inClass = true
			b.WriteRune(c)
		case c == '(' && i+3 < len(r) && r[i+1] == '?' && r[i+2] == 'P' && r[i+3] == '<':
			b.WriteString("(?<")
			i += 3
		default:
			b.WriteRune(c)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// the scanner
// ---------------------------------------------------------------------------

// frame is one group's accumulated state. hasUnbounded, best and the unbounded
// count all propagate to the parent when the group closes, which is what lets
// the three nesting rules be decided in a single left-to-right pass.
type frame struct {
	// hasUnbounded records that a *, + or {n,} appears somewhere inside this
	// group at any depth. Quantifying such a group is the (a+)+ shape.
	hasUnbounded bool
	// best is the largest product of {n,m} upper bounds along any path inside
	// this group. A group's own quantifier multiplies it on the way out.
	best int
	// branchUnbounded counts the unbounded quantifiers in the alternation
	// branch currently being scanned, including those contributed by nested
	// groups that have already closed.
	branchUnbounded int
	// maxUnbounded is the largest branchUnbounded of any branch that has
	// already ended at a '|'. worstBranch combines the two.
	maxUnbounded int
}

// worstBranch is the number of unbounded quantifiers in this group's most
// expensive alternation branch, including the branch still being scanned.
// Branches are independent — a backtracking engine explores one at a time — so
// `a+|b+` costs what `a+` costs and counts as one, not two.
func (f *frame) worstBranch() int {
	if f.branchUnbounded > f.maxUnbounded {
		return f.branchUnbounded
	}
	return f.maxUnbounded
}

// endBranch closes the branch at a '|'.
func (f *frame) endBranch() {
	f.maxUnbounded = f.worstBranch()
	f.branchUnbounded = 0
}

type patternScanner struct {
	src      []rune
	errs     []error
	stack    []*frame
	captures int
	names    map[string]bool
	// each of these is reported at most once, so a 500-rune pattern with a
	// systematic mistake yields a readable result rather than a wall.
	reported map[string]bool
}

func (v *patternScanner) add(offset int, code, msg string) {
	if v.reported == nil {
		v.reported = map[string]bool{}
	}
	key := code + "@" + strconv.Itoa(offset)
	if v.reported[key] {
		return
	}
	v.reported[key] = true
	v.errs = append(v.errs, &PatternError{Code: code, Offset: offset, Message: msg})
}

// addOnce reports a code at most once per pattern regardless of offset, for
// the bounds that describe the whole pattern rather than a position in it.
func (v *patternScanner) addOnce(offset int, code, msg string) {
	if v.reported == nil {
		v.reported = map[string]bool{}
	}
	if v.reported["once:"+code] {
		return
	}
	v.reported["once:"+code] = true
	v.errs = append(v.errs, &PatternError{Code: code, Offset: offset, Message: msg})
}

func (v *patternScanner) checkFlags(flags []string) {
	seen := map[string]bool{}
	for i, f := range flags {
		switch {
		case f != "i":
			v.add(i, ReasonFlagNotAllowed, fmt.Sprintf("flag %q is not permitted; only \"i\" is", f))
		case seen[f]:
			v.add(i, ReasonDuplicateFlag, fmt.Sprintf("flag %q is listed more than once", f))
		}
		seen[f] = true
	}
}

func (v *patternScanner) top() *frame { return v.stack[len(v.stack)-1] }

func (v *patternScanner) scan() {
	if len(v.src) == 0 {
		v.add(0, ReasonEmptyPattern, "a pattern must not be empty")
		return
	}
	if len(v.src) > MaxPatternRunes {
		v.add(MaxPatternRunes, ReasonPatternTooLong,
			fmt.Sprintf("pattern is %d runes; the limit is %d", len(v.src), MaxPatternRunes))
		return
	}

	v.stack = []*frame{{best: 1}}
	i := 0
	for i < len(v.src) {
		switch c := v.src[i]; {
		case c == '\\':
			i = v.quantify(v.escape(i, false), atomSimple, nil)
		case c == '[':
			i = v.quantify(v.charClass(i), atomSimple, nil)
		case c == '(':
			i = v.openGroup(i)
		case c == ')':
			if len(v.stack) == 1 {
				v.add(i, ReasonUnbalancedParen, "')' with no matching '('")
				i++
				continue
			}
			child := v.stack[len(v.stack)-1]
			v.stack = v.stack[:len(v.stack)-1]
			i = v.quantify(i+1, atomGroup, child)
		case c == '.':
			v.add(i, ReasonBareDot, `a bare '.' matches \r, U+2028 and U+2029 in Go but not in JavaScript; write [^\n]`)
			i = v.quantify(i+1, atomSimple, nil)
		case c == '*' || c == '+' || c == '?':
			// Quantifiers are always consumed together with the atom they
			// apply to, so reaching one here means it applies to nothing (or
			// to another quantifier, i.e. a possessive form).
			v.add(i, ReasonMalformedRepetition, fmt.Sprintf("'%c' has no atom to repeat", c))
			i++
		case c == '{':
			v.add(i, ReasonMalformedRepetition, `a literal '{' must be written \{`)
			i++
		case c == '|':
			v.top().endBranch()
			i++
		case c == '^' || c == '$':
			i++
		default:
			i = v.quantify(i+1, atomSimple, nil)
		}
	}

	if len(v.stack) > 1 {
		v.add(len(v.src), ReasonUnbalancedParen,
			fmt.Sprintf("%d group(s) left open", len(v.stack)-1))
	}
	if v.stack[0].best > MaxBoundProduct {
		v.addOnce(0, ReasonBoundProductTooLarge,
			fmt.Sprintf("the product of {n,m} upper bounds along one nesting path is %d; the limit is %d",
				v.stack[0].best, MaxBoundProduct))
	}
}

type atomKind int

const (
	atomSimple atomKind = iota
	atomGroup
)

// quantify reads the quantifier (if any) at index next, applies the two
// nesting rules, folds the atom's cost into the enclosing frame, and returns
// the index just past the quantifier.
func (v *patternScanner) quantify(next int, kind atomKind, child *frame) int {
	q, after := v.readQuant(next)
	cur := v.top()

	childBest, childUnbounded := 1, false
	if child != nil {
		childBest, childUnbounded = child.best, child.hasUnbounded
	}

	if q.present && kind == atomGroup {
		if q.unbounded {
			v.add(next, ReasonGroupUnboundedQuantifier,
				"an unbounded quantifier on a group is the catastrophic-backtracking shape; "+
					"'?' and '{n,m}' are bounded and are allowed")
		} else if childUnbounded {
			v.add(next, ReasonUnboundedInsideQuantifiedGroup,
				"this group is quantified and contains an unbounded quantifier; "+
					"that is the (a+)+ nesting — bound the inner quantifier with {n,m}")
		}
	}

	if q.present && q.unbounded {
		cur.hasUnbounded = true
	}
	if childUnbounded {
		cur.hasUnbounded = true
	}

	// The polynomial-backtracking bound. The atom contributes its own unbounded
	// quantifier plus, for a group, that group's most expensive branch — so
	// `(a+|b+)c+` counts two and `(a+|b+)c` counts one.
	added := 0
	if q.present && q.unbounded {
		added++
	}
	if child != nil {
		added += child.worstBranch()
	}
	if added > 0 {
		cur.branchUnbounded += added
		if cur.branchUnbounded > MaxUnboundedPerBranch {
			v.addOnce(next, ReasonMultipleUnboundedQuantifiers,
				fmt.Sprintf("more than %d unbounded quantifier in one alternation branch: that is the "+
					"POLYNOMIAL backtracking shape (n^k for k of them), which RE2 is immune to and "+
					"JavaScript is not. Collapse them — [0-9]+[0-9]+ is [0-9]{2,} — or bound all but one with {n,m}",
					MaxUnboundedPerBranch))
		}
	}

	prod := childBest
	if q.present && !q.unbounded {
		prod = mulCapped(childBest, q.max)
	}
	if prod > cur.best {
		cur.best = prod
	}
	return after
}

// mulCapped keeps the running product from overflowing on a pattern that is
// rejected anyway (a{99999} nested ten deep).
func mulCapped(a, b int) int {
	if a > MaxBoundProduct || b > MaxBoundProduct {
		return MaxBoundProduct + 1
	}
	p := a * b
	if p > MaxBoundProduct {
		return MaxBoundProduct + 1
	}
	return p
}

type quant struct {
	present   bool
	unbounded bool
	max       int
}

// readQuant reads a quantifier at i, including its optional non-greedy '?'
// suffix, and returns the index just past it.
func (v *patternScanner) readQuant(i int) (quant, int) {
	if i >= len(v.src) {
		return quant{}, i
	}
	switch v.src[i] {
	case '*', '+':
		return quant{present: true, unbounded: true}, v.skipLazy(i + 1)
	case '?':
		return quant{present: true, max: 1}, v.skipLazy(i + 1)
	case '{':
		return v.readBraceQuant(i)
	}
	return quant{}, i
}

func (v *patternScanner) skipLazy(i int) int {
	if i < len(v.src) && v.src[i] == '?' {
		return i + 1
	}
	return i
}

// readBraceQuant parses {n}, {n,} and {n,m}. Anything else is rejected: Go
// reads a{,3} as five literal characters while JavaScript under the u flag
// makes it a SyntaxError, so the two engines do not agree on what it is.
func (v *patternScanner) readBraceQuant(i int) (quant, int) {
	j := i + 1
	start := j
	for j < len(v.src) && v.src[j] >= '0' && v.src[j] <= '9' {
		j++
	}
	if j == start {
		v.add(i, ReasonMalformedRepetition, `'{' must open a repetition {n}, {n,} or {n,m}; a literal '{' is written \{`)
		return quant{}, i + 1
	}
	lo, err := strconv.Atoi(string(v.src[start:j]))
	if err != nil {
		v.add(i, ReasonMalformedRepetition, "repetition count is not a number")
		return quant{}, i + 1
	}
	if j < len(v.src) && v.src[j] == '}' {
		return quant{present: true, max: lo}, v.skipLazy(j + 1)
	}
	if j >= len(v.src) || v.src[j] != ',' {
		v.add(i, ReasonMalformedRepetition, "unterminated repetition")
		return quant{}, i + 1
	}
	j++ // past ','
	hiStart := j
	for j < len(v.src) && v.src[j] >= '0' && v.src[j] <= '9' {
		j++
	}
	if j >= len(v.src) || v.src[j] != '}' {
		v.add(i, ReasonMalformedRepetition, "unterminated repetition")
		return quant{}, i + 1
	}
	if hiStart == j { // {n,}
		return quant{present: true, unbounded: true}, v.skipLazy(j + 1)
	}
	hi, err := strconv.Atoi(string(v.src[hiStart:j]))
	if err != nil {
		v.add(i, ReasonMalformedRepetition, "repetition count is not a number")
		return quant{}, i + 1
	}
	if hi < lo {
		v.add(i, ReasonMalformedRepetition, fmt.Sprintf("repetition {%d,%d} counts down", lo, hi))
		return quant{}, v.skipLazy(j + 1)
	}
	return quant{present: true, max: hi}, v.skipLazy(j + 1)
}

// escape validates the escape sequence starting at i (which points at the
// backslash) and returns the index just past it.
func (v *patternScanner) escape(i int, inClass bool) int {
	if i+1 >= len(v.src) {
		v.add(i, ReasonMalformedEscape, "pattern ends with a backslash")
		return i + 1
	}
	c := v.src[i+1]
	switch {
	case c == 's' || c == 'S':
		v.add(i, ReasonEscapePerlSpace,
			`\s is [\t\n\f\r ] in Go; in JavaScript it also matches \v, U+00A0, U+FEFF and the Unicode space separators. `+
				`On normalized text write the exact set, e.g. [ \n]`)
	case c == 'b' || c == 'B':
		v.add(i, ReasonEscapeWordBoundary,
			`word boundaries diverge once the i flag is set (JavaScript's word set gains U+017F and U+212A, Go's does not) `+
				`and are meaningless around Arabic, which this corpus is`)
	case c == 'p' || c == 'P':
		v.add(i, ReasonEscapeUnicodeClass,
			`Go spells it \p{Arabic} and JavaScript spells it \p{Script=Arabic}; neither engine accepts the other's form`)
	case c == 'u':
		v.add(i, ReasonEscapeUnicodeCodepoint, `\u{...} does not compile in Go; write the character itself or \xHH`)
	case c == 'x':
		return v.hexEscape(i)
	case c == 'A' || c == 'z' || c == 'Z':
		v.add(i, ReasonEscapeTextAnchor, `\A, \z and \Z compile in Go and are a SyntaxError in JavaScript; use ^ and $`)
	case c >= '0' && c <= '9':
		v.add(i, ReasonEscapeBackreference,
			"backreferences and octal escapes: RE2 has neither, and a backreference has unbounded cost in JavaScript")
	case c == 'k':
		v.add(i, ReasonEscapeBackreference, `\k is a named backreference in JavaScript and not supported in RE2`)
	case strings.ContainsRune(escapeWhitelist, c):
		// measured identical in both engines
	case inClass && strings.ContainsRune(escapeClassOnly, c):
		// `\-` is a valid ClassEscape in JavaScript and only inside a class
	default:
		v.add(i, ReasonEscapeNotAllowed,
			fmt.Sprintf(`\%c is not in the dialect's escape whitelist; the two engines were not measured to agree on it`, c))
	}
	return i + 2
}

// hexEscape allows \xHH, which both engines read as one code point, and
// rejects \x{...}, which is a SyntaxError in JavaScript under the u flag.
func (v *patternScanner) hexEscape(i int) int {
	if i+2 < len(v.src) && v.src[i+2] == '{' {
		v.add(i, ReasonEscapeUnicodeCodepoint, `\x{...} is a SyntaxError in JavaScript under the u flag; write \xHH or the character itself`)
		for j := i + 2; j < len(v.src); j++ {
			if v.src[j] == '}' {
				return j + 1
			}
		}
		return len(v.src)
	}
	if i+3 >= len(v.src) || !isHex(v.src[i+2]) || !isHex(v.src[i+3]) {
		v.add(i, ReasonMalformedEscape, `\x must be followed by exactly two hexadecimal digits`)
		return i + 2
	}
	return i + 4
}

func isHex(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

// charClass validates the character class starting at i (which points at '[')
// and returns the index just past the closing ']'.
func (v *patternScanner) charClass(i int) int {
	j := i + 1
	if j < len(v.src) && v.src[j] == '^' {
		j++
	}
	if j < len(v.src) && v.src[j] == ']' {
		// Go rejects `[]` outright; JavaScript under u reads it as a class
		// that never matches. Neither is what an author meant.
		v.add(i, ReasonEmptyCharClass, `an empty character class; a literal ']' is written \]`)
		return j + 1
	}
	for j < len(v.src) {
		switch v.src[j] {
		case '\\':
			j = v.escape(j, true)
		case '[':
			v.add(j, ReasonClassLiteralBracket,
				`a '[' inside a character class must be written \[: Go reads [[:alpha:]] as a POSIX class `+
					`and JavaScript under the u flag makes it a SyntaxError`)
			j++
		case ']':
			return j + 1
		default:
			j++
		}
	}
	v.add(i, ReasonUnterminatedCharClass, "character class is never closed")
	return len(v.src)
}

// openGroup validates a group opener at i (which points at '('), pushes its
// frame, and returns the index just past the opener.
func (v *patternScanner) openGroup(i int) int {
	push := func(next int) int {
		v.stack = append(v.stack, &frame{best: 1})
		return next
	}
	capture := func() {
		v.captures++
		if v.captures > MaxCaptureGroups {
			v.addOnce(i, ReasonTooManyCaptureGroups,
				fmt.Sprintf("more than %d capture groups", MaxCaptureGroups))
		}
	}

	if i+1 >= len(v.src) || v.src[i+1] != '?' {
		capture()
		return push(i + 1)
	}
	if i+2 >= len(v.src) {
		v.add(i, ReasonUnsupportedGroup, "'(?' is not a group")
		return push(i + 2)
	}

	switch v.src[i+2] {
	case ':':
		return push(i + 3)
	case '=', '!':
		v.add(i, ReasonLookaround, "lookahead is a backtracking construct and RE2 has no equivalent")
		return push(i + 3)
	case '<':
		if i+3 < len(v.src) && (v.src[i+3] == '=' || v.src[i+3] == '!') {
			v.add(i, ReasonLookaround, "lookbehind is a backtracking construct and RE2 has no equivalent")
			return push(i + 4)
		}
		v.add(i, ReasonNamedGroupJSSyntax,
			"a named group is stored as (?P<name>...) and rewritten to (?<name>...) for JavaScript by ToJS; "+
				"storing the JavaScript spelling would not compile in Go RE2 before Go 1.22 and defeats the single-stored-text rule")
		return push(i + 3)
	case 'P':
		if i+3 < len(v.src) && v.src[i+3] == '<' {
			capture()
			return push(v.groupName(i + 4))
		}
		v.add(i, ReasonUnsupportedGroup, "(?P= and (?P> are not part of the dialect")
		return push(i + 3)
	case '#':
		v.add(i, ReasonUnsupportedGroup, "(?# comments are not part of the dialect")
		return push(i + 3)
	default:
		v.add(i, ReasonInlineFlags,
			"JavaScript has no inline flag groups; declare flags on the Extract entry instead")
		return push(i + 3)
	}
}

// groupName validates the name starting at i (just past "(?P<") and returns
// the index just past the '>'.
func (v *patternScanner) groupName(i int) int {
	j := i
	for j < len(v.src) && v.src[j] != '>' {
		j++
	}
	if j >= len(v.src) {
		v.add(i, ReasonInvalidGroupName, "group name is never closed with '>'")
		return len(v.src)
	}
	name := string(v.src[i:j])
	if !groupNameRe.MatchString(name) {
		v.add(i, ReasonInvalidGroupName,
			fmt.Sprintf("group name %q must match [A-Za-z_][A-Za-z0-9_]*: Go accepts names JavaScript rejects "+
				"(a leading digit) and JavaScript accepts names Go rejects (a '$')", name))
	}
	if v.names == nil {
		v.names = map[string]bool{}
	}
	if v.names[name] {
		v.add(i, ReasonDuplicateGroupName,
			fmt.Sprintf("group name %q is used twice; Go allows this and JavaScript rejects it", name))
	}
	v.names[name] = true
	return j + 1
}

// GroupNames returns the named capture groups of a pattern, in order of
// appearance. It assumes the pattern already passed ValidatePattern.
func GroupNames(p string) []string {
	re, err := regexp.Compile(p)
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range re.SubexpNames() {
		if n != "" {
			out = append(out, n)
		}
	}
	return out
}
