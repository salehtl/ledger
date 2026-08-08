package api

// keys_test.go covers GET/PUT /api/v1/keys — the account's published X25519
// ingest public key and the blob that wraps its private key material under the
// user's recovery phrase.
//
// The properties that matter are not "it round-trips". They are: the blob is
// scoped to the caller's own account and to nothing else, and a second
// publication with DIFFERENT bytes is refused. That second one is the one with
// teeth: every blob ever sealed to a published ingest key becomes unreadable
// the moment a different key set replaces it, and Phase 3 has no re-sealing
// story that would survive it happening by accident.

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"testing"
)

// A well-formed wrapped blob, in the envelope client/src/crypto/keys.ts writes:
// 36 header bytes + 65 body + 16 tag. The server never parses it; the length is
// what the CHECK constraint cares about.
func wrappedBlob(fill byte) []byte {
	b := make([]byte, 36+65+16)
	for i := range b {
		b[i] = fill
	}
	b[0] = 1 // envelope version
	b[1] = 1 // argon2id
	return b
}

func pubkey(fill byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = fill
	}
	return b
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestKeysRequireASession(t *testing.T) {
	h := newHarness(t)
	if rec := h.req(http.MethodGet, "/api/v1/keys", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET = %d, want 401", rec.Code)
	}
	body := map[string]any{"ingest_pubkey": b64(pubkey(1)), "wrapped_keys": b64(wrappedBlob(2)), "key_version": 1}
	if rec := h.req(http.MethodPut, "/api/v1/keys", "", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated PUT = %d, want 401", rec.Code)
	}
	if rec := h.req(http.MethodPut, "/api/v1/keys", "not-a-session", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bogus token PUT = %d, want 401", rec.Code)
	}
}

// An account with no keys is a REAL state, not an error: every account created
// before Phase 3 is in it, and Task 2 keeps those accounts working in plaintext.
// So the answer has to be one a client can branch on.
func TestKeysAreAbsentUntilPublished(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	rec := h.req(http.MethodGet, "/api/v1/keys", tok, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET before publish = %d, want 404: %s", rec.Code, rec.Body.String())
	}
	if got := decodeJSON[map[string]any](t, rec)["error"]; got != "no_keys" {
		t.Fatalf("GET before publish error = %v, want no_keys", got)
	}
}

func TestKeysRoundTrip(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	pub, wrapped := pubkey(0x11), wrappedBlob(0x22)

	rec := h.req(http.MethodPut, "/api/v1/keys", tok, map[string]any{
		"ingest_pubkey": b64(pub), "wrapped_keys": b64(wrapped), "key_version": 1,
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d, want 204: %s", rec.Code, rec.Body.String())
	}

	got := decodeJSON[KeysResponse](t, h.req(http.MethodGet, "/api/v1/keys", tok, nil))
	gotPub, err := base64.StdEncoding.DecodeString(got.IngestPubkey)
	if err != nil {
		t.Fatalf("decode pubkey: %v", err)
	}
	gotWrapped, err := base64.StdEncoding.DecodeString(got.WrappedKeys)
	if err != nil {
		t.Fatalf("decode wrapped: %v", err)
	}
	if !bytes.Equal(gotPub, pub) {
		t.Fatalf("pubkey round-tripped to %x, want %x", gotPub, pub)
	}
	if !bytes.Equal(gotWrapped, wrapped) {
		t.Fatalf("wrapped blob round-tripped to %x, want %x", gotWrapped, wrapped)
	}
	if got.KeyVersion != 1 {
		t.Fatalf("key_version = %d, want 1", got.KeyVersion)
	}
	if got.CreatedAt.IsZero() {
		t.Fatal("created_at is zero")
	}
}

// The refusal that protects every sealed blob the account will ever hold.
func TestKeysCannotBeReplacedWithDifferentMaterial(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	first := map[string]any{"ingest_pubkey": b64(pubkey(0x11)), "wrapped_keys": b64(wrappedBlob(0x22)), "key_version": 1}
	if rec := h.req(http.MethodPut, "/api/v1/keys", tok, first); rec.Code != http.StatusNoContent {
		t.Fatalf("first PUT = %d, want 204: %s", rec.Code, rec.Body.String())
	}

	for name, body := range map[string]map[string]any{
		"a different public key": {"ingest_pubkey": b64(pubkey(0x33)), "wrapped_keys": b64(wrappedBlob(0x22)), "key_version": 1},
		"a different wrap":       {"ingest_pubkey": b64(pubkey(0x11)), "wrapped_keys": b64(wrappedBlob(0x44)), "key_version": 1},
	} {
		rec := h.req(http.MethodPut, "/api/v1/keys", tok, body)
		if rec.Code != http.StatusConflict {
			t.Fatalf("republishing with %s = %d, want 409: %s", name, rec.Code, rec.Body.String())
		}
		if got := decodeJSON[map[string]any](t, rec)["error"]; got != "keys_already_published" {
			t.Fatalf("republishing with %s: error = %v", name, got)
		}
	}

	// And the stored row is untouched — a refusal that half-applied would be
	// worse than one that succeeded.
	got := decodeJSON[KeysResponse](t, h.req(http.MethodGet, "/api/v1/keys", tok, nil))
	if got.IngestPubkey != b64(pubkey(0x11)) || got.WrappedKeys != b64(wrappedBlob(0x22)) {
		t.Fatal("a refused republication changed the stored row")
	}
}

// A device that published, lost the response and retried has done nothing
// wrong: identical bytes must be a success, or onboarding strands a user who
// blinked at the wrong moment.
func TestRepublishingIdenticalMaterialIsIdempotent(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	body := map[string]any{"ingest_pubkey": b64(pubkey(0x11)), "wrapped_keys": b64(wrappedBlob(0x22)), "key_version": 1}
	for i := 0; i < 3; i++ {
		if rec := h.req(http.MethodPut, "/api/v1/keys", tok, body); rec.Code != http.StatusNoContent {
			t.Fatalf("PUT %d = %d, want 204: %s", i, rec.Code, rec.Body.String())
		}
	}
}

// The scoping test. Two accounts, two key sets: neither may see the other's,
// and the user id is taken from the SESSION and never from the request — there
// is no user field in the request shape at all, and this is what proves it.
func TestKeysAreScopedToTheCallersAccount(t *testing.T) {
	h := newHarness(t)
	alice := h.session(h.user("alice"))
	bob := h.session(h.user("bob"))

	if rec := h.req(http.MethodPut, "/api/v1/keys", alice, map[string]any{
		"ingest_pubkey": b64(pubkey(0xa1)), "wrapped_keys": b64(wrappedBlob(0xa2)), "key_version": 1,
	}); rec.Code != http.StatusNoContent {
		t.Fatalf("alice PUT = %d", rec.Code)
	}

	if rec := h.req(http.MethodGet, "/api/v1/keys", bob, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("bob GET after alice published = %d, want 404: %s", rec.Code, rec.Body.String())
	}

	// Bob publishes his own, and Alice's is unchanged.
	if rec := h.req(http.MethodPut, "/api/v1/keys", bob, map[string]any{
		"ingest_pubkey": b64(pubkey(0xb1)), "wrapped_keys": b64(wrappedBlob(0xb2)), "key_version": 1,
	}); rec.Code != http.StatusNoContent {
		t.Fatalf("bob PUT = %d", rec.Code)
	}
	if got := decodeJSON[KeysResponse](t, h.req(http.MethodGet, "/api/v1/keys", alice, nil)); got.IngestPubkey != b64(pubkey(0xa1)) {
		t.Fatal("bob's publication changed alice's key")
	}
}

func TestKeysRefuseMalformedSubmissions(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	good := wrappedBlob(0x22)

	cases := map[string]map[string]any{
		"a 31-byte public key":   {"ingest_pubkey": b64(make([]byte, 31)), "wrapped_keys": b64(good), "key_version": 1},
		"a 33-byte public key":   {"ingest_pubkey": b64(make([]byte, 33)), "wrapped_keys": b64(good), "key_version": 1},
		"no public key":          {"wrapped_keys": b64(good), "key_version": 1},
		"no wrapped blob":        {"ingest_pubkey": b64(pubkey(1)), "key_version": 1},
		"a wrapped blob too big": {"ingest_pubkey": b64(pubkey(1)), "wrapped_keys": b64(make([]byte, 4097)), "key_version": 1},
		"a wrapped blob too small": {
			"ingest_pubkey": b64(pubkey(1)), "wrapped_keys": b64(make([]byte, 8)), "key_version": 1,
		},
		"a key version of zero": {"ingest_pubkey": b64(pubkey(1)), "wrapped_keys": b64(good), "key_version": 0},
		"a public key that is not base64": {
			"ingest_pubkey": "not base64!", "wrapped_keys": b64(good), "key_version": 1,
		},
	}
	for name, body := range cases {
		rec := h.req(http.MethodPut, "/api/v1/keys", tok, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("PUT with %s = %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}
	// None of them stored anything.
	if rec := h.req(http.MethodGet, "/api/v1/keys", tok, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a rejected submission stored a row: GET = %d", rec.Code)
	}
}

// The bound in the migration's CHECK and the bound in the handler are two
// numbers that must be one. A handler that admitted more than the column does
// would turn a user-visible refusal into a 500 in production only.
func TestWrappedBlobBoundMatchesTheColumn(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	// Exactly at the limit: accepted, which proves the handler's bound is not
	// tighter than the column's, and that the column's is not tighter than the
	// handler's.
	rec := h.req(http.MethodPut, "/api/v1/keys", tok, map[string]any{
		"ingest_pubkey": b64(pubkey(1)), "wrapped_keys": b64(make([]byte, maxWrappedKeyBytes)), "key_version": 1,
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT at the size limit = %d, want 204: %s", rec.Code, rec.Body.String())
	}
}
