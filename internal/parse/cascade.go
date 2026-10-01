package parse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"ledger/internal/aihttp"
)

// Status values mirror ingest_log.parse_status.
const (
	StatusParsed        = "parsed"
	StatusLowConfidence = "low_confidence"
	StatusUnparsed      = "unparsed"
	// StatusIgnored marks a raw email recognized as known non-transactional
	// content (e.g. a duplicate confirmation of a transfer already recorded
	// from its sibling notification). The raw body stays in ingest_log —
	// nothing is ever silently dropped — but no transaction is created. A
	// template's ignore is never reprocessed; an AI-check set-aside is
	// revisited only by a manual reprocess.
	StatusIgnored = "ignored"
)

// ErrIgnoreEmail is returned by a BankParser.Parse to mean "this email is a
// recognized non-transactional layout for this bank; skip it entirely."
// Unlike an ordinary parse failure, the cascade does NOT fall through to the
// heuristic or AI tiers when it sees this error — those tiers have no way to
// know the email is a deliberate no-op and would otherwise misparse it into
// a bogus transaction (a duplicate, a decoy, a wrong-direction guess).
var ErrIgnoreEmail = errors.New("parse: known non-transactional email, ignore")

// Result is the outcome of running the cascade over one email.
type Result struct {
	Txn     ParsedTxn
	Status  string      // parsed | low_confidence | unparsed | ignored
	Tier    string      // template | heuristic | ai | ai_check | "" (none)
	Err     string      // last tier error, for ingest_log.parse_error (optional)
	Verdict *TxnVerdict // the AI check's answer, when it gave one
}

// Cascade runs the extraction tiers in order. AI may be a DisabledExtractor.
// Check, when set, classifies an email no tier could read; IgnoreAt is the
// confidence at or above which a "not a transaction" verdict sets the email
// aside (0 = never).
type Cascade struct {
	Parsers   []BankParser
	Heuristic HeuristicParser
	AI        Extractor
	Check     TxnChecker
	IgnoreAt  float64
}

// Run descends the ladder and stops at the first validated, accepted result.
// When nothing resolves, Result.Err carries each attempted tier's failure so
// ingest_log.parse_error explains the unparsed row.
func (c *Cascade) Run(ctx context.Context, from, subject, textBody string, fallbackDate time.Time) Result {
	var errs []string
	fail := func(tier string, err error) {
		errs = append(errs, tier+": "+strings.TrimPrefix(err.Error(), tier+": "))
	}

	// Tier 1: matching per-bank template.
	for _, bp := range c.Parsers {
		if !bp.Matches(from, subject) {
			continue
		}
		p, err := bp.Parse(subject, textBody)
		if errors.Is(err, ErrIgnoreEmail) {
			return Result{Status: StatusIgnored, Tier: TierTemplate}
		}
		if err == nil {
			// A template may leave PostedAt zero when its format carries no
			// body date; the email's own date is trustworthy for advice mail.
			if p.PostedAt.IsZero() {
				p.PostedAt = fallbackDate
			}
			if verr := Validate(p); verr == nil {
				return Result{Txn: p, Status: StatusParsed, Tier: TierTemplate}
			} else {
				err = verr
			}
		}
		fail(TierTemplate, err)
		break // the bank matched but failed; fall through to heuristic
	}
	// Tier 2: bank-agnostic heuristic.
	p, err := c.Heuristic.Parse(textBody)
	if err == nil {
		if verr := Validate(p); verr == nil {
			return Result{Txn: p, Status: StatusParsed, Tier: TierHeuristic}
		} else {
			err = verr
		}
	}
	fail(TierHeuristic, err)
	// Tier 3: AI (always low-confidence → review). Skipped when disabled.
	if c.AI != nil {
		p, err := c.AI.Extract(ctx, textBody)
		if err == nil {
			if verr := Validate(p); verr == nil {
				p.Tier = TierAI
				return Result{Txn: p, Status: StatusLowConfidence, Tier: TierAI}
			} else {
				err = verr
			}
		}
		// A disabled AI tier is a benign skip, not a failure worth recording.
		if !errors.Is(err, ErrAIUnavailable) {
			fail(TierAI, err)
		}
	}
	// Tier 4: AI check. It only classifies; it never writes a transaction. A
	// confident "not a transaction" sets the email aside (ignored; the raw body
	// stays in ingest_log). Anything else stays unparsed, carrying the verdict.
	if c.Check != nil {
		v, err := c.Check.Check(ctx, from, subject, textBody)
		switch {
		case err == nil && v.Verdict == VerdictNotTxn && c.IgnoreAt > 0 && v.Confidence >= c.IgnoreAt:
			return Result{Status: StatusIgnored, Tier: TierAICheck, Verdict: &v}
		case err == nil:
			fail(TierAICheck, fmt.Errorf("%s (%.2f)", v.Verdict, v.Confidence))
			return Result{Status: StatusUnparsed, Err: strings.Join(errs, "; "), Verdict: &v}
		case !errors.Is(err, aihttp.ErrAIDisabled):
			fail(TierAICheck, err)
		}
	}
	// Floor: nothing resolved.
	return Result{Status: StatusUnparsed, Err: strings.Join(errs, "; ")}
}
