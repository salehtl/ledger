package config

// admin_bind.go is spec §3.1's one-line rule — "admin stays tailnet-only" —
// written as code.
//
// # Why the BINDING is the control and the token is not
//
// The admin console publishes templates that every device executes, approves
// merchant mappings that ship to every device, and reads diagnostics across all
// users. A static bearer token defends that surface exactly as well as the
// token is kept, which is to say: against an accident, not against an attacker
// who has one. What actually keeps the console out of reach is that there is no
// route from the internet to the socket at all.
//
// So this refusal is deliberately not "warn and continue". A console that comes
// up on 0.0.0.0 because someone was debugging is indistinguishable, from the
// outside, from a console deliberately exposed — and the operator has no signal
// that the difference stopped mattering.
//
// # Why loopback OR 100.64.0.0/10, and nothing else
//
// Tailscale assigns every node an address in 100.64.0.0/10 (the CGNAT range,
// RFC 6598) and binds it to the `tailscale0` interface. A process bound to that
// address is reachable from the tailnet and from nowhere else: the range is not
// routable on the public internet, and no other interface on this box carries
// one. Loopback is the strictly narrower case — reachable only from the box
// itself, which is how `ledgerd serve` runs in development and how the operator
// reaches it over SSH.
//
// Everything else is refused, including RFC1918. A LAN is not a tailnet: it has
// other hosts on it, and the whole point of the posture is that the set of
// principals who can reach this socket is the set of devices the operator
// enrolled.
//
// # The v6 case, stated rather than assumed
//
// Tailscale also assigns a fd7a:115c:a1e0::/48 ULA address. It is NOT accepted
// here, because that prefix is Tailscale's by convention rather than by a
// registry allocation — the ULA space it lives in (fc00::/7) is
// locally-assigned and any host may use it, so accepting the /48 would accept
// whatever else happened to be numbered from it. `tailscale ip -4` is what the
// deploy uses, and ::1 covers the development case.

import (
	"fmt"
	"net"
	"net/netip"
)

// tailnetV4 is Tailscale's CGNAT allocation. Written as a parsed prefix rather
// than a mask-and-compare so the boundary cases (100.63.255.255 below,
// 100.128.0.0 above) are decided by the standard library and not by arithmetic
// this file would have to get right.
var tailnetV4 = netip.MustParsePrefix("100.64.0.0/10")

// CheckAdminBind reports whether addr is an address the admin console may bind.
//
// It returns an error rather than a bool because the error IS the feature: the
// operator who set this to ":8079" needs to be told which rule they hit and
// what the two acceptable shapes are, at startup, in the log they are already
// reading.
//
// It is called from two places on purpose. [Config.validate] refuses at load,
// so no deployment configured this way ever starts; cmd/ledgerd's runServe
// calls it again immediately before net.Listen, so a Config assembled in code
// rather than through Load — which every test does, and which a future
// subcommand might — cannot slip past. The check is pure and costs a parse.
func CheckAdminBind(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return adminBindError(addr, "it is not a host:port address, so there is no host to check")
	}
	if host == "" {
		// The idiomatic Go listen address, and the wrong answer here: an empty
		// host binds EVERY interface, including the public one. This is the case
		// the whole function exists for, so it gets its own sentence.
		return adminBindError(addr,
			"an empty host binds every interface, including the public one")
	}
	// "localhost" is resolved by the resolver rather than by us, exactly as
	// isLoopbackListen does it. Same rule in both places, by construction.
	if isLoopbackListen(addr) {
		return nil
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return adminBindError(addr,
			"the host is neither \"localhost\" nor an IP literal, so what it resolves to is not knowable here")
	}
	if tailnetV4.Contains(ip.Unmap()) {
		return nil
	}
	return adminBindError(addr, "it is neither loopback nor a Tailscale address")
}

func adminBindError(addr, why string) error {
	return fmt.Errorf(
		"refusing to bind server.admin_listen to %q: %s. The admin console publishes templates "+
			"and merchant mappings to every device in the beta and reads diagnostics across all "+
			"users, and spec §3.1 keeps it tailnet-only — the BINDING is the control, not the "+
			"bearer token. Use a loopback address (the default, 127.0.0.1:8079) or this node's "+
			"Tailscale address from 100.64.0.0/10 (`tailscale ip -4`)",
		addr, why)
}
