package admin

// waitlist.go is the bank-demand counter behind GET/POST /admin/waitlist.
//
// See migrations/00012_waitlist.sql for why this is an aggregate rather than a
// list of submissions — the short version is that a per-submission table would
// be a durable record of which financial institution a named person uses, kept
// for a feature whose entire output is "write the Mashreq parser next".

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrInvalidBank means the submission is not a bank name this table will store.
var ErrInvalidBank = errors.New("admin: not a bank name")

// maxBankName is the longest name stored. Real bank names — "Al Maryah
// Community Bank", "Industrial and Commercial Bank of China" — fit well inside
// it; anything longer is a sentence, and a sentence is content.
const maxBankName = 64

// bankRe is the Go half of the grammar the waitlist_bank_is_bounded CHECK
// repeats. Lower-case because Record normalizes before it validates: the two
// are one operation, and validating the raw form would make the accepted set
// depend on capitalisation.
//
// The four permitted punctuation marks are the ones that occur in real names:
// "M&S Bank", "St. George's Bank", "Al-Rajhi". A name must begin and end
// alphanumeric, so a submission cannot be punctuation alone.
var bankRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9 &.'-]{0,62}[a-z0-9])?$`)

// amountRe rejects a decimal number anywhere in the name.
//
// The grammar above is a SHAPE check, and shape alone cannot tell "Bank of
// Baroda" from a pasted transaction line — "AED 25.00 STARBUCKS" is letters,
// digits, spaces and a full stop, and passes it. A decimal amount is the one
// feature that paste reliably has and no bank name has, so it is refused
// specifically.
//
// The residual is real and worth stating rather than papering over: "aed 25
// starbucks" still passes, and no grammar over a 64-character string will
// separate a short paste from a short name. What bounds the damage is that this
// is a counter reachable only from the tailnet, that the stored value is capped
// at 64 characters, and that nothing here is ever attributed to a person.
var amountRe = regexp.MustCompile(`[0-9]\.[0-9]`)

// Entry is one bank's demand.
type Entry struct {
	Bank      string    `json:"bank"`
	Demand    int64     `json:"count"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
}

// Waitlist owns the waitlist table.
type Waitlist struct {
	Pool *pgxpool.Pool
	// Now defaults to time.Now.
	Now func() time.Time
}

func (w *Waitlist) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

func (w *Waitlist) check() error {
	if w == nil || w.Pool == nil {
		return errors.New("admin: Waitlist.Pool is nil")
	}
	return nil
}

// NormalizeBank folds a submission to its stored form, or returns
// [ErrInvalidBank].
//
// Exported because the HTTP layer answers 400 on exactly this error and a test
// should be able to ask the question without a database.
func NormalizeBank(raw string) (string, error) {
	// Collapse ALL Unicode whitespace, not just spaces: a tab or a non-breaking
	// space between words is the same bank, and leaving it in would produce a
	// second row the grammar then rejects for a reason that reads as arbitrary.
	name := strings.ToLower(strings.Join(strings.Fields(raw), " "))
	if name == "" {
		return "", fmt.Errorf("%w: empty", ErrInvalidBank)
	}
	if len(name) > maxBankName {
		return "", fmt.Errorf("%w: longer than %d characters", ErrInvalidBank, maxBankName)
	}
	if amountRe.MatchString(name) {
		return "", fmt.Errorf("%w: a bank name does not contain a decimal amount "+
			"(this looks like a pasted transaction line)", ErrInvalidBank)
	}
	if !bankRe.MatchString(name) {
		return "", fmt.Errorf("%w: a bank name is letters, digits, spaces and & . ' - "+
			"(send a value from the onboarding picker, or \"other\")", ErrInvalidBank)
	}
	return name, nil
}

const recordSQL = `
INSERT INTO waitlist (bank, demand, first_seen, last_seen)
VALUES ($1, 1, $2, $2)
ON CONFLICT (bank) DO UPDATE
   SET demand = waitlist.demand + 1,
       last_seen = EXCLUDED.last_seen`

// Record adds one to a bank's demand, creating the row on first sighting.
//
// first_seen is never updated — it is the answer to "how long have people been
// asking for this", which a later submission does not change.
func (w *Waitlist) Record(ctx context.Context, raw string) error {
	if err := w.check(); err != nil {
		return err
	}
	bank, err := NormalizeBank(raw)
	if err != nil {
		return err
	}
	if _, err := w.Pool.Exec(ctx, recordSQL, bank, w.now()); err != nil {
		return fmt.Errorf("admin: record waitlist demand: %w", err)
	}
	return nil
}

// List returns every bank, most wanted first, ties broken alphabetically so the
// console's order is stable between reads.
func (w *Waitlist) List(ctx context.Context) ([]Entry, error) {
	if err := w.check(); err != nil {
		return nil, err
	}
	rows, err := w.Pool.Query(ctx,
		`SELECT bank, demand, first_seen, last_seen FROM waitlist ORDER BY demand DESC, bank`)
	if err != nil {
		return nil, fmt.Errorf("admin: read waitlist: %w", err)
	}
	defer rows.Close()

	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Bank, &e.Demand, &e.FirstSeen, &e.LastSeen); err != nil {
			return nil, fmt.Errorf("admin: read waitlist: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("admin: read waitlist: %w", err)
	}
	return out, nil
}
