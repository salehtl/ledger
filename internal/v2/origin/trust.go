package origin

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"
)

// Allowlist scopes. These are the values stored in sender_allowlist.scope,
// whose migration ships with Task 27.
const (
	// ScopeInner trusts a bank behind a forwarder. It is honourable only for an
	// [Origin] whose Attested is true.
	ScopeInner = "inner"
	// ScopeOuter trusts a domain that signed the message as we received it.
	ScopeOuter = "outer"
)

// Allowlist reads the origins a user has confirmed from their quarantine lane.
//
// It is an interface so that this package — which sits on the inbound path and
// must stay testable offline — does not depend on a database, and so that the
// pipeline consumes one type whichever side implements it.
//
// The method name matches Task 27's *quarantine.Store.Allowlisted deliberately,
// so that store satisfies this interface with no adapter. That store's single
// query is the ONE read of sender_allowlist, and it must stay that way: the
// carry-over across an address rotation that spec section 3.2:46 promises is a
// property of the table being keyed by user, and a second query joining through
// inbound_addresses would quietly drop it.
type Allowlist interface {
	// Allowlisted reports whether (userID, domain, scope) is present. An error
	// is an error, never a false: see [Decide].
	Allowlisted(ctx context.Context, userID uuid.UUID, domain, scope string) (bool, error)
}

// Decision is the answer to "may this message take the trusted lane?".
type Decision struct {
	// Trusted is the answer. False means quarantine.
	Trusted bool
	// Domain and Scope name the allowlist entry that matched, or "" and "".
	Domain string
	Scope  string
	// Reason explains a refusal. Diagnostic text, never stored in a
	// closed-enum column.
	Reason string
}

// Decide applies a user's allowlist to a resolved origin.
//
// # The rule, and the bypass it exists to close
//
// Spec section 3.2: "The allowlist entry is the verified signing domain plus,
// for forwarded mail, the inner origin — trusting the bank, not merely the
// user's forwarder." Three properties carry that:
//
//  1. An unattested inner domain is never consulted. Without an attestation the
//     only available source for "which bank is behind this forward" is the
//     forwarded body's own From line, which is content, which anybody can
//     write.
//
//  2. An unverified outer domain is never consulted. Origin.Outer carries the
//     "unverified:" prefix precisely so an envelope claim cannot be compared
//     against an allowlist as though it were evidence, and the prefixed form is
//     not a hostname, so it can never accidentally equal a stored row.
//
//  3. A forwarder domain is never trusted as an OUTER origin, even if a row
//     says so. Task 27's API refuses to create that row; this refuses to honour
//     one, so a row that predates the check — or arrives by any other route —
//     is inert rather than a standing bypass. Allowlisting gmail.com as an
//     outer origin trusts every message anyone routes through the user's
//     mailbox, which is the exact failure section 3.2 forbids.
//
//  4. Every one of those is cross-checked against the SIGNATURE RESULTS, not
//     against the strings that were derived from them. Decide is exported, it
//     takes an Origin from any caller, and one of its three callers
//     (ingest.recordedOrigin) rebuilds that Origin out of a database row a
//     month later. Reading only Outer's prefix and the Attested bool made
//     "verified" a property of how the value was spelled: Origin{Outer:
//     "dib.ae"} with DKIM and ARC both none was trusted, and so was an
//     attestation labelled with a word this package does not define. The
//     verdicts are right there in the struct; refusing to look at them is what
//     turns them into decoration.
//
// The scopes are not interchangeable in either direction. An outer entry does
// not trust that domain as an inner origin, or "I trust what my bank sends me
// directly" would silently become "I trust anyone who forwards me something my
// bank signed once". That separation is only real because [Resolve] decides
// which scope a message lands in from signatures alone — see the note on
// [ResolveWithEnvelope] about the envelope choosing the scope.
//
// # Errors
//
// A store error is returned, not swallowed into a refusal — on BOTH queries.
// Both produce the quarantine lane, but only one of them is visible to an
// operator, and an outage that renders as "the user has confirmed nothing" is
// an outage nobody finds.
func Decide(ctx context.Context, list Allowlist, userID uuid.UUID, o Origin) (Decision, error) {
	if list == nil {
		// Fail CLOSED. Pipeline.check refuses to start without a Trust store, so
		// this is unreachable today; the safe default is the entire point of the
		// branch, and an unreachable branch that silently inverts is how a
		// missing dependency becomes "trust everything".
		return Decision{Reason: "no allowlist configured"}, nil
	}
	refuse := func(format string, args ...any) (Decision, error) {
		return Decision{Reason: sanitize(fmt.Sprintf(format, args...))}, nil
	}

	// The inner origin first: it is the more specific claim, and for forwarded
	// mail it is the only one that names the bank.
	var missedInner string
	switch {
	case !o.Attested || o.Inner == "":
		// Nothing attested; the outer origin is all there is.
	case !attestationRestsOnASignature(o):
		missedInner = fmt.Sprintf("inner origin %s claims to be attested by %q, which no passing "+
			"verification supports (dkim=%s, arc=%s)", o.Inner, o.AttestedBy, o.DKIM, o.ARC)
	default:
		ok, err := list.Allowlisted(ctx, userID, o.Inner, ScopeInner)
		if err != nil {
			return Decision{}, fmt.Errorf("origin: read allowlist: %w", err)
		}
		if ok {
			return Decision{Trusted: true, Domain: o.Inner, Scope: ScopeInner}, nil
		}
		missedInner = fmt.Sprintf("inner origin %s is attested (%s) but not on the allowlist",
			o.Inner, o.AttestedBy)
	}

	// Then the outer origin. Falling through rather than stopping at the inner
	// miss matters: the outer check grants nothing an unattested message with
	// the same Outer would not already get, so stopping here would leave an
	// ATTESTED message with strictly fewer rights than an unattested one —
	// which is backwards, and would break the user who allowlisted the relay
	// their mail legitimately arrives through.
	switch {
	case o.Outer == "":
		return refuse("nothing identifies the sender")
	case strings.HasPrefix(o.Outer, unverifiedPrefix):
		return refuse("%s; no signature verified, and %s is an envelope claim rather than evidence",
			or(missedInner, "nothing is attested"), o.Outer)
	case o.DKIM != SigPass && o.ARC != SigPass:
		// The unverified: prefix is how Resolve spells this, and the prefix is
		// checked above. This is the same question asked of the evidence
		// instead of the spelling, for the Origins that did not come from
		// Resolve — a hand-built struct, or one rebuilt from a diagnostics row.
		return refuse("%s; %s is named as the sender but neither DKIM nor ARC verified "+
			"(dkim=%s, arc=%s)", or(missedInner, "nothing is attested"), o.Outer, o.DKIM, o.ARC)
	case IsForwarderDomain(o.Outer):
		// Deliberately checked before the query: the answer cannot depend on
		// the row, so asking for it would be a database lookup any sender could
		// trigger, for a result that is already decided.
		return refuse("%s; %s is a forwarder, and trusting it as an outer origin would trust "+
			"everything relayed through it. Confirm the inner origin instead.",
			or(missedInner, "nothing is attested"), o.Outer)
	}

	ok, err := list.Allowlisted(ctx, userID, o.Outer, ScopeOuter)
	if err != nil {
		return Decision{}, fmt.Errorf("origin: read allowlist: %w", err)
	}
	if ok {
		return Decision{Trusted: true, Domain: o.Outer, Scope: ScopeOuter}, nil
	}
	return refuse("%s; verified sender %s is not on the allowlist either",
		or(missedInner, "nothing is attested"), o.Outer)
}

// attestationRestsOnASignature reports whether an Origin's attestation names a
// verification this package performs AND that verification passed.
//
// [Origin].AttestedBy is not a label: it says which of the two message-level
// verdicts the inner origin was derived from, so it is checkable against that
// verdict. A value this package does not define is refused outright rather than
// treated as "some other attestation" — there is no other kind, and an unknown
// word arriving here means a caller invented one.
func attestationRestsOnASignature(o Origin) bool {
	if !o.Attested {
		// Repeated from the caller on purpose: these are two independent
		// readings of "is this attested?", and either one alone closes the
		// hole, which is exactly the arrangement where one of them quietly
		// stops being reached.
		return false
	}
	switch o.AttestedBy {
	case AttestedByDKIM:
		return o.DKIM == SigPass
	case AttestedByARC:
		return o.ARC == SigPass
	default:
		return false
	}
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// ForwarderDomains are the domains a message may pass THROUGH. None of them may
// ever be trusted as an outer origin (spec section 3.2:51), because doing so
// trusts everything anyone relays through the user's mailbox.
//
// It is a superset of the list Task 27's brief names, and the additions are not
// cosmetic. The brief lists the domains users have MAILBOXES at — gmail.com,
// icloud.com — but Origin.Outer holds the domain that SIGNED or SEALED the
// message, and Google seals as google.com, Microsoft as microsoft.com, Apple as
// icloud.com. A list of mailbox domains would therefore have refused
// "gmail.com" while cheerfully accepting "google.com", which is the same
// bypass with a different spelling. Task 27 should consume this list rather
// than declare its own; TestTheTwoListsAreDistinctAndNonEmpty holds the two in
// the right relation.
//
// Matching is PERMISSIVE — a subdomain counts. Over-inclusion costs a user one
// refused outer entry and nothing else; under-inclusion is the bypass.
var ForwarderDomains = []string{
	"apple.com",
	"fastmail.com",
	"gmail.com",
	"google.com",
	"googlemail.com",
	"hotmail.com",
	"icloud.com",
	"live.com",
	"mac.com",
	"me.com",
	"messagingengine.com",
	"microsoft.com",
	"outlook.com",
	"proton.me",
	"protonmail.ch",
	"protonmail.com",
	"yahoo.com",
	"zoho.com",
}

// IsForwarderDomain reports whether d is, or is under, a known forwarder.
func IsForwarderDomain(d string) bool {
	d = normalizeDomain(d)
	if d == "" {
		return false
	}
	for _, f := range ForwarderDomains {
		if d == f || strings.HasSuffix(d, "."+f) {
			return true
		}
	}
	return false
}

// TrustedSealers are the domains whose ARC-Authentication-Results this receiver
// is willing to believe.
//
// RFC 8617 section 8.1 makes this a local decision and nothing else: a chain is
// cryptographically valid regardless of who sealed it, so "pass" says the chain
// was not tampered with, never that the sealer was honest. A chain an attacker
// seals with their own key passes. This list is what turns "the chain is
// intact" into "the first hop's report is worth reading" — and because any hop
// may rewrite the body under its own ARC-Message-Signature, EVERY seal domain
// in a chain must be on it, not just the first.
//
// Matching is EXACT — no subdomains, and no automatic promotion of anything on
// [ForwarderDomains]. This list runs the opposite way round from that one: a
// name wrongly present here can attest any bank it likes, so under-inclusion is
// the safe error. The cost of a missing sealer is one forwarder falling back to
// the direct-DKIM path, which is the load-bearing path anyway
// (docs/superpowers/specs/v2-arc-spike.md, "Which path is load-bearing").
//
// # What an entry must be evidenced for, and what it must not
//
// The question an entry answers is "who can seal under this name?", and that
// has a hard answer: only whoever holds a key published under the domain's own
// DNS. So an entry is safe when the domain is provably the provider's own
// infrastructure — never registrable, never delegable to a customer — and it is
// DANGEROUS in exactly one way: a sealer whose ARC-Authentication-Results is
// copied from the inbound message rather than written from its own verification
// hands an attestation to anyone with an account there. That is not
// hypothetical; Wang & Wang (WWW '22, "Revisiting Email Forwarding Security
// under the Authenticated Received Chain Protocol") measured a provider that
// honours an unauthenticated party's ARC chain, so "reputable" is not the test
// and is never the reason an entry is here.
//
// Being unsure costs a provider nothing catastrophic — see
// TestAForwarderWeCannotBelieveStillLeavesTheBankConfirmable: a forward that
// leaves the bank's own signature verifiable does not need this list at all,
// because Outer is then the bank and the bank is confirmable at the outer
// scope. This list is what rescues the forwards whose inner signature did NOT
// survive, and only those.
//
// # The evidence, per entry
//
//   - google.com, icloud.com, microsoft.com — the only sealers observed across
//     the 1,222 chains in the v1 corpus, and all 1,222 verify. icloud.com seals
//     as s=arc-0513 under the authserv-id arc.icloud.com and google.com as
//     s=arc-20260327, both readable in origin/testdata/gmail-forward-*.eml;
//     microsoft.com as s=arcselector10001 in enbd-selector1.eml.
//
//   - messagingengine.com — Fastmail, added by this round. The corpus holds NO
//     Fastmail sample (it is one operator's mailbox, and that operator is on
//     iCloud), so the evidence is external and is recorded here rather than
//     assumed: Fastmail's own documentation states "we seal messages with ARC"
//     and "all outbound mail is DKIM signed with a messagingengine.com key";
//     the WWW '22 measurement above names Fastmail among the providers that
//     have adopted ARC; and a real Fastmail ARC set reads
//     "ARC-Seal: i=1; a=rsa-sha256; cv=none; d=messagingengine.com; s=fm3"
//     over "ARC-Authentication-Results: i=1; mx6.messagingengine.com; ...".
//     DNS confirms sole Fastmail control: fm3._domainkey.messagingengine.com is
//     a live key in Fastmail's fmhosted.com infrastructure, and
//     messagingengine.com and fastmail.com share nameservers, MX and DMARC rua.
//     Fastmail's ARC implementation is its own open-source authentication
//     milter, which computes the results it seals.
//
// # Deliberately NOT here, and why that is not a locked door
//
// proton.me, protonmail.ch and yahoo.com. No evidence could be found that
// either provider seals anything: Proton's own ARC writing describes Proton as
// a VALIDATOR ("we currently only accept messages that fail DMARC for a limited
// set of parties that we trust to implement ARC correctly") and never as a
// sealer, neither appears in the WWW '22 adopter list, and a public-code search
// for an ARC-Seal bearing d=protonmail.ch or a Yahoo cv= seal returns nothing
// while d=yahoo.com appears only as header.d inside somebody ELSE's report.
// Naming them here would be inert at best and, if either turned out to seal the
// way that paper's outlier does, a bank identity available to anyone with an
// account. Their users are covered by the outer scope instead, which needs no
// trust in the forwarder at all. zoho.com and pobox.com are ARC adopters per
// that same paper and are likewise absent: pobox.com for want of a verified
// sealing domain, zoho.com because it is the outlier the paper measured.
var TrustedSealers = []string{
	"google.com",
	"icloud.com",
	"messagingengine.com",
	"microsoft.com",
}

// IsTrustedSealer reports whether an ARC-Seal domain is one this receiver
// believes. Exact match; see [TrustedSealers].
func IsTrustedSealer(d string) bool {
	return slices.Contains(TrustedSealers, normalizeDomain(d))
}
