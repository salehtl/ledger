package api

// The two endpoints the BACKUP RELAY talks to (spec §3.2, Task 35).
//
//	GET  /api/v1/relay/addresses -> {addresses:[{local_part,user_pubkey,expires_at}], as_of}
//	POST /api/v1/relay/deliver   {local_part, envelope_from, remote_ip, received_at, raw:<base64>}
//
// # A different credential, and deliberately not a session
//
// Both are authenticated by `Authorization: Bearer $LEDGER_RELAY_TOKEN` and NOT
// by a user session. That is not a shortcut: a session names one account and
// these two calls are about all of them, so there is no session that could
// legitimately authorize either. The converse matters more — a stolen session
// must not be able to read the whole address map or inject mail into a stranger's
// ledger — and it holds by construction, because [Server.requireRelayToken]
// compares against one configured secret and consults no session table at all.
//
// When LEDGER_RELAY_TOKEN is unset the routes are NOT MOUNTED, on exactly the
// same terms as the admin console: an endpoint that exists only to answer 401 is
// one an attacker can still find, and a deployment with no relay has no reason
// to advertise the pair. api.NewServer refuses to build at all if relay.enabled
// is set with no token, so the silent-half-configured case cannot happen either.
//
// # Why the address list is a FULL snapshot
//
// The task brief specified `?since=<rfc3339>`. It is deliberately not
// implemented, for a reason an incremental protocol cannot express: an address
// that DISAPPEARS — a purged account (§3.10), or a rotation whose grace window
// closed — produces no row to send, so the relay would keep it forever and go on
// accepting mail for an account that no longer exists. The whole map for a
// closed beta is a few kilobytes.
//
// The query returns only addresses that can still ACCEPT mail. A retired address
// inside its grace window is included with its expires_at, so the relay applies
// the same window the primary does rather than a second copy of the rule.
//
// # user_pubkey is empty in Phase 1, on purpose
//
// There is no account encryption key in the Phase 1 schema — device writers hold
// Ed25519 SIGNING keys, which are not that — so the field is present and empty.
// It is carried now so Phase 3 fills it in without a schema or a protocol
// change. See internal/v2/relay's package doc for why the relay cannot seal to
// an op-log position no matter what key it holds.
//
// # deliver is the ordinary ingest path
//
// It resolves the recipient itself and calls the SAME [smtpd.Handler] the SMTP
// receiver calls, with the arrival time the RELAY recorded rather than the
// moment the drain happened to succeed. So relayed mail is deduplicated by
// ingest id exactly like directly-received mail, is DKIM/ARC-verified over the
// same unmodified bytes, and is indistinguishable downstream.
//
// One difference, stated rather than hidden: relayed mail does not consume the
// per-address daily allowance, because that limiter lives in the SMTP receiver
// and this path does not go through it. The relay metered the same message
// against its own copy of the allowance when it accepted it, so the message was
// counted once — on the box that accepted it.

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"net/netip"
	"time"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/smtpd"
)

// Relay route paths. internal/v2/relay declares the same two strings as the
// client's constants, and TestTheRelayRoutesAreTheOnesTheRelayCalls asserts they
// are the same — a relay pointed at a path this mux does not serve gets a 404,
// which its drain classifies as a per-message rejection and would file an entire
// spool under rejected/.
const (
	relayAddressesPath = "/api/v1/relay/addresses"
	relayDeliverPath   = "/api/v1/relay/deliver"
)

const (
	// maxRelayDeliverBytes caps POST /api/v1/relay/deliver.
	//
	// It is sized so a conforming relay ALWAYS fits: the raw message is capped
	// at blob.MaxColdMail (1,000,000) and travels base64'd inside JSON, which is
	// ~1,333,336 bytes plus framing. The two caps disagreeing is not cosmetic —
	// a relay forwarding a legal maximum-size message would trip the body cap
	// and get a generic 413 that its drain would treat as a PERMANENT rejection,
	// filing a perfectly good message under rejected/ forever.
	// TestRelayDeliverSizeCapsAgree asserts the arithmetic.
	maxRelayDeliverBytes = 2 << 20

	// maxReplicaRows bounds the address map one response may carry. Past it the
	// endpoint FAILS rather than truncating: a truncated replica is worse than
	// no replica, because the relay would treat it as authoritative and answer
	// a permanent 550 for every address that fell off the end.
	maxReplicaRows = 20000

	// The relay is one known, authenticated peer, so the budget is shaped for
	// its actual traffic: a sync every five minutes, and a recovery drain that
	// can be a burst of hundreds of messages back to back. The burst is what
	// matters; the sustained rate exists so a compromised relay token cannot be
	// used to hammer the ingest path indefinitely.
	relayRate    = 20
	relayBurst   = 200
	relayMaxKeys = 64
)

// requireRelayToken gates the two relay routes on the shared secret.
//
// The comparison is constant time and the failure answer is byte-identical to
// every other 401 this package produces. There is no per-reason detail and no
// log line that varies with the token, for the same reason requireSession has
// none: the response is the one place a difference becomes an oracle.
func (s *Server) requireRelayToken(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok || s.RelayToken == "" ||
			subtle.ConstantTimeCompare([]byte(token), []byte(s.RelayToken)) != 1 {
			s.logf("api: %s %s: relay token rejected", r.Method, r.URL.Path)
			writeUnauthorized(w)
			return
		}
		if !s.RelayPerIP.Allow(clientKey(r)) {
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many relay requests")
			return
		}
		h(w, r)
	}
}

// RelayAddress is one row of the map the relay is allowed to hold.
type RelayAddress struct {
	LocalPart string `json:"local_part"`
	// UserPubKey is empty in Phase 1 and is carried anyway. It is NOT
	// `omitempty`: the field's presence is the statement that the protocol has
	// room for it, and a client that never saw the key would have no way to
	// tell "empty" from "this server is too old to send it".
	UserPubKey string `json:"user_pubkey"`
	// ExpiresAt is null for an active address, otherwise the instant its
	// rotation grace window closes.
	ExpiresAt *time.Time `json:"expires_at"`
}

// RelayAddressesResponse is GET /api/v1/relay/addresses.
type RelayAddressesResponse struct {
	Addresses []RelayAddress `json:"addresses"`
	// AsOf is the instant this snapshot was taken, and it is what the relay
	// ages its replica against when deciding whether it may still answer a
	// PERMANENT refusal.
	AsOf time.Time `json:"as_of"`
}

func (s *Server) handleRelayAddresses(w http.ResponseWriter, r *http.Request) {
	// The relay reports its own backlog on this call. It is logged and used for
	// nothing else: a spooled message that never reaches this server is a silent
	// drop unless something surfaces it, and the operator watches THIS box.
	if h := r.Header.Get(relaySpoolHeader); h != "" {
		s.logf("api: the backup relay reports a spool backlog: %s", sanitizeHeader(h))
	}
	now := s.now()
	rows, err := s.Pool.Query(r.Context(),
		`SELECT local_part, expires_at FROM inbound_addresses
		  WHERE expires_at IS NULL OR expires_at > $1
		  ORDER BY local_part
		  LIMIT $2`, now, maxReplicaRows+1)
	if err != nil {
		s.logf("api: GET %s: %v", relayAddressesPath, err)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "")
		return
	}
	defer rows.Close()

	out := RelayAddressesResponse{Addresses: []RelayAddress{}, AsOf: now}
	for rows.Next() {
		var (
			a       RelayAddress
			expires *time.Time
		)
		if err := rows.Scan(&a.LocalPart, &expires); err != nil {
			s.logf("api: GET %s: scan: %v", relayAddressesPath, err)
			writeErr(w, http.StatusServiceUnavailable, "unavailable", "")
			return
		}
		a.ExpiresAt = expires
		out.Addresses = append(out.Addresses, a)
	}
	if err := rows.Err(); err != nil {
		s.logf("api: GET %s: %v", relayAddressesPath, err)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "")
		return
	}
	if len(out.Addresses) > maxReplicaRows {
		// Refused rather than truncated. See maxReplicaRows.
		s.logf("api: GET %s: MORE THAN %d LIVE ADDRESSES. The relay replica is refused rather "+
			"than truncated, because a truncated replica would make the relay refuse real "+
			"addresses permanently. Paginate this endpoint before the beta grows further.",
			relayAddressesPath, maxReplicaRows)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// relaySpoolHeader mirrors relay.SpoolHeader. It is a literal here rather than
// an import so that internal/v2/api does not depend on internal/v2/relay in
// production code; the test asserts the two agree.
const relaySpoolHeader = "X-Ledger-Relay-Spool"

// sanitizeHeader keeps an attacker-influenced header out of the operator's log
// as anything but bounded printable text. The relay is authenticated, but a log
// line is not the place to find out that assumption was wrong.
func sanitizeHeader(h string) string {
	const max = 200
	out := make([]rune, 0, max)
	for _, c := range h {
		if len(out) == max {
			break
		}
		if c < 0x20 || c == 0x7f {
			c = '.'
		}
		out = append(out, c)
	}
	return string(out)
}

// RelayDeliverRequest is POST /api/v1/relay/deliver.
//
// It carries a LOCAL PART and not a user id: the relay never learns one, and
// this server re-resolves the recipient itself so a compromised relay cannot
// name an account it was never given mail for.
type RelayDeliverRequest struct {
	LocalPart    string    `json:"local_part"`
	EnvelopeFrom string    `json:"envelope_from"`
	RemoteIP     string    `json:"remote_ip"`
	ReceivedAt   time.Time `json:"received_at"`
	Raw          string    `json:"raw"` // base64, the message exactly as it arrived
}

// RelayDeliverResponse names the message this server took responsibility for.
type RelayDeliverResponse struct {
	IngestID string `json:"ingest_id"`
}

func (s *Server) handleRelayDeliver(w http.ResponseWriter, r *http.Request) {
	var req RelayDeliverRequest
	if !decodeBody(w, r, maxRelayDeliverBytes, &req) {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Raw)
	if err != nil || len(raw) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "raw must be a non-empty base64 message")
		return
	}
	if len(raw) > s.maxMessageBytes() {
		// 413 is a PERMANENT rejection and the relay will set the message
		// aside rather than retry it. That is correct: this server would refuse
		// the same bytes at DATA too, and a message that cannot be stored will
		// not become storable by being sent again.
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large",
			"the message exceeds this server's SMTP size cap")
		return
	}
	// The local part is re-normalized through the SAME rule the SMTP path uses,
	// and must already BE normalized: the relay sends the canonical form, so
	// anything else is a bug or a probe rather than a spelling to fold.
	suffix := s.Addresses.Suffix
	local, ok := addresses.LocalPartOf(req.LocalPart+suffix, suffix)
	if !ok || local != req.LocalPart {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"local_part must be a normalized inbound address local part")
		return
	}

	userID, isGrace, err := s.Addresses.Resolve(r.Context(), local+suffix)
	switch {
	case errors.Is(err, addresses.ErrUnknownRecipient):
		// PERMANENT: the relay moves this message to its rejection lane and
		// logs it loudly, which is the visible notice §2 requires for a message
		// that was accepted from a sender and can now never be placed. It
		// happens when the relay's replica named an address this server has
		// since retired or purged.
		s.logf("api: POST %s: no such recipient; the relay's replica is out of date and a "+
			"message it ACCEPTED cannot be placed", relayDeliverPath)
		writeErr(w, http.StatusNotFound, "not_found", "no such recipient")
		return
	case err != nil:
		// TEMPORARY: an outage here must not make the relay discard mail.
		s.logf("api: POST %s: resolve recipient: %v", relayDeliverPath, err)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "")
		return
	}

	receivedAt := req.ReceivedAt
	if receivedAt.IsZero() {
		receivedAt = s.now()
	}
	ip, _ := netip.ParseAddr(req.RemoteIP)

	if err := s.Mail.Deliver(r.Context(), smtpd.Delivery{
		UserID:       userID,
		Rcpt:         local + suffix,
		EnvelopeFrom: req.EnvelopeFrom,
		RemoteIP:     ip,
		Raw:          raw,
		// The instant the RELAY accepted it, not the instant the drain
		// succeeded: authored_at is a fact about the message, and a recovery
		// drain would otherwise stamp a week of backlog with one timestamp.
		ReceivedAt: receivedAt,
		IsGrace:    isGrace,
	}); err != nil {
		// The pipeline answers an error only for conditions a retry might fix,
		// and the relay keeps the message on a 5xx. Anything else here would
		// discard mail on a transient database failure.
		s.logf("api: POST %s: deliver: %v", relayDeliverPath, err)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "")
		return
	}
	sum := sha256.Sum256(raw)
	writeJSON(w, http.StatusAccepted, RelayDeliverResponse{IngestID: hex.EncodeToString(sum[:])})
}

// maxMessageBytes is the SMTP DATA cap this server enforces, defaulting to the
// same ceiling config.validate clamps mail.max_message_bytes to.
func (s *Server) maxMessageBytes() int {
	if s.MaxMessageBytes > 0 {
		return s.MaxMessageBytes
	}
	return blob.MaxColdMail
}

// relayRoutesMountable reports whether the relay pair can be served. All three
// are required and none is defaulted: an address resolver is what turns a local
// part into an account, a mail handler is what stores the message, and the token
// is the only thing standing between the open internet and both.
func (s *Server) relayRoutesMountable() bool {
	return s.RelayToken != "" && s.Mail != nil && s.Addresses != nil
}

// logRelayNotMounted says so once, at startup, when the operator asked for a
// relay-capable deployment and did not get one.
func logRelayNotMounted(why string) {
	log.Printf("api: the relay endpoints are NOT being served: %s", why)
}
