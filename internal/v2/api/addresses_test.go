package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/addresses"
)

const apiSuffix = "@in.example.test"

// addrHarness extends the shared harness with an Addresses store. It builds its
// own handler rather than reusing newHarness's, because the routes are only
// mounted once Server.Addresses is set.
type addrHarness struct {
	*harness
	addr *addresses.Addresses
	now  time.Time
}

func newAddrHarness(t *testing.T) *addrHarness {
	t.Helper()
	h := newHarness(t)
	ah := &addrHarness{harness: h, now: time.Now().UTC().Truncate(time.Microsecond)}
	ah.addr = &addresses.Addresses{
		Pool:   h.pool,
		Suffix: apiSuffix,
		Grace:  addresses.DefaultGrace,
		Now:    func() time.Time { return ah.now },
	}
	h.srv.Addresses = ah.addr
	h.h = h.srv.Handler()
	return ah
}

// signedIn returns a user with a live session, an enrolled device key, and an
// ID token that re-verifies to the SAME account — everything the rotation
// endpoint demands, so each test can remove exactly one of them.
func (h *addrHarness) signedIn(t *testing.T, sub string) (uuid.UUID, string, ed25519.PrivateKey, string) {
	t.Helper()
	// The fake verifier maps id_token X to subject "sub-X", so the account must
	// be created under that subject for the re-auth to name the same user.
	u := h.user("sub-" + sub)
	return u, h.session(u), h.writer(u, "phone"), sub
}

func (h *addrHarness) rotationNonce(t *testing.T, session string) []byte {
	t.Helper()
	rec := h.req(http.MethodPost, "/api/v1/address/challenge", session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("challenge: %d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ChallengeResponse](t, rec)
	nonce, err := base64.StdEncoding.DecodeString(out.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	return nonce
}

func (h *addrHarness) currentAddress(t *testing.T, session string) AddressResponse {
	t.Helper()
	rec := h.req(http.MethodGet, "/api/v1/address", session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/address: %d %s", rec.Code, rec.Body.String())
	}
	return decodeJSON[AddressResponse](t, rec)
}

// ---------------------------------------------------------------------------

func TestGetAddressIssuesOnFirstReadAndIsStableAfterwards(t *testing.T) {
	h := newAddrHarness(t)
	u, session, _, _ := h.signedIn(t, "alice")

	first := h.currentAddress(t, session)
	if !strings.HasSuffix(first.Address, apiSuffix) {
		t.Fatalf("address %q does not end in the configured suffix", first.Address)
	}
	if first.RotatesFrom != "" || first.GraceUntil != nil {
		t.Fatalf("a never-rotated account must report no predecessor: %+v", first)
	}
	if second := h.currentAddress(t, session); second.Address != first.Address {
		t.Fatalf("a second read minted a different address: %q then %q", first.Address, second.Address)
	}
	got, grace, err := h.addr.Resolve(bg, first.Address)
	if err != nil || got != u || grace {
		t.Fatalf("the returned address must route to the caller: (%s,%v,%v)", got, grace, err)
	}
}

func TestAddressEndpointsRequireASession(t *testing.T) {
	h := newAddrHarness(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/address"},
		{http.MethodPost, "/api/v1/address/challenge"},
		{http.MethodPost, "/api/v1/address/rotate"},
	} {
		rec := h.req(tc.method, tc.path, "", nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a session: %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

// TestRotationRequiresAWriterSignature is spec §3.4's capability rule at the
// HTTP boundary: a session token is a weak capability and must not, on its own,
// be able to retire the address the user's bank forwards mail to. Losing that
// address silently is a total ingest outage for the account.
func TestRotationRequiresAWriterSignature(t *testing.T) {
	h := newAddrHarness(t)
	_, session, priv, idToken := h.signedIn(t, "alice")
	before := h.currentAddress(t, session)

	t.Run("a session alone is refused", func(t *testing.T) {
		rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
			IdP: "apple", IDToken: idToken,
		})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("got %d %s, want 403", rec.Code, rec.Body.String())
		}
	})

	t.Run("a signature from an unenrolled key is refused", func(t *testing.T) {
		nonce := h.rotationNonce(t, session)
		_, stranger, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		local := strings.TrimSuffix(before.Address, apiSuffix)
		sig := ed25519.Sign(stranger, addresses.RotationMessage(nonce, h.user("sub-alice"), local))
		rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
			IdP: "apple", IDToken: idToken,
			Nonce: base64.StdEncoding.EncodeToString(nonce),
			Sig:   base64.StdEncoding.EncodeToString(sig),
		})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("got %d %s, want 403", rec.Code, rec.Body.String())
		}
	})

	if after := h.currentAddress(t, session); after.Address != before.Address {
		t.Fatalf("a refused rotation still changed the address: %q -> %q", before.Address, after.Address)
	}
	_ = priv
}

// TestRotationRequiresFreshIdPReauthentication is the other half of §3.4:
// "address rotation requires fresh IdP re-authentication PLUS an on-device
// confirmation backed by key possession". A device that is unlocked but whose
// owner has not just proved who they are must not be able to rotate.
func TestRotationRequiresFreshIdPReauthentication(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, _ := h.signedIn(t, "alice")
	before := h.currentAddress(t, session)
	local := strings.TrimSuffix(before.Address, apiSuffix)

	sign := func() (string, string) {
		nonce := h.rotationNonce(t, session)
		sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
		return base64.StdEncoding.EncodeToString(nonce), base64.StdEncoding.EncodeToString(sig)
	}

	t.Run("no id token", func(t *testing.T) {
		nonce, sig := sign()
		rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
			IdP: "apple", Nonce: nonce, Sig: sig,
		})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("got %d %s, want 400", rec.Code, rec.Body.String())
		}
	})

	t.Run("a token for a different account", func(t *testing.T) {
		nonce, sig := sign()
		rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
			IdP: "apple", IDToken: "mallory", Nonce: nonce, Sig: sig,
		})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("a token naming another subject must not authorize this account's rotation: %d %s",
				rec.Code, rec.Body.String())
		}
	})

	if after := h.currentAddress(t, session); after.Address != before.Address {
		t.Fatalf("a refused rotation still changed the address: %q -> %q", before.Address, after.Address)
	}
}

func TestRotateMintsANewAddressAndReportsTheGraceDeadline(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, idToken := h.signedIn(t, "alice")
	before := h.currentAddress(t, session)
	local := strings.TrimSuffix(before.Address, apiSuffix)

	nonce := h.rotationNonce(t, session)
	sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
	rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
		IdP: "apple", IDToken: idToken,
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig:   base64.StdEncoding.EncodeToString(sig),
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[AddressResponse](t, rec)

	if out.Address == before.Address {
		t.Fatal("rotation returned the same address")
	}
	if out.RotatesFrom != before.Address {
		t.Fatalf("RotatesFrom = %q, want the retired address %q", out.RotatesFrom, before.Address)
	}
	if out.GraceUntil == nil {
		t.Fatal("the response must carry the deadline after which the old address stops accepting")
	}
	if want := h.now.Add(addresses.DefaultGrace); !out.GraceUntil.Equal(want) {
		t.Fatalf("GraceUntil = %s, want %s", out.GraceUntil, want)
	}
	// GET now reports the same thing, so a client that reloads sees the
	// countdown rather than losing it.
	again := h.currentAddress(t, session)
	if again.Address != out.Address || again.RotatesFrom != out.RotatesFrom {
		t.Fatalf("GET disagrees with the rotate response: %+v vs %+v", again, out)
	}
	// Both addresses accept mail until the deadline passes.
	for _, addr := range []string{before.Address, out.Address} {
		if got, _, err := h.addr.Resolve(bg, addr); err != nil || got != u {
			t.Fatalf("%q must still resolve during grace: %v", addr, err)
		}
	}
	h.now = out.GraceUntil.Add(time.Second)
	if _, _, err := h.addr.Resolve(bg, before.Address); err == nil {
		t.Fatal("the old address must stop accepting once the grace window closes")
	}
	// And the lapsed predecessor drops out of the response rather than being
	// shown to the user as if it still worked.
	if lapsed := h.currentAddress(t, session); lapsed.RotatesFrom != "" || lapsed.GraceUntil != nil {
		t.Fatalf("a lapsed predecessor is still advertised: %+v", lapsed)
	}
}

func TestRotateRefusesAReplayedChallenge(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, idToken := h.signedIn(t, "alice")
	before := h.currentAddress(t, session)
	local := strings.TrimSuffix(before.Address, apiSuffix)

	nonce := h.rotationNonce(t, session)
	body := RotateRequest{
		IdP: "apple", IDToken: idToken,
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig: base64.StdEncoding.EncodeToString(
			ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))),
	}
	if rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, body); rec.Code != http.StatusOK {
		t.Fatalf("first rotate: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, body); rec.Code != http.StatusForbidden {
		t.Fatalf("replayed rotate: %d %s, want 403", rec.Code, rec.Body.String())
	}
}

// TestEveryRotationRefusalLooksTheSame keeps the 403 from becoming an oracle
// about which half of the capability check failed, or about whether a nonce or
// a writer exists.
func TestEveryRotationRefusalLooksTheSame(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, idToken := h.signedIn(t, "alice")
	before := h.currentAddress(t, session)
	local := strings.TrimSuffix(before.Address, apiSuffix)
	good := h.rotationNonce(t, session)
	goodSig := base64.StdEncoding.EncodeToString(
		ed25519.Sign(priv, addresses.RotationMessage(good, u, local)))
	b64 := base64.StdEncoding.EncodeToString

	unknownNonce := make([]byte, addresses.ChallengeNonceBytes)
	for i := range unknownNonce {
		unknownNonce[i] = 0xAB
	}
	_, stranger, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	bodies := map[string]RotateRequest{
		"unknown nonce": {IdP: "apple", IDToken: idToken, Nonce: b64(unknownNonce), Sig: goodSig},
		"zero signature": {IdP: "apple", IDToken: idToken, Nonce: b64(good),
			Sig: b64(make([]byte, ed25519.SignatureSize))},
		"unenrolled key": {IdP: "apple", IDToken: idToken, Nonce: b64(good),
			Sig: b64(ed25519.Sign(stranger, addresses.RotationMessage(good, u, local)))},
		"wrong account's token": {IdP: "apple", IDToken: "mallory", Nonce: b64(good), Sig: goodSig},
		"signature over another address": {IdP: "apple", IDToken: idToken, Nonce: b64(good),
			Sig: b64(ed25519.Sign(priv, addresses.RotationMessage(good, u, "u-bbbbbbbbbbbbbbbbbbbbbbbbbb")))},
	}
	var seen []string
	for name, body := range bodies {
		rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, body)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s: %d %s, want 403", name, rec.Code, rec.Body.String())
		}
		seen = append(seen, rec.Body.String())
	}
	for i, got := range seen {
		if got != seen[0] {
			t.Fatalf("rejection %d reads %q but the first reads %q", i, got, seen[0])
		}
	}
	if strings.Contains(seen[0], "nonce") || strings.Contains(seen[0], "key") ||
		strings.Contains(seen[0], "signature") || strings.Contains(seen[0], "token") {
		t.Fatalf("the rejection body names the failing check: %q", seen[0])
	}
}

func TestAddressRoutesAreRateLimitedPerUser(t *testing.T) {
	h := newAddrHarness(t)
	_, session, _, _ := h.signedIn(t, "alice")
	// A limiter with no refill: the burst is the whole budget.
	h.srv.AddressPerUser = NewLimiter(0, 2, 16, func() time.Time { return h.now })
	h.h = h.srv.Handler()

	var got429 bool
	for i := 0; i < 8; i++ {
		rec := h.req(http.MethodPost, "/api/v1/address/challenge", session, nil)
		if rec.Code == http.StatusTooManyRequests {
			got429 = true
			break
		}
	}
	if !got429 {
		t.Fatal("minting rotation challenges is unbounded: one session can fill the table")
	}
}
