package tmpl

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

func newStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	pool := pgtest.New(t)
	return &Store{Pool: pool}, pool
}

func publishedCount(t *testing.T, pool *pgxpool.Pool, id string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM templates WHERE id = $1 AND status = 'published'`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func rowCount(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM templates`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// the publish-time gate
// ---------------------------------------------------------------------------

func TestPublishRejectsADefinitionWithAnInvalidPattern(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()

	d := mustLoad(t, "testdata/dib.card.v1.json")
	// \s is banned: Go's is [\t\n\f\r ] and JavaScript's includes U+00A0 and
	// friends, so the two executors would read different text out of the same
	// stored template.
	d.Extract[0].Patterns = []string{`المبلغ\s+(?P<amt>[0-9][0-9,]*\.[0-9]{2})`}

	err := s.Publish(ctx, d)
	if err == nil {
		t.Fatal("Publish accepted a pattern the dialect rejects")
	}
	if !errors.Is(err, ErrInvalidDefinition) {
		t.Fatalf("err = %v, want ErrInvalidDefinition", err)
	}
	if !strings.Contains(err.Error(), ReasonEscapePerlSpace) {
		t.Fatalf("the error must name the dialect reason code: %v", err)
	}
	if n := rowCount(t, pool); n != 0 {
		t.Fatalf("%d rows written by a rejected publish; the gate must write nothing", n)
	}
}

func TestPublishRejectsADefinitionThatDoesNotValidate(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()

	d := mustLoad(t, "testdata/dib.card.v1.json")
	d.Required = []string{"amount"} // direction is mandatory
	if err := s.Publish(ctx, d); !errors.Is(err, ErrInvalidDefinition) {
		t.Fatalf("err = %v, want ErrInvalidDefinition", err)
	}

	d2 := mustLoad(t, "testdata/dib.card.v1.json")
	d2.Match.SenderDomain = nil // matching on content alone is refused
	if err := s.Publish(ctx, d2); !errors.Is(err, ErrInvalidDefinition) {
		t.Fatalf("err = %v, want ErrInvalidDefinition", err)
	}
	if n := rowCount(t, pool); n != 0 {
		t.Fatalf("%d rows written by a rejected publish", n)
	}
}

func TestPublishRejectsReusingAVersionNumber(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()
	d := mustLoad(t, "testdata/dib.card.v1.json")

	if err := s.Publish(ctx, d); err != nil {
		t.Fatal(err)
	}
	// Byte-identical republish.
	if err := s.Publish(ctx, d); !errors.Is(err, ErrVersionExists) {
		t.Fatalf("err = %v, want ErrVersionExists", err)
	}
	// A DIFFERENT definition at the same version is the dangerous one: it would
	// silently change what a stored (template_id, template_version) means.
	changed := d
	changed.Bank = "other"
	if err := s.Publish(ctx, changed); !errors.Is(err, ErrVersionExists) {
		t.Fatalf("err = %v, want ErrVersionExists", err)
	}
	if n := rowCount(t, pool); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
	var bank string
	if err := pool.QueryRow(ctx, `SELECT bank FROM templates WHERE id=$1 AND version=1`, d.ID).Scan(&bank); err != nil {
		t.Fatal(err)
	}
	if bank != d.Bank {
		t.Fatalf("the stored row was overwritten: bank = %q", bank)
	}
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

func TestOnlyOneTemplateVersionCanBePublished(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()

	v1 := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, v1); err != nil {
		t.Fatal(err)
	}
	v2 := v1
	v2.Version = 2
	if err := s.Publish(ctx, v2); err != nil {
		t.Fatal(err)
	}

	if n := publishedCount(t, pool, v1.ID); n != 1 {
		t.Fatalf("%d published rows for %s, want exactly 1", n, v1.ID)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM templates WHERE id=$1 AND version=1`, v1.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusRetired {
		t.Fatalf("v1 status = %q, want %q", status, StatusRetired)
	}
	// The superseded definition is RETAINED: a stored transaction names the
	// template version that produced it, and re-verifying that match needs the
	// definition to still exist.
	if n := rowCount(t, pool); n != 2 {
		t.Fatalf("rows = %d, want 2", n)
	}

	got, err := s.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != 2 {
		t.Fatalf("Published() = %+v, want only version 2", got)
	}

	// The index, not just the code path: a hand-written INSERT cannot make a
	// second version live either.
	_, err = pool.Exec(ctx,
		`INSERT INTO templates (id, version, bank, normalizer_version, definition, status, created_at, published_at)
		 SELECT id, 3, bank, normalizer_version,
		        jsonb_set(definition, '{version}', '3'), 'published', now(), now()
		   FROM templates WHERE id=$1 AND version=2`, v1.ID)
	if err == nil {
		t.Fatal("the partial unique index did not stop a second published row")
	}
}

func TestPublicationSinceIsAnHonestGlobalDelta(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()
	card := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, card); err != nil {
		t.Fatal(err)
	}

	initial, err := s.PublicationSince(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(initial.Templates) != 1 || initial.Templates[0].Version != 1 || len(initial.Removed) != 0 {
		t.Fatalf("initial delta = %+v", initial)
	}

	// A draft is deliberately absent from both a full snapshot and later deltas.
	draft := mustLoad(t, "testdata/enbd.alert.v1.json")
	raw, err := draft.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO templates (id,version,bank,normalizer_version,definition,status,created_at) VALUES ($1,$2,$3,$4,$5,'draft',now())`, draft.ID, draft.Version, draft.Bank, draft.NormalizerVersion, raw); err != nil {
		t.Fatal(err)
	}

	v2 := card
	v2.Version = 2
	if err := s.Publish(ctx, v2); err != nil {
		t.Fatal(err)
	}
	updated, err := s.PublicationSince(ctx, initial.Version)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Templates) != 1 || updated.Templates[0].Version != 2 || len(updated.Removed) != 0 {
		t.Fatalf("update delta = %+v", updated)
	}

	if err := s.SetStatus(ctx, card.ID, 2, StatusRetired); err != nil {
		t.Fatal(err)
	}
	removed, err := s.PublicationSince(ctx, updated.Version)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed.Templates) != 0 || len(removed.Removed) != 1 || removed.Removed[0] != card.ID {
		t.Fatalf("removal delta = %+v", removed)
	}
	final, err := s.PublicationSince(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(final.Templates) != 0 {
		t.Fatalf("snapshot leaked draft or retired templates: %+v", final.Templates)
	}
}

func TestPublicationSinceRejectsAFutureCursor(t *testing.T) {
	s, _ := newStore(t)
	if _, err := s.PublicationSince(context.Background(), 1); !errors.Is(err, ErrPublicationCursor) {
		t.Fatalf("future cursor error = %v, want ErrPublicationCursor", err)
	}
}

func TestPublishedRoundTripsTheDefinitionByteForByte(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	for _, f := range []string{"dib.card.v1", "dib.account.v1", "enbd.alert.v1"} {
		d := mustLoad(t, "testdata/"+f+".json")
		if err := s.Publish(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d published templates, want 3", len(got))
	}
	for _, g := range got {
		want := mustLoad(t, "testdata/"+g.ID+".json")
		wb, err := want.Canonical()
		if err != nil {
			t.Fatal(err)
		}
		gb, err := g.Canonical()
		if err != nil {
			t.Fatal(err)
		}
		if string(wb) != string(gb) {
			t.Fatalf("%s round trip differs:\n stored %s\n loaded %s", g.ID, wb, gb)
		}
		// A round trip that loses the Arabic anchors would still hash the same
		// if Canonical were the thing at fault, so execute the loaded copy too.
		if g.ID == "dib.card.v1" {
			e, err := Execute(g, "", dibCardBody)
			if err != nil || e.Merchant != "CARREFOUR DUBAI" {
				t.Fatalf("the loaded definition does not execute: %+v %v", e, err)
			}
		}
	}
}

func TestForSenderDomainFiltersOnLabelBoundaries(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	for _, f := range []string{"dib.card.v1", "dib.account.v1", "enbd.alert.v1"} {
		if err := s.Publish(ctx, mustLoad(t, "testdata/"+f+".json")); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		domain string
		want   int
	}{
		{"dib.ae", 2},
		{"notifications.dib.ae", 2},
		{"emiratesnbd.com", 1},
		{"evildib.ae", 0},
		{"dib.ae.attacker.example", 0},
		{"", 0},
	} {
		got, err := s.ForSenderDomain(ctx, tc.domain)
		if err != nil {
			t.Fatalf("%q: %v", tc.domain, err)
		}
		if len(got) != tc.want {
			t.Errorf("ForSenderDomain(%q) returned %d templates, want %d", tc.domain, len(got), tc.want)
		}
	}
}

func TestSetStatus(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()
	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, d); err != nil {
		t.Fatal(err)
	}

	if err := s.SetStatus(ctx, d.ID, 1, "nonsense"); err == nil {
		t.Fatal("SetStatus accepted a status outside the closed set")
	}
	if err := s.SetStatus(ctx, "no.such.template", 1, StatusTesting); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if err := s.SetStatus(ctx, d.ID, 1, StatusTesting); err != nil {
		t.Fatal(err)
	}
	if n := publishedCount(t, pool, d.ID); n != 0 {
		t.Fatalf("published rows = %d after demotion, want 0", n)
	}
	// Promoting back is a cutover, not a second live row.
	v2 := d
	v2.Version = 2
	if err := s.Publish(ctx, v2); err != nil {
		t.Fatal(err)
	}
	if err := s.SetStatus(ctx, d.ID, 1, StatusPublished); err != nil {
		t.Fatal(err)
	}
	if n := publishedCount(t, pool, d.ID); n != 1 {
		t.Fatalf("published rows = %d, want 1", n)
	}
	got, err := s.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != 1 {
		t.Fatalf("Published() = %+v, want version 1", got)
	}
}

// ---------------------------------------------------------------------------
// the database as the backstop
// ---------------------------------------------------------------------------

func TestTheDatabaseRefusesARowWhoseColumnsDisagreeWithItsDefinition(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()
	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, d); err != nil {
		t.Fatal(err)
	}
	// ForSenderDomain and Published read the DEFINITION; every other consumer
	// (the admin console, an operator query, diagnostics) reads the COLUMNS. A
	// row where those two disagree is a template that is one thing to the
	// executor and another to everyone looking at it.
	for _, q := range []string{
		`UPDATE templates SET bank = 'not-dib' WHERE id = $1`,
		`UPDATE templates SET normalizer_version = 99 WHERE id = $1`,
		`UPDATE templates SET definition = jsonb_set(definition, '{id}', '"other"') WHERE id = $1`,
		`UPDATE templates SET definition = jsonb_set(definition, '{version}', '7') WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, q, d.ID); err == nil {
			t.Errorf("the database accepted %q", q)
		}
	}
}

func TestPublishedRefusesAStoredDefinitionItCannotRead(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()
	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, d); err != nil {
		t.Fatal(err)
	}
	// A key nobody reads is how a template "publishes and silently matches
	// nothing"; the strict reader must refuse it on the way back out too.
	if _, err := pool.Exec(ctx,
		`UPDATE templates SET definition = definition || '{"surprise": true}'::jsonb WHERE id = $1`, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Published(ctx); err == nil {
		t.Fatal("Published() accepted a definition carrying an unknown key")
	}
}

func TestConcurrentPublishLeavesExactlyOnePublishedRow(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()
	base := mustLoad(t, "testdata/dib.card.v1.json")

	// Warm the pool: pgxpool opens connections lazily, so without this the
	// goroutines below spend their race window in connection setup and the
	// contention this test exists to create never happens.
	const n = 8
	var warm sync.WaitGroup
	for i := 0; i < n; i++ {
		warm.Add(1)
		go func() {
			defer warm.Done()
			var one int
			_ = pool.QueryRow(ctx, `SELECT 1`).Scan(&one)
		}()
	}
	warm.Wait()

	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d := base
			d.Version = i + 1
			<-start
			errs[i] = s.Publish(ctx, d)
		}(i)
	}
	close(start)
	wg.Wait()

	ok := 0
	for i, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrPublishConflict):
			// Expected: another version won the cutover.
		default:
			t.Errorf("publish %d: unexpected error %v", i+1, err)
		}
	}
	if ok == 0 {
		t.Fatal("every concurrent publish failed")
	}
	if got := publishedCount(t, pool, base.ID); got != 1 {
		t.Fatalf("%d published rows, want exactly 1", got)
	}
	// A conflict is retryable, not terminal.
	retry := base
	retry.Version = n + 1
	if err := s.Publish(ctx, retry); err != nil {
		t.Fatalf("retry after conflict: %v", err)
	}
	if got := publishedCount(t, pool, base.ID); got != 1 {
		t.Fatalf("%d published rows after retry, want exactly 1", got)
	}
}

func TestStoreRefusesAnEmptyPool(t *testing.T) {
	s := &Store{}
	if err := s.Publish(context.Background(), mustLoad(t, "testdata/dib.card.v1.json")); err == nil {
		t.Fatal("Publish with a nil pool must fail loudly rather than nil-panic")
	}
}
