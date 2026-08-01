package smtpd

import (
	"container/list"
	"net/netip"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Defaults for every LimiterConfig field. config.MailConfig carries four of
// these knobs (per_address_daily, invalid_rcpt_burst, tarpit_base,
// max_message_bytes); the rest are policy constants rather than deployment
// settings, and a zero value for any of them must never mean "no limit" —
// a zero disconnect threshold would drop every connection on its first typo.
const (
	// DefaultInvalidRcptBurst is how many invalid recipients an address gets
	// for free before the tarpit engages. A misconfigured forwarder or a stale
	// bank-side registration produces a handful; a sweep produces thousands.
	DefaultInvalidRcptBurst = 5
	// DefaultTarpitBase is the first doubling step. Spec §3.2 wants the sweep
	// to be expensive, not the mistake.
	DefaultTarpitBase = 2 * time.Second
	// DefaultTarpitMax caps the doubling. Without a cap the tarpit becomes the
	// attacker's tool: each held connection costs us a goroutine and a file
	// descriptor for as long as they like.
	DefaultTarpitMax = 30 * time.Second
	// DefaultInvalidRcptWindow is the rolling window invalid recipients are
	// counted over.
	DefaultInvalidRcptWindow = time.Hour
	// DefaultDisconnectAfter is the invalid-recipient count in one window past
	// which connections from that source are dropped immediately.
	DefaultDisconnectAfter = 20
	// DefaultPerAddressDaily is spec §3.2's ~50 messages/day. Bank alerts are
	// single digits; the rest is an attack.
	DefaultPerAddressDaily = 50
	// DefaultQuotaWindow is the rolling window the daily allowance spans.
	DefaultQuotaWindow = 24 * time.Hour
	// DefaultNoticesPerWindow bounds the USER-SCOPED diagnostics rows one
	// refusal reason may produce for one user in a window. See [Limiter.Notice].
	DefaultNoticesPerWindow = 8
	// DefaultMaxTrackedIPs and DefaultMaxTrackedUsers bound the two maps. An
	// unbounded map keyed by an attacker-chosen source address is a remote
	// memory-exhaustion primitive on an open port 25.
	DefaultMaxTrackedIPs   = 10000
	DefaultMaxTrackedUsers = 10000

	// maxNoticeReasons bounds the per-user notice map. diag's reject-reason
	// enum is closed and smaller than this; the bound exists so that a future
	// caller passing something else cannot grow the map without limit.
	maxNoticeReasons = 8

	// counterCeiling stops a counter from growing without bound under a
	// sustained flood. Every threshold in this file is far below it, so
	// saturating changes no decision — it only keeps the arithmetic finite.
	counterCeiling = 1 << 30
)

// LimiterConfig configures a [Limiter]. Every zero field takes the
// corresponding Default constant above.
type LimiterConfig struct {
	// Burst, Base, Max, Window and Disconnect govern the per-source
	// invalid-recipient tarpit.
	Burst      int
	Base       time.Duration
	Max        time.Duration
	Window     time.Duration
	Disconnect int

	// Daily and DailyWindow govern the per-user message allowance, and
	// Notices bounds the user-scoped diagnostics rows a refusal may write.
	Daily       int
	DailyWindow time.Duration
	Notices     int

	MaxIPs   int
	MaxUsers int

	// Now defaults to time.Now.
	Now func() time.Time
}

func (c LimiterConfig) withDefaults() LimiterConfig {
	if c.Burst <= 0 {
		c.Burst = DefaultInvalidRcptBurst
	}
	if c.Base <= 0 {
		c.Base = DefaultTarpitBase
	}
	if c.Max <= 0 {
		c.Max = DefaultTarpitMax
	}
	if c.Window <= 0 {
		c.Window = DefaultInvalidRcptWindow
	}
	if c.Disconnect <= 0 {
		c.Disconnect = DefaultDisconnectAfter
	}
	if c.Daily <= 0 {
		c.Daily = DefaultPerAddressDaily
	}
	if c.DailyWindow <= 0 {
		c.DailyWindow = DefaultQuotaWindow
	}
	if c.Notices <= 0 {
		c.Notices = DefaultNoticesPerWindow
	}
	if c.MaxIPs <= 0 {
		c.MaxIPs = DefaultMaxTrackedIPs
	}
	if c.MaxUsers <= 0 {
		c.MaxUsers = DefaultMaxTrackedUsers
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c
}

// Limiter is the receiver's two nuisance controls: a per-source
// invalid-recipient tarpit and a per-user message allowance.
//
// # What it is and is not
//
// It is IN-MEMORY and bounded, and a restart resets it. That is acceptable
// because it is a nuisance control, not a security boundary: the actual
// boundary is that an unknown recipient is never accepted, and that the address
// token carries 128 bits of entropy. Nothing here is load bearing for
// confidentiality.
//
// # What the tarpit actually buys, measured
//
// Stated precisely, because the obvious claim is wrong. The delay is imposed on
// ONE connection's goroutine, so a sweeper who opens several connections in
// parallel pays the delays concurrently rather than in sequence: eight probes
// over eight connections were measured at 10.0s against 12.7s serialized, and
// with production settings a full budget costs about 30s in parallel against
// about 330s in series. So the tarpit raises the cost of a sweep by a constant
// factor bounded by how many connections the attacker can open — it does not
// make a sweep expensive on its own.
//
// The thing that actually bounds a sweep is the pair of hard limits either side
// of it: the Disconnect threshold, after which Blocked refuses that source
// without so much as a database lookup for the rest of the window, and the
// per-source connection cap in smtpd, which is what stops the parallelism that
// would otherwise divide the delay away.
//
// # Order of checks
//
// Per-caller first, shared resource second. [Limiter.Blocked] is a read-only
// pre-check the receiver runs BEFORE the recipient lookup, so a source that has
// already earned a disconnect costs no database work. A limiter consulted after
// the expensive step does not limit the expensive step — and a shared budget
// spent before a per-caller check is drainable by a single host, which locks
// every legitimate sender out at once.
type Limiter struct {
	cfg LimiterConfig

	mu    sync.Mutex
	ips   *lru[netip.Addr, *ipState]
	users *lru[uuid.UUID, *userState]
}

type ipState struct {
	invalid counter
}

type userState struct {
	msgs counter
	// notices is keyed by diag reject reason. Bounded by maxNoticeReasons.
	notices map[string]*counter
}

// NewLimiter builds a limiter. A zero field takes its documented default.
func NewLimiter(cfg LimiterConfig) *Limiter {
	c := cfg.withDefaults()
	return &Limiter{
		cfg:   c,
		ips:   newLRU[netip.Addr, *ipState](c.MaxIPs),
		users: newLRU[uuid.UUID, *userState](c.MaxUsers),
	}
}

// InvalidRcpt records one REFUSED recipient from ip and reports how long to
// stall before replying, and whether to drop the connection instead.
//
// "Invalid" here means "one this server would not accept", which covers both a
// recipient that does not exist and one whose owner is over their allowance.
// Both are metered together on purpose: an unmetered refusal branch is a free
// loop, and the over-quota branch was measured at 5,396 refusals per second
// from a single socket while it had one.
//
// The delay is Base * 2^(n-Burst) capped at Max, where n is that source's
// refusal count in the rolling window; the first Burst are free. Past the
// disconnect threshold the delay is zero and disconnect is true — "drop it
// immediately" rather than "stall then drop", because at that point the
// connection is worth nothing to us and the goroutine is better spent elsewhere.
func (l *Limiter) InvalidRcpt(ip netip.Addr) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.cfg.Now()
	st := l.ips.getOrAdd(sourceKey(ip), func() *ipState { return &ipState{} })
	n := st.invalid.add(now, l.cfg.Window)
	if n >= int64(l.cfg.Disconnect) {
		return 0, true
	}
	if n <= int64(l.cfg.Burst) {
		return 0, false
	}
	return l.tarpit(n), false
}

// Blocked reports whether ip is already past the disconnect threshold. It
// records nothing: this is the pre-check that runs before the recipient lookup,
// and a pre-check that fed the counter it reads would escalate on its own.
func (l *Limiter) Blocked(ip netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.ips.get(sourceKey(ip))
	if !ok {
		return false
	}
	return st.invalid.estimate(l.cfg.Now(), l.cfg.Window) >= int64(l.cfg.Disconnect)
}

// AllowMessage reports whether another message may be accepted for userID, and
// consumes one unit of the allowance when it says yes.
//
// It is keyed on the RESOLVED USER, never on the recipient string.
// addresses.Resolve folds case and strips brackets and does not hand back the
// normalized local part, so a quota keyed on the raw RCPT would hand one
// mailbox 2^26 distinct buckets and be bypassable by typing the address in a
// different case. Keying on the user also means a rotated address and its
// 7-day grace predecessor share one allowance instead of doubling it.
//
// A refusal does NOT consume the allowance. If it did, an attacker who blew
// through it could hold it blown indefinitely by continuing to send, turning a
// rate limit into an off switch for that user's mail.
func (l *Limiter) AllowMessage(userID uuid.UUID) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.cfg.Now()
	st := l.users.getOrAdd(userID, newUserState)
	if st.msgs.estimate(now, l.cfg.DailyWindow) >= int64(l.cfg.Daily) {
		return false
	}
	st.msgs.add(now, l.cfg.DailyWindow)
	return true
}

// ReleaseMessage returns a unit taken by AllowMessage for a message that was
// never delivered.
//
// This is what stops the allowance from being a remote off switch for a user's
// mail. The unit has to be taken at RCPT — checking at RCPT is the whole reason
// an over-quota sender never gets to transfer a megabyte — but a transaction
// that is then abandoned has cost the user nothing, and charging for it means
// `MAIL / RCPT / RSET` in a loop burns a stranger's entire day in a few
// milliseconds with no message ever sent. Every path that ends a transaction
// without a delivery gives the unit back: RSET, a new MAIL, logout, a refused
// or oversized body.
//
// The allowance therefore counts DELIVERED messages. Refusals are metered
// separately, by the per-source counter InvalidRcpt drives — a nuisance control
// belongs on the nuisance, not on the recipient's mailbox.
func (l *Limiter) ReleaseMessage(userID uuid.UUID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.users.get(userID)
	if !ok {
		return
	}
	st.msgs.sub(l.cfg.Now(), l.cfg.DailyWindow)
}

// ReleaseNotice returns a permit taken by Notice for a diagnostics row that
// then failed to be written.
//
// Without it the notice budget is spent by failures, and a server whose
// database is down burns all 8 permits on rows that never landed — after which
// Notice answers "already told them" for a user who was never told anything.
// That is the exact input the receiver uses to decide whether a refusal left a
// trace, so it has to mean what it says.
func (l *Limiter) ReleaseNotice(userID uuid.UUID, reason string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.users.get(userID)
	if !ok {
		return
	}
	if c := st.notices[reason]; c != nil {
		c.sub(l.cfg.Now(), l.cfg.DailyWindow)
	}
}

// Notice reports whether this refusal should also write a USER-SCOPED
// diagnostics row, as opposed to only incrementing the aggregate counter.
//
// One notice says everything a hundred identical ones do, and an unbounded
// number of them is a storage-amplification bug with exactly the shape the
// aggregated smtp_rejections table exists to prevent for unknown recipients:
// anyone holding one valid address could grow parse_diagnostics without limit.
// The bound is per user, per reason, per window, and it is deliberately larger
// than a legitimate day's mail so a real problem is never hidden by it.
func (l *Limiter) Notice(userID uuid.UUID, reason string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.cfg.Now()
	st := l.users.getOrAdd(userID, newUserState)
	c, ok := st.notices[reason]
	if !ok {
		if len(st.notices) >= maxNoticeReasons {
			return false
		}
		c = &counter{}
		st.notices[reason] = c
	}
	if c.estimate(now, l.cfg.DailyWindow) >= int64(l.cfg.Notices) {
		return false
	}
	c.add(now, l.cfg.DailyWindow)
	return true
}

// TrackedIPs and TrackedUsers report the current map sizes. They exist so the
// LRU bound is an assertion rather than a claim.
func (l *Limiter) TrackedIPs() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ips.len()
}

func (l *Limiter) TrackedUsers() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.users.len()
}

func newUserState() *userState { return &userState{notices: map[string]*counter{}} }

// tarpit computes Base * 2^(n-Burst), saturating at Max. The shift is bounded
// before it is applied: n is attacker-driven, and an unbounded shift on an
// int64 wraps to a negative duration, which would turn the tarpit into an
// instant reply.
func (l *Limiter) tarpit(n int64) time.Duration {
	shift := n - int64(l.cfg.Burst)
	if shift < 1 {
		return 0
	}
	if shift > 62 {
		return l.cfg.Max
	}
	d := l.cfg.Base
	for i := int64(0); i < shift; i++ {
		d *= 2
		if d <= 0 || d >= l.cfg.Max {
			return l.cfg.Max
		}
	}
	return d
}

// sourceKey folds a remote address to the unit a limit should apply to.
//
// Two foldings, both of which are bypasses if omitted. A v4-mapped v6 address
// (::ffff:203.0.113.9) is the same host as the plain v4 form, and keying them
// apart doubles every budget for free. And a single IPv6 allocation is a /64:
// counting per-address there is counting per-attempt, because the attacker has
// 2^64 of them and the tarpit never engages. The cost is that hosts sharing a
// /64 — or, as with IPv4 NAT, a single public address — share a budget. That is
// the same trade every per-IP control makes, and the refusals it produces are
// temporary (421/550 with retry), never a permanent bounce.
func sourceKey(ip netip.Addr) netip.Addr {
	ip = ip.Unmap()
	if ip.Is6() {
		if p, err := ip.Prefix(64); err == nil {
			return p.Addr()
		}
	}
	return ip
}

// ---------------------------------------------------------------------------
// counter: a fixed-memory rolling-window count
// ---------------------------------------------------------------------------

// counter approximates a rolling-window count in O(1) memory: the current
// window's count plus the previous window's, the latter weighted by how much of
// it still lies inside the trailing window.
//
// The alternative — a timestamp per event — is unbounded memory driven by an
// attacker's send rate, on the one port that anyone can reach. A tumbling
// window would be bounded too, but it lets a sweeper take a fresh burst
// allowance at every window boundary and time their traffic to sit astride one.
type counter struct {
	start time.Time
	cur   int64
	prev  int64
}

// roll advances the bucket pair so that start is within one window of now.
func (c *counter) roll(now time.Time, window time.Duration) {
	if c.start.IsZero() {
		c.start = now
		return
	}
	elapsed := now.Sub(c.start)
	switch {
	case elapsed < window:
		// Still inside the current bucket.
	case elapsed < 2*window:
		c.prev, c.cur = c.cur, 0
		c.start = c.start.Add(window)
	default:
		// More than two windows of silence: everything has aged out.
		c.prev, c.cur = 0, 0
		c.start = now
	}
}

// weighted is the count at now. roll must have run first.
func (c *counter) weighted(now time.Time, window time.Duration) int64 {
	if c.prev == 0 {
		return c.cur
	}
	elapsed := now.Sub(c.start)
	if elapsed < 0 {
		elapsed = 0
	}
	w := 1 - float64(elapsed)/float64(window)
	if w <= 0 {
		return c.cur
	}
	return c.cur + int64(float64(c.prev)*w)
}

func (c *counter) estimate(now time.Time, window time.Duration) int64 {
	c.roll(now, window)
	return c.weighted(now, window)
}

// add records one event and returns the resulting count.
func (c *counter) add(now time.Time, window time.Duration) int64 {
	c.roll(now, window)
	if c.cur < counterCeiling {
		c.cur++
	}
	return c.weighted(now, window)
}

// sub gives one event back. It exists for RESERVATIONS: a unit of an allowance
// taken when a transaction starts and returned when that transaction turns out
// not to have delivered anything. It clamps at zero rather than going negative,
// because a reservation taken in one bucket can be released after the window
// has rolled, and a negative count would hand out free allowance later.
func (c *counter) sub(now time.Time, window time.Duration) {
	c.roll(now, window)
	switch {
	case c.cur > 0:
		c.cur--
	case c.prev > 0:
		c.prev--
	}
}

// ---------------------------------------------------------------------------
// lru: a bounded map with least-recently-used eviction
// ---------------------------------------------------------------------------

type lruEntry[K comparable, V any] struct {
	key K
	val V
}

type lru[K comparable, V any] struct {
	max int
	ll  *list.List
	m   map[K]*list.Element
}

func newLRU[K comparable, V any](max int) *lru[K, V] {
	return &lru[K, V]{max: max, ll: list.New(), m: make(map[K]*list.Element)}
}

func (l *lru[K, V]) get(k K) (V, bool) {
	if e, ok := l.m[k]; ok {
		l.ll.MoveToFront(e)
		return e.Value.(*lruEntry[K, V]).val, true
	}
	var zero V
	return zero, false
}

// getOrAdd returns the value for k, creating it with mk if absent, and
// evicts the least recently used entry when the map is over its cap.
//
// Eviction is a real, accepted weakness: a flood from many sources evicts the
// entry tracking an ongoing abuser and hands them a fresh burst. It is the
// bounded-memory half of the trade, and it is why this is a nuisance control
// rather than a boundary. The user map is not exposed to it in the same way —
// only a RESOLVED recipient creates an entry there, so its size is bounded by
// the number of real accounts rather than by anything an attacker chooses.
func (l *lru[K, V]) getOrAdd(k K, mk func() V) V {
	if e, ok := l.m[k]; ok {
		l.ll.MoveToFront(e)
		return e.Value.(*lruEntry[K, V]).val
	}
	v := mk()
	l.m[k] = l.ll.PushFront(&lruEntry[K, V]{key: k, val: v})
	for l.ll.Len() > l.max {
		back := l.ll.Back()
		if back == nil {
			break
		}
		l.ll.Remove(back)
		delete(l.m, back.Value.(*lruEntry[K, V]).key)
	}
	return v
}

func (l *lru[K, V]) len() int { return l.ll.Len() }
