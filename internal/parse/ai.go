package parse

import (
	"context"
	"errors"
)

// ErrAIUnavailable means no AI extractor is configured/enabled. The cascade
// treats it as "skip the AI tier".
var ErrAIUnavailable = errors.New("ai extractor unavailable")

// Extractor is the AI extraction tier. Implementations operate on the plain-text
// body and MUST be treated as low-confidence by the caller (always routed to
// review). The real Anthropic-backed implementation arrives in Milestone 4.
type Extractor interface {
	Extract(ctx context.Context, textBody string) (ParsedTxn, error)
}

// DisabledExtractor is the default when ai.enabled is false. It always returns
// ErrAIUnavailable so the cascade falls through to the review-queue floor.
type DisabledExtractor struct{}

func (DisabledExtractor) Extract(context.Context, string) (ParsedTxn, error) {
	return ParsedTxn{}, ErrAIUnavailable
}
