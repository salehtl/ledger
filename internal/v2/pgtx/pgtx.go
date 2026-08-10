// Package pgtx holds the two pgx transaction helpers every v2 Postgres store
// used to copy by hand: opening a transaction pinned to READ COMMITTED, and
// rolling one back on a context detached from the caller's. It is a leaf
// package on purpose — it imports only pgx/pgxpool and stdlib, never goose
// and never internal/v2/pg, so depending on it never pulls in the embedded
// migrations that pg owns.
package pgtx

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BeginReadCommitted opens a transaction pinned to READ COMMITTED rather
// than letting it inherit whatever isolation level happens to be active:
// default_transaction_isolation is settable per database, per role and by a
// pooler's startup parameters, so a plain Begin() runs at whatever was last
// configured there. Several v2 stores use a `SELECT ... FOR UPDATE` (with or
// without SKIP LOCKED) or an equivalent row lock to serialize concurrent
// writers — a concurrent sweep, registration, rotation, cutover or append.
// Under REPEATABLE READ that lock can raise a serialization failure instead
// of doing its job — blocking, or for SKIP LOCKED, skipping — turning a
// routine concurrent operation into an error whose text says nothing about
// what actually happened.
//
// The returned error is unwrapped — pool.BeginTx's error verbatim — so a
// caller can prefix it with its own package/operation tag without producing
// a doubled prefix.
func BeginReadCommitted(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	return pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
}

// Rollback rolls tx back on a context detached from ctx's cancellation,
// bounded at 5s — the timeout stops a wedged server from pinning the
// connection forever — so cleanup still runs when the request context is
// gone. A cancelled caller request still releases the transaction's locks
// cleanly this way, instead of leaving pgx to destroy the connection.
func Rollback(ctx context.Context, tx pgx.Tx) {
	rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(rbCtx)
}
