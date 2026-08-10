package main

// consent.go — `ledgerd record-consent`, recording (and listing) the
// signed-consent records the retention enforcer in purgeuser.go reads (spec
// §5, Task 34). Split out of main.go for the same reason verify.go and
// seedtemplates.go were.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/config"
	"ledger/internal/v2/pg"
	"ledger/internal/v2/purge"
)

// runRecordConsent writes (or replaces) an account's signed-consent record, or
// with --show lists what is on file. Spec §5, Task 34.
//
// It exists because the enforcer had no input. `purge-user --retention-due`
// reads user_consent.retention_until, and until this command landed NOTHING
// anywhere wrote that column: a sweep run a hundred years past every deadline
// purged zero accounts and reported one as having no record. A retention
// commitment with a table, an enforcer and no way to record a deadline is a
// commitment in name only.
//
// Recording is deliberately manual. The row asserts that a specific person
// signed a specific document on a specific date; a row written automatically by
// the sign-up path would be the server asserting a signature nobody made.
func runRecordConsent(cfg config.Config) error {
	// Argument validation FIRST, before any I/O, on the same terms as
	// purge-user: this command sets a date on which an account gets deleted.
	var (
		target                uuid.UUID
		signedAt, retainUntil time.Time
		err                   error
	)
	if !cfg.Consent.Show {
		switch {
		case cfg.Consent.User == "":
			return errors.New("ledgerd record-consent: --user <uuid> is required (or --show to list what is on file)")
		case cfg.Consent.Document == "":
			return errors.New("ledgerd record-consent: --document <identifier> is required, e.g. " +
				"--document alpha-plaintext-v1; it names the consent text that was signed")
		case cfg.Consent.RetentionUntil == "":
			return errors.New("ledgerd record-consent: --retention-until <RFC3339> is required; " +
				"it is the instant this account's plaintext must be gone, and the whole point of the record")
		}
		if target, err = uuid.Parse(cfg.Consent.User); err != nil || target == uuid.Nil {
			return fmt.Errorf("ledgerd record-consent: --user %q is not a uuid", cfg.Consent.User)
		}
		if retainUntil, err = time.Parse(time.RFC3339, cfg.Consent.RetentionUntil); err != nil {
			return fmt.Errorf("ledgerd record-consent: --retention-until %q is not an RFC3339 instant "+
				"(e.g. 2027-01-31T00:00:00Z)", cfg.Consent.RetentionUntil)
		}
		signedAt = time.Now()
		if cfg.Consent.SignedAt != "" {
			if signedAt, err = time.Parse(time.RFC3339, cfg.Consent.SignedAt); err != nil {
				return fmt.Errorf("ledgerd record-consent: --signed-at %q is not an RFC3339 instant",
					cfg.Consent.SignedAt)
			}
		}
		if !retainUntil.After(signedAt) {
			return fmt.Errorf("ledgerd record-consent: --retention-until %s is not after the signature %s",
				retainUntil.UTC(), signedAt.UTC())
		}
	}

	ctx := context.Background()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd record-consent: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd record-consent: migrate: %w", err)
	}

	if cfg.Consent.Show {
		return showConsent(ctx, pool)
	}
	if err := purge.RecordConsent(ctx, pool, target, cfg.Consent.Document, signedAt, retainUntil); err != nil {
		return fmt.Errorf("ledgerd record-consent: %w", err)
	}
	fmt.Printf("recorded consent for %s: document %s, signed %s, plaintext retained until %s\n",
		target, cfg.Consent.Document, signedAt.UTC().Format(time.RFC3339), retainUntil.UTC().Format(time.RFC3339))
	fmt.Println("enforce with: ledgerd record-consent --show, then " +
		"ledgerd purge-user --retention-due --dry-run")
	return nil
}

// showConsent lists every account beside its deadline, including the ones with
// no record at all — which are the interesting ones, since they are the
// accounts the retention sweep will report and refuse to act on.
func showConsent(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `
		SELECT u.id, c.document, c.signed_at, c.retention_until
		  FROM users u LEFT JOIN user_consent c ON c.user_id = u.id
		 ORDER BY c.retention_until NULLS FIRST, u.id`)
	if err != nil {
		return fmt.Errorf("ledgerd record-consent: %w", err)
	}
	defer rows.Close()
	missing, now := 0, time.Now()
	for rows.Next() {
		var (
			id                  uuid.UUID
			doc                 *string
			signed, retainUntil *time.Time
		)
		if err := rows.Scan(&id, &doc, &signed, &retainUntil); err != nil {
			return fmt.Errorf("ledgerd record-consent: %w", err)
		}
		if retainUntil == nil {
			missing++
			fmt.Printf("%s  NO CONSENT RECORD — the retention sweep will report and skip this account\n", id)
			continue
		}
		state := "current"
		if !retainUntil.After(now) {
			state = "OVERDUE"
		}
		fmt.Printf("%s  %-24s signed %s  retained until %s  %s\n",
			id, *doc, signed.UTC().Format(time.RFC3339),
			retainUntil.UTC().Format(time.RFC3339), state)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("ledgerd record-consent: %w", err)
	}
	if missing > 0 {
		fmt.Printf("\n%d account(s) have no consent record. Spec §5 admits alphas under signed "+
			"consent with a retention limit; an account without one is outside that promise.\n", missing)
	}
	return nil
}
