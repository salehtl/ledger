package smtpd

import (
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/diag"
)

// A frozen, hand-advanced clock. Every window assertion below depends on
// controlling time exactly; a real clock would make "just inside the window"
// and "just outside it" the same test.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *testClock {
	return &testClock{t: time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)}
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func addr(s string) netip.Addr { return netip.MustParseAddr(s) }

// ---------------------------------------------------------------------------
// Invalid-RCPT tarpit
// ---------------------------------------------------------------------------

// The brief's test, verbatim in intent: the first Burst invalid recipients are
// free, after that the delay grows, and sustained abuse drops the connection.
func TestInvalidRcptTarpitGrowsAndThenDisconnects(t *testing.T) {
	l := NewLimiter(LimiterConfig{Burst: 5, Base: 10 * time.Millisecond, Window: time.Hour})
	ip := addr("192.0.2.1")
	for i := 0; i < 5; i++ {
		if d, _ := l.InvalidRcpt(ip); d != 0 {
			t.Fatalf("burst %d should not delay, got %v", i, d)
		}
	}
	d6, _ := l.InvalidRcpt(ip)
	d7, _ := l.InvalidRcpt(ip)
	if !(d7 > d6 && d6 > 0) {
		t.Fatalf("tarpit must grow: %v then %v", d6, d7)
	}
	for i := 0; i < 20; i++ {
		l.InvalidRcpt(ip)
	}
	if _, disconnect := l.InvalidRcpt(ip); !disconnect {
		t.Fatal("expected disconnect after sustained abuse")
	}
}

// The doubling is bounded. Without a cap a determined sweeper pins a server
// goroutine and a file descriptor for as long as it likes — the tarpit would
// become the attacker's tool rather than ours.
func TestTarpitDelayIsCappedAtMax(t *testing.T) {
	l := NewLimiter(LimiterConfig{
		Burst: 1, Base: time.Second, Max: 30 * time.Second,
		Window: time.Hour, Disconnect: 1 << 30,
	})
	ip := addr("192.0.2.2")
	var last time.Duration
	for i := 0; i < 200; i++ {
		d, disconnect := l.InvalidRcpt(ip)
		if disconnect {
			t.Fatalf("call %d: disconnect not expected with a huge threshold", i)
		}
		if d > 30*time.Second {
			t.Fatalf("call %d: delay %v exceeds the cap", i, d)
		}
		last = d
	}
	if last != 30*time.Second {
		t.Fatalf("after 200 invalid recipients the delay should sit at the cap, got %v", last)
	}
}

// The window is rolling, so an IP that stops for an hour is forgiven. A counter
// that never decayed would turn a transient misconfiguration into a permanent
// block on a shared NAT address.
func TestInvalidRcptCountDecaysOutOfTheWindow(t *testing.T) {
	c := newClock()
	l := NewLimiter(LimiterConfig{
		Burst: 2, Base: time.Millisecond, Window: time.Hour,
		Disconnect: 10, Now: c.now,
	})
	ip := addr("192.0.2.3")
	for i := 0; i < 9; i++ {
		l.InvalidRcpt(ip)
	}
	if l.Blocked(ip) {
		t.Fatal("nine invalid recipients with a threshold of ten should not be blocking yet")
	}
	c.advance(2 * time.Hour)
	if l.Blocked(ip) {
		t.Fatal("the window has rolled twice over; this IP must be forgiven")
	}
	if d, _ := l.InvalidRcpt(ip); d != 0 {
		t.Fatalf("after the window rolled the burst allowance is fresh, got a %v delay", d)
	}
}

// Blocked is the pre-check that runs BEFORE the recipient lookup, so an IP that
// has already earned a disconnect costs no database work. It must therefore not
// itself record an attempt, or the pre-check would drive the counter it reads.
func TestBlockedReportsWithoutRecordingAnAttempt(t *testing.T) {
	l := NewLimiter(LimiterConfig{Burst: 1, Base: time.Millisecond, Window: time.Hour, Disconnect: 3})
	ip := addr("192.0.2.4")
	for i := 0; i < 100; i++ {
		if l.Blocked(ip) {
			t.Fatal("Blocked must not count its own calls")
		}
	}
	for i := 0; i < 3; i++ {
		l.InvalidRcpt(ip)
	}
	if !l.Blocked(ip) {
		t.Fatal("three invalid recipients with a threshold of three must block")
	}
}

// Per-caller before global: one abusive host must not spend anyone else's
// budget. This is the failure mode a prior task shipped — a per-IP check placed
// after a shared one — and it locks every legitimate sender out at once.
func TestOneAbusiveIPDoesNotDelayAnother(t *testing.T) {
	l := NewLimiter(LimiterConfig{Burst: 2, Base: time.Second, Window: time.Hour, Disconnect: 20})
	bad, good := addr("192.0.2.5"), addr("198.51.100.5")
	for i := 0; i < 19; i++ {
		l.InvalidRcpt(bad)
	}
	if l.Blocked(good) {
		t.Fatal("a flood from one address must not block a different one")
	}
	if d, _ := l.InvalidRcpt(good); d != 0 {
		t.Fatalf("an unrelated address still owns its full burst, got a %v delay", d)
	}
}

// An IPv4 address reached over a v6-mapped socket is the SAME host. Keying the
// two forms separately would double every budget for free.
func TestMappedIPv4IsTheSameKeyAsPlainIPv4(t *testing.T) {
	l := NewLimiter(LimiterConfig{Burst: 1, Base: time.Millisecond, Window: time.Hour, Disconnect: 3})
	plain := addr("203.0.113.9")
	mapped := netip.AddrFrom16(plain.As16()) // ::ffff:203.0.113.9, not unmapped
	l.InvalidRcpt(plain)
	l.InvalidRcpt(mapped)
	l.InvalidRcpt(plain)
	if !l.Blocked(mapped) {
		t.Fatal("v4-mapped and plain v4 forms of one address must share a counter")
	}
}

// A single IPv6 allocation is a /64. Counting per-address there is counting
// per-attempt: the attacker has 2^64 of them and the tarpit never engages.
func TestIPv6AddressesInOneSlash64ShareABudget(t *testing.T) {
	l := NewLimiter(LimiterConfig{Burst: 1, Base: time.Millisecond, Window: time.Hour, Disconnect: 3})
	for _, s := range []string{"2001:db8:1:1::1", "2001:db8:1:1::2", "2001:db8:1:1::dead:beef"} {
		l.InvalidRcpt(addr(s))
	}
	if !l.Blocked(addr("2001:db8:1:1::ffff")) {
		t.Fatal("three attempts from one /64 must block the whole /64")
	}
	if l.Blocked(addr("2001:db8:1:2::1")) {
		t.Fatal("a different /64 is a different network and keeps its own budget")
	}
}

// ---------------------------------------------------------------------------
// Per-user daily quota
// ---------------------------------------------------------------------------

func TestAllowMessagePermitsExactlyTheDailyAllowance(t *testing.T) {
	l := NewLimiter(LimiterConfig{Daily: 50, DailyWindow: 24 * time.Hour})
	u := uuid.New()
	for i := 0; i < 50; i++ {
		if !l.AllowMessage(u) {
			t.Fatalf("message %d is inside the allowance and must be permitted", i+1)
		}
	}
	if l.AllowMessage(u) {
		t.Fatal("the 51st message in the window must be refused")
	}
}

// A refusal must not spend quota. If it did, an attacker who blew through the
// allowance could hold it blown indefinitely by continuing to send — turning a
// rate limit into an off switch for that user's mail.
func TestRefusedMessagesDoNotConsumeQuota(t *testing.T) {
	c := newClock()
	l := NewLimiter(LimiterConfig{Daily: 3, DailyWindow: 24 * time.Hour, Now: c.now})
	u := uuid.New()
	for i := 0; i < 3; i++ {
		l.AllowMessage(u)
	}
	for i := 0; i < 1000; i++ {
		if l.AllowMessage(u) {
			t.Fatal("over quota must stay over quota within the window")
		}
	}
	// One full window after the last ACCEPTED message, the allowance is back.
	// If the 1000 refusals had counted, it would not be.
	c.advance(25 * time.Hour)
	if !l.AllowMessage(u) {
		t.Fatal("a window after the last accepted message the allowance must be fresh")
	}
}

func TestQuotaIsPerUserNotShared(t *testing.T) {
	l := NewLimiter(LimiterConfig{Daily: 2, DailyWindow: 24 * time.Hour})
	a, b := uuid.New(), uuid.New()
	l.AllowMessage(a)
	l.AllowMessage(a)
	if l.AllowMessage(a) {
		t.Fatal("user a is over quota")
	}
	if !l.AllowMessage(b) {
		t.Fatal("user b's mail must not be refused because user a was flooded")
	}
}

// ---------------------------------------------------------------------------
// Notice bounding
// ---------------------------------------------------------------------------

// The user-scoped diagnostics row is a NOTICE, and one notice says everything a
// hundred identical ones do. Unbounded, it is a storage-amplification bug with
// the same shape the aggregated smtp_rejections counter exists to prevent.
func TestNoticesAreBoundedPerUserPerReasonPerWindow(t *testing.T) {
	c := newClock()
	l := NewLimiter(LimiterConfig{Notices: 3, DailyWindow: 24 * time.Hour, Now: c.now})
	u := uuid.New()
	allowed := 0
	for i := 0; i < 500; i++ {
		if l.Notice(u, diag.RejectOverQuota) {
			allowed++
		}
	}
	if allowed != 3 {
		t.Fatalf("notices per user per reason per window = %d, want 3", allowed)
	}
	// A different reason is a different fact and keeps its own budget.
	if !l.Notice(u, diag.RejectTooLarge) {
		t.Fatal("a different rejection reason must not be starved by another's flood")
	}
	c.advance(25 * time.Hour)
	if !l.Notice(u, diag.RejectOverQuota) {
		t.Fatal("a window later the notice budget must be fresh")
	}
}

// ---------------------------------------------------------------------------
// Boundedness and concurrency
// ---------------------------------------------------------------------------

// In-memory and bounded. An unbounded map keyed by attacker-chosen source
// address is a remote memory-exhaustion primitive on an open port 25.
func TestTrackedIPsAreBoundedByTheLRUCap(t *testing.T) {
	l := NewLimiter(LimiterConfig{
		Burst: 1, Base: time.Millisecond, Window: time.Hour,
		Disconnect: 3, MaxIPs: 64,
	})
	for i := 0; i < 5000; i++ {
		l.InvalidRcpt(netip.AddrFrom4([4]byte{10, byte(i >> 8), byte(i), 1}))
	}
	if n := l.TrackedIPs(); n > 64 {
		t.Fatalf("tracked IPs = %d, must not exceed the cap of 64", n)
	}
}

func TestTrackedUsersAreBoundedByTheLRUCap(t *testing.T) {
	l := NewLimiter(LimiterConfig{Daily: 1, DailyWindow: 24 * time.Hour, MaxUsers: 32})
	for i := 0; i < 2000; i++ {
		l.AllowMessage(uuid.New())
	}
	if n := l.TrackedUsers(); n > 32 {
		t.Fatalf("tracked users = %d, must not exceed the cap of 32", n)
	}
}

// Every connection runs in its own goroutine, so every limiter call races every
// other one. The pool is warmed first so the assertion is about contention, not
// about first-touch allocation.
func TestLimiterIsSafeUnderConcurrentUse(t *testing.T) {
	l := NewLimiter(LimiterConfig{
		Burst: 1 << 20, Base: time.Millisecond, Window: time.Hour, Disconnect: 1 << 30,
		Daily: 1 << 20, DailyWindow: 24 * time.Hour,
	})
	ip := addr("192.0.2.10")
	u := uuid.New()
	l.InvalidRcpt(ip)
	l.AllowMessage(u)

	const workers, each = 8, 200
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				l.InvalidRcpt(ip)
				l.Blocked(ip)
				l.AllowMessage(u)
				l.Notice(u, diag.RejectOverQuota)
			}
		}()
	}
	wg.Wait()
}

// Concurrency must not over-issue quota either: the allowance is a limit, not a
// suggestion, and a check-then-act split across goroutines silently exceeds it.
func TestConcurrentAllowMessageIssuesExactlyTheAllowance(t *testing.T) {
	const allowance = 50
	l := NewLimiter(LimiterConfig{Daily: allowance, DailyWindow: 24 * time.Hour})
	u := uuid.New()
	l.Notice(u, diag.RejectOverQuota) // warm the entry

	var mu sync.Mutex
	granted := 0
	var wg sync.WaitGroup
	for w := 0; w < 16; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				if l.AllowMessage(u) {
					mu.Lock()
					granted++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	if granted != allowance {
		t.Fatalf("granted %d messages concurrently, allowance is %d", granted, allowance)
	}
}

// Defaults exist because NewLimiter is called with a partially-filled config in
// production too (config.MailConfig carries four of these knobs, not nine), and
// a zero Disconnect threshold would drop every connection on its first typo.
func TestZeroConfigFieldsFallBackToTheDocumentedDefaults(t *testing.T) {
	l := NewLimiter(LimiterConfig{})
	ip := addr("192.0.2.11")
	for i := 0; i < DefaultInvalidRcptBurst; i++ {
		if d, disc := l.InvalidRcpt(ip); d != 0 || disc {
			t.Fatalf("call %d inside the default burst: delay %v disconnect %v", i, d, disc)
		}
	}
	if d, _ := l.InvalidRcpt(ip); d != 2*DefaultTarpitBase {
		t.Fatalf("first tarpitted delay = %v, want %v", d, 2*DefaultTarpitBase)
	}
	u := uuid.New()
	for i := 0; i < DefaultPerAddressDaily; i++ {
		if !l.AllowMessage(u) {
			t.Fatalf("message %d is inside the default allowance", i+1)
		}
	}
	if l.AllowMessage(u) {
		t.Fatalf("message %d exceeds the default allowance", DefaultPerAddressDaily+1)
	}
}
