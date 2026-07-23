package categorize

import (
	"context"
	"strings"
)

// SuggestionStore persists AI category suggestions keyed by normalized merchant.
// *store.Store satisfies it.
type SuggestionStore interface {
	GetAISuggestion(merchantNorm string) (categoryName string, confidence float64, ok bool, err error)
	PutAISuggestion(merchantNorm string, categoryID int64, confidence float64) error
}

// MemoAI wraps an AICategorizer with a persistent merchant→suggestion memo so
// the same unknown merchant is never sent to the API twice — across runs and
// restarts, and regardless of the auto-accept threshold. Rules always run
// before the AI path, so a manual/confirmed rule still shadows any memo.
type MemoAI struct {
	Inner AICategorizer
	Store SuggestionStore
}

func (m MemoAI) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	key := strings.ToLower(strings.TrimSpace(merchant))
	if key != "" {
		if name, conf, ok, err := m.Store.GetAISuggestion(key); err == nil && ok {
			return name, conf, nil
		}
	}
	name, conf, err := m.Inner.Categorize(ctx, merchant, cats)
	if err != nil {
		return "", 0, err
	}
	if key != "" {
		for _, c := range cats {
			if strings.EqualFold(c.Name, name) {
				// Best-effort: a failed memo write just means one more API call later.
				_ = m.Store.PutAISuggestion(key, c.ID, conf)
				break
			}
		}
	}
	return name, conf, nil
}
