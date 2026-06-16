package anthropic

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// newRetrier returns a Retrier whose sleeps are captured (never real) so tests
// run instantly while still asserting the requested wait.
func newRetrier(maxRetries int, slept *[]time.Duration) *Retrier {
	return &Retrier{
		HTTP:       &http.Client{},
		MaxRetries: maxRetries,
		Backoff:    func(int) time.Duration { return 7 * time.Millisecond },
		sleep: func(_ context.Context, d time.Duration) error {
			*slept = append(*slept, d)
			return nil
		},
	}
}

func TestPostSucceedsFirstTry(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	var slept []time.Duration
	resp, err := newRetrier(3, &slept).Post(context.Background(), srv.URL, "k", []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || atomic.LoadInt32(&calls) != 1 || len(slept) != 0 {
		t.Fatalf("status=%d calls=%d slept=%v", resp.StatusCode, calls, slept)
	}
}

func TestPostRetriesOn429ThenSucceeds(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&calls, 1) <= 2 {
			w.WriteHeader(429) // no Retry-After → backoff path
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	var slept []time.Duration
	resp, err := newRetrier(3, &slept).Post(context.Background(), srv.URL, "k", []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || atomic.LoadInt32(&calls) != 3 {
		t.Fatalf("status=%d calls=%d", resp.StatusCode, calls)
	}
	if len(slept) != 2 || slept[0] != 7*time.Millisecond {
		t.Fatalf("expected 2 backoff sleeps, got %v", slept)
	}
}

func TestPostHonorsRetryAfter(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	var slept []time.Duration
	resp, err := newRetrier(3, &slept).Post(context.Background(), srv.URL, "k", []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// Slept exactly the Retry-After value, not the 7ms backoff.
	if len(slept) != 1 || slept[0] != 2*time.Second {
		t.Fatalf("expected one 2s Retry-After sleep, got %v", slept)
	}
}

func TestPostReturnsLastResponseAfterExhausting(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(429)
	}))
	defer srv.Close()

	var slept []time.Duration
	resp, err := newRetrier(2, &slept).Post(context.Background(), srv.URL, "k", []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// 1 initial + 2 retries = 3 calls; final 429 is returned, not an error.
	if resp.StatusCode != 429 || atomic.LoadInt32(&calls) != 3 || len(slept) != 2 {
		t.Fatalf("status=%d calls=%d slept=%v", resp.StatusCode, calls, slept)
	}
}

func TestPostStopsOnContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(429)
	}))
	defer srv.Close()

	r := &Retrier{
		HTTP:       &http.Client{},
		MaxRetries: 5,
		Backoff:    func(int) time.Duration { return time.Millisecond },
		sleep:      func(ctx context.Context, _ time.Duration) error { return ctx.Err() },
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Post(ctx, srv.URL, "k", []byte("{}")); err == nil {
		t.Fatal("expected error from cancelled context")
	}
}

func TestRetryAfterParsing(t *testing.T) {
	cases := map[string]time.Duration{"": -1, "abc": -1, "-3": -1, "0": 0, "5": 5 * time.Second, "9999": maxBackoff}
	for in, want := range cases {
		if got := retryAfter(in); got != want {
			t.Errorf("retryAfter(%q)=%v want %v", in, got, want)
		}
	}
}
