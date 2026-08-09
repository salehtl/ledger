// Package budget is the admission gate of
// docs/superpowers/specs/2026-08-09-account-isolation-design.md.
//
// Its whole job is one sentence from that document:
//
//	Every durable byte must be attributable to exactly one account at the
//	moment it is admitted, and admission must fail closed against that
//	account's budget — in one place, not per endpoint.
//
// So there is exactly one exported operation, [Gate.Admit], and it is called
// from the two seams where attacker-scale durable bytes can accumulate: the op
// log append (internal/v2/oplog) and the quarantine hold
// (internal/v2/quarantine). It is deliberately NOT called from an endpoint. An
// endpoint check is the thing the next feature forgets; a check inside the
// appender cannot be forgotten, because there is no second way to append.
//
// # Three tables, three jobs
//
//   - account_usage is the ledger: one row per (account, resource), maintained
//     INSIDE the caller's transaction so the bytes and the number that counts
//     them commit together or not at all. A rolled-back append leaves the
//     ledger exactly as it found it, and that property is what makes the
//     accounting survive every future caller rather than only the careful ones.
//   - account_limits is the policy: one default row plus optional per-account
//     overrides, so raising a ceiling is an UPDATE and not a deploy.
//   - account_refusals is the receipt: a content-free (user, day, resource)
//     count of every denial. See the note on [Gate.recordRefusal] for why it is
//     the one write here that does NOT join the caller's transaction.
//
// # Ceilings are per resource FAMILY
//
// The design states one ceiling for "the op log", not one per stream, so
// account_limits.oplog_bytes bounds oplog_hot_bytes + oplog_cold_bytes
// TOGETHER: admission for either stream compares the pair's sum plus the delta.
// Quarantine has two independent ceilings — bytes OR holds — because 500 tiny
// held messages are as much of a nuisance as 100 MiB of large ones, and either
// one refuses on its own.
//
// # Lock ordering
//
// Admit locks every row of the target's family with a single ORDER BY resource
// ... FOR UPDATE, so two transactions touching the same family take the same
// rows in the same order and cannot deadlock against each other. Families are
// disjoint, so an append (oplog_*) and a quarantine hold (quarantine_*) never
// contend at all. The caller's own ordering rule matters as much: oplog's
// appendTx calls Admit only AFTER allocSeq has taken the per-account counter
// lock, which serializes same-account appends one step earlier and leaves this
// gate contending on a row that is already exclusively held.
package budget

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The ledger's resources. This is the whole closed set — it matches the CHECK
// constraint on account_usage.resource, and adding a value is a migration,
// which is the correct amount of friction for a claim that a new write path can
// fill the disk.
const (
	// ResourceOplogHotBytes counts durable bytes in the hot op-log stream.
	ResourceOplogHotBytes = "oplog_hot_bytes"
	// ResourceOplogColdBytes counts durable bytes in the cold op-log stream.
	ResourceOplogColdBytes = "oplog_cold_bytes"
	// ResourceQuarantineBytes counts held raw message bytes.
	ResourceQuarantineBytes = "quarantine_bytes"
	// ResourceQuarantineCount counts held messages.
	ResourceQuarantineCount = "quarantine_count"
)

// family is the set of ledger resources one ceiling bounds together, plus the
// account_limits column holding that ceiling.
//
// members is stored SORTED, because it is also the lock order (see the package
// doc). Do not reorder it for readability.
type family struct {
	limitColumn string
	members     []string
}

var families = map[string]family{
	ResourceOplogHotBytes: {
		limitColumn: "oplog_bytes",
		members:     []string{ResourceOplogColdBytes, ResourceOplogHotBytes},
	},
	ResourceOplogColdBytes: {
		limitColumn: "oplog_bytes",
		members:     []string{ResourceOplogColdBytes, ResourceOplogHotBytes},
	},
	ResourceQuarantineBytes: {
		limitColumn: "quarantine_bytes",
		members:     []string{ResourceQuarantineBytes},
	},
	ResourceQuarantineCount: {
		limitColumn: "quarantine_count",
		members:     []string{ResourceQuarantineCount},
	},
}

// ErrRefused reports that a write was declined because the account is at or
// over its ceiling. Callers map it to a status: 413 or 429 on the API, 452 on
// SMTP. Match it with errors.Is; the concrete [RefusedError] carries the
// numbers an operator wants.
//
// It is deliberately distinct from every other failure Admit can return: a
// refusal is a policy outcome the user can be told about, while a missing
// policy row or a locked-out ledger is a server fault, and answering the two
// with one error would let an outage be rendered to a user as "you are out of
// space".
var ErrRefused = errors.New("budget: refused")

// ErrLedgerUnderflow reports that a release (a negative delta) was larger than
// what the ledger says the account holds.
//
// It is NOT a refusal and is NOT counted in account_refusals: nothing a user
// did was declined. It means the ledger and reality have drifted, which is a
// server bug — so it is loud, it leaves the ledger untouched, and it is the
// signal to run internal/v2/verify's reconciliation. Clamping at zero instead
// would convert the accounting bug into free quota, silently and permanently,
// which is why account_usage.amount also carries a non-negative CHECK.
var ErrLedgerUnderflow = errors.New("budget: ledger underflow")

// RefusedError is the concrete form of [ErrRefused].
type RefusedError struct {
	UserID   uuid.UUID
	Resource string
	// Have is the family's total BEFORE this delta, Delta is what was asked
	// for, and Limit is the ceiling that bounds the family.
	Have  int64
	Delta int64
	Limit int64
}

func (e *RefusedError) Error() string {
	return fmt.Sprintf("budget: refused: %s holds %d of %d for %s and asked for %d more",
		e.UserID, e.Have, e.Limit, e.Resource, e.Delta)
}

// Is makes errors.Is(err, ErrRefused) true for every RefusedError, so callers
// can switch on the class without depending on the struct.
func (e *RefusedError) Is(target error) bool { return target == ErrRefused }

// Gate is the admission gate. Pool is required and is used for exactly one
// thing — writing the refusal receipt outside the caller's doomed transaction
// (see [Gate.recordRefusal]). Every other statement runs on the caller's tx.
type Gate struct {
	Pool *pgxpool.Pool
	// now is the clock for the refusal day bucket. nil means time.Now.
	now func() time.Time
}

// New returns a Gate over pool.
func New(pool *pgxpool.Pool) *Gate { return &Gate{Pool: pool} }

func (g *Gate) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

// Admit accounts delta against userID's budget for resource, INSIDE tx, and
// fails closed if the resulting family total would exceed the account's
// ceiling.
//
// The caller must roll tx back when Admit returns an error. It is the caller's
// transaction, so Admit cannot and does not end it — but every increment Admit
// wrote is only durable if the caller's own write is, which is the entire point
// of taking a tx rather than a pool.
//
// delta may be negative: that is a release (an expiry sweep, a
// confirm-and-reingest that moves bytes from quarantine into the op log, a
// future compaction). A release is never refused by a ceiling — an account
// already over a lowered limit must still be able to shrink — but a release
// larger than the stored amount returns [ErrLedgerUnderflow] and changes
// nothing.
//
// delta == 0 is a no-op that takes no lock and creates no row.
func (g *Gate) Admit(ctx context.Context, tx pgx.Tx, userID uuid.UUID, resource string, delta int64) error {
	if g == nil || g.Pool == nil {
		// Fail closed and loudly. A Gate without a pool could still do the
		// arithmetic, but it could not record a refusal anywhere the rollback
		// does not erase — and an uncounted refusal is the silent drop
		// account_refusals exists to prevent.
		return errors.New("budget: admit: gate has no pool")
	}
	if tx == nil {
		return errors.New("budget: admit: no transaction")
	}
	if userID == uuid.Nil {
		return errors.New("budget: admit: user_id is zero")
	}
	fam, ok := families[resource]
	if !ok {
		return fmt.Errorf("budget: admit: unknown resource %q", resource)
	}
	if delta == 0 {
		return nil
	}

	limit, err := g.limitFor(ctx, tx, userID, fam)
	if err != nil {
		return err
	}

	// Every member row must exist before the FOR UPDATE below, or a family
	// whose sibling has never been written would lock one row here and the
	// other on a later call, in whichever order the calls happened to arrive.
	// unnest preserves the array's order, and fam.members is sorted, so the
	// insert takes the same order as the lock.
	if _, err := tx.Exec(ctx,
		`INSERT INTO account_usage (user_id, resource)
		 SELECT $1, r FROM unnest($2::text[]) AS r
		 ON CONFLICT (user_id, resource) DO NOTHING`, userID, fam.members); err != nil {
		return fmt.Errorf("budget: admit: ensure usage rows for %s: %w", userID, err)
	}

	amounts, err := g.lockFamily(ctx, tx, userID, fam)
	if err != nil {
		return err
	}
	var have int64
	for _, m := range fam.members {
		have += amounts[m]
	}
	next := amounts[resource] + delta
	if next < 0 {
		return fmt.Errorf("%w: %s holds %d of %s and a release of %d was asked for",
			ErrLedgerUnderflow, userID, amounts[resource], resource, -delta)
	}
	if delta > 0 && have+delta > limit {
		refused := &RefusedError{UserID: userID, Resource: resource, Have: have, Delta: delta, Limit: limit}
		if err := g.recordRefusal(ctx, userID, resource); err != nil {
			// Both, joined: the caller still needs the refusal (errors.Is
			// survives Join), and an operator still needs to know the receipt
			// was lost.
			return errors.Join(refused, err)
		}
		return refused
	}

	if _, err := tx.Exec(ctx,
		`UPDATE account_usage SET amount = $3, updated_at = now()
		  WHERE user_id = $1 AND resource = $2`, userID, resource, next); err != nil {
		return fmt.Errorf("budget: admit: update %s for %s: %w", resource, userID, err)
	}
	return nil
}

// Usage reads one resource's current amount. It exists for tests, the
// reconciliation check and the operator console; nothing on a write path needs
// it, because Admit reads under its own lock.
func (g *Gate) Usage(ctx context.Context, userID uuid.UUID, resource string) (int64, error) {
	if g == nil || g.Pool == nil {
		return 0, errors.New("budget: usage: gate has no pool")
	}
	var amount int64
	err := g.Pool.QueryRow(ctx,
		`SELECT coalesce(max(amount), 0) FROM account_usage WHERE user_id = $1 AND resource = $2`,
		userID, resource).Scan(&amount)
	if err != nil {
		return 0, fmt.Errorf("budget: usage: %s for %s: %w", resource, userID, err)
	}
	return amount, nil
}

// limitFor resolves the ceiling that applies to this account: its override if
// it has one, otherwise the default row.
//
// ORDER BY user_id NULLS LAST puts the override first, so LIMIT 1 picks it and
// falls through to the default only when there is none. A missing default row
// is an error rather than a fallback constant: the migration makes that row
// undeletable precisely so this cannot happen, and the two ways to guess at it
// are "refuse every write on the box" and "allow every write on the box" —
// neither is a thing to decide silently.
func (g *Gate) limitFor(ctx context.Context, tx pgx.Tx, userID uuid.UUID, fam family) (int64, error) {
	var limit int64
	err := tx.QueryRow(ctx,
		`SELECT `+fam.limitColumn+` FROM account_limits
		  WHERE user_id = $1 OR user_id IS NULL
		  ORDER BY user_id NULLS LAST LIMIT 1`, userID).Scan(&limit)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("budget: admit: no policy row for %s and no default in account_limits", userID)
	}
	if err != nil {
		return 0, fmt.Errorf("budget: admit: read limit %s for %s: %w", fam.limitColumn, userID, err)
	}
	return limit, nil
}

// lockFamily takes an exclusive row lock on every member of the family and
// returns their amounts.
//
// ORDER BY resource is the lock order, not a presentation choice: FOR UPDATE
// locks rows as the plan emits them, and the sort sits below the LockRows node,
// so two transactions on the same family always take the same rows in the same
// sequence. See the package doc.
func (g *Gate) lockFamily(ctx context.Context, tx pgx.Tx, userID uuid.UUID, fam family) (map[string]int64, error) {
	rows, err := tx.Query(ctx,
		`SELECT resource, amount FROM account_usage
		  WHERE user_id = $1 AND resource = ANY($2::text[])
		  ORDER BY resource FOR UPDATE`, userID, fam.members)
	if err != nil {
		return nil, fmt.Errorf("budget: admit: lock usage rows for %s: %w", userID, err)
	}
	defer rows.Close()
	amounts := make(map[string]int64, len(fam.members))
	for rows.Next() {
		var res string
		var amount int64
		if err := rows.Scan(&res, &amount); err != nil {
			return nil, fmt.Errorf("budget: admit: scan usage row for %s: %w", userID, err)
		}
		amounts[res] = amount
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("budget: admit: read usage rows for %s: %w", userID, err)
	}
	for _, m := range fam.members {
		if _, ok := amounts[m]; !ok {
			// The INSERT above created them, so this can only mean the row was
			// deleted between the two statements — i.e. the account was
			// purged mid-append. Refusing is right; inventing a zero would
			// write a usage row for a user that no longer exists.
			return nil, fmt.Errorf("budget: admit: usage row %s is missing for %s", m, userID)
		}
	}
	return amounts, nil
}

// recordRefusal increments the (user, day, resource) count.
//
// It runs on the POOL, on its own connection and its own transaction, and that
// is the single most important line in this package. Admit refuses by returning
// an error; the caller's only correct response is to roll its transaction back;
// a refusal written inside that transaction would be rolled back with it. The
// receipt would then exist only in the moment before it was erased, and
// account_refusals — the table whose entire purpose is that nothing is silently
// dropped — would read zero forever while writes were being declined all day.
//
// The context is detached from the caller's, so a refusal is still counted when
// the request that provoked it has already been cancelled, and bounded so a
// wedged server cannot pin the connection.
//
// It cannot deadlock against the doomed transaction: that transaction holds
// locks on account_usage and (for an append) oplog_seq, and touches
// account_refusals not at all.
func (g *Gate) recordRefusal(ctx context.Context, userID uuid.UUID, resource string) error {
	if !slices.Contains([]string{
		ResourceOplogHotBytes, ResourceOplogColdBytes,
		ResourceQuarantineBytes, ResourceQuarantineCount,
	}, resource) {
		return fmt.Errorf("budget: refusal: unknown resource %q", resource)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := g.Pool.Exec(ctx,
		`INSERT INTO account_refusals (user_id, day, resource, count)
		 VALUES ($1, $2::date, $3, 1)
		 ON CONFLICT (user_id, day, resource)
		 DO UPDATE SET count = account_refusals.count + 1`,
		userID, g.clock().UTC().Format("2006-01-02"), resource)
	if err != nil {
		return fmt.Errorf("budget: refusal: count %s for %s: %w", resource, userID, err)
	}
	return nil
}
