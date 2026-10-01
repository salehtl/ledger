package categorize

import (
	"context"
	"fmt"

	"ledger/internal/classify"
)

// noFitOption lets the classifier say "none of these". It is never a real
// category name.
const noFitOption = "__no_fit__"

// Jev reads instructions literally (docs: jev-1.13 jaggedness #1), so the
// boundary cases are spelled out rather than implied.
const categoryInstructions = "Which budget category does the card transaction at `merchant` belong to? " +
	"`merchant` is the raw merchant text from a UAE bank alert. " +
	"Choose " + noFitOption + " when no category clearly fits."

func criterionFor(c Category) string {
	switch c.Kind {
	case "income":
		return "Money received"
	case "excluded":
		return "Not counted in the budget, such as transfers between own accounts"
	}
	if c.Bucket != "" {
		return "Spending (" + c.Bucket + ")"
	}
	return "Spending"
}

// ClassifierCategorizer implements AICategorizer with one choice question to a
// classification provider. It sends ONLY the merchant string and the category
// list: no amounts, dates or account details leave the server.
type ClassifierCategorizer struct {
	C classify.Classifier
}

// NewClassifierCategorizer wraps a provider.
func NewClassifierCategorizer(c classify.Classifier) *ClassifierCategorizer {
	return &ClassifierCategorizer{C: c}
}

// Categorize implements AICategorizer.
func (cc *ClassifierCategorizer) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	if limit := cc.C.MaxOptions() - 1; len(cats) > limit {
		return "", 0, fmt.Errorf("categorize: %d categories exceed the provider's limit of %d", len(cats), limit)
	}
	opts := make([]classify.Option, 0, len(cats)+1)
	for _, c := range cats {
		opts = append(opts, classify.Option{Name: c.Name, Criterion: criterionFor(c)})
	}
	opts = append(opts, classify.Option{Name: noFitOption, Criterion: "None of the other categories fits this merchant"})

	ans, err := cc.C.Classify(ctx, classify.Request{
		Path:     "categorize",
		Detail:   merchant,
		State:    map[string]string{"merchant": merchant},
		Question: classify.Question{ID: "category", Instructions: categoryInstructions, Options: opts},
	})
	if err != nil {
		return "", 0, fmt.Errorf("categorize: %w", err)
	}
	if ans.Choice == noFitOption {
		// Suggest the best real category, but never let it auto-confirm.
		best, bestP := "", -1.0
		for _, c := range cats {
			if p := ans.Probs[c.Name]; p > bestP {
				best, bestP = c.Name, p
			}
		}
		if bestP <= 0 {
			// No real category has any weight. A guess would be cached in
			// ai_suggestions for good, so fail and leave the row in review.
			return "", 0, fmt.Errorf("categorize: provider answered no fit with no usable probabilities")
		}
		return best, 0, nil
	}
	return ans.Choice, ans.Confidence, nil
}
