package seed

import (
	"context"
	"os"
	"testing"

	"ledger/internal/v2/pgtest"
	"ledger/internal/v2/tmpl"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var ctx = context.Background()

// TestAFreshStoreHoldsNoTemplateUntilTheSeedIsApplied is the defect this file
// closes, stated as a test: for the whole of Phase 1 nothing called Apply's
// predecessor, so this was the PERMANENT state of a deployment.
func TestAFreshStoreHoldsNoTemplateUntilTheSeedIsApplied(t *testing.T) {
	s := &tmpl.Store{Pool: pgtest.New(t)}

	live, err := s.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 0 {
		t.Fatalf("a freshly migrated database already holds %d published templates", len(live))
	}
	for _, domain := range []string{"dib.ae", "emiratesnbd.com"} {
		defs, err := s.ForSenderDomain(ctx, domain)
		if err != nil {
			t.Fatal(err)
		}
		if len(defs) != 0 {
			t.Fatalf("%s: %d templates before seeding", domain, len(defs))
		}
	}

	rs, err := Apply(ctx, s)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := Published(rs); got != len(IDs) {
		t.Fatalf("published %d of %d seeds: %+v", got, len(IDs), rs)
	}
	live, err = s.Published(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != len(IDs) {
		t.Fatalf("after seeding, %d templates are live, want %d", len(live), len(IDs))
	}
}

// TestApplyIsIdempotent is the property a deploy step must have: running it on
// every start, or twice by hand, writes nothing the second time. Publish
// refuses a republish outright (ErrVersionExists), so a non-idempotent Apply
// would fail a boot rather than corrupt anything — which is still a server that
// will not start.
func TestApplyIsIdempotent(t *testing.T) {
	s := &tmpl.Store{Pool: pgtest.New(t)}
	if _, err := Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	before, err := s.All(ctx)
	if err != nil {
		t.Fatal(err)
	}

	rs, err := Apply(ctx, s)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if got := Published(rs); got != 0 {
		t.Fatalf("the second apply published %d templates: %+v", got, rs)
	}
	after, err := s.All(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("the second apply changed the row count: %d -> %d", len(before), len(after))
	}
	for i := range after {
		if after[i].ID != before[i].ID || after[i].Version != before[i].Version ||
			after[i].Status != before[i].Status || !after[i].CreatedAt.Equal(before[i].CreatedAt) {
			t.Fatalf("row %d changed: %+v -> %+v", i, before[i], after[i])
		}
	}
}

// TestApplyNeverRetiresANewerOperatorFix is the reason Apply compares versions
// instead of checking for absence. The operator fixes an anchor the bank
// changed by publishing v2 from the admin console; a seed that republished its
// own v1 would retire that fix on the next restart, silently, and every message
// from that bank would stop parsing again.
func TestApplyNeverRetiresANewerOperatorFix(t *testing.T) {
	s := &tmpl.Store{Pool: pgtest.New(t)}
	if _, err := Apply(ctx, s); err != nil {
		t.Fatal(err)
	}

	// The operator's fix: the same template, one version later.
	defs := Seed()
	fix := defs[0]
	fix.Version = defs[0].Version + 1
	if err := s.Publish(ctx, fix); err != nil {
		t.Fatalf("publish the operator's fix: %v", err)
	}

	rs, err := Apply(ctx, s)
	if err != nil {
		t.Fatalf("apply after the fix: %v", err)
	}
	for _, r := range rs {
		if r.Action != ActionKept {
			t.Fatalf("apply wrote %s version %d after the operator's fix", r.ID, r.Version)
		}
	}
	live, err := s.Live(ctx, fix.ID)
	if err != nil {
		t.Fatal(err)
	}
	if live.Version != fix.Version {
		t.Fatalf("the live version of %s is %d, want the operator's %d — the seed walked backwards",
			fix.ID, live.Version, fix.Version)
	}
}

// TestApplyPublishesASeedVersionBumpedByABuild is the other half of the same
// rule: re-running after a build that bumped a seed IS how the fix reaches
// devices, so the comparison must let a newer seed through.
func TestApplyPublishesASeedVersionBumpedByABuild(t *testing.T) {
	s := &tmpl.Store{Pool: pgtest.New(t)}

	// A store already holding an older version of one seed, as if the previous
	// build's seed had been applied.
	old := Seed()[0]
	if old.Version != 1 {
		t.Skipf("this test assumes the seed set starts at version 1; %s is v%d", old.ID, old.Version)
	}
	rs, err := Apply(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if got := Published(rs); got != len(IDs) {
		t.Fatalf("published %d of %d", got, len(IDs))
	}

	// Now simulate the next build: one seed at a higher version.
	next := old
	next.Version = old.Version + 1
	highest, err := s.HighestVersions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if have := highest[next.ID]; have >= next.Version {
		t.Fatalf("stored version %d already covers the bumped seed %d", have, next.Version)
	}
	if err := s.Publish(ctx, next); err != nil {
		t.Fatalf("a bumped seed must publish: %v", err)
	}
	live, err := s.Live(ctx, next.ID)
	if err != nil {
		t.Fatal(err)
	}
	if live.Version != next.Version {
		t.Fatalf("live version = %d, want %d", live.Version, next.Version)
	}
}

// TestApplyRefusesANilStore keeps the deploy path's one nil dependency loud.
func TestApplyRefusesANilStore(t *testing.T) {
	if _, err := Apply(ctx, nil); err == nil {
		t.Fatal("Apply(nil) returned no error")
	}
}
