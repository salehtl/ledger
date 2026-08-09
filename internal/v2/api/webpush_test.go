package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/pushv2"
)

// testVAPIDPublic is a syntactically real application server key. Nothing in
// the API verifies it — the server only hands it to clients — but a placeholder
// would make a reader think one of these tests checks the key material.
const testVAPIDPublic = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"

const (
	subP256dh = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"
	subAuth   = "8eDyX_uCN0XRhSbY5hs7Hg"
)

// webPushHarness is newHarness with Web Push configured, which is the only
// state in which the subscribe routes do anything.
func webPushHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	h.srv.VAPIDPublicKey = testVAPIDPublic
	return h
}

func subscribe(t *testing.T, h *harness, sess, writerID, endpoint string) *httptest.ResponseRecorder {
	t.Helper()
	return h.req(http.MethodPost, "/api/v1/push/subscriptions", sess,
		PushSubscriptionRequest{Endpoint: endpoint, P256dh: subP256dh, Auth: subAuth, WriterID: writerID})
}

func subscriptionsOf(t *testing.T, h *harness, u uuid.UUID) []string {
	t.Helper()
	rows, err := h.pool.Query(bg,
		`SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY endpoint`, u)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestSubscribingIsScopedToTheSession is the property the endpoint exists to
// have: the user comes from the bearer token and from nowhere else.
//
// A push endpoint is a URL that turns up in logs, proxies and crash reports. If
// a request could name its own user, anyone who saw one could point another
// account's notifications at a subscription they control — or, by subscribing
// with a victim's endpoint under their own account and then deleting it, end
// them.
func TestSubscribingIsScopedToTheSession(t *testing.T) {
	h := webPushHarness(t)
	a, b := h.user("a"), h.user("b")
	sa, sb := h.session(a), h.session(b)
	wa, wb := enrolled(t, h, a, "browser-a"), enrolled(t, h, b, "browser-b")
	const shared = "https://push.example.test/shared"

	for _, c := range []struct{ sess, writer string }{{sa, wa}, {sb, wb}} {
		if rec := subscribe(t, h, c.sess, c.writer, shared); rec.Code != http.StatusNoContent {
			t.Fatalf("subscribe: %d %s", rec.Code, rec.Body.String())
		}
	}
	if got := subscriptionsOf(t, h, a); len(got) != 1 {
		t.Fatalf("user a has %v", got)
	}
	if got := subscriptionsOf(t, h, b); len(got) != 1 {
		t.Fatalf("user b has %v", got)
	}

	// A deletes. B's row must survive: the table is keyed by (user_id, endpoint)
	// exactly so one string is two independent subscriptions.
	path := "/api/v1/push/subscriptions/" + url.PathEscape(shared)
	if rec := h.req(http.MethodDelete, path, sa, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if got := subscriptionsOf(t, h, a); len(got) != 0 {
		t.Fatalf("user a still holds %v after deleting", got)
	}
	if got := subscriptionsOf(t, h, b); len(got) != 1 {
		t.Fatalf("user a's delete removed user b's subscription: %v", got)
	}
}

func TestWebPushSubscriptionRoutesNeedASession(t *testing.T) {
	h := webPushHarness(t)
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/v1/push/subscriptions", PushSubscriptionRequest{
			Endpoint: "https://push.example.test/x", P256dh: subP256dh, Auth: subAuth, WriterID: "w"}},
		{http.MethodGet, "/api/v1/push/subscriptions", nil},
		{http.MethodDelete, "/api/v1/push/subscriptions", nil},
		{http.MethodDelete, "/api/v1/push/subscriptions/anything", nil},
	} {
		if rec := h.req(c.method, c.path, "", c.body); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a session: %d", c.method, c.path, rec.Code)
		}
	}
}

// TestTheVAPIDKeyRouteSaysWhenPushIsNotConfigured. A client that cannot get a
// key cannot subscribe, and the honest thing for it to render is "not set up on
// this server" rather than a switch that turns on and does nothing. A 200 with
// an empty string would make "unconfigured" a value every client has to
// remember to check.
func TestTheVAPIDKeyRouteSaysWhenPushIsNotConfigured(t *testing.T) {
	h := newHarness(t) // deliberately NOT webPushHarness
	rec := h.req(http.MethodGet, "/api/v1/push/vapid", "", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unconfigured vapid route: %d %s", rec.Code, rec.Body.String())
	}

	h.srv.VAPIDPublicKey = testVAPIDPublic
	rec = h.req(http.MethodGet, "/api/v1/push/vapid", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("configured vapid route: %d %s", rec.Code, rec.Body.String())
	}
	if got := decodeJSON[VAPIDResponse](t, rec); got.PublicKey != testVAPIDPublic {
		t.Fatalf("served key %q, want %q", got.PublicKey, testVAPIDPublic)
	}
}

// TestSubscribingIsRefusedWhenThereIsNoKeyToSendUnder. Storing a subscription
// against a deployment with no VAPID key produces a row that can never be
// delivered to and a user who believes notifications are on.
func TestSubscribingIsRefusedWhenThereIsNoKeyToSendUnder(t *testing.T) {
	h := newHarness(t)
	u := h.user("u")
	sess := h.session(u)
	w := enrolled(t, h, u, "browser")
	rec := subscribe(t, h, sess, w, "https://push.example.test/x")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("subscribe with no VAPID key: %d %s", rec.Code, rec.Body.String())
	}
	if got := subscriptionsOf(t, h, u); len(got) != 0 {
		t.Fatalf("an undeliverable subscription was stored: %v", got)
	}
}

// TestSubscribingRequiresALiveDeviceWriterOfThisAccount.
//
// writer_id is what makes a subscription revocable. Accepting an unknown one,
// another account's, the server's keyless ingest writer, or a revoked one would
// each produce a row that the corresponding revocation cannot reach — which is
// precisely the hole 00019 was written to close, reintroduced through a value
// the client picks.
func TestSubscribingRequiresALiveDeviceWriterOfThisAccount(t *testing.T) {
	h := webPushHarness(t)
	u, other := h.user("u"), h.user("other")
	sess := h.session(u)
	// The first enrolment spends the account's one TOFU self-approval, so every
	// writer after it needs THIS key to authorize — which is also what makes the
	// revoked case below reachable at all.
	minePriv := h.writer(u, "mine")
	const mine = "mine"
	theirs := enrolled(t, h, other, "theirs")

	revoked := enrolledSecond(t, h, u, "revoked", minePriv)
	h.revoke(u, revoked, minePriv)

	for _, c := range []struct{ name, writer string }{
		{"no such writer", "nobody"},
		{"another account's writer", theirs},
		{"the ingest writer", "ingest"},
		{"a revoked writer", revoked},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := subscribe(t, h, sess, c.writer, "https://push.example.test/"+c.writer)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("subscribe: %d %s", rec.Code, rec.Body.String())
			}
			// Every refusal must read identically, or the error text becomes a
			// way to enumerate an account's device roster.
			if !strings.Contains(rec.Body.String(), "invalid_writer") {
				t.Fatalf("refusal names a cause: %s", rec.Body.String())
			}
		})
	}

	if rec := subscribe(t, h, sess, mine, "https://push.example.test/ok"); rec.Code != http.StatusNoContent {
		t.Fatalf("a live device writer was refused: %d %s", rec.Code, rec.Body.String())
	}
}

// TestSubscribingRefusesAMalformedSubscription. Every one of these is also a
// CHECK constraint, so the point of the handler-level refusal is that the
// answer is a 400 the client can act on rather than a 500 with a Postgres
// constraint name in it — and that an http:// endpoint, which would send the
// VAPID Authorization header in clear, never reaches the database at all.
func TestSubscribingRefusesAMalformedSubscription(t *testing.T) {
	h := webPushHarness(t)
	u := h.user("u")
	sess := h.session(u)
	w := enrolled(t, h, u, "browser")

	for _, c := range []struct {
		name string
		req  PushSubscriptionRequest
	}{
		{"cleartext endpoint", PushSubscriptionRequest{Endpoint: "http://push.example.test/x", P256dh: subP256dh, Auth: subAuth, WriterID: w}},
		{"empty endpoint", PushSubscriptionRequest{Endpoint: "", P256dh: subP256dh, Auth: subAuth, WriterID: w}},
		{"endpoint with a newline", PushSubscriptionRequest{Endpoint: "https://push.example.test/x\nHost: evil", P256dh: subP256dh, Auth: subAuth, WriterID: w}},
		{"oversized endpoint", PushSubscriptionRequest{Endpoint: "https://push.example.test/" + strings.Repeat("x", 3000), P256dh: subP256dh, Auth: subAuth, WriterID: w}},
		{"short p256dh", PushSubscriptionRequest{Endpoint: "https://push.example.test/x", P256dh: "abc", Auth: subAuth, WriterID: w}},
		{"non-base64url auth", PushSubscriptionRequest{Endpoint: "https://push.example.test/x", P256dh: subP256dh, Auth: "not base64!!!!!!!!", WriterID: w}},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := h.req(http.MethodPost, "/api/v1/push/subscriptions", sess, c.req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("accepted %s: %d %s", c.name, rec.Code, rec.Body.String())
			}
		})
	}
	if got := subscriptionsOf(t, h, u); len(got) != 0 {
		t.Fatalf("a malformed subscription was stored: %v", got)
	}
}

// TestTheListingNeverReturnsAWholeEndpoint. An endpoint is the address anything
// can POST to; a listing that returned whole ones would hand every one of a
// user's subscriptions to anything holding a session. The host is what a person
// actually recognises, which is the job the listing has.
func TestTheListingNeverReturnsAWholeEndpoint(t *testing.T) {
	h := webPushHarness(t)
	u := h.user("u")
	sess := h.session(u)
	w := enrolled(t, h, u, "browser")
	const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/SECRETSECRETSECRET"
	if rec := subscribe(t, h, sess, w, endpoint); rec.Code != http.StatusNoContent {
		t.Fatalf("subscribe: %d %s", rec.Code, rec.Body.String())
	}

	rec := h.req(http.MethodGet, "/api/v1/push/subscriptions", sess, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "SECRETSECRETSECRET") {
		t.Fatalf("the listing returned the whole endpoint: %s", rec.Body.String())
	}
	got := decodeJSON[PushSubscriptionsResponse](t, rec)
	if len(got.Subscriptions) != 1 {
		t.Fatalf("listing has %d rows", len(got.Subscriptions))
	}
	if got.Subscriptions[0].EndpointHost != "updates.push.services.mozilla.com" {
		t.Fatalf("endpoint_host is %q", got.Subscriptions[0].EndpointHost)
	}
	// "current" is what lets a user tell two rows apart without reading a URL.
	if !got.Subscriptions[0].Current {
		t.Fatal("the row this very session created is not marked current")
	}
	if got.Max != pushv2.MaxDevicesPerUser {
		t.Fatalf("max is %d, want %d", got.Max, pushv2.MaxDevicesPerUser)
	}
}

// TestTheSubscriptionCapEvictsTheOldest, with the same expression pushv2
// notifies by — so the set the API keeps is exactly the set the sender would
// reach. Two independent constants would eventually disagree, and the symptom
// is a browser that is stored and never notified: silent, and
// indistinguishable from push being broken.
func TestTheSubscriptionCapEvictsTheOldest(t *testing.T) {
	h := webPushHarness(t)
	u := h.user("u")
	sess := h.session(u)
	w := enrolled(t, h, u, "browser")
	// The shipped push budget is a burst of 20, which is BELOW the number of
	// subscribes this test has to make to reach the cap. Widened here rather
	// than skipped: a t.Skip on a rate limit is a test that reports success
	// while asserting nothing, and this branch has shipped enough of those.
	// The limiter itself is covered by TestPushRoutesAreRateLimited.
	h.srv.PushPerUser = NewLimiter(1000, 1000, 64, nil)
	total := pushv2.MaxDevicesPerUser + 2
	for i := range total {
		rec := subscribe(t, h, sess, w, fmt.Sprintf("https://push.example.test/%03d", i))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("subscribe %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	got := subscriptionsOf(t, h, u)
	if len(got) != pushv2.MaxDevicesPerUser {
		t.Fatalf("stored %d subscriptions, want the cap of %d", len(got), pushv2.MaxDevicesPerUser)
	}
	joined := strings.Join(got, " ")
	if strings.Contains(joined, "/000") {
		t.Fatalf("the oldest subscription survived the cap: %v", got)
	}
	if !strings.Contains(joined, fmt.Sprintf("/%03d", total-1)) {
		t.Fatalf("the newest subscription was evicted by the cap: %v", got)
	}
}

// TestRevokingADeviceStopsItsWebPush is the property 00019 had to be written to
// add for Expo tokens, asserted here BEFORE the same hole can open for the PWA.
//
// A browser that was revoked, signed out or handed on must stop receiving. The
// content of the notification is nothing; its TIMING is a live feed of when the
// user spends.
func TestRevokingADeviceStopsItsWebPush(t *testing.T) {
	h := webPushHarness(t)
	u := h.user("u")
	sess := h.session(u)
	first := h.writer(u, "browser-one")
	second := enrolledSecond(t, h, u, "browser-two", first)

	if rec := subscribe(t, h, sess, "browser-one", "https://push.example.test/one"); rec.Code != http.StatusNoContent {
		t.Fatalf("subscribe one: %d %s", rec.Code, rec.Body.String())
	}
	if rec := subscribe(t, h, sess, second, "https://push.example.test/two"); rec.Code != http.StatusNoContent {
		t.Fatalf("subscribe two: %d %s", rec.Code, rec.Body.String())
	}

	h.revoke(u, second, first)
	got := subscriptionsOf(t, h, u)
	if len(got) != 1 || got[0] != "https://push.example.test/one" {
		t.Fatalf("after revoking browser-two the subscriptions are %v", got)
	}
}

// TestSigningOutStopsWebPushForThatSession is the other disowning gesture.
// Revoking a device key and ending a sign-in are different acts and both have
// to reach this table.
func TestSigningOutStopsWebPushForThatSession(t *testing.T) {
	h := webPushHarness(t)
	u := h.user("u")
	sess := h.session(u)
	w := enrolled(t, h, u, "browser")
	if rec := subscribe(t, h, sess, w, "https://push.example.test/one"); rec.Code != http.StatusNoContent {
		t.Fatalf("subscribe: %d %s", rec.Code, rec.Body.String())
	}
	if err := h.srv.Sessions.Revoke(bg, sess); err != nil {
		t.Fatal(err)
	}
	if got := subscriptionsOf(t, h, u); len(got) != 0 {
		t.Fatalf("signing out left %v subscribed", got)
	}
}

// TestUnsubscribingEverythingIsOneCall. The recovery a user needs is "make it
// stop", not "work out which of these five rows is the machine at my old job".
func TestUnsubscribingEverythingIsOneCall(t *testing.T) {
	h := webPushHarness(t)
	u := h.user("u")
	sess := h.session(u)
	w := enrolled(t, h, u, "browser")
	for i := range 3 {
		if rec := subscribe(t, h, sess, w, fmt.Sprintf("https://push.example.test/%d", i)); rec.Code != http.StatusNoContent {
			t.Fatalf("subscribe: %d %s", rec.Code, rec.Body.String())
		}
	}
	if rec := h.req(http.MethodDelete, "/api/v1/push/subscriptions", sess, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete all: %d %s", rec.Code, rec.Body.String())
	}
	if got := subscriptionsOf(t, h, u); len(got) != 0 {
		t.Fatalf("delete-all left %v", got)
	}
}
