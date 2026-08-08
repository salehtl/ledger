package api

// keywraps.go serves the account's PRF wraps: a second sealing of the SAME key
// material 00026's wrapped_keys carries, opened by a secret that lives inside
// one of the account's WebAuthn credentials rather than by the recovery phrase.
// It is what makes Face ID, Touch ID or a security key an alternative to typing
// twelve words.
//
// # It is additive, and keys.go is untouched
//
// Key publication is write-once: handlePublishKeys compares all three fields
// byte for byte and answers 409 on any difference, with no UPDATE and no DELETE.
// Appending a second wrap to that column is therefore unreachable for any
// account that has published, and relaxing the comparison would reopen the
// accidental-rekey hazard the 409 exists to prevent. So the multi-wrap lives
// here, keyed by credential, and an account that published months ago gains PRF
// unlock without rewriting a byte of what it published.
//
// # What the server holds
//
// The same nothing it holds for wrapped_keys. `wrapped` is opaque: its format is
// client/src/crypto/prf.ts's envelope, and the key that opens it is derived from
// a 32-byte PRF output an authenticator computes under a secret this server
// never sees and cannot ask for. Nothing here parses past the length checks.
//
// # DELETE is correct here, and it is not correct for user_keys
//
// Losing a PRF wrap loses NOTHING: both wraps carry the same key set, so the
// recovery phrase still opens the account. That makes a row here disposable by
// design — a user who stops using a passkey, or a device that finds an orphaned
// wrap, may remove it freely. The identical operation on user_keys would let a
// stolen phone destroy a financial history with one tap, which is why that table
// has no DELETE at all.
//
// The phrase therefore stays MANDATORY. Every row here derives from a secret
// inside one authenticator that can be lost, reset or silently rotated by an OS
// update, and this server holds nothing that would help.

import (
	"encoding/base64"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// The bounds on a PRF wrap, mirroring user_key_wraps_wrapped_is_bounded and
// MAX_WRAPPED_BYTES in client/src/crypto/keys.ts. Checked here as well as in the
// column because a constraint violation is a 500 to the caller and "your blob is
// not a plausible length" is a 400 they can act on.
const (
	minKeyWrapBytes = minWrappedKeyBytes
	maxKeyWrapBytes = maxWrappedKeyBytes
)

// KeyWrap is one credential's wrap, as GET returns it.
//
// CredentialID is standard base64 of the raw credential id — the same bytes the
// browser calls `rawId`, and the same ones PasskeyAddResponse returns. The
// client matches an assertion against this list to find which wrap to open.
type KeyWrap struct {
	CredentialID string    `json:"credential_id"`
	Wrapped      string    `json:"wrapped"`
	WrapVersion  int       `json:"wrap_version"`
	CreatedAt    time.Time `json:"created_at"`
}

// KeyWrapsResponse answers GET /api/v1/keys/wraps.
//
// An account with no wraps answers 200 with an empty list, not 404: "this
// account has no PRF wrap" is a normal state — every account has it until
// somebody enrols one — and it is not the same fact as "there is no such
// account".
type KeyWrapsResponse struct {
	Wraps []KeyWrap `json:"wraps"`
}

type putKeyWrapRequest struct {
	CredentialID string `json:"credential_id"`
	Wrapped      string `json:"wrapped"`
	WrapVersion  int    `json:"wrap_version"`
}

type deleteKeyWrapRequest struct {
	CredentialID string `json:"credential_id"`
}

func (s *Server) handleGetKeyWraps(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	rows, err := s.Pool.Query(r.Context(),
		`SELECT credential_id, wrapped, wrap_version, created_at
		   FROM user_key_wraps WHERE user_id = $1 ORDER BY created_at`, userID)
	if err != nil {
		s.logf("api: read key wraps for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	defer rows.Close()

	out := KeyWrapsResponse{Wraps: []KeyWrap{}}
	for rows.Next() {
		var (
			credential []byte
			wrapped    []byte
			version    int
			created    time.Time
		)
		if err := rows.Scan(&credential, &wrapped, &version, &created); err != nil {
			s.logf("api: scan key wrap for %s: %v", userID, err)
			writeErr(w, http.StatusInternalServerError, "internal", "")
			return
		}
		out.Wraps = append(out.Wraps, KeyWrap{
			CredentialID: base64.StdEncoding.EncodeToString(credential),
			Wrapped:      base64.StdEncoding.EncodeToString(wrapped),
			WrapVersion:  version,
			CreatedAt:    created,
		})
	}
	if err := rows.Err(); err != nil {
		s.logf("api: read key wraps for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handlePutKeyWrap stores one credential's wrap, replacing any wrap that
// credential already had.
//
// The replacement is deliberate and is the opposite of handlePublishKeys's
// refusal, for the reason the file header gives: a wrap is disposable. Re-running
// enrolment after an authenticator rotated its PRF secret must be able to
// succeed, and a 409 there would leave the user with a row that no longer opens
// anything and no way to replace it.
func (s *Server) handlePutKeyWrap(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req putKeyWrapRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	credential, ok := decodeKeyField(w, req.CredentialID, "credential_id")
	if !ok {
		return
	}
	wrapped, ok := decodeKeyField(w, req.Wrapped, "wrapped")
	if !ok {
		return
	}
	if len(wrapped) < minKeyWrapBytes || len(wrapped) > maxKeyWrapBytes {
		writeErr(w, http.StatusBadRequest, "invalid_wrapped", "the wrapped key blob is not a plausible length")
		return
	}
	if req.WrapVersion <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_wrap_version", "wrap_version must be a positive integer")
		return
	}

	// The credential must be THIS account's. The foreign key alone would only
	// prove the credential exists somewhere, so a caller naming a stranger's
	// credential id would get a 204 and a stored row — a probe for whether a
	// credential id is registered, and a row attached to an account that cannot
	// open it. The check and the insert are one statement so nothing can change
	// between them.
	tag, err := s.Pool.Exec(r.Context(),
		`INSERT INTO user_key_wraps (user_id, credential_id, wrapped, wrap_version, created_at)
		 SELECT $1, $2, $3, $4, $5
		   FROM webauthn_credentials
		  WHERE credential_id = $2 AND user_id = $1
		 ON CONFLICT (user_id, credential_id)
		 DO UPDATE SET wrapped = EXCLUDED.wrapped, wrap_version = EXCLUDED.wrap_version, created_at = EXCLUDED.created_at`,
		userID, credential, wrapped, req.WrapVersion, s.now())
	if err != nil {
		s.logf("api: store key wrap for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if tag.RowsAffected() == 0 {
		// One answer for "no such credential" and "somebody else's credential",
		// because telling them apart would say whether a credential id is
		// registered to another account.
		writeErr(w, http.StatusNotFound, "unknown_credential", "this account has no such passkey")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteKeyWrap removes one credential's wrap.
//
// Deleting a wrap that is not there is a 204, not a 404: the caller's goal is
// "this credential no longer unlocks my keys", and that goal is met either way.
// It is also what the client does when it finds an orphaned wrap — a passkey
// deleted from a keychain, whose wrap the server still holds — and that cleanup
// must not fail because another device got there first.
func (s *Server) handleDeleteKeyWrap(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req deleteKeyWrapRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	credential, ok := decodeKeyField(w, req.CredentialID, "credential_id")
	if !ok {
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`DELETE FROM user_key_wraps WHERE user_id = $1 AND credential_id = $2`, userID, credential); err != nil {
		s.logf("api: delete key wrap for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
