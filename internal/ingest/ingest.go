// Package ingest owns reading the dedicated mailbox and recording every message
// in ingest_log. It does NOT parse: Milestone 2 stores raw bodies + envelope
// metadata with parse_status "unparsed"; the parse cascade arrives in M3.
//
// The Worker holds all the testable logic and depends on the Mailbox/Dialer
// interfaces (the I/O seam). The real IMAP implementation lives in imap.go.
package ingest

import (
	"context"
	"time"
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
