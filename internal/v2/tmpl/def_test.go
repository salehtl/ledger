package tmpl

import (
	"bytes"
	"strings"
	"testing"
)

func mustParse(t *testing.T, s string) Definition {
	t.Helper()
	d, err := ParseDefinition([]byte(s))
	if err != nil {
		t.Fatalf("ParseDefinition(%s): %v", s, err)
	}
	return d
}

// A complete, valid definition, used as the base for the negative cases below
// so each one differs from a passing definition in exactly one way.
const validDefinitionJSON = `{
  "id": "dib.card.v1",
  "version": 1,
  "bank": "dib",
  "normalizer_version": 1,
  "match": {
    "sender_domain": ["dib.ae"],
    "body_contains": ["إشعار مشتريات"]
  },
  "default_currency": "AED",
  "date_from": "body",
  "extract": [
    {"field":"amount","type":"amount","source":"body",
     "patterns":["المبلغ\\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]*\\.[0-9]{2})"]},
    {"field":"date","type":"date","source":"body",
     "patterns":["بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})"],
     "layouts":["DD-MM-YYYY"]},
    {"field":"merchant","type":"text","source":"body",
     "patterns":["الدفع الى\\n(?P<v>[^\\n]+)"]},
    {"field":"last4","type":"last4","source":"body",
     "patterns":["رقم البطاقة\\n(?P<v>[^ \\n]+)"]},
    {"field":"direction","type":"const","source":"body","value":"debit"},
    {"field":"is_transfer","type":"flag","source":"body","value":"false"}
  ],
  "required": ["amount","direction"]
}`

func TestParseDefinitionReadsTheFormat(t *testing.T) {
	d := mustParse(t, validDefinitionJSON)
	if d.ID != "dib.card.v1" || d.Version != 1 || d.Bank != "dib" || d.NormalizerVersion != 1 {
		t.Fatalf("header wrong: %+v", d)
	}
	if len(d.Match.SenderDomain) != 1 || d.Match.SenderDomain[0] != "dib.ae" {
		t.Fatalf("match wrong: %+v", d.Match)
	}
	if d.DateFrom != "body" || d.DefaultCurrency != "AED" || len(d.Extract) != 6 {
		t.Fatalf("body wrong: %+v", d)
	}
	if d.Extract[1].Layouts[0] != LayoutDDMMYYYY {
		t.Fatalf("layout wrong: %+v", d.Extract[1])
	}
}

// A key nobody reads is how a template "compiles, validates, publishes and
// silently matches nothing".
func TestParseDefinitionRejectsUnknownKeys(t *testing.T) {
	_, err := ParseDefinition([]byte(`{"id":"x","versoin":1}`))
	if err == nil {
		t.Fatal("a misspelled key must be an error, not a silently ignored field")
	}
	if !strings.Contains(err.Error(), "versoin") {
		t.Errorf("error should name the offending key, got %v", err)
	}
}

func TestParseDefinitionRejectsTrailingData(t *testing.T) {
	if _, err := ParseDefinition([]byte(`{"id":"x"} {"id":"y"}`)); err == nil {
		t.Fatal("trailing JSON must be an error")
	}
}

// ---------------------------------------------------------------------------
// Canonical()
// ---------------------------------------------------------------------------

func TestCanonicalDoesNotHTMLEscape(t *testing.T) {
	d := mustParse(t, `{"id":"x","version":1,"extract":[{"field":"merchant","type":"text","source":"body","patterns":["A & B"]}]}`)
	b, err := d.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	// The brief writes this assertion as bytes.Contains(b, []byte(`&`)), which
	// is an HTML entity that survived into the markdown: the escape Go emits is
	// the six characters \u0026, and searching for a bare "&" can only ever fire
	// on the "A & B" the fixture is made of.
	for _, esc := range []string{`\u0026`, `\u003c`, `\u003e`} {
		if bytes.Contains(b, []byte(esc)) {
			t.Fatalf("Canonical emitted %s; Go and TypeScript would hash the same template differently", esc)
		}
	}
	if !bytes.Contains(b, []byte(`A & B`)) {
		t.Fatalf("want the ampersand verbatim, got %s", b)
	}
}

// The second escaping divergence, and the one the brief's prescribed mechanism
// does NOT fix: encoding/json escapes U+2028 and U+2029 even with
// SetEscapeHTML(false), while JSON.stringify emits them raw. Measured, not
// assumed - see docs/superpowers/specs/v2-template-format.md.
func TestCanonicalEmitsU2028AndU2029RawLikeJSONStringify(t *testing.T) {
	src := "{\"id\":\"x\",\"version\":1,\"extract\":[{\"field\":\"merchant\",\"type\":\"text\",\"source\":\"body\",\"patterns\":[\"a\u2028b\u2029c\"]}]}"
	d := mustParse(t, src)
	b, err := d.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	for _, esc := range []string{`\u2028`, `\u2029`} {
		if bytes.Contains(b, []byte(esc)) {
			t.Fatalf("Canonical escaped %s; JSON.stringify does not, so the two hashes would differ", esc)
		}
	}
	if !bytes.Contains(b, []byte("a\u2028b\u2029c")) {
		t.Fatalf("want the separators verbatim, got %q", b)
	}
}

func TestCanonicalEscapesExactlyWhatJSONStringifyEscapes(t *testing.T) {
	// left: the Go string; right: what JSON.stringify produces for it.
	// The right-hand column is pinned in conformance/dialect/patterns.json and
	// re-checked from Bun by client/src/tmpl/agreement.test.ts.
	for _, tc := range []struct{ in, want string }{
		{"a\"b", `"a\"b"`},
		{"a\\b", `"a\\b"`},
		{"a\nb", `"a\nb"`},
		{"a\tb", `"a\tb"`},
		{"a\rb", `"a\rb"`},
		{"a\bb", `"a\bb"`},
		{"a\fb", `"a\fb"`},
		{"a\vb", `"a\u000bb"`},
		{"a\x00b", `"a\u0000b"`},
		{"a\x1fb", `"a\u001fb"`},
		{"a&<>b", `"a&<>b"`},
		{"المبلغ", `"المبلغ"`},
		{"a\u2028b", "\"a\u2028b\""},
		{"a\u2029b", "\"a\u2029b\""},
		{"a b", "\"a b\""},
	} {
		if got := string(canonicalString(tc.in)); got != tc.want {
			t.Errorf("canonicalString(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}

func TestCanonicalIsStableAcrossKeyOrder(t *testing.T) {
	a := mustParse(t, `{"id":"x","version":1,"bank":"b","extract":[{"field":"amount","type":"amount","source":"body","patterns":["(?P<amt>[0-9]\\.[0-9]{2})"],"flags":["i"]}]}`)
	b := mustParse(t, `{"extract":[{"patterns":["(?P<amt>[0-9]\\.[0-9]{2})"],"source":"body","flags":["i"],"type":"amount","field":"amount"}],"bank":"b","version":1,"id":"x"}`)
	ab, err := a.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	bb, err := b.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ab, bb) {
		t.Fatalf("canonical forms differ:\n%s\n%s", ab, bb)
	}
}

func TestCanonicalSortsKeysAndIsTotal(t *testing.T) {
	d := mustParse(t, `{"id":"x","version":1}`)
	b, err := d.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	// Every key is always present (no omitempty), so a TypeScript mirror never
	// has to reproduce Go's emptiness rules, and keys are lexicographic.
	want := `{"bank":"","date_from":"","default_currency":"","extract":[],"id":"x",` +
		`"match":{"body_contains":[],"body_not_contains":[],"sender_domain":[],"subject_contains":[]},` +
		`"normalizer_version":0,"required":[],"version":1}`
	if got != want {
		t.Fatalf("canonical form:\n got %s\nwant %s", got, want)
	}
}

func TestCanonicalOnMatchKeysAreSorted(t *testing.T) {
	d := mustParse(t, `{"id":"x","version":1,"extract":[{"field":"direction","type":"const","source":"body","value":"debit","on_match":{"zeta":"1","alpha":"2","mid":"3"}}]}`)
	b, err := d.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"on_match":{"alpha":"2","mid":"3","zeta":"1"}`)) {
		t.Fatalf("on_match keys must be sorted, got %s", b)
	}
}

func TestCanonicalRejectsInvalidUTF8(t *testing.T) {
	d := Definition{ID: "x", Version: 1, Bank: "\xff\xfe"}
	if _, err := d.Canonical(); err == nil {
		t.Fatal("invalid UTF-8 must be an error: Go would substitute U+FFFD and JSON.stringify would not")
	}
}

// ---------------------------------------------------------------------------
// ValidateDefinition
// ---------------------------------------------------------------------------

func validateJSON(t *testing.T, s string) []error {
	t.Helper()
	return ValidateDefinition(mustParse(t, s))
}

func TestValidateDefinitionAcceptsAWellFormedDefinition(t *testing.T) {
	if errs := validateJSON(t, validDefinitionJSON); len(errs) != 0 {
		t.Fatalf("valid definition rejected: %v", errs)
	}
}

func TestValidateDefinitionRequiresAmountAndDirection(t *testing.T) {
	s := strings.Replace(validDefinitionJSON, `"required": ["amount","direction"]`, `"required": ["amount"]`, 1)
	if errs := validateJSON(t, s); len(errs) == 0 {
		t.Fatal("a definition whose Required omits direction must be rejected")
	}
	s = strings.Replace(validDefinitionJSON, `"required": ["amount","direction"]`, `"required": ["direction"]`, 1)
	if errs := validateJSON(t, s); len(errs) == 0 {
		t.Fatal("a definition whose Required omits amount must be rejected")
	}
	s = strings.Replace(validDefinitionJSON, `"required": ["amount","direction"]`,
		`"required": ["amount","direction","merchant","last4","date","is_transfer"]`, 1)
	if errs := validateJSON(t, s); len(errs) != 0 {
		t.Fatalf("every listed field IS produced here: %v", errs)
	}
	// A Required field no Extract entry can ever produce is a dead template.
	s = strings.Replace(validDefinitionJSON, `{"field":"date","type":"date","source":"body",`,
		`{"field":"merchant","type":"text","source":"body",`, 1)
	s = strings.Replace(s, `"layouts":["DD-MM-YYYY"]`, `"flags":[]`, 1)
	s = strings.Replace(s, `(?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})`, `(?P<v>[0-9]{2}-[0-9]{2}-[0-9]{4})`, 1)
	s = strings.Replace(s, `"required": ["amount","direction"]`, `"required": ["amount","direction","date"]`, 1)
	if errs := validateJSON(t, s); len(errs) == 0 {
		t.Fatal("Required naming a field no entry produces must be rejected")
	}
}

func TestValidateDefinitionRejectsMultipleOverrides(t *testing.T) {
	one := strings.Replace(validDefinitionJSON,
		`{"field":"direction","type":"const","source":"body","value":"debit"}`,
		`{"field":"direction","type":"const","source":"body","value":"debit"},`+
			`{"field":"direction","type":"const","source":"body","value":"credit","override":true,`+
			`"why":"dib.go:79-83 re-derives direction from the description suffix"}`, 1)
	if errs := validateJSON(t, one); len(errs) != 0 {
		t.Fatalf("exactly one override must be allowed: %v", errs)
	}

	two := strings.Replace(one,
		`{"field":"direction","type":"const","source":"body","value":"credit","override":true,`,
		`{"field":"direction","type":"const","source":"body","value":"credit","override":true,"why":"x"},`+
			`{"field":"direction","type":"const","source":"body","value":"debit","override":true,`, 1)
	errs := validateJSON(t, two)
	if len(errs) == 0 {
		t.Fatal("two override entries must be rejected")
	}
	if !strings.Contains(errs[0].Error(), "override") {
		t.Errorf("the error must name override, got %v", errs)
	}
}

func TestValidateDefinitionRequiresWhyOnAnOverride(t *testing.T) {
	s := strings.Replace(validDefinitionJSON,
		`{"field":"direction","type":"const","source":"body","value":"debit"}`,
		`{"field":"direction","type":"const","source":"body","value":"debit","override":true}`, 1)
	errs := validateJSON(t, s)
	if len(errs) == 0 {
		t.Fatal(`an override entry with no "why" must be rejected`)
	}
	if !strings.Contains(errs[0].Error(), "why") {
		t.Errorf(`the error must name "why", got %v`, errs)
	}
}

func TestValidateDefinitionRunsTheDialectGateOverEveryPattern(t *testing.T) {
	s := strings.Replace(validDefinitionJSON, `(?P<v>[^\\n]+)`, `(?P<v>.+)`, 1)
	if s == validDefinitionJSON {
		t.Fatal("test setup: fixture text not found")
	}
	errs := validateJSON(t, s)
	if len(errs) == 0 {
		t.Fatal("a pattern with a bare dot must be rejected by ValidateDefinition")
	}
	if !strings.Contains(errs[0].Error(), ReasonBareDot) {
		t.Errorf("want the dialect reason code, got %v", errs)
	}
}

func TestValidateDefinitionEnforcesTheRequiredGroupNamesPerType(t *testing.T) {
	for _, tc := range []struct{ name, from, to string }{
		{"amount without amt", `(?P<amt>[0-9][0-9,]*\\.[0-9]{2})`, `(?P<x>[0-9][0-9,]*\\.[0-9]{2})`},
		{"date without d", `(?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})`, `(?P<v>[0-9]{2}-[0-9]{2}-[0-9]{4})`},
		{"text without v", `الدفع الى\\n(?P<v>[^\\n]+)`, `الدفع الى\\n(?P<d>[^\\n]+)`},
		{"amount with a stray group", `(?P<amt>[0-9][0-9,]*\\.[0-9]{2})`, `(?P<amt>[0-9][0-9,]*\\.[0-9]{2})(?P<junk>x)?`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := strings.Replace(validDefinitionJSON, tc.from, tc.to, 1)
			if s == validDefinitionJSON {
				t.Fatalf("test setup: %q not found in the fixture", tc.from)
			}
			if errs := ValidateDefinition(mustParse(t, s)); len(errs) == 0 {
				t.Fatalf("%s must be rejected", tc.name)
			}
		})
	}
	// ccy is optional on an amount pattern, not required.
	s := strings.Replace(validDefinitionJSON, `(?P<ccy>[A-Z]{3} )?`, ``, 1)
	if s == validDefinitionJSON {
		t.Fatal("test setup: fixture text not found")
	}
	if errs := ValidateDefinition(mustParse(t, s)); len(errs) != 0 {
		t.Fatalf("ccy is optional: %v", errs)
	}
}

func TestValidateDefinitionEnforcesTheClosedEnums(t *testing.T) {
	for _, tc := range []struct{ name, from, to string }{
		{"date_from", `"date_from": "body"`, `"date_from": "header"`},
		{"field", `"field":"merchant","type":"text"`, `"field":"payee","type":"text"`},
		{"type", `"field":"merchant","type":"text"`, `"field":"merchant","type":"string"`},
		{"source", `"field":"merchant","type":"text","source":"body"`, `"field":"merchant","type":"text","source":"html"`},
		{"layout", `"layouts":["DD-MM-YYYY"]`, `"layouts":["YYYY-MM-DD"]`},
		{"currency", `"default_currency": "AED"`, `"default_currency": "aed"`},
		{"flag value", `{"field":"is_transfer","type":"flag","source":"body","value":"false"}`,
			`{"field":"is_transfer","type":"flag","source":"body","value":"maybe"}`},
		{"direction value", `{"field":"direction","type":"const","source":"body","value":"debit"}`,
			`{"field":"direction","type":"const","source":"body","value":"outgoing"}`},
		{"field/type pairing", `"field":"amount","type":"amount"`, `"field":"amount","type":"text"`},
		{"id charset", `"id": "dib.card.v1"`, `"id": "DIB Card"`},
		{"version", `"version": 1,`, `"version": 0,`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := strings.Replace(validDefinitionJSON, tc.from, tc.to, 1)
			if s == validDefinitionJSON {
				t.Fatalf("test setup: %q not found in the fixture", tc.from)
			}
			if errs := ValidateDefinition(mustParse(t, s)); len(errs) == 0 {
				t.Fatalf("%s must be rejected", tc.name)
			}
		})
	}
}

func TestValidateDefinitionRequiresASenderDomain(t *testing.T) {
	s := strings.Replace(validDefinitionJSON, `"sender_domain": ["dib.ae"],`, ``, 1)
	if s == validDefinitionJSON {
		t.Fatal("test setup: fixture text not found")
	}
	if errs := ValidateDefinition(mustParse(t, s)); len(errs) == 0 {
		t.Fatal("a template with no sender_domain would match on unverified content alone")
	}
}

func TestValidateDefinitionRequiresPatternsWhereTheTypeNeedsThem(t *testing.T) {
	s := strings.Replace(validDefinitionJSON,
		`{"field":"merchant","type":"text","source":"body",
     "patterns":["الدفع الى\\n(?P<v>[^\\n]+)"]}`,
		`{"field":"merchant","type":"text","source":"body"}`, 1)
	if s == validDefinitionJSON {
		t.Fatal("test setup: fixture text not found")
	}
	if errs := ValidateDefinition(mustParse(t, s)); len(errs) == 0 {
		t.Fatal("a text entry with no patterns can never produce a value")
	}
	// A const entry with no patterns is the unconditional default and is legal
	// - it is how v1's four-way DIB direction cascade ends.
	if errs := ValidateDefinition(mustParse(t, validDefinitionJSON)); len(errs) != 0 {
		t.Fatalf("the unconditional const entry must stay legal: %v", errs)
	}
}

func TestValidateDefinitionRequiresLayoutsOnADateEntry(t *testing.T) {
	s := strings.Replace(validDefinitionJSON, `,
     "layouts":["DD-MM-YYYY"]`, ``, 1)
	if s == validDefinitionJSON {
		t.Fatal("test setup: fixture text not found")
	}
	if errs := ValidateDefinition(mustParse(t, s)); len(errs) == 0 {
		t.Fatal("a date entry with no layouts can never convert")
	}
}
