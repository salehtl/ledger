package api

import (
	"strconv"
	"testing"
	"time"
)

func TestLimiterSpendsTheBurstThenRefillsOnTheClock(t *testing.T) {
	now := time.Now()
	l := NewLimiter(1, 3, 16, func() time.Time { return now })
	for i := 0; i < 3; i++ {
		if !l.Allow("k") {
			t.Fatalf("call %d was refused inside the burst", i)
		}
	}
	if l.Allow("k") {
		t.Fatal("the burst did not bound anything")
	}
	now = now.Add(2 * time.Second)
	for i := 0; i < 2; i++ {
		if !l.Allow("k") {
			t.Fatalf("refill %d was refused after 2s at 1/s", i)
		}
	}
	if l.Allow("k") {
		t.Fatal("refill exceeded the elapsed time")
	}
}

func TestLimiterKeysAreIndependent(t *testing.T) {
	now := time.Now()
	l := NewLimiter(0, 1, 16, func() time.Time { return now })
	if !l.Allow("a") || l.Allow("a") {
		t.Fatal("key a's budget is wrong")
	}
	if !l.Allow("b") {
		t.Fatal("key a exhausting its budget must not spend key b's")
	}
}

func TestLimiterUnderKeyPressureSharesABucketRatherThanDenying(t *testing.T) {
	// The key space is attacker-chosen on the sign-in path. Refusing new keys
	// once the map is full would let anyone with many source addresses lock
	// every legitimate caller out — an amplification nuisance traded for an
	// outage. Under pressure the limit gets coarser, never absolute.
	now := time.Now()
	l := NewLimiter(0, 2, 2, func() time.Time { return now })
	for i := 0; i < 2; i++ {
		l.Allow("a")
		l.Allow("b")
	}
	// The map is now full and neither bucket is refillable (rate 0).

	served := 0
	for i := 0; i < 10; i++ {
		if l.Allow("flood-" + strconv.Itoa(i)) {
			served++
		}
	}
	if served == 0 {
		t.Fatal("a full key map denied every new caller outright")
	}
	if served > 2 {
		t.Fatalf("the shared fallback bucket served %d, which is more than its burst of 2", served)
	}
	// The established keys keep their own (already spent) budgets.
	if l.Allow("a") {
		t.Fatal("key pressure handed an established key a fresh budget")
	}
}

func TestLimiterSweepOnlyEvictsFullyRefilledKeys(t *testing.T) {
	now := time.Now()
	l := NewLimiter(1, 2, 2, func() time.Time { return now })
	l.Allow("idle") // 1 token left
	l.Allow("busy")
	l.Allow("busy") // 0 tokens left

	now = now.Add(10 * time.Second) // "idle" is back to full; "busy" is too
	if !l.Allow("new") {
		t.Fatal("a sweep of refilled keys should have made room")
	}
	if len(l.buckets) > 2 {
		t.Fatalf("the map holds %d keys, above its cap of 2", len(l.buckets))
	}

	// Now with no time passing, a spent key must not be evicted and reborn.
	l2 := NewLimiter(0, 1, 1, func() time.Time { return now })
	l2.Allow("spent")
	if l2.Allow("spent") {
		t.Fatal("a spent key was granted a second token")
	}
	l2.Allow("other") // forces the sweep path
	if l2.Allow("spent") {
		t.Fatal("the sweep evicted a partially spent bucket, handing its key a fresh burst")
	}
}

func TestNilLimiterAllows(t *testing.T) {
	var l *Limiter
	if !l.Allow("anything") {
		t.Fatal("a nil limiter must be an absent limit, not a closed door")
	}
}
