package tmpl

// console.go is the ADMIN read/author path over the same table store.go owns:
// every version in every status, one version by key, and the draft-authoring
// write.
//
// It is separate from store.go because the two have different audiences and
// different guarantees. store.go serves the INGEST pipeline, which asks exactly
// one question ("what is live?") and must never see a draft; this file serves
// one operator on a tailnet-bound socket, whose question is the opposite one
// ("what is there, including what I retired last week?").
//
// # Authoring runs the publish gate, deliberately
//
// [Store.SaveDraft] calls [ValidateForPublish], not a weaker "draft" check.
// Spec §3.5 only requires the dialect gate at publish time, so this is stricter
// than the spec — on purpose. The alternative is a table that can hold a
// definition with an invalid pattern, at which point [Store.SetStatus] is the
// only thing between that row and every device in the beta, and "the draft
// validator is weaker than the publish validator" becomes a fact somebody has
// to remember. A draft that cannot be published is not a useful draft.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Record is one stored template row: the columns an operator reads plus the
// definition itself.
//
// PublishedAt is a pointer because "never published" and "published at the zero
// time" are different facts and the table distinguishes them with NULL.
type Record struct {
	ID                string
	Version           int
	Bank              string
	NormalizerVersion int
	Status            string
	CreatedAt         time.Time
	PublishedAt       *time.Time
	Definition        Definition
}

const recordColumns = `id, version, bank, normalizer_version, status, created_at, published_at, definition`

// All returns every stored version of every template, newest version first
// within each id.
//
// Unbounded, and that is a considered choice rather than an oversight: rows are
// only ever created by an operator authoring a template by hand, so the table's
// size is the number of parser revisions this system has ever had — tens, over
// the life of the project. A pagination cursor here would be machinery for a
// growth curve that does not exist. If it ever does, the fix is a cursor on
// (id, version), which is already the primary key.
func (s *Store) All(ctx context.Context) ([]Record, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+recordColumns+` FROM templates ORDER BY id, version DESC`)
	if err != nil {
		return nil, fmt.Errorf("tmpl: read all templates: %w", err)
	}
	defer rows.Close()

	var out []Record
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("tmpl: read all templates: %w", err)
	}
	return out, nil
}

// Get returns one stored version, or [ErrNotFound].
func (s *Store) Get(ctx context.Context, id string, version int) (Record, error) {
	if err := s.check(); err != nil {
		return Record{}, err
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+recordColumns+` FROM templates WHERE id = $1 AND version = $2`, id, version)
	if err != nil {
		return Record{}, fmt.Errorf("tmpl: read %s version %d: %w", id, version, err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return Record{}, fmt.Errorf("tmpl: read %s version %d: %w", id, version, err)
		}
		return Record{}, fmt.Errorf("%w: %s version %d", ErrNotFound, id, version)
	}
	return scanRecord(rows)
}

const insertDraftSQL = `
INSERT INTO templates (id, version, bank, normalizer_version, definition, status, created_at, published_at)
VALUES ($1, $2, $3, $4, $5::jsonb, 'draft', $6, NULL)`

// SaveDraft stores d as a new DRAFT version. It publishes nothing.
//
// The version is immutable in exactly the same way a published one is: an
// existing (id, version) is [ErrVersionExists], never an update. A draft is
// what a validation run and a publish decision are made ABOUT, so a draft that
// could change underneath either of them would make both meaningless — the
// operator would have validated one definition and published another under the
// same name.
func (s *Store) SaveDraft(ctx context.Context, d Definition) error {
	if err := s.check(); err != nil {
		return err
	}
	if err := ValidateForPublish(d); err != nil {
		return err
	}
	canonical, err := d.Canonical()
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidDefinition, err)
	}
	if _, err := s.Pool.Exec(ctx, insertDraftSQL,
		d.ID, d.Version, d.Bank, d.NormalizerVersion, string(canonical), s.now()); err != nil {
		if constraintOf(err) == "templates_pkey" {
			return fmt.Errorf("%w: %s version %d", ErrVersionExists, d.ID, d.Version)
		}
		return fmt.Errorf("tmpl: save draft %s version %d: %w", d.ID, d.Version, err)
	}
	return nil
}

// scanRecord reads one row. A stored definition this build cannot parse is an
// ERROR rather than a skipped or half-filled row, for the same reason
// [Store.Published] treats it as one: the row is the only description of a
// parser that may have produced live transactions, and a console that silently
// showed it as blank would be describing something that does not exist.
func scanRecord(rows pgx.Rows) (Record, error) {
	var (
		r   Record
		raw []byte
	)
	if err := rows.Scan(&r.ID, &r.Version, &r.Bank, &r.NormalizerVersion,
		&r.Status, &r.CreatedAt, &r.PublishedAt, &raw); err != nil {
		return Record{}, fmt.Errorf("tmpl: read template row: %w", err)
	}
	d, err := ParseDefinition(raw)
	if err != nil {
		return Record{}, fmt.Errorf("tmpl: stored template %s version %d is unreadable: %w", r.ID, r.Version, err)
	}
	r.Definition = d
	return r, nil
}

// ErrNoLiveVersion means a template id has no published version. It is not an
// error condition for a first publish; it is what [Store.Live] reports so a
// caller can tell "nothing to regress against" from "the read failed".
var ErrNoLiveVersion = errors.New("tmpl: this template has no published version")

// Live returns the published version of id, or [ErrNoLiveVersion].
//
// The admin publish gate needs this specifically — the baseline a candidate is
// compared against — and [Store.Published] cannot answer it without the caller
// filtering a slice, which is a filter that would exist in two places.
func (s *Store) Live(ctx context.Context, id string) (Record, error) {
	if err := s.check(); err != nil {
		return Record{}, err
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+recordColumns+` FROM templates WHERE id = $1 AND status = $2`, id, StatusPublished)
	if err != nil {
		return Record{}, fmt.Errorf("tmpl: read the live version of %s: %w", id, err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return Record{}, fmt.Errorf("tmpl: read the live version of %s: %w", id, err)
		}
		return Record{}, fmt.Errorf("%w: %s", ErrNoLiveVersion, id)
	}
	return scanRecord(rows)
}
