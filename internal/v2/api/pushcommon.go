package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ledger/internal/v2/auth"
)

// The pieces the push registration handlers share.
//
// They lived in push.go until the native push-token API was removed on
// 2026-08-10 (its only client was the retired Expo app). Every one of them is
// still used by webpush.go, which is the surviving half of the same shape, so
// they moved here rather than going with the file.

// maxWriterIDLen mirrors writers_writer_id_charset. It is a cheapness bound
// only: what actually authorizes a writer_id here is the ownership lookup in
// liveDeviceWriter, which is strictly stronger than any grammar check.
const maxWriterIDLen = 64

// liveDeviceWriter reports whether writerID names an enrolled, non-revoked
// DEVICE writer of this user.
//
// kind = 'device' matters: the ingest writer is the server's own, it has no key
// and therefore no revocation ceremony, so a subscription pinned to it would be
// one that nothing could ever revoke — the exact hole this whole change closes,
// reintroduced through a value a client picks.
func (s *Server) liveDeviceWriter(r *http.Request, userID uuid.UUID, writerID string) (bool, error) {
	var one int
	err := s.Pool.QueryRow(r.Context(),
		`SELECT 1 FROM writers
		  WHERE user_id = $1 AND writer_id = $2 AND kind = 'device' AND revoked_at IS NULL`,
		userID, writerID).Scan(&one)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	return true, nil
}

// sessionHash re-derives the hash of the bearer token this request carried.
//
// Recomputed rather than threaded through requireSession because it is needed
// by exactly these handlers, and widening authedHandler for a few of nineteen
// routes would put a credential-derived value in the signature of every handler
// that has no business holding one.
func (s *Server) sessionHash(r *http.Request) ([]byte, bool) {
	tok, ok := bearerToken(r)
	if !ok {
		return nil, false
	}
	return auth.SessionHash(tok), true
}
