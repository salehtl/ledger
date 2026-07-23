package categorize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"ledger/internal/anthropic"
)

// AnthropicCategorizer calls the Anthropic Messages API to suggest a category
// for a merchant string. It sends ONLY the merchant and the category list —
// no amounts, dates, or account details leave the server.
type AnthropicCategorizer struct {
	apiKey   string
	model    string
	endpoint string // defaults to "https://api.anthropic.com/v1/messages"
	retry    *anthropic.Retrier
	gate     func() error
	rec      anthropic.Recorder
}

// NewAnthropicCategorizer builds the real AI categorizer. gate is consulted by
// the Retrier before any network I/O; rec records usage for each call that
// actually left the box (nil means "don't record").
func NewAnthropicCategorizer(apiKey, model string, gate func() error, rec anthropic.Recorder) *AnthropicCategorizer {
	r := anthropic.New(nil)
	r.Gate = gate
	return &AnthropicCategorizer{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.anthropic.com/v1/messages",
		retry:    r,
		gate:     gate,
		rec:      rec,
	}
}

const categorizerSystemPrompt = `You are a financial transaction categorizer.
Given a merchant name and a list of categories, return ONLY valid JSON on one line:
{"category": "<exact category name from the list>", "confidence": <0.0 to 1.0>}
Use confidence < 0.5 if no category is a good fit. Never add explanation outside the JSON.`

type anthropicCategReq struct {
	Model     string     `json:"model"`
	MaxTokens int        `json:"max_tokens"`
	System    string     `json:"system"`
	Messages  []categMsg `json:"messages"`
}

type categMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicCategResp struct {
	Model   string `json:"model"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Usage struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
}

type categResult struct {
	Category   string  `json:"category"`
	Confidence float64 `json:"confidence"`
}

// Categorize implements AICategorizer using the Anthropic Messages API.
func (a *AnthropicCategorizer) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	names := make([]string, len(cats))
	for i, c := range cats {
		names[i] = c.Name
	}

	userMsg := fmt.Sprintf("Merchant: %q\nCategories: %s", merchant, strings.Join(names, ", "))

	reqBody := anthropicCategReq{
		Model:     a.model,
		MaxTokens: 60, // reply is one ~20-token JSON line; this is a runaway guard
		System:    categorizerSystemPrompt,
		Messages: []categMsg{
			{Role: "user", Content: userMsg},
		},
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", 0, fmt.Errorf("categorize: marshal request: %w", err)
	}

	resp, err := a.retry.Post(ctx, a.endpoint, a.apiKey, bodyBytes)
	if err != nil {
		if !errors.Is(err, anthropic.ErrAIDisabled) && a.rec != nil {
			a.rec(anthropic.Usage{Path: "categorize", Model: a.model, OK: false, Detail: merchant})
		}
		return "", 0, fmt.Errorf("categorize: http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if a.rec != nil {
			a.rec(anthropic.Usage{Path: "categorize", Model: a.model, OK: false, Detail: merchant})
		}
		return "", 0, fmt.Errorf("anthropic API status %d", resp.StatusCode)
	}

	var ar anthropicCategResp
	if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
		return "", 0, fmt.Errorf("categorize: decode response: %w", err)
	}

	if a.rec != nil {
		model := ar.Model
		if model == "" {
			model = a.model
		}
		a.rec(anthropic.Usage{
			Path: "categorize", Model: model,
			InputTokens: ar.Usage.InputTokens, OutputTokens: ar.Usage.OutputTokens,
			OK: true, Detail: merchant,
		})
	}

	if len(ar.Content) == 0 {
		return "", 0, fmt.Errorf("categorize: empty content in response")
	}

	var result categResult
	if err := json.Unmarshal([]byte(anthropic.ExtractJSON(ar.Content[0].Text)), &result); err != nil {
		return "", 0, fmt.Errorf("categorize: parse result JSON: %w", err)
	}

	return result.Category, anthropic.Clamp01(result.Confidence), nil
}
