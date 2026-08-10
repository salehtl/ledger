package pushv2

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

// Notifier is what this package's senders have in common. It is a restatement
// of ingest.Pusher, declared here so that [Multi] can hold senders without
// pushv2 importing the pipeline that consumes it.
type Notifier interface {
	Notify(ctx context.Context, userID uuid.UUID) error
}

// Multi notifies through every sender it holds.
//
// Exactly one sender exists today ([Web], the PWA audience) since the Expo
// transport was removed on 2026-08-10. This is kept rather than collapsed
// because the constraint it solves has not changed: ingest.Pipeline
// deliberately holds exactly ONE Pusher — a field that took a list would invite
// a caller to build the list per transaction, which is where a per-transaction
// decision about WHO to notify would eventually grow — so a second audience has
// a composition point that is not the pipeline.
//
// Every sender is called even if an earlier one fails, and the errors are
// joined rather than short-circuited: the senders are independent audiences,
// and one must not go unnotified because another could not be read. The
// pipeline ignores the return value; joining is for the log line, and for a
// test that needs to see which half broke.
type Multi []Notifier

// Notify implements the pipeline's Pusher over every member.
func (m Multi) Notify(ctx context.Context, userID uuid.UUID) error {
	var errs []error
	for _, n := range m {
		if n == nil {
			continue
		}
		if err := n.Notify(ctx, userID); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
