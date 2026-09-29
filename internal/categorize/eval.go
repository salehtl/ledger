package categorize

import (
	"context"
	"strings"
)

// Labeled is one merchant with the category Saleh confirmed for it.
type Labeled struct{ Merchant, Want string }

// EvalBand counts answers whose confidence is >= Min and below the next band.
type EvalBand struct {
	Min        float64
	N, Correct int
}

// EvalReport is the outcome of Evaluate. Errors are calls that failed; they
// count in Total but in no band. FirstErr is the first of them, so a bad key
// reads as a 401, not as a bare count.
type EvalReport struct {
	Total, Correct, Errors int
	Bands                  []EvalBand
	FirstErr               error
}

// evalBandMins are descending; 0.85 matches the default auto-accept threshold.
var evalBandMins = []float64{0.9, 0.85, 0.7, 0.5, 0}

// Evaluate asks ai for every labeled merchant and compares the answer with the
// confirmed category. It calls ai directly, never through MemoAI, so every
// answer is fresh.
func Evaluate(ctx context.Context, labels []Labeled, cats []Category, ai AICategorizer) EvalReport {
	r := EvalReport{Bands: make([]EvalBand, len(evalBandMins))}
	for i, m := range evalBandMins {
		r.Bands[i].Min = m
	}
	for _, l := range labels {
		r.Total++
		name, conf, err := ai.Categorize(ctx, l.Merchant, cats)
		if err != nil {
			r.Errors++
			if r.FirstErr == nil {
				r.FirstErr = err
			}
			continue
		}
		ok := strings.EqualFold(name, l.Want)
		if ok {
			r.Correct++
		}
		for i, m := range evalBandMins {
			if conf >= m {
				r.Bands[i].N++
				if ok {
					r.Bands[i].Correct++
				}
				break
			}
		}
	}
	return r
}
