package main

// seedtemplates.go is the deploy-time half of spec §3.5's "the three existing
// corpus-validated parsers, ported into the template store".
//
// The port itself landed in Phase 1 and its corpus parity gate passed — 5,719
// template hits, 0 mismatches. What never landed was any way for those
// templates to reach a database: internal/v2/tmpl/seed was imported by nothing
// and tmpl.Store.Publish had no production caller, so a freshly migrated
// ledgerd served with an EMPTY templates table and parsed no bank mail at all.
// The Phase 2 plan even instructed the operator to "run Phase 1's seed path",
// which did not exist.
//
// # Why BOTH a subcommand and a call in runServe
//
// A subcommand alone reproduces the same defect one level up: it only works if
// somebody remembers, and forgetting is silent — the symptom is a beta where
// every alpha's mail lands unparsed on day one, with a diagnostics ledger that
// says the templates were never tried. So runServe seeds too, on every start,
// which is safe precisely because seed.Apply publishes only what is strictly
// newer than what is stored.
//
// The subcommand is still worth having: it is how an operator applies a bumped
// seed without restarting, and how a deployment can be checked before the
// listener opens.

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/config"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/tmpl"
	"ledger/internal/v2/tmpl/seed"
)

// runSeedTemplates publishes the embedded bank templates into the configured
// database, then reports what it did.
//
// It is idempotent and re-runnable: see [seed.Apply]. Running it against a
// store the operator has since moved forward — a hand-authored fix at a higher
// version — reports `kept` and writes nothing.
func runSeedTemplates(cfg config.Config) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd seed-templates: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd seed-templates: migrate: %w", err)
	}

	applied, err := seedTemplates(ctx, pool)
	if err != nil {
		return fmt.Errorf("ledgerd seed-templates: %w", err)
	}
	for _, a := range applied {
		fmt.Printf("%-9s %s version %d\n", a.Action, a.ID, a.Version)
	}
	fmt.Printf("%d of %d seed templates published; %d already current\n",
		seed.Published(applied), len(applied), len(applied)-seed.Published(applied))
	return nil
}

// seedTemplates is the one call both the subcommand and runServe make, so
// "what a deploy publishes" and "what a restart publishes" cannot drift.
func seedTemplates(ctx context.Context, pool *pgxpool.Pool) ([]seed.Applied, error) {
	return seed.Apply(ctx, &tmpl.Store{Pool: pool})
}

// logSeededTemplates runs the seed during startup and reports it to the log.
//
// A failure here is fatal to the start, deliberately. The alternative —
// carrying on with whatever is in the table — is exactly the state this file
// exists to end: a server that runs, answers health checks, accepts mail, and
// silently parses none of it.
func logSeededTemplates(ctx context.Context, pool *pgxpool.Pool) error {
	applied, err := seedTemplates(ctx, pool)
	if err != nil {
		return fmt.Errorf("seed templates: %w", err)
	}
	if n := seed.Published(applied); n > 0 {
		for _, a := range applied {
			if a.Action == seed.ActionPublished {
				log.Printf("ledgerd serve: published bank template %s version %d", a.ID, a.Version)
			}
		}
		log.Printf("ledgerd serve: %d bank template(s) published, %d already current", n, len(applied)-n)
		return nil
	}
	log.Printf("ledgerd serve: %d bank template(s) already current", len(applied))
	return nil
}
