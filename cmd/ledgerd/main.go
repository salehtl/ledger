// Command ledgerd is the v2 multi-user server. It shares no state, no port and
// no database with the v1 `ledger` binary.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"ledger/internal/v2/config"
	"ledger/internal/v2/pg"
)

func main() {
	mode := "serve"
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		mode = os.Args[1]
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	var cfgPath string
	flag.StringVar(&cfgPath, "config", "", "path to config.toml")
	flag.Parse()

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.Mode = mode

	switch mode {
	case "serve":
		err = runServe(cfg)
	case "relay":
		err = runRelay(cfg)
	case "verify":
		err = runVerify(cfg)
	case "seed-dictionary":
		err = runSeedDictionary(cfg)
	case "purge-user":
		err = runPurgeUser(cfg)
	case "parse-rate":
		err = runParseRate(cfg)
	default:
		err = fmt.Errorf("unknown mode %q (%s)", mode, strings.Join(config.Modes(), "|"))
	}
	if err != nil {
		log.Fatal(err)
	}
}

// runServe opens the Postgres pool, applies every embedded migration, logs
// readiness, and blocks until SIGINT/SIGTERM. This is deliberately the whole
// of "serve" for now: the sync API (Task 9), the SMTP receiver (Task 24) and
// the Tailscale-bound admin listener (Task 32) all mount onto this same
// startup sequence as their tasks land — none of them exist yet, so there is
// nothing to serve beyond proving the database is reachable and migrated.
func runServe(cfg config.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer pool.Close()

	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	log.Println("ledgerd serve: migrations applied")

	<-ctx.Done()
	log.Println("shutting down")
	return nil
}

// runRelay will start the SMTP receiver in relay mode: a durable local spool
// plus a drain loop that forwards to the primary. Task 35.
func runRelay(cfg config.Config) error {
	return errors.New("ledgerd relay: not implemented yet (Task 35)")
}

// runVerify will run the offline structural checker and mail-accounting
// report against cfg.Server.DSN. Task 36.
func runVerify(cfg config.Config) error {
	return errors.New("ledgerd verify: not implemented yet (Task 36)")
}

// runSeedDictionary will one-shot import the operator's v1 categorization
// rules into the merchant dictionary, bypassing the k-submitter threshold
// because it is the operator's own data, not a crowd signal. Task 33.
func runSeedDictionary(cfg config.Config) error {
	return errors.New("ledgerd seed-dictionary: not implemented yet (Task 33)")
}

// runPurgeUser will delete a user's account and enforce retention limits
// across every table Task 34's schema discovery finds. Task 34.
func runPurgeUser(cfg config.Config) error {
	return errors.New("ledgerd purge-user: not implemented yet (Task 34)")
}

// runParseRate will report the Task 36 parse-rate instrument used to measure
// the alpha's two-week exit criterion. PHASE 1 ONLY. Task 36.
func runParseRate(cfg config.Config) error {
	return errors.New("ledgerd parse-rate: not implemented yet (Task 36)")
}
