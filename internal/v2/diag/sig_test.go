package diag

import (
	"regexp"
	"strings"
	"testing"
	"unicode"
)

// The brief's own test, verbatim in intent: two real-shaped bank emails with
// different amounts, different merchants and a different WORD COUNT in the
// merchant must share a signature; a different layout must not.
func TestStructureSigIsContentFreeButLayoutSensitive(t *testing.T) {
	a := StructureSig("المبلغ\nAED 250.00\nالدفع الى\nCARREFOUR")
	b := StructureSig("المبلغ\nAED 9,912.45\nالدفع الى\nSPINNEYS ABU DHABI")
	c := StructureSig("Debit Amount:\nAED 250.00")
	if a != b {
		t.Fatalf("same layout, different values must share a signature: %s vs %s", a, b)
	}
	if a == c {
		t.Fatalf("different layouts must differ, both were %s", a)
	}
}

func TestStructureSigIsAThirtyTwoCharLowerHexDigest(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{32}$`)
	for _, in := range []string{"", "AED 250.00", strings.Repeat("مرحبا ", 5000)} {
		if got := StructureSig(in); !re.MatchString(got) {
			t.Fatalf("StructureSig(%.20q) = %q, want 32 lower-case hex chars", in, got)
		}
	}
}

// The single most important property in this file: the intermediate the digest
// is taken over must itself carry no letter and no digit from the input. If
// shape leaked so much as a merchant substring, the digest would be a
// searchable commitment to content rather than to layout.
func TestShapeRetainsNoLetterOrDigitFromTheInput(t *testing.T) {
	in := "Dear SALEH,\nAED 1,234.56 was spent at CARREFOUR MALL OF THE EMIRATES\n" +
		"البطاقة المنتهية بـ ٤٥٦٧\nБАНК Москва 中国银行 ½"
	got := shape(in)
	for _, r := range got {
		switch r {
		case '0', 'A', 'B', 'C':
			continue // the four content-free class symbols
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsNumber(r) {
			t.Fatalf("shape leaked a letter/digit %q from the input; shape = %q", r, got)
		}
	}
	for _, secret := range []string{"SALEH", "CARREFOUR", "1,234.56", "234", "Москва", "中国银行"} {
		if strings.Contains(got, secret) {
			t.Fatalf("shape contains %q from the input: %q", secret, got)
		}
	}
}

// Word count is a content signal (a merchant's name length), and thousands
// separators are a formatting artefact of the amount. Neither may move the
// signature.
func TestStructureSigCollapsesWordCountAndThousandsSeparators(t *testing.T) {
	if StructureSig("CARREFOUR") != StructureSig("SPINNEYS ABU DHABI MALL") {
		t.Fatal("word count must not change the signature")
	}
	if StructureSig("AED 250.00") != StructureSig("AED 1,234,567.89") {
		t.Fatal("thousands separators must not change the signature")
	}
	if StructureSig("٤٥٦") != StructureSig("456") {
		t.Fatal("Arabic-Indic and ASCII digits are the same class")
	}
}

// Layout sensitivity, stated as the mutations a template author would care
// about: a moved label, a new line, changed punctuation, a changed script.
func TestStructureSigDistinguishesDifferentLayouts(t *testing.T) {
	base := "Amount:\nAED 250.00\nMerchant:\nCARREFOUR"
	mutants := map[string]string{
		"extra line":         "Amount:\nAED 250.00\n\nMerchant:\nCARREFOUR",
		"dropped colon":      "Amount\nAED 250.00\nMerchant:\nCARREFOUR",
		"reordered fields":   "Merchant:\nCARREFOUR\nAmount:\nAED 250.00",
		"amount before word": "Amount:\n250.00 AED\nMerchant:\nCARREFOUR",
		"arabic label":       "المبلغ:\nAED 250.00\nMerchant:\nCARREFOUR",
		"joined lines":       "Amount: AED 250.00 Merchant: CARREFOUR",
	}
	want := StructureSig(base)
	for name, m := range mutants {
		if StructureSig(m) == want {
			t.Errorf("%s: layout change did not move the signature", name)
		}
	}
}

// Scripts the classifier does not name explicitly must still be classed, not
// passed through as "punctuation". Otherwise a Cyrillic or CJK merchant name
// would survive verbatim into the hashed string.
func TestNonASCIINonArabicScriptsCollapseToOneClass(t *testing.T) {
	if StructureSig("Москва") != StructureSig("中国银行") {
		t.Fatal("other scripts must share the single 'other letter' class")
	}
	if StructureSig("Москва") == StructureSig("MOSCOW") {
		t.Fatal("the other-letter class must be distinct from the ASCII class")
	}
}

// Combining marks and bidi/format controls are invisible content decorations,
// not layout. Arabic mail is full of RLM/LRM; if they survived, the same
// template would fingerprint differently depending on the sender's mailer.
func TestMarksAndFormatControlsDoNotMoveTheSignature(t *testing.T) {
	if StructureSig("مَرْحَبًا") != StructureSig("مرحبا") {
		t.Fatal("Arabic harakat must not move the signature")
	}
	if StructureSig("‏AED 250.00‎") != StructureSig("AED 250.00") {
		t.Fatal("bidi format controls must not move the signature")
	}
}

func TestStructureSigIsStableAcrossLineEndingsAndPadding(t *testing.T) {
	want := StructureSig("Amount:\nAED 250.00")
	for name, in := range map[string]string{
		"crlf":            "Amount:\r\nAED 250.00",
		"cr":              "Amount:\rAED 250.00",
		"trailing spaces": "Amount:  \nAED   250.00   ",
		"leading blank":   "\n  Amount:\nAED 250.00",
		"tabs":            "Amount:\n\tAED\t250.00",
	} {
		if got := StructureSig(in); got != want {
			t.Errorf("%s: %s != %s", name, got, want)
		}
	}
}

// The digest is taken over the first 4 KB of the SHAPE, which bounds both the
// work and how much of a hostile body can influence the fingerprint.
func TestStructureSigDigestsOnlyTheFirstFourKilobytesOfTheShape(t *testing.T) {
	prefix := strings.Repeat("Amount: 250.00\n", 2000) // shape is well past 4 KB
	if StructureSig(prefix+"TAIL") != StructureSig(prefix+"!!!DIFFERENT!!!") {
		t.Fatal("content past the 4 KB shape limit must not reach the digest")
	}
	// ...and the limit is not so aggressive that short mail is truncated.
	if StructureSig("Amount:\nAED 250.00") == StructureSig("Amount:\nAED 250.00\nExtra:\nX") {
		t.Fatal("short bodies must not be truncated to a common prefix")
	}
}

func TestShapeTruncationStaysOnARuneBoundary(t *testing.T) {
	// Multi-byte punctuation is kept verbatim by shape, so the 4 KB cut can
	// land mid-rune unless it backs off.
	in := strings.Repeat("…", 4000)
	if got := shape(in); !isValidUTF8(got) {
		t.Fatal("shape truncation split a rune")
	}
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}
