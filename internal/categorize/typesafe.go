package categorize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"ledger/internal/anthropic"
)

// MaxTypeSafeCategories is the most categories one Choice can carry: the API
// allows 255 options and one is reserved for noFitOption.
const MaxTypeSafeCategories = 254

// noFitOption lets Jev say "none of these". It is never a real category name.
const noFitOption = "__no_fit__"

// TypeSafeCategorizer asks TypeSafe's Jev model one Choice question per
// merchant. Like AnthropicCategorizer it sends ONLY the merchant string and the
// category list — no amounts, dates, or account details leave the server.
type TypeSafeCategorizer struct {
	apiKey   string
	model    string
	endpoint string // defaults to "https://api.typesafe.ai/v1/systemone"
	retry    *anthropic.Retrier
	rec      anthropic.Recorder
}

// NewTypeSafeCategorizer builds the TypeSafe categorizer. gate is consulted by
// the Retrier before any network I/O; rec records usage (nil = don't record).
func NewTypeSafeCategorizer(apiKey, model string, gate func() error, rec anthropic.Recorder) *TypeSafeCategorizer {
	r := anthropic.New(nil)
	r.Gate = gate
	r.SetHeaders = func(req *http.Request, key string) {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
	}
	return &TypeSafeCategorizer{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.typesafe.ai/v1/systemone",
		retry:    r,
		rec:      rec,
	}
}

type tsQuestion struct {
	Type         string            `json:"type"`
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

type tsRequest struct {
	State     map[string]string     `json:"state"`
	Model     string                `json:"model"`
	Questions map[string]tsQuestion `json:"questions"`
}

type tsResponse struct {
	Model   string `json:"model"`
	Answers map[string]struct {
		Type          string             `json:"type"`
		Choice        string             `json:"choice"`
		Confidence    float64            `json:"confidence"`
		Probabilities map[string]float64 `json:"probabilities"`
	} `json:"answers"`
	Usage struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
}

// Jev reads instructions literally (docs: jev-1.13 jaggedness #1), so the
// boundary cases are spelled out here rather than implied.
const tsInstructions = "Which budget category does the card transaction at `merchant` belong to? " +
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

// Categorize implements AICategorizer using a TypeSafe Choice question.
func (t *TypeSafeCategorizer) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	if len(cats) > MaxTypeSafeCategories {
		return "", 0, fmt.Errorf("categorize: %d categories exceed TypeSafe's limit of %d", len(cats), MaxTypeSafeCategories)
	}
	crit := make(map[string]string, len(cats)+1)
	for _, c := range cats {
		crit[c.Name] = criterionFor(c)
	}
	crit[noFitOption] = "None of the other categories fits this merchant"

	body, err := json.Marshal(tsRequest{
		State: map[string]string{"merchant": merchant},
		Model: t.model,
		Questions: map[string]tsQuestion{
			"category": {Type: "choice", Instructions: tsInstructions, Criteria: crit},
		},
	})
	if err != nil {
		return "", 0, fmt.Errorf("categorize: marshal request: %w", err)
	}

	resp, err := t.retry.Post(ctx, t.endpoint, t.apiKey, body)
	if err != nil {
		if !errors.Is(err, anthropic.ErrAIDisabled) && t.rec != nil {
			t.rec(anthropic.Usage{Path: "categorize", Model: t.model, OK: false, Detail: merchant})
		}
		return "", 0, fmt.Errorf("categorize: http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if t.rec != nil {
			t.rec(anthropic.Usage{Path: "categorize", Model: t.model, OK: false, Detail: merchant})
		}
		return "", 0, fmt.Errorf("typesafe API status %d", resp.StatusCode)
	}

	var tr tsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", 0, fmt.Errorf("categorize: decode response: %w", err)
	}
	if t.rec != nil {
		model := tr.Model
		if model == "" {
			model = t.model
		}
		t.rec(anthropic.Usage{
			Path: "categorize", Model: model,
			InputTokens: tr.Usage.InputTokens, OutputTokens: tr.Usage.OutputTokens,
			OK: true, Detail: merchant,
		})
	}

	ans, ok := tr.Answers["category"]
	if !ok || ans.Choice == "" {
		return "", 0, fmt.Errorf("categorize: typesafe response has no category answer")
	}
	if ans.Choice == noFitOption {
		// Suggest the best real category, but never let it auto-confirm.
		best, bestP := "", -1.0
		for _, c := range cats {
			if p := ans.Probabilities[c.Name]; p > bestP {
				best, bestP = c.Name, p
			}
		}
		return best, 0, nil
	}
	return ans.Choice, anthropic.Clamp01(ans.Confidence), nil
}
