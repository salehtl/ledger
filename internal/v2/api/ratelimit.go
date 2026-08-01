package api

import (
	"sync"
	"time"
)

// Limiter is a keyed token bucket. It exists because two endpoints in this
// package are reachable by callers who have not proved anything yet, or have
// proved only that they hold a session — and both of them cost the server real
// resources per request:
//
//   - POST /api/v1/auth/exchange is UNAUTHENTICATED and drives the IdP
//     verification path. auth.cachingKeySet already caps outbound JWKS fetches
//     at one per provider per minute, so the amplifier that policy closed does
//     not reopen here; what is left is a stream of unauthenticated base64
//     decodes, signature verifications and, on success, a user upsert plus a
//     session insert. That is worth bounding before it reaches any of them.
//   - POST /api/v1/writers/challenge mints a 32-byte row per call, for anyone
//     holding a session. auth.Writers.Challenge sweeps expired rows
//     opportunistically, but the sweep is one retention period BEHIND expiry,
//     so the table's steady-state size is set by the mint rate. Unbounded, one
//     session can put 500 live rows in it in a second.
//
// # Memory, and why the key space is bounded
//
// The sign-in limiter is keyed by client address, which is attacker-chosen: an
// unbounded map is a memory-exhaustion primitive dressed as a defence.
// MaxKeys caps it. When the map is full, Allow first sweeps buckets that have
// refilled to full (i.e. idle for at least burst/rate) and, if that frees
// nothing, falls back to ONE shared bucket rather than denying. Denying on
// pressure would let an attacker with many source addresses lock every
// legitimate caller out — trading an amplification nuisance for an outage,
// which is the same trap auth's package doc rejects for negative caching of
// JWKS kids.
//
// The zero rate is legal and means "burst only, never refills"; the tests use
// it so the budget is exactly the burst.
type Limiter struct {
	rate    float64 // tokens per second
	burst   float64
	maxKeys int
	now     func() time.Time

	mu       sync.Mutex
	buckets  map[string]*bucket
	fallback bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter returns a limiter allowing burst requests immediately and rate
// requests per second thereafter, tracking at most maxKeys distinct keys.
func NewLimiter(rate, burst float64, maxKeys int, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	if burst < 1 {
		burst = 1
	}
	if maxKeys < 1 {
		maxKeys = 1
	}
	return &Limiter{
		rate:    rate,
		burst:   burst,
		maxKeys: maxKeys,
		now:     now,
		buckets: make(map[string]*bucket),
	}
}

// Allow consumes one token for key and reports whether there was one to
// consume. A nil Limiter allows everything, so an unconfigured field is an
// absent limit rather than a panic.
func (l *Limiter) Allow(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()

	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxKeys {
			l.sweep(now)
		}
		if len(l.buckets) >= l.maxKeys {
			// Shared bucket: the limit still applies, it is simply coarser for
			// the duration of the pressure. See the type doc.
			return take(&l.fallback, l.rate, l.burst, now)
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	return take(b, l.rate, l.burst, now)
}

func take(b *bucket, rate, burst float64, now time.Time) bool {
	if b.last.IsZero() {
		b.tokens, b.last = burst, now
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * rate
		if b.tokens > burst {
			b.tokens = burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweep drops buckets that have refilled to full, i.e. keys idle long enough
// that forgetting them changes no decision. It is the only eviction: dropping a
// PARTIALLY spent bucket would hand its key a fresh burst, which is exactly the
// bypass a bounded map must not create.
func (l *Limiter) sweep(now time.Time) {
	for k, b := range l.buckets {
		refilled := b.tokens + now.Sub(b.last).Seconds()*l.rate
		if refilled >= l.burst {
			delete(l.buckets, k)
		}
	}
}
