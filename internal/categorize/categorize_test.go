package categorize

import (
	"context"
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
	res, ok := c.Categorize(context.Background(), "AMAZON.AE")
	if !ok {
		t.Fatal("expected ok=true")
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
	res, ok := c.Categorize(context.Background(), "AMAZON.AE")
	if !ok {
		t.Fatal("expected ok=true")
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
	res, ok := c.Categorize(context.Background(), "FIGMA")
	if !ok {
		t.Fatal("expected ok=true for 'FIGMA'")
	}
	if res.CategoryID != 2 {
		t.Errorf("expected CategoryID=2, got %d", res.CategoryID)
	}

	// Should not match
	_, ok = c.Categorize(context.Background(), "NOT FIGMA")
	if ok {
		t.Error("expected ok=false for 'NOT FIGMA'")
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
	res, ok := c.Categorize(context.Background(), "AMAZON.AE")
	if !ok {
		t.Fatal("expected ok=true")
	}
	if res.CategoryID != 1 {
		t.Errorf("expected CategoryID=1 (priority=10 wins), got %d", res.CategoryID)
	}
}

func TestNoRuleNoAI(t *testing.T) {
	c := New(nil, testCats, DisabledAI{}, 0.85, false)
	_, ok := c.Categorize(context.Background(), "SOME MERCHANT")
	if ok {
		t.Error("expected ok=false when no rules and AI disabled")
	}
}

func TestAIFallbackAboveThreshold(t *testing.T) {
	ai := fixedAI{name: "Shopping", conf: 0.92}
	c := New(nil, testCats, ai, 0.85, true)
	res, ok := c.Categorize(context.Background(), "some merchant")
	if !ok {
		t.Fatal("expected ok=true")
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
	res, ok := c.Categorize(context.Background(), "some merchant")
	if !ok {
		t.Fatal("expected ok=true when AI returns a known category")
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
