package aihttp

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

func TestCostMuUSDJevRoundsUp(t *testing.T) {
	// $0.042/Mtok = 42 milli-µUSD per token. 400 tokens = 16800 milli = 16.8 µUSD → 17.
	if got := CostMuUSD("jev-1.13.0", 400, 65); got != 17 {
		t.Errorf("jev 400 in = %d µUSD, want 17", got)
	}
	// One token still costs one whole µUSD, so the cap counts every call.
	if got := CostMuUSD("jev-1.13.0", 1, 0); got != 1 {
		t.Errorf("jev 1 in = %d, want 1", got)
	}
	if got := CostMuUSD("jev-1.13.0", 0, 0); got != 0 {
		t.Errorf("jev 0 in = %d, want 0", got)
	}
}

// Documents the known gap: a Jev version not in the table records cost 0.
func TestCostMuUSDUnknownJevIsZero(t *testing.T) {
	if got := CostMuUSD("jev-9.0.0", 1000, 0); got != 0 {
		t.Errorf("unknown jev = %d, want 0", got)
	}
}
