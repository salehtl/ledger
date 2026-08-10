package main

// seeddictionary.go — `ledgerd seed-dictionary`, the one-shot import of the
// operator's v1 categorization rules into the merchant dictionary (spec §3.6,
// Task 33). Split out of main.go for the same reason verify.go and
// seedtemplates.go were.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"ledger/internal/v2/config"
	"ledger/internal/v2/corpus"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/pg"
)

// runSeedDictionary one-shot imports the operator's v1 categorization rules
// into the merchant dictionary (spec §3.6, Task 33).
//
// The seed bypasses the k-submitter threshold and ONLY that: it is one
// identified party's own data contributed deliberately, not a crowd signal that
// could be a single user's fingerprint, so there is nobody for the threshold to
// protect. It does NOT bypass moderation — every seeded entry lands unmoderated
// and publishes nothing until the operator approves it, which for a few hundred
// of the operator's own rules is what POST /admin/dictionary/approve-seed is
// for.
//
// It is idempotent: re-running it after fixing v1's rules adds what is new and
// leaves every moderation decision already made alone.
//
// The reconciliation output is the point of the printed summary. v1's rule
// table is not a clean set — it holds inactive rules, exact duplicates, and
// genuine conflicts where one pattern was confirmed into two different
// categories — so "seeded N" alone would not add up against
// `select count(*) from rules` and the operator would be left guessing which
// direction the discrepancy went.
func runSeedDictionary(cfg config.Config) error {
	path := corpus.DefaultPath()
	if path == "" {
		return errors.New("ledgerd seed-dictionary: set LEDGER_CORPUS_DB to a `.backup` " +
			"snapshot of the v1 database (internal/v2/corpus refuses the live one)")
	}
	db, err := corpus.Open(path)
	if err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: %w", err)
	}
	defer db.Close()

	rules, err := db.Rules()
	if err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: %w", err)
	}

	// Canonicalize and dedupe HERE rather than inside dict.SeedFromV1, so the
	// numbers below are the ones actually written and not an estimate.
	var (
		entries  []dict.Entry
		seen     = map[dict.Entry]bool{}
		inactive int
		dupes    int
		skipped  []string
	)
	for _, r := range rules {
		if !r.Active {
			inactive++
			continue
		}
		e, err := dict.Canonicalize(dict.Entry{
			Pattern: r.Pattern, Match: r.MatchType, Category: r.Category,
		})
		if err != nil {
			// A rule v2 will not accept — a regex, an out-of-range pattern —
			// is REPORTED, never dropped silently: a missing rule shows up
			// later as a merchant that stopped categorizing, with nothing to
			// connect it to this run.
			skipped = append(skipped, fmt.Sprintf("%s %q: %v", r.MatchType, r.Pattern, err))
			continue
		}
		key := dict.Entry{Pattern: e.Pattern, Category: e.Category}
		if seen[key] {
			dupes++
			continue
		}
		seen[key] = true
		entries = append(entries, e)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: migrate: %w", err)
	}

	// No HMAC key is needed: seeding writes no submitter identifier, because a
	// seeded entry never needs a count. Requiring one here would make the
	// operator configure a secret this command does not use.
	d := &dict.Dict{Pool: pool}
	if err := d.SeedFromV1(ctx, entries); err != nil {
		return fmt.Errorf("ledgerd seed-dictionary: %w", err)
	}

	for _, s := range skipped {
		log.Printf("seed-dictionary: skipped %s", s)
	}
	fmt.Printf("seeded %d operator rules (from %d v1 rules: %d inactive, %d duplicate, %d unusable)\n",
		len(entries), len(rules), inactive, dupes, len(skipped))
	fmt.Println("all seeded entries are UNMODERATED and publish nothing until approved " +
		"(POST /admin/dictionary/approve-seed)")
	return nil
}
