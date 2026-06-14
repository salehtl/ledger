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

// Worker ingests the mailbox into the store. It depends on a Dialer (the I/O
// seam) and the concrete store. now is injectable for deterministic tests.
type Worker struct {
	dialer   Dialer
	store    *store.Store
	interval time.Duration
	log      *log.Logger
	now      func() time.Time
}

// New builds a Worker. interval is the poll cadence; logger receives operational
// messages.
func New(d Dialer, st *store.Store, interval time.Duration, logger *log.Logger) *Worker {
	return &Worker{
		dialer:   d,
		store:    st,
		interval: interval,
		log:      logger,
		now:      time.Now,
	}
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
	return inserted, nil
}
