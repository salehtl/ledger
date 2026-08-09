package verify

// usage.go is the standing audit of the per-account usage ledger — P1 of
// docs/superpowers/specs/2026-08-09-account-isolation-design.md, which ships the
// ledger WITH this check rather than after it:
//
//	Drift is the known failure mode of application-level accounting. So the
//	ledger ships with a reconciliation check in internal/v2/verify […]:
//	recompute sum(length(blob)) per account, compare against the ledger, and
//	report any difference as a finding. The check is the guard against the
//	ledger quietly becoming fiction.
//
// The ledger is what admission compares against (internal/v2/budget). If it
// drifts HIGH an honest account is refused writes it should have been allowed;
// if it drifts LOW an account is handed budget it has already spent, which is
// the exact failure the whole isolation design exists to prevent. Neither
// direction announces itself — account_usage is a number nobody reads — so the
// only thing standing between a wrong number and a wrong policy is this check.
//
// # It reconciles the PADDED STORED BYTES, and that is not a detail
//
// The charged quantity is len(Blob): the framed, bucket-padded bytes actually
// written to the column. oplog's appender charges that (append.go's admit),
// migration 00031 backfills sum(octet_length(blob)), and this file recomputes
// the same expression. Reconciling against a plaintext length instead would
// invent drift on every account on a healthy box — the padding — and would grow
// with Phase 3's sealing.
//
// # It reads no content, like the rest of this package
//
// octet_length() on a bytea is answered from the stored value's length header,
// so this never fetches, decompresses or looks inside a blob. It is arithmetic
// over sizes, which is why an audit that runs against real users' mail on the
// production box can run at all.
//
// # Report, repair, and the deploy window
//
// [UsageLedger] REPORTS. It never writes. `ledgerd verify` is an audit of stored
// data — it deliberately does not even apply migrations, because a tool that
// changes the database it is measuring has changed the measurement — and a check
// that silently rewrote the ledger every night would erase the evidence of the
// bug it exists to find. A repeatedly self-healing ledger reads exactly like a
// correct one.
//
// [RepairUsageLedger] is the operator's separate, deliberate lever
// (`ledgerd verify --repair-usage`), and §7 of the design is why it has to
// exist: migrations are applied out of band BEFORE the new binary starts, so the
// OLD binary — which does not maintain the ledger — keeps writing between
// 00031's backfill sums and the restart. Every one of those writes is drift the
// first reconciliation after a deploy is EXPECTED to find, and expected to
// repair. Report by default, repair on request, is what serves both: a cron that
// never writes and can still fail loudly, and a runbook step that closes a
// window nobody could have closed at migration time.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/budget"
)

// usageScope bounds every leg of the reconciliation to the requested accounts,
// or to all of them when the array is empty. cardinality(NULL) is NULL, so the
// coalesce is what makes a nil slice and an empty slice mean the same thing
// instead of silently selecting no rows at all.
const usageScope = `(coalesce(cardinality($1::uuid[]), 0) = 0 OR user_id = ANY($1::uuid[]))`

// usageDriftSQL recomputes the truth and compares it against the ledger in ONE
// statement, and the single statement is the substance of it.
//
// An append writes its op row and its account_usage increment in the same
// transaction, so the two are only ever consistent in the same SNAPSHOT. Reading
// the ledger and then the stored bytes is two snapshots, and a perfectly healthy
// append committing between them shows up as drift of exactly its own size. That
// is a checker that cries wolf on the busiest accounts — the same reasoning S5's
// single statement records — and a check nobody trusts is worse than none.
//
// FULL JOIN, not a join in either direction: a ledger row with no stored bytes
// (an account whose data was deleted under it) and stored bytes with no ledger
// row (a write path that never charged them) are both drift, and either
// one-sided join drops one of them.
//
// The resource names are built the way 00031's backfill builds them, from the
// stream itself. TestTheReconciledResourceNamesAreTheLedgersOwn pins the
// spelling against internal/v2/budget's constants, because a typo here would
// report every account's whole log as drift and repair it into a duplicate row.
const usageDriftSQL = `
WITH truth AS (
        SELECT user_id, 'oplog_' || stream || '_bytes' AS resource,
               sum(octet_length(blob))::bigint AS amount
          FROM op_log WHERE ` + usageScope + `
         GROUP BY user_id, stream
   UNION ALL
        SELECT user_id, 'quarantine_bytes', sum(octet_length(blob))::bigint
          FROM quarantine WHERE ` + usageScope + `
         GROUP BY user_id
   UNION ALL
        SELECT user_id, 'quarantine_count', count(*)::bigint
          FROM quarantine WHERE ` + usageScope + `
         GROUP BY user_id
),
ledger AS (
   SELECT user_id, resource, amount FROM account_usage WHERE ` + usageScope + `
)
SELECT coalesce(t.user_id, l.user_id), coalesce(t.resource, l.resource),
       coalesce(l.amount, 0), coalesce(t.amount, 0)
  FROM truth t FULL JOIN ledger l ON l.user_id = t.user_id AND l.resource = t.resource
 WHERE coalesce(l.amount, 0) <> coalesce(t.amount, 0)
 ORDER BY 1, 2`

// drift is one (account, resource) whose ledger amount and recomputed total
// disagree.
type drift struct {
	UserID   uuid.UUID
	Resource string
	// Ledger is what account_usage holds; Actual is what the stored rows add
	// up to, in the same snapshot.
	Ledger int64
	Actual int64
}

// Correction is one ledger row [RepairUsageLedger] rewrote.
type Correction struct {
	UserID   uuid.UUID `json:"user_id"`
	Resource string    `json:"resource"`
	// From is what the row held; To is the recomputed total it now holds.
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// UsageLedger reconciles account_usage against the stored bytes, for every
// account.
func UsageLedger(ctx context.Context, pool *pgxpool.Pool) ([]Finding, error) {
	return UsageLedgerFor(ctx, pool, nil)
}

// UsageLedgerFor reconciles the named accounts, or all of them when users is
// empty. Findings are ordered by account and then by resource, so two runs over
// an unchanged database produce identical output and a diff between them is
// meaningful.
//
// It writes nothing. See the file header for why the repair is a separate,
// explicitly requested operation.
func UsageLedgerFor(ctx context.Context, pool *pgxpool.Pool, users []uuid.UUID) ([]Finding, error) {
	drifts, err := usageDrift(ctx, pool, users)
	if err != nil {
		return nil, err
	}
	out := make([]Finding, 0, len(drifts))
	for _, d := range drifts {
		if len(out) >= maxFindings {
			out = append(out, Finding{
				ID:     "truncated",
				Detail: fmt.Sprintf("stopped after %d findings; fix these and re-run", maxFindings),
			})
			break
		}
		out = append(out, Finding{ID: U1UsageDrift, UserID: d.UserID, Detail: d.detail()})
	}
	return out, nil
}

func usageDrift(ctx context.Context, pool *pgxpool.Pool, users []uuid.UUID) ([]drift, error) {
	if pool == nil {
		return nil, errors.New("verify: pool is nil")
	}
	if users == nil {
		users = []uuid.UUID{}
	}
	rows, err := pool.Query(ctx, usageDriftSQL, users)
	if err != nil {
		return nil, fmt.Errorf("verify: usage ledger: %w", err)
	}
	defer rows.Close()
	var out []drift
	for rows.Next() {
		var d drift
		if err := rows.Scan(&d.UserID, &d.Resource, &d.Ledger, &d.Actual); err != nil {
			return nil, fmt.Errorf("verify: usage ledger: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("verify: usage ledger: %w", err)
	}
	return out, nil
}

// detail names the position and the two numbers, and says which way the error
// bends — because the two directions have opposite consequences for the person
// whose account it is, and an operator reading a wall of findings should not
// have to do the subtraction to find out which one they are looking at.
func (d drift) detail() string {
	unit := usageUnit(d.Resource)
	if d.Ledger > d.Actual {
		return fmt.Sprintf(
			"%s: the ledger says %d %s and the stored rows total %d, so it is %d too HIGH — "+
				"this account is charged for space it does not hold and will be refused writes early. "+
				"Recompute it with `ledgerd verify --repair-usage`.",
			d.Resource, d.Ledger, unit, d.Actual, d.Ledger-d.Actual)
	}
	return fmt.Sprintf(
		"%s: the ledger says %d %s and the stored rows total %d, so it is %d too LOW — "+
			"this account holds space nobody is charged for, which is budget the ceiling "+
			"cannot see. Recompute it with `ledgerd verify --repair-usage`.",
		d.Resource, d.Ledger, unit, d.Actual, d.Actual-d.Ledger)
}

// usageUnit is what a resource's amount counts. Three of the four are bytes and
// the fourth is messages, and printing "500 bytes" for a hold count would be a
// number an operator acts on wrongly.
func usageUnit(resource string) string {
	if resource == budget.ResourceQuarantineCount {
		return "held message(s)"
	}
	return "bytes"
}

// repairable is the closed set of resources [RepairUsageLedger] will write.
//
// It is a filter and not a formality: account_usage.resource carries a CHECK,
// so an INSERT of anything else aborts the repair transaction. A resource
// outside this set can only come from a stream the op log's own constraint does
// not permit, which is a finding to READ and not a row to rewrite.
var repairable = []string{
	budget.ResourceOplogHotBytes, budget.ResourceOplogColdBytes,
	budget.ResourceQuarantineBytes, budget.ResourceQuarantineCount,
}

// RepairUsageLedger rewrites every drifting row to its recomputed total and
// returns what it changed.
//
// This is the deploy-window lever of §7 and the design's "expected to find
// drift, and expected to repair it". It is never called by a report; the caller
// is `ledgerd verify --repair-usage`, typed by an operator.
//
// # One transaction per row, and the lock is taken FIRST
//
// Each row is locked FOR UPDATE and only then is its truth recomputed, so the
// recompute sees every append that committed before the lock and every append
// after it waits on the lock — the written value is exact rather than a
// best-effort snapshot, even with the service running.
//
// One row per transaction is also what makes a deadlock impossible: budget.Admit
// locks a whole resource family in one statement, and a repair that held two
// family members at once could take them in the opposite order. Holding exactly
// one lock at a time cannot participate in a cycle.
//
// A row that is no longer drifting when its turn comes is left alone and not
// reported: a live append that corrected it between the survey and the write is
// the ledger working, not a repair.
func RepairUsageLedger(ctx context.Context, pool *pgxpool.Pool, users []uuid.UUID) ([]Correction, error) {
	drifts, err := usageDrift(ctx, pool, users)
	if err != nil {
		return nil, err
	}
	var out []Correction
	for _, d := range drifts {
		if !contains(repairable, d.Resource) {
			continue
		}
		c, ok, err := repairOne(ctx, pool, d)
		if err != nil {
			return out, err
		}
		if ok {
			out = append(out, c)
		}
	}
	return out, nil
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func repairOne(ctx context.Context, pool *pgxpool.Pool, d drift) (Correction, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Correction{}, false, fmt.Errorf("verify: repair usage ledger: %w", err)
	}
	defer tx.Rollback(ctx)

	// The row may not exist at all: a write path that never charged its bytes
	// leaves no row, and 00031's "an absent row and a zero row mean the same
	// thing" only holds while the amount really is zero.
	if _, err := tx.Exec(ctx,
		`INSERT INTO account_usage (user_id, resource) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		d.UserID, d.Resource); err != nil {
		var pge *pgconn.PgError
		if errors.As(err, &pge) && pge.Code == "23503" {
			// foreign_key_violation: the account was purged between the survey
			// and now. There is nothing to repair and nothing wrong.
			return Correction{}, false, nil
		}
		return Correction{}, false, fmt.Errorf("verify: repair usage ledger: ensure %s for %s: %w",
			d.Resource, d.UserID, err)
	}

	var have int64
	err = tx.QueryRow(ctx,
		`SELECT amount FROM account_usage WHERE user_id = $1 AND resource = $2 FOR UPDATE`,
		d.UserID, d.Resource).Scan(&have)
	if errors.Is(err, pgx.ErrNoRows) {
		return Correction{}, false, nil
	}
	if err != nil {
		return Correction{}, false, fmt.Errorf("verify: repair usage ledger: lock %s for %s: %w",
			d.Resource, d.UserID, err)
	}

	actual, err := usageTruth(ctx, tx, d.UserID, d.Resource)
	if err != nil {
		return Correction{}, false, err
	}
	if actual == have {
		return Correction{}, false, nil
	}
	if _, err := tx.Exec(ctx,
		`UPDATE account_usage SET amount = $3, updated_at = now()
		  WHERE user_id = $1 AND resource = $2`, d.UserID, d.Resource, actual); err != nil {
		return Correction{}, false, fmt.Errorf("verify: repair usage ledger: write %s for %s: %w",
			d.Resource, d.UserID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Correction{}, false, fmt.Errorf("verify: repair usage ledger: commit %s for %s: %w",
			d.Resource, d.UserID, err)
	}
	return Correction{UserID: d.UserID, Resource: d.Resource, From: have, To: actual}, true, nil
}

// usageTruth recomputes one (account, resource) total INSIDE the caller's
// transaction, which is what makes the repair exact — see RepairUsageLedger.
func usageTruth(ctx context.Context, tx pgx.Tx, userID uuid.UUID, resource string) (int64, error) {
	var (
		sql    string
		args   = []any{userID}
		amount int64
	)
	switch resource {
	case budget.ResourceOplogHotBytes, budget.ResourceOplogColdBytes:
		sql = `SELECT coalesce(sum(octet_length(blob)), 0)::bigint FROM op_log
		        WHERE user_id = $1 AND stream = $2`
		args = append(args, streamForResource(resource))
	case budget.ResourceQuarantineBytes:
		sql = `SELECT coalesce(sum(octet_length(blob)), 0)::bigint FROM quarantine WHERE user_id = $1`
	case budget.ResourceQuarantineCount:
		sql = `SELECT count(*)::bigint FROM quarantine WHERE user_id = $1`
	default:
		return 0, fmt.Errorf("verify: repair usage ledger: %q is not a ledger resource", resource)
	}
	if err := tx.QueryRow(ctx, sql, args...).Scan(&amount); err != nil {
		return 0, fmt.Errorf("verify: repair usage ledger: recompute %s for %s: %w",
			resource, userID, err)
	}
	return amount, nil
}

// streamForResource is the inverse of oplog's resourceForStream. The two are
// pinned together by TestTheReconciledResourceNamesAreTheLedgersOwn.
func streamForResource(resource string) string {
	if resource == budget.ResourceOplogColdBytes {
		return "cold"
	}
	return "hot"
}
