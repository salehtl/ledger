package parse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"ledger/internal/aihttp"
	"ledger/internal/classify"
)

type fakeClf struct {
	ans classify.Answer
	err error
	got classify.Request
}

func (f *fakeClf) Classify(_ context.Context, r classify.Request) (classify.Answer, error) {
	f.got = r
	return f.ans, f.err
}
func (f *fakeClf) MaxOptions() int { return 255 }

type stubCheck struct {
	v     TxnVerdict
	err   error
	calls *int
}

func (s stubCheck) Check(context.Context, string, string, string) (TxnVerdict, error) {
	if s.calls != nil {
		*s.calls++
	}
	return s.v, s.err
}

type stubIgnoreParser struct{}

func (stubIgnoreParser) Bank() string                      { return "stub" }
func (stubIgnoreParser) Matches(from, subject string) bool { return from == "stub@bank.com" }
func (stubIgnoreParser) Parse(string, string) (ParsedTxn, error) {
	return ParsedTxn{}, ErrIgnoreEmail
}

const junk = "totally unparseable content"

func TestTxnCheckerRequestShape(t *testing.T) {
	f := &fakeClf{ans: classify.Answer{Choice: VerdictTxn, Confidence: 0.9}}
	long := strings.Repeat("a", 20000)
	v, err := NewClassifierTxnChecker(f).Check(t.Context(), "alerts@dib.ae", "Card used", long)
	if err != nil || v.Verdict != VerdictTxn || v.Confidence != 0.9 {
		t.Fatalf("verdict = %+v err = %v", v, err)
	}
	r := f.got
	if r.Path != "txn_check" || r.Detail != "Card used" || r.Question.ID != "is_transaction" {
		t.Errorf("request = %+v", r)
	}
	if len(r.State) != 3 || r.State["from"] != "alerts@dib.ae" || r.State["subject"] != "Card used" {
		t.Errorf("state = %v, want from, subject, body only", r.State)
	}
	if n := len(r.State["body"]); n == 0 || n > maxExtractBodyBytes {
		t.Errorf("body is %d bytes, want 1..%d", n, maxExtractBodyBytes)
	}
	names := []string{}
	for _, o := range r.Question.Options {
		names = append(names, o.Name)
	}
	if strings.Join(names, ",") != VerdictTxn+","+VerdictNotTxn {
		t.Errorf("options = %v", names)
	}
}

// A provider answer outside the two options is an error, never "not a
// transaction".
func TestTxnCheckerRejectsUnexpectedChoice(t *testing.T) {
	f := &fakeClf{ans: classify.Answer{Choice: "maybe", Confidence: 1}}
	if v, err := NewClassifierTxnChecker(f).Check(t.Context(), "a", "b", "c"); err == nil {
		t.Errorf("got %+v, want an error", v)
	}
}

func run(c *Cascade) Result {
	return c.Run(context.Background(), "x@y.com", "s", junk, time.Time{})
}

func TestCascadeAICheckIgnoresConfidentNotTxn(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.99}}})
	if res.Status != StatusIgnored || res.Tier != TierAICheck || res.Verdict == nil {
		t.Fatalf("res = %+v, want ignored by ai_check with a verdict", res)
	}
}

// The threshold is inclusive: a confidence exactly at IgnoreAt sets aside.
func TestCascadeAICheckIgnoresAtExactThreshold(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.95}}})
	if res.Status != StatusIgnored || res.Tier != TierAICheck {
		t.Fatalf("res = %+v, want ignored by ai_check at exactly the threshold", res)
	}
}

func TestCascadeAICheckBelowThresholdStaysUnparsed(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.9}}})
	if res.Status != StatusUnparsed || res.Verdict == nil || res.Verdict.Confidence != 0.9 {
		t.Fatalf("res = %+v, want unparsed with the verdict", res)
	}
	if !strings.Contains(res.Err, "ai_check: not_transaction (0.90)") {
		t.Errorf("Err = %q, want the verdict noted", res.Err)
	}
}

func TestCascadeAICheckTransactionStaysUnparsed(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictTxn, 0.99}}})
	if res.Status != StatusUnparsed || res.Verdict == nil || res.Verdict.Verdict != VerdictTxn {
		t.Fatalf("res = %+v, want unparsed with verdict transaction", res)
	}
}

func TestCascadeAICheckZeroThresholdNeverIgnores(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}}})
	if res.Status != StatusUnparsed {
		t.Fatalf("status = %s, want unparsed when IgnoreAt is unset", res.Status)
	}
}

// AI off is a benign skip: no verdict, nothing claimed in parse_error.
func TestCascadeAICheckDisabledIsBenign(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{err: fmt.Errorf("txn check: %w", aihttp.ErrAIDisabled)}})
	if res.Status != StatusUnparsed || res.Verdict != nil {
		t.Fatalf("res = %+v, want unparsed with no verdict", res)
	}
	if strings.Contains(res.Err, TierAICheck) {
		t.Errorf("Err = %q, must not report the disabled check", res.Err)
	}
}

func TestCascadeAICheckErrorRecorded(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{err: errors.New("boom")}})
	if res.Status != StatusUnparsed || res.Verdict != nil || !strings.Contains(res.Err, "ai_check: boom") {
		t.Fatalf("res = %+v, want unparsed noting the check error", res)
	}
}

func TestCascadeTemplateIgnoreSkipsAICheck(t *testing.T) {
	calls := 0
	c := &Cascade{Parsers: []BankParser{stubIgnoreParser{}}, Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}, calls: &calls}}
	res := c.Run(context.Background(), "stub@bank.com", "s", junk, time.Time{})
	if res.Status != StatusIgnored || res.Tier != TierTemplate || calls != 0 {
		t.Fatalf("res = %+v calls = %d, want a template ignore with no check", res, calls)
	}
}
