// Package pgtest boots a throwaway PostgreSQL cluster for tests. It never
// touches a system cluster, never binds TCP, and needs no running service.
//
// Host requirement: apt-get install -y postgresql (for initdb/postgres).
// Set LEDGER_TEST_POSTGRES_URL to reuse an already-running server instead —
// scripts/v2-check.sh does exactly that so one cluster serves the whole run,
// instead of every v2 package (there will be ~20 of them) paying its own
// initdb. Per-package boot below remains the fallback when that variable is
// unset, so `go test ./internal/v2/pg/` in isolation still works standalone.
package pgtest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/pg"
)

var (
	adminDSN  string
	adminPool *pgxpool.Pool // shared for the whole run: CREATE/DROP DATABASE only
	dbSeq     atomic.Int64
)

// Main boots one cluster for the whole package run and tears it down after.
func Main(m *testing.M) int {
	stop, dsn, err := boot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "pgtest: %v\n", err)
		return 1
	}
	adminDSN = dsn
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pgtest: connect admin pool: %v\n", err)
		stop()
		return 1
	}
	adminPool = pool
	code := m.Run()
	adminPool.Close()
	stop()
	return code
}

// New returns a pool on a freshly created, fully migrated database that is
// dropped when the test (and any subtests holding it open) finishes.
func New(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("t%d_%d", os.Getpid(), dbSeq.Add(1))
	if _, err := adminPool.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	// Registered immediately after CREATE succeeds, before Open/Migrate
	// below can fail — t.Fatal from either of those runs t.Cleanup, but
	// only for cleanups already registered by that point. Registering this
	// late (after a successful Open+Migrate, as a first draft of this did)
	// leaks the database on that narrower failure path too: same class of
	// bug as never dropping it at all, just a smaller trigger window.
	var pool *pgxpool.Pool
	t.Cleanup(func() {
		// Close this test's own pool first (if we got far enough to open
		// one) so its connections aren't the "other users" DROP DATABASE
		// complains about. WITH (FORCE) (PG13+) additionally terminates any
		// connection that isn't ours yet — e.g. one pgxpool hasn't finished
		// draining, or a helper the test spawned that never called Close.
		// Without dropping at all, a full `go test ./internal/v2/...` run
		// leaves hundreds of throwaway databases behind in the shared
		// cluster.
		if pool != nil {
			pool.Close()
		}
		if _, err := adminPool.Exec(context.Background(),
			"DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("pgtest: drop database %s: %v", name, err)
		}
	})
	p, err := pg.Open(ctx, dsnForDatabase(adminDSN, name))
	if err != nil {
		t.Fatal(err)
	}
	pool = p
	if err := pg.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

// dsnForDatabase swaps the database name in a DSN of the form produced by
// boot(): postgres://postgres@/postgres?host=...&port=...&sslmode=disable.
// The admin DSN always connects to the "postgres" maintenance database, so
// this replaces the URL path.
//
// This is NOT the same as pgxpool.ParseConfig + mutating cfg.ConnConfig.Database
// + cfg.ConnString(): pgx's ConnConfig.ConnString() returns the exact string
// it was originally parsed from (a cached field), not a re-serialization of
// the mutated struct, so that approach silently keeps connecting to
// "postgres" no matter what Database is set to. Rewriting the URL path
// directly is what actually changes which database pgx connects to.
func dsnForDatabase(adminDSN, name string) string {
	u, err := url.Parse(adminDSN)
	if err != nil || u.Scheme == "" {
		// Fallback for keyword/value DSNs (e.g. "host=... user=... dbname=x"),
		// which LEDGER_TEST_POSTGRES_URL could in principle be set to. pgx
		// takes the last "dbname" it sees, so appending one more wins.
		return adminDSN + " dbname=" + name
	}
	u.Path = "/" + name
	return u.String()
}

func boot() (func(), string, error) {
	if u := os.Getenv("LEDGER_TEST_POSTGRES_URL"); u != "" {
		return func() {}, u, nil
	}
	dir, srv, dsn, err := bootCluster(false)
	if err != nil {
		return nil, "", err
	}
	stop := func() {
		_ = srv.Process.Signal(syscall.SIGQUIT)
		_, _ = srv.Process.Wait()
		_ = os.RemoveAll(dir)
	}
	return stop, dsn, nil
}

// BootStandalone starts a cluster that outlives the calling process: the
// postgres server is started in its own session (SysProcAttr.Setsid) so it
// is not in the caller's process group and is not killed by any signal the
// caller's group receives, and is left running (no Signal/Wait) when
// BootStandalone returns. It is used by cmd/boot, whose whole purpose is to
// print connection info and exit while the server keeps running — see
// scripts/v2-check.sh, which does `eval "$(go run ./internal/v2/pgtest/cmd/boot)"`
// to share one cluster across every v2 package's test run instead of each
// package's own TestMain (via boot() above) paying for its own initdb.
//
// It returns the admin DSN and the path to a self-contained shell script
// that stops the server and removes its data directory; the caller is
// responsible for eventually running that script.
func BootStandalone() (dsn string, stopScript string, err error) {
	dir, srv, dsn, err := bootCluster(true)
	if err != nil {
		return "", "", err
	}
	// Reap the child the moment it exits, whatever the caller's own
	// lifetime looks like. cmd/boot's process exits right after this
	// function returns, so on that path the postgres child is reparented to
	// init and reaped automatically anyway — but a caller that stays alive
	// longer (e.g. a test invoking BootStandalone directly, in-process)
	// would otherwise leave an exited child as an unreaped zombie, which
	// still answers `kill -0` as "running". stop.sh below polls exactly
	// that, so an unreaped zombie makes it wait out its full ~10s timeout
	// on every stop instead of noticing the shutdown immediately.
	go func() { _, _ = srv.Process.Wait() }()
	script := filepath.Join(dir, "stop.sh")
	contents := fmt.Sprintf("#!/bin/sh\nkill -QUIT %d 2>/dev/null\nfor i in $(seq 1 100); do kill -0 %d 2>/dev/null || break; sleep 0.1; done\nrm -rf %s\n",
		srv.Process.Pid, srv.Process.Pid, dir)
	if err := os.WriteFile(script, []byte(contents), 0o700); err != nil {
		// The server is already running and detached at this point (that's
		// the whole point of bootCluster(true)) — without an explicit kill
		// here, a WriteFile failure (e.g. disk full) would leak it running
		// forever with nothing left holding a reference to stop it. The
		// reaper goroutine above already owns the Wait(); calling it again
		// here would race that goroutine for no benefit, since both discard
		// the result anyway.
		_ = srv.Process.Kill()
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("write stop script: %w", err)
	}
	return dsn, script, nil
}

// bootCluster does the actual initdb + postgres start shared by boot() and
// BootStandalone; detach controls whether the server process is placed in
// its own session (required when the caller is a short-lived `go run`
// process that must not take the server down with it on exit).
func bootCluster(detach bool) (dir string, srv *exec.Cmd, dsn string, err error) {
	bin, err := filepath.Glob("/usr/lib/postgresql/*/bin/initdb")
	if err != nil || len(bin) == 0 {
		return "", nil, "", fmt.Errorf("initdb not found; run: apt-get install -y postgresql")
	}
	binDir := filepath.Dir(bin[len(bin)-1])
	dir, err = os.MkdirTemp("", "pgtest-")
	if err != nil {
		return "", nil, "", err
	}
	// From here on, dir exists on disk. Every early return below on error
	// must not leak it — found by literally forcing one of these paths
	// (LEDGER_TEST_PG_USER pointed at a nonexistent user) and finding a
	// stray /tmp/pgtest-* directory afterward, which is exactly the kind of
	// leak that only shows up after enough failed/flaky boots accumulate.
	//
	// bootDir, not dir, is what the cleanup defer below closes over: dir is
	// this function's named return value, and every early "return "", nil,
	// "", err" below assigns "" to it before the deferred function runs —
	// os.RemoveAll(dir) at that point would silently remove nothing. A
	// plain local variable can't be reassigned out from under the defer by
	// a return statement, so it stays correct.
	bootDir := dir
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(bootDir)
		}
	}()
	data := filepath.Join(dir, "data")
	cred, err := unprivileged()
	if err != nil {
		return "", nil, "", err
	}
	if cred != nil {
		// initdb refuses to run as root; the whole tree must be owned by the
		// unprivileged user that will own the server process.
		if err := os.Chown(dir, int(cred.Uid), int(cred.Gid)); err != nil {
			return "", nil, "", err
		}
	}
	// cmd returns a fresh, never-yet-run *exec.Cmd with no Stdout/Stderr set.
	// That matters: exec.Cmd.CombinedOutput panics with "exec: Stdout already
	// set" if either stream is already assigned, so the one-shot initdb call
	// below (which wants captured output) and the long-running postgres
	// process (which wants to stream to os.Stderr) each set the streams
	// exactly once, on their own Cmd, and never reuse a Cmd across the two.
	cmd := func(name string, args ...string) *exec.Cmd {
		c := exec.Command(filepath.Join(binDir, name), args...)
		if cred != nil || detach {
			attr := &syscall.SysProcAttr{}
			if cred != nil {
				attr.Credential = cred
			}
			if detach {
				attr.Setsid = true
			}
			c.SysProcAttr = attr
		}
		return c
	}
	// --locale=C.UTF-8 matches the production cluster (Task D5), not the
	// initdb default. If this is ever changed to --locale=C for expediency,
	// note it here: `C` collates byte-wise and does not match the
	// linguistic/case-folding behavior C.UTF-8 gives production, so
	// ORDER BY, LIKE and index usability on text columns could diverge
	// between test and prod. Do not make that change silently.
	if out, err := cmd("initdb", "-D", data, "-U", "postgres", "-A", "trust",
		"--encoding=UTF8", "--locale=C.UTF-8").CombinedOutput(); err != nil {
		return "", nil, "", fmt.Errorf("initdb: %v: %s", err, out)
	}
	// 5433 is hardcoded and reused by every cluster this package boots,
	// concurrently or not: listen_addresses="" (below) means postgres never
	// binds a TCP port at all, so "port" only names the unix socket file
	// (.s.PGSQL.5433) inside this cluster's own -k dir. Two clusters in two
	// different temp dirs using the same number don't collide — there is no
	// shared namespace to collide in.
	port := 5433
	srv = cmd("postgres", "-D", data, "-k", dir, "-p", strconv.Itoa(port),
		"-c", "listen_addresses=", "-c", "fsync=off", "-c", "full_page_writes=off",
		"-c", "synchronous_commit=off")
	srv.Stdout, srv.Stderr = os.Stderr, os.Stderr // long-running: stream, never capture
	if err := srv.Start(); err != nil {
		return "", nil, "", err
	}
	dsn = fmt.Sprintf("postgres://postgres@/postgres?host=%s&port=%d&sslmode=disable", dir, port)
	if err := waitReady(dsn); err != nil {
		_ = srv.Process.Kill()
		_, _ = srv.Process.Wait() // reap now: nothing else is going to
		return "", nil, "", err
	}
	ok = true
	return dir, srv, dsn, nil
}

// unprivileged returns the credential to run the server under, or nil when
// this process is already unprivileged.
func unprivileged() (*syscall.Credential, error) {
	if os.Geteuid() != 0 {
		return nil, nil
	}
	name := os.Getenv("LEDGER_TEST_PG_USER")
	if name == "" {
		name = "nobody"
	}
	u, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("lookup %q: %w", name, err)
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	return &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}, nil
}

func waitReady(dsn string) error {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		pool, err := pgxpool.New(context.Background(), dsn)
		if err == nil {
			if err = pool.Ping(context.Background()); err == nil {
				pool.Close()
				return nil
			}
			pool.Close()
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("postgres did not become ready")
}
