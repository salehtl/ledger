package categorize

import (
	"context"
	"errors"
	"testing"
)

type fakeAI map[string]struct {
	name string
	conf float64
}

func (f fakeAI) Categorize(_ context.Context, m string, _ []Category) (string, float64, error) {
	r, ok := f[m]
	if !ok {
		return "", 0, errors.New("boom")
	}
	return r.name, r.conf, nil
}

func TestEvaluateBandsAndErrors(t *testing.T) {
	ai := fakeAI{
		"a": {"Dining", 0.95},    // correct, band 0.9
		"b": {"Groceries", 0.92}, // wrong,   band 0.9
		"c": {"Dining", 0.6},     // correct, band 0.5
		"d": {"dining", 0.1},     // correct (case-insensitive), band 0
	}
	labels := []Labeled{{"a", "Dining"}, {"b", "Dining"}, {"c", "Dining"}, {"d", "Dining"}, {"e", "Dining"}}
	r := Evaluate(t.Context(), labels, tsCats, ai)
	if r.Total != 5 || r.Correct != 3 || r.Errors != 1 {
		t.Fatalf("report = %+v, want total 5 correct 3 errors 1", r)
	}
	if r.FirstErr == nil || r.FirstErr.Error() != "boom" {
		t.Errorf("FirstErr = %v, want boom (the operator needs the cause, not just a count)", r.FirstErr)
	}
	want := map[float64][2]int{0.9: {2, 1}, 0.85: {0, 0}, 0.7: {0, 0}, 0.5: {1, 1}, 0: {1, 1}}
	for _, b := range r.Bands {
		if w := want[b.Min]; b.N != w[0] || b.Correct != w[1] {
			t.Errorf("band %.2f = %d/%d, want %d/%d", b.Min, b.Correct, b.N, w[1], w[0])
		}
	}
}
