package aihttp

import (
	"strings"
	"testing"
)

// The gate's error can surface in the categorize run status. It must not name
// a provider the code may not be calling.
func TestErrAIDisabledNamesNoProvider(t *testing.T) {
	if msg := ErrAIDisabled.Error(); strings.Contains(strings.ToLower(msg), "anthropic") {
		t.Errorf("ErrAIDisabled = %q, must not name a provider", msg)
	}
}
