package categorize

import (
	"context"
	"testing"
)

type countingAI struct{ calls int }

func (c *countingAI) Categorize(context.Context, string, []Category) (string, float64, error) {
	c.calls++
	return "Dining", 0.7, nil
}

type mapMemo struct {
	rows map[string]struct {
		catID int64
		conf  float64
	}
}

func (m *mapMemo) GetAISuggestion(k string) (string, float64, bool, error) {
	r, ok := m.rows[k]
	if !ok {
		return "", 0, false, nil
	}
	_ = r.catID
	return "Dining", r.conf, true, nil
}

func (m *mapMemo) PutAISuggestion(k string, catID int64, conf float64) error {
	m.rows[k] = struct {
		catID int64
		conf  float64
	}{catID, conf}
	return nil
}

func TestMemoAICallsInnerOncePerMerchant(t *testing.T) {
	inner := &countingAI{}
	memo := MemoAI{Inner: inner, Store: &mapMemo{rows: map[string]struct {
		catID int64
		conf  float64
	}{}}}
	cats := []Category{{ID: 7, Name: "Dining"}}

	name, conf, err := memo.Categorize(context.Background(), "Some Cafe LLC", cats)
	if err != nil || name != "Dining" || conf != 0.7 {
		t.Fatalf("first call: %q %v %v", name, conf, err)
	}
	// Same merchant, different casing/whitespace → memo hit, no second API call.
	if _, _, err := memo.Categorize(context.Background(), "  SOME CAFE llc ", cats); err != nil {
		t.Fatal(err)
	}
	if inner.calls != 1 {
		t.Fatalf("inner AI must be called exactly once, got %d", inner.calls)
	}
}
