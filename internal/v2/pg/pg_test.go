package pg_test

import (
	"context"
	"os"
	"testing"

	"ledger/internal/v2/pg"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

func TestMigrationsCreateUsersAndSessions(t *testing.T) {
	pool := pgtest.New(t)
	ctx := context.Background()
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables
		  WHERE table_schema='public' AND table_name IN ('users','sessions')`).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected users+sessions tables, found %d", n)
	}
}

func TestEachTestGetsAnIsolatedDatabase(t *testing.T) {
	ctx := context.Background()
	a, b := pgtest.New(t), pgtest.New(t)
	if _, err := a.Exec(ctx, `INSERT INTO users (id, idp, idp_sub_hash, created_at)
		VALUES (gen_random_uuid(), 'apple', '\x00'::bytea, now())`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := b.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("databases are not isolated: second pool sees %d users", n)
	}
}

func TestMigrationsAreReversible(t *testing.T) {
	// goose's Down path is dead code unless something runs it; a broken Down
	// block is only discovered during an emergency rollback otherwise.
	pool := pgtest.New(t)
	ctx := context.Background()
	if err := pg.MigrateDown(ctx, pool); err != nil {
		t.Fatalf("down: %v", err)
	}
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
	                     WHERE table_schema='public' AND table_name='users'`).Scan(&n)
	if n != 0 {
		t.Fatal("Down left the users table behind")
	}
	if err := pg.Migrate(ctx, pool); err != nil {
		t.Fatalf("re-up: %v", err)
	}
}
