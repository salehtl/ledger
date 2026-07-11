package parse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ledger/internal/anthropic"
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

const extractorSystemPrompt = `Extract financial transaction data from this bank email body.
Respond ONLY with valid JSON on one line (no extra text):
{"posted_at":"2024-01-15T00:00:00Z","amount_fils":3825,"currency":"AED","direction":"debit","merchant_raw":"AMAZON.AE","last4":"1234","confidence":0.8}
Rules: posted_at is ISO8601 UTC; amount_fils is a positive integer, the amount in minor units (×100) of the transaction currency (e.g. USD 10.09 → 1009 with currency "USD"); currency is the 3-letter code shown in the email, "AED" if none shown; direction is exactly "debit" or "credit"; last4 may be empty string "".`

type extractReq struct {
	Model     string   `json:"model"`
	MaxTokens int      `json:"max_tokens"`
	System    string   `json:"system"`
	Messages  []extMsg `json:"messages"`
}

type extMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type extractResp struct {
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

type extractedTxn struct {
	PostedAt    string  `json:"posted_at"`
	AmountFils  int64   `json:"amount_fils"`
	Currency    string  `json:"currency"`
	Direction   string  `json:"direction"`
	MerchantRaw string  `json:"merchant_raw"`
	Last4       string  `json:"last4"`
	Confidence  float64 `json:"confidence"`
}

// AnthropicExtractor calls the Anthropic Messages API as the last-resort extraction
// tier. It sends the email body and expects a JSON ParsedTxn in reply.
// Output is always confidence < 1 and routed to needs_review by the cascade.
type AnthropicExtractor struct {
	apiKey   string
	model    string
	endpoint string
	retry    *anthropic.Retrier
	gate     func() error
	rec      anthropic.Recorder
}

// NewAnthropicExtractor builds the real AI extractor. gate is consulted by the
// Retrier before any network I/O; rec records usage for each call that
// actually left the box (nil means "don't record").
func NewAnthropicExtractor(apiKey, model string, gate func() error, rec anthropic.Recorder) *AnthropicExtractor {
	r := anthropic.New(nil)
	r.Gate = gate
	return &AnthropicExtractor{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.anthropic.com/v1/messages",
		retry:    r,
		gate:     gate,
		rec:      rec,
	}
}

func (a *AnthropicExtractor) Extract(ctx context.Context, textBody string) (ParsedTxn, error) {
	payload := extractReq{
		Model:     a.model,
		MaxTokens: 400,
		System:    extractorSystemPrompt,
		Messages:  []extMsg{{Role: "user", Content: textBody}},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("ai: marshal request: %w", err)
	}

	resp, err := a.retry.Post(ctx, a.endpoint, a.apiKey, body)
	if err != nil {
		if !errors.Is(err, anthropic.ErrAIDisabled) && a.rec != nil {
			a.rec(anthropic.Usage{Path: "extract", Model: a.model, OK: false})
		}
		return ParsedTxn{}, fmt.Errorf("ai: http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if a.rec != nil {
			a.rec(anthropic.Usage{Path: "extract", Model: a.model, OK: false})
		}
		return ParsedTxn{}, fmt.Errorf("ai: unexpected status %d", resp.StatusCode)
	}

	var apiResp extractResp
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return ParsedTxn{}, fmt.Errorf("ai: decode response: %w", err)
	}

	if a.rec != nil {
		model := apiResp.Model
		if model == "" {
			model = a.model
		}
		a.rec(anthropic.Usage{
			Path: "extract", Model: model,
			InputTokens: apiResp.Usage.InputTokens, OutputTokens: apiResp.Usage.OutputTokens,
			OK: true, Detail: "",
		})
	}

	if len(apiResp.Content) == 0 {
		return ParsedTxn{}, fmt.Errorf("ai: empty content in response")
	}

	var et extractedTxn
	if err := json.Unmarshal([]byte(anthropic.ExtractJSON(apiResp.Content[0].Text)), &et); err != nil {
		return ParsedTxn{}, fmt.Errorf("ai: unmarshal extracted txn: %w", err)
	}

	postedAt, err := time.Parse(time.RFC3339, et.PostedAt)
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("ai: parse posted_at %q: %w", et.PostedAt, err)
	}

	return ParsedTxn{
		PostedAt:    postedAt,
		AmountFils:  et.AmountFils,
		Currency:    strings.ToUpper(strings.TrimSpace(et.Currency)),
		Direction:   et.Direction,
		MerchantRaw: et.MerchantRaw,
		Last4:       et.Last4,
		Confidence:  anthropic.Clamp01(et.Confidence),
		Tier:        TierAI,
	}, nil
}
