// Package ingest owns reading the dedicated mailbox and recording every message
// in ingest_log. It does NOT parse: Milestone 2 stores raw bodies + envelope
// metadata with parse_status "unparsed"; the parse cascade arrives in M3.
//
// The Worker holds all the testable logic and depends on the Mailbox/Dialer
// interfaces (the I/O seam). The real IMAP implementation lives in imap.go.
package ingest

import (
	"context"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"ledger/internal/store"
)

// Message is one email as the worker needs it: the IMAP UID, envelope metadata,
// and the full raw RFC822 body (never discarded, so a future parser can backfill).
type Message struct {
	UID        uint32
	From       string
	Subject    string
	ReceivedAt time.Time
	Raw        []byte
}

// HealthSnapshot is a point-in-time view of the worker's polling health,
// read by /api/health. All state is in-memory: it rebuilds within one poll
// of a restart, so it is deliberately not persisted.
type HealthSnapshot struct {
	StartedAt           time.Time     // when the worker was constructed; anchors the "starting" grace window
	LastAttemptAt       time.Time     // zero until the first poll completes or fails
	LastSuccessAt       time.Time     // zero until the first successful poll
	ConsecutiveFailures int
	LastError           string // "" when the last poll succeeded
	Interval            time.Duration
}

// Mailbox is a read-only view of one IMAP mailbox. Implementations open with
// EXAMINE so the app can never alter mail.
type Mailbox interface {
	// Examine opens the mailbox read-only and returns its UIDVALIDITY.
	Examine(ctx context.Context) (uidValidity uint32, err error)
	// ListUIDs returns every message UID currently in the mailbox.
	ListUIDs(ctx context.Context) ([]uint32, error)
	// Fetch returns the full message for one UID.
	Fetch(ctx context.Context, uid uint32) (Message, error)
	// Close releases the connection.
	Close() error
}

// Dialer opens a fresh Mailbox. The worker dials per sync cycle, so reconnects
// are automatic.
type Dialer interface {
	Dial(ctx context.Context) (Mailbox, error)
}

// Waiter blocks until the mailbox signals new mail or a timeout passes.
// Wait returns nil when it is time to sync again (a new-mail signal or the
// timeout elapsing — callers treat both the same) and a non-nil error on
// cancellation or connection failure. Close releases the connection.
type Waiter interface {
	Wait(ctx context.Context, timeout time.Duration) error
	Close() error
}

// IdleDialer opens a Waiter: a dedicated connection that can park in IMAP
// IDLE between syncs. Optional — without one the worker is purely poll-driven.
type IdleDialer interface {
	DialIdle(ctx context.Context) (Waiter, error)
}

// Worker ingests the mailbox into the store. It depends on a Dialer (the I/O
// seam) and the concrete store. now is injectable for deterministic tests.
type Worker struct {
	dialer      Dialer
	store       *store.Store
	interval    time.Duration
	log         *log.Logger
	now         func() time.Time
	postProcess func(ctx context.Context) (int, error)
	idle        IdleDialer
	healthMu    sync.Mutex
	health      HealthSnapshot
}

// New builds a Worker. interval is the poll cadence; logger receives operational
// messages.
func New(d Dialer, st *store.Store, interval time.Duration, logger *log.Logger) *Worker {
	w := &Worker{
		dialer:   d,
		store:    st,
		interval: interval,
		log:      logger,
		now:      time.Now,
	}
	w.health = HealthSnapshot{StartedAt: w.now().UTC(), Interval: interval}
	return w
}

// SetPostProcess registers a hook run at the end of each sync (e.g. the parse
// processor). It runs even when no new messages arrived, so a restart still
// processes any leftover unparsed rows.
func (w *Worker) SetPostProcess(fn func(ctx context.Context) (int, error)) {
	w.postProcess = fn
}

// SetIdle registers an IdleDialer. When set, the worker parks in IMAP IDLE
// between syncs and wakes early on new mail; the poll interval remains the
// fallback upper bound, so IDLE failures degrade to plain polling.
func (w *Worker) SetIdle(d IdleDialer) {
	w.idle = d
}

// Health returns a copy of the current poll-health snapshot. Safe for
// concurrent use with the polling loop.
func (w *Worker) Health() HealthSnapshot {
	w.healthMu.Lock()
	defer w.healthMu.Unlock()
	return w.health
}

// recordPoll updates the snapshot after one poll. A success resets the
// failure streak and error; a failure increments the streak.
func (w *Worker) recordPoll(err error) {
	w.healthMu.Lock()
	defer w.healthMu.Unlock()
	now := w.now().UTC()
	w.health.LastAttemptAt = now
	if err == nil {
		w.health.LastSuccessAt = now
		w.health.ConsecutiveFailures = 0
		w.health.LastError = ""
		return
	}
	w.health.ConsecutiveFailures++
	w.health.LastError = err.Error()
}

// pollOnce runs one sync and records its outcome in the health snapshot.
// Shutdown cancellation is not recorded — it is not a mailbox failure.
func (w *Worker) pollOnce(ctx context.Context) (int, error) {
	n, err := w.syncOnce(ctx)
	if ctx.Err() == nil {
		w.recordPoll(err)
	}
	return n, err
}

// syncOnce dials, examines the mailbox read-only, and writes any not-yet-seen
// messages to ingest_log oldest→newest. It returns the number of new rows.
func (w *Worker) syncOnce(ctx context.Context) (int, error) {
	mb, err := w.dialer.Dial(ctx)
	if err != nil {
		return 0, fmt.Errorf("dial: %w", err)
	}
	defer mb.Close()

	uidValidity, err := mb.Examine(ctx)
	if err != nil {
		return 0, fmt.Errorf("examine: %w", err)
	}
	uids, err := mb.ListUIDs(ctx)
	if err != nil {
		return 0, fmt.Errorf("list uids: %w", err)
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })

	known, err := w.store.KnownUIDs()
	if err != nil {
		return 0, fmt.Errorf("known uids: %w", err)
	}

	inserted := 0
	for _, uid := range uids {
		key := fmt.Sprintf("%d-%d", uidValidity, uid)
		if _, seen := known[key]; seen {
			continue
		}
		m, err := mb.Fetch(ctx, uid)
		if err != nil {
			return inserted, fmt.Errorf("fetch uid %d: %w", uid, err)
		}
		ok, err := w.store.InsertIngest(store.IngestRecord{
			MessageUID:  key,
			ReceivedAt:  m.ReceivedAt,
			FromAddr:    m.From,
			Subject:     m.Subject,
			ParseStatus: "unparsed",
			RawBody:     m.Raw,
			CreatedAt:   w.now().UTC(),
		})
		if err != nil {
			return inserted, fmt.Errorf("insert uid %d: %w", uid, err)
		}
		if ok {
			inserted++
		}
	}
	if w.postProcess != nil {
		if n, err := w.postProcess(ctx); err != nil {
			w.log.Printf("post-process error: %v", err)
		} else if n > 0 {
			w.log.Printf("parsed %d new transaction(s)", n)
		}
	}
	return inserted, nil
}

// Run syncs the mailbox until ctx is cancelled: every interval, plus (when an
// IdleDialer is set) immediately on an IDLE new-mail signal. Transient errors
// are logged and retried on the next cycle; the worker never crashes the process.
func (w *Worker) Run(ctx context.Context) {
	mode := "poll"
	if w.idle != nil {
		mode = "idle+poll"
	}
	w.log.Printf("ingest worker started (%s, interval %s)", mode, w.interval)
	for {
		n, err := w.pollOnce(ctx)
		switch {
		case ctx.Err() != nil:
			w.log.Printf("ingest worker stopping")
			return
		case err != nil:
			w.log.Printf("ingest sync error: %v", err)
		case n > 0:
			w.log.Printf("ingest: %d new message(s)", n)
		}
		if !w.waitNext(ctx) {
			w.log.Printf("ingest worker stopping")
			return
		}
	}
}

// waitNext blocks until the next sync should run. With an IdleDialer set it
// parks in IMAP IDLE and wakes early on a new-mail signal; the poll interval
// is always the upper bound, and the sole mechanism when IDLE is off or
// failing (a failed IDLE falls through to the plain timer, so the worker can
// never spin hot). Returns false when ctx was cancelled.
func (w *Worker) waitNext(ctx context.Context) bool {
	if w.idle != nil {
		wtr, err := w.idle.DialIdle(ctx)
		if err == nil {
			werr := wtr.Wait(ctx, w.interval)
			_ = wtr.Close()
			if werr == nil {
				return true // new-mail signal or interval elapsed: sync now
			}
			if ctx.Err() != nil {
				return false
			}
			w.log.Printf("idle wait error: %v (falling back to poll timer)", werr)
		} else {
			if ctx.Err() != nil {
				return false
			}
			w.log.Printf("idle dial error: %v (falling back to poll timer)", err)
		}
	}
	select {
	case <-ctx.Done():
		return false
	case <-time.After(w.interval):
		return true
	}
}
