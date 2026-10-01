package categorize

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"ledger/internal/aihttp"
	"ledger/internal/classify"
)

// tsCats is shared with eval_test.go.
var tsCats = []Category{
	{ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need"},
	{ID: 2, Name: "Dining", Kind: "spending", Bucket: "want"},
	{ID: 3, Name: "Salary", Kind: "income", Bucket: ""},
}

type fakeClassifier struct {
	ans   classify.Answer
	err   error
	max   int
	calls int
	got   classify.Request
}

func (f *fakeClassifier) Classify(_ context.Context, r classify.Request) (classify.Answer, error) {
	f.calls++
	f.got = r
	return f.ans, f.err
}

func (f *fakeClassifier) MaxOptions() int {
	if f.max == 0 {
		return 255
	}
	return f.max
}

func TestClassifierCategorizerQuestionShape(t *testing.T) {
	f := &fakeClassifier{ans: classify.Answer{Choice: "Groceries", Confidence: 0.9}}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "CARREFOUR MOE", tsCats); err != nil {
		t.Fatal(err)
	}
	r := f.got
	if len(r.State) != 1 || r.State["merchant"] != "CARREFOUR MOE" {
		t.Errorf("state must hold ONLY the merchant, got %v", r.State)
	}
	if r.Path != "categorize" || r.Detail != "CARREFOUR MOE" || r.Question.ID != "category" {
		t.Errorf("request = %+v", r)
	}
	crit := map[string]string{}
	for _, o := range r.Question.Options {
		crit[o.Name] = o.Criterion
	}
	if len(crit) != 4 || crit["Salary"] != "Money received" || crit["Dining"] != "Spending (want)" {
		t.Errorf("options = %v", crit)
	}
	if _, ok := crit[noFitOption]; !ok {
		t.Errorf("options missing %q", noFitOption)
	}
}

func TestClassifierCategorizerReturnsChoice(t *testing.T) {
	f := &fakeClassifier{ans: classify.Answer{Choice: "Dining", Confidence: 0.81}}
	name, conf, err := NewClassifierCategorizer(f).Categorize(t.Context(), "TALABAT", tsCats)
	if err != nil || name != "Dining" || conf != 0.81 {
		t.Errorf("got (%q, %v, %v), want (Dining, 0.81, nil)", name, conf, err)
	}
}

func TestClassifierCategorizerNoFitReturnsBestRealWithZeroConfidence(t *testing.T) {
	f := &fakeClassifier{ans: classify.Answer{Choice: noFitOption, Confidence: 0.6,
		Probs: map[string]float64{noFitOption: 0.7, "Dining": 0.2, "Groceries": 0.1}}}
	name, conf, err := NewClassifierCategorizer(f).Categorize(t.Context(), "XYZ LLC", tsCats)
	if err != nil || name != "Dining" || conf != 0 {
		t.Errorf("got (%q, %v, %v), want (Dining, 0, nil)", name, conf, err)
	}
}

// A no-fit answer with no usable probabilities has no best category. Picking
// the first one would be cached in ai_suggestions for good.
func TestClassifierCategorizerNoFitWithoutProbabilitiesErrors(t *testing.T) {
	for _, probs := range []map[string]float64{nil, {noFitOption: 1, "Dining": 0}} {
		f := &fakeClassifier{ans: classify.Answer{Choice: noFitOption, Confidence: 0.9, Probs: probs}}
		if name, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", tsCats); err == nil {
			t.Errorf("probs %v: got %q, want an error", probs, name)
		}
	}
}

func TestClassifierCategorizerRejectsTooManyCategories(t *testing.T) {
	f := &fakeClassifier{max: 4} // room for 3 categories + no-fit
	many := make([]Category, 4)
	for i := range many {
		many[i] = Category{ID: int64(i + 1), Name: "c" + strconv.Itoa(i)}
	}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", many); err == nil {
		t.Error("want an error for 4 categories with MaxOptions 4")
	}
	if f.calls != 0 {
		t.Error("must not call the provider when the category list is too long")
	}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", many[:3]); err != nil {
		t.Errorf("3 categories must fit: %v", err)
	}
}

func TestClassifierCategorizerKeepsErrorChain(t *testing.T) {
	f := &fakeClassifier{err: aihttp.ErrAIDisabled}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", tsCats); !errors.Is(err, aihttp.ErrAIDisabled) {
		t.Errorf("err = %v, want it to wrap ErrAIDisabled", err)
	}
}
