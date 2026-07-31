// Command boot starts a single throwaway Postgres cluster and prints two
// shell variable assignments for scripts/v2-check.sh to `eval`:
//
//	LEDGER_TEST_POSTGRES_URL=...   the admin DSN, for the whole test run to share
//	PG_STOP=...                    path to a script that stops the server and
//	                                 removes its data directory
//
// This exists so that a run across every v2 package (there will be roughly
// twenty of them by the end of Phase 1) pays for exactly one initdb instead
// of one per package: each package's own TestMain (pgtest.Main) already
// prefers LEDGER_TEST_POSTGRES_URL over booting its own cluster when the
// variable is set — see internal/v2/pgtest/pgtest.go.
//
// The server outlives this process on purpose (BootStandalone starts it in
// its own session via SysProcAttr.Setsid): boot prints and exits immediately
// while postgres keeps serving connections in the background.
package main

import (
	"fmt"
	"os"

	"ledger/internal/v2/pgtest"
)

func main() {
	dsn, stopScript, err := pgtest.BootStandalone()
	if err != nil {
		fmt.Fprintf(os.Stderr, "boot: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("LEDGER_TEST_POSTGRES_URL=%q\n", dsn)
	fmt.Printf("PG_STOP=%q\n", stopScript)
}
