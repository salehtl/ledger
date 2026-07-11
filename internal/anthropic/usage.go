package anthropic

import "errors"

// ErrAIDisabled is returned by Retrier.Post when the gate refuses a call. Callers
// treat it like any other Post failure (extraction skips its tier; categorization
// surfaces the error and the transaction stays in the review queue).
var ErrAIDisabled = errors.New("anthropic: AI disabled")

// Usage is one recorded Anthropic call. Path is "extract" or "categorize".
type Usage struct {
	Path         string
	Model        string
	InputTokens  int64
	OutputTokens int64
	OK           bool
	Detail       string
}

// Recorder persists a Usage. A nil Recorder means "don't record".
type Recorder func(Usage)

// PriceMuUSD is micro-USD (1e-6 USD) per token, per model. $1/Mtok input == 1 muUSD/token.
// Unknown models resolve to {0,0} — tokens are still recorded, cost shows as unknown.
var PriceMuUSD = map[string]struct{ In, Out int64 }{
	"claude-haiku-4-5-20251001": {In: 1, Out: 5},   // $1 / $5 per Mtok
	"claude-haiku-4-5":          {In: 1, Out: 5},
	"claude-opus-4-8":           {In: 5, Out: 25},  // $5 / $25 per Mtok
	"claude-sonnet-5":           {In: 3, Out: 15},  // $3 / $15 per Mtok
}

// CostMuUSD computes exact integer micro-USD cost for a call. Unknown model -> 0.
func CostMuUSD(model string, inTok, outTok int64) int64 {
	p, ok := PriceMuUSD[model]
	if !ok {
		return 0
	}
	return inTok*p.In + outTok*p.Out
}
