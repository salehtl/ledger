package pushv2

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

// A syntactically valid subscription, as a browser would produce one. The key
// material is real (generated once, checked in) because webpush-go performs the
// ECDH before it will send anything, so a placeholder string would make
// TestARealSendIsEncryptedAndVAPIDSigned fail for the wrong reason.
const (
	testP256dh = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"
	testAuth   = "8eDyX_uCN0XRhSbY5hs7Hg"
)

func newSubscription(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, endpoint string) {
	t.Helper()
	writerID, sessionHash := newDeviceRow(t, pool, u)
	if _, err := pool.Exec(bg,
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, writer_id, session_hash)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		u, endpoint, testP256dh, testAuth, writerID, sessionHash); err != nil {
		t.Fatal(err)
	}
}

func endpointsOf(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) []string {
	t.Helper()
	rows, err := pool.Query(bg,
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

// webRecorder captures the EXACT bytes handed to the encryption routine, which is
// the last point at which the payload is readable. Everything downstream is
// ciphertext, so an assertion made there could not tell a content-free payload
// from one carrying a merchant name.
type webRecorder struct {
	mu      sync.Mutex
	sent    [][]byte
	targets []string
	status  int
	err     error
}

func (r *webRecorder) send(_ context.Context, sub *webpush.Subscription, payload []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, bytes.Clone(payload))
	r.targets = append(r.targets, sub.Endpoint)
	if r.status == 0 {
		return http.StatusCreated, r.err
	}
	return r.status, r.err
}

// TestTheWebPushPayloadIsContentFree is the guard on the ONE decision this
// whole path exists to keep: a notification says that something arrived and
// nothing about what.
//
// It pins the serialised body BYTE FOR BYTE rather than checking that it does
// not contain "AED" or a merchant name. An absence check only catches the leaks
// somebody already thought of; a future edit that adds `"amount":24000` passes
// every absence check ever written and fails this one on the first run.
//
// The field set is asserted separately so that the failure message names the
// added field rather than showing two long strings that differ somewhere.
func TestTheWebPushPayloadIsContentFree(t *testing.T) {
	const want = `{"title":"New activity"}`
	if got := string(WebPayload()); got != want {
		t.Fatalf("web push payload is %s, want %s\n\nIf you added a field to make the notification "+
			"more useful: that is the decision this test exists to refuse. The server holds "+
			"ciphertext after Phase 3; composing a body from a merchant and an amount means "+
			"decrypting user data here to build a string that then transits Apple's or Google's "+
			"push service.", got, want)
	}

	var fields map[string]any
	if err := json.Unmarshal(WebPayload(), &fields); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if len(fields) != 1 {
		t.Fatalf("payload has %d fields (%v), want exactly one: title", len(fields), fields)
	}
	if fields["title"] != WebTitle {
		t.Fatalf("payload title is %v, want %q", fields["title"], WebTitle)
	}
}

// TestWebPayloadCannotBeMutatedThroughAPreviousCaller: the payload is a
// package-level slice, so handing the same backing array to every caller would
// make the contents of a notification depend on what an earlier one did with
// its copy.
func TestWebPayloadCannotBeMutatedThroughAPreviousCaller(t *testing.T) {
	first := WebPayload()
	for i := range first {
		first[i] = 'x'
	}
	if got := string(WebPayload()); got != `{"title":"New activity"}` {
		t.Fatalf("a caller overwrote the shared payload: now %s", got)
	}
}

// TestWebNotifySendsTheContentFreePayloadToEveryBrowser covers the fan-out and,
// more importantly, asserts on the payload AT THE SEND — the composed-per-user
// path, not the constant. A Notify that built its own body would satisfy
// TestTheWebPushPayloadIsContentFree and fail here.
func TestWebNotifySendsTheContentFreePayloadToEveryBrowser(t *testing.T) {
	pool := pgtest.New(t)
	u := newUser(t, pool)
	for _, e := range []string{
		"https://push.example.test/a",
		"https://push.example.test/b",
	} {
		newSubscription(t, pool, u, e)
	}
	// Another account's subscription must not be notified.
	other := newUser(t, pool)
	newSubscription(t, pool, other, "https://push.example.test/other")

	rec := &webRecorder{}
	w := &Web{Pool: pool, VAPIDPublic: "pub", VAPIDPrivate: "priv", Subscriber: "mailto:o@example.test", send: rec.send}
	if err := w.Notify(bg, u); err != nil {
		t.Fatalf("Notify: %v", err)
	}

	if len(rec.sent) != 2 {
		t.Fatalf("sent %d notifications, want 2 (targets %v)", len(rec.sent), rec.targets)
	}
	for i, body := range rec.sent {
		if string(body) != `{"title":"New activity"}` {
			t.Fatalf("notification %d carried %s", i, body)
		}
	}
	for _, target := range rec.targets {
		if target == "https://push.example.test/other" {
			t.Fatal("notified another account's subscription")
		}
	}
}

// TestWebNotifyForgetsASubscriptionThePushServiceSaysIsGone. 404/410 is the one
// permanent answer in RFC 8030. Leaving the row would mean an outbound request
// per transaction, forever, for a browser that cleared its site data.
func TestWebNotifyForgetsASubscriptionThePushServiceSaysIsGone(t *testing.T) {
	pool := pgtest.New(t)
	u := newUser(t, pool)
	newSubscription(t, pool, u, "https://push.example.test/gone")

	rec := &webRecorder{status: http.StatusGone}
	w := &Web{Pool: pool, send: rec.send}
	if err := w.Notify(bg, u); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := endpointsOf(t, pool, u); len(got) != 0 {
		t.Fatalf("a gone subscription survived: %v", got)
	}
}

// TestWebNotifyKeepsASubscriptionThatMerelyFailed is the other half, and it is
// the one that matters more: a 500 or a dropped connection says nothing about
// whether the browser still holds the subscription, and deleting on it would
// switch a user's notifications off the next time their push service had a bad
// afternoon.
func TestWebNotifyKeepsASubscriptionThatMerelyFailed(t *testing.T) {
	pool := pgtest.New(t)
	u := newUser(t, pool)
	newSubscription(t, pool, u, "https://push.example.test/flaky")

	for _, tc := range []struct {
		name string
		rec  *webRecorder
	}{
		{"server error", &webRecorder{status: http.StatusInternalServerError}},
		{"transport error", &webRecorder{err: fmt.Errorf("connection reset")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := &Web{Pool: pool, Logf: func(string, ...any) {}, send: tc.rec.send}
			if err := w.Notify(bg, u); err != nil {
				t.Fatalf("Notify: %v", err)
			}
			if got := endpointsOf(t, pool, u); len(got) != 1 {
				t.Fatalf("a transient failure deleted the subscription: %v", got)
			}
		})
	}
}

// TestTheWebCapKeepsTheNewestSubscriptions. Ascending order was a real defect
// on the Expo path (00019): a user past the cap had the device in their hand
// excluded from every notification while everything still answered 204.
func TestTheWebCapKeepsTheNewestSubscriptions(t *testing.T) {
	pool := pgtest.New(t)
	u := newUser(t, pool)
	writerID, sessionHash := newDeviceRow(t, pool, u)
	total := MaxDevicesPerUser + 3
	for i := range total {
		// created_at ascending with i, so the highest i is the newest.
		if _, err := pool.Exec(bg,
			`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, writer_id, session_hash, created_at)
			 VALUES ($1,$2,$3,$4,$5,$6, now() + $7::interval)`,
			u, fmt.Sprintf("https://push.example.test/%03d", i), testP256dh, testAuth,
			writerID, sessionHash, fmt.Sprintf("%d seconds", i)); err != nil {
			t.Fatal(err)
		}
	}

	rec := &webRecorder{}
	w := &Web{Pool: pool, Logf: func(string, ...any) {}, send: rec.send}
	if err := w.Notify(bg, u); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if len(rec.targets) != MaxDevicesPerUser {
		t.Fatalf("notified %d subscriptions, want the cap of %d", len(rec.targets), MaxDevicesPerUser)
	}
	newest := fmt.Sprintf("https://push.example.test/%03d", total-1)
	oldest := fmt.Sprintf("https://push.example.test/%03d", 0)
	if !strings.Contains(strings.Join(rec.targets, " "), newest) {
		t.Fatalf("the newest subscription %s was excluded by the cap: %v", newest, rec.targets)
	}
	if strings.Contains(strings.Join(rec.targets, " "), oldest) {
		t.Fatalf("the oldest subscription %s survived the cap: %v", oldest, rec.targets)
	}
}

// TestARealSendIsEncryptedAndVAPIDSigned runs the production transport (no
// seam) against a fake push service.
//
// It is what stops the content-free assertions above from being vacuous in the
// other direction: it proves the bytes WebPayload returns are the bytes that
// actually get encrypted and sent, and that they leave this box sealed and
// under a VAPID signature rather than as the readable JSON the seam sees.
func TestARealSendIsEncryptedAndVAPIDSigned(t *testing.T) {
	priv, pub, err := GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}

	type capture struct {
		body []byte
		auth string
		ce   string
	}
	got := make(chan capture, 1)
	// TLS, not plain http: push_subscriptions_endpoint_is_bounded_https refuses
	// an http:// endpoint, so a cleartext test server could not even be stored —
	// which is the constraint doing its job, and the reason the client below has
	// to be the one httptest hands out.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		got <- capture{body: raw, auth: r.Header.Get("Authorization"), ce: r.Header.Get("Content-Encoding")}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	pool := pgtest.New(t)
	u := newUser(t, pool)
	newSubscription(t, pool, u, srv.URL+"/sub")

	w := &Web{Pool: pool, VAPIDPublic: pub, VAPIDPrivate: priv, Subscriber: "mailto:ops@example.test", HTTP: srv.Client()}
	if err := w.Notify(bg, u); err != nil {
		t.Fatalf("Notify: %v", err)
	}

	c := <-got
	if !strings.HasPrefix(c.auth, "vapid ") {
		t.Fatalf("Authorization header is %q, want a vapid scheme", c.auth)
	}
	if c.ce != "aes128gcm" {
		t.Fatalf("Content-Encoding is %q, want aes128gcm", c.ce)
	}
	if bytes.Contains(c.body, []byte("title")) || bytes.Contains(c.body, []byte(WebTitle)) {
		t.Fatalf("the payload reached the push service in the clear: %q", c.body)
	}
	// The subscription must survive a 201 — only 404/410 retire one.
	if len(endpointsOf(t, pool, u)) != 1 {
		t.Fatal("a successful send deleted the subscription")
	}
}

// TestMultiNotifiesEveryChannelEvenWhenOneFails. The Expo audience and the Web
// Push audience are independent, so a browser subscription must not go
// unnotified because a token list could not be read.
func TestMultiNotifiesEveryChannelEvenWhenOneFails(t *testing.T) {
	var reached bool
	m := Multi{
		notifierFunc(func(context.Context, uuid.UUID) error { return fmt.Errorf("expo is down") }),
		notifierFunc(func(context.Context, uuid.UUID) error { reached = true; return nil }),
		nil,
	}
	err := m.Notify(bg, uuid.New())
	if !reached {
		t.Fatal("a failing sender short-circuited the one after it")
	}
	if err == nil || !strings.Contains(err.Error(), "expo is down") {
		t.Fatalf("Multi.Notify returned %v, want the joined failure", err)
	}
}

type notifierFunc func(context.Context, uuid.UUID) error

func (f notifierFunc) Notify(ctx context.Context, u uuid.UUID) error { return f(ctx, u) }
