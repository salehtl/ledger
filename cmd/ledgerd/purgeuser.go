package main

// purgeuser.go — `ledgerd purge-user`, the operator's account-deletion and
// retention-enforcement command (spec §3.10, Task 34). Split out of main.go
// for the same reason verify.go and seedtemplates.go were.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/config"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/purge"
)

// runPurgeUser deletes a user's account, or enforces the plaintext-retention
// deadline across every account past it, using the schema discovery in
// internal/v2/purge. Task 34, spec §3.10.
//
// This is the OPERATOR's path. The user's own path is DELETE /api/v1/account,
// which is gated on fresh IdP re-authentication plus key possession; this one
// is gated on having a shell on the box, which is the strongest gate available
// and the only one that works for a user who has lost every device.
//
// # Why the retention sweep is a command and not a ticker
//
// runServe starts a sweep for quarantine expiry and one for donated-sample
// retention, and deliberately starts NONE for this. Those two delete a message;
// this deletes a person's entire account, and in a phase with a handful of
// alpha users, no in-app deletion UX yet and a consent deadline that may be
// extended by re-consenting, an unattended timer that removes accounts is a
// footgun with no upside — the operator running `purge-user --retention-due`
// (after `--dry-run`) knows it happened, which is precisely the property an
// automated sweep gives up. It is a deliberate decision, not an oversight;
// revisit it when deletion is self-service and the population is not five
// people the operator can name.
func runPurgeUser(cfg config.Config) error {
	// Argument validation FIRST, before any I/O: a mistyped invocation of a
	// destructive command must fail against the arguments, not against
	// whatever DSN happened to be in the environment.
	switch {
	case cfg.Purge.User == "" && !cfg.Purge.RetentionDue:
		return errors.New("ledgerd purge-user: nothing selected: pass --user <uuid> to delete one " +
			"account, or --retention-due to delete every account past its consent retention deadline")
	case cfg.Purge.User != "" && cfg.Purge.RetentionDue:
		return errors.New("ledgerd purge-user: --user and --retention-due are alternatives; " +
			"pass exactly one")
	}
	var target uuid.UUID
	if cfg.Purge.User != "" {
		var err error
		if target, err = uuid.Parse(cfg.Purge.User); err != nil {
			return fmt.Errorf("ledgerd purge-user: --user %q is not a uuid", cfg.Purge.User)
		}
		if target == uuid.Nil {
			return errors.New("ledgerd purge-user: --user is the nil uuid, which names no account")
		}
	}

	ctx := context.Background()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd purge-user: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd purge-user: migrate: %w", err)
	}

	// The HMAC key is REQUIRED to forget a user's merchant-dictionary
	// submissions, and purge.Purge refuses rather than skipping them when it is
	// absent and the table is not empty. Built the same way api.NewServer does.
	d := &dict.Dict{Pool: pool}
	if cfg.DictHMACKey != "" {
		key, err := dict.ParseKey(cfg.DictHMACKey)
		if err != nil {
			return fmt.Errorf("ledgerd purge-user: %w", err)
		}
		d.HMACKey = key
	}

	if cfg.Purge.DryRun {
		return purgeDryRun(ctx, pool, target, cfg.Purge.RetentionDue)
	}

	var rep purge.Report
	if cfg.Purge.RetentionDue {
		rep, err = purge.EnforceRetention(ctx, pool, d, time.Now())
	} else {
		rep, err = purge.Purge(ctx, pool, d, target)
	}
	// The report is printed even on failure. A purge that failed part-way
	// through is exactly when an operator most needs to know what DID happen,
	// and an error that swallowed the report would leave them guessing.
	printPurgeReport(rep)
	if err != nil {
		return fmt.Errorf("ledgerd purge-user: %w", err)
	}
	if len(rep.Users) == 0 {
		fmt.Println("no accounts matched; nothing was deleted")
	}
	return nil
}

// purgeDryRun reports what a purge would remove without removing it.
//
// It runs the SAME schema discovery and the same classification check the real
// purge does, so "the dry run was clean" means the real one will not refuse for
// a reason the dry run could have found.
func purgeDryRun(ctx context.Context, pool *pgxpool.Pool, target uuid.UUID, retentionDue bool) error {
	c, err := purge.Classify(ctx, pool)
	if err != nil {
		return fmt.Errorf("ledgerd purge-user: %w", err)
	}
	if len(c.Unclassified) != 0 {
		return fmt.Errorf("ledgerd purge-user: a real purge would REFUSE: unclassified tables %v",
			c.Unclassified)
	}
	targets := []uuid.UUID{target}
	if retentionDue {
		if targets, err = purge.DueForRetention(ctx, pool, time.Now()); err != nil {
			return fmt.Errorf("ledgerd purge-user: %w", err)
		}
	}
	if len(targets) == 0 {
		fmt.Println("dry run: no accounts are past their retention deadline")
		return nil
	}
	total := 0
	for _, u := range targets {
		fmt.Printf("dry run: account %s\n", u)
		for _, r := range c.UserScoped {
			var n int
			// r.SQL() quotes the schema and the name as two identifiers. A
			// relation outside `public` is now discovered, so the preview has
			// to be able to address one.
			if err := pool.QueryRow(ctx,
				`SELECT count(*) FROM `+r.SQL()+` WHERE user_id = $1`, u).Scan(&n); err != nil {
				return fmt.Errorf("ledgerd purge-user: count %s: %w", r, err)
			}
			if n > 0 {
				fmt.Printf("  %-40s %d\n", r, n)
			}
			total += n
		}
	}
	fmt.Printf("dry run: %d rows across %d account(s) would be deleted, plus their "+
		"dictionary submitter identifiers. Nothing was deleted.\n", total, len(targets))
	return nil
}

func printPurgeReport(rep purge.Report) {
	for _, u := range rep.Users {
		fmt.Printf("purged account %s\n", u)
	}
	tables := make([]string, 0, len(rep.Rows))
	for tb := range rep.Rows {
		tables = append(tables, tb)
	}
	sort.Strings(tables)
	for _, tb := range tables {
		if rep.Rows[tb] > 0 {
			fmt.Printf("  %-40s %d\n", tb, rep.Rows[tb])
		}
	}
	if rep.DictSubmissions > 0 {
		fmt.Printf("  %-40s %d\n", "dict_submissions", rep.DictSubmissions)
	}
	if len(rep.SweptWithoutCascade) > 0 {
		fmt.Printf("WARNING: these tables needed an explicit sweep because their user_id "+
			"foreign key is missing ON DELETE CASCADE: %v\n", rep.SweptWithoutCascade)
	}
	if len(rep.RefreshedViews) > 0 {
		fmt.Printf("WARNING: these MATERIALIZED VIEWS held rows for the purged account and had "+
			"to be refreshed: %v. A matview is a stored copy of user data that nothing else in "+
			"the system tracks; check that it should exist at all.\n", rep.RefreshedViews)
	}
	if len(rep.WithoutConsentRecord) > 0 {
		fmt.Printf("NOTE: %d account(s) have no consent record and therefore no retention "+
			"deadline; they were NOT purged: %v\n",
			len(rep.WithoutConsentRecord), rep.WithoutConsentRecord)
	}
}
