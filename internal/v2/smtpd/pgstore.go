package smtpd

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/budget"
)

// PGStore is the primary's implementation of [Suspensions], [Refusals] and
// [CounterStore] — the three optional database seams this receiver has.
//
// One type rather than three because they are one deployment decision: the
// primary has a pool and answers all three, and the backup relay (Task 35) has
// no Postgres and answers none. Splitting them would invite a half-wired server
// that persists counters but never notices a suspension.
//
// Every statement here is guarded so that a row for an account that has since
// been purged is SKIPPED rather than reported as a foreign-key violation. That
// is not tidiness: these writes are retried from an in-memory buffer, so an
// error that can never succeed is an error that is retried forever.
type PGStore struct{ Pool *pgxpool.Pool }

// Compile-time proof that the one type satisfies all three seams.
var (
	_ Suspensions  = (*PGStore)(nil)
	_ Refusals     = (*PGStore)(nil)
	_ CounterStore = (*PGStore)(nil)
)

var errNoPool = errors.New("smtpd: pg store has no pool")

// Suspended reads users.status.
//
// A missing row answers false, not an error: the recipient resolved a moment
// ago, so a user that has vanished between the two queries has been purged, and
// there is no account left to suspend. The message is then refused downstream
// by the delivery path rather than here.
func (p *PGStore) Suspended(ctx context.Context, userID uuid.UUID) (bool, error) {
	if p == nil || p.Pool == nil {
		return false, errNoPool
	}
	var status string
	err := p.Pool.QueryRow(ctx, `SELECT status FROM users WHERE id = $1`, userID).Scan(&status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("smtpd: read account status: %w", err)
	}
	return status == StatusSuspended, nil
}

// StatusSuspended is users.status's suspended value (migration 00030).
const StatusSuspended = "suspended"

// CountRefusals adds n to (userID, today UTC, resource).
//
// It delegates to [budget.CountRefusals], which is the ONE writer of
// account_refusals. This used to be a second, near-identical statement, and the
// two drifted in both of the ways a duplicated writer drifts: this one computed
// the day in the database while the budget gate computed it in Go, so a refusal
// an hour either side of midnight could land on two different days depending on
// which path refused it; and only this one carried the guard that skips an
// account that has since been purged. One writer cannot drift from itself.
func (p *PGStore) CountRefusals(ctx context.Context, userID uuid.UUID, resource string, n int64) error {
	if p == nil || p.Pool == nil {
		return errNoPool
	}
	if err := budget.CountRefusals(ctx, p.Pool, userID, resource, n); err != nil {
		return fmt.Errorf("smtpd: count refusal %s: %w", resource, err)
	}
	return nil
}

// LoadUserCounters reads every persisted counter.
//
// Rows older than two windows are not filtered out here and do not need to be:
// counter.roll ages them to zero on the first read, so they restore to nothing.
// The housekeeping sweep that removes them is an operational concern, not a
// correctness one.
func (p *PGStore) LoadUserCounters(ctx context.Context) ([]UserCounter, error) {
	if p == nil || p.Pool == nil {
		return nil, errNoPool
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT user_id, kind, reason, window_seconds, window_start, cur, prev
		   FROM smtp_user_counters`)
	if err != nil {
		return nil, fmt.Errorf("smtpd: load counters: %w", err)
	}
	defer rows.Close()
	var out []UserCounter
	for rows.Next() {
		var c UserCounter
		if err := rows.Scan(&c.UserID, &c.Kind, &c.Reason, &c.WindowSeconds,
			&c.WindowStart, &c.Cur, &c.Prev); err != nil {
			return nil, fmt.Errorf("smtpd: load counters: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("smtpd: load counters: %w", err)
	}
	return out, nil
}

// SaveUserCounters upserts a whole snapshot.
//
// Rows are written one statement at a time inside one transaction: the snapshot
// is bounded by the number of tracked accounts, and a partially written
// snapshot would be a mixture of two instants. A row for a purged account is
// skipped by the EXISTS guard rather than aborting the transaction.
func (p *PGStore) SaveUserCounters(ctx context.Context, rows []UserCounter) error {
	if p == nil || p.Pool == nil {
		return errNoPool
	}
	if len(rows) == 0 {
		return nil
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("smtpd: save counters: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, c := range rows {
		if _, err := tx.Exec(ctx,
			`INSERT INTO smtp_user_counters
			   (user_id, kind, reason, window_seconds, window_start, cur, prev, updated_at)
			 SELECT $1, $2, $3, $4, $5, $6, $7, now()
			  WHERE EXISTS (SELECT 1 FROM users WHERE id = $1)
			 ON CONFLICT (user_id, kind, reason) DO UPDATE
			   SET window_seconds = EXCLUDED.window_seconds,
			       window_start   = EXCLUDED.window_start,
			       cur            = EXCLUDED.cur,
			       prev           = EXCLUDED.prev,
			       updated_at     = EXCLUDED.updated_at`,
			c.UserID, c.Kind, c.Reason, c.WindowSeconds,
			c.WindowStart.UTC(), c.Cur, c.Prev); err != nil {
			return fmt.Errorf("smtpd: save counters: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("smtpd: save counters: commit: %w", err)
	}
	return nil
}

// SweepUserCounters removes rows that have been silent for more than two
// windows, at which point counter.roll would restore them to zero anyway so the
// row carries no information. It is exported for a housekeeping caller; nothing
// in this package calls it on a timer.
func (p *PGStore) SweepUserCounters(ctx context.Context, window time.Duration) (int64, error) {
	if p == nil || p.Pool == nil {
		return 0, errNoPool
	}
	tag, err := p.Pool.Exec(ctx,
		`DELETE FROM smtp_user_counters WHERE updated_at < now() - $1::interval`,
		fmt.Sprintf("%d seconds", int(2*window/time.Second)))
	if err != nil {
		return 0, fmt.Errorf("smtpd: sweep counters: %w", err)
	}
	return tag.RowsAffected(), nil
}
