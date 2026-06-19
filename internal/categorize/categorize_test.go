package categorize

import (
	"context"
	"errors"
	"testing"
)

// fixedAI is a test helper that always returns the same name and confidence.
type fixedAI struct {
	name string
	conf float64
}

func (f fixedAI) Categorize(_ context.Context, _ string, _ []Category) (string, float64, error) {
	return f.name, f.conf, nil
}

// errAI always fails, simulating an AI provider outage / rate-limit exhaustion.
type errAI struct{ err error }

func (e errAI) Categorize(_ context.Context, _ string, _ []Category) (string, float64, error) {
	return "", 0, e.err
}

var testCats = []Category{
	{ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want"},
	{ID: 2, Name: "Software", Kind: "spending", Bucket: "need"},
	{ID: 3, Name: "Food", Kind: "spending", Bucket: "need"},
}

func TestRuleMatchExact(t *testing.T) {
	rules := []Rule{
		{MatchType: "exact", Pattern: "AMAZON.AE", CategoryID: 1, Priority: 10},
	}
	c := New(rules, testCats, DisabledAI{}, 0.85, false)
	res, err := c.Categorize(context.Background(), "AMAZON.AE")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if res.CategoryID != 1 {
		t.Errorf("expected CategoryID=1, got %d", res.CategoryID)
	}
	if res.Source != "rule" {
		t.Errorf("expected Source=rule, got %q", res.Source)
	}
	if res.Confidence != 1.0 {
		t.Errorf("expected Confidence=1.0, got %f", res.Confidence)
	}
	if !res.AboveThreshold {
		t.Error("expected AboveThreshold=true for rule match")
	}
}

func TestRuleMatchContainsCaseInsensitive(t *testing.T) {
	rules := []Rule{
		{MatchType: "contains", Pattern: "amazon", CategoryID: 1, Priority: 10},
	}
	c := New(rules, testCats, DisabledAI{}, 0.85, false)
	res, err := c.Categorize(context.Background(), "AMAZON.AE")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if res.CategoryID != 1 {
		t.Errorf("expected CategoryID=1, got %d", res.CategoryID)
	}
	if res.Source != "rule" {
		t.Errorf("expected Source=rule, got %q", res.Source)
	}
}

func TestRuleMatchRegex(t *testing.T) {
	rules := []Rule{
		{MatchType: "regex", Pattern: `^FIGMA`, CategoryID: 2, Priority: 10},
	}
	c := New(rules, testCats, DisabledAI{}, 0.85, false)

	// Should match
	res, err := c.Categorize(context.Background(), "FIGMA")
	if err != nil {
		t.Fatalf("expected nil error for 'FIGMA', got %v", err)
	}
	if res.CategoryID != 2 {
		t.Errorf("expected CategoryID=2, got %d", res.CategoryID)
	}

	// Should not match — AI disabled, so a benign ErrAIUnavailable miss.
	_, err = c.Categorize(context.Background(), "NOT FIGMA")
	if !errors.Is(err, ErrAIUnavailable) {
		t.Errorf("expected ErrAIUnavailable for 'NOT FIGMA', got %v", err)
	}
}

func TestRulePriorityOrder(t *testing.T) {
	// Lower priority number wins — priority=10 should beat priority=100
	// Both match "AMAZON" but point to different categories.
	rules := []Rule{
		{MatchType: "contains", Pattern: "amazon", CategoryID: 1, Priority: 10},
		{MatchType: "contains", Pattern: "amazon", CategoryID: 2, Priority: 100},
	}
	c := New(rules, testCats, DisabledAI{}, 0.85, false)
	res, err := c.Categorize(context.Background(), "AMAZON.AE")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if res.CategoryID != 1 {
		t.Errorf("expected CategoryID=1 (priority=10 wins), got %d", res.CategoryID)
	}
}

func TestNoRuleNoAI(t *testing.T) {
	c := New(nil, testCats, DisabledAI{}, 0.85, false)
	_, err := c.Categorize(context.Background(), "SOME MERCHANT")
	if !errors.Is(err, ErrAIUnavailable) {
		t.Errorf("expected ErrAIUnavailable when no rules and AI disabled, got %v", err)
	}
}

// A real AI failure (not the disabled sentinel) must propagate so callers can
// surface it. This is the regression guard for swallowed errors during a
// manual categorization run.
func TestAIErrorPropagates(t *testing.T) {
	boom := errors.New("anthropic API status 429")
	c := New(nil, testCats, errAI{err: boom}, 0.85, true)
	_, err := c.Categorize(context.Background(), "some merchant")
	if err == nil {
		t.Fatal("expected the AI error to propagate, got nil")
	}
	if errors.Is(err, ErrAIUnavailable) {
		t.Errorf("a real AI failure must not look like the benign ErrAIUnavailable sentinel: %v", err)
	}
	if !errors.Is(err, boom) {
		t.Errorf("expected wrapped boom error, got %v", err)
	}
}

// When the AI returns a category name we don't know, that's a failure (not a
// silent drop) so it can be reported.
func TestAIUnknownCategoryIsError(t *testing.T) {
	ai := fixedAI{name: "Teleportation", conf: 0.99}
	c := New(nil, testCats, ai, 0.85, true)
	_, err := c.Categorize(context.Background(), "some merchant")
	if err == nil {
		t.Fatal("expected an error for an unknown category name, got nil")
	}
	if errors.Is(err, ErrAIUnavailable) {
		t.Errorf("unknown-category must not look like ErrAIUnavailable: %v", err)
	}
}

func TestAIFallbackAboveThreshold(t *testing.T) {
	ai := fixedAI{name: "Shopping", conf: 0.92}
	c := New(nil, testCats, ai, 0.85, true)
	res, err := c.Categorize(context.Background(), "some merchant")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if res.Source != "ai" {
		t.Errorf("expected Source=ai, got %q", res.Source)
	}
	if res.Confidence != 0.92 {
		t.Errorf("expected Confidence=0.92, got %f", res.Confidence)
	}
	if !res.AboveThreshold {
		t.Error("expected AboveThreshold=true (0.92 >= 0.85)")
	}
	if res.ProposedRule == nil {
		t.Fatal("expected ProposedRule != nil when above threshold")
	}
	if res.ProposedRule.MatchType != "contains" {
		t.Errorf("expected ProposedRule.MatchType=contains, got %q", res.ProposedRule.MatchType)
	}
	if res.ProposedRule.CategoryID != 1 {
		t.Errorf("expected ProposedRule.CategoryID=1, got %d", res.ProposedRule.CategoryID)
	}
}

func TestAIFallbackBelowThreshold(t *testing.T) {
	ai := fixedAI{name: "Shopping", conf: 0.50}
	c := New(nil, testCats, ai, 0.85, true)
	res, err := c.Categorize(context.Background(), "some merchant")
	if err != nil {
		t.Fatalf("expected nil error when AI returns a known category, got %v", err)
	}
	if res.Source != "ai" {
		t.Errorf("expected Source=ai, got %q", res.Source)
	}
	if res.AboveThreshold {
		t.Error("expected AboveThreshold=false (0.50 < 0.85)")
	}
	if res.ProposedRule != nil {
		t.Error("expected ProposedRule=nil when below threshold")
	}
}
