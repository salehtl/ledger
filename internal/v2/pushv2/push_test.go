package pushv2

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

func newUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// newDeviceRow creates the writer and the session a push token now has to name.
// A token that names neither is what made a stolen phone's notifications
// unstoppable, so the schema no longer admits one and neither does this helper.
func newDeviceRow(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) (writerID string, sessionHash []byte) {
	t.Helper()
	writerID = "dev-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	pub := make([]byte, 32)
	if _, err := rand.Read(pub); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bg,
		`INSERT INTO writers (user_id, writer_id, kind, pubkey, registered_at)
		 VALUES ($1,$2,'device',$3,now())`, u, writerID, pub); err != nil {
		t.Fatal(err)
	}
	tok, err := (&auth.Sessions{Pool: pool, TTL: time.Hour}).Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	return writerID, auth.SessionHash(tok)
}

func addToken(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, tok string) {
	t.Helper()
	addTokenAt(t, pool, u, tok, time.Now())
}

func addTokenAt(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, tok string, at time.Time) {
	t.Helper()
	writerID, sessionHash := newDeviceRow(t, pool, u)
	if _, err := pool.Exec(bg,
		`INSERT INTO push_tokens (user_id, token, platform, writer_id, session_hash, created_at)
		 VALUES ($1,$2,'ios',$3,$4,$5)`, u, tok, writerID, sessionHash, at); err != nil {
		t.Fatal(err)
	}
}

// recorder is an Expo stand-in that captures every request body and answers
// with whatever the test chose.
type recorder struct {
	mu     sync.Mutex
	bodies [][]byte
	status int
	reply  string
}

func (r *recorder) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		r.bodies = append(r.bodies, b)
		status, reply := r.status, r.reply
		r.mu.Unlock()
		if status == 0 {
			status = http.StatusOK
		}
		if reply == "" {
			reply = `{"data":[{"status":"ok"}]}`
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}
}

func (r *recorder) captured() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte(nil), r.bodies...)
}

// TestPushPayloadIsContentFree is the whole reason this component exists before
// an app does. A notification body is rendered on a lock screen, is delivered
// through Apple's and Google's infrastructure, and is not covered by any
// encryption this design promises. So it says that something happened and
// nothing about what.
func TestPushPayloadIsContentFree(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]")

	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	got := rec.captured()
	if len(got) != 1 {
		t.Fatalf("sent %d requests, want 1", len(got))
	}
	for _, forbidden := range []string{"250.00", "CARREFOUR", "AED", "debit", "25000", "3701"} {
		if bytes.Contains(got[0], []byte(forbidden)) {
			t.Fatalf("push payload leaked %q: %s", forbidden, got[0])
		}
	}
	// Pinned exactly, not by absence: a later "helpful" field is the failure
	// this test exists to make impossible, and absence-checking a value nobody
	// thought of catches nothing.
	var body map[string]any
	if err := json.Unmarshal(got[0], &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"to":    "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
		"title": "New transaction",
		"body":  "",
	}
	if len(body) != len(want) {
		t.Fatalf("payload has %d fields, want exactly %d: %s", len(body), len(want), got[0])
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatalf("payload[%q] = %v, want %v", k, body[k], v)
		}
	}
}

// TestPushFailureDoesNotPropagate: a push is a courtesy. The transaction is
// already in the op log, and the client will see it on its next sync whether or
// not Expo was reachable.
func TestPushFailureDoesNotPropagate(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]")

	rec := &recorder{status: http.StatusInternalServerError, reply: `{"errors":[{"code":"boom"}]}`}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	var logged int
	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool,
		Logf: func(string, ...any) { logged++ }}
	if err := p.Notify(bg, user); err != nil {
		t.Fatalf("Notify returned %v for a delivery failure", err)
	}
	if logged == 0 {
		t.Fatal("a failed delivery was neither returned nor logged, so nobody can ever know")
	}
	// The token survives: a 500 says nothing about whether the device exists.
	if n := countTokens(t, pool, user); n != 1 {
		t.Fatalf("tokens = %d after a server error, want 1", n)
	}
}

// TestADeadDeviceIsForgotten: Expo's DeviceNotRegistered is the one error that
// means the token will never work again. Keeping it would push to a dead
// endpoint on every transaction for the life of the account.
func TestADeadDeviceIsForgotten(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[cccccccccccccccccccccc]")

	rec := &recorder{reply: `{"data":[{"status":"error","message":"...","details":{"error":"DeviceNotRegistered"}}]}`}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool, Logf: func(string, ...any) {}}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if n := countTokens(t, pool, user); n != 0 {
		t.Fatalf("tokens = %d, want 0", n)
	}
}

// TestASingleObjectReceiptIsUnderstoodToo: Expo answers a single-message POST
// with an object and a batched one with an array. Reading only one shape would
// make every receipt unreadable and every dead device permanent.
func TestASingleObjectReceiptIsUnderstoodToo(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[dddddddddddddddddddddd]")

	rec := &recorder{reply: `{"data":{"status":"error","details":{"error":"DeviceNotRegistered"}}}`}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool, Logf: func(string, ...any) {}}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if n := countTokens(t, pool, user); n != 0 {
		t.Fatalf("tokens = %d, want 0", n)
	}
}

func TestNoTokensSendsNothing(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if got := rec.captured(); len(got) != 0 {
		t.Fatalf("sent %d requests for a user with no devices", len(got))
	}
}

// TestOneRequestPerDevice: two devices, two notifications, and each one names
// only its own token.
func TestOneRequestPerDevice(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[eeeeeeeeeeeeeeeeeeeeee]")
	addToken(t, pool, user, "ExponentPushToken[ffffffffffffffffffffff]")

	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if got := rec.captured(); len(got) != 2 {
		t.Fatalf("sent %d requests, want 2", len(got))
	}
}

// TestAnotherUsersTokenIsNeverNotified: the query is scoped, and a shared token
// string (a phone handed on to somebody else) is not a channel into another
// account's activity.
func TestAnotherUsersTokenIsNeverNotified(t *testing.T) {
	pool := pgtest.New(t)
	a := newUser(t, pool)
	b := newUser(t, pool)
	addToken(t, pool, a, "ExponentPushToken[aaaa1111aaaa1111aaaa11]")
	addToken(t, pool, b, "ExponentPushToken[bbbb2222bbbb2222bbbb22]")

	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(bg, a); err != nil {
		t.Fatal(err)
	}
	got := rec.captured()
	if len(got) != 1 {
		t.Fatalf("sent %d requests, want 1", len(got))
	}
	if bytes.Contains(got[0], []byte("bbbb2222")) {
		t.Fatalf("user A's notification named user B's device: %s", got[0])
	}
}

// TestDisabledIsTheDefaultAndDoesNothing: cfg.Push.Enabled defaults to false, so
// this is what Phase 1 actually wires.
func TestDisabledIsTheDefaultAndDoesNothing(t *testing.T) {
	if err := (Disabled{}).Notify(bg, uuid.New()); err != nil {
		t.Fatalf("Disabled.Notify returned %v", err)
	}
}

// TestAnAccessTokenIsSentAsABearerCredential covers Expo's enhanced security
// mode. It is a credential, so it rides in a header and never in the body.
func TestAnAccessTokenIsSentAsABearerCredential(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[gggggggggggggggggggggg]")

	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"status":"ok"}]}`))
	}))
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool, AccessToken: "expo-secret"}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer expo-secret" {
		t.Fatalf("Authorization = %q", auth)
	}
}

// TestTheFanoutCapKeepsTheNewestDevices is the one that was wrong, not merely
// untested. `ORDER BY created_at` ascending with `LIMIT 20` kept the twenty
// OLDEST registrations, so a user with 21 devices had their newest phone — the
// one in their hand — excluded from every notification, silently, while
// registration still answered 204. For a feature whose entire value is
// "instant", being off with nothing saying so is the worst available failure.
func TestTheFanoutCapKeepsTheNewestDevices(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)

	base := time.Now().Add(-48 * time.Hour)
	var oldest, newest string
	for i := 0; i < MaxDevicesPerUser+1; i++ {
		tok := fmt.Sprintf("ExponentPushToken[device%03d]", i)
		addTokenAt(t, pool, user, tok, base.Add(time.Duration(i)*time.Hour))
		if i == 0 {
			oldest = tok
		}
		newest = tok
	}

	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	var logs []string
	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool,
		Logf: func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}

	got := rec.captured()
	if len(got) != MaxDevicesPerUser {
		t.Fatalf("sent %d requests, want the cap of %d", len(got), MaxDevicesPerUser)
	}
	var notified []string
	for _, b := range got {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		notified = append(notified, m["to"].(string))
	}
	if !slices.Contains(notified, newest) {
		t.Fatalf("the newest device %q was not notified; the cap dropped the phone the user is holding", newest)
	}
	if slices.Contains(notified, oldest) {
		t.Fatalf("the oldest device %q was notified over a newer one", oldest)
	}
	// And it is not silent. A cap that drops a user's devices without a word is
	// how this stayed invisible in the first place.
	if !slices.ContainsFunc(logs, func(s string) bool { return strings.Contains(s, "more than") }) {
		t.Fatalf("exceeding the device cap logged nothing: %q", logs)
	}
}

// TestTheAccessTokenNeverRidesInTheBody: the credential is a HEADER. A body is
// the thing that gets logged by a proxy, echoed by an error handler and edited
// by every future maintainer; the existing coverage asserted the header was
// present and never that the body was clean, so adding the token to the JSON
// passed the whole suite.
func TestTheAccessTokenNeverRidesInTheBody(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	const tok = "ExponentPushToken[hhhhhhhhhhhhhhhhhhhhhh]"
	addToken(t, pool, user, tok)

	const secret = "expo-secret-do-not-leak"
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool, AccessToken: secret}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	got := rec.captured()
	if len(got) != 1 {
		t.Fatalf("sent %d requests, want 1", len(got))
	}
	if bytes.Contains(got[0], []byte(secret)) {
		t.Fatalf("the Expo access token leaked into the request body: %s", got[0])
	}
	// Pinned exactly, for the same reason the content-free test is: the payload
	// has three fields WITH a credential configured, not just without one.
	var body map[string]any
	if err := json.Unmarshal(got[0], &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"to": tok, "title": Title, "body": ""}
	if len(body) != len(want) {
		t.Fatalf("payload has %d fields, want exactly %d: %s", len(body), len(want), got[0])
	}
	for k, v := range want {
		if body[k] != v {
			t.Fatalf("payload[%q] = %v, want %v", k, body[k], v)
		}
	}
}

// TestANon2xxIsDetectedEvenWhenTheBodyIsWellFormed closes a false-confidence
// trap. TestPushFailureDoesNotPropagate looks like it covers a failed status,
// and does not: its 500 body has no "data" key, so the receipt decoder errors
// independently and the assertion still fires with the status check DELETED.
// A real Expo 429 or 503 carrying a well-formed body would have been recorded
// as a successful delivery.
func TestANon2xxIsDetectedEvenWhenTheBodyIsWellFormed(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[iiiiiiiiiiiiiiiiiiiiii]")

	rec := &recorder{status: http.StatusTooManyRequests, reply: `{"data":[{"status":"ok"}]}`}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	var logs []string
	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool,
		Logf: func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }}
	if err := p.Notify(bg, user); err != nil {
		t.Fatalf("Notify returned %v; a delivery failure must not propagate", err)
	}
	if !slices.ContainsFunc(logs, func(s string) bool { return strings.Contains(s, "429") }) {
		t.Fatalf("a 429 with a well-formed body was recorded as a success: %q", logs)
	}
	if n := countTokens(t, pool, user); n != 1 {
		t.Fatalf("tokens = %d after a 429, want 1: a rate limit is not a dead device", n)
	}
}

// TestATransientExpoErrorKeepsTheDevice pins the "one permanent error" rule
// that is the entire justification for the deviceNotRegistered constant.
// Widening it to "any error" — which the suite used to accept — mass-forgets
// every device on the first rate-limit blip, and a forgotten token cannot be
// recovered by the server: it comes back only when that app next launches.
func TestATransientExpoErrorKeepsTheDevice(t *testing.T) {
	pool := pgtest.New(t)
	for _, expoErr := range []string{"MessageRateExceeded", "MessageTooBig", "InvalidCredentials", ""} {
		t.Run("err="+expoErr, func(t *testing.T) {
			user := newUser(t, pool)
			addToken(t, pool, user, "ExponentPushToken[transient"+expoErr+"]")

			rec := &recorder{reply: fmt.Sprintf(
				`{"data":[{"status":"error","message":"...","details":{"error":%q}}]}`, expoErr)}
			srv := httptest.NewServer(rec.handler())
			defer srv.Close()

			p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool, Logf: func(string, ...any) {}}
			if err := p.Notify(bg, user); err != nil {
				t.Fatal(err)
			}
			if n := countTokens(t, pool, user); n != 1 {
				t.Fatalf("tokens = %d after a %q receipt, want 1: only DeviceNotRegistered is permanent", n, expoErr)
			}
		})
	}
}

// TestTheRequestIsWellFormedForExpo. Expo answers a POST without a JSON
// content type with a 400, so an unset header is a push path that is 100%
// broken and looks — in the journal, which is the only signal — exactly like
// Expo being unhappy for some other reason.
func TestTheRequestIsWellFormedForExpo(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[jjjjjjjjjjjjjjjjjjjjjj]")

	var method, ctype, accept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, ctype, accept = r.Method, r.Header.Get("Content-Type"), r.Header.Get("Accept")
		_, _ = w.Write([]byte(`{"data":[{"status":"ok"}]}`))
	}))
	defer srv.Close()

	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPost {
		t.Fatalf("method = %q, want POST", method)
	}
	if ctype != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ctype)
	}
	if accept != "application/json" {
		t.Fatalf("Accept = %q, want application/json", accept)
	}
}

// TestAnOversizedExpoResponseIsBounded: the receipt is read through a 64 KB
// LimitReader whose comment says "an endpoint that answers with a gigabyte must
// not be able to make this allocate one". Nothing checked that. The response
// here is valid JSON that only parses if the limit did NOT bind, so a deleted
// bound is a green test turning red rather than a slow one.
func TestAnOversizedExpoResponseIsBounded(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[kkkkkkkkkkkkkkkkkkkkkk]")

	huge := `{"data":[{"status":"ok"}],"pad":"` + strings.Repeat("p", 256<<10) + `"}`
	rec := &recorder{reply: huge}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()

	var logs []string
	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool,
		Logf: func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }}
	if err := p.Notify(bg, user); err != nil {
		t.Fatalf("Notify returned %v; an oversized receipt must not propagate", err)
	}
	if len(logs) == 0 {
		t.Fatal("a 256 KB receipt was read whole: the 64 KB bound did not bind")
	}
}

// TestNotifyRefusesAnUnusableConfiguration. Both guards are cheap and both
// failures are silent without them: a nil pool would panic on the ingest path,
// and a zero user id would SELECT nothing and report success forever.
func TestNotifyRefusesAnUnusableConfiguration(t *testing.T) {
	pool := pgtest.New(t)
	if err := (&Expo{}).Notify(bg, uuid.New()); err == nil {
		t.Fatal("Notify with no pool returned nil")
	}
	if err := (&Expo{Pool: pool}).Notify(bg, uuid.Nil); err == nil {
		t.Fatal("Notify with a zero user id returned nil")
	}
}

// TestATokenReadFailureIsReturned: Notify swallows DELIVERY failures on
// purpose, and must not swallow a STORE failure. They are different facts —
// "Expo was unreachable" versus "this process cannot read its own database" —
// and only the second is worth waking somebody for.
func TestATokenReadFailureIsReturned(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	addToken(t, pool, user, "ExponentPushToken[llllllllllllllllllllll]")
	pool.Close()

	p := &Expo{Endpoint: "http://127.0.0.1:1", Pool: pool, Logf: func(string, ...any) {}}
	if err := p.Notify(bg, user); err == nil {
		t.Fatal("Notify returned nil when the token store was unreadable")
	}
}

// TestARevokedSessionsDeviceIsNotNotified is C1 seen from the end that matters:
// not "a row was deleted" but "the phone stops receiving". Before 00019,
// signing out left the token in place and the notifications running.
func TestARevokedSessionsDeviceIsNotNotified(t *testing.T) {
	pool := pgtest.New(t)
	user := newUser(t, pool)
	sessions := &auth.Sessions{Pool: pool, TTL: time.Hour}

	token, err := sessions.Issue(bg, user)
	if err != nil {
		t.Fatal(err)
	}
	writerID, _ := newDeviceRow(t, pool, user)
	if _, err := pool.Exec(bg,
		`INSERT INTO push_tokens (user_id, token, platform, writer_id, session_hash)
		 VALUES ($1,$2,'ios',$3,$4)`,
		user, "ExponentPushToken[signedout00signedout00]", writerID, auth.SessionHash(token)); err != nil {
		t.Fatal(err)
	}

	if err := sessions.Revoke(bg, token); err != nil {
		t.Fatal(err)
	}

	rec := &recorder{}
	srv := httptest.NewServer(rec.handler())
	defer srv.Close()
	p := &Expo{Endpoint: srv.URL, HTTP: srv.Client(), Pool: pool}
	if err := p.Notify(bg, user); err != nil {
		t.Fatal(err)
	}
	if got := rec.captured(); len(got) != 0 {
		t.Fatalf("a signed-out device was still notified: %s", got)
	}
}

func countTokens(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM push_tokens WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
