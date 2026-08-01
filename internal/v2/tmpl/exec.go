package tmpl

// exec.go is the Go template executor: it runs a published [Definition] over
// one normalized message and produces an [Extraction].
//
// # What it is running on
//
// The body is ATTACKER-WRITABLE. Anyone who learns a user's inbound address can
// send mail whose text is chosen to maximise the cost of matching, so the
// executor must not be able to hang, allocate unboundedly, or panic. Three
// things hold that line, and each is a separate defence:
//
//  1. Go's RE2 does not backtrack, so match cost is linear in the input for
//     every pattern the dialect permits — including the shapes that are
//     polynomial in JavaScript (see the KNOWN test in exec_test.go).
//  2. [MaxBodyBytes] and [MaxSubjectBytes] bound the input, because "linear"
//     still means "proportional", and the executor is called once per template.
//     Over the bound the message is REFUSED, never truncated: a truncated body
//     is a different message from the one that arrived.
//  3. [MaxCaptureRunes] bounds what a single group may hand back, so a
//     `[^\n]+` merchant anchor pointed at a 400 KB line yields a conversion
//     failure rather than a 400 KB merchant in the transaction store.
//
// # The one gate this file cannot apply
//
// Match.SenderDomain is checked by [MatchesSenderDomain], NOT by [Execute],
// which is not given a domain — the verified signing domain comes from the
// DKIM/ARC verifier, and passing it through the executor would invite a caller
// to hand it the body's own From line, which is content anyone can author. The
// store's [Store.ForSenderDomain] applies it. A caller that assembles its own
// template list must apply it too.
//
// # Two executors, one behaviour
//
// A TypeScript executor (Task 20) runs the same stored template on the user's
// device and must reach the same answer. Every place where Go and JavaScript
// would otherwise differ by default is pinned explicitly here — the trim set,
// the digit set, ASCII-only case folding, rune counting rather than byte
// counting — rather than left to each language's library. Where Go's time
// package has behaviour a hand-written parser would not reproduce by accident
// (case-insensitive month names, two-digit fields, range checks), it is stated
// in [parseLayout] and pinned by a test whose name says so.

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Executor bounds. All of them are part of the cross-executor contract: a
// TypeScript mirror that picks different numbers extracts different values from
// the same message.
const (
	// MaxBodyBytes bounds the normalized text. blob.MaxColdMail caps a raw
	// message at 1,000,000 bytes, and normalization can inflate that — a
	// base64'd UTF-16 part becomes longer UTF-8 — so the bound is 2x the raw
	// cap rather than equal to it. TestExecuteBoundsExceedTheLargestStorableMail
	// pins the relationship instead of leaving it as arithmetic in a comment.
	MaxBodyBytes = 2_000_000
	// MaxSubjectBytes bounds the effective subject. RFC 5322 already limits a
	// header line; this bounds the DECODED value, which encoded words can
	// inflate.
	MaxSubjectBytes = 64_000
	// MaxCaptureRunes bounds one captured group. RUNES, not bytes, so the
	// TypeScript mirror reproduces it with [...s].length and never has to know
	// anything about UTF-8. Anything longer is a conversion failure (rule 3):
	// the entry falls through, and a field nothing produced stays unset.
	MaxCaptureRunes = 512
	// MaxEmptyGroups matches diag's own cap. Emitting more would make the
	// diagnostics row unstorable, which loses the WHOLE diagnostic rather than
	// the surplus names.
	MaxEmptyGroups = 32
)

// The four reasons an execution produces no transaction. They are separate
// sentinels because the pipeline treats them differently: ErrNoMatch is
// routine (this mail is not for this template), ErrMissingField is the DRIFT
// SIGNAL (this template should have handled it and could not), and the other
// two are faults that a published template must never reach.
var (
	// ErrNoMatch means the Match block excluded the message.
	ErrNoMatch = errors.New("tmpl: the message does not match this template")
	// ErrMissingField means the gates passed but a required field was not
	// produced. This is what a bank changing its mail format looks like.
	ErrMissingField = errors.New("tmpl: a required field was not produced")
	// ErrDefinition means the definition cannot be executed at all. The publish
	// gate rejects these, so one here means a template reached the executor
	// without going through [ValidateForPublish].
	ErrDefinition = errors.New("tmpl: the definition cannot be executed")
	// ErrTooLarge means the input exceeded an executor bound.
	ErrTooLarge = errors.New("tmpl: input exceeds the executor size bound")
)

// Extraction is what one template read out of one message.
//
// Presence is derived from the values, never from a separate mask, because the
// TypeScript mirror has to reproduce it and a mask is one more thing to get
// wrong. See [Produced] for the exact predicates — in particular Currency, not
// AmountMinor, is what says an amount was extracted, because a genuine 0.00 is
// a value and a zero int is not distinguishable from "nothing ran".
type Extraction struct {
	AmountMinor int64
	Currency    string
	Direction   string
	// PostedAt is the zero time when the definition's date_from is "email";
	// the caller supplies norm.Result.EmailDate in that case. It is ALSO the
	// zero time when a body date was expected and no entry produced one — that
	// is a failure, and Required is what turns it into one. A zero time is
	// never presented as an extracted date.
	PostedAt   time.Time
	Merchant   string
	Last4      string
	IsTransfer bool
	// EmptyGroups names the capture groups that matched but captured nothing,
	// as "<field>_<group>", sorted and deduplicated.
	//
	// The plan says "named capture groups"; the privacy disclosure (spec §2)
	// says "the names of the template fields that failed to extract". Bare
	// group names cannot serve the second, because the format gives every text
	// and last4 pattern the group name "v" — an operator reading ["v"] cannot
	// tell whether the merchant or the card number went missing, which is
	// precisely the question the diagnostic exists to answer. Qualifying the
	// group with its field satisfies both readings and adds no content: both
	// halves are template-authored identifiers, and the result still matches
	// diag's group-name grammar.
	EmptyGroups []string
	// Matched is true if and only if Execute returned a nil error.
	Matched bool
}

// Produced reports whether the named field was extracted.
//
// The predicates, and why each is the honest one:
//
//	amount       Currency != ""     — set together with the amount, always
//	date         !PostedAt.IsZero() — 0001-01-01 is not a bank date
//	merchant     Merchant != ""     — an empty capture is not a merchant
//	last4        Last4 != ""
//	direction    Direction != ""
//	is_transfer  ALWAYS FALSE       — see below
//
// is_transfer cannot be honestly reported: a flag that is false looks exactly
// like a flag that was never set, so a template requiring it could never be
// satisfied. Returning false here makes that fail closed, and
// [ValidateExecutable] refuses to publish such a template in the first place.
func (e Extraction) Produced(field string) bool {
	switch field {
	case FieldAmount:
		return e.Currency != ""
	case FieldDate:
		return !e.PostedAt.IsZero()
	case FieldMerchant:
		return e.Merchant != ""
	case FieldLast4:
		return e.Last4 != ""
	case FieldDirection:
		return e.Direction != ""
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

// Compiled is a definition with its patterns compiled once. It is immutable
// after construction and safe for concurrent use, which is what lets the ingest
// pipeline compile the published set once and run it against every message.
type Compiled struct {
	def     Definition
	entries []compiledEntry
}

type compiledEntry struct {
	x   Extract
	res []*regexp.Regexp
}

// Definition returns the definition this was compiled from.
func (c *Compiled) Definition() Definition { return c.def }

// Compile checks everything EXECUTION depends on and compiles every pattern.
//
// It deliberately does not re-run [ValidateDefinition]: that is publish-time
// policy, it is the expensive half (the dialect scanner compiles every pattern
// a second time), and a template that is already stored has passed it. What
// Compile enforces is narrower and non-negotiable — the executor must be able
// to reach a value for every entry it is given, or the template would publish
// and then silently extract nothing.
func Compile(d Definition) (*Compiled, error) {
	if !currencyRe.MatchString(d.DefaultCurrency) {
		return nil, fmt.Errorf("%w: default_currency %q is not three upper-case letters, so no amount could carry a currency",
			ErrDefinition, d.DefaultCurrency)
	}
	if d.DateFrom != DateFromBody && d.DateFrom != DateFromEmail {
		return nil, fmt.Errorf("%w: date_from %q is neither %q nor %q", ErrDefinition, d.DateFrom, DateFromBody, DateFromEmail)
	}
	for _, f := range d.Required {
		if _, ok := fieldTypes[f]; !ok {
			return nil, fmt.Errorf("%w: required names %q, which is not a field", ErrDefinition, f)
		}
		if f == FieldIsTransfer {
			return nil, fmt.Errorf("%w: is_transfer cannot be required — a flag that is false is "+
				"indistinguishable from one that was never set, so the requirement could never be enforced", ErrDefinition)
		}
	}

	c := &Compiled{def: d, entries: make([]compiledEntry, 0, len(d.Extract))}
	dates := 0
	for i, x := range d.Extract {
		ce, err := compileEntry(i, x)
		if err != nil {
			return nil, err
		}
		if x.Field == FieldDate {
			dates++
		}
		c.entries = append(c.entries, ce)
	}
	// date_from is a promise about where the date comes from, and both ways of
	// breaking it are silent: a "body" template with no date entry can never
	// produce one, and an "email" template with a date entry produces a body
	// date the caller has been told to overwrite with the email date.
	switch {
	case d.DateFrom == DateFromBody && dates == 0:
		return nil, fmt.Errorf("%w: date_from is %q but no extract entry produces a date", ErrDefinition, DateFromBody)
	case d.DateFrom == DateFromEmail && dates > 0:
		return nil, fmt.Errorf("%w: date_from is %q but %d extract entries produce a date", ErrDefinition, DateFromEmail, dates)
	}
	return c, nil
}

func compileEntry(i int, x Extract) (compiledEntry, error) {
	fail := func(format string, args ...any) (compiledEntry, error) {
		return compiledEntry{}, fmt.Errorf("%w: extract[%d]: "+format, append([]any{ErrDefinition, i}, args...)...)
	}
	types, ok := fieldTypes[x.Field]
	if !ok {
		return fail("field %q is not a field name", x.Field)
	}
	spec, ok := groupNamesByType[x.Type]
	if !ok {
		return fail("type %q is not a type", x.Type)
	}
	if !containsString(types, x.Type) {
		return fail("field %q cannot be extracted as type %q", x.Field, x.Type)
	}
	if x.Source != SourceBody && x.Source != SourceSubject {
		return fail("source %q is neither %q nor %q", x.Source, SourceBody, SourceSubject)
	}

	isConst := x.Type == TypeConst || x.Type == TypeFlag
	if isConst {
		if err := checkLiteral(x.Field, x.Value); err != nil {
			return fail("%s", err)
		}
	} else if len(x.Patterns) == 0 {
		return fail("a %s entry with no patterns can never produce a value", x.Type)
	}
	for f, v := range x.OnMatch {
		if err := checkLiteral(f, v); err != nil {
			return fail("on_match: %s", err)
		}
	}
	if x.Type == TypeDate {
		if len(x.Layouts) == 0 {
			return fail("a date entry with no layouts can never convert its capture")
		}
		for _, l := range x.Layouts {
			if _, ok := goDateLayouts[l]; !ok {
				return fail("layout %q is not one of the three supported layouts", l)
			}
		}
	}

	ce := compiledEntry{x: x, res: make([]*regexp.Regexp, 0, len(x.Patterns))}
	for j, p := range x.Patterns {
		re, err := CompileGo(p, x.Flags)
		if err != nil {
			return fail("patterns[%d] does not compile: %v", j, err)
		}
		names := re.SubexpNames()
		for _, want := range spec.required {
			if !containsString(names, want) {
				return fail("patterns[%d] does not capture (?P<%s>...), so a %s entry could never read a value from it",
					j, want, x.Type)
			}
		}
		// Every named group becomes a potential diagnostics label, and diag
		// refuses a label that is not a bounded identifier — refusing it there
		// would drop the whole row, so it is refused here instead.
		for _, n := range names {
			if n == "" {
				continue
			}
			if !reEmptyGroupLabel.MatchString(emptyGroupLabel(x.Field, n)) {
				return fail("patterns[%d] group %q would produce the diagnostics label %q, which is not a bounded identifier",
					j, n, emptyGroupLabel(x.Field, n))
			}
		}
		ce.res = append(ce.res, re)
	}
	return ce, nil
}

// checkLiteral validates a value that is written into a field verbatim — a
// const/flag entry's Value, or an on_match entry. amount and date are absent
// on purpose: neither has an unambiguous literal spelling that both executors
// would parse identically, so they may only come from a typed conversion.
func checkLiteral(field, value string) error {
	switch field {
	case FieldDirection:
		if value != "debit" && value != "credit" {
			return fmt.Errorf("direction %q is neither debit nor credit", value)
		}
	case FieldIsTransfer:
		if value != "true" && value != "false" {
			return fmt.Errorf("is_transfer %q is neither true nor false", value)
		}
	case FieldMerchant, FieldLast4:
		if value == "" {
			return fmt.Errorf("%s cannot be set to the empty string: an unset field and a field set to \"\" are the same thing to every reader", field)
		}
		if utf8.RuneCountInString(value) > MaxCaptureRunes {
			return fmt.Errorf("%s literal is longer than %d runes", field, MaxCaptureRunes)
		}
	default:
		return fmt.Errorf("%s cannot be set from a literal value", field)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

// Execute compiles d and runs it. It is the convenience form; the ingest
// pipeline holds a [Compiled] instead so the patterns are compiled once per
// published template rather than once per message.
//
// subject must be norm.Result.Subject (the EFFECTIVE subject: the inner one
// when the message is a forward) and normalizedBody must be norm.Result.Text
// produced by the normalizer version the definition declares. The sender-domain
// gate is NOT applied here; see the package-level note on [MatchesSenderDomain].
func Execute(d Definition, subject, normalizedBody string) (Extraction, error) {
	c, err := Compile(d)
	if err != nil {
		return Extraction{}, err
	}
	return c.Execute(subject, normalizedBody)
}

// Execute runs the compiled template over one message.
//
// The returned Extraction is meaningful even when the error is non-nil: on
// ErrMissingField it carries everything that DID extract, including
// EmptyGroups, which is the case the diagnostics ledger exists for — a row with
// matched=false and the names of the groups that came back empty is what turns
// "unparsed, cause unknown" into a fixable bug report. On ErrNoMatch it is the
// zero value, because nothing was attempted.
func (c *Compiled) Execute(subject, normalizedBody string) (Extraction, error) {
	if len(normalizedBody) > MaxBodyBytes {
		return Extraction{}, fmt.Errorf("%w: normalized body is %d bytes, limit %d",
			ErrTooLarge, len(normalizedBody), MaxBodyBytes)
	}
	if len(subject) > MaxSubjectBytes {
		return Extraction{}, fmt.Errorf("%w: subject is %d bytes, limit %d",
			ErrTooLarge, len(subject), MaxSubjectBytes)
	}
	if err := c.gate(subject, normalizedBody); err != nil {
		return Extraction{}, err
	}

	st := &execState{set: map[string]bool{}, empty: map[string]bool{}}
	for _, ce := range c.entries {
		// Rule 3: the first entry that produces a value for a field wins, and
		// later entries for that field are SKIPPED — not evaluated and
		// discarded. Skipping is also what keeps the cost of a hostile body
		// proportional to the number of fields rather than to the number of
		// entries.
		if st.set[ce.x.Field] && !ce.x.Override {
			continue
		}
		src := normalizedBody
		if ce.x.Source == SourceSubject {
			src = subject
		}
		produced, err := c.runEntry(st, ce, src)
		if err != nil {
			return st.finish(), err
		}
		if !produced {
			continue
		}
		// Rule 4: on_match sets additional fields only if not already set.
		// Sorted, so two executors apply them in the same order even though
		// on_match is a map.
		for _, f := range sortedKeys(ce.x.OnMatch) {
			if st.set[f] {
				continue
			}
			if err := st.setLiteral(f, ce.x.OnMatch[f]); err != nil {
				return st.finish(), err
			}
		}
	}

	e := st.finish()
	if err := ValidateExtraction(e, c.def); err != nil {
		return e, err
	}
	e.Matched = true
	return e, nil
}

// gate applies the content half of Match. Every listed condition must hold and
// body_not_contains must match none.
//
// The errors quote the TEMPLATE's own anchor, never the message, so a caller
// may log them without logging content.
func (c *Compiled) gate(subject, body string) error {
	for _, s := range c.def.Match.SubjectContains {
		if !strings.Contains(subject, s) {
			return fmt.Errorf("%w: the subject does not contain %q", ErrNoMatch, s)
		}
	}
	for _, s := range c.def.Match.BodyContains {
		if !strings.Contains(body, s) {
			return fmt.Errorf("%w: the body does not contain %q", ErrNoMatch, s)
		}
	}
	for _, s := range c.def.Match.BodyNotContains {
		if strings.Contains(body, s) {
			return fmt.Errorf("%w: the body contains %q", ErrNoMatch, s)
		}
	}
	return nil
}

// runEntry evaluates one entry against its source and reports whether it
// produced a value.
//
// Rule 3 in full: a pattern that does not match moves to the next pattern; a
// pattern that matches but whose capture fails typed conversion ALSO moves to
// the next pattern; an entry whose patterns are exhausted produces nothing. A
// conversion failure is never a zero value and never aborts the run.
func (c *Compiled) runEntry(st *execState, ce compiledEntry, src string) (bool, error) {
	x := ce.x
	// A const or flag entry with no patterns at all is an unconditional
	// default. Placed last, that is how a conditional default is expressed —
	// the shape of v1's four-way DIB direction cascade.
	if len(ce.res) == 0 {
		return true, st.setLiteral(x.Field, x.Value)
	}
	for _, re := range ce.res {
		idx := re.FindStringSubmatchIndex(src)
		if idx == nil {
			continue
		}
		st.recordEmptyGroups(x.Field, re, idx)

		switch x.Type {
		case TypeConst, TypeFlag:
			return true, st.setLiteral(x.Field, x.Value)

		case TypeAmount:
			amt, ok := group(src, re, idx, "amt")
			if !ok {
				continue
			}
			ccy, _ := group(src, re, idx, "ccy")
			minor, currency, ok := convertAmount(amt, ccy, c.def.DefaultCurrency)
			if !ok {
				continue
			}
			st.out.AmountMinor, st.out.Currency = minor, currency
			st.mark(x.Field)
			return true, nil

		case TypeDate:
			text, ok := group(src, re, idx, "d")
			if !ok {
				continue
			}
			when, ok := convertDate(text, x.Layouts)
			if !ok {
				continue
			}
			st.out.PostedAt = when
			st.mark(x.Field)
			return true, nil

		case TypeText:
			text, ok := group(src, re, idx, "v")
			if !ok {
				continue
			}
			value, ok := convertText(text)
			if !ok {
				continue
			}
			return true, st.setLiteral(x.Field, value)

		case TypeLast4:
			text, ok := group(src, re, idx, "v")
			if !ok {
				continue
			}
			value, ok := convertLast4(text)
			if !ok {
				continue
			}
			return true, st.setLiteral(x.Field, value)

		default:
			return false, fmt.Errorf("%w: type %q has no conversion", ErrDefinition, x.Type)
		}
	}
	return false, nil
}

// ---------------------------------------------------------------------------
// execution state
// ---------------------------------------------------------------------------

type execState struct {
	out   Extraction
	set   map[string]bool
	empty map[string]bool
}

func (st *execState) mark(field string) { st.set[field] = true }

// setLiteral writes a value that needs no conversion: a const/flag entry's
// Value, an on_match entry, or an already-converted text/last4 capture.
func (st *execState) setLiteral(field, value string) error {
	switch field {
	case FieldDirection:
		st.out.Direction = value
	case FieldMerchant:
		st.out.Merchant = value
	case FieldLast4:
		st.out.Last4 = value
	case FieldIsTransfer:
		st.out.IsTransfer = value == "true"
	default:
		// Unreachable for a compiled definition: checkLiteral refuses these at
		// compile time. Kept because "unreachable" is a claim about today's
		// callers, not a property of this function.
		return fmt.Errorf("%w: %s cannot be set from the literal %q", ErrDefinition, field, value)
	}
	st.mark(field)
	return nil
}

// recordEmptyGroups appends the groups that MATCHED and captured nothing.
//
// The distinction that matters: a group that did not participate at all (an
// optional currency prefix that was absent) has index -1 and is NOT empty,
// while a group that participated and captured "" IS. FindStringSubmatch
// collapses both to "", which is why this reads the index pairs instead —
// conflating them is precisely how this diagnostic goes wrong.
func (st *execState) recordEmptyGroups(field string, re *regexp.Regexp, idx []int) {
	for gi, name := range re.SubexpNames() {
		if gi == 0 || name == "" || 2*gi+1 >= len(idx) {
			continue
		}
		start, end := idx[2*gi], idx[2*gi+1]
		if start < 0 || start != end {
			continue
		}
		st.empty[emptyGroupLabel(field, name)] = true
	}
}

func (st *execState) finish() Extraction {
	out := st.out
	if len(st.empty) > 0 {
		// Sorted and deduplicated, which is the form diag stores: the order an
		// executor happened to evaluate its entries in is not a fact worth
		// carrying, and carrying it would make two identical failures look
		// different.
		labels := make([]string, 0, len(st.empty))
		for l := range st.empty {
			labels = append(labels, l)
		}
		slices.Sort(labels)
		if len(labels) > MaxEmptyGroups {
			labels = labels[:MaxEmptyGroups]
		}
		out.EmptyGroups = labels
	}
	return out
}

func emptyGroupLabel(field, group string) string { return field + "_" + group }

// reEmptyGroupLabel is diag's own group-name grammar. Duplicated rather than
// imported because tmpl must not depend on diag (diag is a consumer), and
// because the constraint is what makes a label storable at all.
var reEmptyGroupLabel = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,31}$`)

// group returns the text a named group captured, and whether it participated.
func group(src string, re *regexp.Regexp, idx []int, name string) (string, bool) {
	gi := re.SubexpIndex(name)
	if gi < 0 || 2*gi+1 >= len(idx) {
		return "", false
	}
	start, end := idx[2*gi], idx[2*gi+1]
	if start < 0 {
		return "", false
	}
	return src[start:end], true
}

// ---------------------------------------------------------------------------
// typed conversion
// ---------------------------------------------------------------------------

// trimCutset is the executor's OWN whitespace set, spelled out rather than
// delegated to strings.TrimSpace or JavaScript's String.prototype.trim. Those
// two disagree — Go trims U+0085 and the Unicode separators but not U+FEFF,
// JavaScript trims U+FEFF — and a difference in what gets trimmed off a capture
// is a difference in the extracted value.
const trimCutset = " \t\n\v\f\r"

func trimCapture(s string) string { return strings.Trim(s, trimCutset) }

// amountShapeRe is the shape an amount must have AFTER commas are removed.
// Exactly two decimals, no sign: bank alert formats in this corpus always carry
// two decimals, and money is always positive with direction carrying the sign.
var amountShapeRe = regexp.MustCompile(`^[0-9]+\.[0-9]{2}$`)

// convertAmount implements rule 5.
//
// The amt group must contain the NUMBER ONLY. A pattern whose amt group also
// swallows a currency prefix ("AED 250.00") is a conversion failure by design:
// the format gives the amount type an optional ccy group for exactly that, and
// accepting two spellings of the same thing would mean two implementations of
// it in two languages.
func convertAmount(amt, ccy, defaultCurrency string) (int64, string, bool) {
	amt = trimCapture(amt)
	if utf8.RuneCountInString(amt) > MaxCaptureRunes {
		return 0, "", false
	}
	digits := strings.ReplaceAll(amt, ",", "")
	if !amountShapeRe.MatchString(digits) {
		return 0, "", false
	}
	// Removing the point rather than scaling by 100 keeps this integer-only in
	// both languages: the TypeScript mirror parses the same digit string with
	// BigInt and never sees a float.
	minor, err := strconv.ParseInt(strings.Replace(digits, ".", "", 1), 10, 64)
	if err != nil {
		return 0, "", false // overflow: an amount int64 cannot hold is not an amount
	}
	currency := defaultCurrency
	if c := asciiUpper(trimCapture(ccy)); c != "" {
		if !currencyRe.MatchString(c) {
			return 0, "", false
		}
		currency = c
	}
	return minor, currency, true
}

// asciiUpper upper-cases A-Z and nothing else. strings.ToUpper and
// String.prototype.toUpperCase disagree on non-ASCII (JavaScript maps U+00DF to
// "SS", Go leaves it alone), and a currency code is ASCII by definition.
func asciiUpper(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 'a' - 'A'
		}
	}
	return string(b)
}

// goDateLayouts maps the format's closed layout enum onto Go reference layouts.
var goDateLayouts = map[string]string{
	LayoutDDMMYYYY:       "02-01-2006",
	LayoutDDMonYYYYHHMMA: "02/Jan/2006 03:04 PM",
	LayoutDDMonYYYY:      "02/Jan/2006",
}

// convertDate implements rule 6: for each declared layout in order, try the
// whole trimmed string, then the text up to the first U+0020. The first success
// wins. The second attempt is what reproduces v1's strings.Fields(s)[0] fallback
// in ParseENBDDate without needing a second Extract entry.
//
// Every layout failing on both attempts is a conversion failure — never a zero
// time presented as a date.
func convertDate(text string, layouts []string) (time.Time, bool) {
	text = trimCapture(text)
	if utf8.RuneCountInString(text) > MaxCaptureRunes {
		return time.Time{}, false
	}
	for _, l := range layouts {
		layout, ok := goDateLayouts[l]
		if !ok {
			continue // refused at compile time; skipping is the fail-closed reading
		}
		if t, ok := parseLayout(text, layout); ok {
			return t, true
		}
	}
	return time.Time{}, false
}

// parseLayout is the whole-string-then-first-token attempt for one layout.
//
// Go's time.Parse decides several things a hand-written TypeScript parser would
// not reproduce by accident, so they are stated here and pinned by
// TestDateParsingSemanticsTheTypeScriptMirrorMustReproduce:
//
//   - Month NAMES are matched case-insensitively ("jun" parses as June), but
//     the AM/PM marker must be upper case.
//   - Numeric fields written "02"/"01"/"03"/"04" require exactly two digits;
//     "5/Jun/2026" does not parse.
//   - Calendar ranges are checked: "31-02-2026" is an error, not 2 March.
//   - There is no zone in any layout, so the result is UTC.
//   - Trailing text is an error, which is what makes the whole-string attempt
//     genuinely whole-string and the first-token fallback necessary.
func parseLayout(text, layout string) (time.Time, bool) {
	if t, err := time.Parse(layout, text); err == nil {
		return t, true
	}
	// The first U+0020 specifically, not "any whitespace": one code point that
	// both languages find the same way.
	if i := strings.IndexByte(text, ' '); i >= 0 {
		if t, err := time.Parse(layout, text[:i]); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// convertText trims a capture and refuses an empty or oversized one. An empty
// capture is not a value: it falls through to the next pattern, and the field
// is left unset for Required to judge.
func convertText(s string) (string, bool) {
	s = trimCapture(s)
	if s == "" || utf8.RuneCountInString(s) > MaxCaptureRunes {
		return "", false
	}
	return s, true
}

// convertLast4 implements rule 7: drop every non-digit, keep the last four.
// Fewer than one digit is a conversion failure.
//
// "Digit" is ASCII 0-9 and nothing else. This corpus is Arabic, and Arabic-Indic
// digits (U+0660-U+0669) are digits to Unicode but are not what a card number is
// written in here; treating them as digits would also make the two executors'
// notions of \d the difference between one card and another.
func convertLast4(s string) (string, bool) {
	if utf8.RuneCountInString(s) > MaxCaptureRunes {
		return "", false
	}
	// A byte scan is safe on UTF-8: an ASCII byte never appears inside a
	// multi-byte sequence.
	digits := make([]byte, 0, 4)
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			digits = append(digits, s[i])
			if len(digits) > 4 {
				digits = digits[1:]
			}
		}
	}
	if len(digits) == 0 {
		return "", false
	}
	return string(digits), true
}

// ---------------------------------------------------------------------------
// gates the caller applies
// ---------------------------------------------------------------------------

// MatchesSenderDomain reports whether verified — the CRYPTOGRAPHICALLY VERIFIED
// signing domain from the DKIM/ARC verifier — is covered by the definition's
// sender_domain list.
//
// The rule is a suffix match ON LABEL BOUNDARIES: "dib.ae" covers
// "notifications.dib.ae" and does NOT cover "evildib.ae". A plain
// strings.HasSuffix would cover both, and registering evildib.ae is a $10
// operation.
//
// This is the ONE definition of the rule; [Store.ForSenderDomain] calls it
// rather than expressing it again in SQL, so the set of templates the ingest
// path runs and the set an operator queries can never disagree.
func MatchesSenderDomain(d Definition, verified string) bool {
	v := asciiLower(strings.TrimSuffix(strings.TrimSpace(verified), "."))
	// A domain that is not shaped like a domain matches nothing. ".dib.ae" has
	// an empty first label, and a plain suffix test would accept it as
	// "something under dib.ae" — the same class of hole as evildib.ae, reached
	// by a malformed input rather than a registered one.
	if !domainRe.MatchString(v) {
		return false
	}
	for _, listed := range d.Match.SenderDomain {
		l := asciiLower(listed)
		if l == "" {
			continue
		}
		if v == l || strings.HasSuffix(v, "."+l) {
			return true
		}
	}
	return false
}

func asciiLower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

// last4Re is the shape [convertLast4] produces.
var last4Re = regexp.MustCompile(`^[0-9]{1,4}$`)

// ValidateExtraction is the second gate: it decides whether an extraction is a
// transaction. [Compiled.Execute] runs it before setting Matched, and the
// pipeline may run it again before writing.
//
// It checks two separate things. First, that every field in Required was
// produced — that is the drift signal, and it is why a template that stops
// matching reports WHICH field went missing. Second, that the extraction is
// internally coherent: a negative amount, an amount with no currency, a
// direction that is not debit or credit, or a body date under date_from=email
// are all states no correct executor produces, so finding one means something
// upstream is wrong and the transaction must not be written.
//
// It deliberately ignores Matched, because Execute calls it BEFORE Matched is
// set — a check on that field here would be a check on nothing.
func ValidateExtraction(e Extraction, d Definition) error {
	for _, f := range d.Required {
		if _, ok := fieldTypes[f]; !ok {
			return fmt.Errorf("%w: required names %q, which is not a field", ErrDefinition, f)
		}
		if f == FieldIsTransfer {
			return fmt.Errorf("%w: is_transfer cannot be required", ErrDefinition)
		}
		if !e.Produced(f) {
			return fmt.Errorf("%w: %s", ErrMissingField, f)
		}
	}
	switch {
	case e.AmountMinor < 0:
		return fmt.Errorf("%w: amount %d is negative; amounts are always positive and direction carries the sign",
			ErrDefinition, e.AmountMinor)
	case e.AmountMinor != 0 && e.Currency == "":
		return fmt.Errorf("%w: an amount was extracted with no currency", ErrDefinition)
	case e.Currency != "" && !currencyRe.MatchString(e.Currency):
		return fmt.Errorf("%w: currency %q is not three upper-case letters", ErrDefinition, e.Currency)
	case e.Direction != "" && e.Direction != "debit" && e.Direction != "credit":
		return fmt.Errorf("%w: direction %q is neither debit nor credit", ErrDefinition, e.Direction)
	case e.Last4 != "" && !last4Re.MatchString(e.Last4):
		return fmt.Errorf("%w: last4 %q is not one to four digits", ErrDefinition, e.Last4)
	case utf8.RuneCountInString(e.Merchant) > MaxCaptureRunes:
		return fmt.Errorf("%w: merchant is %d runes, limit %d",
			ErrDefinition, utf8.RuneCountInString(e.Merchant), MaxCaptureRunes)
	case d.DateFrom == DateFromEmail && !e.PostedAt.IsZero():
		return fmt.Errorf("%w: date_from is %q but a date was extracted from the message body",
			ErrDefinition, DateFromEmail)
	}
	return nil
}
