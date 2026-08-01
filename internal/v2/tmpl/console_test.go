package tmpl

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The console reads EVERY version in EVERY status. That is the difference
// between it and Published, and it is the whole reason this read path exists:
// the operator's question is "what is there", including the retired version a
// regression might have to be rolled back to.
func TestAllReturnsEveryVersionInEveryStatus(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()

	v1 := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, v1); err != nil {
		t.Fatalf("Publish v1: %v", err)
	}
	v2 := v1
	v2.Version = 2
	if err := s.Publish(ctx, v2); err != nil { // retires v1
		t.Fatalf("Publish v2: %v", err)
	}
	v3 := v1
	v3.Version = 3
	if err := s.SaveDraft(ctx, v3); err != nil {
		t.Fatalf("SaveDraft v3: %v", err)
	}

	all, err := s.All(ctx)
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("All returned %d rows, want 3", len(all))
	}
	// Newest version first within an id: the operator is nearly always looking
	// at the most recent work.
	got := map[int]string{}
	for _, r := range all {
		got[r.Version] = r.Status
		if r.Definition.ID != v1.ID {
			t.Fatalf("row %d carries definition id %q", r.Version, r.Definition.ID)
		}
	}
	want := map[int]string{1: StatusRetired, 2: StatusPublished, 3: StatusDraft}
	for ver, st := range want {
		if got[ver] != st {
			t.Errorf("version %d status = %q, want %q", ver, got[ver], st)
		}
	}
	if all[0].Version != 3 {
		t.Errorf("All is not newest-first: got version %d first", all[0].Version)
	}
	if all[0].PublishedAt != nil {
		t.Errorf("a draft must have no published_at")
	}
	if all[1].PublishedAt == nil {
		t.Errorf("a published row must carry published_at")
	}
}

// A draft is authored through the SAME gate a publish runs. Spec §3.5 puts the
// dialect check at publish time; running it at authoring time as well is
// strictly stronger and means an invalid pattern is never a row at all — so a
// later SetStatus cannot promote something that was never checked.
func TestSaveDraftRunsTheFullPublishGate(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()

	d := mustLoad(t, "testdata/dib.card.v1.json")
	d.Extract[0].Patterns = []string{`المبلغ\s+(?P<amt>[0-9][0-9,]*\.[0-9]{2})`}
	err := s.SaveDraft(ctx, d)
	if !errors.Is(err, ErrInvalidDefinition) {
		t.Fatalf("err = %v, want ErrInvalidDefinition", err)
	}
	if !strings.Contains(err.Error(), ReasonEscapePerlSpace) {
		t.Fatalf("the error must name the dialect reason code: %v", err)
	}
	if n := rowCount(t, pool); n != 0 {
		t.Fatalf("%d rows written by a rejected draft", n)
	}
}

// A draft is NOT live. Publishing is a separate, deliberate act.
func TestSaveDraftPublishesNothing(t *testing.T) {
	s, pool := newStore(t)
	ctx := context.Background()

	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.SaveDraft(ctx, d); err != nil {
		t.Fatalf("SaveDraft: %v", err)
	}
	if n := publishedCount(t, pool, d.ID); n != 0 {
		t.Fatalf("%d published rows after SaveDraft", n)
	}
	live, err := s.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 0 {
		t.Fatalf("Published returned %d rows after a draft was saved", len(live))
	}
}

// Versions are immutable, and a draft is a version. Re-saving is a new version,
// never an edit — otherwise "the definition v3 was validated against" and "the
// definition v3 publishes" become two different objects.
func TestSaveDraftRefusesAnExistingVersion(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()

	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.SaveDraft(ctx, d); err != nil {
		t.Fatalf("SaveDraft: %v", err)
	}
	if err := s.SaveDraft(ctx, d); !errors.Is(err, ErrVersionExists) {
		t.Fatalf("err = %v, want ErrVersionExists", err)
	}
	// And the same version cannot be re-authored over a PUBLISHED row either.
	d2 := mustLoad(t, "testdata/dib.card.v1.json")
	d2.Version = 2
	if err := s.Publish(ctx, d2); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if err := s.SaveDraft(ctx, d2); !errors.Is(err, ErrVersionExists) {
		t.Fatalf("err = %v, want ErrVersionExists", err)
	}
}

func TestGetReturnsTheStoredDefinitionAndStatus(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()

	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.Publish(ctx, d); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	r, err := s.Get(ctx, d.ID, d.Version)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if r.Status != StatusPublished {
		t.Fatalf("status = %q", r.Status)
	}
	if r.Definition.Bank != d.Bank || len(r.Definition.Extract) != len(d.Extract) {
		t.Fatalf("Get returned a different definition")
	}
	if _, err := s.Get(ctx, d.ID, 99); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := s.Get(ctx, "no.such.template", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// Live is the baseline the admin publish gate compares a candidate against, so
// "there is no baseline" has to be distinguishable from "the read failed".
func TestLiveReturnsThePublishedVersionOrANamedSentinel(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()

	if _, err := s.Live(ctx, "dib.card"); !errors.Is(err, ErrNoLiveVersion) {
		t.Fatalf("err = %v, want ErrNoLiveVersion for a template that does not exist", err)
	}

	d := mustLoad(t, "testdata/dib.card.v1.json")
	if err := s.SaveDraft(ctx, d); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Live(ctx, d.ID); !errors.Is(err, ErrNoLiveVersion) {
		t.Fatalf("err = %v, want ErrNoLiveVersion when only a draft exists", err)
	}

	v2 := d
	v2.Version = 2
	if err := s.Publish(ctx, v2); err != nil {
		t.Fatal(err)
	}
	got, err := s.Live(ctx, d.ID)
	if err != nil {
		t.Fatalf("Live: %v", err)
	}
	if got.Version != 2 || got.Status != StatusPublished {
		t.Fatalf("Live returned %+v", got)
	}
}
