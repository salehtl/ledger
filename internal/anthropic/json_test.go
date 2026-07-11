package anthropic

import "testing"

func TestExtractJSON(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain", `{"a":1}`, `{"a":1}`},
		{"fenced", "```json\n{\"a\":1}\n```", `{"a":1}`},
		{"prose-wrapped", `Here is the JSON: {"a":1} Hope that helps!`, `{"a":1}`},
		{"nested-braces", `{"a":{"b":2}}`, `{"a":{"b":2}}`},
		{"no-json", "no braces here", "no braces here"},
		{"empty", "", ""},
	}
	for _, c := range cases {
		if got := ExtractJSON(c.in); got != c.want {
			t.Errorf("%s: ExtractJSON(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

func TestClamp01(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{0.5, 0.5}, {0, 0}, {1, 1}, {1.7, 1}, {-0.3, 0},
	}
	for _, c := range cases {
		if got := Clamp01(c.in); got != c.want {
			t.Errorf("Clamp01(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}
