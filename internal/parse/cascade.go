package parse

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Status values mirror ingest_log.parse_status.
const (
	StatusParsed        = "parsed"
	StatusLowConfidence = "low_confidence"
	StatusUnparsed      = "unparsed"
)

// Result is the outcome of running the cascade over one email.
type Result struct {
	Txn    ParsedTxn
	Status string // parsed | low_confidence | unparsed
	Tier   string // template | heuristic | ai | "" (none)
	Err    string // last tier error, for ingest_log.parse_error (optional)
}

// Cascade runs the extraction tiers in order. AI may be a DisabledExtractor.
type Cascade struct {
	Parsers   []BankParser
	Heuristic HeuristicParser
	AI        Extractor
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
	// Floor: nothing resolved.
	return Result{Status: StatusUnparsed, Err: strings.Join(errs, "; ")}
}
