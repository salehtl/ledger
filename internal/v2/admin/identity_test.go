package admin

// These tests pin the second credential: the Tailscale identity `tailscale
// serve` injects. The header VALUES here are the ones measured on the real box
// (see identity.go's header) rather than invented, so a test passing means the
// console accepts what Tailscale actually sends.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/tmpl"
)

// The exact identity Tailscale 1.102.2 put on a proxied request to this box.
const (
	testLogin = "salehtl@github"
	testTSIP  = "100.68.143.4"
)

// identityConsole builds a token-guarded console with the given identity policy and
// nothing behind it. Same reasoning as uiOnly: authentication is a routing
// question and answering it should not need Postgres.
func identityConsole(t *testing.T, pol IdentityPolicy) http.Handler {
	t.Helper()
	h := &Handler{
		Templates: &tmpl.Store{},
		Diag:      &diag.Diag{},
		Waitlist:  &Waitlist{},
		Token:     testToken,
		Identity:  pol,
		Logf:      func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	return mux
}

// proxied builds the request `tailscale serve` produces: loopback peer, the
// identity headers, the tailnet client in X-Forwarded-For, and the browser's
// own same-origin signal.
func proxied(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = "127.0.0.1:54321"
	r.Host = "dinosaur.marmoset-paradise.ts.net:8445"
	r.Header.Set(hdrLogin, testLogin)
	r.Header.Set(hdrName, "Saleh")
	r.Header.Set(hdrFor, testTSIP)
	r.Header.Set("Tailscale-Headers-Info", "https://tailscale.com/s/serve-headers")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func do(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// The whole point: a request through `tailscale serve` needs no token.
//
// /admin/status is the route used because it is the one the panel probes on
// load, and because it answers 200 with no database behind it.
func TestATailscaleIdentityAuthenticatesWithoutAToken(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true})
	if rec := do(h, proxied(http.MethodGet, "/admin/status")); rec.Code != http.StatusOK {
		t.Fatalf("a proxied request answered %d, want 200: the operator still needs a token", rec.Code)
	}
}

// ...and the identity comes back on the status route, which is how the panel
// knows not to show a token field.
func TestTheStatusRouteReportsTheIdentityItAuthenticatedWith(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true})
	rec := do(h, proxied(http.MethodGet, "/admin/status"))
	if body := rec.Body.String(); !strings.Contains(body, testLogin) {
		t.Fatalf("GET /admin/status did not report the caller identity: %s", body)
	}

	// A token-authenticated caller gets NO identity, because the token says
	// somebody holds the credential and not who they are.
	r := httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	rec = do(h, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("token auth answered %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "identity") {
		t.Fatalf("a token-authenticated caller was given an identity: %s", body)
	}
}

// Every way a request can fail to be a trusted, proxied, same-origin one, and
// all of them answer the identical 401.
func TestUntrustedIdentitiesAreRefused(t *testing.T) {
	tests := []struct {
		name   string
		pol    IdentityPolicy
		mutate func(*http.Request)
	}{{
		name: "the policy does not trust the header at all",
		pol:  IdentityPolicy{},
	}, {
		// The case the loopback rule exists for: another enrolled tailnet
		// device connecting STRAIGHT to 100.x:8079, bypassing `serve` and
		// writing whatever identity it likes.
		name:   "the peer is a tailnet device rather than the local proxy",
		pol:    IdentityPolicy{Trust: true},
		mutate: func(r *http.Request) { r.RemoteAddr = "100.64.0.9:41234" },
	}, {
		name:   "there is no identity header",
		pol:    IdentityPolicy{Trust: true},
		mutate: func(r *http.Request) { r.Header.Del(hdrLogin) },
	}, {
		name:   "the identity header is blank",
		pol:    IdentityPolicy{Trust: true},
		mutate: func(r *http.Request) { r.Header.Set(hdrLogin, "   ") },
	}, {
		name:   "there is no forwarded-for, so nothing says this came through serve",
		pol:    IdentityPolicy{Trust: true},
		mutate: func(r *http.Request) { r.Header.Del(hdrFor) },
	}, {
		name:   "forwarded-for is not a tailnet address",
		pol:    IdentityPolicy{Trust: true},
		mutate: func(r *http.Request) { r.Header.Set(hdrFor, "203.0.113.7") },
	}, {
		// 100.63.255.255 is one below the CGNAT range. It is here because a
		// mask-and-compare written by hand gets exactly this wrong.
		name:   "forwarded-for is just below the tailnet range",
		pol:    IdentityPolicy{Trust: true},
		mutate: func(r *http.Request) { r.Header.Set(hdrFor, "100.63.255.255") },
	}, {
		name:   "the login is not on the allowlist",
		pol:    IdentityPolicy{Trust: true, Logins: []string{"someone-else@github"}},
		mutate: func(r *http.Request) {},
	}}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := identityConsole(t, tc.pol)
			r := proxied(http.MethodGet, "/admin/status")
			if tc.mutate != nil {
				tc.mutate(r)
			}
			if rec := do(h, r); rec.Code != http.StatusUnauthorized {
				t.Fatalf("answered %d, want 401", rec.Code)
			}
		})
	}
}

// The allowlist accepts the operator, and does so whatever case the header
// arrives in.
func TestTheLoginAllowlistAcceptsTheOperator(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true, Logins: []string{" SalehTL@GitHub "}})
	if rec := do(h, proxied(http.MethodGet, "/admin/status")); rec.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: a mis-cased allowlist entry must not lock the operator out", rec.Code)
	}
}

// The IPv6 half of the corroboration, which config.CheckAdminBind deliberately
// does NOT accept for a binding. Pinned so nobody "fixes" the difference.
func TestAnIPv6TailscaleClientIsAccepted(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true})
	r := proxied(http.MethodGet, "/admin/status")
	r.Header.Set(hdrFor, "fd7a:115c:a1e0::d33a:8f04")
	if rec := do(h, r); rec.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: the operator's phone may be v6-only on the tailnet", rec.Code)
	}
}

// THE test for this whole design.
//
// `tailscale serve` attaches the operator's identity to EVERY request their
// browser makes, including one a malicious page caused. So an identity-
// authenticated WRITE has to carry evidence the browser itself produced that
// the request came from this console's own page. Without that, tokenless access
// would have handed any open tab the ability to suspend an account.
func TestAnIdentityAloneCannotDriveAWriteFromAnotherSite(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true})
	const path = "/admin/waitlist" // a POST that exists with no database behind it

	refused := []struct {
		name   string
		mutate func(*http.Request)
	}{{
		name:   "a cross-site fetch",
		mutate: func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
	}, {
		name:   "a same-site fetch from a sibling host",
		mutate: func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") },
	}, {
		// The old-browser path: no Sec-Fetch-* at all, but a cross-origin
		// write still carries Origin.
		name: "an origin that is not this console",
		mutate: func(r *http.Request) {
			r.Header.Del("Sec-Fetch-Site")
			r.Header.Set("Origin", "https://evil.example")
		},
	}, {
		// Neither signal. Not a browser, so it is told to use the token —
		// accepting it would mean accepting a write with no same-origin
		// evidence whatsoever, which is the forged POST this check exists for.
		name: "no same-origin evidence at all",
		mutate: func(r *http.Request) {
			r.Header.Del("Sec-Fetch-Site")
			r.Header.Del("Origin")
		},
	}}
	for _, tc := range refused {
		t.Run(tc.name, func(t *testing.T) {
			r := proxied(http.MethodPost, path)
			tc.mutate(r)
			if rec := do(h, r); rec.Code != http.StatusUnauthorized {
				t.Fatalf("a write answered %d, want 401: %s must not be able to change state", rec.Code, tc.name)
			}
		})
	}

	accepted := []struct {
		name   string
		mutate func(*http.Request)
	}{{
		name:   "the console's own fetch",
		mutate: func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-origin") },
	}, {
		name:   "a navigation the operator typed",
		mutate: func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "none") },
	}, {
		name: "an origin matching this console, on a browser with no Sec-Fetch",
		mutate: func(r *http.Request) {
			r.Header.Del("Sec-Fetch-Site")
			r.Header.Set("Origin", "https://dinosaur.marmoset-paradise.ts.net:8445")
		},
	}}
	for _, tc := range accepted {
		t.Run(tc.name, func(t *testing.T) {
			r := proxied(http.MethodPost, path)
			tc.mutate(r)
			// It gets past the gate; the handler then fails on the missing body
			// or the nil store. Anything but 401 means it was authenticated.
			if rec := do(h, r); rec.Code == http.StatusUnauthorized {
				t.Fatalf("%s was refused; the console's own page must be able to write", tc.name)
			}
		})
	}
}

// A GET needs no same-origin evidence: it changes nothing, and this listener
// sends no CORS headers, so a cross-site page cannot read the reply either.
func TestAReadNeedsNoSameOriginEvidence(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true})
	r := proxied(http.MethodGet, "/admin/status")
	r.Header.Del("Sec-Fetch-Site")
	if rec := do(h, r); rec.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200", rec.Code)
	}
}

// The token is a FALLBACK, not a legacy path: it still works, and it works for
// a caller with no browser signals at all, which is exactly the `curl` case.
func TestTheBearerTokenStillWorksWithNoBrowserSignals(t *testing.T) {
	for _, pol := range []IdentityPolicy{{}, {Trust: true}} {
		h := identityConsole(t, pol)
		r := httptest.NewRequest(http.MethodPost, "/admin/waitlist", nil)
		r.Header.Set("Authorization", "Bearer "+testToken)
		if rec := do(h, r); rec.Code == http.StatusUnauthorized {
			t.Fatalf("the operator token was refused (trust=%v); it is the fallback for scripts "+
				"and for a box with no serve mount", pol.Trust)
		}
	}
}

// A WRONG token is refused outright, even from a browser the tailnet vouches
// for. Somebody who presented a credential meant this one; quietly authenticating
// them by another route would hide a stale token nobody would ever fix.
func TestAWrongTokenIsRefusedEvenWithATrustedIdentity(t *testing.T) {
	h := identityConsole(t, IdentityPolicy{Trust: true})
	r := proxied(http.MethodGet, "/admin/status")
	r.Header.Set("Authorization", "Bearer not-the-operator-token")
	if rec := do(h, r); rec.Code != http.StatusUnauthorized {
		t.Fatalf("answered %d, want 401", rec.Code)
	}
}

// The token, when one is still needed, is kept per DEVICE and not per tab.
//
// sessionStorage meant retyping it in every new tab, which is most of the
// friction this whole change is about. It is checked in the source because there
// is no other way to observe it: the panel has no build and no test runner.
func TestThePanelKeepsTheTokenPerDeviceAndNotPerTab(t *testing.T) {
	js := panelCode()
	if strings.Contains(js, "sessionStorage") {
		t.Error("console.js still uses sessionStorage; the token must survive a new tab")
	}
	for _, want := range []string{"localStorage.getItem", "localStorage.setItem", "localStorage.removeItem"} {
		if !strings.Contains(js, want) {
			t.Errorf("console.js does not call %s", want)
		}
	}
	// And it never shows the token field before finding out whether it needs
	// one: the boot probe is what makes the panel tokenless in practice.
	if !strings.Contains(js, "async function boot()") {
		t.Error("console.js has no boot probe, so it cannot know whether a token is needed")
	}
}

// The dictionary half shares the gate rather than reimplementing it. It is the
// route that ships a merchant mapping to every device in the beta, so a policy
// that applied to the rest of the console and not to this one would be the
// worst possible place for the two to disagree.
func TestTheDictionaryConsoleHonoursTheSameIdentityPolicy(t *testing.T) {
	h := &DictHandler{
		Dict:     &dict.Dict{},
		Token:    testToken,
		Identity: IdentityPolicy{Trust: true},
		Logf:     func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	if rec := do(mux, proxied(http.MethodGet, "/admin/dictionary")); rec.Code == http.StatusUnauthorized {
		t.Fatal("the dictionary console refused a trusted tailnet identity the rest of the console accepts")
	}
	// And the CSRF half, on the approval route specifically.
	r := proxied(http.MethodPost, "/admin/dictionary/moderate")
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := do(mux, r); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a cross-site approval answered %d, want 401", rec.Code)
	}
}
