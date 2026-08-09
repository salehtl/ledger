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
// It exists because a deployment can legitimately have both an Expo audience
// (the native client's remaining installs) and a Web Push audience (the PWA),
// while ingest.Pipeline deliberately holds exactly ONE Pusher — a field that
// took a list would invite a caller to build the list per transaction, which is
// where a per-transaction decision about WHO to notify would eventually grow.
//
// Every sender is called even if an earlier one fails, and the errors are
// joined rather than short-circuited: the senders are independent audiences,
// and a browser subscription must not go unnotified because an Expo token list
// could not be read. The pipeline ignores the return value; joining is for the
// log line, and for a test that needs to see which half broke.
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
