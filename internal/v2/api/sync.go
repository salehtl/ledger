package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/oplog"
)

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------
//
// These are the shapes the TypeScript client codes against. int64 fields are
// decimal STRINGS and chain hashes are hex; see the package doc for why.

// Row is one op-log row on the wire.
type Row struct {
	Seq           string    `json:"seq"`
	Stream        string    `json:"stream"`
	WriterID      string    `json:"writer_id"`
	WriterCounter string    `json:"writer_counter"`
	TypeFlag      string    `json:"type_flag"`
	SizeBucket    int       `json:"size_bucket"`
	BlobHash      string    `json:"blob_hash"` // hex
	PrevHash      string    `json:"prev_hash"` // hex
	CreatedAt     time.Time `json:"created_at"`
	Blob          string    `json:"blob"` // base64
}

// PullResponse answers GET /api/v1/sync.
//
// Next is the largest seq returned FOR THIS STREAM and is what the caller sends
// back as `after`. Complete answers "is this client caught up on this stream",
// and it is computed against the stream's committed maximum rather than
// inferred from the page size — a page can end early because of the byte
// budget, and a client that read "short page, therefore done" would stop
// syncing with rows outstanding.
type PullResponse struct {
	Stream   string `json:"stream"`
	Rows     []Row  `json:"rows"`
	Next     string `json:"next"`
	Complete bool   `json:"complete"`
}

// HashEntry is one entry of the per-blob hash list (spec §3.3:72).
type HashEntry struct {
	Seq           string `json:"seq"`
	WriterID      string `json:"writer_id"`
	WriterCounter string `json:"writer_counter"`
	BlobHash      string `json:"blob_hash"` // hex
	PrevHash      string `json:"prev_hash"` // hex
}

// HashesResponse answers GET /api/v1/sync/hashes.
type HashesResponse struct {
	Stream   string      `json:"stream"`
	Hashes   []HashEntry `json:"hashes"`
	Next     string      `json:"next"`
	Complete bool        `json:"complete"`
}

// UploadBlob is one blob a device submits, already sealed for the position it
// declares and already chained by its author.
type UploadBlob struct {
	WriterCounter string `json:"writer_counter"`
	PrevHash      string `json:"prev_hash"` // hex
	BlobHash      string `json:"blob_hash"` // hex
	TypeFlag      string `json:"type_flag"`
	SizeBucket    int    `json:"size_bucket"`
	Blob          string `json:"blob"` // base64
}

// UploadRequest is POST /api/v1/sync. It carries no user id: the account is the
// one the session resolves to, always.
type UploadRequest struct {
	WriterID string       `json:"writer_id"`
	Stream   string       `json:"stream"`
	Blobs    []UploadBlob `json:"blobs"`
}

// UploadResponse returns the assigned seqs, in submission order.
type UploadResponse struct {
	Seqs []string `json:"seqs"`
}

// ExchangeRequest is POST /api/v1/auth/exchange.
type ExchangeRequest struct {
	IdP     string `json:"idp"`
	IDToken string `json:"id_token"`
}

// ExchangeResponse carries the session token, returned exactly once.
type ExchangeResponse struct {
	SessionToken string `json:"session_token"`
	UserID       string `json:"user_id"`
}

// ChallengeResponse carries a single-use registration nonce (base64).
type ChallengeResponse struct {
	Nonce string `json:"nonce"`
}

// RegisterRequest is POST /api/v1/writers/register. The signature is over
// auth.RegistrationMessage(nonce, writer_id, pubkey).
type RegisterRequest struct {
	WriterID string `json:"writer_id"`
	PubKey   string `json:"pubkey"` // base64
	Nonce    string `json:"nonce"`  // base64
	Sig      string `json:"sig"`    // base64
}

// WriterEntry is one roster row. RevokedAt is null while the writer is live.
type WriterEntry struct {
	WriterID     string     `json:"writer_id"`
	Kind         string     `json:"kind"`
	PubKey       string     `json:"pubkey"` // base64; empty for the ingest writer, which has no key
	RegisteredAt time.Time  `json:"registered_at"`
	RevokedAt    *time.Time `json:"revoked_at"`
}

// WritersResponse answers GET /api/v1/writers. Revoked writers are INCLUDED: a
// peer auditing a chain needs "this writer was retired" and "this writer was
// never here" to be different answers.
type WritersResponse struct {
	Writers []WriterEntry `json:"writers"`
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

// handleExchange trades a provider ID token for a session.
//
// It is the only unauthenticated endpoint, which is why it is rate limited
// twice: per client address, and globally as the backstop for a caller
// distributed across addresses.
//
// # The order of the two checks is load bearing
//
// Per-IP FIRST, and a global token is spent only by a request that already
// passed it. The other order — which this handler shipped with — spends the
// shared budget on requests the per-IP limiter is about to refuse anyway, so
// one host makes 40 attempts, is served its own burst of 3, and drains the
// global bucket with the other 37. At a real clock a single host sustaining
// the global refill rate then holds EVERY other client at 429 indefinitely:
// one source, no forged tokens, total sign-in outage. That is precisely the
// trade Limiter's doc says it refuses to make, undone by a `||`.
func (s *Server) handleExchange(w http.ResponseWriter, r *http.Request) {
	if !s.SignInPerIP.Allow(clientKey(r)) || !s.SignInGlobal.Allow("") {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many sign-in attempts")
		return
	}
	var req ExchangeRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	verifier, ok := s.Verifiers[req.IdP]
	if !ok || verifier == nil {
		// Not a 401: naming a provider we do not support is a malformed
		// request, and answering it as a failed authentication would send a
		// client into a re-auth loop against a provider we will never accept.
		writeErr(w, http.StatusBadRequest, "bad_request", "unsupported idp")
		return
	}
	if req.IDToken == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "id_token is required")
		return
	}

	// VerifyOpts.Nonce is deliberately EMPTY in Phase 1.
	//
	// The nonce claim is plaintext inside the ID token, so anyone who captured
	// the token can read it: a flow where the client picks the nonce and hands
	// it back alongside the token is decorative — the replayer supplies it too
	// and every check passes. A real binding needs server-side state created
	// BEFORE the token existed: issue a random challenge, store it against the
	// pending sign-in, have the client pass it to the provider as `nonce`, then
	// look it up, compare, and CONSUME it exactly once. auth.Writers.Challenge
	// is that shape (32 random bytes, single use, 5-minute TTL) and is what to
	// reuse. Phase 1 has no such store on this path and no client to drive it,
	// so the binding is left unwired rather than half-wired: a decorative nonce
	// check reads as a defence in every later review and is none.
	id, err := verifier.Verify(r.Context(), req.IDToken, auth.VerifyOpts{})
	if err != nil {
		if errors.Is(err, auth.ErrNotConfigured) {
			// Checked BEFORE the collapse below, even though it wraps
			// ErrTokenRejected. It means this deployment has no client ids for
			// the provider, so no token can be recognized as ours — a fact
			// about the server, not the credential. Answering 401 would be the
			// same confusion ErrKeySetUnavailable's 503 exists to remove: the
			// user is told their perfectly good token is invalid and sent to
			// fetch another one that will fail identically.
			s.logf("api: exchange: %v", err)
			writeErr(w, http.StatusServiceUnavailable, "unavailable", "identity provider is not configured")
			return
		}
		if errors.Is(err, auth.ErrKeySetUnavailable) {
			// NOT a 401. The token said nothing wrong; we could not reach the
			// provider's keys. Telling a user with a perfectly good token that
			// their sign-in was invalid sends them to re-authenticate against a
			// provider that will hand back another token we still cannot
			// verify.
			s.logf("api: exchange: %v", err)
			writeErr(w, http.StatusServiceUnavailable, "unavailable", "identity provider key set is unavailable")
			return
		}
		// Every rejection reason collapses to one 401. Which check failed is an
		// oracle in a response and a useful detail only in a log.
		s.logf("api: exchange: token rejected: %v", err)
		writeUnauthorized(w)
		return
	}

	userID, err := auth.UpsertUser(r.Context(), s.Pool, id)
	if err != nil {
		s.logf("api: exchange: upsert user: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	token, err := s.Sessions.Issue(r.Context(), userID)
	if err != nil {
		s.logf("api: exchange: issue session: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, ExchangeResponse{SessionToken: token, UserID: userID.String()})
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

// handleChallenge mints a single-use registration nonce.
//
// The per-user cap is the point of the rate limit here: minting is exactly what
// a session token authorizes, so without a cap one session can fill
// writer_challenges as fast as it can issue requests. The challenge is
// worthless without a signature from an enrolled key, so the cap protects
// storage rather than the capability.
func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.ChallengePerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many challenges; try again shortly")
		return
	}
	nonce, err := s.Writers.Challenge(r.Context(), userID)
	if err != nil {
		s.logf("api: challenge for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, ChallengeResponse{Nonce: base64.StdEncoding.EncodeToString(nonce)})
}

// handleRegister enrolls a writer.
//
// The session identifies the ACCOUNT and authorizes nothing else: the
// enrollment is authorized by the Ed25519 signature, which auth.Writers.Register
// checks against an already-enrolled key (or, exactly once per account, against
// the key being enrolled — the TOFU bootstrap).
//
// Every rejection is the same 403 with the same body. auth returns distinct
// sentinels — ErrWriterExists, ErrKeyAlreadyEnrolled, ErrNotAuthorized,
// ErrChallengeUsed, … — and each of them, surfaced, tells a caller who could
// not prove key possession whether a writer id is taken or a public key is
// already enrolled. Neither is theirs to learn.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	// Capping challenge minting bounds SUCCESSFUL registrations, and nothing
	// else: a failed attempt consumes no challenge budget — a replayed nonce is
	// refused by consumeChallenge, which costs two database round trips before
	// any signature work — so attempts need their own cap. It is per user
	// rather than per address so one account cannot spend another's.
	if !s.RegisterPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many registration attempts; try again shortly")
		return
	}
	var req RegisterRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	pub, err := base64.StdEncoding.DecodeString(req.PubKey)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "pubkey is not base64")
		return
	}
	nonce, err := base64.StdEncoding.DecodeString(req.Nonce)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "nonce is not base64")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(req.Sig)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "sig is not base64")
		return
	}
	err = s.Writers.Register(r.Context(), userID, req.WriterID, ed25519.PublicKey(pub), nonce, sig)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, auth.ErrRegistrationRejected):
		s.logf("api: register writer for %s: %v", userID, err)
		writeErr(w, http.StatusForbidden, "registration_rejected", "")
	default:
		s.logf("api: register writer for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
	}
}

// handleRoster returns the caller's writers, revoked ones included.
func (s *Server) handleRoster(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	roster, err := s.Writers.Roster(r.Context(), userID)
	if err != nil {
		s.logf("api: roster for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	out := WritersResponse{Writers: make([]WriterEntry, 0, len(roster))}
	for _, wr := range roster {
		e := WriterEntry{
			WriterID:     wr.WriterID,
			Kind:         wr.Kind,
			RegisteredAt: wr.RegisteredAt,
		}
		if wr.PubKey != nil {
			e.PubKey = base64.StdEncoding.EncodeToString(wr.PubKey)
		}
		if !wr.RevokedAt.IsZero() {
			t := wr.RevokedAt
			e.RevokedAt = &t
		}
		out.Writers = append(out.Writers, e)
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	stream, ok := requireStream(w, r)
	if !ok {
		return
	}
	after, err := parseCursor(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	limit, err := parseLimit(r, defaultPullLimit, maxPullLimit)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	rows, err := oplog.Read(r.Context(), s.Pool, userID, stream, after, limit, s.PullByteBudget)
	if err != nil {
		s.logf("api: pull %s for %s: %v", stream, userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	out := PullResponse{Stream: stream, Rows: make([]Row, 0, len(rows))}
	// An empty page leaves the cursor exactly where the caller had it, so a
	// client that keeps sending `next` back never rewinds.
	next := after
	for _, row := range rows {
		next = row.Seq
		out.Rows = append(out.Rows, Row{
			Seq:           strconv.FormatInt(row.Seq, 10),
			Stream:        row.Stream,
			WriterID:      row.WriterID,
			WriterCounter: strconv.FormatInt(row.WriterCounter, 10),
			TypeFlag:      row.TypeFlag,
			SizeBucket:    row.SizeBucket,
			BlobHash:      hex.EncodeToString(row.BlobHash),
			PrevHash:      hex.EncodeToString(row.PrevHash),
			CreatedAt:     row.CreatedAt,
			Blob:          base64.StdEncoding.EncodeToString(row.Blob),
		})
	}
	out.Next = strconv.FormatInt(next, 10)

	// Asked AFTER the page, never before: rows committed in between make this
	// report "not complete", which costs one empty round trip. The other order
	// can report complete while rows exist, which costs the client its data.
	maxSeq, err := oplog.StreamMaxSeq(r.Context(), s.Pool, userID, stream)
	if err != nil {
		s.logf("api: pull %s max seq for %s: %v", stream, userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	out.Complete = next >= maxSeq
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleHashes(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	stream, ok := requireStream(w, r)
	if !ok {
		return
	}
	after, err := parseCursor(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	limit, err := parseLimit(r, defaultHashLimit, maxHashLimit)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	hashes, err := oplog.Hashes(r.Context(), s.Pool, userID, stream, after, limit)
	if err != nil {
		s.logf("api: hashes %s for %s: %v", stream, userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	out := HashesResponse{Stream: stream, Hashes: make([]HashEntry, 0, len(hashes))}
	next := after
	for _, h := range hashes {
		next = h.Seq
		out.Hashes = append(out.Hashes, HashEntry{
			Seq:           strconv.FormatInt(h.Seq, 10),
			WriterID:      h.WriterID,
			WriterCounter: strconv.FormatInt(h.WriterCounter, 10),
			BlobHash:      hex.EncodeToString(h.BlobHash),
			PrevHash:      hex.EncodeToString(h.PrevHash),
		})
	}
	out.Next = strconv.FormatInt(next, 10)
	maxSeq, err := oplog.StreamMaxSeq(r.Context(), s.Pool, userID, stream)
	if err != nil {
		s.logf("api: hashes %s max seq for %s: %v", stream, userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	out.Complete = next >= maxSeq
	writeJSON(w, http.StatusOK, out)
}

// requireStream reads and validates the `stream` query parameter. It is
// required rather than defaulted: a client that forgets it means one of the two
// streams, and guessing which would silently sync the wrong one.
func requireStream(w http.ResponseWriter, r *http.Request) (string, bool) {
	stream := r.URL.Query().Get("stream")
	if stream != blob.StreamHot && stream != blob.StreamCold {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"stream must be "+strconv.Quote(blob.StreamHot)+" or "+strconv.Quote(blob.StreamCold))
		return "", false
	}
	return stream, true
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

// handleUpload appends a device's own blobs.
//
// Order matters and is not arbitrary:
//
//  1. the session resolves the account — there is no user field on the wire;
//  2. the writer must be a LIVE writer of THAT account (oplog.AppendClient
//     documents that its caller owns this check, because auth imports oplog and
//     the roster lookup cannot live down there);
//  3. every blob is validated structurally, including that its embedded AAD
//     names the exact position it is being stored at;
//  4. only then does the append transaction open.
//
// Nothing is stored unless the whole batch is: oplog.AppendClient rolls back as
// a unit, so a rejected batch consumes neither a seq nor a counter.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req UploadRequest
	if !decodeBody(w, r, maxUploadBytes, &req) {
		return
	}
	if req.Stream == blob.StreamCold {
		// Invariant I16: the cold stream carries raw email bodies and never
		// ops, and only the ingest writer produces those. A client-authored
		// cold row would be an op blob on the stream a hot-only client skips,
		// which is exactly what makes "a hot-only sync is a complete
		// materialization" false.
		writeErr(w, http.StatusBadRequest, "bad_request",
			"the cold stream carries raw bodies from the server's ingest writer only")
		return
	}
	if req.Stream != blob.StreamHot {
		writeErr(w, http.StatusBadRequest, "bad_request", "stream must be "+strconv.Quote(blob.StreamHot))
		return
	}
	if len(req.Blobs) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "blobs is empty")
		return
	}
	if len(req.Blobs) > maxUploadBlobs {
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large",
			"at most "+strconv.Itoa(maxUploadBlobs)+" blobs per upload")
		return
	}
	if req.WriterID == oplog.IngestWriterID {
		// The server's own writer, whose provenance the client UI labels
		// "server-ingested". A device allowed to author here would be
		// laundering its own ops into that label.
		writeErr(w, http.StatusForbidden, "forbidden", "the ingest writer is the server's own")
		return
	}
	if !s.writerIsLive(w, r, userID, req.WriterID) {
		return
	}

	rows := make([]oplog.Row, 0, len(req.Blobs))
	for i, b := range req.Blobs {
		row, status, detail := decodeUploadBlob(userID, req.WriterID, req.Stream, b)
		if status != 0 {
			writeErr(w, status, statusCode(status), "blob "+strconv.Itoa(i)+": "+detail)
			return
		}
		rows = append(rows, row)
	}

	// The batch's INTERNAL consistency is checked here, before the append, so
	// that its failure is answered as what it is: a client-side arithmetic
	// error.
	//
	// oplog.AppendClient runs this same check before it opens a transaction and
	// reports failure as ErrChainBreak — correct for that package, wrong at this
	// layer, because a chain break is spec §3.3:68's non-dismissable "your
	// server may have tampered with your data" hard stop. Nothing the server
	// did can make the blobs in one request fail to link to each other: they
	// arrived together, in this request, from the client that authored them. A
	// client bug must never tell a user their operator may have tampered with
	// their log.
	//
	// What is left for AppendClient's ErrChainBreak is the HEAD-relative
	// case — the batch does not continue what is stored — which is genuinely
	// ambiguous between "this client skipped" and "the server lost rows", and
	// is the case the hard stop exists for.
	var claimedPrev [32]byte
	copy(claimedPrev[:], rows[0].PrevHash)
	if err := oplog.VerifyChain(rows, rows[0].WriterCounter-1, claimedPrev); err != nil {
		// Deliberately NOT err.Error(): oplog's text says "writer hash chain
		// break", which is the vocabulary of the hard stop this answer exists
		// to avoid raising.
		s.logf("api: upload for %s: batch is not internally chained: %v", userID, err)
		writeErr(w, http.StatusBadRequest, "bad_request",
			"the blobs in this batch do not chain to each other: counters must be consecutive, "+
				"each prev_hash must be the previous blob_hash, and each blob_hash must be "+
				"SHA256(prev_hash || blob)")
		return
	}

	seqs, err := s.Appender.AppendClient(r.Context(), userID, req.WriterID, req.Stream, rows)
	if err != nil {
		s.writeAppendErr(w, userID, err)
		return
	}
	out := UploadResponse{Seqs: make([]string, len(seqs))}
	for i, q := range seqs {
		out.Seqs[i] = strconv.FormatInt(q, 10)
	}
	writeJSON(w, http.StatusOK, out)
}

// writerIsLive checks the roster. A writer that is unknown to this account, or
// revoked, or the ingest writer, may not append — and all three answer 403
// rather than 404: the caller can read their own roster, so there is nothing to
// hide from them, but the distinction is theirs and not a stranger's.
func (s *Server) writerIsLive(w http.ResponseWriter, r *http.Request, userID uuid.UUID, writerID string) bool {
	roster, err := s.Writers.Roster(r.Context(), userID)
	if err != nil {
		s.logf("api: upload: roster for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return false
	}
	for _, wr := range roster {
		if wr.WriterID != writerID {
			continue
		}
		if wr.Kind != auth.KindDevice {
			writeErr(w, http.StatusForbidden, "forbidden", "that writer is not a device writer")
			return false
		}
		if !wr.Live() {
			writeErr(w, http.StatusForbidden, "forbidden", "that writer is revoked")
			return false
		}
		return true
	}
	writeErr(w, http.StatusForbidden, "forbidden", "no such writer on this account")
	return false
}

// decodeUploadBlob turns one wire blob into an oplog.Row, or returns the HTTP
// status and detail for why it cannot. status 0 means success.
//
// The AAD check here is the one that stops a blob being stored at a position it
// was not sealed for — including a blob sealed for ANOTHER USER, which is the
// only way a request can even name another account, since the wire shape has no
// user field. It is done with blob.EmbeddedAAD rather than by opening the blob:
//
//   - the AAD is cleartext framing in BOTH phases, so this exact check still
//     works in Phase 3 when the server holds no key and cannot open anything;
//   - opening would gzip-decompress up to blob.MaxPlaintext per blob purely to
//     throw the plaintext away, which is a CPU amplifier the server gains
//     nothing from.
//
// oplog.Row.validate performs the same comparison again inside the append, so
// this is the early, specific answer rather than the only line of defence.
func decodeUploadBlob(userID uuid.UUID, writerID, stream string, b UploadBlob) (oplog.Row, int, string) {
	counter, err := strconv.ParseInt(b.WriterCounter, 10, 64)
	if err != nil || counter < 1 {
		return oplog.Row{}, http.StatusBadRequest, "writer_counter must be a decimal integer of at least 1"
	}
	raw, err := base64.StdEncoding.DecodeString(b.Blob)
	if err != nil {
		return oplog.Row{}, http.StatusBadRequest, "blob is not base64"
	}
	// Checked before the bucket check so an oversize blob is a 413 and not a
	// confusing "not a size bucket" 400.
	if len(raw) > blob.MaxBucket {
		return oplog.Row{}, http.StatusRequestEntityTooLarge,
			"blob is " + strconv.Itoa(len(raw)) + " bytes, cap is " + strconv.Itoa(blob.MaxBucket)
	}
	if b.SizeBucket != len(raw) {
		return oplog.Row{}, http.StatusBadRequest,
			"size_bucket is " + strconv.Itoa(b.SizeBucket) + " but the blob is " + strconv.Itoa(len(raw)) + " bytes"
	}
	bucket, err := blob.BucketFor(len(raw))
	if err != nil || bucket != len(raw) {
		return oplog.Row{}, http.StatusBadRequest,
			"blob is " + strconv.Itoa(len(raw)) + " bytes, which is not a size bucket"
	}
	// Safe to index: the bucket check above rejected everything shorter than
	// the smallest bucket, so raw is at least 1 KiB by the time we get here. Do
	// not move this above it.
	if raw[0] != blob.Version {
		// The framing version is frozen (blob's package doc: nothing about the
		// layout may move), so a blob declaring another one is unopenable by
		// every client that will ever read it. The log is append-only, which
		// makes storing it permanent loss, so it is refused here rather than
		// discovered later as a set-aside warning on a device.
		return oplog.Row{}, http.StatusBadRequest,
			"envelope version is " + strconv.Itoa(int(raw[0])) + ", want " + strconv.Itoa(blob.Version)
	}
	blobHash, err := hex.DecodeString(b.BlobHash)
	if err != nil || len(blobHash) != 32 {
		return oplog.Row{}, http.StatusBadRequest, "blob_hash must be 64 hex characters"
	}
	prevHash, err := hex.DecodeString(b.PrevHash)
	if err != nil || len(prevHash) != 32 {
		return oplog.Row{}, http.StatusBadRequest, "prev_hash must be 64 hex characters"
	}
	if b.TypeFlag != "" && b.TypeFlag != oplog.TypeFlagEdit {
		// type_flag is the provenance column; "ingest" means the server wrote
		// this from inbound mail, which a device's row is by definition not.
		return oplog.Row{}, http.StatusBadRequest, "type_flag must be " + strconv.Quote(oplog.TypeFlagEdit)
	}
	embedded, err := blob.EmbeddedAAD(raw)
	if err != nil {
		return oplog.Row{}, http.StatusBadRequest, "blob framing is unreadable"
	}
	want := blob.Envelope{UserID: userID, Stream: stream, WriterID: writerID, WriterCounter: counter}
	if err := want.Validate(); err != nil {
		return oplog.Row{}, http.StatusBadRequest, "the position this blob claims is not a valid one"
	}
	if string(embedded) != string(want.AAD()) {
		return oplog.Row{}, http.StatusBadRequest,
			"the blob was sealed for a different position than the one it is being stored at"
	}
	return oplog.Row{
		UserID:        userID,
		Stream:        stream,
		WriterID:      writerID,
		WriterCounter: counter,
		TypeFlag:      oplog.TypeFlagEdit,
		Blob:          raw,
		SizeBucket:    len(raw),
		BlobHash:      blobHash,
		PrevHash:      prevHash,
	}, 0, ""
}

// writeAppendErr maps the append's outcomes onto statuses a client can act on.
//
// The three conflict cases are deliberately distinguished in the DETAIL and not
// in the status, because a client's remedy differs: a chain break is a sync
// hard stop (spec §3.3:68), a partial resend has a trivial fix, and a taken
// position is a server-side invariant violation the client cannot repair. All
// three describe the caller's own log, so the detail discloses nothing.
func (s *Server) writeAppendErr(w http.ResponseWriter, userID uuid.UUID, err error) {
	switch {
	case errors.Is(err, oplog.ErrPartiallyApplied):
		// The client contract, quoted verbatim from oplog/chain.go: the server
		// refuses a straddling batch rather than trimming it.
		writeErr(w, http.StatusConflict, "conflict",
			"read the chain head and resend only the rows above it")
	case errors.Is(err, oplog.ErrChainBreak):
		writeErr(w, http.StatusConflict, "chain_break", err.Error())
	case errors.Is(err, oplog.ErrPositionTaken):
		s.logf("api: upload for %s: %v", userID, err)
		writeErr(w, http.StatusConflict, "conflict", "that chain position is already held")
	default:
		// Everything reachable here has already been screened by
		// decodeUploadBlob, so this is a server-side failure and gets no
		// detail.
		s.logf("api: upload for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
	}
}

// statusCode names the error code that goes with a status, so decodeUploadBlob
// can return a status alone.
func statusCode(status int) string {
	switch status {
	case http.StatusRequestEntityTooLarge:
		return "too_large"
	case http.StatusForbidden:
		return "forbidden"
	default:
		return "bad_request"
	}
}
