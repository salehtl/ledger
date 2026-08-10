package smtpd

import (
	"context"
	"time"

	"github.com/google/uuid"
	"ledger/internal/v2/budget"
)

// The two kinds of USER-SCOPED counter the limiter holds, mirroring
// smtp_user_counters.kind (migration 00032).
const (
	// CounterKindMessages is [Limiter.AllowMessage]'s daily allowance.
	CounterKindMessages = "messages"
	// CounterKindNotice is one of the per-reason notice budgets
	// [Limiter.Notice] spends. Its Reason is the diag reject reason.
	CounterKindNotice = "notice"
)

// UserCounter is one user-scoped rolling-window counter, flattened to the
// scalars that ARE its state.
//
// # Why this is faithful rather than a summary
//
// The obvious worry is that a persisted allowance is not a calendar day, and it
// is not: [counter] is a decaying rolling window. But the counter's ENTIRE
// state is (start, cur, prev), and both roll and weighted are pure functions of
// (start, cur, prev, now, window). So a row read back after any gap produces
// precisely the number the process would have produced had it never stopped —
// including the two boundary cases roll handles, where one window of silence
// shifts cur into prev and two windows of silence ages everything to zero.
// Nothing is approximated and nothing is stored the limiter cannot use.
//
// WindowSeconds travels WITH the state because that is what makes the claim
// checkable. cur, prev and start only mean something under the window they were
// accumulated at, so a row whose window differs from the running configuration
// is not convertible: [Limiter.Restore] DISCARDS it rather than rescaling it. A
// discarded row costs one account one window of leniency, once, at a
// configuration change. Reinterpreting it would silently mis-state every
// account's allowance with no way to notice.
type UserCounter struct {
	UserID uuid.UUID
	// Kind is CounterKindMessages or CounterKindNotice.
	Kind string
	// Reason is the diag reject reason a notice counter is keyed by, and "" for
	// a messages counter. The pairing is a CHECK constraint on the table.
	Reason string
	// WindowSeconds is the window these counts were accumulated at.
	WindowSeconds int
	// WindowStart, Cur and Prev are counter.start, counter.cur and counter.prev.
	WindowStart time.Time
	Cur, Prev   int64
}

// CounterStore is where the user-scoped counters are persisted between runs.
//
// It is an interface for the same reason [Diagnostics] is: the backup relay
// (Task 35) runs this receiver on a box with no Postgres and no user rows at
// all, so it supplies none and the limiter simply stays in memory. A nil store
// is a supported deployment, not a misconfiguration.
//
// # What is NOT here, deliberately
//
// The per-source (IP) tarpit counters. That map is keyed by a value the
// attacker chooses — the source address folded to a /64 — on a port anybody can
// reach, so persisting it would convert an LRU-bounded in-memory map into an
// unbounded, remotely-writable table: a storage-amplification primitive
// attached to the very control that exists to stop one. The user-scoped
// counters are safe to persist for the mirror-image reason: a row can only
// exist for a RESOLVED recipient, so the table is bounded by the number of real
// accounts.
type CounterStore interface {
	// LoadUserCounters reads every stored counter. Rows for users that no
	// longer exist need not be returned.
	LoadUserCounters(ctx context.Context) ([]UserCounter, error)
	// SaveUserCounters upserts the whole snapshot. A row naming a user that no
	// longer exists must be skipped rather than reported as an error.
	SaveUserCounters(ctx context.Context, rows []UserCounter) error
}

// Refusals counts a refusal against the account it was applied to.
//
// Counts only — no sender, no address, no size — matching account_refusals
// (migration 00031). It is what keeps the promise that nothing is silently
// dropped: the user's own app can say "N messages were turned away today".
//
// Like [CounterStore] it is optional, for the relay deployment that has no
// database to count into.
type Refusals interface {
	// CountRefusals adds n to (userID, today, resource). resource is one of the
	// Refusal* constants below.
	CountRefusals(ctx context.Context, userID uuid.UUID, resource string, n int64) error
}

// Suspensions answers whether an account is currently suspended.
//
// Separate from [Resolver] on purpose. Resolve's contract is one sentinel for
// every rejection so the receiver cannot rebuild an enumeration oracle out of
// it; suspension is not a rejection of the ADDRESS, it is a temporary refusal
// for an address that exists, and folding it into Resolve would either corrupt
// that contract or hide the difference from this package.
//
// A nil Suspensions means no account is suspended, which is the correct
// behaviour for the relay: it holds no user rows and cannot answer the
// question, and refusing everything because it cannot look would be an outage.
type Suspensions interface {
	// Suspended reports whether userID's account is suspended. An error is an
	// error, never a false — see [session.Rcpt], which answers a temporary
	// failure rather than guessing.
	Suspended(ctx context.Context, userID uuid.UUID) (bool, error)
}

// The account_refusals resources this package produces: the subset of that
// column's closed set an SMTP refusal can be.
//
// They are ALIASES of the budget package's names rather than their own string
// literals, because budget is the one writer of account_refusals and validates
// the resource against the closed set before writing. A literal here that
// budget did not know about would be rejected at write time, inside a buffered
// retry loop, forever — so the two lists cannot be allowed to disagree.
const (
	// RefusalSMTPDaily is the per-user daily message allowance.
	RefusalSMTPDaily = budget.ResourceSMTPDaily
	// RefusalSuspended is a refusal because the account is suspended.
	RefusalSuspended = budget.ResourceSuspended
)

// Snapshot flattens every user-scoped counter to rows for a [CounterStore].
//
// Counters that hold nothing are omitted: an all-zero row restores to the same
// state an absent row does, and writing them would make the table's size the
// number of accounts ever seen rather than the number currently spending.
func (l *Limiter) Snapshot() []UserCounter {
	l.mu.Lock()
	defer l.mu.Unlock()
	win := int(l.cfg.DailyWindow / time.Second)
	var out []UserCounter
	l.users.each(func(id uuid.UUID, st *userState) {
		if st.msgs.start.IsZero() || (st.msgs.cur == 0 && st.msgs.prev == 0) {
			// nothing to persist
		} else {
			out = append(out, UserCounter{
				UserID: id, Kind: CounterKindMessages, WindowSeconds: win,
				WindowStart: st.msgs.start, Cur: st.msgs.cur, Prev: st.msgs.prev,
			})
		}
		for reason, c := range st.notices {
			if c == nil || c.start.IsZero() || (c.cur == 0 && c.prev == 0) {
				continue
			}
			out = append(out, UserCounter{
				UserID: id, Kind: CounterKindNotice, Reason: reason, WindowSeconds: win,
				WindowStart: c.start, Cur: c.cur, Prev: c.prev,
			})
		}
	})
	return out
}

// Restore loads counters saved by a previous run and reports how many were
// applied.
//
// It is for STARTUP, before the listener accepts anything, and it says so by
// refusing to overwrite: a counter that already holds state is left alone. A
// stored row is by definition older than anything the running process has
// counted, so pasting it over live state could only ever discard counts that
// were actually spent — which is the one direction this whole mechanism must
// never move in.
//
// Rows it discards, each silently because each is a data condition rather than
// a failure:
//
//   - a window that does not match the running DailyWindow. See [UserCounter]:
//     the state is not convertible, and rescaling it would invent an allowance.
//   - a kind this package does not define, or a notice row past
//     maxNoticeReasons — the same bound the live map carries, applied to
//     restored rows so a table someone edited cannot grow it.
//   - a zero user id, a zero window start, or a negative count.
func (l *Limiter) Restore(rows []UserCounter) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	want := int(l.cfg.DailyWindow / time.Second)
	n := 0
	for _, r := range rows {
		if r.UserID == uuid.Nil || r.WindowStart.IsZero() || r.Cur < 0 || r.Prev < 0 {
			continue
		}
		if r.WindowSeconds != want {
			continue
		}
		if r.Cur > counterCeiling || r.Prev > counterCeiling {
			continue
		}
		st := l.users.getOrAdd(r.UserID, newUserState)
		var c *counter
		switch r.Kind {
		case CounterKindMessages:
			if r.Reason != "" {
				continue
			}
			c = &st.msgs
		case CounterKindNotice:
			if r.Reason == "" {
				continue
			}
			if existing, ok := st.notices[r.Reason]; ok {
				c = existing
			} else {
				if len(st.notices) >= maxNoticeReasons {
					continue
				}
				c = &counter{}
				st.notices[r.Reason] = c
			}
		default:
			continue
		}
		if !c.start.IsZero() {
			// Already live. See the doc: never overwrite.
			continue
		}
		c.start, c.cur, c.prev = r.WindowStart, r.Cur, r.Prev
		n++
	}
	return n
}
