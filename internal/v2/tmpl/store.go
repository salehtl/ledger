package tmpl

// store.go is the versioned template store: the publish-time gate, and the
// read path the ingest pipeline loads its parsers from.
//
// # Publishing is the gate, not a lint
//
// Spec §3.5 puts the regex dialect check at PUBLISH time. The reason is that
// there is no second chance: a published template is shipped to every device
// and executed there, so a pattern that reached the store is a pattern a phone
// must either run or refuse at load time, and neither is recoverable from the
// device's side. [ValidateForPublish] is therefore the only door into this
// table, and it runs the dialect check FIRST — before the definition validator
// that also happens to run it — so the gate the spec names is a visible,
// standalone step rather than a side effect of something else.
//
// # Versions are immutable
//
// A stored transaction records the (template_id, template_version) that
// produced it. Publishing over an existing version would make that reference
// describe something other than what ran, so [Store.Publish] refuses a version
// that already exists — including a byte-identical republish, because "this
// definition is unchanged" is a claim the store would have to verify and a
// caller re-publishing by accident is not communicating that claim.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The four statuses. They are a wire format shared with the admin console and
// the templates_status_is_closed CHECK; add one, never rename one.
const (
	// StatusDraft is authored but never live.
	StatusDraft = "draft"
	// StatusTesting is a candidate being replayed against donated samples.
	StatusTesting = "testing"
	// StatusPublished is THE live version. At most one per id.
	StatusPublished = "published"
	// StatusRetired was live and has been superseded. The row is kept because a
	// transaction that names this version must stay explainable.
	StatusRetired = "retired"
)

// Statuses lists the closed set, in lifecycle order.
func Statuses() []string { return []string{StatusDraft, StatusTesting, StatusPublished, StatusRetired} }

var (
	// ErrInvalidDefinition means the definition did not pass the publish gate.
	// It wraps the specific reasons; the message names them.
	ErrInvalidDefinition = errors.New("tmpl: definition rejected by the publish gate")
	// ErrVersionExists means this (id, version) is already stored. A fix is a
	// new version, never a rewrite.
	ErrVersionExists = errors.New("tmpl: this template version already exists")
	// ErrPublishConflict means another version of this template won the cutover
	// concurrently. It is retryable: publish again at a fresh version.
	ErrPublishConflict = errors.New("tmpl: another version of this template was published concurrently")
	// ErrNotFound means no such (id, version).
	ErrNotFound = errors.New("tmpl: no such template version")
	// ErrBadStatus means a status outside the closed set.
	ErrBadStatus = errors.New("tmpl: unknown template status")
)

// Store owns the templates table.
//
// It holds no state beyond its dependencies, so constructing one per request is
// correct and free.
type Store struct {
	Pool *pgxpool.Pool
	// Now defaults to time.Now. Injected for the same reason every other v2
	// store injects it: one clock decides created_at and published_at, and a
	// test can pin both.
	Now func() time.Time
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Store) check() error {
	if s == nil || s.Pool == nil {
		return errors.New("tmpl: Store.Pool is nil")
	}
	return nil
}

// ---------------------------------------------------------------------------
// the publish gate
// ---------------------------------------------------------------------------

// ValidateForPublish is everything that must hold before a definition may be
// stored. It is exported so an admin console can show the operator the same
// verdict the store will reach, without a write.
//
// Three steps, in this order and for these reasons:
//
//  1. The DIALECT gate, over every pattern. This is the spec §3.5 gate. It runs
//     first and on its own so that removing it is a visible deletion rather
//     than an invisible consequence of refactoring step 2 — [ValidateDefinition]
//     happens to call [ValidatePattern] today, and a gate that exists only as
//     someone else's implementation detail is not a gate.
//
//     Stated honestly, because the alternative is a claim nothing backs:
//     deleting this loop is NOT caught by the test suite (measured — every
//     publish test still passes), precisely because step 2 covers the same
//     patterns today. The redundancy is the entire value. If step 2 ever stops
//     calling [ValidatePattern], this loop is what keeps an invalid pattern out
//     of the store, and it is here so that day needs no discovery.
//
//  2. The definition validator: field/type pairings, required fields, the
//     override budget, the sender-domain requirement.
//
//  3. [Compile]: the executor's own contract. A definition that validates but
//     that the executor cannot reach a value through is a template that
//     publishes and silently matches nothing.
func ValidateForPublish(d Definition) error {
	for i, x := range d.Extract {
		for j, p := range x.Patterns {
			if errs := ValidatePattern(p, x.Flags); len(errs) > 0 {
				return fmt.Errorf("%w: extract[%d].patterns[%d]: %s",
					ErrInvalidDefinition, i, j, strings.Join(Codes(errs), ", "))
			}
		}
	}
	if errs := ValidateDefinition(d); len(errs) > 0 {
		return fmt.Errorf("%w: %w", ErrInvalidDefinition, errors.Join(errs...))
	}
	if _, err := Compile(d); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidDefinition, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const insertTemplateSQL = `
INSERT INTO templates (id, version, bank, normalizer_version, definition, status, created_at, published_at)
VALUES ($1, $2, $3, $4, $5::jsonb, 'published', $6, $6)`

// Publish stores d as the live version of its template, retiring whatever was
// live before, in ONE transaction.
//
// Atomicity is the point: a reader must never see a template with no published
// version. The ingest pipeline reloads the published set on demand, and a
// window with nothing published is a window where genuine bank mail lands
// unparsed with no diagnostic explaining why.
func (s *Store) Publish(ctx context.Context, d Definition) error {
	if err := s.check(); err != nil {
		return err
	}
	if err := ValidateForPublish(d); err != nil {
		return err
	}
	// The canonical bytes, not encoding/json's: this is the form both executors
	// hash, and storing anything else would mean the stored template and the
	// hashed template are different objects.
	canonical, err := d.Canonical()
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidDefinition, err)
	}

	tx, err := s.begin(ctx)
	if err != nil {
		return err
	}
	defer s.rollback(ctx, tx)

	// Retiring first takes the row lock on the outgoing version, which is what
	// serializes two concurrent cutovers of the same template: the loser's
	// UPDATE re-evaluates after the winner commits, finds nothing published,
	// and its INSERT then collides with the winner on templates_one_published.
	if _, err := tx.Exec(ctx,
		`UPDATE templates SET status = $2 WHERE id = $1 AND status = $3`,
		d.ID, StatusRetired, StatusPublished); err != nil {
		return fmt.Errorf("tmpl: retire the live version of %s: %w", d.ID, err)
	}

	now := s.now()
	if _, err := tx.Exec(ctx, insertTemplateSQL,
		d.ID, d.Version, d.Bank, d.NormalizerVersion, string(canonical), now); err != nil {
		switch constraintOf(err) {
		case "templates_pkey":
			return fmt.Errorf("%w: %s version %d", ErrVersionExists, d.ID, d.Version)
		case "templates_one_published":
			return fmt.Errorf("%w: %s", ErrPublishConflict, d.ID)
		default:
			return fmt.Errorf("tmpl: publish %s version %d: %w", d.ID, d.Version, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		// A unique violation can also surface at COMMIT rather than at INSERT
		// (a deferred check, or the index wait resolving in the loser's
		// favour), so the same mapping is applied here. Without it a routine
		// concurrent publish would look like an infrastructure failure.
		if constraintOf(err) == "templates_one_published" {
			return fmt.Errorf("%w: %s", ErrPublishConflict, d.ID)
		}
		return fmt.Errorf("tmpl: publish %s version %d: commit: %w", d.ID, d.Version, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

// Published returns every live template, ordered by id.
//
// The ingest pipeline caches the result in memory; nothing here is per-message
// work.
//
// A stored definition that this build cannot read is an ERROR, not a skipped
// row. Skipping would degrade silently — every message from that bank becomes
// unparsed, with a diagnostics ledger that says the template was never even
// tried — whereas an error at load names the row. Publish gates every write, so
// reaching this means the row was edited outside this package or the reader
// itself changed.
func (s *Store) Published(ctx context.Context) ([]Definition, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT id, version, definition FROM templates WHERE status = $1 ORDER BY id`, StatusPublished)
	if err != nil {
		return nil, fmt.Errorf("tmpl: read published templates: %w", err)
	}
	defer rows.Close()

	var out []Definition
	for rows.Next() {
		var (
			id      string
			version int
			raw     []byte
		)
		if err := rows.Scan(&id, &version, &raw); err != nil {
			return nil, fmt.Errorf("tmpl: read published templates: %w", err)
		}
		d, err := ParseDefinition(raw)
		if err != nil {
			return nil, fmt.Errorf("tmpl: stored template %s version %d is unreadable: %w", id, version, err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tmpl: read published templates: %w", err)
	}
	return out, nil
}

// HighestVersions returns the highest stored version of every template id, in
// ANY status, or an empty map for an empty table.
//
// It exists for the deploy-time seed (internal/v2/tmpl/seed.Apply), which has
// to answer one question before it writes anything: is this template already
// managed here, at this version or a later one? [Store.All] would answer it too,
// but only by parsing every stored definition — so one retired template this
// build can no longer read would make seeding a NEW bank's parser fail, which
// is the opposite of what a deploy step should do. This reads the two columns
// the question is actually about and nothing else.
func (s *Store) HighestVersions(ctx context.Context) (map[string]int, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id, max(version) FROM templates GROUP BY id`)
	if err != nil {
		return nil, fmt.Errorf("tmpl: read stored template versions: %w", err)
	}
	defer rows.Close()

	out := map[string]int{}
	for rows.Next() {
		var (
			id      string
			version int
		)
		if err := rows.Scan(&id, &version); err != nil {
			return nil, fmt.Errorf("tmpl: read stored template versions: %w", err)
		}
		out[id] = version
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tmpl: read stored template versions: %w", err)
	}
	return out, nil
}

// ForSenderDomain returns the live templates that accept mail signed by domain.
//
// domain must be the CRYPTOGRAPHICALLY VERIFIED signing domain from the
// DKIM/ARC verifier — never an envelope sender, a From header, or
// norm.Result.From, all of which are attacker-authored.
//
// The filter is [MatchesSenderDomain] in Go rather than a LIKE in SQL, so the
// label-boundary rule has exactly one implementation. Expressed twice, the two
// would eventually disagree about whether "evildib.ae" is covered by "dib.ae",
// and only one of those disagreements is visible in a test.
func (s *Store) ForSenderDomain(ctx context.Context, domain string) ([]Definition, error) {
	all, err := s.Published(ctx)
	if err != nil {
		return nil, err
	}
	var out []Definition
	for _, d := range all {
		if MatchesSenderDomain(d, domain) {
			out = append(out, d)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// SetStatus
// ---------------------------------------------------------------------------

// SetStatus moves one stored version between lifecycle states.
//
// Promoting to published is a CUTOVER, not a second live row: the currently
// live version is retired in the same transaction, and the definition is
// re-validated first. Without that re-validation, SetStatus would be a back
// door around the publish gate for any row that reached the table by another
// route.
func (s *Store) SetStatus(ctx context.Context, id string, version int, status string) error {
	if err := s.check(); err != nil {
		return err
	}
	if !containsString(Statuses(), status) {
		return fmt.Errorf("%w: %q is not one of %s", ErrBadStatus, status, strings.Join(Statuses(), ", "))
	}

	tx, err := s.begin(ctx)
	if err != nil {
		return err
	}
	defer s.rollback(ctx, tx)

	var (
		raw         []byte
		current     string
		publishedAt *time.Time
	)
	err = tx.QueryRow(ctx,
		`SELECT definition, status, published_at FROM templates WHERE id = $1 AND version = $2 FOR UPDATE`,
		id, version).Scan(&raw, &current, &publishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: %s version %d", ErrNotFound, id, version)
	}
	if err != nil {
		return fmt.Errorf("tmpl: read %s version %d: %w", id, version, err)
	}
	if current == status {
		return nil
	}

	now := s.now()
	switch status {
	case StatusPublished:
		d, err := ParseDefinition(raw)
		if err != nil {
			return fmt.Errorf("tmpl: stored template %s version %d is unreadable: %w", id, version, err)
		}
		if err := ValidateForPublish(d); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE templates SET status = $3 WHERE id = $1 AND status = $2 AND version <> $4`,
			id, StatusPublished, StatusRetired, version); err != nil {
			return fmt.Errorf("tmpl: retire the live version of %s: %w", id, err)
		}
		// published_at records the FIRST time this version went live and is not
		// reset by a re-promotion: it is the answer to "when could this parser
		// have produced a transaction", which a later promotion does not change.
		if _, err := tx.Exec(ctx,
			`UPDATE templates SET status = $3, published_at = COALESCE(published_at, $4)
			  WHERE id = $1 AND version = $2`, id, version, StatusPublished, now); err != nil {
			if constraintOf(err) == "templates_one_published" {
				return fmt.Errorf("%w: %s", ErrPublishConflict, id)
			}
			return fmt.Errorf("tmpl: publish %s version %d: %w", id, version, err)
		}
	default:
		// A draft is a version that never ran. Once a version has been
		// published, transactions may name it, so calling it a draft again
		// would be a lie the templates_draft_was_never_published CHECK would
		// reject anyway — refused here with a reason instead of there with a
		// constraint name.
		if status == StatusDraft && publishedAt != nil {
			return fmt.Errorf("tmpl: %s version %d has been published and cannot become a draft: "+
				"a draft is a version that never ran, and transactions may name this one", id, version)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE templates SET status = $3 WHERE id = $1 AND version = $2`, id, version, status); err != nil {
			return fmt.Errorf("tmpl: set status of %s version %d: %w", id, version, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		if constraintOf(err) == "templates_one_published" {
			return fmt.Errorf("%w: %s", ErrPublishConflict, id)
		}
		return fmt.Errorf("tmpl: set status of %s version %d: commit: %w", id, version, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

// constraintOf returns the name of the constraint or index a Postgres error
// names, or "". Matching on the NAME rather than the SQLSTATE is what lets
// Publish tell "this version already exists" (the caller's mistake) from
// "another version went live underneath us" (retryable), which are both 23505.
func constraintOf(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.ConstraintName
	}
	return ""
}

// begin pins READ COMMITTED rather than inheriting it, for the same reason
// auth.Writers and addresses do: default_transaction_isolation is settable per
// database, per role and by a pooler, and under REPEATABLE READ the row lock
// that serializes two concurrent cutovers would raise a serialization failure
// instead of blocking.
func (s *Store) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("tmpl: begin: %w", err)
	}
	return tx, nil
}

// rollback runs on a context detached from the caller's, so a cancelled request
// still releases its locks cleanly instead of leaving pgx to destroy the
// connection.
func (s *Store) rollback(ctx context.Context, tx pgx.Tx) {
	rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(rbCtx)
}
