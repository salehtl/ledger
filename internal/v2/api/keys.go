package api

// keys.go serves the account's Phase 3 key material: the X25519 ingest public
// key the server will seal incoming bank mail to, and the blob that wraps the
// account's private key material under the user's recovery phrase.
//
// # What this server can and cannot do with what it stores here
//
// The public key is not a secret. The wrapped blob is opaque: its format is
// client/src/crypto/keys.ts's envelope, its contents are sealed under a key
// Argon2id derives from a twelve-word phrase that never leaves the user's
// device, and nothing in this package parses past the length checks below.
//
// Stated in spec §2's terms, because the onboarding copy is a privacy claim
// made to someone signing a consent document: a stolen disk, a stolen backup or
// a subpoena of this table yields a public key and a blob this server cannot
// open. That is NOT "we cannot see your data". Bank mail arrives over SMTP in
// plaintext and is read in memory before it is sealed, and a live, actively
// compromised server could log it. This endpoint narrows at-rest exposure; it
// does not close the ingest window, and no string anywhere may say it does.
//
// # Publication is once, and a replacement is a 409
//
// Every blob ever sealed to a published ingest key becomes unreadable the moment
// a different key set replaces it, and Phase 3 has no re-sealing path that would
// survive that happening by accident. So a PUT that names DIFFERENT bytes than
// the stored row is refused.
//
// Identical bytes succeed. That is not leniency, it is the retry case: a device
// that published and lost the response has done nothing wrong, and a blanket
// "written once, never again" would strand it mid-onboarding with no way
// forward. The comparison is on the bytes, which is why this check cannot be a
// row-level trigger — a trigger sees an UPDATE and cannot tell the two apart
// without the same comparison, at which point it is this code in a worse place.
//
// # There is no DELETE
//
// Deliberately. "Forget my keys" and "delete my account" are the same operation
// on the web — there is no other copy of the key material, so losing it loses
// the history — and account deletion already removes this row through the
// cascade in 00026_user_keys.sql. A separate DELETE would be a one-tap,
// session-authenticated way to destroy a financial history, reachable from a
// stolen phone.

import (
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// An X25519 public key, raw. Mirrors user_keys_pubkey_is_256_bits.
const ingestPubkeyBytes = 32

// The bounds on the wrapped blob, mirroring user_keys_wrapped_is_bounded and
// MAX_WRAPPED_BYTES in client/src/crypto/keys.ts. Checked HERE as well as in
// the column because a constraint violation is a 500 to the caller, and "your
// blob is too big" is a 400 the client can act on. keys_test.go pins the two
// bounds to each other.
const (
	minWrappedKeyBytes = 32
	maxWrappedKeyBytes = 4096
)

// KeysResponse answers GET /api/v1/keys.
//
// Both binary fields are standard base64, per api.go's wire rules. The wrapped
// blob travels whole: a client that has just been given a recovery phrase needs
// every byte of it to derive anything at all.
type KeysResponse struct {
	IngestPubkey string    `json:"ingest_pubkey"`
	WrappedKeys  string    `json:"wrapped_keys"`
	KeyVersion   int       `json:"key_version"`
	CreatedAt    time.Time `json:"created_at"`
}

type publishKeysRequest struct {
	IngestPubkey string `json:"ingest_pubkey"`
	WrappedKeys  string `json:"wrapped_keys"`
	KeyVersion   int    `json:"key_version"`
}

// handleGetKeys returns the caller's own key material.
//
// A 404 is a REAL answer here rather than a failure: every account created
// before Phase 3 has no keys, Task 2 keeps those accounts working in plaintext,
// and a recovering device branches on exactly this — keys present means "ask for
// the recovery phrase", keys absent means "generate a new set". It carries a
// named error code so the branch is not on a bare status.
func (s *Server) handleGetKeys(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var (
		pub     []byte
		wrapped []byte
		version int
		created time.Time
	)
	err := s.Pool.QueryRow(r.Context(),
		`SELECT ingest_pubkey, wrapped_keys, key_version, created_at FROM user_keys WHERE user_id = $1`,
		userID).Scan(&pub, &wrapped, &version, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "no_keys", "")
		return
	}
	if err != nil {
		s.logf("api: read user keys for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, KeysResponse{
		IngestPubkey: base64.StdEncoding.EncodeToString(pub),
		WrappedKeys:  base64.StdEncoding.EncodeToString(wrapped),
		KeyVersion:   version,
		CreatedAt:    created,
	})
}

// handlePublishKeys stores the caller's key material, once.
func (s *Server) handlePublishKeys(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req publishKeysRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}

	pub, ok := decodeKeyField(w, req.IngestPubkey, "ingest_pubkey")
	if !ok {
		return
	}
	if len(pub) != ingestPubkeyBytes {
		writeErr(w, http.StatusBadRequest, "invalid_pubkey", "an X25519 public key is 32 bytes")
		return
	}
	wrapped, ok := decodeKeyField(w, req.WrappedKeys, "wrapped_keys")
	if !ok {
		return
	}
	if len(wrapped) < minWrappedKeyBytes || len(wrapped) > maxWrappedKeyBytes {
		writeErr(w, http.StatusBadRequest, "invalid_wrapped_keys", "the wrapped key blob is not a plausible length")
		return
	}
	if req.KeyVersion <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_key_version", "key_version must be a positive integer")
		return
	}

	now := s.now()
	// ON CONFLICT DO NOTHING, then read back and compare — rather than an
	// upsert with a WHERE, or a SELECT followed by an INSERT. The read-back is
	// what makes the idempotent retry and the refusal one atomic decision: two
	// devices racing to publish cannot both believe they won, because whichever
	// INSERT lost reads the row the winner wrote and compares against it.
	tag, err := s.Pool.Exec(r.Context(),
		`INSERT INTO user_keys (user_id, ingest_pubkey, wrapped_keys, key_version, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $5)
		 ON CONFLICT (user_id) DO NOTHING`,
		userID, pub, wrapped, req.KeyVersion, now)
	if err != nil {
		s.logf("api: publish user keys for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if tag.RowsAffected() == 1 {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var (
		storedPub     []byte
		storedWrapped []byte
	)
	if err := s.Pool.QueryRow(r.Context(),
		`SELECT ingest_pubkey, wrapped_keys FROM user_keys WHERE user_id = $1`, userID).
		Scan(&storedPub, &storedWrapped); err != nil {
		s.logf("api: compare user keys for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if bytesEqual(storedPub, pub) && bytesEqual(storedWrapped, wrapped) {
		// The retry. Nothing changed and nothing needed to.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeErr(w, http.StatusConflict, "keys_already_published",
		"this account already has key material, and replacing it would make everything already sealed to it unreadable")
}

// decodeKeyField decodes one standard-base64 field, or writes the 400 and
// returns false. Standard base64 and not URL-safe, matching api.go's rule for
// every other binary field.
func decodeKeyField(w http.ResponseWriter, value, field string) ([]byte, bool) {
	if value == "" {
		writeErr(w, http.StatusBadRequest, "invalid_"+field, field+" is required")
		return nil, false
	}
	b, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_"+field, field+" is not standard base64")
		return nil, false
	}
	return b, true
}

// bytesEqual is bytes.Equal, named locally so the comparison at the heart of
// the 409 reads as one decision rather than as an import.
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
