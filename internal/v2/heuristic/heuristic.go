// Package heuristic is the bank-agnostic fallback tier: what the pipeline runs
// when no published template matched a message.
//
// It is a port of v1's internal/parse/heuristic.go, patterns kept byte-for-byte,
// with one behavioural change that the rest of this comment is about.
//
// # Nothing this tier produces is ever trusted
//
// Spec §3.2: a heuristic result is ALWAYS needs_review. No threshold, no
// confidence score to tune, no override — and not a field a caller can set,
// which is why [Result.NeedsReview] is a method returning a constant rather
// than a bool on the struct. There is no value of [Result], built by this
// package or any other, that reports anything else.
//
// The reason is the tier's own shape, and it is not hypothetical. What it does
// is: take the first amount-shaped run of digits anywhere in the body, assume
// AED when no currency code precedes it, assume a debit unless a credit word
// appears anywhere, read a DD-MM-YYYY date if one is present, and take whatever
// follows "at"/"to"/"paid to" as the merchant. Every one of those is a guess
// about a UAE-shaped bank alert:
//
//   - A promotional mail advertising "EUR 899.00" parses as a transaction.
//   - A balance line above the purchase line wins, because it is first.
//   - "04-07-2025" is read as 4 July, because US order is not considered.
//   - A body with no currency code at all becomes AED.
//
// Those are asserted in TestHeuristicIsUAEShapedAndSaysSo rather than described
// here and forgotten. Under a template they would be defects; under this tier
// they are the cost of parsing mail no template covers, and needs_review is
// what makes the cost visible to the user instead of silent in the ledger.
//
// # The regex dialect does not apply here (Decision 16)
//
// v1's patterns use \b, inline (?i) flags and \s, all of which the template
// dialect bans. They are kept anyway, because the two things the dialect exists
// to prevent cannot happen here:
//
//  1. GO/JS DIVERGENCE. The dialect makes two executors agree. This tier is
//     never published, never distributed and never executed by a client, so
//     there is no second executor to diverge from.
//  2. CATASTROPHIC BACKTRACKING. That is a JavaScript property. Go's RE2 has no
//     backtracking, so an attacker-chosen body cannot make these patterns
//     expensive in the only engine that runs them —
//     TestParseSurvivesHostileBodies asserts it on the shapes that are
//     polynomial in a backtracking engine.
//
// Converting them now would be a rewrite in service of an executor that does
// not exist, validated against a corpus gate the heuristic tier does not have.
//
// # The consequence, stated rather than hidden
//
// Spec §3.5 requires the two executors to agree, and the conformance suite
// covers the TEMPLATE rung only. Phase 1 ships NO TypeScript heuristic, so a
// client reprocessing a message the server heuristic-parsed cannot reproduce
// the server's result. Two things follow:
//
//  1. The divergence surfaces as a review item, not as a silently different
//     number, because everything this tier produces is needs_review anyway.
//  2. Before client-side reprocessing ships, the heuristic must be converted to
//     the dialect AND entered into the conformance suite. Until then a client
//     must skip reprocessing any transaction whose tier is "heuristic".
//
// TestHeuristicPatternsAreOutsideTheRegexDialectOnPurpose is the tripwire: it
// fails the day these patterns become dialect-legal, which is the day those two
// conditions come due.
//
// # One deviation from the plan's stated signature
//
// The plan writes this as func Parse(string) (tmpl.Extraction, error) with
// "Tier = heuristic, NeedsReview = true". tmpl.Extraction has neither field,
// and it must not gain them: it is the type the TypeScript mirror reproduces
// (Task 20), so a server-only trust bit added there becomes part of the
// cross-executor contract, and a bool on a shared struct is settable by anyone.
// [Result] embeds tmpl.Extraction, so every extraction field is reached exactly
// as before (r.AmountMinor, r.Merchant, r.Produced) and r.Extraction hands back
// the embedded value; the trust bit is a method that cannot be set at all.
//
// What that does NOT cover, stated so it is not mistaken for more than it is:
// the guarantee lives on the Result type, and a caller that unwraps
// r.Extraction and composes its own op payload is writing its own tier and
// review flag. That is the pipeline's job (Task 29) and is pinned at that end
// by its own test over the stored payload. The rule is asserted twice, at both
// ends of the handoff, because one assertion covers only one of them.
package heuristic

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ledger/internal/v2/tmpl"
)

// TierHeuristic is the tier name this package's results carry. It is a copy of
// diag.TierHeuristic rather than a reference to it: an extraction tier must not
// depend on the diagnostics store. TestTierNameIsTheOneTheDiagnosticsEnumStores
// keeps the two equal.
const TierHeuristic = "heuristic"

// ErrNoAmount means the body carries nothing this tier can record as money —
// either no amount-shaped run at all, or one no int64 of minor units can hold.
// Both fail closed: the pipeline records the message as unparsed, which is
// visible, rather than as a transaction with a wrapped or truncated figure.
var ErrNoAmount = errors.New("heuristic: the body carries no amount this tier can record")

// The four patterns, byte-for-byte from v1's internal/parse/heuristic.go and
// internal/parse/fields.go. They are named constants so the dialect tripwire in
// heuristic_test.go can assert against the exact text that runs.
const (
	// amountPattern finds an optional 3-letter currency then a number with
	// comma thousands separators and exactly two decimals.
	amountPattern     = `(?:([A-Z]{3})\s*)?([0-9][0-9,]*\.[0-9]{2})`
	datePattern       = `\b(\d{2}-\d{2}-\d{4})\b`
	creditWordPattern = `(?i)\b(credit(ed)?|deposit(ed)?|received|refund)\b`
	merchantPattern   = `(?i)\b(?:at|to|merchant|payment to|paid to)\b[:\s]+([A-Za-z0-9][A-Za-z0-9 &.'\-]{2,40})`
)

var (
	amountRe     = regexp.MustCompile(amountPattern)
	dateRe       = regexp.MustCompile(datePattern)
	creditWordRe = regexp.MustCompile(creditWordPattern)
	merchantRe   = regexp.MustCompile(merchantPattern)
)

// dateLayout is v1's ParseDIBDate layout. Go's time.Parse checks calendar
// ranges, so "32-13-2025" has the shape and is not a date; the field is then
// left unset rather than zero-timed.
const dateLayout = "02-01-2006"

// defaultCurrency is the assumption this tier makes when the body carries no
// currency code. A template states its default; this tier has none to state, so
// it guesses the operator's country — see the package comment.
const defaultCurrency = "AED"

const (
	directionDebit  = "debit"
	directionCredit = "credit"
)

// Result is one heuristic extraction. The embedded [tmpl.Extraction] carries
// the values; [Result.Tier] and [Result.NeedsReview] carry the tier's contract
// and are methods precisely so that no caller can construct a trusted heuristic
// result. See TestNoConstructionOfAHeuristicResultCanBeTrusted.
type Result struct {
	tmpl.Extraction
}

// Tier is always [TierHeuristic].
func (Result) Tier() string { return TierHeuristic }

// NeedsReview is always true. Spec §3.2: a heuristic result is never
// auto-trusted, so this takes no threshold and consults no state — including on
// the zero value, which is what a caller holds after Parse returns an error.
func (Result) NeedsReview() bool { return true }

// Parse extracts shape-level fields from normalized body text.
//
// It returns [ErrNoAmount] when there is no amount to record — that is the only
// field without which there is no transaction — and [tmpl.ErrTooLarge] for a
// body past the executor's bound. Every other field is optional: a missing date
// or merchant leaves the field unset for the caller to judge, exactly as in the
// template executor.
//
// The body is ATTACKER-WRITABLE. Three things bound the work it can cause, and
// each is separate: the size guard below, RE2's linear matching, and the
// merchant pattern's own {2,40} bound. Nothing here allocates in proportion to
// anything but the input, and no error message quotes the body.
func Parse(normalized string) (Result, error) {
	// The same bound the template executor applies, for the same reason: over
	// it the message is REFUSED, never truncated, because a truncated body is a
	// different message from the one that arrived. In the pipeline the
	// normalizer's output is already inside this bound; the guard is for the
	// caller that is not the pipeline.
	if len(normalized) > tmpl.MaxBodyBytes {
		return Result{}, fmt.Errorf("%w: normalized body is %d bytes, limit %d",
			tmpl.ErrTooLarge, len(normalized), tmpl.MaxBodyBytes)
	}

	minor, currency, err := amount(normalized)
	if err != nil {
		return Result{}, err
	}
	e := tmpl.Extraction{
		AmountMinor: minor,
		Currency:    currency,
		Direction:   directionDebit,
		Matched:     true,
	}
	if creditWordRe.MatchString(normalized) {
		e.Direction = directionCredit
	}
	if m := dateRe.FindStringSubmatch(normalized); m != nil {
		if d, derr := time.Parse(dateLayout, m[1]); derr == nil {
			e.PostedAt = d
		}
	}
	if m := merchantRe.FindStringSubmatch(normalized); m != nil {
		e.Merchant = strings.TrimSpace(m[1])
	}
	return Result{Extraction: e}, nil
}

// amount is v1's ParseAEDToFils, returning minor units and a currency.
//
// The point is removed rather than the value scaled by 100, so this is
// integer-only and never sees a float. An amount int64 cannot hold is not an
// amount: the tier reports ErrNoAmount rather than the wrapped figure ParseInt
// would otherwise be asked for.
func amount(body string) (int64, string, error) {
	m := amountRe.FindStringSubmatch(body)
	if m == nil {
		return 0, "", ErrNoAmount
	}
	currency := m[1]
	if currency == "" {
		currency = defaultCurrency
	}
	digits := strings.ReplaceAll(m[2], ",", "")
	digits = strings.Replace(digits, ".", "", 1) // "10000.00" -> "1000000"
	minor, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		// The body is attacker-writable and this error reaches a log, so it
		// reports the SHAPE and never the text: a 100,000-digit run quoted back
		// is a log-amplification bug, and body content in a log is a privacy
		// one.
		return 0, "", fmt.Errorf("%w: a %d-digit figure does not fit an int64 of minor units",
			ErrNoAmount, len(digits))
	}
	return minor, currency, nil
}
