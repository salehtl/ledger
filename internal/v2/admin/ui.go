package admin

// ui.go serves the operator's panel: three static files that talk to the JSON
// routes in admin.go, accounts.go and dict.go.
//
// # Why three hand-written files and not a bundle
//
// The panel is a reader with five buttons on it, for one operator, on a
// tailnet. A Vite app would add a second embedded dist tree, a second build
// step the deploy has to remember, and a node_modules to keep current — for a
// page whose whole job is to render eight tables. The app's design language is
// carried in CSS custom properties, so it copies across verbatim into a plain
// stylesheet; what does NOT copy across is the app's fonts (Geist is an npm
// dependency, not an asset this package can embed), so the stacks here fall
// back to the system sans and system mono. That is the one visible difference
// from the app, and it is a fair price for a console with no build.
//
// # The assets are NOT behind the token, and that is deliberate
//
// A browser navigating to a URL cannot send an Authorization header, so a
// token-guarded index.html could never be opened by the operator it exists for.
// These three files therefore serve unauthenticated — they carry no data, only
// markup, style and the code that ASKS for a token. Every byte of actual
// content still comes from a guarded JSON route, so an unauthenticated caller
// on the tailnet who fetches the panel sees an empty shell and a login field.
//
// This is also why the console needs no CSRF token. Authority is a bearer
// header the page reads out of sessionStorage, never a cookie, so a request
// forged from another origin arrives with no credential at all and is refused
// by requireToken like any other. A cookie-based session here would have needed
// a separate defence; a header-based one does not have the problem.
//
// # What it must never show
//
// Operational data only: accounts, mailbox addresses, forwarding health, ingest
// failures, quarantine counts, parse drift, template health, key-publication
// state, the moderation queue, the waitlist. Never a transaction, an amount, a
// merchant or a balance. That is not a preference about clutter — from Phase 3
// the server cannot read those things at all, and a panel written as though it
// could would break the day sealing lands. TestThePanelReferencesNoMoneyRoute
// pins the negative half of it.

import (
	_ "embed"
	"net/http"
	"strconv"
)

//go:embed ui/index.html
var uiIndexHTML []byte

//go:embed ui/console.css
var uiConsoleCSS []byte

//go:embed ui/console.js
var uiConsoleJS []byte

// uiPath is where the panel lives. It sits UNDER /admin/ so that everything
// this listener serves shares one prefix, and it is registered as three exact
// patterns rather than a subtree with a wildcard: three files is the whole
// asset set, and an exact pattern per file leaves no path to traverse.
const uiPath = "/admin/ui/"

// uiRoutes mounts the panel. Called by Routes, after the JSON routes, so the
// error path there ("mount nothing on the way to a refusal") still holds.
func (h *Handler) uiRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+uiPath+"{$}", serveAsset("text/html; charset=utf-8", uiIndexHTML))
	mux.HandleFunc("GET "+uiPath+"console.css", serveAsset("text/css; charset=utf-8", uiConsoleCSS))
	mux.HandleFunc("GET "+uiPath+"console.js", serveAsset("text/javascript; charset=utf-8", uiConsoleJS))

	// The root, and ONLY the exact root: `{$}` matches "/" and nothing else, so
	// this cannot become a catch-all that answers 200 for a path that should be
	// a 404. cmd/ledgerd's TestTheAdminConsoleIsNotMountedOnThePublicListener
	// checks the admin mux 404s for every /api/ path, and a bare "/" pattern
	// would have quietly broken it.
	//
	// It exists because an operator types a host name, not a path.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, uiPath, http.StatusFound)
	})
}

// serveAsset returns a handler for one embedded file.
//
// no-store, matching writeJSON: the panel is redeployed with the binary, and a
// cached console.js from the previous build talking to the current API is a
// confusing failure for a page nobody versions.
func serveAsset(contentType string, body []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hdr := w.Header()
		hdr.Set("Content-Type", contentType)
		hdr.Set("Content-Length", strconv.Itoa(len(body)))
		hdr.Set("Cache-Control", "no-store")
		hdr.Set("X-Content-Type-Options", "nosniff")
		hdr.Set("Referrer-Policy", "no-referrer")
		// Everything the page loads is one of these three files on this origin.
		// There is no inline script and no inline style, so 'self' is enough and
		// no 'unsafe-inline' escape hatch is needed.
		hdr.Set("Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; "+
				"connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "+
				"frame-ancestors 'none'")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}
}
