package anthropic

import "strings"

// ExtractJSON returns the JSON object embedded in s — the substring from the
// first '{' to the last '}'. Models occasionally wrap their answer in markdown
// code fences or prose despite instructions; that must not fail the caller's
// unmarshal. Returns s unchanged when no object is present.
func ExtractJSON(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start == -1 || end < start {
		return s
	}
	return s[start : end+1]
}

// Clamp01 bounds a model-reported confidence to [0, 1] so an out-of-range
// value can't trivially clear a caller's acceptance threshold.
func Clamp01(f float64) float64 {
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}
