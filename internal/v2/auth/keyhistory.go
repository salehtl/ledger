package auth

// keyhistory.go is the READ side of the append-only key-history log.
//
// It exists because for the whole of Phase 1 there was no read side. The log
// was written on every registration, every revocation and every ingest-writer
// creation (appendKeyHistory in writer.go), guarded by two triggers against
// rewrite and truncation, and then never selected by a single line of
// production code. Spec §3.4 and §2:176 both tell the user that peer devices
// detect key substitution by comparing this log across devices, and §2 is the
// text the alpha privacy page is drawn from — so the log being unreachable was
// not a missing feature, it was a promise the system could not keep.
//
// # What the server may and may not do here
//
// It may serve the log. It may NOT compute the comparison code. The whole
// premise of §3.4's detection is that the operator's own server is the thing
// being audited, so a code the server calculated would be a code the server
// could choose; only a digest each device computes over material it fetched
// itself, and that two users compare out of band, detects anything. This file
// therefore returns entries and no digest, and the ordering below is part of
// the contract precisely so that two honest devices hash the same bytes.

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// KeyHistoryEntry is one append-only log row.
//
// PubKey is nil for the keyless ingest writer, which is a fact a peer needs:
// "a writer with no key was added" and "a writer with THIS key was added" are
// different events, and collapsing them would let a substitution hide behind a
// missing field.
type KeyHistoryEntry struct {
	// ID is the log position. It is monotonic per user and is what makes "the
	// head" a well-defined thing to hash.
	ID       int64
	WriterID string
	PubKey   ed25519.PublicKey
	// Event is [EventRegistered] or [EventRevoked].
	Event string
	At    time.Time
}

// KeyHistory returns a user's whole key-history log, OLDEST FIRST.
//
// Oldest first, and complete, both deliberately:
//
//   - A peer audits the log by replaying it, so it needs every entry, not the
//     current roster (which [Writers.Roster] already serves) and not a page.
//     The log is bounded by how many devices a person has ever enrolled or
//     retired — tens over an account's life — so there is nothing to paginate.
//
//   - Ascending id means the LAST element is the head. A descending order would
//     put the head first and read more naturally, and would also mean that a
//     server omitting the tail of the log produced a prefix that still hashed
//     to something a client might accept as a valid earlier state. Ascending
//     makes a truncation change the head, which is the value being compared.
func (w *Writers) KeyHistory(ctx context.Context, userID uuid.UUID) ([]KeyHistoryEntry, error) {
	if w == nil || w.Pool == nil {
		return nil, errors.New("auth: Writers.Pool is nil")
	}
	rows, err := w.Pool.Query(ctx,
		`SELECT id, writer_id, pubkey, event, at
		   FROM key_history WHERE user_id = $1 ORDER BY id`, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: key history for user %s: %w", userID, err)
	}
	defer rows.Close()

	var out []KeyHistoryEntry
	for rows.Next() {
		var (
			e   KeyHistoryEntry
			key []byte
		)
		if err := rows.Scan(&e.ID, &e.WriterID, &key, &e.Event, &e.At); err != nil {
			return nil, fmt.Errorf("auth: scan key history entry: %w", err)
		}
		if key != nil {
			e.PubKey = ed25519.PublicKey(key)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: key history for user %s: %w", userID, err)
	}
	return out, nil
}
