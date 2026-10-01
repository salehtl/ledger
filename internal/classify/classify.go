// Package classify is the seam between ledger and an AI classification
// provider. A provider answers one choice question about a small text state
// with one of the offered options and a confidence. It never generates text.
// To add a provider, write one adapter that implements Classifier and add a
// case to the provider switch in cmd/ledger/main.go.
package classify

import (
	"context"
	"errors"
)

// Option is one allowed answer. Criterion tells the provider when it applies.
type Option struct {
	Name      string
	Criterion string
}

// Question is one choice question. ID names it in the request and the answer.
type Question struct {
	ID           string
	Instructions string
	Options      []Option
}

// Request is one call. Path and Detail label the usage record (for example
// "categorize" and the merchant); they are never sent to the provider. State
// is everything the provider sees besides the question.
type Request struct {
	Path     string
	Detail   string
	State    map[string]string
	Question Question
}

// Answer is the provider's choice. Choice is always one of the option names;
// Confidence is in [0, 1]; Probs maps option names to probabilities and may be
// empty.
type Answer struct {
	Choice     string
	Confidence float64
	Probs      map[string]float64
}

// Classifier is an AI classification provider.
type Classifier interface {
	Classify(ctx context.Context, req Request) (Answer, error)
	// MaxOptions is the most options one question may carry.
	MaxOptions() int
}

// ErrTooManyOptions is returned, before any network call, when a question has
// more options than the provider allows.
var ErrTooManyOptions = errors.New("classify: too many options")
