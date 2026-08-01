package seed

// apply.go is how the templates in this directory actually reach a database.
//
// It exists because for the whole of Phase 1 they did not. [Seed] was imported
// by nothing outside this package's own tests, and [tmpl.Store.Publish] had no
// production caller at all, so a freshly migrated ledgerd served with an EMPTY
// templates table: `templatesFor` returned nothing for every sender, every
// genuine DIB and ENBD message fell through to the heuristic tier or landed
// `unparsed`, and spec §5's "≥95% of alphas' genuine transaction mail parses"
// was unmeetable on a new install. The corpus parity gate (5,719 template hits,
// 0 mismatches) proved the templates are correct; nothing proved they were
// installed. This is the missing half.
//
// # Why the version comparison, and not "insert if absent"
//
// Templates are versioned and publishing is how a parser fix reaches devices,
// so this has to be re-runnable — an operator who deploys a build with a bumped
// seed must be able to run it again and have the new version go live. But it
// must never walk BACKWARDS: the operator may have authored dib.card v2 in the
// admin console to fix an anchor the bank changed, and a seed that blindly
// published its own v1 would retire that fix and reintroduce the bug, on every
// restart, silently. So the rule is a comparison rather than an existence
// check: publish only when the seed's version is strictly newer than anything
// already stored for that id, in any status.
//
// A deliberately RETIRED seed is respected by the same rule — its row is still
// the highest version for that id, so nothing republishes it.

import (
	"context"
	"errors"
	"fmt"

	"ledger/internal/v2/tmpl"
)

// The two actions [Apply] reports. They are printed by `ledgerd seed-templates`
// and logged by `ledgerd serve`, so they are a small stable vocabulary rather
// than prose.
const (
	// ActionPublished means this seed version is now the live one.
	ActionPublished = "published"
	// ActionKept means the store already held this version or a later one and
	// was left alone.
	ActionKept = "kept"
)

// Applied is what [Apply] did to one template id.
//
// Version is the version now considered current for the id: the seed's version
// for [ActionPublished], the stored one for [ActionKept]. An operator reading
// `kept dib.card.v1 version 2` learns both that nothing was written and why.
type Applied struct {
	ID      string
	Version int
	Action  string
}

// Apply publishes the embedded seed set into s, idempotently.
//
// It is safe to call on every start and safe to call concurrently: a lost race
// with another process publishing the same version surfaces as
// [tmpl.ErrVersionExists] or [tmpl.ErrPublishConflict], which mean "the row you
// wanted is there" and are reported as [ActionKept] rather than failing a boot.
//
// Every other error is returned. A definition that will not publish is not a
// degraded mode to serve in — it is the parser for a bank whose mail would
// otherwise silently stop being read — and the results collected so far are
// returned alongside it so a caller can report what did land.
func Apply(ctx context.Context, s *tmpl.Store) ([]Applied, error) {
	if s == nil {
		return nil, errors.New("seed: nil template store")
	}
	highest, err := s.HighestVersions(ctx)
	if err != nil {
		return nil, fmt.Errorf("seed: read the template store: %w", err)
	}

	out := make([]Applied, 0, len(IDs))
	for _, d := range Seed() {
		if have, ok := highest[d.ID]; ok && have >= d.Version {
			out = append(out, Applied{ID: d.ID, Version: have, Action: ActionKept})
			continue
		}
		switch err := s.Publish(ctx, d); {
		case err == nil:
			out = append(out, Applied{ID: d.ID, Version: d.Version, Action: ActionPublished})
		case errors.Is(err, tmpl.ErrVersionExists), errors.Is(err, tmpl.ErrPublishConflict):
			out = append(out, Applied{ID: d.ID, Version: d.Version, Action: ActionKept})
		default:
			return out, fmt.Errorf("seed: publish %s version %d: %w", d.ID, d.Version, err)
		}
	}
	return out, nil
}

// Published counts the entries of rs that actually wrote a template.
func Published(rs []Applied) int {
	n := 0
	for _, r := range rs {
		if r.Action == ActionPublished {
			n++
		}
	}
	return n
}
