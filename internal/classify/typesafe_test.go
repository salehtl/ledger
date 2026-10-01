package classify

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

var testQ = Question{
	ID:           "category",
	Instructions: "Pick one.",
	Options: []Option{
		{Name: "Groceries", Criterion: "Spending (need)"},
		{Name: "Dining", Criterion: "Spending (want)"},
		{Name: "__no_fit__", Criterion: "None fits"},
	},
}

func testReq() Request {
	return Request{Path: "categorize", Detail: "TALABAT", State: map[string]string{"merchant": "TALABAT"}, Question: testQ}
}

// newTestTS passes gate through the constructor, so a test proves the
// constructor wires it (setting retry.Gate afterwards would not).
func newTestTS(t *testing.T, gate func() error, h http.HandlerFunc) (*TypeSafe, *[]aihttp.Usage) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	var rec []aihttp.Usage
	ts := NewTypeSafe("ts-key", "jev-1.13.0", gate, func(u aihttp.Usage) { rec = append(rec, u) })
	ts.endpoint = srv.URL + "/v1/systemone"
	ts.retry.HTTP = srv.Client()
	ts.retry.Backoff = func(int) time.Duration { return 0 }
	return ts, &rec
}

func answer(choice string, conf float64) string {
	return `{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"` + choice +
		`","confidence":` + strconv.FormatFloat(conf, 'f', -1, 64) +
		`,"probabilities":{"Groceries":0.1,"Dining":0.9,"__no_fit__":0}}},"usage":{"input_tokens":318,"output_tokens":34}}`
}

func TestTypeSafeRequestShape(t *testing.T) {
	var body map[string]any
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer ts-key" {
			t.Errorf("Authorization = %q", got)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(answer("Dining", 0.9)))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "jev-1.13.0" {
		t.Errorf("model = %v", body["model"])
	}
	state, _ := body["state"].(map[string]any)
	if len(state) != 1 || state["merchant"] != "TALABAT" {
		t.Errorf("state = %v, want exactly the request's state", body["state"])
	}
	q := body["questions"].(map[string]any)["category"].(map[string]any)
	if q["type"] != "choice" || q["instructions"] != "Pick one." {
		t.Errorf("question = %v", q)
	}
	crit := q["criteria"].(map[string]any)
	if len(crit) != 3 || crit["Dining"] != "Spending (want)" {
		t.Errorf("criteria = %v", crit)
	}
}

func TestTypeSafeSuccessRecordsUsage(t *testing.T) {
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(answer("Dining", 0.81)))
	})
	ans, err := ts.Classify(t.Context(), testReq())
	if err != nil {
		t.Fatal(err)
	}
	if ans.Choice != "Dining" || ans.Confidence != 0.81 || ans.Probs["Dining"] != 0.9 {
		t.Errorf("answer = %+v", ans)
	}
	if len(*rec) != 1 {
		t.Fatalf("recorded %d usages, want 1", len(*rec))
	}
	u := (*rec)[0]
	if !u.OK || u.Path != "categorize" || u.Model != "jev-1.13.0" || u.InputTokens != 318 || u.Detail != "TALABAT" {
		t.Errorf("usage = %+v", u)
	}
}

func TestTypeSafeClampsConfidence(t *testing.T) {
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(answer("Dining", 1.7)))
	})
	ans, err := ts.Classify(t.Context(), testReq())
	if err != nil || ans.Confidence != 1 {
		t.Errorf("conf = %v err = %v, want 1 nil", ans.Confidence, err)
	}
}

func TestTypeSafeNoRetryOn422(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnprocessableEntity)
	})
	_, err := ts.Classify(t.Context(), testReq())
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

func TestTypeSafeRetriesOn529(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(529)
			return
		}
		_, _ = w.Write([]byte(answer("Groceries", 0.9)))
	})
	ans, err := ts.Classify(t.Context(), testReq())
	if err != nil || ans.Choice != "Groceries" || calls.Load() != 2 {
		t.Errorf("choice=%q err=%v calls=%d, want Groceries nil 2", ans.Choice, err, calls.Load())
	}
}

func TestTypeSafeRejectsTooManyOptions(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	q := Question{ID: "category"}
	for i := 0; i <= ts.MaxOptions(); i++ {
		q.Options = append(q.Options, Option{Name: "c" + strconv.Itoa(i)})
	}
	req := testReq()
	req.Question = q
	if _, err := ts.Classify(t.Context(), req); !errors.Is(err, ErrTooManyOptions) {
		t.Errorf("err = %v, want ErrTooManyOptions", err)
	}
	if calls.Load() != 0 {
		t.Error("must not call the API when the question has too many options")
	}
	if ts.MaxOptions() != 255 {
		t.Errorf("MaxOptions = %d, want 255", ts.MaxOptions())
	}
}

func TestTypeSafeGateBlocksEgress(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, func() error { return aihttp.ErrAIDisabled },
		func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	_, err := ts.Classify(t.Context(), testReq())
	if !errors.Is(err, aihttp.ErrAIDisabled) {
		t.Errorf("err = %v, want ErrAIDisabled", err)
	}
	if calls.Load() != 0 || len(*rec) != 0 {
		t.Errorf("gate off: calls=%d records=%d, want 0 0", calls.Load(), len(*rec))
	}
}

func TestTypeSafeMissingAnswer(t *testing.T) {
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{},"usage":{}}`))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err == nil {
		t.Error("want an error when the answer is missing")
	}
}

// An answer outside the options is an error. Callers must never read it as a
// real option, such as "not a transaction".
func TestTypeSafeRejectsUnknownChoice(t *testing.T) {
	for _, choice := range []string{"dining", "Takeaway", " Dining"} {
		ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(answer(choice, 0.99)))
		})
		if ans, err := ts.Classify(t.Context(), testReq()); err == nil {
			t.Errorf("choice %q: got %+v, want an error", choice, ans)
		}
	}
}

// The spend cap prices usage by model id, and startup checks only the
// configured id. A response naming another id must not make calls cost 0.
func TestTypeSafeRecordsRequestedModel(t *testing.T) {
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Replace(answer("Dining", 0.9), `"model":"jev-1.13.0"`, `"model":"jev-1.13"`, 1)))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err != nil {
		t.Fatal(err)
	}
	if len(*rec) != 1 || (*rec)[0].Model != "jev-1.13.0" {
		t.Fatalf("usage = %+v, want one record priced as jev-1.13.0", *rec)
	}
	if aihttp.CostMuUSD((*rec)[0].Model, 318, 0) == 0 {
		t.Error("recorded call costs 0; the spend cap would not count it")
	}
}

// A body that fails to decode still costs a call; the record says it failed.
func TestTypeSafeDecodeFailureRecordsFailedUsage(t *testing.T) {
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err == nil {
		t.Fatal("want a decode error")
	}
	if len(*rec) != 1 || (*rec)[0].OK {
		t.Errorf("want one failed usage record, got %+v", *rec)
	}
}
