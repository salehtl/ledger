package classify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"ledger/internal/aihttp"
)

// typeSafeMaxOptions is TypeSafe's limit on options in one choice question.
const typeSafeMaxOptions = 255

// TypeSafe answers choice questions with TypeSafe's System One API (Jev models).
type TypeSafe struct {
	apiKey   string
	model    string
	endpoint string // defaults to "https://api.typesafe.ai/v1/systemone"
	retry    *aihttp.Retrier
	rec      aihttp.Recorder
}

// NewTypeSafe builds the adapter. gate is consulted by the Retrier before any
// network I/O; rec records usage (nil = don't record).
func NewTypeSafe(apiKey, model string, gate func() error, rec aihttp.Recorder) *TypeSafe {
	r := aihttp.New(nil)
	r.Gate = gate
	r.SetHeaders = func(req *http.Request, key string) {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
	}
	return &TypeSafe{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.typesafe.ai/v1/systemone",
		retry:    r,
		rec:      rec,
	}
}

// MaxOptions implements Classifier.
func (t *TypeSafe) MaxOptions() int { return typeSafeMaxOptions }

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

// Classify implements Classifier.
func (t *TypeSafe) Classify(ctx context.Context, req Request) (Answer, error) {
	q := req.Question
	if len(q.Options) > typeSafeMaxOptions {
		return Answer{}, fmt.Errorf("%w: %d > %d", ErrTooManyOptions, len(q.Options), typeSafeMaxOptions)
	}
	crit := make(map[string]string, len(q.Options))
	for _, o := range q.Options {
		crit[o.Name] = o.Criterion
	}
	body, err := json.Marshal(tsRequest{
		State:     req.State,
		Model:     t.model,
		Questions: map[string]tsQuestion{q.ID: {Type: "choice", Instructions: q.Instructions, Criteria: crit}},
	})
	if err != nil {
		return Answer{}, fmt.Errorf("classify: marshal request: %w", err)
	}

	resp, err := t.retry.Post(ctx, t.endpoint, t.apiKey, body)
	if err != nil {
		if !errors.Is(err, aihttp.ErrAIDisabled) {
			t.record(req, 0, 0, false)
		}
		return Answer{}, fmt.Errorf("classify: http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.record(req, 0, 0, false)
		return Answer{}, fmt.Errorf("classify: typesafe API status %d", resp.StatusCode)
	}
	var tr tsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		t.record(req, 0, 0, false)
		return Answer{}, fmt.Errorf("classify: decode response: %w", err)
	}
	t.record(req, tr.Usage.InputTokens, tr.Usage.OutputTokens, true)

	ans, ok := tr.Answers[q.ID]
	if !ok || ans.Choice == "" {
		return Answer{}, fmt.Errorf("classify: typesafe response has no %q answer", q.ID)
	}
	if _, ok := crit[ans.Choice]; !ok {
		return Answer{}, fmt.Errorf("classify: answer %q is not an option", ans.Choice)
	}
	return Answer{Choice: ans.Choice, Confidence: aihttp.Clamp01(ans.Confidence), Probs: ans.Probabilities}, nil
}

// record writes one usage row. It prices on the requested (pinned) model id,
// not the id the response names: cost is looked up by this id, and startup
// checks only the configured one.
func (t *TypeSafe) record(req Request, in, out int64, ok bool) {
	if t.rec == nil {
		return
	}
	t.rec(aihttp.Usage{Path: req.Path, Model: t.model, InputTokens: in, OutputTokens: out, OK: ok, Detail: req.Detail})
}
