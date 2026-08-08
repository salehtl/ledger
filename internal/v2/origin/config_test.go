package origin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestTrustPathNeverReadsUserConfiguration enforces the rule that survives the
// schema-v3 configuration ops: declared banks route the waitlist and drive the
// UI, and they must never influence an origin decision.
//
// It matters because the two look interchangeable and are not. A declared bank
// is a claim the USER makes, editable at any moment from a phone; trust here is
// a claim about a MESSAGE, established by DKIM and a sender allowlist. Letting
// the first reach the second would mean a user could widen what this package
// trusts by ticking a box in Settings, and the widening would look like a
// preference rather than a security change.
//
// A source scan rather than a behavioural assertion, because the property is an
// absence: there is no call to make that proves nothing consults configuration,
// only the fact that the package cannot see it. It reads this package's own
// sources, so a future file is covered without anyone remembering to add it.
func TestTrustPathNeverReadsUserConfiguration(t *testing.T) {
	// The op vocabulary that carries user configuration. Named literally rather
	// than imported from oplog: importing the package to name its constants is
	// itself the dependency this test forbids.
	forbidden := []string{"banks_declared", "budget_split_set", "category_defined", "OpBanksDeclared", "OpBudgetSplitSet", "OpCategoryDefined", "ledger/internal/v2/oplog"}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || filepath.Ext(name) != ".go" || strings.HasSuffix(name, "_test.go") {
			continue
		}
		b, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		for _, needle := range forbidden {
			if strings.Contains(string(b), needle) {
				t.Errorf("%s mentions %q: the trust path must not consult user configuration", name, needle)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("scanned no sources, so this test proved nothing")
	}
}
