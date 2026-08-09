package smtpd

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/pgtest"
)

// spend consumes the whole remaining allowance and reports how much there was.
// It is the only honest measurement of "what would this limiter let through
// now": the state is three scalars and a weighting, and reading them directly
// would be a second copy of the arithmetic under test.
func spend(l *Limiter, u uuid.UUID) int {
	n := 0
	for l.AllowMessage(u) {
		n++
		if n > 1<<20 {
			panic("spend: the allowance never ran out")
		}
	}
	return n
}

func counterCfg(clock *testClock) LimiterConfig {
	return LimiterConfig{Daily: 10, DailyWindow: time.Hour, Notices: 3, Now: clock.now}
}

// TestPersistedCountersReproduceTheRunningAllowanceExactly is the claim
// 00032_smtp_counters.sql makes: the three scalars ARE the state, so a limiter
// restored from them answers precisely what a limiter that never stopped would
// have answered — at the same instant, one window later, and two windows later.
//
// The reference is the LIVE limiter rather than a number written here, because
// the property is "identical to not having restarted", not "equal to 6".
func TestPersistedCountersReproduceTheRunningAllowanceExactly(t *testing.T) {
	for _, tc := range []struct {
		name string
		gap  time.Duration
		// want is the allowance both limiters must report after the gap. It is
		// spelled out so that a bug which broke BOTH sides identically — a
		// Restore that silently did nothing, at a gap where that is invisible —
		// cannot pass.
		want int
	}{
		{"no gap", 0, 6},
		// One window of silence: roll shifts cur into prev, and prev is weighted
		// by the whole window because none of it has elapsed yet. Still 4 spent.
		{"one window of silence shifts current into previous", time.Hour, 6},
		// Halfway through the next window half of prev has decayed: 4 * 0.5 = 2.
		{"a half window decays half of the previous bucket", 90 * time.Minute, 8},
		// More than two windows: everything has aged out.
		{"two windows of silence ages everything to zero", 2*time.Hour + time.Minute, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clock := newClock()
			u := uuid.New()

			live := NewLimiter(counterCfg(clock))
			for i := 0; i < 4; i++ {
				if !live.AllowMessage(u) {
					t.Fatal("the allowance ran out early")
				}
			}

			rows := live.Snapshot()
			if len(rows) != 1 || rows[0].Kind != CounterKindMessages || rows[0].UserID != u {
				t.Fatalf("snapshot = %+v, want one messages counter for %v", rows, u)
			}
			if rows[0].Cur != 4 || rows[0].Prev != 0 || rows[0].WindowSeconds != 3600 {
				t.Fatalf("snapshot did not carry the counter's own state: %+v", rows[0])
			}

			clock.advance(tc.gap)

			restored := NewLimiter(counterCfg(clock))
			if n := restored.Restore(rows); n != 1 {
				t.Fatalf("restored %d counters, want 1", n)
			}
			gotLive, gotRestored := spend(live, u), spend(restored, u)
			if gotLive != tc.want {
				t.Fatalf("the running limiter allowed %d more messages, want %d", gotLive, tc.want)
			}
			if gotRestored != gotLive {
				t.Fatalf("a restart changed the allowance: restored %d, still-running %d", gotRestored, gotLive)
			}
		})
	}
}

// TestASnapshotTakenAcrossAWindowBoundaryCarriesBothBuckets.
//
// The test above snapshots a counter whose previous bucket is empty, so it
// cannot tell whether prev is persisted at all. This one spends either side of
// a boundary, so the stored row carries both scalars and a limiter that dropped
// one of them answers a different allowance.
func TestASnapshotTakenAcrossAWindowBoundaryCarriesBothBuckets(t *testing.T) {
	clock := newClock()
	u := uuid.New()
	live := NewLimiter(counterCfg(clock))
	for i := 0; i < 4; i++ {
		live.AllowMessage(u)
	}
	clock.advance(time.Hour) // the 4 roll into the previous bucket
	for i := 0; i < 2; i++ {
		live.AllowMessage(u)
	}

	rows := live.Snapshot()
	if len(rows) != 1 || rows[0].Cur != 2 || rows[0].Prev != 4 {
		t.Fatalf("snapshot = %+v, want cur=2 prev=4", rows)
	}
	restored := NewLimiter(counterCfg(clock))
	if n := restored.Restore(rows); n != 1 {
		t.Fatalf("restored %d counters, want 1", n)
	}
	if a, b := spend(restored, u), spend(live, u); a != b {
		t.Fatalf("a restart across a window boundary changed the allowance: %d vs %d", a, b)
	}
}

// TestAWindowMismatchDiscardsTheRowRatherThanRescalingIt is the reason
// window_seconds is stored at all.
//
// cur, prev and window_start only mean something under the window they were
// accumulated at. A deployment that changes DailyWindow makes every stored row
// un-reinterpretable, and the only two options are discard and invent. Invent
// silently mis-states every account's allowance with no way to notice; discard
// costs one account one window of leniency, once.
func TestAWindowMismatchDiscardsTheRowRatherThanRescalingIt(t *testing.T) {
	clock := newClock()
	u := uuid.New()
	live := NewLimiter(counterCfg(clock))
	for i := 0; i < 4; i++ {
		live.AllowMessage(u)
	}
	rows := live.Snapshot()
	rows[0].WindowSeconds *= 2 // the operator doubled DailyWindow between runs

	restored := NewLimiter(counterCfg(clock))
	if n := restored.Restore(rows); n != 0 {
		t.Fatalf("restored %d rows accumulated under a different window; they are not convertible", n)
	}
	if got := spend(restored, u); got != 10 {
		t.Fatalf("a discarded row must leave a clean counter, allowance = %d, want 10", got)
	}
}

// TestRestoreNeverOverwritesACounterThatIsAlreadyLive.
//
// Restore is a startup step, and the one direction it must never move in is
// "less spent than the process has already counted". A stored row is older than
// anything the running process has seen, so pasting it over live state could
// only discard counts that were actually spent.
func TestRestoreNeverOverwritesACounterThatIsAlreadyLive(t *testing.T) {
	clock := newClock()
	u := uuid.New()
	old := NewLimiter(counterCfg(clock))
	old.AllowMessage(u)
	rows := old.Snapshot() // one message spent

	live := NewLimiter(counterCfg(clock))
	for i := 0; i < 7; i++ {
		live.AllowMessage(u)
	}
	if n := live.Restore(rows); n != 0 {
		t.Fatalf("Restore overwrote %d live counters", n)
	}
	if got := spend(live, u); got != 3 {
		t.Fatalf("allowance = %d, want 3: the seven already spent must still be spent", got)
	}
}

// TestNoticeBudgetsSurviveARestartToo. The notice counters are the other half
// of what 00032 persists, and they are what decides whether a refusal left a
// user-visible trace — a budget that a restart refilled would spam the
// diagnostics table on every deploy.
func TestNoticeBudgetsSurviveARestart(t *testing.T) {
	clock := newClock()
	u := uuid.New()
	live := NewLimiter(counterCfg(clock))
	for i := 0; i < 3; i++ {
		if !live.Notice(u, diag.RejectOverQuota) {
			t.Fatalf("notice %d refused early", i)
		}
	}
	if live.Notice(u, diag.RejectOverQuota) {
		t.Fatal("the notice budget is 3")
	}

	rows := live.Snapshot()
	var found *UserCounter
	for i := range rows {
		if rows[i].Kind == CounterKindNotice && rows[i].Reason == diag.RejectOverQuota {
			found = &rows[i]
		}
	}
	if found == nil {
		t.Fatalf("the notice counter was not persisted: %+v", rows)
	}

	restored := NewLimiter(counterCfg(clock))
	restored.Restore(rows)
	if restored.Notice(u, diag.RejectOverQuota) {
		t.Fatal("a restart refilled the notice budget")
	}
	// A DIFFERENT reason is a different counter and is untouched.
	if !restored.Notice(u, diag.RejectTooLarge) {
		t.Fatal("restoring one reason's budget spent another's")
	}
}

// TestAnEmptyCounterIsNotPersisted keeps the table's size the number of
// accounts currently spending rather than the number ever seen.
func TestAnEmptyCounterIsNotPersisted(t *testing.T) {
	clock := newClock()
	l := NewLimiter(counterCfg(clock))
	u := uuid.New()
	l.AllowMessage(u)
	l.ReleaseMessage(u) // taken and given straight back: nothing was delivered
	if rows := l.Snapshot(); len(rows) != 0 {
		t.Fatalf("snapshot = %+v, want nothing", rows)
	}
}

// TestTheTarpitCountersAreNeverPersisted.
//
// Deliberate, and stated in 00032: the per-source map is keyed by a value the
// attacker chooses, on a port anybody can reach, so persisting it would turn an
// LRU-bounded map into an unbounded remotely-writable table — a storage
// amplification primitive bolted to the control that exists to stop one.
func TestTheTarpitCountersAreNeverPersisted(t *testing.T) {
	clock := newClock()
	l := NewLimiter(counterCfg(clock))
	for i := 0; i < 50; i++ {
		l.InvalidRcpt(addr("192.0.2.1"))
	}
	if rows := l.Snapshot(); len(rows) != 0 {
		t.Fatalf("a source-keyed counter reached the snapshot: %+v", rows)
	}
}

// ---------------------------------------------------------------------------
// The Postgres store
// ---------------------------------------------------------------------------

// TestCountersRoundTripThroughPostgres is the whole mechanism end to end: a
// running limiter's state, written, read back by a fresh process, and answering
// the same allowance.
func TestCountersRoundTripThroughPostgres(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	st := &PGStore{Pool: pool}
	clock := newClock()

	live := NewLimiter(counterCfg(clock))
	for i := 0; i < 4; i++ {
		live.AllowMessage(u)
	}
	// Across a window boundary, so BOTH buckets are non-zero and a column that
	// round-trips into the wrong field is visible rather than invisible.
	clock.advance(time.Hour)
	for i := 0; i < 2; i++ {
		live.AllowMessage(u)
	}
	live.Notice(u, diag.RejectOverQuota)
	if err := st.SaveUserCounters(bg, live.Snapshot()); err != nil {
		t.Fatal(err)
	}

	got, err := st.LoadUserCounters(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("loaded %d rows, want the messages counter and the notice counter", len(got))
	}
	for _, r := range got {
		if !r.WindowStart.Equal(clock.now()) {
			t.Fatalf("window_start round-tripped as %v, want %v", r.WindowStart, clock.now())
		}
		if r.WindowSeconds != 3600 {
			t.Fatalf("window_seconds round-tripped as %d", r.WindowSeconds)
		}
		if r.Kind == CounterKindMessages && (r.Cur != 2 || r.Prev != 4) {
			t.Fatalf("the messages counter round-tripped as cur=%d prev=%d, want cur=2 prev=4", r.Cur, r.Prev)
		}
	}

	restored := NewLimiter(counterCfg(clock))
	if n := restored.Restore(got); n != 2 {
		t.Fatalf("restored %d of 2 counters", n)
	}
	if a, b := spend(restored, u), spend(live, u); a != b {
		t.Fatalf("a restart through Postgres changed the allowance: %d vs %d", a, b)
	}

	// A second flush of the same account updates the row rather than adding one.
	if err := st.SaveUserCounters(bg, restored.Snapshot()); err != nil {
		t.Fatal(err)
	}
	if got, err = st.LoadUserCounters(bg); err != nil || len(got) != 2 {
		t.Fatalf("a second flush left %d rows (err %v), want 2", len(got), err)
	}
}

// TestAPurgedAccountsCounterIsSkippedRatherThanFailing.
//
// These writes are retried from an in-memory buffer, so an error that can never
// succeed is an error that is retried forever. A foreign key violation for an
// account that no longer exists is exactly that.
func TestAPurgedAccountsCounterIsSkippedRatherThanFailing(t *testing.T) {
	pool := pgtest.New(t)
	st := &PGStore{Pool: pool}
	ghost := UserCounter{
		UserID: uuid.New(), Kind: CounterKindMessages, WindowSeconds: 3600,
		WindowStart: time.Now().UTC().Truncate(time.Microsecond), Cur: 3,
	}
	if err := st.SaveUserCounters(bg, []UserCounter{ghost}); err != nil {
		t.Fatalf("a counter for a purged account must be skipped, not fail: %v", err)
	}
	if rows, err := st.LoadUserCounters(bg); err != nil || len(rows) != 0 {
		t.Fatalf("rows = %d (err %v), want none", len(rows), err)
	}
	if err := st.CountRefusals(bg, uuid.New(), RefusalSuspended, 1); err != nil {
		t.Fatalf("a refusal for a purged account must be skipped, not fail: %v", err)
	}
}
