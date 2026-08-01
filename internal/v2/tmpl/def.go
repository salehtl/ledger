package tmpl

// def.go is the template definition format: the JSON a bank parser is written
// in (spec section 3.5), the strict reader for it, the canonical byte form
// used for hashing, and the publish-time validator.
//
// Templates are data, not code. One definition is authored once, published
// once, and then executed by two independent engines — the Go executor in this
// package and the TypeScript executor in client/. Everything here exists to
// make those two executors see the same template: a strict reader so a
// misspelled key is an error rather than a silently ignored field, a canonical
// encoder whose bytes Go and JavaScript both produce, and a validator that
// runs the regex dialect gate (dialect.go) over every pattern before anything
// is stored.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Definition is one published bank template.
type Definition struct {
	ID                string    `json:"id"`
	Version           int       `json:"version"`
	Bank              string    `json:"bank"`
	NormalizerVersion int       `json:"normalizer_version"`
	Match             Match     `json:"match"`
	DefaultCurrency   string    `json:"default_currency"`
	DateFrom          string    `json:"date_from"` // "body" | "email"
	Extract           []Extract `json:"extract"`
	Required          []string  `json:"required"`
}

// Match gates whether a definition is tried against a message at all.
//
// SenderDomain is matched against the CRYPTOGRAPHICALLY VERIFIED signing
// domain supplied by the trusted-lane check, never against a From header and
// never against norm.Result.From, which is attacker-authored body text.
type Match struct {
	SenderDomain    []string `json:"sender_domain"`
	SubjectContains []string `json:"subject_contains,omitempty"`
	BodyContains    []string `json:"body_contains,omitempty"`
	BodyNotContains []string `json:"body_not_contains,omitempty"`
}

// Extract is one field-producing rule. Entries are evaluated in order and the
// first entry to produce a value for a field wins, unless Override is set.
type Extract struct {
	Field    string            `json:"field"`  // amount|date|merchant|last4|direction|is_transfer
	Type     string            `json:"type"`   // amount|date|text|last4|const|flag
	Source   string            `json:"source"` // body|subject
	Patterns []string          `json:"patterns,omitempty"`
	Flags    []string          `json:"flags,omitempty"`   // only {"i"} is permitted
	Layouts  []string          `json:"layouts,omitempty"` // date only, closed enum, tried in order
	Value    string            `json:"value,omitempty"`   // const/flag only
	Override bool              `json:"override,omitempty"`
	Why      string            `json:"why,omitempty"` // mandatory when Override is set
	OnMatch  map[string]string `json:"on_match,omitempty"`
}

// The three date layouts. This is a closed enum: both executors implement
// exactly these and nothing else, because a layout one executor understands
// and the other does not is a silent per-device date difference.
const (
	LayoutDDMMYYYY       = "DD-MM-YYYY"
	LayoutDDMonYYYYHHMMA = "DD/Mon/YYYY hh:mm A"
	LayoutDDMonYYYY      = "DD/Mon/YYYY"
)

// Field, type, source and date-source enums.
const (
	FieldAmount     = "amount"
	FieldDate       = "date"
	FieldMerchant   = "merchant"
	FieldLast4      = "last4"
	FieldDirection  = "direction"
	FieldIsTransfer = "is_transfer"

	TypeAmount = "amount"
	TypeDate   = "date"
	TypeText   = "text"
	TypeLast4  = "last4"
	TypeConst  = "const"
	TypeFlag   = "flag"

	SourceBody    = "body"
	SourceSubject = "subject"

	DateFromBody  = "body"
	DateFromEmail = "email"
)

// fieldTypes is the legal (field, type) pairing. A pairing table rather than
// two independent enums, because "amount extracted as text" would parse, pass
// two enum checks and then never produce an int64.
var fieldTypes = map[string][]string{
	FieldAmount:     {TypeAmount},
	FieldDate:       {TypeDate},
	FieldMerchant:   {TypeText, TypeConst},
	FieldLast4:      {TypeLast4, TypeConst},
	FieldDirection:  {TypeConst},
	FieldIsTransfer: {TypeFlag},
}

// groupNamesByType is the executor's contract with the pattern author: the
// executor reads exactly these named groups, so a pattern that captures under
// any other name has captured nothing as far as extraction is concerned.
var groupNamesByType = map[string]struct{ required, optional []string }{
	TypeAmount: {required: []string{"amt"}, optional: []string{"ccy"}},
	TypeDate:   {required: []string{"d"}},
	TypeText:   {required: []string{"v"}},
	TypeLast4:  {required: []string{"v"}},
	TypeConst:  {},
	TypeFlag:   {},
}

var (
	idRe       = regexp.MustCompile(`^[a-z0-9]+([._-][a-z0-9]+)*$`)
	currencyRe = regexp.MustCompile(`^[A-Z]{3}$`)
	domainRe   = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
)

// ParseDefinition reads a definition from JSON, strictly.
//
// Unknown keys are an error. A template is authored by hand, and a key nobody
// reads is exactly how a template "compiles, validates, publishes and silently
// matches nothing" — the failure mode the seed-transcription warning in the
// plan is about.
func ParseDefinition(b []byte) (Definition, error) {
	var d Definition
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return Definition{}, fmt.Errorf("template definition: %w", err)
	}
	if dec.More() {
		return Definition{}, fmt.Errorf("template definition: trailing data after the JSON object")
	}
	return d, nil
}

// ---------------------------------------------------------------------------
// Canonical
// ---------------------------------------------------------------------------

// Canonical renders the definition as the byte string used for hashing and
// signing. It is not the storage form: it is a TOTAL, key-sorted encoding that
// a TypeScript mirror can reproduce with a sort and a JSON.stringify.
//
// Three properties, each of which exists because getting it wrong produces a
// silent Go/TypeScript hash difference on a template that works fine in both:
//
//  1. Keys are sorted lexicographically at every level, including on_match.
//     Go marshals a struct in field-declaration order and JavaScript
//     stringifies in insertion order; neither is reproducible from the other,
//     but both can sort.
//
//  2. Every key is always present. No omitempty, nil slices render as [], the
//     empty string as "". A TypeScript mirror therefore never has to reproduce
//     Go's emptiness rules.
//
//  3. Strings are escaped exactly as JSON.stringify escapes them. Go's
//     encoding/json is wrong here twice over: by default it escapes &, < and >
//     (so a merchant anchor containing & would hash differently), and even with
//     SetEscapeHTML(false) it still escapes U+2028 and U+2029, which
//     JSON.stringify emits raw. Both were measured; see
//     docs/superpowers/specs/v2-template-format.md. JSON.stringify's algorithm
//     is fixed by the ECMAScript spec and Go's is configurable, so Go is the
//     side that moves.
//
// It returns an error if any string is not valid UTF-8: Go would silently
// substitute U+FFFD and JavaScript would not.
func (d Definition) Canonical() ([]byte, error) {
	if err := d.checkUTF8(); err != nil {
		return nil, err
	}
	extract := make([][]byte, 0, len(d.Extract))
	for _, e := range d.Extract {
		extract = append(extract, canonicalObject([]canonicalField{
			{"field", canonicalString(e.Field)},
			{"flags", canonicalStrings(e.Flags)},
			{"layouts", canonicalStrings(e.Layouts)},
			{"on_match", canonicalStringMap(e.OnMatch)},
			{"override", canonicalBool(e.Override)},
			{"patterns", canonicalStrings(e.Patterns)},
			{"source", canonicalString(e.Source)},
			{"type", canonicalString(e.Type)},
			{"value", canonicalString(e.Value)},
			{"why", canonicalString(e.Why)},
		}))
	}
	match := canonicalObject([]canonicalField{
		{"body_contains", canonicalStrings(d.Match.BodyContains)},
		{"body_not_contains", canonicalStrings(d.Match.BodyNotContains)},
		{"sender_domain", canonicalStrings(d.Match.SenderDomain)},
		{"subject_contains", canonicalStrings(d.Match.SubjectContains)},
	})
	return canonicalObject([]canonicalField{
		{"bank", canonicalString(d.Bank)},
		{"date_from", canonicalString(d.DateFrom)},
		{"default_currency", canonicalString(d.DefaultCurrency)},
		{"extract", canonicalArray(extract)},
		{"id", canonicalString(d.ID)},
		{"match", match},
		{"normalizer_version", canonicalInt(d.NormalizerVersion)},
		{"required", canonicalStrings(d.Required)},
		{"version", canonicalInt(d.Version)},
	}), nil
}

func (d Definition) checkUTF8() error {
	bad := func(where, s string) error {
		return fmt.Errorf("template %s: %s is not valid UTF-8", d.ID, where)
	}
	// A slice, not a map: the field named in the error must not depend on Go's
	// map iteration order, or the same definition produces different errors on
	// different runs.
	type group struct {
		where  string
		values []string
	}
	groups := []group{
		{"id", []string{d.ID}},
		{"bank", []string{d.Bank}},
		{"default_currency", []string{d.DefaultCurrency}},
		{"date_from", []string{d.DateFrom}},
		{"match.sender_domain", d.Match.SenderDomain},
		{"match.subject_contains", d.Match.SubjectContains},
		{"match.body_contains", d.Match.BodyContains},
		{"match.body_not_contains", d.Match.BodyNotContains},
		{"required", d.Required},
	}
	for i, e := range d.Extract {
		onMatch := make([]string, 0, 2*len(e.OnMatch))
		for _, k := range sortedKeys(e.OnMatch) {
			onMatch = append(onMatch, k, e.OnMatch[k])
		}
		groups = append(groups,
			group{fmt.Sprintf("extract[%d]", i), []string{e.Field, e.Type, e.Source, e.Value, e.Why}},
			group{fmt.Sprintf("extract[%d].patterns", i), e.Patterns},
			group{fmt.Sprintf("extract[%d].flags", i), e.Flags},
			group{fmt.Sprintf("extract[%d].layouts", i), e.Layouts},
			group{fmt.Sprintf("extract[%d].on_match", i), onMatch},
		)
	}
	for _, g := range groups {
		for _, s := range g.values {
			if !utf8.ValidString(s) {
				return bad(g.where, s)
			}
		}
	}
	return nil
}

type canonicalField struct {
	key string
	val []byte
}

func canonicalObject(fs []canonicalField) []byte {
	sort.Slice(fs, func(i, j int) bool { return fs[i].key < fs[j].key })
	var b bytes.Buffer
	b.WriteByte('{')
	for i, f := range fs {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(canonicalString(f.key))
		b.WriteByte(':')
		b.Write(f.val)
	}
	b.WriteByte('}')
	return b.Bytes()
}

func canonicalArray(vs [][]byte) []byte {
	var b bytes.Buffer
	b.WriteByte('[')
	for i, v := range vs {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(v)
	}
	b.WriteByte(']')
	return b.Bytes()
}

func canonicalStrings(ss []string) []byte {
	vs := make([][]byte, 0, len(ss))
	for _, s := range ss {
		vs = append(vs, canonicalString(s))
	}
	return canonicalArray(vs)
}

func canonicalStringMap(m map[string]string) []byte {
	fs := make([]canonicalField, 0, len(m))
	for k, v := range m {
		fs = append(fs, canonicalField{k, canonicalString(v)})
	}
	return canonicalObject(fs)
}

func canonicalBool(v bool) []byte {
	if v {
		return []byte("true")
	}
	return []byte("false")
}

func canonicalInt(n int) []byte { return []byte(strconv.Itoa(n)) }

// canonicalString implements ECMAScript's QuoteJSONString: escape only the
// quote, the backslash and the C0 controls, using the short forms where they
// exist and \u00xx (lowercase hex) otherwise. Everything else, including &, <,
// >, U+2028, U+2029 and every non-ASCII rune, is emitted verbatim as UTF-8.
func canonicalString(s string) []byte {
	b := make([]byte, 0, len(s)+2)
	b = append(b, '"')
	for _, r := range s {
		switch r {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\b':
			b = append(b, '\\', 'b')
		case '\f':
			b = append(b, '\\', 'f')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			if r < 0x20 {
				b = append(b, fmt.Sprintf(`\u%04x`, r)...)
			} else {
				b = utf8.AppendRune(b, r)
			}
		}
	}
	return append(b, '"')
}

// ---------------------------------------------------------------------------
// ValidateDefinition
// ---------------------------------------------------------------------------

// ValidateDefinition reports every reason the definition must not be
// published. An empty result is the only thing that may reach the store: the
// dialect check is a publish-time gate (spec section 3.5), not a lint, because
// an invalid pattern that reaches a device is a pattern the device must
// either run or refuse at load time, and neither is recoverable from the
// device's side.
func ValidateDefinition(d Definition) []error {
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if !idRe.MatchString(d.ID) {
		add("id %q must match %s", d.ID, idRe)
	}
	if d.Version < 1 {
		add("version must be >= 1, got %d", d.Version)
	}
	if d.Bank == "" {
		add("bank must not be empty")
	}
	if d.NormalizerVersion < 1 {
		add("normalizer_version must be >= 1, got %d", d.NormalizerVersion)
	}
	if !currencyRe.MatchString(d.DefaultCurrency) {
		add("default_currency %q must be three upper-case letters", d.DefaultCurrency)
	}
	if d.DateFrom != DateFromBody && d.DateFrom != DateFromEmail {
		add("date_from must be %q or %q, got %q", DateFromBody, DateFromEmail, d.DateFrom)
	}

	if len(d.Match.SenderDomain) == 0 {
		add("match.sender_domain must list at least one domain: without it the template would " +
			"match on message content alone, and content is attacker-authored")
	}
	for i, dom := range d.Match.SenderDomain {
		if !domainRe.MatchString(dom) {
			add("match.sender_domain[%d] %q must be a lower-case domain name", i, dom)
		}
	}

	if len(d.Extract) == 0 {
		add("extract must contain at least one entry")
	}

	produced := map[string]bool{}
	overrides := 0
	for i, e := range d.Extract {
		errs = append(errs, validateExtract(i, e)...)
		produced[e.Field] = true
		for f := range e.OnMatch {
			produced[f] = true
		}
		if e.Override {
			overrides++
		}
	}
	if overrides > 1 {
		add("override is set on %d entries; it exists for exactly one case (v1 dib.go:79-83 "+
			"re-deriving direction from the description suffix) and a second use means the "+
			"first-entry-wins rule is being worked around rather than expressed", overrides)
	}

	for _, f := range []string{FieldAmount, FieldDirection} {
		if !containsString(d.Required, f) {
			add("required must include %q: a transaction without it is not a transaction", f)
		}
	}
	for i, f := range d.Required {
		if _, ok := fieldTypes[f]; !ok {
			add("required[%d] %q is not a field name", i, f)
			continue
		}
		if !produced[f] {
			add("required[%d] %q is not produced by any extract entry, so the template can never match", i, f)
		}
	}
	return errs
}

func validateExtract(i int, e Extract) []error {
	var errs []error
	add := func(format string, args ...any) {
		errs = append(errs, fmt.Errorf("extract[%d]: "+format, append([]any{i}, args...)...))
	}

	types, knownField := fieldTypes[e.Field]
	if !knownField {
		add("field %q is not one of %s", e.Field, strings.Join(sortedKeys(fieldTypes), ", "))
	}
	spec, knownType := groupNamesByType[e.Type]
	if !knownType {
		add("type %q is not one of %s", e.Type, strings.Join(sortedKeys(groupNamesByType), ", "))
	}
	if knownField && knownType && !containsString(types, e.Type) {
		add("field %q cannot be extracted as type %q; legal types are %s",
			e.Field, e.Type, strings.Join(types, ", "))
	}
	if e.Source != SourceBody && e.Source != SourceSubject {
		add("source must be %q or %q, got %q", SourceBody, SourceSubject, e.Source)
	}

	isConst := e.Type == TypeConst || e.Type == TypeFlag
	switch {
	case isConst && e.Value == "":
		add("a %s entry must carry a value", e.Type)
	case !isConst && e.Value != "":
		add("value is only meaningful on const and flag entries")
	}
	if e.Type == TypeFlag && e.Value != "true" && e.Value != "false" {
		add("a flag value must be \"true\" or \"false\", got %q", e.Value)
	}
	if e.Field == FieldDirection && e.Value != "debit" && e.Value != "credit" {
		add("a direction value must be \"debit\" or \"credit\", got %q", e.Value)
	}

	if !isConst && len(e.Patterns) == 0 {
		add("a %s entry needs at least one pattern; with none it can never produce a value", e.Type)
	}
	if e.Type == TypeDate && len(e.Layouts) == 0 {
		add("a date entry needs at least one layout; with none the captured text can never convert")
	}
	if e.Type != TypeDate && len(e.Layouts) > 0 {
		add("layouts are only meaningful on a date entry")
	}
	for j, l := range e.Layouts {
		if l != LayoutDDMMYYYY && l != LayoutDDMonYYYYHHMMA && l != LayoutDDMonYYYY {
			add("layouts[%d] %q is not one of the three supported layouts (%q, %q, %q)",
				j, l, LayoutDDMMYYYY, LayoutDDMonYYYYHHMMA, LayoutDDMonYYYY)
		}
	}

	if e.Override && strings.TrimSpace(e.Why) == "" {
		add(`override must carry a "why": it suspends the first-entry-wins rule, ` +
			`so the reason has to survive in the template rather than in a commit message`)
	}
	if !e.Override && e.Why != "" {
		add(`"why" is only meaningful together with override`)
	}

	for f := range e.OnMatch {
		if _, ok := fieldTypes[f]; !ok {
			add("on_match key %q is not a field name", f)
		}
	}

	// The dialect gate. Every pattern, every entry, before anything is stored.
	for j, p := range e.Patterns {
		for _, err := range ValidatePattern(p, e.Flags) {
			errs = append(errs, fmt.Errorf("extract[%d].patterns[%d]: %w", i, j, err))
		}
		if knownType {
			errs = append(errs, validateGroupNames(i, j, e.Type, p, spec.required, spec.optional)...)
		}
	}
	return errs
}

// validateGroupNames enforces the executor's contract: the executor reads
// exactly the named groups listed for the entry's type, so a pattern that is
// missing one can never produce a value and a pattern that captures under an
// extra name has written a capture nothing will ever read.
func validateGroupNames(i, j int, typ, p string, required, optional []string) []error {
	names := GroupNames(p)
	if names == nil && !regexpCompiles(p) {
		return nil // the dialect gate already reported it
	}
	var errs []error
	have := map[string]bool{}
	for _, n := range names {
		have[n] = true
	}
	for _, want := range required {
		if !have[want] {
			errs = append(errs, fmt.Errorf(
				"extract[%d].patterns[%d]: a %s pattern must capture (?P<%s>...); it captures %v",
				i, j, typ, want, names))
		}
	}
	for _, n := range names {
		if !containsString(required, n) && !containsString(optional, n) {
			errs = append(errs, fmt.Errorf(
				"extract[%d].patterns[%d]: a %s pattern has no use for the group %q; the executor reads only %v",
				i, j, typ, n, append(append([]string{}, required...), optional...)))
		}
	}
	return errs
}

func regexpCompiles(p string) bool {
	_, err := regexp.Compile(p)
	return err == nil
}

func containsString(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
