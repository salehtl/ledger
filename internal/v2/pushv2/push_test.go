package pushv2

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

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

func addToken(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, tok string) {
	t.Helper()
	if _, err := pool.Exec(bg,
		`INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,'ios')`, u, tok); err != nil {
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

func countTokens(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM push_tokens WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
