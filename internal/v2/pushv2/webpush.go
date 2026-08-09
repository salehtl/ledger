package pushv2

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"slices"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WebTitle is the entire content of a web push notification.
//
// It is a constant, exported, and shared with nothing else, so that "make it
// say what was bought" is a change to THIS line rather than a parameter
// somebody threads in from the ingest pipeline. [Pusher.Notify]'s signature
// already refuses the data — it is handed a user id and nothing else — and this
// is the other half of that: there is no code path in this package that can
// interpolate a merchant, an amount, a category or a count into a payload.
//
// The client does not trust it either. web/src/lib/pushNotification.ts renders
// its OWN constant and never reads a server-supplied string, so a future
// version of this server cannot make an old client display text.
const WebTitle = "New activity"

// webPayloadJSON is the exact body every web push carries, forever.
//
// A struct with ONE field and no omitempty, marshalled once at init: a second
// field cannot be added anywhere else in the process, and an empty one cannot
// be silently dropped. TestTheWebPushPayloadIsContentFree pins these bytes
// literally rather than checking for the absence of particular words — absence
// checks only catch the leaks somebody already thought of.
var webPayloadJSON = mustMarshalWebPayload()

func mustMarshalWebPayload() []byte {
	b, err := json.Marshal(struct {
		Title string `json:"title"`
	}{Title: WebTitle})
	if err != nil {
		// Unreachable: a struct of one string always marshals. Panicking rather
		// than returning an error keeps the payload a package-level constant
		// instead of something every call site has to handle failing.
		panic("pushv2: marshalling the web push payload: " + err.Error())
	}
	return b
}

// WebPayload is the plaintext body of every web push this server sends.
//
// Cloned per call because the caller hands it to an encryption routine, and a
// package-level slice that anything could write through would be a payload
// whose contents depend on call order.
func WebPayload() []byte { return slices.Clone(webPayloadJSON) }

// webTTL is how long a push service may hold an undelivered notification.
//
// Short on purpose. This notification says only that something arrived, and the
// client syncs on launch regardless, so a copy delivered hours later tells a
// user nothing they have not already seen — while still announcing, on a lock
// screen, that they spent money at some unstated point in the past. Expiring it
// is strictly better than delivering it late.
const webTTL = 300

// webSendTimeout bounds one delivery. The transaction is already committed and
// in the op log by the time Notify is called; a slow push service must not hold
// the ingest path open.
const webSendTimeout = 10 * time.Second

// Web delivers content-free notifications to browsers over the Web Push
// protocol (RFC 8030) with VAPID (RFC 8292).
//
// # What the encryption here does and does not buy
//
// Every payload is sealed to the subscription's own p256dh/auth pair before it
// leaves this box, so the push service — Apple's, Google's or Mozilla's — sees
// ciphertext. That is worth having and it is NOT the reason the payload is
// content-free. Two things survive the encryption:
//
//   - Timing and volume. The push service learns that an account received a
//     notification and exactly when. A series of those is a spending diary
//     with the amounts redacted.
//   - The plaintext existing here at all. After Phase 3 this server holds
//     ciphertext; composing a body from a merchant and an amount means
//     decrypting user data on the server to build a string. Encrypting that
//     string a moment later does not undo having composed it.
//
// So the rule is the payload, not the transport. See [WebTitle].
type Web struct {
	// Pool reads push_subscriptions. Required.
	Pool *pgxpool.Pool
	// VAPIDPublic and VAPIDPrivate are the application server key pair. Both
	// required: they are what identifies this deployment to the push service,
	// and the public half is also what the browser subscribed under, so a key
	// change silently invalidates every stored subscription.
	VAPIDPublic  string
	VAPIDPrivate string
	// Subscriber is the VAPID `sub` claim: a mailto: or https: URL a push
	// service operator can use to reach whoever runs this deployment.
	Subscriber string
	// HTTP defaults to a client with webSendTimeout.
	HTTP *http.Client
	// Logf receives delivery failures. Defaults to log.Printf.
	Logf func(format string, args ...any)

	// send is the transport seam, and it exists for one reason: a test must be
	// able to see the EXACT bytes handed to the encryption routine. Once
	// webpush has sealed them they are indistinguishable from any other
	// ciphertext, so an assertion made downstream of this point could not tell
	// a content-free payload from one carrying a merchant name.
	//
	// nil in production, where sendWebPush is used.
	send func(ctx context.Context, sub *webpush.Subscription, payload []byte) (int, error)
}

func (w *Web) logf(format string, args ...any) {
	if w.Logf != nil {
		w.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (w *Web) client() *http.Client {
	if w.HTTP != nil {
		return w.HTTP
	}
	return &http.Client{Timeout: webSendTimeout}
}

// webSubscription is one row of push_subscriptions, as the sender needs it.
type webSubscription struct {
	endpoint string
	p256dh   string
	auth     string
}

// webFanoutOrder is the order browsers are notified in, and the order the cap
// is applied in. DESCENDING by creation, exactly as [fanoutOrder] is and for
// the same reason: the casualty of the cap must always be a browser the user
// stopped using, never the one in their hand.
//
// api.evictPushSubscriptionsOverCap evicts by the identical expression.
const webFanoutOrder = `ORDER BY created_at DESC, endpoint DESC`

// Notify tells every browser this user has subscribed that something arrived.
//
// It returns an error only for a failure to READ the subscription list. A
// delivery failure is logged and swallowed, because a push is a courtesy: the
// transaction is already in the op log and the client will see it on its next
// sync whether or not the push service answered.
func (w *Web) Notify(ctx context.Context, userID uuid.UUID) error {
	if w == nil || w.Pool == nil {
		return fmt.Errorf("pushv2: no pool")
	}
	if userID == uuid.Nil {
		return fmt.Errorf("pushv2: user id is zero")
	}
	subs, err := w.subscriptions(ctx, userID)
	if err != nil {
		return err
	}
	payload := WebPayload()
	for _, s := range subs {
		gone, err := w.deliver(ctx, s, payload)
		switch {
		case err != nil:
			// Logged, never returned, and the row is left alone: a network
			// error or a 500 from the push service says nothing about whether
			// the browser still holds this subscription.
			w.logf("pushv2: web push to user %s: %v", userID, err)
		case gone:
			// 404/410 is the one permanent answer in RFC 8030: the push service
			// itself says this subscription no longer exists. Unlike the Expo
			// path — which only learns about a dead device from a RECEIPT it
			// never fetches — this arrives inline, so a browser that cleared
			// its site data or revoked permission stops costing a request per
			// transaction the first time we try it.
			if err := w.forget(ctx, userID, s.endpoint); err != nil {
				w.logf("pushv2: forgetting a gone subscription for user %s: %v", userID, err)
			}
		}
	}
	return nil
}

func (w *Web) subscriptions(ctx context.Context, userID uuid.UUID) ([]webSubscription, error) {
	// LIMIT is the cap PLUS ONE, deliberately: it distinguishes "exactly the
	// cap" from "more than the cap", and only the second is worth a log line.
	rows, err := w.Pool.Query(ctx,
		`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 `+
			webFanoutOrder+` LIMIT $2`,
		userID, MaxDevicesPerUser+1)
	if err != nil {
		return nil, fmt.Errorf("pushv2: read push subscriptions: %w", err)
	}
	defer rows.Close()
	var out []webSubscription
	for rows.Next() {
		var s webSubscription
		if err := rows.Scan(&s.endpoint, &s.p256dh, &s.auth); err != nil {
			return nil, fmt.Errorf("pushv2: read push subscriptions: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pushv2: read push subscriptions: %w", err)
	}
	if len(out) > MaxDevicesPerUser {
		// Registration evicts down to the cap already, so reaching here means
		// the two enforcement points disagree or something wrote this table
		// directly. Either way an operator should hear about it.
		w.logf("pushv2: user %s has more than %d push subscriptions; notifying the %d most recent only",
			userID, MaxDevicesPerUser, MaxDevicesPerUser)
		out = out[:MaxDevicesPerUser]
	}
	return out, nil
}

func (w *Web) forget(ctx context.Context, userID uuid.UUID, endpoint string) error {
	_, err := w.Pool.Exec(ctx,
		`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, userID, endpoint)
	return err
}

// deliver sends one notification and reports whether the push service says the
// subscription is permanently gone.
func (w *Web) deliver(ctx context.Context, s webSubscription, payload []byte) (gone bool, err error) {
	sub := &webpush.Subscription{
		Endpoint: s.endpoint,
		Keys:     webpush.Keys{P256dh: s.p256dh, Auth: s.auth},
	}
	sendFn := w.send
	if sendFn == nil {
		sendFn = w.sendWebPush
	}
	status, err := sendFn(ctx, sub, payload)
	if err != nil {
		return false, err
	}
	switch {
	case status == http.StatusNotFound || status == http.StatusGone:
		return true, nil
	case status/100 != 2:
		return false, fmt.Errorf("push service answered %d", status)
	}
	return false, nil
}

func (w *Web) sendWebPush(ctx context.Context, sub *webpush.Subscription, payload []byte) (int, error) {
	resp, err := webpush.SendNotificationWithContext(ctx, payload, sub, &webpush.Options{
		HTTPClient:      w.client(),
		Subscriber:      w.Subscriber,
		VAPIDPublicKey:  w.VAPIDPublic,
		VAPIDPrivateKey: w.VAPIDPrivate,
		TTL:             webTTL,
		// Low, not high. The whole message is "something arrived"; waking a
		// phone out of a doze cycle for that is a battery cost with no
		// corresponding value, and push services throttle senders that claim
		// high urgency for everything.
		Urgency: webpush.UrgencyNormal,
	})
	if err != nil {
		return 0, err
	}
	// The body is a diagnostic string at best and is never read; closing it is
	// what returns the connection to the pool.
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// GenerateVAPIDKeys mints an application server key pair, base64url-encoded.
//
// Nothing in cmd/ledgerd calls it, and that is deliberate: a key-minting
// subcommand next to a running server is an invitation to run it twice, and the
// second run silently invalidates every row in push_subscriptions — the public
// half is what every browser subscribed under — with nothing telling the users
// to subscribe again. The operator mints ONE pair with the v1 binary's
// `ledger vapid-keys`, which encodes through this same library.
//
// It is exported here so the format this package SENDS with and the format the
// tests generate under have one source; TestARealSendIsEncryptedAndVAPIDSigned
// signs with a pair from this function.
func GenerateVAPIDKeys() (private, public string, err error) {
	return webpush.GenerateVAPIDKeys()
}
