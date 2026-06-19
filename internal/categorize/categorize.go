package categorize

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Category is a spending/income/excluded category.
type Category struct {
	ID     int64
	Name   string
	Kind   string // "spending" | "income" | "excluded"
	Bucket string // "need" | "want" | "saving"
}

// Rule is one merchant-match rule, ordered by Priority (lower = higher priority).
type Rule struct {
	MatchType  string // "contains" | "exact" | "regex"
	Pattern    string
	CategoryID int64
	Priority   int
}

// Result is what Categorize returns.
type Result struct {
	CategoryID     int64
	CategoryName   string
	Confidence     float64
	Source         string // "rule" | "ai"
	AboveThreshold bool   // true when source="rule" OR when AI confidence >= threshold
	ProposedRule   *Rule  // non-nil when AI fires above threshold (to write back to rules table)
}

// AICategorizer is the AI fallback interface.
type AICategorizer interface {
	Categorize(ctx context.Context, merchant string, cats []Category) (name string, conf float64, err error)
}

// ErrAIUnavailable is returned by DisabledAI.
var ErrAIUnavailable = errors.New("ai categorizer unavailable")

// DisabledAI always returns ErrAIUnavailable.
type DisabledAI struct{}

func (DisabledAI) Categorize(_ context.Context, _ string, _ []Category) (string, float64, error) {
	return "", 0, ErrAIUnavailable
}

// Categorizer applies rules first, then falls back to AI.
type Categorizer struct {
	rules      []Rule
	cats       []Category
	catsByID   map[int64]Category
	catsByName map[string]Category // keyed by strings.ToLower(name)
	ai         AICategorizer
	threshold  float64
	autoRule   bool // when true, AI-proposed rules are written back automatically (used by Processor in M4)
	compiled   map[string]*regexp.Regexp // keyed by Rule.Pattern for regex rules
}

// New creates a Categorizer. rules must already be sorted by Priority ascending.
func New(rules []Rule, cats []Category, ai AICategorizer, threshold float64, autoRule bool) *Categorizer {
	catsByName := make(map[string]Category, len(cats))
	catsByID := make(map[int64]Category, len(cats))
	for _, cat := range cats {
		catsByName[strings.ToLower(cat.Name)] = cat
		catsByID[cat.ID] = cat
	}

	compiled := make(map[string]*regexp.Regexp)
	for _, r := range rules {
		if r.MatchType == "regex" {
			if _, already := compiled[r.Pattern]; already {
				continue
			}
			re, err := regexp.Compile("(?i)" + r.Pattern)
			if err != nil {
				// skip silently on compile failure
				continue
			}
			compiled[r.Pattern] = re
		}
	}

	return &Categorizer{
		rules:      rules,
		cats:       cats,
		catsByID:   catsByID,
		catsByName: catsByName,
		ai:         ai,
		threshold:  threshold,
		autoRule:   autoRule,
		compiled:   compiled,
	}
}

// matchRule checks whether rule r matches lowerMerchant.
func (c *Categorizer) matchRule(r Rule, lowerMerchant string) bool {
	switch r.MatchType {
	case "exact":
		return lowerMerchant == strings.ToLower(r.Pattern)
	case "contains":
		return strings.Contains(lowerMerchant, strings.ToLower(r.Pattern))
	case "regex":
		re, ok := c.compiled[r.Pattern]
		if !ok {
			return false
		}
		return re.MatchString(lowerMerchant)
	default:
		return false
	}
}

// Categorize classifies merchantRaw using rules first, then AI fallback.
// Returns (Result, true) on success, (Result{}, false) when no classification is possible.
// Categorize resolves a merchant to a category. It returns a nil error when a
// rule or the AI confidently resolved the merchant. A non-nil error means the
// merchant was left unresolved; callers should leave the transaction in review.
// The sentinel ErrAIUnavailable (returned when AI is disabled and no rule
// matched) signals a *benign* miss rather than a failure, so callers surfacing
// errors to the user can filter it out via errors.Is.
func (c *Categorizer) Categorize(ctx context.Context, merchantRaw string) (Result, error) {
	lowerMerchant := strings.ToLower(merchantRaw)

	// Walk rules in priority order (already sorted ascending by Priority).
	for _, r := range c.rules {
		if !c.matchRule(r, lowerMerchant) {
			continue
		}
		cat, ok := c.catsByID[r.CategoryID]
		if !ok {
			// Rule references unknown category — skip.
			continue
		}
		return Result{
			CategoryID:     cat.ID,
			CategoryName:   cat.Name,
			Confidence:     1.0,
			Source:         "rule",
			AboveThreshold: true,
		}, nil
	}

	// No rule matched — try AI.
	name, conf, err := c.ai.Categorize(ctx, merchantRaw, c.cats)
	if err != nil {
		return Result{}, err
	}
	cat, ok := c.catsByName[strings.ToLower(name)]
	if !ok {
		return Result{}, fmt.Errorf("ai returned unknown category %q for %q", name, merchantRaw)
	}

	res := Result{
		CategoryID:   cat.ID,
		CategoryName: cat.Name,
		Confidence:   conf,
		Source:       "ai",
	}
	if conf >= c.threshold {
		res.AboveThreshold = true
		if c.autoRule {
			res.ProposedRule = &Rule{
				MatchType:  "contains",
				Pattern:    strings.ToLower(merchantRaw),
				CategoryID: cat.ID,
				Priority:   100,
			}
		}
	}
	return res, nil
}
