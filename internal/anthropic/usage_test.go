package anthropic

import "testing"

func TestCostMuUSD(t *testing.T) {
	cases := []struct {
		name          string
		model         string
		in, out, want int64
	}{
		{"haiku basic", "claude-haiku-4-5-20251001", 1000, 100, 1500}, // 1000*1 + 100*5
		{"haiku alias", "claude-haiku-4-5", 812, 47, 1047},            // 812*1 + 47*5
		{"opus", "claude-opus-4-8", 1000, 100, 7500},                  // 1000*5 + 100*25
		{"unknown model -> zero", "made-up-model", 1000, 100, 0},
		{"zero tokens", "claude-haiku-4-5", 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := CostMuUSD(c.model, c.in, c.out); got != c.want {
				t.Fatalf("CostMuUSD(%q,%d,%d) = %d, want %d", c.model, c.in, c.out, got, c.want)
			}
		})
	}
}
