package parse

import "context"

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
func (c *Cascade) Run(ctx context.Context, from, subject, textBody string) Result {
	// Tier 1: matching per-bank template.
	for _, bp := range c.Parsers {
		if !bp.Matches(from, subject) {
			continue
		}
		if p, err := bp.Parse(textBody); err == nil {
			if verr := Validate(p); verr == nil {
				return Result{Txn: p, Status: StatusParsed, Tier: TierTemplate}
			}
		}
		break // the bank matched but failed; fall through to heuristic
	}
	// Tier 2: bank-agnostic heuristic.
	if p, err := c.Heuristic.Parse(textBody); err == nil {
		if verr := Validate(p); verr == nil {
			return Result{Txn: p, Status: StatusParsed, Tier: TierHeuristic}
		}
	}
	// Tier 3: AI (always low-confidence → review). Skipped when disabled.
	if c.AI != nil {
		if p, err := c.AI.Extract(ctx, textBody); err == nil {
			if verr := Validate(p); verr == nil {
				p.Tier = TierAI
				return Result{Txn: p, Status: StatusLowConfidence, Tier: TierAI}
			}
		}
	}
	// Floor: nothing resolved.
	return Result{Status: StatusUnparsed}
}
