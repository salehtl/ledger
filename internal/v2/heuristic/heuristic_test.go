package heuristic

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/tmpl"
)

// ---------------------------------------------------------------------------
// The rule: a heuristic result is NEVER trusted
// ---------------------------------------------------------------------------

func TestHeuristicResultsAreAlwaysNeedsReview(t *testing.T) {
	for _, body := range []string{
		"AED 250.00 debited",
		"USD 10.00 credited to your account",
		"Total: 1,234.56",
	} {
		r, err := Parse(body)
		if err != nil {
			t.Fatal(err)
		}
		if !r.NeedsReview() {
			t.Fatalf("spec §3.2 requires every heuristic result to be needs_review: %q", body)
		}
		if r.Tier() != TierHeuristic {
			t.Fatalf("tier = %q, want %q", r.Tier(), TierHeuristic)
		}
	}
}

func TestNoConstructionOfAHeuristicResultCanBeTrusted(t *testing.T) {
	// The rule is a property of the TYPE, not of a code path, and this is the
	// test that says so. NeedsReview is a method returning a constant, so there
	// is no value of Result — however built, by this package or any other —
	// that reports anything else. If someone converts it back into a field, or
	// adds a second field a caller could use to override it, this fails.
	rt := reflect.TypeOf(Result{})

	if rt.NumField() != 1 || rt.Field(0).Name != "Extraction" {
		t.Fatalf("Result has fields %v; it must carry exactly the embedded tmpl.Extraction. "+
			"A settable field is a way to construct a TRUSTED heuristic result, which spec §3.2 forbids",
			fieldNames(rt))
	}
	for _, name := range []string{"NeedsReview", "Tier"} {
		if _, ok := rt.FieldByName(name); ok {
			t.Fatalf("%s is a FIELD on Result: anything that can be set can be set to the wrong value", name)
		}
		m, ok := rt.MethodByName(name)
		if !ok {
			t.Fatalf("%s must be a method on the VALUE type, so a copy cannot dodge it", name)
		}
		if m.Type.NumIn() != 1 || m.Type.NumOut() != 1 {
			t.Fatalf("%s has signature %s; it must take nothing and return one value", name, m.Type)
		}
	}

	// Every way of getting hold of a Result, including the ones that never went
	// through Parse.
	parsed, err := Parse("AED 250.00 at CARREFOUR on 03-02-2025")
	if err != nil {
		t.Fatal(err)
	}
	failed, _ := Parse("nothing here")
	copied := parsed
	viaReflect := reflect.New(rt).Elem().Interface().(Result)
	viaLiteral := Result{Extraction: tmpl.Extraction{AmountMinor: 1, Currency: "AED", Matched: true}}
	for name, r := range map[string]Result{
		"zero value":     {},
		"from Parse":     parsed,
		"from a failure": failed,
		"copied":         copied,
		"reflect.New":    viaReflect,
		"literal":        viaLiteral,
	} {
		if !r.NeedsReview() {
			t.Errorf("%s: NeedsReview() is false; no path may produce a trusted heuristic result", name)
		}
		if r.Tier() != TierHeuristic {
			t.Errorf("%s: Tier() = %q", name, r.Tier())
		}
	}
}

func TestTierNameIsTheOneTheDiagnosticsEnumStores(t *testing.T) {
	// diag is imported by the TEST only: the heuristic must not depend on the
	// diagnostics store. This is the assertion that keeps the two strings equal
	// without the dependency.
	if TierHeuristic != diag.TierHeuristic {
		t.Fatalf("TierHeuristic = %q but diag.TierHeuristic = %q; a tier the diagnostics row rejects makes the row unstorable",
			TierHeuristic, diag.TierHeuristic)
	}
}

// ---------------------------------------------------------------------------
// The port itself
// ---------------------------------------------------------------------------

func TestHeuristicFindsAmountDirectionDateMerchant(t *testing.T) {
	// Ported from v1's TestHeuristicExtractsAmountAndDate.
	r, err := Parse("Your card was charged AED 49.90 on 03-02-2025 at STARBUCKS DUBAI.")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if r.AmountMinor != 4990 {
		t.Errorf("amount = %d, want 4990", r.AmountMinor)
	}
	if r.Currency != "AED" {
		t.Errorf("currency = %q, want AED", r.Currency)
	}
	if r.Direction != "debit" {
		t.Errorf("direction = %q, want debit", r.Direction)
	}
	want := time.Date(2025, 2, 3, 0, 0, 0, 0, time.UTC)
	if !r.PostedAt.Equal(want) {
		t.Errorf("posted_at = %s, want %s", r.PostedAt, want)
	}
	// With the trailing full stop: v1's merchant class contains '.', so the
	// sentence punctuation is part of the merchant. Asserted rather than
	// papered over with a "contains" check — it is the port's real behaviour,
	// and one more reason the tier is never trusted.
	if r.Merchant != "STARBUCKS DUBAI." {
		t.Errorf("merchant = %q, want STARBUCKS DUBAI.", r.Merchant)
	}
	if !r.Matched {
		t.Error("Matched must be true when Parse returns no error")
	}
	for _, f := range []string{tmpl.FieldAmount, tmpl.FieldDate, tmpl.FieldMerchant, tmpl.FieldDirection} {
		if !r.Produced(f) {
			t.Errorf("Produced(%q) = false", f)
		}
	}
}

func TestCreditWordsFlipTheDirection(t *testing.T) {
	// Ported from v1's TestHeuristicCreditKeyword, plus the whole word list,
	// because "credited" passing says nothing about "refund".
	for _, body := range []string{
		"AED 500.00 credited to your account on 01-01-2025",
		"AED 500.00 credit",
		"AED 500.00 deposited",
		"AED 500.00 deposit",
		"AED 500.00 received",
		"AED 500.00 refund",
		"AED 500.00 REFUND", // the pattern is case-insensitive
	} {
		r, err := Parse(body)
		if err != nil {
			t.Fatalf("%q: %v", body, err)
		}
		if r.Direction != "credit" {
			t.Errorf("%q: direction = %q, want credit", body, r.Direction)
		}
	}
	// And the word must be a whole word: "creditor" is not a credit.
	r, err := Parse("AED 500.00 paid to CREDITORS LLC")
	if err != nil {
		t.Fatal(err)
	}
	if r.Direction != "debit" {
		t.Errorf("direction = %q, want debit: 'creditors' is not the word 'credit'", r.Direction)
	}
}

func TestHeuristicErrorsWhenNoAmountIsPresent(t *testing.T) {
	// Nothing to record. The pipeline turns this into tier "none" + unparsed,
	// which is still appended — the message is not dropped, it is just not a
	// transaction as far as this tier can tell.
	r, err := Parse("no money, no date, nothing useful")
	if !errors.Is(err, ErrNoAmount) {
		t.Fatalf("err = %v, want ErrNoAmount", err)
	}
	if r.Matched {
		t.Error("Matched must be false when Parse returns an error")
	}
	if r.Currency != "" || r.AmountMinor != 0 {
		t.Errorf("a failed parse must carry no amount: %+v", r.Extraction)
	}
}

func TestMatchedIsTrueExactlyWhenParseSucceeds(t *testing.T) {
	for _, body := range []string{
		"AED 250.00 debited",
		"",
		"no amount at all",
		"AED " + strings.Repeat("9", 100_000) + ".00",
		strings.Repeat("\n", 100),
	} {
		r, err := Parse(body)
		if r.Matched != (err == nil) {
			t.Fatalf("body %.20q: Matched = %v, err = %v", body, r.Matched, err)
		}
	}
}

func TestAmountIsPositiveMinorUnitsAndDirectionCarriesTheSign(t *testing.T) {
	// Money is int64 minor units and always positive; the sign lives in
	// Direction. The pattern captures no sign at all, so "-50.00" is 5000 fils
	// debit rather than a negative amount.
	r, err := Parse("AED -50.00 charged")
	if err != nil {
		t.Fatal(err)
	}
	if r.AmountMinor != 5000 {
		t.Fatalf("amount = %d, want 5000", r.AmountMinor)
	}
	if r.Direction != "debit" {
		t.Fatalf("direction = %q", r.Direction)
	}
}

func TestUnparseableDateIsLeftUnsetRatherThanZeroTimed(t *testing.T) {
	// "32-13-2025" has the shape and is not a date. A zero PostedAt is never
	// presented as an extracted date — Produced("date") is the predicate.
	r, err := Parse("AED 10.00 on 32-13-2025")
	if err != nil {
		t.Fatal(err)
	}
	if !r.PostedAt.IsZero() || r.Produced(tmpl.FieldDate) {
		t.Fatalf("posted_at = %s; an impossible date must not become one", r.PostedAt)
	}
}

// ---------------------------------------------------------------------------
// Why the rule exists
// ---------------------------------------------------------------------------

func TestHeuristicIsUAEShapedAndSaysSo(t *testing.T) {
	// Each of these is a WRONG answer that the tier cannot avoid giving, and
	// together they are the argument for §3.2's needs_review rule. They are
	// asserted rather than described so that a future "improvement" that
	// changes one has to come here and say so.

	// 1. A EUR promotional mail is not a transaction, and parses as one.
	promo, err := Parse("SALE! Flights to Paris from EUR 899.00 — book by 31-12-2025")
	if err != nil {
		t.Fatal(err)
	}
	if promo.AmountMinor != 89900 || promo.Currency != "EUR" {
		t.Fatalf("promo parsed as %d %s", promo.AmountMinor, promo.Currency)
	}
	if !promo.NeedsReview() {
		t.Fatal("...which is exactly why it must be needs_review")
	}

	// 2. A bare number is assumed to be AED. There is no evidence for that in
	//    the body; it is the v1 default, and it is a guess about the user's
	//    country.
	bare, err := Parse("Total: 1,234.56")
	if err != nil {
		t.Fatal(err)
	}
	if bare.Currency != "AED" {
		t.Fatalf("currency = %q, want the AED default", bare.Currency)
	}

	// 3. The FIRST amount-shaped run in the body wins, whatever it is. A
	//    balance line above the amount silently becomes the transaction.
	first, err := Parse("Available balance: AED 12,000.00\nPurchase: AED 35.00")
	if err != nil {
		t.Fatal(err)
	}
	if first.AmountMinor != 1200000 {
		t.Fatalf("amount = %d; the first match wins, and here it is the balance", first.AmountMinor)
	}

	// 4. The date pattern is DD-MM-YYYY only, so a US-shaped date is read
	//    transposed when both halves are <= 12, and dropped otherwise.
	us, err := Parse("AED 10.00 on 04-07-2025")
	if err != nil {
		t.Fatal(err)
	}
	if us.PostedAt.Month() != time.July || us.PostedAt.Day() != 4 {
		t.Fatalf("posted_at = %s; DD-MM-YYYY is assumed, so July 4 in US order reads as 4 July",
			us.PostedAt.Format("2006-01-02"))
	}
}

func TestHeuristicPatternsAreOutsideTheRegexDialectOnPurpose(t *testing.T) {
	// Decision 16. The dialect exists to stop Go/JS divergence and JS
	// catastrophic backtracking; the heuristic is never published, never
	// executed by a client, and runs only in RE2, so neither reason applies and
	// the patterns are kept byte-for-byte from v1 instead of rewritten.
	//
	// This test is the TRIPWIRE for that decision, and it fails in the
	// direction that matters: the day these patterns become dialect-legal,
	// someone has started making them portable, and the conditions in the
	// package doc — enter them into the conformance suite, and drop the
	// client's "skip tier == heuristic" precondition — come due.
	for _, p := range []string{amountPattern, datePattern, creditWordPattern, merchantPattern} {
		errs := tmpl.ValidatePattern(p, nil)
		if len(errs) == 0 {
			t.Fatalf("%q is now dialect-legal. If that was deliberate: add the heuristic to the "+
				"cross-executor conformance suite and lift the Phase 2 client's skip of tier==heuristic, "+
				"then delete this test. If it was not, revert it.", p)
		}
		t.Logf("%q rejected by the dialect: %v", p, tmpl.Codes(errs))
	}
}

// ---------------------------------------------------------------------------
// Attacker-writable input
// ---------------------------------------------------------------------------

func TestParseSurvivesHostileBodies(t *testing.T) {
	// The body is written by whoever learned the user's inbound address. The
	// bar is Task 19's: no hang, no unbounded allocation, no panic — and, since
	// this tier's whole contract is the review flag, no trusted result either.
	bodies := map[string]string{
		"empty":                    "",
		"nul bytes":                "\x00\x00\x00AED 1.00\x00",
		"invalid utf-8":            "\xff\xfe\xfdAED 250.00 at SHOP",
		"lone newlines":            strings.Repeat("\n", 200_000),
		"one enormous line":        strings.Repeat("A", 500_000),
		"400k-char merchant":       "paid to " + strings.Repeat("X", 400_000) + " AED 1.00",
		"bidi overrides":           strings.Repeat("‮‭", 50_000),
		"100k-digit amount":        "AED " + strings.Repeat("9", 100_000) + ".00",
		"100k-digit amount, zeros": "AED " + strings.Repeat("0", 100_000) + ".00",
		"comma stuffing":           "AED 1" + strings.Repeat(",", 100_000) + ".00",
		"redos shape: digits":      strings.Repeat("1", 200_000) + "z",
		"redos shape: at-words":    strings.Repeat("at at at ", 50_000),
		"repeated amounts":         strings.Repeat("AED 1.00 at SHOP on 01-01-2025\n", 20_000),
		"date candidates":          strings.Repeat("99-99-9999 ", 50_000),
	}
	for name, body := range bodies {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s: panic: %v", name, r)
				}
			}()
			start := time.Now()
			r, err := Parse(body)
			if el := time.Since(start); el > 5*time.Second {
				t.Errorf("%s: took %s; the tier is not linear in the input", name, el)
			}
			if !r.NeedsReview() {
				t.Errorf("%s: produced a trusted result", name)
			}
			if err == nil {
				if r.AmountMinor < 0 {
					t.Errorf("%s: negative amount %d", name, r.AmountMinor)
				}
				if n := len([]rune(r.Merchant)); n > tmpl.MaxCaptureRunes {
					t.Errorf("%s: merchant is %d runes", name, n)
				}
			}
		}()
	}
}

func TestABodyOverTheExecutorBoundIsRefusedNotTruncated(t *testing.T) {
	// The same bound the template executor applies, for the same reason: a
	// truncated body is a different message from the one that arrived, so the
	// tier declines rather than parsing a prefix.
	body := strings.Repeat("x", tmpl.MaxBodyBytes+1)
	if _, err := Parse("AED 1.00 " + body); !errors.Is(err, tmpl.ErrTooLarge) {
		t.Fatalf("err = %v, want tmpl.ErrTooLarge", err)
	}
	// One byte under, the same body parses.
	ok := "AED 1.00" + strings.Repeat("x", tmpl.MaxBodyBytes-8)
	if len(ok) != tmpl.MaxBodyBytes {
		t.Fatalf("test bug: body is %d bytes", len(ok))
	}
	if _, err := Parse(ok); err != nil {
		t.Fatalf("a body exactly at the bound must parse: %v", err)
	}
}

func TestAnAmountNoInt64CanHoldIsNotAnAmount(t *testing.T) {
	// Fails CLOSED: the tier reports no amount rather than a wrapped or
	// truncated one. The pipeline then records the message as unparsed, which
	// is visible, rather than as a transaction for 4.6 billion dirhams.
	for _, body := range []string{
		"AED " + strings.Repeat("9", 100_000) + ".00",
		"AED 99999999999999999999.00",
	} {
		r, err := Parse(body)
		if !errors.Is(err, ErrNoAmount) {
			t.Fatalf("%.20q: err = %v, want ErrNoAmount", body, err)
		}
		if r.AmountMinor != 0 {
			t.Fatalf("%.20q: amount = %d", body, r.AmountMinor)
		}
	}
}

func FuzzParseAlwaysNeedsReview(f *testing.F) {
	for _, s := range []string{
		"AED 250.00 debited at CARREFOUR on 03-02-2025",
		"USD 10.00 credited",
		"Total: 1,234.56",
		"", "\x00", "\xff\xfe", "at at at 0.00", "1,,,,.00", "99-99-9999",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, body string) {
		r, err := Parse(body)
		if !r.NeedsReview() || r.Tier() != TierHeuristic {
			t.Fatalf("untrusted-tier rule broken on %q", body)
		}
		if err != nil {
			return
		}
		if r.AmountMinor < 0 {
			t.Fatalf("negative amount %d from %q", r.AmountMinor, body)
		}
		if r.Direction != "debit" && r.Direction != "credit" {
			t.Fatalf("direction = %q from %q", r.Direction, body)
		}
		if r.Currency == "" {
			t.Fatalf("a successful parse must carry a currency: %q", body)
		}
		if n := len([]rune(r.Merchant)); n > tmpl.MaxCaptureRunes {
			t.Fatalf("merchant is %d runes from %q", n, body)
		}
	})
}

func fieldNames(rt reflect.Type) []string {
	out := make([]string, rt.NumField())
	for i := range out {
		out[i] = rt.Field(i).Name
	}
	return out
}
