package categorize

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ledger/internal/aihttp"
)

var tsCats = []Category{
	{ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need"},
	{ID: 2, Name: "Dining", Kind: "spending", Bucket: "want"},
	{ID: 3, Name: "Salary", Kind: "income", Bucket: ""},
}

func newTestTS(t *testing.T, h http.HandlerFunc) (*TypeSafeCategorizer, *[]aihttp.Usage) {
	t.Helper()
	return newTestTSGated(t, nil, h)
}

// newTestTSGated passes gate through the constructor, so a test proves the
// constructor wires it (setting retry.Gate afterwards would not).
func newTestTSGated(t *testing.T, gate func() error, h http.HandlerFunc) (*TypeSafeCategorizer, *[]aihttp.Usage) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	var rec []aihttp.Usage
	ts := NewTypeSafeCategorizer("ts-key", "jev-1.13.0", gate, func(u aihttp.Usage) { rec = append(rec, u) })
	ts.endpoint = srv.URL + "/v1/systemone"
	ts.retry.HTTP = srv.Client()
	ts.retry.Backoff = func(int) time.Duration { return 0 }
	return ts, &rec
}

func TestTypeSafeCategorizerRequestShape(t *testing.T) {
	var body map[string]any
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer ts-key" {
			t.Errorf("Authorization = %q", got)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Groceries","confidence":0.9,"probabilities":{"Groceries":0.95,"Dining":0.05,"Salary":0,"__no_fit__":0}}},"usage":{"input_tokens":300,"output_tokens":20}}`))
	})
	if _, _, err := ts.Categorize(t.Context(), "CARREFOUR MOE", tsCats); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "jev-1.13.0" {
		t.Errorf("model = %v", body["model"])
	}
	state, _ := body["state"].(map[string]any)
	if len(state) != 1 || state["merchant"] != "CARREFOUR MOE" {
		t.Errorf("state must hold ONLY the merchant, got %v", body["state"])
	}
	q := body["questions"].(map[string]any)["category"].(map[string]any)
	if q["type"] != "choice" {
		t.Errorf("question type = %v", q["type"])
	}
	crit := q["criteria"].(map[string]any)
	for _, want := range []string{"Groceries", "Dining", "Salary", noFitOption} {
		if _, ok := crit[want]; !ok {
			t.Errorf("criteria missing %q", want)
		}
	}
	if len(crit) != 4 {
		t.Errorf("criteria has %d options, want 4", len(crit))
	}
}

func TestTypeSafeCategorizerSuccessRecordsUsage(t *testing.T) {
	ts, rec := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Dining","confidence":0.81,"probabilities":{"Dining":0.88,"Groceries":0.12,"Salary":0,"__no_fit__":0}}},"usage":{"input_tokens":318,"output_tokens":34}}`))
	})
	name, conf, err := ts.Categorize(t.Context(), "TALABAT", tsCats)
	if err != nil {
		t.Fatal(err)
	}
	if name != "Dining" || conf != 0.81 {
		t.Errorf("got (%q, %v), want (Dining, 0.81)", name, conf)
	}
	if len(*rec) != 1 {
		t.Fatalf("recorded %d usages, want 1", len(*rec))
	}
	u := (*rec)[0]
	if !u.OK || u.Path != "categorize" || u.Model != "jev-1.13.0" || u.InputTokens != 318 || u.Detail != "TALABAT" {
		t.Errorf("usage = %+v", u)
	}
}

func TestTypeSafeCategorizerNoFitReturnsBestRealWithZeroConfidence(t *testing.T) {
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"__no_fit__","confidence":0.6,"probabilities":{"__no_fit__":0.7,"Dining":0.2,"Groceries":0.1,"Salary":0}}},"usage":{"input_tokens":1,"output_tokens":1}}`))
	})
	name, conf, err := ts.Categorize(t.Context(), "XYZ LLC", tsCats)
	if err != nil {
		t.Fatal(err)
	}
	if name != "Dining" || conf != 0 {
		t.Errorf("got (%q, %v), want (Dining, 0)", name, conf)
	}
}

func TestTypeSafeCategorizerClampsConfidence(t *testing.T) {
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Dining","confidence":1.7,"probabilities":{"Dining":1}}},"usage":{}}`))
	})
	_, conf, err := ts.Categorize(t.Context(), "X", tsCats)
	if err != nil || conf != 1 {
		t.Errorf("conf = %v err = %v, want 1 nil", conf, err)
	}
}

func TestTypeSafeCategorizerNoRetryOn422(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"detail":"bad question"}`))
	})
	_, _, err := ts.Categorize(t.Context(), "X", tsCats)
	if err == nil || !strings.Contains(err.Error(), "422") {
		t.Errorf("err = %v, want a 422 error", err)
	}
	if calls.Load() != 1 {
		t.Errorf("server hit %d times, want 1 (422 must not retry)", calls.Load())
	}
	if len(*rec) != 1 || (*rec)[0].OK {
		t.Errorf("want one failed usage record, got %+v", *rec)
	}
}

func TestTypeSafeCategorizerRetriesOn529(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(529)
			return
		}
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Salary","confidence":0.9,"probabilities":{"Salary":1}}},"usage":{}}`))
	})
	name, _, err := ts.Categorize(t.Context(), "ACME PAYROLL", tsCats)
	if err != nil || name != "Salary" || calls.Load() != 2 {
		t.Errorf("name=%q err=%v calls=%d, want Salary nil 2", name, err, calls.Load())
	}
}

func TestTypeSafeCategorizerRejectsTooManyCategories(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	many := make([]Category, MaxTypeSafeCategories+1)
	for i := range many {
		many[i] = Category{ID: int64(i + 1), Name: "c" + strconv.Itoa(i)}
	}
	if _, _, err := ts.Categorize(t.Context(), "X", many); err == nil {
		t.Error("want an error for 255 categories")
	}
	if calls.Load() != 0 {
		t.Error("must not call the API when the category list is too long")
	}
}

func TestTypeSafeCategorizerGateBlocksEgress(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTSGated(t, func() error { return aihttp.ErrAIDisabled },
		func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	_, _, err := ts.Categorize(t.Context(), "X", tsCats)
	if !errors.Is(err, aihttp.ErrAIDisabled) {
		t.Errorf("err = %v, want ErrAIDisabled", err)
	}
	if calls.Load() != 0 || len(*rec) != 0 {
		t.Errorf("gate off: calls=%d records=%d, want 0 0", calls.Load(), len(*rec))
	}
}

func TestTypeSafeCategorizerMissingAnswer(t *testing.T) {
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{},"usage":{}}`))
	})
	if _, _, err := ts.Categorize(t.Context(), "X", tsCats); err == nil {
		t.Error("want an error when the answer is missing")
	}
}

// The spend cap prices usage by model id, and startup checks only the
// configured id. A response naming another id (an alias, a patch bump) must
// not make every call cost 0.
func TestTypeSafeCategorizerRecordsRequestedModel(t *testing.T) {
	ts, rec := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13","answers":{"category":{"type":"choice","choice":"Dining","confidence":0.9,"probabilities":{"Dining":1}}},"usage":{"input_tokens":300,"output_tokens":0}}`))
	})
	if _, _, err := ts.Categorize(t.Context(), "X", tsCats); err != nil {
		t.Fatal(err)
	}
	if len(*rec) != 1 || (*rec)[0].Model != "jev-1.13.0" {
		t.Fatalf("usage = %+v, want one record priced as jev-1.13.0", *rec)
	}
	if c := aihttp.CostMuUSD((*rec)[0].Model, 300, 0); c == 0 {
		t.Errorf("recorded call costs 0; the spend cap would not count it")
	}
}

// A no-fit answer with no usable probabilities has no best category. Picking
// the first one would be cached in ai_suggestions for good.
func TestTypeSafeCategorizerNoFitWithoutProbabilitiesErrors(t *testing.T) {
	for _, probs := range []string{``, `,"probabilities":{"__no_fit__":1,"Dining":0}`} {
		ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"__no_fit__","confidence":0.9` + probs + `}},"usage":{}}`))
		})
		if name, _, err := ts.Categorize(t.Context(), "X", tsCats); err == nil {
			t.Errorf("probs %q: got %q, want an error", probs, name)
		}
	}
}
