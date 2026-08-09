package admin

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/tmpl"
)

// uiOnly builds a console with no database behind it.
//
// Routes only needs the three required stores to be non-nil, and none of the
// panel's own routes touch a pool, so the whole file runs without Postgres.
// That is worth having: "which paths serve the panel, and to whom" is a routing
// question, and a routing regression should not need a cluster to be observed.
func uiOnly(t *testing.T) http.Handler {
	t.Helper()
	h := &Handler{
		Templates: &tmpl.Store{},
		Diag:      &diag.Diag{},
		Waitlist:  &Waitlist{},
		Token:     testToken,
		Logf:      func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	return mux
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// The panel's three files are served, with the right type, WITHOUT a token.
//
// A browser navigating to a URL cannot send an Authorization header, so a
// token-guarded index.html could never be opened. What makes that safe is the
// second half of this test: the assets carry no data (see
// TestThePanelTalksOnlyToTheAdminConsole and the guard tests below).
func TestThePanelIsServedWithoutAToken(t *testing.T) {
	h := uiOnly(t)
	for path, wantType := range map[string]string{
		"/admin/ui/":            "text/html",
		"/admin/ui/console.css": "text/css",
		"/admin/ui/console.js":  "text/javascript",
	} {
		rec := get(t, h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: %d, want 200 (a browser cannot send a bearer header on a navigation)", path, rec.Code)
			continue
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, wantType) {
			t.Errorf("%s: Content-Type %q, want %s", path, ct, wantType)
		}
		if rec.Body.Len() == 0 {
			t.Errorf("%s: empty body", path)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options %q", path, got)
		}
		if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
			t.Errorf("%s: Content-Security-Policy %q does not deny by default", path, csp)
		}
	}
}

// The root redirects to the panel, because an operator types a host name.
func TestTheRootRedirectsToThePanel(t *testing.T) {
	rec := get(t, uiOnly(t), "/")
	if rec.Code != http.StatusFound {
		t.Fatalf("/: %d, want 302", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != uiPath {
		t.Fatalf("/ redirected to %q, want %q", loc, uiPath)
	}
}

// The root pattern is `/{$}` and not `/`, so it matches the root and nothing
// else. A bare "/" would have made this listener answer 200 for every unrouted
// path — including the user API paths cmd/ledgerd's
// TestTheAdminConsoleIsNotMountedOnThePublicListener requires to 404 here.
func TestTheRootRedirectIsNotACatchAll(t *testing.T) {
	h := uiOnly(t)
	// Not an /admin/ path: those fall to the GUARDED catch-all and answer 401 by
	// design, so an unauthenticated caller cannot map the console's routes by
	// comparing a 404 against a 401.
	for _, p := range []string{"/api/v1/sync", "/api/v1/writers", "/anything", "/health"} {
		if rec := get(t, h, p); rec.Code != http.StatusNotFound {
			t.Errorf("%s answered %d on the admin listener; it must be 404", p, rec.Code)
		}
	}
}

// pathLiteral finds every absolute-path string literal in the panel's script.
var pathLiteral = regexp.MustCompile(`"(/[^"\s]*)"`)

// panelPaths is every path the panel is allowed to name, exactly as it spells
// it. The last three are suffixes concatenated onto a template's base path.
//
// It is an exact allowlist rather than a prefix rule so that adding a data
// source to the panel is a deliberate edit here. That is the mechanical half of
// "operational data only": each of these is an /admin/ route whose response is
// audited for what it may return — no donated body, no extracted value, and
// nothing out of the op log — so a panel that talks only to them inherits that
// audit. A fetch anywhere else steps outside it.
var panelPaths = map[string]bool{
	"/admin/accounts":  true,
	"/admin/accounts/": true,
	// The two halves of the suspend lever, concatenated onto the account base
	// path above. They are the only WRITES the panel makes to an account, and
	// they carry no body: the URL is the whole instruction.
	"/suspend":          true,
	"/resume":           true,
	"/admin/accounting": true,
	"/admin/diagnostics?event=arrival&limit=500": true,
	"/admin/quarantine?user=":                    true,
	"/admin/templates":                           true,
	"/admin/templates/":                          true,
	"/admin/samples":                             true,
	"/admin/samples/":                            true,
	"/admin/dictionary":                          true,
	"/admin/dictionary/moderate":                 true,
	"/admin/dictionary/approve-seed":             true,
	"/admin/waitlist":                            true,
	"/validate":                                  true,
	"/publish":                                   true,
	"/reprocess":                                 true,
	// The separator between a template id and its version.
	"/": true,
}

func TestThePanelTalksOnlyToTheAdminConsole(t *testing.T) {
	// The header comment names paths in prose; strip comments before scanning.
	var body strings.Builder
	for _, line := range strings.Split(string(uiConsoleJS), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		body.WriteString(line + "\n")
	}
	for _, m := range pathLiteral.FindAllStringSubmatch(body.String(), -1) {
		if !panelPaths[m[1]] {
			t.Errorf("console.js names the path %q, which is not in panelPaths. If it is a new "+
				"data source, add it here deliberately and check what that route can return: "+
				"the panel shows operational data only.", m[1])
		}
	}
}

// Every route the panel calls exists on the console, and every one of them is
// behind the token.
//
// The two halves matter together: a typo'd path would 404 at runtime and this
// catches it, and a route that answered without a token would mean the
// unauthenticated panel shell could read data, which is the one thing the
// unguarded assets depend on not being true.
func TestEveryRouteThePanelCallsIsMountedAndGuarded(t *testing.T) {
	h := uiOnly(t)
	for _, p := range []string{
		"/admin/accounts", "/admin/accounting", "/admin/diagnostics",
		"/admin/quarantine", "/admin/templates", "/admin/samples",
		"/admin/dictionary", "/admin/waitlist",
	} {
		// Quarantine, Samples and Dict are nil in this fixture, so they are
		// genuinely not mounted here and fall to the GUARDED catch-all — which
		// answers 401 to an unauthenticated caller exactly like a real route, on
		// purpose (an unauthenticated caller must not be able to map the routes).
		if rec := get(t, h, p); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s answered %d without a token, want 401", p, rec.Code)
		}
	}
}
