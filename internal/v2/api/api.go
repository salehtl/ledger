// Package api is v2's HTTP surface: the sync protocol a device speaks, plus
// the sign-in exchange and writer-roster endpoints it needs to speak it. It is
// the first thing in this tree reachable from a network, so it owns the
// translation from the internal packages' precise errors into answers that are
// useful to a client and useless to an attacker.
//
// # The contract, in full
//
//	POST /api/v1/auth/exchange     {idp, id_token}                 -> {session_token, user_id}
//	POST /api/v1/writers/challenge {}                              -> {nonce}
//	POST /api/v1/writers/register  {writer_id, pubkey, nonce, sig} -> 204
//	GET  /api/v1/writers                                           -> {writers:[...]}
//	GET  /api/v1/sync?stream=&after=&limit=                        -> {stream, rows, next, complete}
//	GET  /api/v1/sync/hashes?stream=&after=&limit=                 -> {stream, hashes, next, complete}
//	POST /api/v1/sync {writer_id, stream, blobs:[...]}             -> {seqs:[...]}
//
// Every endpoint except the exchange requires `Authorization: Bearer <session
// token>`. Every query is scoped by the user id RESOLVED from that token and
// never by a user id taken from the request — there is no user field anywhere
// in the request shapes above, deliberately.
//
// # Wire encodings
//
// Two rules, both pinned by tests:
//
//   - Integers that are int64 in Go (seq, writer_counter) travel as DECIMAL
//     STRINGS. JSON.parse turns a JSON number into a float64, and this is the
//     same rule oplog's frozen op model already applies to counters and money;
//     one convention across the whole protocol beats two.
//   - Chain hashes are lower-case HEX (matching oplog.CheckpointHead.Hash);
//     every other binary field — blob bodies, public keys, nonces, signatures —
//     is standard base64.
//
// # Uploading: what happens when a batch is partly applied
//
// A batch that STRADDLES the writer's committed head — some rows already
// stored, some not — is refused with 409 rather than trimmed, because the seq
// block is reserved for the whole batch before the head is known
// (oplog.AppendClient). The client contract for that case, quoted verbatim from
// oplog/chain.go:
//
//	read the chain head and resend only the rows above it
//
// A byte-identical resend of an ALREADY-applied batch is not that case: it is
// idempotent and answers 200 with the seqs those rows already hold.
//
// # What a clean sync does NOT prove
//
// oplog.VerifyChain over a pull proves that what the server served is a
// consistent continuation of the head the client gave it. It does not prove the
// server served everything: a truncation, a re-chained interior drop, a
// cross-stream splice and equivocation between two devices all verify.
// Detecting those needs a head pinned independently of the response — the
// device's own persisted head, or spec §3.3(c)'s writer_checkpoint op (plan
// invariant I11_roster_checkpoint). And in Phase 1, where blobs are PLAINTEXT
// and unauthenticated, even a client writer's chain is forgeable by the server;
// the chains detect mistakes today and become evidence about an adversary only
// when Phase 3 seals the blobs. No response from this package may be presented
// as more than that.
//
// # Replay of an ID token, stated plainly
//
// POST /api/v1/auth/exchange binds no nonce in Phase 1 (see handleExchange for
// why a client-supplied one would be theatre). The consequence: a captured
// Apple or Google ID token is a REPLAYABLE BEARER CREDENTIAL here for its whole
// validity window — anything that observes one (a malicious SDK in the client
// app, a log line, an intercepting proxy) can exchange it for a session. That
// compounds with the absence of a sign-up allowlist: a replayed token for an
// account this deployment has never seen creates one. Closing it needs the
// issue → store → compare → consume-once flow described at the call site.
//
// # Sessions are weak capabilities
//
// A session token authorizes reading and appending to the account's log, and
// obtaining a registration challenge. It does NOT authorize enrolling a writer:
// POST /api/v1/writers/register takes the session only to know WHICH account is
// being talked about, and the enrollment itself is authorized by an Ed25519
// signature over a server-issued single-use nonce (auth.Writers.Register). The
// same rule applies to account deletion and inbound-address rotation when those
// arrive (spec §3.4); do not reach for requireSession as the only gate.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/config"
	"ledger/internal/v2/oplog"
)

// Request-shaping limits. They bound what one caller can make the server hold
// in memory before anything about the caller is known to be legitimate.
const (
	// maxUploadBlobs caps how many positions one call may claim. The whole
	// batch shares one seq block and one counter-lock hold (oplog.appendRows),
	// so this is also the bound on how long one upload can serialise a user's
	// appends.
	maxUploadBlobs = 8
	// maxUploadBytes caps POST /api/v1/sync.
	//
	// It is sized so that a batch conforming to maxUploadBlobs ALWAYS fits:
	// 8 blobs x base64(1 MiB) is ~11.2 MB, plus JSON framing. The two limits
	// disagreeing is not cosmetic — a client sending the permitted number of
	// max-size blobs would trip the body cap and get a generic "body too large"
	// instead of the per-blob 413 that says which blob is wrong and why.
	// TestUploadSizeCapsAgree asserts the arithmetic so they cannot drift.
	maxUploadBytes = 12 << 20
	// maxSmallBodyBytes caps every other request body. None of them carries
	// anything but short strings; an ID token is capped again inside auth.
	maxSmallBodyBytes = 64 << 10

	// defaultPullLimit / maxPullLimit bound GET /api/v1/sync's row count;
	// pullByteBudget bounds the bytes those rows may carry, which is the limit
	// that actually matters when a row can be a megabyte.
	defaultPullLimit = 100
	maxPullLimit     = 500
	// pullByteBudget is chosen against PEAK MEMORY, not bandwidth: a response
	// is marshalled into one buffer, so a full page costs its raw blobs plus
	// their base64 expansion plus the marshalled JSON — roughly 4x the budget,
	// live at once, for every in-flight request. 4 MiB keeps that near 15 MB
	// per request; cmd/ledgerd's WriteTimeout is what bounds how long a client
	// that stops reading can hold it.
	pullByteBudget = 4 << 20

	// Hash-list pages are fixed-width rows (two 32-byte hashes and three small
	// fields), so a much larger page is still a small response.
	defaultHashLimit = 1000
	maxHashLimit     = 5000
)

// Rate-limit defaults. See Limiter for why each of these endpoints has one.
const (
	signInPerIPRate   = 0.2 // 12/minute sustained
	signInPerIPBurst  = 10
	signInGlobalRate  = 20
	signInGlobalBurst = 100
	signInMaxKeys     = 4096

	challengeRate    = 1.0 / 60.0 // 1/minute sustained
	challengeBurst   = 10
	challengeMaxKeys = 4096

	// Strictly more generous than the challenge cap, because a legitimate
	// client spends one challenge per registration and may retry a request that
	// failed in transit.
	registerRate    = 2.0 / 60.0 // 2/minute sustained
	registerBurst   = 20
	registerMaxKeys = 4096
)

// Server holds everything the handlers need. Construct it with NewServer in
// production; the fields are exported so a test can substitute a fake verifier
// or a limiter with no refill.
type Server struct {
	Pool     *pgxpool.Pool
	Sessions *auth.Sessions
	Writers  *auth.Writers
	Appender *oplog.Appender

	// Verifiers maps an IdP name to its verifier, and it is built ONCE per
	// process (NewServer), never per request.
	//
	// This is not tidiness. auth's JWKS cache, its one-fetch-per-refresh-window
	// attempt limit and its inflight herd control are all per INSTANCE: a
	// handler that constructed a verifier per request would give every inbound
	// token its own cold cache and restore, exactly, the unauthenticated
	// outbound amplifier pointed at Apple and Google that auth's cachingKeySet
	// exists to remove. TestIdPVerifiersAreReusedAcrossRequests pins it.
	Verifiers map[string]auth.Verifier

	// The limiters default to the constants above when nil.
	SignInPerIP      *Limiter
	SignInGlobal     *Limiter
	ChallengePerUser *Limiter
	RegisterPerUser  *Limiter

	// PullByteBudget bounds the blob bytes one page of GET /api/v1/sync may
	// carry; 0 means pullByteBudget. It is a field rather than a constant so a
	// test can truncate a page by BYTES — the case `complete` exists for, and
	// the one a page-size heuristic gets wrong — without seeding megabytes.
	PullByteBudget int

	// Logf receives operator-facing detail: the REASON a request was rejected,
	// which the response deliberately does not carry. Defaults to log.Printf.
	Logf func(format string, args ...any)

	// Now defaults to time.Now and is used only by the default limiters.
	Now func() time.Time
}

// NewServer builds the production server from config. It performs no network
// I/O: the IdP verifiers are constructed here precisely because construction is
// free and must happen exactly once, while the first JWKS fetch happens lazily
// on the first sign-in.
func NewServer(cfg config.Config, pool *pgxpool.Pool) (*Server, error) {
	if pool == nil {
		return nil, errors.New("api: NewServer: pool is nil")
	}
	if cfg.Auth.SessionTTL <= 0 {
		return nil, errors.New("api: NewServer: auth.session_ttl must be positive")
	}
	now := time.Now
	s := &Server{
		Pool:     pool,
		Sessions: &auth.Sessions{Pool: pool, TTL: cfg.Auth.SessionTTL},
		Writers:  &auth.Writers{Pool: pool},
		Appender: &oplog.Appender{Pool: pool},
		Verifiers: map[string]auth.Verifier{
			// One instance each, for the life of the process. A misconfigured
			// verifier (no client ids) is not an error here: it rejects every
			// token with auth.ErrNotConfigured, so the failure mode of a bad
			// config is "nobody can sign in", never "anybody can".
			auth.IdPApple:  auth.NewAppleVerifier(cfg.Auth.AppleClientIDs, now),
			auth.IdPGoogle: auth.NewGoogleVerifier(cfg.Auth.GoogleClientIDs, now),
		},
		Now: now,
	}
	return s, nil
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) logf(format string, args ...any) {
	if s.Logf != nil {
		s.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// Handler returns the router. It fills in any limiter the caller left nil, so a
// Server built field-by-field is still rate limited.
func (s *Server) Handler() http.Handler {
	if s.SignInPerIP == nil {
		s.SignInPerIP = NewLimiter(signInPerIPRate, signInPerIPBurst, signInMaxKeys, s.now)
	}
	if s.SignInGlobal == nil {
		s.SignInGlobal = NewLimiter(signInGlobalRate, signInGlobalBurst, 1, s.now)
	}
	if s.ChallengePerUser == nil {
		s.ChallengePerUser = NewLimiter(challengeRate, challengeBurst, challengeMaxKeys, s.now)
	}
	if s.RegisterPerUser == nil {
		s.RegisterPerUser = NewLimiter(registerRate, registerBurst, registerMaxKeys, s.now)
	}
	if s.PullByteBudget <= 0 {
		s.PullByteBudget = pullByteBudget
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/auth/exchange", s.handleExchange)
	mux.HandleFunc("POST /api/v1/writers/challenge", s.requireSession(s.handleChallenge))
	mux.HandleFunc("POST /api/v1/writers/register", s.requireSession(s.handleRegister))
	mux.HandleFunc("GET /api/v1/writers", s.requireSession(s.handleRoster))
	mux.HandleFunc("GET /api/v1/sync", s.requireSession(s.handlePull))
	mux.HandleFunc("GET /api/v1/sync/hashes", s.requireSession(s.handleHashes))
	mux.HandleFunc("POST /api/v1/sync", s.requireSession(s.handleUpload))

	// Catch-all: an unrouted /api/ path answers 404 JSON rather than falling
	// through to anything a later task mounts at "/" (a static client bundle,
	// say), which would turn a client's typo into an HTML page it tries to
	// parse as a sync response.
	//
	// One edge this does NOT cover, stated so the guarantee is not overclaimed:
	// ServeMux cleans paths BEFORE matching, so a request for a path needing
	// normalisation (`/api/v1/../v1/sync`) is answered with a 301 and an HTML
	// body by net/http itself, never reaching this handler. Harmless — the
	// redirect target is the correct route — but a client that follows
	// redirects sees one non-JSON response on the way.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
	return mux
}

// ---------------------------------------------------------------------------
// Session middleware
// ---------------------------------------------------------------------------

type authedHandler func(w http.ResponseWriter, r *http.Request, userID uuid.UUID)

// requireSession resolves the bearer token and hands the handler the user id it
// names.
//
// EVERY rejection — absent header, wrong scheme, unknown token, expired token,
// revoked token — produces the identical 401: same status, same body, same
// headers. auth returns distinct sentinels for these on purpose (they are
// useful in a log, and "expired" or "revoked" confirms the token was once real
// where "unknown" does not), and telling them apart in a RESPONSE is an oracle.
// The reason goes to the operator log instead.
//
// A failure that is not a rejection — the database is unreachable — is a 500,
// not a 401: reporting infrastructure trouble as "your credential is invalid"
// sends a user off to re-authenticate for no reason. Same principle as
// auth.ErrKeySetUnavailable's 503 on the exchange path.
func (s *Server) requireSession(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			s.logf("api: %s %s: no bearer token", r.Method, r.URL.Path)
			writeUnauthorized(w)
			return
		}
		userID, err := s.Sessions.Resolve(r.Context(), token)
		if err != nil {
			if errors.Is(err, auth.ErrSessionInvalid) {
				// The reason is logged, never returned.
				s.logf("api: %s %s: session rejected: %v", r.Method, r.URL.Path, err)
				writeUnauthorized(w)
				return
			}
			s.logf("api: %s %s: resolve session: %v", r.Method, r.URL.Path, err)
			writeErr(w, http.StatusInternalServerError, "internal", "")
			return
		}
		h(w, r, userID)
	}
}

// bearerToken extracts the credential from an Authorization header. The scheme
// is matched case-insensitively (RFC 7235 says it is case-insensitive); the
// token itself is not touched, because Sessions hashes the ENCODED form that
// arrives on the wire.
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const scheme = "bearer "
	if len(h) <= len(scheme) || !strings.EqualFold(h[:len(scheme)], scheme) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(scheme):])
	if tok == "" {
		return "", false
	}
	return tok, true
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

// errorBody is every failure answer this package produces. Detail is present
// only where it describes the CALLER's own submission (a malformed blob, a
// chain break in their own log); it is always empty on 401 and on a rejected
// registration, where any variation at all would be an oracle.
type errorBody struct {
	Error  string `json:"error"`
	Detail string `json:"detail,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		// Marshalling our own response types cannot fail; if it somehow does,
		// a 500 with no body beats a half-written one.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// Every response from this API is either a credential (the exchange returns
	// a session bearer token) or the user's own financial history. None of it
	// may reach a shared cache, an intermediary, or a client's disk cache, so
	// the header is set here — once, for every response — rather than on the
	// handlers someone remembers.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}

func writeErr(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, errorBody{Error: code, Detail: detail})
}

// writeUnauthorized is the ONE 401 this package emits. It takes no arguments
// precisely so no caller can vary it.
func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	writeJSON(w, http.StatusUnauthorized, errorBody{Error: "unauthorized"})
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

// decodeBody reads a JSON request body under a hard byte cap, refusing unknown
// fields so a client typo is a loud 400 rather than a silently ignored value.
// It reports whether it already answered.
func decodeBody(w http.ResponseWriter, r *http.Request, max int64, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large",
				"request body exceeds "+strconv.FormatInt(max, 10)+" bytes")
			return false
		}
		writeErr(w, http.StatusBadRequest, "bad_request", "body is not valid JSON for this endpoint")
		return false
	}
	// Exactly one JSON value per request: trailing bytes mean the client and
	// the server disagree about what was sent.
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "bad_request", "body carries more than one JSON value")
		return false
	}
	return true
}

// parseCursor reads the `after` query parameter: a seq, as a decimal string,
// defaulting to 0. Negative is refused rather than clamped — it means the
// client's cursor arithmetic is wrong, and silently repairing it hides that.
func parseCursor(r *http.Request) (int64, error) {
	raw := r.URL.Query().Get("after")
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, errors.New("after must be a non-negative decimal seq")
	}
	return n, nil
}

// parseLimit reads `limit`, defaulting and capping it. A caller asking for more
// than the cap gets the cap, not an error: the response says `complete` either
// way, so an over-large request is answered correctly, just in more pages.
func parseLimit(r *http.Request, def, max int) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, errors.New("limit must be a positive integer")
	}
	if n > max {
		n = max
	}
	return n, nil
}

// clientKey is the rate-limit key for an unauthenticated caller: the remote
// address with the port stripped, so one host cannot get a fresh budget per
// connection. It is attacker-chosen (there is no proxy in front of this
// listener today, and no X-Forwarded-For is trusted — trusting one would let
// any caller pick their own key and defeat the limit entirely), which is why
// Limiter bounds its key space.
//
// FOR TASK D4: the plan terminates TLS IN THIS PROCESS (autocert in runServe on
// the public domain), which keeps RemoteAddr the real client and this key
// meaningful — so the correct action there is to change nothing here. It is
// written down because the tempting alternative silently breaks it: put any
// reverse proxy in front and every request arrives from that one hop, this
// degenerates to a SINGLE key, the per-IP limiter quietly becomes a second
// global one, and one client can starve the sign-in budget again with no error
// anywhere. Anyone who does introduce a proxy owes PROXY protocol, or a
// forwarded-for header trusted from that hop specifically and only from it.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
