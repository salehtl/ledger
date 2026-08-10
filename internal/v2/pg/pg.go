// Package pg owns the v2 Postgres connection pool and the embedded migration set.
package pg

import (
	"context"
	"embed"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

// gooseMu serializes every call into goose. SetDialect and SetBaseFS mutate
// unsynchronized package-level globals in the vendored goose source
// (var store in dialect.go, var baseFS in goose.go), which UpContext and
// DownToContext then read while running — goose was never written to be
// called concurrently. Every caller here sets the same dialect ("postgres")
// and the same embedded FS, so the values never actually disagree, but an
// unsynchronized concurrent read/write of the same memory is a data race
// regardless of whether the values agree, and go test -race reports it as
// one. This harness exists specifically so ~20 v2 packages can test
// concurrently (including via t.Parallel() within a package), so this global
// state gets exercised concurrently as soon as any test uses it that way.
var gooseMu sync.Mutex

// Open creates a pool with conservative limits: this process is the only
// writer, and a beta-scale user count needs far fewer connections than the
// server's default 100.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = 16
	cfg.MinConns = 2
	return pgxpool.NewWithConfig(ctx, cfg)
}

// Migrate applies every embedded migration. Idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	return goose.UpContext(ctx, db, "migrations")
}

// MigrateTo applies migrations up to and including version, leaving anything
// later unapplied.
//
// It exists for one reason: a migration that BACKFILLS can only be observed
// against rows that existed before it ran, and Migrate applies the whole set in
// one call, so by the time a test can insert anything the backfill has already
// happened over an empty database. MigrateTo lets a test stop one version
// short, seed, and then step forward — which is the only way the backfill in
// 00031_account_budgets.sql is exercised by anything other than production.
func MigrateTo(ctx context.Context, pool *pgxpool.Pool, version int64) error {
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	return goose.UpToContext(ctx, db, "migrations", version)
}

// MigrateDown reverses every migration. Used only by tests; a Down block that
// nobody runs is a rollback that does not work.
func MigrateDown(ctx context.Context, pool *pgxpool.Pool) error {
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	return goose.DownToContext(ctx, db, "migrations", 0)
}
