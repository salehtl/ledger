package origin

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// fakeAllowlist stands in for Task 27's sender_allowlist table. The rows it
// holds are exactly what a user confirmed from the quarantine lane.
type fakeAllowlist struct {
	rows map[string]bool // "<user>|<domain>|<scope>"
	err  error
	asks []string
}

func allow(entries ...string) *fakeAllowlist {
	f := &fakeAllowlist{rows: map[string]bool{}}
	for _, e := range entries {
		f.rows[testUser.String()+"|"+e] = true
	}
	return f
}

func (f *fakeAllowlist) Allowlisted(_ context.Context, u uuid.UUID, domain, scope string) (bool, error) {
	f.asks = append(f.asks, domain+"|"+scope)
	if f.err != nil {
		return false, f.err
	}
	return f.rows[u.String()+"|"+domain+"|"+scope], nil
}

var testUser = uuid.MustParse("11111111-2222-3333-4444-555555555555")

func decide(t *testing.T, list Allowlist, o Origin) Decision {
	t.Helper()
	d, err := Decide(context.Background(), list, testUser, o)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// The whole point of spec 3.2:51: the entry names the bank, and it is honoured
// only because an attestation proved the bank signed this message.
func TestAttestedInnerOriginIsTrustedByAnInnerEntry(t *testing.T) {
	o := Origin{Outer: "google.com", Inner: "dib.ae", InnerFrom: "alerts@dib.ae",
		Attested: true, AttestedBy: AttestedByDKIM, DKIM: SigPass, ARC: SigPass}
	got := decide(t, allow("dib.ae|inner"), o)
	if !got.Trusted || got.Domain != "dib.ae" || got.Scope != ScopeInner {
		t.Fatalf("%+v", got)
	}
}

// The bypass §3.2:51 forbids, expressed as a database row rather than an API
// call: even with gmail.com sitting in sender_allowlist as an outer origin,
// nothing forwarded through gmail may become trusted. Task 27's API refuses to
// create the row; this refuses to honour one, so a row that predates the check
// (or arrives by any other route) is still inert.
func TestForwarderDomainIsNeverTrustedAsAnOuterOrigin(t *testing.T) {
	for _, d := range []string{"gmail.com", "icloud.com", "mail.gmail.com"} {
		t.Run(d, func(t *testing.T) {
			o := Origin{Outer: d, DKIM: SigPass}
			got := decide(t, allow(d+"|outer"), o)
			if got.Trusted {
				t.Fatalf("allowlisting a forwarder as an outer origin trusts everything it relays: %+v", got)
			}
			if got.Reason == "" {
				t.Fatal("a refusal must say why")
			}
		})
	}
}

// A forwarder domain is refused as an OUTER origin and only as an outer one.
// The inner scope is how a user trusts their bank behind that same forwarder,
// and confusing the two rules would break every forwarded message.
func TestForwarderRefusalDoesNotReachTheInnerScope(t *testing.T) {
	o := Origin{Outer: "google.com", Inner: "dib.ae", Attested: true,
		AttestedBy: AttestedByARC, DKIM: SigFail, ARC: SigPass}
	if got := decide(t, allow("dib.ae|inner"), o); !got.Trusted {
		t.Fatalf("%+v", got)
	}
}

func TestUnattestedInnerDomainIsNeverTrusted(t *testing.T) {
	// The shape a bug would produce: a domain in Inner with Attested false.
	// Decide must not take the field's word for it.
	o := Origin{Outer: "unverified:icloud.com", Inner: "dib.ae", DKIM: SigNone, ARC: SigNone}
	if got := decide(t, allow("dib.ae|inner"), o); got.Trusted {
		t.Fatalf("an unattested inner origin is body text with extra steps: %+v", got)
	}
}

func TestUnverifiedOuterIsNeverTrusted(t *testing.T) {
	o := Origin{Outer: "unverified:dib.ae", DKIM: SigNone, ARC: SigNone}
	got := decide(t, allow("dib.ae|outer", "unverified:dib.ae|outer"), o)
	if got.Trusted {
		t.Fatalf("an envelope claim is not a signature: %+v", got)
	}
}

func TestVerifiedOuterWithAnEntryIsTrusted(t *testing.T) {
	o := Origin{Outer: "dib.ae", DKIM: SigPass}
	got := decide(t, allow("dib.ae|outer"), o)
	if !got.Trusted || got.Domain != "dib.ae" || got.Scope != ScopeOuter {
		t.Fatalf("%+v", got)
	}
}

// Scopes are not interchangeable. An outer entry for a domain must not trust
// that domain when it appears as an inner origin, or "I trust mail my bank
// sends me directly" would silently become "I trust anyone who forwards me
// something my bank signed at some point".
func TestScopesAreNotInterchangeable(t *testing.T) {
	inner := Origin{Outer: "google.com", Inner: "dib.ae", Attested: true,
		AttestedBy: AttestedByDKIM, DKIM: SigPass}
	if got := decide(t, allow("dib.ae|outer"), inner); got.Trusted {
		t.Fatalf("an outer entry trusted an inner origin: %+v", got)
	}
	outer := Origin{Outer: "dib.ae", DKIM: SigPass}
	if got := decide(t, allow("dib.ae|inner"), outer); got.Trusted {
		t.Fatalf("an inner entry trusted an outer origin: %+v", got)
	}
}

// An attestation must never LOSE a message rights it would have had without
// one. A user whose mail legitimately arrives through a relay they allowlisted
// as an outer origin keeps that lane when the relay happens to leave the bank's
// signature intact, rather than being told to confirm a second time.
func TestAnOuterEntryStillAppliesToAnAttestedMessage(t *testing.T) {
	o := Origin{Outer: "relay.example", Inner: "dib.ae", Attested: true,
		AttestedBy: AttestedByDKIM, DKIM: SigPass}
	list := allow("relay.example|outer")
	got := decide(t, list, o)
	if !got.Trusted || got.Domain != "relay.example" || got.Scope != ScopeOuter {
		t.Fatalf("%+v", got)
	}
	// ...and it asked about the inner origin first, because that is the more
	// specific claim and the one a user is meant to confirm.
	if len(list.asks) != 2 || list.asks[0] != "dib.ae|inner" {
		t.Fatalf("asks = %v", list.asks)
	}
}

// A refusal that mentions only the outer origin hides the fact that a bank WAS
// identified and simply is not confirmed — which is the one thing the user has
// to act on.
func TestARefusalNamesBothTheAttestedInnerOriginAndTheOuter(t *testing.T) {
	o := Origin{Outer: "google.com", Inner: "dib.ae", Attested: true,
		AttestedBy: AttestedByARC, DKIM: SigFail, ARC: SigPass}
	got := decide(t, allow(), o)
	if got.Trusted {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(got.Reason, "dib.ae") || !strings.Contains(got.Reason, "google.com") {
		t.Fatalf("Reason = %q", got.Reason)
	}
}

// Decision.Reason reaches logs, and Decide is callable with an Origin some
// future caller built by hand, so it gets the same treatment as every other
// string this package derives from a message.
func TestDecisionReasonIsBoundedAndPrintable(t *testing.T) {
	o := Origin{Outer: "evil\x01" + strings.Repeat("a", 5000) + ".test", DKIM: SigPass}
	got := decide(t, allow(), o)
	if got.Trusted {
		t.Fatalf("%+v", got)
	}
	if len(got.Reason) > maxErrBytes || strings.ContainsRune(got.Reason, '\x01') {
		t.Fatalf("Reason is %d bytes: %q", len(got.Reason), got.Reason)
	}
}

func TestNoEntryIsNotTrustedAndSaysSo(t *testing.T) {
	o := Origin{Outer: "dib.ae", DKIM: SigPass}
	got := decide(t, allow(), o)
	if got.Trusted || got.Reason == "" {
		t.Fatalf("%+v", got)
	}
}

// A database error is not a "no". Swallowing it would make an outage look like
// a user who has not confirmed anything — which is the same lane, but for a
// reason the operator can never see.
func TestAllowlistErrorIsReturnedNotSwallowed(t *testing.T) {
	boom := errors.New("connection refused")
	list := &fakeAllowlist{rows: map[string]bool{}, err: boom}
	_, err := Decide(context.Background(), list, testUser, Origin{Outer: "dib.ae", DKIM: SigPass})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the store's error", err)
	}
}

// An origin with nothing verified must not cost a query at all: the answer
// cannot depend on the row, so asking for it is a lookup an attacker can
// trigger for free.
func TestUntrustworthyOriginIsRefusedWithoutQueryingTheAllowlist(t *testing.T) {
	list := allow("dib.ae|inner", "dib.ae|outer")
	o := Origin{Outer: "unverified:dib.ae", DKIM: SigNone, ARC: SigNone}
	if got := decide(t, list, o); got.Trusted {
		t.Fatalf("%+v", got)
	}
	if len(list.asks) != 0 {
		t.Fatalf("queried the allowlist %v for an origin nothing verified", list.asks)
	}
}

func TestEmptyOriginIsNotTrusted(t *testing.T) {
	if got := decide(t, allow("|inner", "|outer"), Origin{}); got.Trusted {
		t.Fatalf("%+v", got)
	}
}

// ---------------------------------------------------------------------------
// the two closed lists
// ---------------------------------------------------------------------------

// The forwarder list is matched PERMISSIVELY — a subdomain counts — because
// being over-inclusive there only costs a user one refused outer entry, while
// being under-inclusive hands over the bypass.
func TestForwarderMatchingIsPermissive(t *testing.T) {
	for _, d := range []string{
		"gmail.com", "GMAIL.COM", "googlemail.com", "icloud.com", "me.com", "mac.com",
		"outlook.com", "hotmail.com", "live.com", "yahoo.com", "proton.me",
		"protonmail.com", "zoho.com", "fastmail.com", "mail.gmail.com",
	} {
		if !IsForwarderDomain(d) {
			t.Errorf("IsForwarderDomain(%q) = false", d)
		}
	}
	for _, d := range []string{"dib.ae", "emiratesnbd.com", "", "gmail.com.evil.test", "notgmail.com"} {
		if IsForwarderDomain(d) {
			t.Errorf("IsForwarderDomain(%q) = true", d)
		}
	}
}

// The sealer list is matched STRICTLY — exact, no subdomains — because it runs
// the other way round: a name wrongly on it can attest any bank it likes.
func TestSealerTrustIsExactMatch(t *testing.T) {
	for _, d := range []string{"google.com", "icloud.com", "microsoft.com", "GOOGLE.COM"} {
		if !IsTrustedSealer(d) {
			t.Errorf("IsTrustedSealer(%q) = false", d)
		}
	}
	for _, d := range []string{"evil.test", "", "google.com.evil.test", "arc.icloud.com", "mx.google.com"} {
		if IsTrustedSealer(d) {
			t.Errorf("IsTrustedSealer(%q) = true", d)
		}
	}
}

// Two lists, two jobs, and they must not be quietly merged. Every forwarder we
// know how to seal for is a forwarder; not every forwarder seals.
func TestTheTwoListsAreDistinctAndNonEmpty(t *testing.T) {
	if len(ForwarderDomains) == 0 || len(TrustedSealers) == 0 {
		t.Fatal("a closed list that is empty is not a closed list")
	}
	for _, s := range TrustedSealers {
		if !IsForwarderDomain(s) {
			t.Errorf("%q seals ARC chains but is not treated as a forwarder; a user could "+
				"allowlist it as an outer origin and trust everything it relays", s)
		}
	}
}
