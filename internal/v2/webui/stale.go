package webui

import (
	"bytes"
	"fmt"
	"io/fs"
	"strings"
)

// v2APIPrefix is the path every v2 sync call begins with. The browser Client
// leaves its base URL empty (same origin), so these appear in the bundle as
// literal strings and survive minification.
const v2APIPrefix = "/api/v1"

// CheckBundle reports whether the embedded bundle looks like the v2 PWA.
//
// # Why a committed build artifact needs a liveness check at all
//
// dist/ is committed (see embed.go), which is what lets a fresh clone compile
// without Node — and is also what makes a STALE bundle completely silent. The
// Go build succeeds, every test passes, the binary starts, and the public
// origin serves a PWA wired to endpoints ledgerd does not have. Nothing in the
// type system, the tests or the deploy can tell the difference between "this
// dist is current" and "this dist is from another branch six weeks ago",
// because both are just bytes in a directory.
//
// The cheapest true signal is that the v2 client talks to /api/v1 and nothing
// else does. A bundle with no such reference is not the v2 UI, whatever else it
// might be. This is a heuristic and it is named like one: it cannot detect a
// bundle that is v2 but merely OLD, only one that is not v2 at all. runServe
// logs it loudly rather than refusing to start, because a warning an operator
// can act on beats a binary that will not boot during a cutover.
func CheckBundle(files fs.FS) error {
	var scanned int
	var found bool
	err := fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || found {
			return nil
		}
		if !strings.HasSuffix(p, ".js") && !strings.HasSuffix(p, ".html") {
			return nil
		}
		b, err := fs.ReadFile(files, p)
		if err != nil {
			return err
		}
		scanned++
		if bytes.Contains(b, []byte(v2APIPrefix)) {
			found = true
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("scan embedded bundle: %w", err)
	}
	if scanned == 0 {
		return fmt.Errorf("the embedded PWA bundle has no JavaScript in it at all: " +
			"dist/ was never built (cd web && bun run build)")
	}
	if !found {
		return fmt.Errorf("the embedded PWA bundle (%d script/html file(s)) contains no reference to "+
			"%q: it is not a build of the v2 UI. Serving it publicly means shipping a client wired to "+
			"endpoints ledgerd does not serve — rebuild with (cd web && bun run build) and commit "+
			"internal/v2/webui/dist", scanned, v2APIPrefix)
	}
	return nil
}
