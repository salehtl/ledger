package pgtest_test

// This file covers BootStandalone and, indirectly, cmd/boot — the only
// piece of internal/v2/pgtest that had zero automated coverage: cmd/boot's
// own main.go is a ~10-line wrapper (call BootStandalone, print two lines),
// so exercising BootStandalone directly covers the actual logic without the
// overhead and flakiness risk of shelling out to `go run` inside a test.
//
// It does not use pgtest.Main/TestMain: BootStandalone manages a complete,
// independent cluster of its own (that's the whole point — see
// scripts/v2-check.sh), so this package needs no package-level cluster to
// run its own tests against.

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/pgtest"
)

func TestBootStandaloneServesConnectionsAndStopScriptTearsDown(t *testing.T) {
	dsn, stopScript, err := pgtest.BootStandalone()
	if err != nil {
		t.Fatalf("BootStandalone: %v", err)
	}
	// Safety net: BootStandalone's whole point is a cluster that survives
	// its caller (Setsid-detached), so if any assertion between here and
	// the explicit stop-script run below fails, t.Fatal unwinds without
	// ever running it — leaking a live postgres process plus its
	// /tmp/pgtest-* directory.
	//
	// stop.sh is NOT idempotent — verified by actually invoking it twice:
	// its own `rm -rf` removes the directory it lives in, i.e. itself, so a
	// second `exec.Command(stopScript).Run()` after a successful first run
	// fails with "fork/exec ...: no such file or directory". In the
	// normal-pass case the explicit invocation below always runs first (a
	// t.Cleanup func runs after the test body returns, never before), so
	// guard with an existence check rather than relying on the second call
	// being silently swallowed: if the script is already gone, the explicit
	// run below already tore everything down and there's nothing left to do.
	t.Cleanup(func() {
		if _, err := os.Stat(stopScript); err == nil {
			_ = exec.Command(stopScript).Run()
		}
	})
	if stopScript == "" {
		t.Fatal("BootStandalone returned an empty stop script path")
	}
	if fi, err := os.Stat(stopScript); err != nil {
		t.Fatalf("stat stop script: %v", err)
	} else if fi.Mode()&0o100 == 0 {
		t.Fatalf("stop script %s is not executable: mode %v", stopScript, fi.Mode())
	}

	// The server must be reachable from a connection that has nothing to do
	// with the process that booted it — that's the property BootStandalone
	// exists for: a `go run` process prints and exits while the server it
	// started keeps serving.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect to standalone cluster: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping standalone cluster: %v", err)
	}
	pool.Close()

	stop := exec.Command(stopScript)
	if out, err := stop.CombinedOutput(); err != nil {
		t.Fatalf("run stop script: %v: %s", err, out)
	}

	// Give the (now stopped) server a moment to actually release the socket,
	// then confirm connecting fails and the data directory is gone — a stop
	// script that "succeeds" without actually tearing anything down is the
	// failure mode this test is for.
	deadline := time.Now().Add(5 * time.Second)
	var pingErr error
	for time.Now().Before(deadline) {
		p, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			pingErr = err
			break
		}
		pingErr = p.Ping(context.Background())
		p.Close()
		if pingErr != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if pingErr == nil {
		t.Fatal("stop script ran but the cluster is still accepting connections")
	}
}
