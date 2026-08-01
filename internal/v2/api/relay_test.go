package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/config"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/ingest"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/relay"
	"ledger/internal/v2/smtpd"
)

const relayToken = "relay-token-0123456789"

// recordingHandler is the ingest seam, when the test's subject is the endpoint
// rather than the pipeline.
type recordingHandler struct {
	mu   sync.Mutex
	got  []smtpd.Delivery
	fail error
}

func (h *recordingHandler) Deliver(_ context.Context, d smtpd.Delivery) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != nil {
		return h.fail
	}
	h.got = append(h.got, d)
	return nil
}

func (h *recordingHandler) calls() []smtpd.Delivery {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]smtpd.Delivery(nil), h.got...)
}

type relayHarness struct {
	*harness
	mail *recordingHandler
}

func newRelayHarness(t *testing.T) *relayHarness {
	t.Helper()
	h := newHarness(t)
	h.srv.Addresses = &addresses.Addresses{
		Pool:   h.pool,
		Suffix: "@in.example.test",
		Grace:  addresses.DefaultGrace,
		Now:    time.Now,
	}
	mail := &recordingHandler{}
	h.srv.Mail = mail
	h.srv.RelayToken = relayToken
	h.h = h.srv.Handler()
	return &relayHarness{harness: h, mail: mail}
}

// relayReq issues a request with an arbitrary bearer credential, so a test can
// present a session token where a relay token is expected and vice versa.
func (h *relayHarness) relayReq(method, path, token string, body any) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.req(method, path, token, body)
}

func (h *relayHarness) issue(u uuid.UUID) string {
	h.t.Helper()
	local, err := h.srv.Addresses.Issue(bg, u)
	if err != nil {
		h.t.Fatal(err)
	}
	return local
}

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

func TestDeliverEndpointRejectsAWrongToken(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	local := h.issue(u)
	body := map[string]any{
		"local_part": local,
		"raw":        base64.StdEncoding.EncodeToString([]byte("Subject: x\r\n\r\nx\r\n")),
	}
	for name, token := range map[string]string{
		"no token":      "",
		"wrong token":   "relay-token-0123456788",
		"prefix":        "relay-token-012345678",
		"session token": h.session(u),
		"admin-ish":     "admin-token",
		"empty-ish":     " ",
	} {
		t.Run(name, func(t *testing.T) {
			rec := h.relayReq(http.MethodPost, relayDeliverPath, token, body)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("POST %s with %s = %d, want 401", relayDeliverPath, name, rec.Code)
			}
		})
	}
	if got := h.mail.calls(); len(got) != 0 {
		t.Fatalf("%d messages were delivered by unauthenticated calls", len(got))
	}
}

// A USER SESSION is not a relay credential, in either direction. The first half
// is above; this is the one that matters more — a stolen session must not be
// able to read every account's inbound address.
func TestASessionCannotReadTheAddressReplica(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	h.issue(u)
	rec := h.relayReq(http.MethodGet, relayAddressesPath, h.session(u), nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET %s with a session = %d, want 401", relayAddressesPath, rec.Code)
	}
	if strings.Contains(rec.Body.String(), "local_part") {
		t.Fatalf("the rejection leaked address data: %s", rec.Body.String())
	}
}

// And the relay token is not a session: it must not reach any user-scoped route.
func TestTheRelayTokenIsNotASession(t *testing.T) {
	h := newRelayHarness(t)
	for _, path := range []string{"/api/v1/sync?stream=hot", "/api/v1/address", "/api/v1/writers"} {
		rec := h.relayReq(http.MethodGet, path, relayToken, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s with the relay token = %d, want 401", path, rec.Code)
		}
	}
}

// With no token the routes are ABSENT, not merely refusing: the catch-all
// answers 404 the same way it does for a typo.
func TestRelayRoutesAreNotMountedWithoutAToken(t *testing.T) {
	h := newRelayHarness(t)
	h.srv.RelayToken = ""
	h.h = h.srv.Handler()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, relayAddressesPath},
		{http.MethodPost, relayDeliverPath},
	} {
		rec := h.relayReq(tc.method, tc.path, relayToken, map[string]any{})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s with no relay configured = %d, want 404", tc.method, tc.path, rec.Code)
		}
	}
}

// relay.enabled with no token is a startup error, not a server that 401s every
// forward while the operator believes they have a backup MX.
func TestNewServerRefusesRelayEnabledWithNoToken(t *testing.T) {
	h := newHarness(t)
	cfg := config.Config{
		Mail:  config.MailConfig{Domain: "example.test", MaxMessageBytes: 1 << 20},
		Auth:  config.AuthConfig{SessionTTL: time.Hour},
		Relay: config.RelayConfig{Enabled: true},
	}
	if _, err := NewServer(cfg, h.pool); err == nil {
		t.Fatal("NewServer accepted relay.enabled with no LEDGER_RELAY_TOKEN")
	}
	cfg.Relay.Token = relayToken
	srv, err := NewServer(cfg, h.pool)
	if err != nil {
		t.Fatal(err)
	}
	if srv.RelayToken != relayToken {
		t.Fatalf("RelayToken = %q", srv.RelayToken)
	}
	if srv.MaxMessageBytes != 1<<20 {
		t.Fatalf("MaxMessageBytes = %d, want the configured SMTP cap", srv.MaxMessageBytes)
	}
}

// ---------------------------------------------------------------------------
// The replica
// ---------------------------------------------------------------------------

func TestTheAddressReplicaCarriesOnlyTheAddressMap(t *testing.T) {
	h := newRelayHarness(t)
	alice := h.user("alice")
	bob := h.user("bob")
	aliceAddr := h.issue(alice)
	bobAddr := h.issue(bob)

	rec := h.relayReq(http.MethodGet, relayAddressesPath, relayToken, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", relayAddressesPath, rec.Code, rec.Body.String())
	}
	// The response is checked as raw JSON, not through the typed struct: the
	// promise is about what a relay receives, and decoding into a type that has
	// only three fields would hide a fourth.
	var got struct {
		Addresses []map[string]json.RawMessage `json:"addresses"`
		AsOf      time.Time                    `json:"as_of"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Addresses) != 2 {
		t.Fatalf("%d addresses, want 2", len(got.Addresses))
	}
	want := map[string]bool{"local_part": true, "user_pubkey": true, "expires_at": true}
	for _, a := range got.Addresses {
		if len(a) != len(want) {
			t.Fatalf("an address row has %d keys, want exactly %d", len(a), len(want))
		}
		for k := range a {
			if !want[k] {
				t.Fatalf("the replica carries %q; the relay is allowed the address map and nothing else", k)
			}
		}
	}
	for _, id := range []string{alice.String(), bob.String()} {
		if strings.Contains(rec.Body.String(), id) {
			t.Fatalf("the replica leaks a user id")
		}
	}
	if got.AsOf.IsZero() {
		t.Fatal("as_of is zero: the relay ages its replica against it and would never go stale")
	}
	body := rec.Body.String()
	if !strings.Contains(body, aliceAddr) || !strings.Contains(body, bobAddr) {
		t.Fatalf("the replica is missing an issued address: %s", body)
	}
	// Phase 1 has no account encryption key. The field is present and empty,
	// which is what lets Phase 3 fill it in with no protocol change.
	for _, a := range got.Addresses {
		if string(a["user_pubkey"]) != `""` {
			t.Fatalf("user_pubkey = %s, want an empty string in Phase 1", a["user_pubkey"])
		}
	}
}

// A retired address inside its grace window is still accepting, so it must be
// in the replica WITH its deadline — otherwise the relay refuses mail the
// primary would take. One past its window must be gone, or the relay accepts
// mail for an address that no longer exists.
func TestTheReplicaCarriesGraceWindowsAndDropsExpiredAddresses(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	old := h.issue(u)
	newLocal, until, err := h.srv.Addresses.Rotate(bg, u)
	if err != nil {
		t.Fatal(err)
	}

	rec := h.relayReq(http.MethodGet, relayAddressesPath, relayToken, nil)
	var got RelayAddressesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	byLocal := map[string]RelayAddress{}
	for _, a := range got.Addresses {
		byLocal[a.LocalPart] = a
	}
	if a, ok := byLocal[old]; !ok {
		t.Fatal("the retired address is missing from the replica during its grace window")
	} else if a.ExpiresAt == nil || !a.ExpiresAt.Truncate(time.Millisecond).Equal(until.UTC().Truncate(time.Millisecond)) {
		t.Fatalf("retired address expires_at = %v, want %v", a.ExpiresAt, until)
	}
	if a, ok := byLocal[newLocal]; !ok || a.ExpiresAt != nil {
		t.Fatalf("the active address is %+v, want present with a null expires_at", a)
	}

	// Past the window it is gone.
	h.srv.Addresses.Now = func() time.Time { return until.Add(time.Second) }
	h.srv.Now = h.srv.Addresses.Now
	h.h = h.srv.Handler()
	rec = h.relayReq(http.MethodGet, relayAddressesPath, relayToken, nil)
	got = RelayAddressesResponse{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for _, a := range got.Addresses {
		if a.LocalPart == old {
			t.Fatal("an address past its grace window is still in the replica")
		}
	}
}

// ---------------------------------------------------------------------------
// deliver
// ---------------------------------------------------------------------------

func TestDeliverRunsTheOrdinaryIngestPathWithTheRelaysArrivalTime(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	local := h.issue(u)
	raw := []byte("Subject: relayed\r\n\r\nAED 12.34 at SOMEWHERE\r\n")
	arrived := time.Now().UTC().Add(-6 * time.Hour).Truncate(time.Millisecond)

	rec := h.relayReq(http.MethodPost, relayDeliverPath, relayToken, map[string]any{
		"local_part":    local,
		"envelope_from": "alerts@bank.test",
		"remote_ip":     "198.51.100.7",
		"received_at":   arrived.Format(time.RFC3339Nano),
		"raw":           base64.StdEncoding.EncodeToString(raw),
	})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST %s = %d: %s", relayDeliverPath, rec.Code, rec.Body.String())
	}
	calls := h.mail.calls()
	if len(calls) != 1 {
		t.Fatalf("%d deliveries", len(calls))
	}
	d := calls[0]
	if d.UserID != u {
		t.Fatalf("delivered to %s, want %s: the server resolves the recipient itself", d.UserID, u)
	}
	if string(d.Raw) != string(raw) {
		t.Fatalf("the message was altered in transit: %q", d.Raw)
	}
	if !d.ReceivedAt.Equal(arrived) {
		t.Fatalf("ReceivedAt = %v, want the RELAY's arrival time %v (not the moment the drain ran)",
			d.ReceivedAt, arrived)
	}
	if d.EnvelopeFrom != "alerts@bank.test" {
		t.Fatalf("EnvelopeFrom = %q", d.EnvelopeFrom)
	}
	if d.RemoteIP != netip.MustParseAddr("198.51.100.7") {
		t.Fatalf("RemoteIP = %v", d.RemoteIP)
	}
	if d.Rcpt != local+"@in.example.test" {
		t.Fatalf("Rcpt = %q", d.Rcpt)
	}
}

// A relayed message for an address that has since gone is a PERMANENT
// rejection: the relay sets it aside and says so loudly, which is the visible
// notice §2 requires. Answering a retryable error would hide it forever.
func TestDeliverRefusesAnUnknownRecipientPermanently(t *testing.T) {
	h := newRelayHarness(t)
	rec := h.relayReq(http.MethodPost, relayDeliverPath, relayToken, map[string]any{
		"local_part": "u-zzzzzzzzzzzzzzzzzzzzzzzzzz",
		"raw":        base64.StdEncoding.EncodeToString([]byte("x")),
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST %s for an unknown recipient = %d, want 404", relayDeliverPath, rec.Code)
	}
	if got := h.mail.calls(); len(got) != 0 {
		t.Fatalf("%d messages delivered for an unknown recipient", len(got))
	}
}

func TestDeliverRefusesMalformedRequests(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	local := h.issue(u)
	for name, body := range map[string]map[string]any{
		"no raw":              {"local_part": local, "raw": ""},
		"not base64":          {"local_part": local, "raw": "!!!!"},
		"no local part":       {"local_part": "", "raw": base64.StdEncoding.EncodeToString([]byte("x"))},
		"unnormalized case":   {"local_part": strings.ToUpper(local), "raw": base64.StdEncoding.EncodeToString([]byte("x"))},
		"full address":        {"local_part": local + "@in.example.test", "raw": base64.StdEncoding.EncodeToString([]byte("x"))},
		"path-ish local part": {"local_part": "../../etc/passwd", "raw": base64.StdEncoding.EncodeToString([]byte("x"))},
	} {
		t.Run(name, func(t *testing.T) {
			rec := h.relayReq(http.MethodPost, relayDeliverPath, relayToken, body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("POST %s (%s) = %d, want 400", relayDeliverPath, name, rec.Code)
			}
		})
	}
	if got := h.mail.calls(); len(got) != 0 {
		t.Fatalf("%d messages delivered from malformed requests", len(got))
	}
}

func TestDeliverRefusesAnOversizeMessage(t *testing.T) {
	h := newRelayHarness(t)
	h.srv.MaxMessageBytes = 1024
	h.h = h.srv.Handler()
	u := h.user("alice")
	local := h.issue(u)
	rec := h.relayReq(http.MethodPost, relayDeliverPath, relayToken, map[string]any{
		"local_part": local,
		"raw":        base64.StdEncoding.EncodeToString(make([]byte, 1025)),
	})
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("POST %s with an oversize message = %d, want 413", relayDeliverPath, rec.Code)
	}
}

// A pipeline failure must be TEMPORARY on the wire: a 4xx would make the relay
// file a perfectly good message under rejected/ over a database blip.
func TestAPipelineFailureIsAnswered5xxSoTheRelayKeepsTheMessage(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	local := h.issue(u)
	h.mail.fail = context.DeadlineExceeded
	rec := h.relayReq(http.MethodPost, relayDeliverPath, relayToken, map[string]any{
		"local_part": local,
		"raw":        base64.StdEncoding.EncodeToString([]byte("x")),
	})
	if rec.Code < 500 {
		t.Fatalf("POST %s with a failing pipeline = %d, want a 5xx", relayDeliverPath, rec.Code)
	}
}

// The body cap and the message cap must agree, or a relay forwarding a legal
// maximum-size message gets a generic 413 its drain reads as permanent.
func TestRelayDeliverSizeCapsAgree(t *testing.T) {
	// base64 of the largest storable message, plus JSON framing and the other
	// fields, must fit under the body cap.
	worst := base64.StdEncoding.EncodedLen(1_000_000) + 1024
	if worst >= maxRelayDeliverBytes {
		t.Fatalf("a maximum-size message frames to ~%d bytes, over the %d body cap",
			worst, maxRelayDeliverBytes)
	}
}

// The relay's own constants must name the routes this mux actually serves.
func TestTheRelayRoutesAreTheOnesTheRelayCalls(t *testing.T) {
	if relay.AddressesPath != relayAddressesPath {
		t.Fatalf("relay.AddressesPath = %q, this server serves %q", relay.AddressesPath, relayAddressesPath)
	}
	if relay.DeliverPath != relayDeliverPath {
		t.Fatalf("relay.DeliverPath = %q, this server serves %q", relay.DeliverPath, relayDeliverPath)
	}
	if relay.SpoolHeader != relaySpoolHeader {
		t.Fatalf("relay.SpoolHeader = %q, this server reads %q", relay.SpoolHeader, relaySpoolHeader)
	}
}

// ---------------------------------------------------------------------------
// End to end: SMTP -> relay spool -> drain -> primary -> op_log
// ---------------------------------------------------------------------------

// trustEverything is the allowlist stand-in. The subject of this test is the
// relay path, not the trust lane, and quarantined mail would never reach the
// op log.
type trustEverything struct{}

func (trustEverything) Allowlisted(context.Context, uuid.UUID, string, string) (bool, error) {
	return true, nil
}

// TestRelayedMailReachesTheOpLogAndIsIdempotent is the whole loop: a real SMTP
// receiver running the RELAY's handler accepts a message onto a real spool, the
// relay drains it over HTTP into this package's endpoint, and the ordinary
// ingest pipeline appends it to the user's op log.
//
// Then it does it again with the same bytes, which is what an MTA retry and a
// lost drain answer both look like, and asserts the log did not grow.
func TestRelayedMailReachesTheOpLogAndIsIdempotent(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	local := h.issue(u)

	// The primary: this package's handler, with the REAL ingest pipeline.
	q := &quarantine.Store{Pool: h.pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore}
	pipeline := &ingest.Pipeline{
		Pool: h.pool,
		Origin: ingest.ResolverFunc(func(context.Context, []byte, string) origin.Origin {
			return origin.Origin{
				Outer: "bank.test",
				DKIM:  origin.SigPass,
				ARC:   origin.SigNone,
			}
		}),
		Trust:      trustEverything{},
		Appender:   &oplog.Appender{Pool: h.pool},
		Diag:       &diag.Diag{Pool: h.pool},
		Quarantine: q,
		Logf:       func(string, ...any) {},
	}
	h.srv.Mail = pipeline
	h.h = h.srv.Handler()
	primary := httptest.NewServer(h.h)
	defer primary.Close()

	// The relay: a real spool, and a real SMTP receiver in front of it.
	spool := t.TempDir()
	r := &relay.Relay{
		SpoolDir:   spool,
		PrimaryURL: primary.URL,
		Token:      relayToken,
		Suffix:     "@in.example.test",
		HTTP:       primary.Client(),
		Logf:       func(string, ...any) {},
	}
	if err := r.Init(); err != nil {
		t.Fatal(err)
	}
	if n, err := r.SyncAddresses(bg); err != nil || n != 1 {
		t.Fatalf("SyncAddresses = (%d,%v), want (1,nil)", n, err)
	}

	mail := smtpd.New(config.MailConfig{
		Domain: "example.test", SMTPListen: "127.0.0.1:0",
		MaxMessageBytes: 1 << 20, PerAddressDaily: 50,
		InvalidRcptBurst: 5, TarpitBase: time.Millisecond,
	}, r, r, relayDiscard{}, time.Now)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = mail.Serve(ln) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mail.Shutdown(ctx)
	})

	msg := "From: alerts@bank.test\r\n" +
		"To: " + local + "@in.example.test\r\n" +
		"Subject: Transaction Alert\r\n" +
		"Date: Sat, 01 Aug 2026 10:00:00 +0400\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" +
		"AED 42.50 spent at RELAYED MERCHANT\r\n"
	sendSMTP(t, ln.Addr().String(), local+"@in.example.test", msg)

	if st, err := r.Stats(); err != nil || st.Spooled != 1 {
		t.Fatalf("after SMTP: Stats = %+v, %v; want one spooled message", st, err)
	}

	sent, failed, err := r.Drain(bg)
	if err != nil || sent != 1 || failed != 0 {
		t.Fatalf("Drain = (%d,%d,%v), want (1,0,nil)", sent, failed, err)
	}
	if got := opCount(t, h, u); got != 2 {
		// One hot op and one cold raw body.
		t.Fatalf("%d op_log rows after the relayed delivery, want 2 (hot + cold)", got)
	}

	// The redelivery. Spool the same bytes again — which is exactly what an
	// MTA retry to the relay, or a drain whose 202 was lost, produces — and
	// drain a second time.
	sendSMTP(t, ln.Addr().String(), local+"@in.example.test", msg)
	sent, failed, err = r.Drain(bg)
	if err != nil || sent != 1 || failed != 0 {
		t.Fatalf("second Drain = (%d,%d,%v), want (1,0,nil)", sent, failed, err)
	}
	if got := opCount(t, h, u); got != 2 {
		t.Fatalf("%d op_log rows after a REDELIVERY, want 2: relayed mail must be "+
			"idempotent by ingest id", got)
	}
	var dupes int
	if err := h.pool.QueryRow(bg,
		`SELECT count(*) FROM parse_diagnostics WHERE user_id = $1 AND outcome = 'duplicate'`,
		u).Scan(&dupes); err != nil {
		t.Fatal(err)
	}
	if dupes != 1 {
		t.Fatalf("%d duplicate diagnostics rows, want exactly 1: the redelivery must be "+
			"RECORDED, not silently ignored", dupes)
	}
	if st, err := r.Stats(); err != nil || st.Spooled != 0 || st.Rejected != 0 {
		t.Fatalf("after two clean drains: Stats = %+v, %v", st, err)
	}
}

// TestTheWireCodeForAnUnknownRecipientDependsOnTheReplicasAge is the assertion
// the whole stale-replica argument rests on, made where it is actually
// observable: on the SMTP wire.
//
// A fresh replica answers an unknown recipient with the same permanent 550 the
// primary would. A stale one answers a TEMPORARY failure instead, because an
// address issued since the last sync would otherwise be refused forever — and a
// sustained permanent failure is what makes Gmail silently disable a user's
// forwarding rule. Nothing below stubs smtpd: the relay returns two different
// error values and the real receiver turns them into two different replies.
func TestTheWireCodeForAnUnknownRecipientDependsOnTheReplicasAge(t *testing.T) {
	h := newRelayHarness(t)
	u := h.user("alice")
	h.issue(u)
	primary := httptest.NewServer(h.h)
	defer primary.Close()

	// An atomically-advanced clock: the receiver reads it from another
	// goroutine, so a plain field assignment mid-test would be a data race.
	base := time.Now().UTC()
	var offset atomic.Int64
	r := &relay.Relay{
		SpoolDir:   t.TempDir(),
		PrimaryURL: primary.URL,
		Token:      relayToken,
		Suffix:     "@in.example.test",
		HTTP:       primary.Client(),
		Now:        func() time.Time { return base.Add(time.Duration(offset.Load())) },
		Logf:       func(string, ...any) {},
	}
	if err := r.Init(); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SyncAddresses(bg); err != nil {
		t.Fatal(err)
	}

	mail := smtpd.New(config.MailConfig{
		Domain: "example.test", SMTPListen: "127.0.0.1:0",
		MaxMessageBytes: 1 << 20, PerAddressDaily: 50,
		InvalidRcptBurst: 50, TarpitBase: time.Millisecond,
	}, r, r, relayDiscard{}, time.Now)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = mail.Serve(ln) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mail.Shutdown(ctx)
	})

	unknown := "u-zzzzzzzzzzzzzzzzzzzzzzzzzz@in.example.test"
	rcptCode(t, ln.Addr().String(), unknown, "550")
	// Two days without a successful sync: the primary has been unreachable, and
	// this relay can no longer speak for an address space it cannot see.
	offset.Store(int64(48 * time.Hour))
	rcptCode(t, ln.Addr().String(), unknown, "4")
}

// rcptCode opens a transaction as far as RCPT and asserts the reply's prefix.
func rcptCode(t *testing.T, addr, rcpt, want string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	c := &smtpConv{t: t, conn: conn}
	c.expect("220")
	c.cmd("EHLO test.local", "250")
	c.cmd("MAIL FROM:<alerts@bank.test>", "250")
	c.cmd("RCPT TO:<"+rcpt+">", want)
}

// relayDiscard is the no-database diagnostics sink a relay uses. It is declared
// here rather than imported so this test exercises the same smtpd seam
// cmd/ledgerd's runRelay does.
type relayDiscard struct{}

func (relayDiscard) Record(context.Context, diag.Record) error            { return nil }
func (relayDiscard) CountRejection(context.Context, string) error         { return nil }
func (relayDiscard) CountRejections(context.Context, string, int64) error { return nil }

func opCount(t *testing.T, h *relayHarness, u uuid.UUID) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM op_log WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// sendSMTP delivers one message with a minimal client, so the test drives the
// receiver over a real socket rather than calling the handler directly.
func sendSMTP(t *testing.T, addr, rcpt, msg string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	c := &smtpConv{t: t, conn: conn}
	c.expect("220")
	c.cmd("EHLO test.local", "250")
	c.cmd("MAIL FROM:<alerts@bank.test>", "250")
	c.cmd("RCPT TO:<"+rcpt+">", "250")
	c.cmd("DATA", "354")
	c.write(msg + ".\r\n")
	c.expect("250")
	c.cmd("QUIT", "221")
}

type smtpConv struct {
	t    *testing.T
	conn net.Conn
	buf  []byte
}

func (c *smtpConv) write(s string) {
	c.t.Helper()
	if _, err := c.conn.Write([]byte(s)); err != nil {
		c.t.Fatal(err)
	}
}

func (c *smtpConv) cmd(line, want string) {
	c.t.Helper()
	c.write(line + "\r\n")
	c.expect(want)
}

// expect reads reply lines until a final one (code followed by a space) arrives,
// and fails unless it starts with want.
func (c *smtpConv) expect(want string) {
	c.t.Helper()
	for {
		line := c.readLine()
		if len(line) >= 4 && line[3] == '-' {
			continue // a continuation line
		}
		if !strings.HasPrefix(line, want) {
			c.t.Fatalf("smtp: got %q, want a reply starting %q", line, want)
		}
		return
	}
}

func (c *smtpConv) readLine() string {
	c.t.Helper()
	for {
		if i := indexCRLF(c.buf); i >= 0 {
			line := string(c.buf[:i])
			c.buf = c.buf[i+2:]
			return line
		}
		var tmp [512]byte
		n, err := c.conn.Read(tmp[:])
		if n > 0 {
			c.buf = append(c.buf, tmp[:n]...)
			continue
		}
		if err != nil {
			c.t.Fatalf("smtp: read: %v (buffered %q)", err, c.buf)
		}
	}
}

func indexCRLF(b []byte) int {
	for i := 0; i+1 < len(b); i++ {
		if b[i] == '\r' && b[i+1] == '\n' {
			return i
		}
	}
	return -1
}
