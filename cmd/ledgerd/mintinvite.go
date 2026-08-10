package main

// mintinvite.go — `ledgerd mint-invite`, minting (and listing) the closed
// beta's single-use signup codes (Phase 2, Decision 8). Split out of main.go
// for the same reason verify.go and seedtemplates.go were.

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/config"
	"ledger/internal/v2/pg"
)

// runMintInvite creates one single-use invite code and prints it, or lists what
// has already been minted.
//
// # Why this command exists
//
// The closed beta gates ACCOUNT CREATION on a code (Phase 2, Decision 8). The
// alternative — an allowlist keyed on the IdP subject — cannot be populated,
// because a subject is not knowable until the first sign-in, which is the event
// being gated. So the key has to be a secret the operator invents, and this is
// where it is invented.
//
// The code is printed ONCE, to stdout, and only its SHA-256 is stored. There is
// no command that recovers it: an operator who loses one mints another, which
// is a five-second inconvenience, while a command that could print an existing
// code would make every database backup a bag of live invitations.
func runMintInvite(cfg config.Config) error {
	ctx := context.Background()
	pool, err := pg.Open(ctx, cfg.Server.DSN)
	if err != nil {
		return fmt.Errorf("ledgerd mint-invite: open postgres: %w", err)
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool); err != nil {
		return fmt.Errorf("ledgerd mint-invite: migrate: %w", err)
	}

	if cfg.Invite.Show {
		return showInvites(ctx, pool)
	}

	code, err := auth.MintInvite(ctx, pool, cfg.Invite.Note, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("ledgerd mint-invite: %w", err)
	}
	// The code alone on its own line, so that piping this into anything (a
	// message, a QR generator, `pbcopy`) gets the code and not a sentence.
	fmt.Println(code)
	fmt.Fprintln(os.Stderr, "this code is single use, gates ACCOUNT CREATION only, "+
		"and is not recoverable: it is stored as a hash. Hand it over out of band.")
	return nil
}

// showInvites lists what has been minted, newest first. The codes themselves
// are not there to list — a short hash prefix is what tells two rows apart.
func showInvites(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := auth.ListInvites(ctx, pool)
	if err != nil {
		return fmt.Errorf("ledgerd mint-invite: %w", err)
	}
	if len(rows) == 0 {
		fmt.Println("no invite codes have been minted")
		return nil
	}
	outstanding := 0
	for _, r := range rows {
		switch {
		case r.RedeemedAt == nil:
			outstanding++
			fmt.Printf("%s  minted %s  OUTSTANDING  %s\n",
				r.Hash, r.CreatedAt.UTC().Format(time.RFC3339), r.Note)
		case r.RedeemedBy == nil:
			// Redeemed, then the account was deleted: ON DELETE SET NULL leaves
			// the row saying a code was spent by nobody in particular.
			fmt.Printf("%s  minted %s  redeemed %s by a since-deleted account  %s\n",
				r.Hash, r.CreatedAt.UTC().Format(time.RFC3339),
				r.RedeemedAt.UTC().Format(time.RFC3339), r.Note)
		default:
			fmt.Printf("%s  minted %s  redeemed %s by %s  %s\n",
				r.Hash, r.CreatedAt.UTC().Format(time.RFC3339),
				r.RedeemedAt.UTC().Format(time.RFC3339), *r.RedeemedBy, r.Note)
		}
	}
	fmt.Printf("%d code(s), %d still outstanding\n", len(rows), outstanding)
	return nil
}
