package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
)

func (h *harness) keyHistory(t *testing.T, token string) KeyHistoryResponse {
	t.Helper()
	w := h.req(http.MethodGet, "/api/v1/key-history", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/key-history = %d, body %s", w.Code, w.Body.String())
	}
	var out KeyHistoryResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// enrollSignedBy enrolls a SECOND device the way a second device is really
// enrolled: an already-enrolled key vouches for it. harness.writer self-signs,
// which only the bootstrap writer may do.
func (h *harness) enrollSignedBy(u uuid.UUID, id string, by ed25519.PrivateKey) ed25519.PrivateKey {
	h.t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		h.t.Fatal(err)
	}
	sig := ed25519.Sign(by, auth.RegistrationMessage(nonce, id, pub))
	if err := h.srv.Writers.Register(bg, u, id, pub, nonce, sig); err != nil {
		h.t.Fatalf("register writer %s: %v", id, err)
	}
	return priv
}

// revoke retires a writer through the real capability path, so the revocation
// entry under test is one the system actually produces.
func (h *harness) revoke(u uuid.UUID, id string, by ed25519.PrivateKey) {
	h.t.Helper()
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		h.t.Fatal(err)
	}
	sig := ed25519.Sign(by, auth.RevocationMessage(nonce, id))
	if err := h.srv.Writers.Revoke(bg, u, id, nonce, sig); err != nil {
		h.t.Fatalf("revoke %s: %v", id, err)
	}
}

// TestKeyHistoryIsServedToTheDeviceItDescribes is finding 1's acceptance test:
// the log spec §3.4 says a peer audits is now reachable by that peer.
func TestKeyHistoryIsServedToTheDeviceItDescribes(t *testing.T) {
	h := newHarness(t)
	u := h.user("sub-history")
	tok := h.session(u)

	// A brand-new account already has one entry: the server's own keyless
	// ingest writer. A peer that could not see it would read the first device
	// registration as the whole history.
	first := h.keyHistory(t, tok)
	if len(first.Entries) != 1 {
		t.Fatalf("a new account's key history has %d entries, want the ingest writer's: %+v",
			len(first.Entries), first.Entries)
	}
	if e := first.Entries[0]; e.WriterID != auth.IngestWriterID || e.Event != auth.EventRegistered || e.PubKey != "" {
		t.Fatalf("first entry = %+v, want the keyless ingest writer registered", e)
	}

	privA := h.writer(u, "dev-a")
	privB := h.enrollSignedBy(u, "dev-b", privA)

	got := h.keyHistory(t, tok)
	if len(got.Entries) != 3 {
		t.Fatalf("entries = %d, want 3: %+v", len(got.Entries), got.Entries)
	}
	// Oldest first, and the head is last: the ordering the comparison code
	// depends on.
	for i := 1; i < len(got.Entries); i++ {
		if got.Entries[i].ID <= got.Entries[i-1].ID {
			t.Fatalf("entries are not in ascending id order: %+v", got.Entries)
		}
		if got.Entries[i].At.Before(got.Entries[i-1].At) {
			t.Fatalf("entries are not in chronological order: %+v", got.Entries)
		}
	}
	if got.Entries[1].WriterID != "dev-a" || got.Entries[2].WriterID != "dev-b" {
		t.Fatalf("writer ids = %q, %q", got.Entries[1].WriterID, got.Entries[2].WriterID)
	}
	for _, e := range got.Entries[1:] {
		key, err := base64.StdEncoding.DecodeString(e.PubKey)
		if err != nil {
			t.Fatalf("entry %+v: pubkey is not base64: %v", e, err)
		}
		if len(key) != ed25519.PublicKeySize {
			t.Fatalf("entry %+v: pubkey is %d bytes", e, len(key))
		}
	}

	// A revocation is what a substitution would look like from a peer's side,
	// so it has to be visible too — and it has to move the head.
	headBefore := got.Entries[len(got.Entries)-1]
	h.revoke(u, "dev-a", privB)

	after := h.keyHistory(t, tok)
	if len(after.Entries) != 4 {
		t.Fatalf("after revocation, entries = %d, want 4: %+v", len(after.Entries), after.Entries)
	}
	head := after.Entries[len(after.Entries)-1]
	if head.WriterID != "dev-a" || head.Event != auth.EventRevoked {
		t.Fatalf("head = %+v, want dev-a revoked", head)
	}
	if head.ID == headBefore.ID {
		t.Fatal("the head did not move when a key was revoked")
	}
}

// TestKeyHistoryIsPerAccount: one user's log must never describe another's
// devices. It is the same table for everyone, and the WHERE clause is the only
// thing between them.
func TestKeyHistoryIsPerAccount(t *testing.T) {
	h := newHarness(t)
	mine, theirs := h.user("sub-mine"), h.user("sub-theirs")
	h.writer(theirs, "their-phone")

	got := h.keyHistory(t, h.session(mine))
	for _, e := range got.Entries {
		if e.WriterID == "their-phone" {
			t.Fatalf("another account's writer appeared in this log: %+v", got.Entries)
		}
	}
}

// TestKeyHistoryRequiresASession keeps the log behind the same gate as the
// roster it accompanies.
func TestKeyHistoryRequiresASession(t *testing.T) {
	h := newHarness(t)
	if w := h.req(http.MethodGet, "/api/v1/key-history", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET = %d, want 401", w.Code)
	}
	if w := h.req(http.MethodGet, "/api/v1/key-history", "not-a-token", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("bad-token GET = %d, want 401", w.Code)
	}
}
