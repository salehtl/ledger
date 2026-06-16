// Package anthropic provides a small retrying HTTP client for the Anthropic
// Messages API. It cooperates with rate limits: on 429 (and 5xx/529) it honors
// the server's Retry-After header, falling back to capped exponential backoff
// with jitter. This lets bulk categorization back off instead of hammering the
// API when it's told to slow down.
package anthropic

import (
	"bytes"
	"context"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	apiVersion = "2023-06-01"
	maxBackoff = 60 * time.Second
)

// Retrier POSTs JSON to the Anthropic Messages API with bounded retries.
type Retrier struct {
	HTTP       *http.Client
	MaxRetries int // retries after the first attempt (total attempts = MaxRetries+1)
	// Backoff returns the wait before retry `attempt` (1-based) when the server
	// sent no usable Retry-After. nil → DefaultBackoff.
	Backoff func(attempt int) time.Duration
	// sleep waits for d or until ctx is done; nil → real wait. Overridable in tests.
	sleep func(ctx context.Context, d time.Duration) error
}

// New returns a Retrier with sane defaults: 3 retries, a 30s per-attempt
// timeout, and exponential backoff.
func New(hc *http.Client) *Retrier {
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Retrier{HTTP: hc, MaxRetries: 3}
}

// Post sends body to endpoint authenticated with apiKey, retrying on 429/5xx.
// It returns the final *http.Response — the caller closes Body and checks
// StatusCode. After exhausting retries it returns the last response (e.g. a
// 429) rather than an error, so callers handle it uniformly.
func (r *Retrier) Post(ctx context.Context, endpoint, apiKey string, body []byte) (*http.Response, error) {
	backoff := r.Backoff
	if backoff == nil {
		backoff = DefaultBackoff
	}
	wait := r.sleep
	if wait == nil {
		wait = sleepCtx
	}

	attempts := r.MaxRetries + 1
	for i := 0; i < attempts; i++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", apiVersion)
		req.Header.Set("content-type", "application/json")

		resp, err := r.HTTP.Do(req)
		last := i == attempts-1
		if err != nil {
			if last {
				return nil, err
			}
			if werr := wait(ctx, backoff(i+1)); werr != nil {
				return nil, werr
			}
			continue
		}
		if last || !retryable(resp.StatusCode) {
			return resp, nil
		}
		// Retryable status with attempts left: respect Retry-After, else back off.
		d := retryAfter(resp.Header.Get("Retry-After"))
		if d < 0 {
			d = backoff(i + 1)
		}
		resp.Body.Close()
		if werr := wait(ctx, d); werr != nil {
			return nil, werr
		}
	}
	return nil, context.DeadlineExceeded // unreachable: loop always returns
}

// retryable reports whether a status code is worth retrying: 429 (rate limit)
// and any 5xx (incl. 529 overloaded).
func retryable(code int) bool {
	return code == http.StatusTooManyRequests || code >= 500
}

// retryAfter parses an integer-seconds Retry-After header, capped at maxBackoff.
// Returns -1 when the header is absent or not an integer (HTTP-date form is
// uncommon for this API; callers fall back to backoff).
func retryAfter(h string) time.Duration {
	h = strings.TrimSpace(h)
	if h == "" {
		return -1
	}
	secs, err := strconv.Atoi(h)
	if err != nil || secs < 0 {
		return -1
	}
	d := time.Duration(secs) * time.Second
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}

// DefaultBackoff is full-jitter exponential backoff: a random wait in
// [0, min(30s, 0.5s·2^(attempt-1))].
func DefaultBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := 500 * time.Millisecond * (1 << (attempt - 1))
	if d > 30*time.Second || d <= 0 {
		d = 30 * time.Second
	}
	return time.Duration(rand.Int63n(int64(d) + 1))
}

// sleepCtx waits for d or until ctx is cancelled, whichever comes first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
