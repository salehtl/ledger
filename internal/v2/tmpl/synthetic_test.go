package tmpl

// synthetic_test.go writes the hand-built half of conformance/templates/.
//
// The corpus half (corpus_test.go) is 1,062 cases of the operator's real bank
// mail, and it is the only evidence that the two executors agree about mail
// that actually arrives. It is also blind in three ways that matter, and each
// one was MEASURED on the corpus rather than assumed:
//
//  1. The corpus holds 62 ENBD messages and NOT ONE of them is the alert
//     format `enbd.alert.v1` was ported from — all 62 are "Local Bank
//     Transfer" / "Telegraphic Transfer" advices with a `Debit Amount:` block,
//     so every corpus case for that template is a non-match. A third of the
//     published seed set has zero corpus coverage of its extraction path.
//  2. Zero corpus cases produce an empty capture group, so the EmptyGroups
//     diagnostic — the thing the whole diagnostics ledger is built on — is
//     never compared.
//  3. Real mail is well-formed. The conversion rules are mostly about
//     malformed input: an amount with three decimals, a date with a two-digit
//     year, a capture surrounded by U+00A0.
//
// That last class is where two hand-written implementations differ, and the
// difference is silent. `String.prototype.trim()` removes U+00A0 and U+FEFF
// and Go's trim set does not; `toUpperCase()` maps U+00DF to "SS" and Go's
// does not; `Number("")` is 0 and `parseInt` stops at the first non-digit;
// `Date.parse` is implementation-defined for every shape in this format. Every
// one of those is a case below, and every expectation is what GO produced —
// never what the case's name says it should produce, so a case whose name is
// wrong is harmless and a case whose expectation is recomputed by the reader
// is impossible.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// syntheticGroup is one output file: a definition and the inputs run against it.
type syntheticGroup struct {
	file       string
	template   string
	definition string
	cases      []syntheticCase
}

type syntheticCase struct {
	name    string
	why     string
	subject string
	body    string
}

// The ENBD alert format, which the corpus has none of. The definition is the
// PUBLISHED SEED, read from testdata rather than retyped, so these cases
// exercise the template that actually ships.
func syntheticENBD(t *testing.T) syntheticGroup {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "enbd.alert.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	const subj = "Transaction advice for your account ending with 3701"
	return syntheticGroup{
		file:       "synthetic-enbd-alert.json",
		template:   "enbd.alert.v1",
		definition: string(b),
		cases: []syntheticCase{
			{"withdrawn", "the debit phrasing v1's enbd_alert.go:25 anchors on", subj,
				"AED 250,000.00 has been withdrawn from your account 067XXX17XXX01."},
			{"debited", "the second debit verb in the same alternation", subj,
				"AED 12.34 has been debited from your account 067XXX17XXX01."},
			{"credited", "the credit branch, and on_match setting direction", subj,
				"AED 400.00 has been credited to your account 067XXX17XXX01."},
			{"deposited-into", "the optional (?:in)?to", subj,
				"AED 400.00 has been deposited into your account 067XXX17XXX01."},
			{"case-folded", `flags ["i"]: the whole line upper-cased`, subj,
				"aed 250,000.00 HAS BEEN WITHDRAWN FROM YOUR ACCOUNT 067XXX17XXX01."},
			{"newline-separated", `the [ \n] separators, which is why \s is banned`, subj,
				"AED 250.00\nhas been\nwithdrawn\nfrom your account 067XXX17XXX01."},
			{"no-currency-prefix", "the ccy group does not participate; default_currency applies", subj,
				"250.00 has been withdrawn from your account 067XXX17XXX01."},
			{"foreign-currency", "the ccy group wins over default_currency", subj,
				"USD 99.99 has been withdrawn from your account 067XXX17XXX01."},
			{"no-subject", "last4 is read from the subject and is not required", "",
				"AED 250.00 has been withdrawn from your account 067XXX17XXX01."},
			{"subject-without-last4", "the last4 pattern does not match; the rest still extracts",
				"Transaction advice", "AED 250.00 has been withdrawn from your account."},
			{"neither-verb", "no amount entry produces a value: the required-field gate fires", subj,
				"AED 250.00 has been reserved on your account 067XXX17XXX01."},
			{"amount-without-decimals", "conversion failure, not a zero amount", subj,
				"AED 250 has been withdrawn from your account 067XXX17XXX01."},
			{"debit-then-credit", "first entry wins: the debit entry runs first", subj,
				"AED 1.00 has been withdrawn from your account.\nAED 2.00 has been credited to your account."},
			{"credit-then-debit", "entry ORDER decides, not position in the body", subj,
				"AED 2.00 has been credited to your account.\nAED 1.00 has been withdrawn from your account."},
			{"amount-longer-than-the-bound",
				"33 digits before the point. The amount run is [0-9,]{0,24} rather than [0-9,]*, because unbounded " +
					"it made this anchor quadratic (333,859 ms on a 1 MB body in Bun); pinned so the two executors " +
					"agree on what the bound does rather than on what it was meant to do", subj,
				"AED 1,234,567,890,123,456,789,012,345.67 has been withdrawn from your account 067XXX17XXX01."},
			{"transfer-advice-from-the-corpus", "the shape all 62 real ENBD messages have; it must not match", "Local Bank Transfer",
				"Transaction Date:\n24/Nov/2024 08:03 PM\nFrom Account:\n067***17***01\nDebit Amount:\nAED 108,564.00\n"},
		},
	}
}

// dates: the three layouts and every semantic Go's time.Parse decides for us.
// Mirrors TestDateParsingSemanticsTheTypeScriptMirrorMustReproduce, but as a
// fixture the TypeScript executor is checked against rather than a Go-only test.
func syntheticDates() syntheticGroup {
	def := `{
	  "id":"synth.dates","version":1,"bank":"t","normalizer_version":1,
	  "match":{"sender_domain":["example.com"]},
	  "default_currency":"AED","date_from":"body",
	  "extract":[
	    {"field":"amount","type":"amount","source":"body","patterns":["Amt: (?P<amt>[^\\n]+)"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"},
	    {"field":"date","type":"date","source":"body",
	     "layouts":["DD-MM-YYYY","DD/Mon/YYYY hh:mm A","DD/Mon/YYYY"],
	     "patterns":["Date: (?P<d>[^\\n]+)"]}
	  ],
	  "required":["amount","direction"]}`
	texts := []syntheticCase{
		{"dd-mm-yyyy", "layout 1, whole string", "", "05-06-2026"},
		{"dd-mon-yyyy-hh-mm-a", "layout 2, whole string", "", "05/Jun/2026 04:25 PM"},
		{"dd-mon-yyyy", "layout 3, whole string", "", "05/Jun/2026"},
		{"month-name-lowercase", "month NAMES fold case in Go", "", "05/jun/2026"},
		{"month-name-uppercase", "and upper too", "", "05/JUN/2026"},
		{"ampm-lowercase", "the AM/PM marker does NOT fold; layout 3 catches it via the first token", "", "05/Jun/2026 04:25 pm"},
		{"pm-noon", "12 PM stays 12", "", "05/Jun/2026 12:00 PM"},
		{"am-midnight", "12 AM is 0", "", "05/Jun/2026 12:00 AM"},
		{"hour-zero-pm", "Go accepts hour 0 in a 12-hour layout; PM adds 12", "", "05/Jun/2026 00:30 PM"},
		{"hour-zero-am", "and AM leaves it", "", "05/Jun/2026 00:30 AM"},
		{"hour-13-pm", "out of range for a 12-hour layout; layout 3 parses the first token", "", "05/Jun/2026 13:25 PM"},
		{"single-digit-fields", "numeric fields need exactly two digits", "", "5-6-2026"},
		{"two-digit-year", "a two-digit year is not a year", "", "05-06-26"},
		{"impossible-day", "calendar ranges are checked; this is not 2 March", "", "31-02-2026"},
		{"leap-day-valid", "2024 is a leap year", "", "29-02-2024"},
		{"leap-day-invalid", "2026 is not", "", "29-02-2026"},
		{"day-zero", "day 0 does not exist", "", "00-06-2026"},
		{"month-thirteen", "month 13 does not exist", "", "05-13-2026"},
		{"trailing-text", "trailing text is an error, which is why the first-token attempt exists", "", "05-06-2026extra"},
		{"first-token-fallback", "v1's strings.Fields(s)[0], expressed as a layout attempt", "", "05/Jun/2026 garbage"},
		{"surrounded-by-spaces", "trimmed with the executor's own cutset before parsing", "", "  05/Jun/2026  "},
		{"surrounded-by-tab-and-cr", "\\t and \\r are in the cutset", "", "\t05-06-2026\r"},
		{"surrounded-by-nbsp", "U+00A0 is NOT in the cutset; JavaScript's trim() would remove it", "", " 05-06-2026 "},
		{"surrounded-by-bom", "U+FEFF is NOT in the cutset; JavaScript's trim() would remove it", "", "\ufeff05-06-2026"},
		{"empty", "no date; the template still matches because date is not required", "", ""},
		{"iso-8601", "a shape neither layout covers, and one Date.parse would happily accept", "", "2026-06-05T00:00:00Z"},
		{"us-order", "06-05-2026 is 6 May under DD-MM-YYYY, not 5 June", "", "06-05-2026"},
		{"tab-separated-first-token", "the fallback splits on U+0020 only, so a tab is not a separator", "", "05/Jun/2026\tgarbage"},
	}
	g := syntheticGroup{file: "synthetic-dates.json", template: "synth.dates", definition: def}
	for _, c := range texts {
		g.cases = append(g.cases, syntheticCase{
			name: c.name, why: c.why, subject: "",
			body: "Amt: 1.00\nDate: " + c.body,
		})
	}
	return g
}

// amounts: rule 5, including the two int64 boundaries and the trim set.
func syntheticAmounts() syntheticGroup {
	def := `{
	  "id":"synth.amounts","version":1,"bank":"t","normalizer_version":1,
	  "match":{"sender_domain":["example.com"]},
	  "default_currency":"AED","date_from":"email",
	  "extract":[
	    {"field":"amount","type":"amount","source":"body","flags":["i"],
	     "patterns":["Amt: (?P<ccy>[a-z]{3} )?(?P<amt>[^\\n]+)"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"}
	  ],
	  "required":["amount","direction"]}`
	texts := []syntheticCase{
		{"plain", "the ordinary case", "", "250.00"},
		{"grouped", "commas are removed before the shape check", "", "1,250.75"},
		{"zero", "0.00 is a VALUE; Currency is what says an amount was extracted", "", "0.00"},
		{"many-commas", "comma placement is not validated, only removed", "", "1,2,3.00"},
		{"leading-comma-removed", "a leading comma leaves a valid shape", "", ",250.00"},
		{"no-decimals", "the shape needs exactly two", "", "250"},
		{"one-decimal", "one is not two", "", "250.0"},
		{"three-decimals", "three is not two", "", "250.000"},
		{"negative", "amounts are positive; direction carries the sign", "", "-250.00"},
		{"plus-signed", "a sign of either kind fails the shape", "", "+250.00"},
		{"int64-max", "92233720368547758.07 is exactly 2^63-1 minor units", "", "92233720368547758.07"},
		{"int64-overflow", "one fils more does not fit an int64, and is not an amount", "", "92233720368547758.08"},
		{"huge", "far past any integer a double could hold exactly", "", "999999999999999999999.99"},
		{"spaces-around", "trimmed with the executor's own cutset", "", "  250.00  "},
		{"vertical-tab-around", "U+000B is in the cutset in both languages", "", "\v250.00\v"},
		{"nbsp-around", "U+00A0 is NOT; JavaScript's trim() would remove it and change the answer", "", " 250.00"},
		{"bom-around", "U+FEFF is NOT either", "", "\ufeff250.00"},
		{"currency-uppercase", "the ccy group, upper case", "", "USD 99.99"},
		{"currency-lowercase", `flags ["i"] lets it match; asciiUpper normalizes it`, "", "usd 99.99"},
		{"currency-mixed", "mixed case folds to upper", "", "Usd 99.99"},
		{"arabic-indic-digits", "U+0660-U+0669 are digits to Unicode and not to this executor", "", "٢٥٠.٠٠"},
		{"empty-capture", "the group matched nothing; the entry falls through", "", ""},
	}
	g := syntheticGroup{file: "synthetic-amounts.json", template: "synth.amounts", definition: def}
	for _, c := range texts {
		g.cases = append(g.cases, syntheticCase{name: c.name, why: c.why, body: "Amt: " + c.body})
	}
	return g
}

// currency: rule 5's ccy group and the ASCII-ONLY upper-casing.
//
// The load-bearing case is dotless-i. Go's asciiUpper leaves U+0131 alone and
// the result fails the three-upper-case-letters check, so the amount does not
// convert. JavaScript's toUpperCase maps "ıed" to "IED", which passes — a
// mirror that reached for the built-in would extract an amount in a currency
// that was never written, and nothing would error. The class is [^ \n]{3} and
// the entry carries no flags on purpose: this case is about the CONVERSION, and
// a case-insensitive class would drag Go's and JavaScript's differing fold
// orbits for U+0131 into it as well.
func syntheticCurrency() syntheticGroup {
	def := `{
	  "id":"synth.currency","version":1,"bank":"t","normalizer_version":1,
	  "match":{"sender_domain":["example.com"]},
	  "default_currency":"AED","date_from":"email",
	  "extract":[
	    {"field":"amount","type":"amount","source":"body",
	     "patterns":["Amt: (?P<ccy>[^ \\n]{3} )?(?P<amt>[^\\n]+)"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"}
	  ],
	  "required":["amount","direction"]}`
	rows := []syntheticCase{
		{"absent", "the group does not participate; default_currency applies", "", "Amt: 5.00"},
		{"upper", "already upper case", "", "Amt: AED 5.00"},
		{"lower", "a-z folds to A-Z", "", "Amt: aed 5.00"},
		{"mixed", "and mixed", "", "Amt: Aed 5.00"},
		{"dotless-i", "U+0131 upper-cases to \"I\" in JavaScript and NOT in Go; Go refuses the amount", "", "Amt: \u0131ed 5.00"},
		{"sharp-s", "U+00DF upper-cases to \"SS\", which is four letters and fails either way", "", "Amt: \u00dfed 5.00"},
		{"micro-sign", "U+00B5 upper-cases to Greek capital Mu in JavaScript, which is not [A-Z]", "", "Amt: \u00b5ed 5.00"},
		{"turkish-dotted-capital", "U+0130 is already upper case and is still not [A-Z]", "", "Amt: \u0130ED 5.00"},
		{"digit-in-code", "a currency code is three LETTERS", "", "Amt: AE1 5.00"},
		{"four-letters", "the group needs exactly three plus a space, so it does not participate", "", "Amt: AEDX 5.00"},
	}
	return syntheticGroup{file: "synthetic-currency.json", template: "synth.currency", definition: def, cases: rows}
}

// fallthrough: rule 3, which says a CONVERSION FAILURE moves to the next
// pattern and then to the next entry, and never writes a zero value.
//
// The distinction only becomes visible when something later would have
// succeeded: an executor that treats an empty capture as a merchant and one
// that falls through both leave the field empty when there is nothing else to
// try, so a fixture without a second pattern cannot tell them apart.
func syntheticFallthrough() syntheticGroup {
	def := `{
	  "id":"synth.fallthrough","version":1,"bank":"t","normalizer_version":1,
	  "match":{"sender_domain":["example.com"]},
	  "default_currency":"AED","date_from":"email",
	  "extract":[
	    {"field":"amount","type":"amount","source":"body",
	     "patterns":["Amt: (?P<amt>[^\\n]*)","Total: (?P<amt>[^\\n]+)"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"},
	    {"field":"merchant","type":"text","source":"body",
	     "patterns":["To: (?P<v>[^\\n]*)","Payee: (?P<v>[^\\n]+)"]},
	    {"field":"merchant","type":"text","source":"body","patterns":["Vendor: (?P<v>[^\\n]+)"]},
	    {"field":"last4","type":"last4","source":"body",
	     "patterns":["Card: (?P<v>[^\\n]*)","Acct: (?P<v>[^\\n]+)"]}
	  ],
	  "required":["amount","direction"]}`
	rows := []syntheticCase{
		{"nothing-to-fall-back-to", "the first pattern wins outright", "", "Amt: 10.00\nTo: SHOP\nCard: 1234\n"},
		{"merchant-pattern-fallthrough", "an EMPTY capture is a conversion failure, so the second pattern of the SAME entry runs", "",
			"Amt: 10.00\nTo: \nPayee: CARREFOUR\nCard: 1234\n"},
		{"merchant-entry-fallthrough", "both patterns of the first entry fail, so the second ENTRY for the field runs", "",
			"Amt: 10.00\nTo: \nVendor: SHOP\nCard: 1234\n"},
		{"merchant-whitespace-only-fallthrough", "trimmed to empty is still empty", "",
			"Amt: 10.00\nTo:    \nPayee: CARREFOUR\nCard: 1234\n"},
		{"amount-pattern-fallthrough", "a capture that fails the shape check falls through rather than becoming 0", "",
			"Amt: \nTotal: 10.00\nTo: SHOP\nCard: 1234\n"},
		{"amount-bad-shape-fallthrough", "and so does one that is not a number at all", "",
			"Amt: N/A\nTotal: 10.00\nTo: SHOP\nCard: 1234\n"},
		{"last4-pattern-fallthrough", "no digits is a conversion failure, not an empty last4", "",
			"Amt: 10.00\nTo: SHOP\nCard: \nAcct: 9999\n"},
		{"first-entry-still-wins-when-it-succeeds", "the second merchant entry must NOT run", "",
			"Amt: 10.00\nTo: FIRST\nVendor: SECOND\nCard: 1234\n"},
		{"everything-falls-through", "nothing produced, and the empty groups say which", "",
			"Amt: \nTo: \nCard: \n"},
	}
	return syntheticGroup{file: "synthetic-fallthrough.json", template: "synth.fallthrough", definition: def, cases: rows}
}

// last4 and merchant text: rules 3 and 7, plus the capture bound.
func syntheticTextAndLast4() syntheticGroup {
	def := `{
	  "id":"synth.text","version":1,"bank":"t","normalizer_version":1,
	  "match":{"sender_domain":["example.com"]},
	  "default_currency":"AED","date_from":"email",
	  "extract":[
	    {"field":"amount","type":"amount","source":"body","patterns":["Amt: (?P<amt>[^\\n]+)"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"},
	    {"field":"merchant","type":"text","source":"body","patterns":["To: (?P<v>[^\\n]*)"]},
	    {"field":"last4","type":"last4","source":"body","patterns":["Card: (?P<v>[^\\n]*)"]}
	  ],
	  "required":["amount","direction"]}`
	rows := []struct{ name, why, merchant, card string }{
		{"ordinary", "the happy path", "CARREFOUR DUBAI", "XXXX1234"},
		{"card-all-digits", "the LAST four, not the first", "SHOP", "1234567890"},
		{"card-two-digits", "fewer than four is still a value", "SHOP", "12"},
		{"card-one-digit", "one digit is the minimum", "SHOP", "7"},
		{"card-no-digits", "no digits is a conversion failure, not an empty last4", "SHOP", "ABCD"},
		{"card-separated", "non-digits are dropped wherever they are", "SHOP", "1-2-3-4-5"},
		{"card-arabic-indic", "Arabic-Indic digits are not ASCII digits", "SHOP", "١٢٣٤"},
		{"card-empty", "the group participated and captured nothing", "SHOP", ""},
		{"merchant-empty", "an empty capture is not a merchant; the field stays unset", "", "XXXX1234"},
		{"merchant-spaces-only", "trimmed to empty, so still not a merchant", "   ", "XXXX1234"},
		{"merchant-cr-inside", `[^\n] includes \r in BOTH engines, which a bare . does not`, "CARREFOUR\rDUBAI", "XXXX1234"},
		{"merchant-nbsp-around", "U+00A0 is not trimmed, so it stays in the merchant", " CARREFOUR ", "XXXX1234"},
		{"merchant-arabic", "the corpus is Arabic; rune counting must not be byte counting", "بقالة الاتحاد", "XXXX1234"},
		{"merchant-512-runes", "exactly at MaxCaptureRunes, in 2-byte runes", repeatRune('م', MaxCaptureRunes), "XXXX1234"},
		{"merchant-513-runes", "one rune over: a conversion failure, not a truncated merchant", repeatRune('م', MaxCaptureRunes+1), "XXXX1234"},
		{"merchant-emoji", "astral runes count as ONE, which is why [...s].length is the mirror of RuneCountInString", "🏪 SHOP", "XXXX1234"},
		{"merchant-300-astral-runes", "300 runes and 600 UTF-16 units: a mirror counting s.length would refuse a merchant Go keeps",
			repeatRune('🏪', 300), "XXXX1234"},
		{"merchant-513-astral-runes", "513 runes is over the bound in BOTH counts; the pair above and below is what makes the unit unambiguous",
			repeatRune('🏪', MaxCaptureRunes+1), "XXXX1234"},
	}
	g := syntheticGroup{file: "synthetic-text-last4.json", template: "synth.text", definition: def}
	for _, r := range rows {
		g.cases = append(g.cases, syntheticCase{
			name: r.name, why: r.why,
			body: "Amt: 10.00\nTo: " + r.merchant + "\nCard: " + r.card + "\n",
		})
	}
	return g
}

// empty capture groups: the diagnostic the corpus never exercises.
func syntheticEmptyGroups() syntheticGroup {
	def := `{
	  "id":"synth.groups","version":1,"bank":"t","normalizer_version":1,
	  "match":{"sender_domain":["example.com"]},
	  "default_currency":"AED","date_from":"email",
	  "extract":[
	    {"field":"amount","type":"amount","source":"body",
	     "patterns":["Amt: (?P<ccy>[A-Z]{3} )?(?P<amt>[^\\n]*)"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"},
	    {"field":"merchant","type":"text","source":"body","patterns":["To: (?P<v>[^\\n]*)"]},
	    {"field":"last4","type":"last4","source":"body","patterns":["Card: (?P<v>[^\\n]*)"]}
	  ],
	  "required":["amount","direction"]}`
	rows := []syntheticCase{
		{"none-empty", "nothing to report", "", "Amt: AED 10.00\nTo: SHOP\nCard: 1234\n"},
		{"ccy-absent-is-not-empty", "an optional group that did not PARTICIPATE has index -1 and is not an empty group", "",
			"Amt: 10.00\nTo: SHOP\nCard: 1234\n"},
		{"merchant-empty", "one label", "", "Amt: AED 10.00\nTo: \nCard: 1234\n"},
		{"two-empty", "sorted and deduplicated, and qualified by FIELD so last4_v and merchant_v are distinguishable", "",
			"Amt: AED 10.00\nTo: \nCard: \n"},
		{"three-empty", "the amount group too; amt_ and v_ collide without the field qualifier", "",
			"Amt: \nTo: \nCard: \n"},
		{"empty-survives-a-failed-match", "EmptyGroups is meaningful on the error path; that is what diag stores", "",
			"To: \nCard: \n"},
	}
	g := syntheticGroup{file: "synthetic-empty-groups.json", template: "synth.groups", definition: def}
	g.cases = rows
	return g
}

// The DIB cascade: override, on_match, the unconditional const default, and
// the two gates that separate the two DIB layouts. Uses the PUBLISHED seeds.
func syntheticDIB(t *testing.T) []syntheticGroup {
	t.Helper()
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	const card = "إشعار مشتريات\nالمبلغ\nAED 250.00\nبتاريخ 05-06-2026\n" +
		"الدفع الى\nCARREFOUR DUBAI\nرقم البطاقة\nXXXX1234"
	return []syntheticGroup{
		{
			file: "synthetic-dib-card.json", template: "dib.card.v1", definition: read("dib.card.v1.json"),
			cases: []syntheticCase{
				{"purchase", "the shape 364 corpus cases have, stated once explicitly", "", card},
				{"merchant-with-cr", `[^\n] must keep \r in both engines`, "",
					"إشعار مشتريات\nالمبلغ\nAED 250.00\nبتاريخ 05-06-2026\nالدفع الى\nCARREFOUR\rDUBAI\nرقم البطاقة\nXXXX1234"},
				{"empty-merchant-line", "the merchant group participates and captures nothing", "",
					"إشعار مشتريات\nالمبلغ\nAED 250.00\nبتاريخ 05-06-2026\nالدفع الى\n\nرقم البطاقة\nXXXX1234"},
				{"gated-out", "body_contains excludes the account layout", "",
					"إشعار إيداع\nالمبلغ\nAED 1.00\nبتاريخ 05-06-2026"},
				{"no-date", "date is required; this is what a bank format change looks like", "",
					"إشعار مشتريات\nالمبلغ\nAED 250.00\nالدفع الى\nSHOP\nرقم البطاقة\nXXXX1234"},
				{"foreign-currency", "the ccy group carries a non-default currency", "",
					"إشعار مشتريات\nالمبلغ\nUSD 25.00\nبتاريخ 05-06-2026\nالدفع الى\nSHOP\nرقم البطاقة\nXXXX1234"},
				{"amount-longer-than-the-bound", "same bound as ENBD, but here the mandatory Arabic anchor means the " +
					"engine cannot start mid-number, so bounded and unbounded reach the same answer by different routes", "",
					"إشعار مشتريات\nالمبلغ\nAED 1,234,567,890,123,456,789,012,345.67\nبتاريخ 05-06-2026\nالدفع الى\nSHOP\nرقم البطاقة\nXXXX1234"},
			},
		},
		{
			file: "synthetic-dib-account.json", template: "dib.account.v1", definition: read("dib.account.v1.json"),
			cases: []syntheticCase{
				{"deposit-whose-description-says-debit",
					"the override entry: v1 dib.go:79-83 re-derives direction AFTER the four-way cascade", "",
					"إشعار إيداع\nالمبلغ\nAED 1,250.75\nبتاريخ 05-06-2026\nالمعاملة\nSALARY TRNSFER DEBIT\nمن حساب\n0123456789"},
				{"deposit-plain", "without the DEBIT suffix the cascade's credit survives", "",
					"إشعار إيداع\nالمبلغ\nAED 1,250.75\nبتاريخ 05-06-2026\nالمعاملة\nSALARY TRNSFER\nمن حساب\n0123456789"},
				{"withdrawal", "the second cascade entry, two patterns in one entry", "",
					"إشعار سحب\nالمبلغ\nAED 100.00\nبتاريخ 05-06-2026\nالمعاملة\nATM\nمن حساب\n0123456789"},
				{"debit-notice", "the first of that entry's two patterns", "",
					"إشعار خصم\nالمبلغ\nAED 100.00\nبتاريخ 05-06-2026\nالمعاملة\nFEE\nمن حساب\n0123456789"},
				{"from-the-account", "the third cascade entry", "",
					"من الحساب\nالمبلغ\nAED 100.00\nبتاريخ 05-06-2026\nالمعاملة\nX\nمن حساب\n0123456789"},
				{"unconditional-default", "no cascade pattern matches: the pattern-less const entry is the default", "",
					"المبلغ\nAED 100.00\nبتاريخ 05-06-2026\nالمعاملة\nX\nمن حساب\n0123456789"},
				{"transfer-flag", "is_transfer, and its i flag", "",
					"إشعار إيداع\nالمبلغ\nAED 1.00\nبتاريخ 05-06-2026\nالمعاملة\nsalary transfer\nمن حساب\n0123456789"},
				{"transfer-flag-misspelling", "v1 anchors on TRNSFER as well; the bank writes both", "",
					"إشعار إيداع\nالمبلغ\nAED 1.00\nبتاريخ 05-06-2026\nالمعاملة\nTRNSFER IN\nمن حساب\n0123456789"},
				{"gated-out", "body_not_contains excludes the card layout", "", card},
			},
		},
	}
}

func repeatRune(r rune, n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = r
	}
	return string(out)
}

func syntheticGroups(t *testing.T) []syntheticGroup {
	t.Helper()
	out := []syntheticGroup{
		syntheticENBD(t),
		syntheticDates(),
		syntheticAmounts(),
		syntheticTextAndLast4(),
		syntheticEmptyGroups(),
		syntheticCurrency(),
		syntheticFallthrough(),
	}
	return append(out, syntheticDIB(t)...)
}

func buildSyntheticFixture(t *testing.T, g syntheticGroup) ([]byte, templateFixture) {
	t.Helper()
	d, err := ParseDefinition([]byte(g.definition))
	if err != nil {
		t.Fatalf("%s: %v", g.file, err)
	}
	// A synthetic definition must be one the store would really accept.
	// Otherwise the fixture pins behaviour on a template that could never be
	// published, which is a fact about nothing.
	if err := ValidateForPublish(d); err != nil {
		t.Fatalf("%s: definition is not publishable: %v", g.file, err)
	}
	if d.ID != g.template {
		t.Fatalf("%s: definition id %q, group says %q", g.file, d.ID, g.template)
	}
	var compactBuf bytes.Buffer
	if err := json.Compact(&compactBuf, []byte(g.definition)); err != nil {
		t.Fatal(err)
	}
	f := templateFixture{
		Note: "Written by internal/v2/tmpl TestWriteSyntheticTemplateFixtures. Regenerate with " +
			"LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/tmpl/ -run TestWriteSyntheticTemplateFixtures " +
			"(no corpus needed); do not hand-edit. These are the input classes the real corpus contains NONE " +
			"of — the ENBD alert format, empty capture groups, and malformed conversions. `expect` is LITERAL " +
			"Go executor output: if a case's name says one thing and Go does another, the fixture records what " +
			"Go does and the TypeScript executor must reproduce THAT.",
		Spec:              "docs/superpowers/specs/v2-template-format.md",
		SchemaVersion:     1,
		Template:          d.ID,
		Kind:              "synthetic",
		NormalizerVersion: d.NormalizerVersion,
		Definition:        compactBuf.Bytes(),
		Cases:             []templateCase{},
	}
	c, err := Compile(d)
	if err != nil {
		t.Fatalf("%s: %v", g.file, err)
	}
	seen := map[string]bool{}
	for _, sc := range g.cases {
		if seen[sc.name] {
			t.Fatalf("%s: duplicate case name %q", g.file, sc.name)
		}
		seen[sc.name] = true
		e, execErr := c.Execute(sc.subject, sc.body)
		f.Cases = append(f.Cases, templateCase{
			Name:                 fmt.Sprintf("%s/%s", d.ID, sc.name),
			Source:               "SYNTHETIC: " + sc.why,
			SubjectBase64:        base64.StdEncoding.EncodeToString([]byte(sc.subject)),
			NormalizedBodyBase64: base64.StdEncoding.EncodeToString([]byte(sc.body)),
			Expect:               expectOf(e, execErr),
		})
	}
	b, err := encodeTemplateFixture(f)
	if err != nil {
		t.Fatal(err)
	}
	return b, f
}

// TestWriteSyntheticTemplateFixtures regenerates the synthetic half. It needs
// no corpus, so any checkout can reproduce it:
//
//	LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/tmpl/ -run TestWriteSyntheticTemplateFixtures -v
func TestWriteSyntheticTemplateFixtures(t *testing.T) {
	if os.Getenv(writeFixturesEnv) == "" {
		t.Skipf("%s is unset; fixtures are committed and regenerated deliberately", writeFixturesEnv)
	}
	if err := os.MkdirAll(templateConformanceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, g := range syntheticGroups(t) {
		b, f := buildSyntheticFixture(t, g)
		if err := os.WriteFile(filepath.Join(templateConformanceDir, g.file), b, 0o644); err != nil {
			t.Fatal(err)
		}
		matched := 0
		for _, c := range f.Cases {
			if c.Expect.Matched {
				matched++
			}
		}
		t.Logf("%s: %d cases, %d matched, %d bytes", g.file, len(f.Cases), matched, len(b))
	}
}

// TestSyntheticFixturesAreWhatThisBuildProduces is the staleness guard for the
// synthetic half. Unlike the corpus half's guard it regenerates from the case
// TABLE rather than from the committed inputs, so it also catches a case that
// was added to the table and never written to disk.
func TestSyntheticFixturesAreWhatThisBuildProduces(t *testing.T) {
	for _, g := range syntheticGroups(t) {
		want, _ := buildSyntheticFixture(t, g)
		got, err := os.ReadFile(filepath.Join(templateConformanceDir, g.file))
		if err != nil {
			t.Fatalf("%v; regenerate with %s=1 go test ./internal/v2/tmpl/ -run TestWriteSyntheticTemplateFixtures",
				err, writeFixturesEnv)
		}
		if string(got) != string(want) {
			t.Errorf("conformance/templates/%s is stale: this build produces different bytes. Regenerate with\n"+
				"  %s=1 go test ./internal/v2/tmpl/ -run TestWriteSyntheticTemplateFixtures", g.file, writeFixturesEnv)
		}
	}
}
