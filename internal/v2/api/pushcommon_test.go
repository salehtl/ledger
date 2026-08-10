package api

import (
	"crypto/ed25519"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
)

// The device-enrolment fixtures the push subscription tests build on. They
// lived in push_test.go until the native push-token API was removed on
// 2026-08-10; webpush_test.go drives both, so they moved here rather than going
// with that file.

// enrolled returns u's FIRST device writer id, through the real capability
// path. Every push registration has to name one: a subscription that names no
// device is one no revocation can reach, which is the whole defect this closes.
func enrolled(t *testing.T, h *harness, u uuid.UUID, id string) string {
	t.Helper()
	h.writer(u, id)
	return id
}

// enrolledSecond adds another device to an account that already has one.
// Enrolment past the first REQUIRES an already-enrolled key to authorize it
// (spec §3.4), so a second browser cannot be planted with a self-signature —
// which is why these tests carry the first device's private key around.
func enrolledSecond(t *testing.T, h *harness, u uuid.UUID, id string, by ed25519.PrivateKey) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.srv.Writers.Register(bg, u, id, pub, nonce,
		ed25519.Sign(by, auth.RegistrationMessage(nonce, id, pub))); err != nil {
		t.Fatalf("register second writer %s: %v", id, err)
	}
	return id
}
