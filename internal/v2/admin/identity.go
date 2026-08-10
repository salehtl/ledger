package admin

// identity.go is the console's SECOND way to authenticate: the caller identity
// `tailscale serve` injects, so the operator does not have to fetch a bearer
// token off the box before reading a page on their own tailnet.
//
// # What tailscale serve actually sends, measured rather than assumed
//
// Verified on this box (Tailscale 1.102.2) by pointing a throwaway
// `tailscale serve --https=8446 http://127.0.0.1:8078` at a listener that dumps
// its request headers, then curling the tailnet name. The proxied request
// arrives on loopback carrying:
//
//	Tailscale-User-Login:       salehtl@github
//	Tailscale-User-Name:        Saleh
//	Tailscale-User-Profile-Pic: https://avatars.githubusercontent.com/u/...
//	Tailscale-Headers-Info:     https://tailscale.com/s/serve-headers
//	X-Forwarded-For:            100.68.143.4
//	X-Forwarded-Host:           dinosaur.marmoset-paradise.ts.net:8446
//	X-Forwarded-Proto:          https
//
// Two properties were measured, not inferred, because the whole design rests on
// them: a caller that sets `Tailscale-User-Login: attacker@evil` on the way in
// has it OVERWRITTEN with the real identity, and a caller that sets
// `X-Forwarded-For: 1.2.3.4` has that overwritten too. `serve` sets these; it
// does not merge them.
//
// # The header is only worth anything if the request came through serve
//
// It did not arrive over an authenticated channel — it arrived as plain HTTP on
// loopback — so the question is not "is this header signed" (it is not, and
// there is no shared secret `serve` can be asked to inject) but "who can put a
// request on this socket at all". Three things narrow that:
//
//  1. config.CheckAdminBind already refuses to bind this listener to anything
//     but loopback or 100.64.0.0/10. Unchanged, and still the real control.
//  2. identify additionally requires the TCP PEER to be loopback. On this box
//     `serve` proxies to 127.0.0.1:8079, so that is satisfied — and it removes
//     a case the binding alone allows: another enrolled tailnet device
//     connecting STRAIGHT to 100.x:8079 and forging a login. Those requests are
//     now refused whatever headers they carry.
//  3. X-Forwarded-For must parse as a Tailscale address. This is corroboration,
//     not a boundary — a local spoofer can write it — and it is written down as
//     corroboration so nobody later mistakes it for one.
//
// # What is left: a local process on the box, stated plainly
//
// A process running on dinosaur can connect to 127.0.0.1:8079 and send
// `Tailscale-User-Login: whoever` itself. Nothing in HTTP can tell that request
// apart from a proxied one, and this file does not pretend otherwise.
//
// It is accepted, for a reason that is not a shrug: a local process is already
// a process that can read LEDGER_ADMIN_TOKEN out of /etc/ledger/ledger.env, out
// of the unit's environment, or out of /proc/<pid>/environ. Trusting the header
// hands it nothing it did not already have. The operator who wants the header
// ignored anyway sets `server.admin_token_only = true` and gets the old
// bearer-only console back with no other change.
//
// # Identity alone is NOT a CSRF defence, and this is the part worth reading
//
// The bearer token had one accidental virtue: a page on evil.com cannot make a
// browser attach an `Authorization` header, so a forged POST arrived with no
// credential. Tailscale identity inverts that — `serve` attaches the identity to
// EVERY request the operator's browser makes, including one a malicious page
// caused. `fetch('https://dinosaur…:8445/admin/accounts/X/suspend',
// {method:'POST', mode:'no-cors'})` would have been authenticated. CORS would
// stop that page reading the reply; the suspension would still have happened.
//
// So an identity-authenticated request that CHANGES something must also carry
// positive same-origin evidence from the browser itself: `Sec-Fetch-Site` (which
// script cannot set) in {same-origin, none}, or an `Origin` matching this
// console's own host. A cross-site page can produce neither. Absent both, the
// request is refused — which is why `curl` scripts keep using the token, and why
// the token is a fallback rather than a legacy path.

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

// Identity is the caller as Tailscale reports them. Login is the stable handle
// (`salehtl@github`); Name is the display name and is decoration.
type Identity struct {
	Login string `json:"login"`
	Name  string `json:"name,omitempty"`
}

// IdentityPolicy is when a Tailscale identity counts as the operator.
//
// The zero value trusts NOTHING, so a Handler or DictHandler built without
// thinking about this — every test in this package that predates it — keeps the
// bearer-only behaviour it had. cmd/ledgerd turns it on.
type IdentityPolicy struct {
	// Trust enables the whole mechanism.
	Trust bool
	// Logins, when non-empty, is the set of logins allowed. Empty means any
	// identity the tailnet vouches for, which is the honest default: the
	// tailnet IS the boundary, and a one-operator tailnet has one member.
	// Matched case-insensitively, because an IdP login is not case-sensitive
	// in practice and a mis-cased allowlist entry that silently locks the
	// operator out is a worse failure than a slightly loose match.
	Logins []string
}

// Tailscale's own address space, used to corroborate X-Forwarded-For.
//
// Both families are accepted here, unlike config.CheckAdminBind, which accepts
// only the v4 CGNAT range. The difference is what the two decide: CheckAdminBind
// picks a socket to bind and must not accept a ULA prefix that any host may
// number itself from, whereas this is a supporting signal on a request that has
// already had to arrive on loopback. Refusing v6 here would refuse the
// operator's phone for no gain.
var (
	tailscaleV4 = netip.MustParsePrefix("100.64.0.0/10")
	tailscaleV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")
)

// Header names, spelled once. They are canonical MIME form, which is what
// http.Header.Get expects.
const (
	hdrLogin = "Tailscale-User-Login"
	hdrName  = "Tailscale-User-Name"
	hdrFor   = "X-Forwarded-For"
)

// identify reports the trusted Tailscale identity on r, if there is one.
//
// The second return is false for every reason — policy off, peer not loopback,
// no header, a forwarded-for that is not a tailnet address, a login off the
// allowlist — and the caller answers the same 401 for all of them, on the same
// terms requireOperator states: a response that distinguishes them is an oracle.
func (p IdentityPolicy) identify(r *http.Request) (Identity, bool) {
	if !p.Trust {
		return Identity{}, false
	}
	if !peerIsLoopback(r.RemoteAddr) {
		return Identity{}, false
	}
	login := strings.TrimSpace(r.Header.Get(hdrLogin))
	if login == "" {
		return Identity{}, false
	}
	if !forwardedForIsTailscale(r.Header.Get(hdrFor)) {
		return Identity{}, false
	}
	if len(p.Logins) > 0 {
		ok := false
		for _, allowed := range p.Logins {
			if strings.EqualFold(strings.TrimSpace(allowed), login) {
				ok = true
				break
			}
		}
		if !ok {
			return Identity{}, false
		}
	}
	return Identity{Login: login, Name: strings.TrimSpace(r.Header.Get(hdrName))}, true
}

// peerIsLoopback reports whether the TCP peer is this box.
//
// A RemoteAddr that does not parse is NOT loopback: the only way to reach this
// code is through net/http, which always sets a host:port, so an unparseable one
// is a fixture or a proxy this function does not understand — and defaulting an
// unknown to "trusted" is the wrong direction for a credential check.
func peerIsLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return ip.Unmap().IsLoopback()
}

// forwardedForIsTailscale checks the FIRST hop of X-Forwarded-For, which is the
// client `serve` saw. Later hops, if a header somehow arrives with several, are
// ignored rather than searched: the leftmost is the only one with a defined
// meaning here, and scanning for "any tailnet-looking address anywhere in the
// list" would be satisfiable by an attacker who controls the list.
func forwardedForIsTailscale(v string) bool {
	first, _, _ := strings.Cut(v, ",")
	ip, err := netip.ParseAddr(strings.TrimSpace(first))
	if err != nil {
		return false
	}
	ip = ip.Unmap()
	return tailscaleV4.Contains(ip) || tailscaleV6.Contains(ip)
}

// sameOriginEvidence reports whether the browser itself vouched that r came from
// this console's own page.
//
// GET and HEAD do not need it: they change nothing, and a cross-site page cannot
// READ the reply — this listener sends no CORS headers at all, so the response
// never leaves the browser's network stack.
//
// Everything else needs one of two signals a cross-site page cannot forge:
//
//	Sec-Fetch-Site  set by the browser, unsettable by script. `same-origin` is
//	                the console's own fetch; `none` is a user-typed navigation.
//	Origin          present on every cross-origin write; if it is here it must
//	                be this host.
//
// Neither present means the caller is not a browser — `curl`, a script, a probe
// — and that caller is told to use the bearer token instead. That is a
// deliberate narrowing: making identity work for non-browsers would mean
// accepting a request with no same-origin evidence at all, which is exactly the
// forged POST this function exists to stop.
func sameOriginEvidence(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	case "":
		// Fall through to Origin: a browser older than Sec-Fetch-* still sends
		// Origin on a cross-site write, so the check below is not a gap.
	default:
		// same-site or cross-site. Both are somebody else's page.
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	// Host, not scheme: the console is reached over https through `serve` and
	// over http on loopback, and the same page is the same page either way.
	// r.Host is what the client asked for, and `serve` passes it through
	// unchanged (measured — X-Forwarded-Host and Host agree).
	return strings.EqualFold(u.Host, r.Host)
}

// identityKey types the context value so nothing else in the process can read
// or write it by accident.
type identityKey struct{}

func withIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, id)
}

// IdentityOf returns the Tailscale identity a request was authenticated with,
// and whether there was one. A request that presented the bearer token has none:
// the token says somebody holds the operator credential, not who they are, and
// inventing a name for them would put a fiction on the page.
func IdentityOf(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(Identity)
	return id, ok
}
