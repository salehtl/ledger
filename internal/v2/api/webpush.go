package api

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/pushv2"
)

// The bounds below mirror push_subscriptions' CHECK constraints exactly.
// Duplicated rather than derived because the constraint is what makes the bound
// a GUARANTEE and this is what makes a violation a 400 instead of a 500 with a
// Postgres error string in the log.
const (
	maxPushEndpointLen = 2048
	maxP256dhLen       = 256
	minP256dhLen       = 64
	maxPushAuthLen     = 64
	minPushAuthLen     = 16
)

// rePushEndpoint mirrors push_subscriptions_endpoint_is_bounded_https: an https
// URL of printable, non-space ASCII. Deliberately not a full URL parse — the
// grammar is what keeps a newline out of a string this server builds an
// outbound request from, and a parser that accepts more than the column does
// would turn a refusal into a constraint violation.
var rePushEndpoint = regexp.MustCompile(`^https://[\x21-\x7e]+$`)

// reBase64URL mirrors the p256dh/auth constraints. Padding is admitted because
// browsers differ on whether they emit it and a subscription this server
// refuses is a user who cannot turn notifications on.
var reBase64URL = regexp.MustCompile(`^[A-Za-z0-9_=-]+$`)

// VAPIDResponse is GET /api/v1/push/vapid.
type VAPIDResponse struct {
	// PublicKey is the application server key, base64url, exactly as
	// PushManager.subscribe wants it. It is public by construction: every
	// browser that subscribes sends it to its push service.
	PublicKey string `json:"public_key"`
}

// PushSubscriptionRequest is POST /api/v1/push/subscriptions. The field names
// are the browser's own (PushSubscription.toJSON's `endpoint` and `keys`), so a
// client can forward what it was given rather than re-shaping it and getting
// the encoding subtly wrong.
type PushSubscriptionRequest struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`

	// WriterID names the device key this browser already enrolled, and it is
	// REQUIRED for the reason it is required on the Expo route: it is the link
	// that makes the subscription revocable. A nullable link is one the first
	// client to forget the field silently opts out of, and what it opts out of
	// is "revoking this device stops its notifications".
	WriterID string `json:"writer_id"`
}

// PushSubscriptionInfo is one row of GET /api/v1/push/subscriptions.
type PushSubscriptionInfo struct {
	// ID is the handle DELETE /push/subscriptions/{handle} takes. A user
	// removing a browser they are not sitting at has only this.
	ID string `json:"id"`
	// EndpointHost is the push service's hostname and nothing else. The full
	// endpoint is a URL that anyone holding it can send to (the VAPID signature
	// is what a push service checks, and a compliant service will still accept
	// an unauthenticated send to many endpoints), so a listing that returned
	// whole endpoints would hand every one of a user's subscriptions to
	// anything holding a session. The host is what a person actually recognises
	// — "this is my Firefox" — which is the job the listing has.
	EndpointHost string    `json:"endpoint_host"`
	WriterID     string    `json:"writer_id"`
	CreatedAt    time.Time `json:"created_at"`
	// Current marks the row created by the session making THIS request. Without
	// it a user looking at two rows a day apart cannot tell which browser to
	// remove, and the cost of guessing wrong is silently switching off their
	// own notifications.
	Current bool `json:"current"`
}

// PushSubscriptionsResponse is GET /api/v1/push/subscriptions.
type PushSubscriptionsResponse struct {
	// Subscriptions is newest first — the same order pushv2 notifies in, so a
	// client can render the truncation honestly rather than implying every row
	// gets a notification.
	Subscriptions []PushSubscriptionInfo `json:"subscriptions"`
	// Max is pushv2.MaxDevicesPerUser, published rather than left implicit.
	Max int `json:"max"`
}

// handleVAPIDPublicKey serves the application server key a browser must present
// to PushManager.subscribe.
//
// It is the one route that reports whether Web Push is configured at all, and
// it answers 404 when it is not. That is a product decision as much as an API
// one: a client that cannot get a key cannot subscribe, and the honest thing
// for it to render is "notifications are not set up on this server" rather than
// a switch that turns on and then does nothing. A 200 with an empty string
// would make "unconfigured" a value every client has to remember to check.
//
// No session is required. The key is public — it travels to Apple, Google and
// Mozilla on every send — and requiring a session to read it would only mean a
// client cannot decide whether to show the control before it has one.
func (s *Server) handleVAPIDPublicKey(w http.ResponseWriter, _ *http.Request) {
	if s.VAPIDPublicKey == "" {
		writeErr(w, http.StatusNotFound, "push_unavailable", "web push is not configured on this server")
		return
	}
	writeJSON(w, http.StatusOK, VAPIDResponse{PublicKey: s.VAPIDPublicKey})
}

// handleSubscribePush records a browser's Web Push subscription for the CALLING
// session's user.
//
// The user comes from the session and is not a field of the request — the same
// property handleRegisterPushToken has, and for a sharper reason here: a push
// endpoint is a URL that shows up in logs and proxies, so if a body could name
// its own user_id, anyone who saw one could point another account's
// notifications at a subscription they control.
//
// It is an upsert on (user_id, endpoint), because a browser hands back the same
// subscription every time it is asked and re-subscribing on every launch is the
// normal client shape. A repeat is a no-op rather than an error and it does NOT
// touch created_at — pushv2 orders the fan-out by it, and refreshing it on every
// launch would make every browser look equally new and the cap's choice
// arbitrary. It DOES refresh the keys, writer_id and session_hash: those are the
// current answer to "which device and which sign-in owns this row", and a stale
// answer is a row the wrong revocation clears.
func (s *Server) handleSubscribePush(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.PushPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
		return
	}
	// Refused before the body is read: storing a subscription against a
	// deployment that has no key to send with produces a row that can never be
	// delivered to, and a client that believes notifications are on.
	if s.VAPIDPublicKey == "" {
		writeErr(w, http.StatusNotFound, "push_unavailable", "web push is not configured on this server")
		return
	}
	var req PushSubscriptionRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	endpoint := strings.TrimSpace(req.Endpoint)
	p256dh := strings.TrimSpace(req.P256dh)
	pauth := strings.TrimSpace(req.Auth)
	switch {
	case endpoint == "" || len(endpoint) > maxPushEndpointLen || !rePushEndpoint.MatchString(endpoint):
		writeErr(w, http.StatusBadRequest, "invalid_endpoint",
			"endpoint must be an https URL of at most 2048 printable characters")
		return
	case len(p256dh) < minP256dhLen || len(p256dh) > maxP256dhLen || !reBase64URL.MatchString(p256dh):
		writeErr(w, http.StatusBadRequest, "invalid_keys", "p256dh must be a base64url P-256 public key")
		return
	case len(pauth) < minPushAuthLen || len(pauth) > maxPushAuthLen || !reBase64URL.MatchString(pauth):
		writeErr(w, http.StatusBadRequest, "invalid_keys", "auth must be a base64url secret")
		return
	case req.WriterID == "" || len(req.WriterID) > maxWriterIDLen:
		writeErr(w, http.StatusBadRequest, "invalid_writer",
			"writer_id must name a device writer this account has enrolled")
		return
	}
	// Authorization before existence, as everywhere else in this API: the
	// refusal is identical for "no such writer", "another account's writer",
	// "the server's ingest writer" and "that key is revoked", so the error text
	// cannot be used to enumerate a roster.
	switch ok, err := s.liveDeviceWriter(r, userID, req.WriterID); {
	case err != nil:
		s.logf("api: check writer %q for %s: %v", req.WriterID, userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	case !ok:
		writeErr(w, http.StatusBadRequest, "invalid_writer",
			"writer_id must name a device writer this account has enrolled")
		return
	}
	sessionHash, ok := s.sessionHash(r)
	if !ok {
		// Unreachable: requireSession already resolved this bearer token.
		// Checked rather than assumed, because the alternative is a NOT NULL
		// violation presented as a 500 on a routine subscribe.
		writeUnauthorized(w)
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, writer_id, session_hash)
		 VALUES ($1,$2,$3,$4,$5,$6)
		 ON CONFLICT (user_id, endpoint) DO UPDATE
		   SET p256dh = excluded.p256dh,
		       auth = excluded.auth,
		       writer_id = excluded.writer_id,
		       session_hash = excluded.session_hash`,
		userID, endpoint, p256dh, pauth, req.WriterID, sessionHash); err != nil {
		s.logf("api: subscribe push for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.evictPushSubscriptionsOverCap(r, userID)
	w.WriteHeader(http.StatusNoContent)
}

// evictPushSubscriptionsOverCap enforces pushv2.MaxDevicesPerUser at the INSERT,
// using pushv2's own ordering so the set kept here is exactly the set notified
// there.
//
// A failure is logged and swallowed: the subscribe itself succeeded and is
// durable, and turning "we could not trim an old row" into a 500 would make a
// client retry a call that already worked.
func (s *Server) evictPushSubscriptionsOverCap(r *http.Request, userID uuid.UUID) {
	tag, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_subscriptions
		  WHERE user_id = $1
		    AND id IN (SELECT id FROM push_subscriptions WHERE user_id = $1
		                ORDER BY created_at DESC, endpoint DESC OFFSET $2)`,
		userID, pushv2.MaxDevicesPerUser)
	if err != nil {
		s.logf("api: trim push subscriptions for %s: %v", userID, err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		s.logf("api: user %s exceeded %d push subscriptions; forgot the %d oldest",
			userID, pushv2.MaxDevicesPerUser, n)
	}
}

// handleListPushSubscriptions is how a user sees the browsers that receive
// their notifications, and it exists for the reason the token listing does:
// without it, "remove this one" is unreachable to anyone who is not sitting at
// the browser in question.
func (s *Server) handleListPushSubscriptions(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	current, _ := s.sessionHash(r)
	rows, err := s.Pool.Query(r.Context(),
		`SELECT id, endpoint, writer_id, created_at, session_hash = $2
		   FROM push_subscriptions WHERE user_id = $1
		  ORDER BY created_at DESC, endpoint DESC`,
		userID, current)
	if err != nil {
		s.logf("api: list push subscriptions for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	defer rows.Close()
	out := PushSubscriptionsResponse{Subscriptions: []PushSubscriptionInfo{}, Max: pushv2.MaxDevicesPerUser}
	for rows.Next() {
		var (
			info     PushSubscriptionInfo
			id       uuid.UUID
			endpoint string
		)
		if err := rows.Scan(&id, &endpoint, &info.WriterID, &info.CreatedAt, &info.Current); err != nil {
			s.logf("api: list push subscriptions for %s: %v", userID, err)
			writeErr(w, http.StatusInternalServerError, "internal", "")
			return
		}
		info.ID = id.String()
		info.EndpointHost = endpointHost(endpoint)
		out.Subscriptions = append(out.Subscriptions, info)
	}
	if err := rows.Err(); err != nil {
		s.logf("api: list push subscriptions for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// endpointHost is the host of an https endpoint, by string surgery rather than
// url.Parse.
//
// The value has already passed rePushEndpoint, so it begins with "https://" and
// contains no space or control character; there is nothing for a parser to
// disagree about. Using url.Parse here would mean a second grammar, and the
// only thing a second grammar can do is admit something the column refused.
func endpointHost(endpoint string) string {
	rest := strings.TrimPrefix(endpoint, "https://")
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

// handleUnsubscribePush forgets one browser.
//
// Scoped to the session's user by the WHERE clause, and because the table is
// keyed by (user_id, endpoint) an endpoint two accounts share is two rows —
// deleting one leaves the other. See 00029_push_subscriptions.sql.
//
// The path segment matches the endpoint OR the row id, because the two callers
// know different things: a browser unsubscribing holds its own endpoint, and a
// user removing a machine they no longer have has only the id from the listing.
//
// An endpoint that does not exist answers 204, not 404. Deleting twice is the
// normal outcome of a client retrying, and a 404 would additionally tell any
// caller whether an arbitrary endpoint is registered to them.
func (s *Server) handleUnsubscribePush(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.PushPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
		return
	}
	handle := r.PathValue("handle")
	if handle == "" {
		writeErr(w, http.StatusBadRequest, "invalid_endpoint", "no subscription in the path")
		return
	}
	// id::text rather than a Go-side uuid.Parse: a handle that is not a uuid
	// must be treated as an endpoint, not as a parse error, and casting the
	// column keeps both cases in one statement under one user_id scope.
	if _, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_subscriptions WHERE user_id = $1 AND (endpoint = $2 OR id::text = $2)`,
		userID, handle); err != nil {
		s.logf("api: unsubscribe push for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleUnsubscribeAllPush forgets every browser this user has subscribed.
//
// The panic button. The recovery a user actually needs is "make it stop", not
// "work out which of these five rows is the machine at my old job". Every
// browser still in use re-subscribes on its next launch, so over-deleting costs
// one app open — which is what makes this safe to offer plainly.
func (s *Server) handleUnsubscribeAllPush(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.PushPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_subscriptions WHERE user_id = $1`, userID); err != nil {
		s.logf("api: unsubscribe all push for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
