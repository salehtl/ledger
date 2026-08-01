package smtpd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/textproto"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/auth"
	"ledger/internal/v2/config"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

const (
	testDomain = "example.test"
	testSuffix = "@in." + testDomain
	// The recipient every happy-path test sends to: "u-" plus 26 base32
	// characters, exactly the shape addresses.NewToken produces.
	knownLocal = "u-abcdefghijklmnopqrstuvwxyz"
	knownRcpt  = knownLocal + testSuffix
	// The one wire response every RCPT-time rejection produces.
	rejectText = "5.1.1 <no such recipient>"
)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// fakeResolver mimics addresses.Resolve closely enough for protocol tests: ONE
// sentinel for every rejection, and the same case/bracket folding, so a test
// that thinks it is exercising a bypass exercises the real one.
// TestQuotaSurvivesRecipientCaseAndBracketVariation runs against the actual
// addresses package rather than this double.
type fakeResolver struct {
	mu    sync.Mutex
	users map[string]uuid.UUID
	grace map[string]bool
	err   error // when set, returned instead of any answer (an outage)
	calls int
}

func resolverWith(locals ...string) *fakeResolver {
	r := &fakeResolver{users: map[string]uuid.UUID{}, grace: map[string]bool{}}
	for _, l := range locals {
		r.users[l] = uuid.New()
	}
	return r
}

func (r *fakeResolver) Resolve(ctx context.Context, rcpt string) (uuid.UUID, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.err != nil {
		return uuid.Nil, false, r.err
	}
	s := strings.TrimSpace(rcpt)
	if strings.HasPrefix(s, "<") && strings.HasSuffix(s, ">") {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	s = strings.ToLower(s)
	if !strings.HasSuffix(s, testSuffix) {
		return uuid.Nil, false, addresses.ErrUnknownRecipient
	}
	local := s[:len(s)-len(testSuffix)]
	u, ok := r.users[local]
	if !ok {
		return uuid.Nil, false, addresses.ErrUnknownRecipient
	}
	return u, r.grace[local], nil
}

func (r *fakeResolver) resolveCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func (r *fakeResolver) fail(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.err = err
}

type recorder struct {
	mu  sync.Mutex
	got []Delivery
	err error
}

func (h *recorder) Deliver(ctx context.Context, d Delivery) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.err != nil {
		return h.err
	}
	h.got = append(h.got, d)
	return nil
}

func (h *recorder) deliveries() []Delivery {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]Delivery(nil), h.got...)
}

func (h *recorder) count() int { return len(h.deliveries()) }

func (h *recorder) fail(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.err = err
}

func testMailConfig() config.MailConfig {
	return config.MailConfig{
		Domain:           testDomain,
		SMTPListen:       "127.0.0.1:0",
		MaxMessageBytes:  4096,
		PerAddressDaily:  50,
		InvalidRcptBurst: 5,
		TarpitBase:       time.Millisecond,
	}
}

type fixture struct {
	srv  *Server
	addr string
	res  *fakeResolver
	h    *recorder
	pool *pgxpool.Pool
	d    *diag.Diag
	user uuid.UUID
}

// start binds an ephemeral loopback port and serves on it. NEVER :25 — this box
// is the production host and Phase 0 confirmed inbound 25 reaches it.
//
// tweaks run BEFORE the accept loop starts. Mutating a Server that is already
// serving is a data race against its connection goroutines, which is exactly
// the kind of thing -race would catch intermittently and confusingly.
func start(t *testing.T, cfg config.MailConfig, res Resolver, h Handler, d *diag.Diag, tweaks ...func(*Server)) (*Server, string) {
	t.Helper()
	srv := New(cfg, res, h, d, time.Now)
	for _, tw := range tweaks {
		tw(srv)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ln.Addr().String(), "127.0.0.1:") {
		t.Fatalf("refusing to run against a non-loopback listener %s", ln.Addr())
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	// Wait until Serve has registered the listener with the Server. Shutdown
	// closes the listener it was GIVEN, and a Shutdown that lands before the
	// goroutine has handed it over has nothing to close yet — Serve then closes
	// it on its way out, a moment later, which is correct but not synchronous.
	// Real callers bind before starting the goroutine; this is the test's
	// equivalent.
	for deadline := time.Now().Add(5 * time.Second); srv.Addr() == ""; {
		if time.Now().After(deadline) {
			t.Fatal("the server never reported a bound address")
		}
		time.Sleep(time.Millisecond)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(bg, 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		<-done
	})
	return srv, ln.Addr().String()
}

// newFixture wires a server over a real diagnostics pool and a real user row:
// every user-scoped diagnostics row this receiver writes has a foreign key into
// users, and an in-memory double would not exercise it.
func newFixture(t *testing.T, cfg config.MailConfig, tweaks ...func(*Server)) *fixture {
	t.Helper()
	pool := pgtest.New(t)
	uid := insertUser(t, pool)
	res := resolverWith()
	res.users[knownLocal] = uid
	h := &recorder{}
	d := &diag.Diag{Pool: pool}
	srv, addr := start(t, cfg, res, h, d, append([]func(*Server){withConnCaps(512, 512)}, tweaks...)...)
	return &fixture{srv: srv, addr: addr, res: res, h: h, pool: pool, d: d, user: uid}
}

func withLimiter(cfg LimiterConfig) func(*Server) {
	return func(s *Server) { s.limiter = NewLimiter(cfg) }
}

// withConnCaps sets the concurrency caps. newFixture raises them out of the way
// by default: the test client holds every connection open until cleanup, and
// every test in this file dials from 127.0.0.1, so the production per-source cap
// of 4 would make unrelated tests fail for a reason that has nothing to do with
// what they assert. The caps themselves are tested deliberately, with explicit
// values, below.
func withConnCaps(total, perSource int) func(*Server) {
	return func(s *Server) { s.maxConns, s.maxConnsPerSource = total, perSource }
}

// withHighRefusalThreshold removes the tarpit and the disconnect from tests
// whose subject is something else. Refusals are metered now — including
// over-quota ones — so a test that provokes dozens of them would otherwise be
// asserting the disconnect threshold by accident.
// It keeps the configured daily allowance: NewLimiter fills a zero Daily with
// its own default, so building a limiter from scratch silently discards
// cfg.PerAddressDaily and hands every quota test an allowance of 50.
func withHighRefusalThreshold() func(*Server) {
	return func(s *Server) {
		s.limiter = NewLimiter(LimiterConfig{
			Burst: 1 << 20, Base: time.Millisecond, Max: time.Millisecond,
			Window: time.Hour, Disconnect: 1 << 30,
			Daily: s.cfg.PerAddressDaily,
		})
	}
}

func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{
		IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// ---------------------------------------------------------------------------
// A raw SMTP client. net/smtp cannot pipeline, cannot send a deliberately
// oversized DATA, and hides the response text this file asserts on.
// ---------------------------------------------------------------------------

type client struct {
	t  *testing.T
	nc net.Conn
	tp *textproto.Conn
}

func dial(t *testing.T, addr string) *client {
	t.Helper()
	nc, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c := &client{t: t, nc: nc, tp: textproto.NewConn(nc)}
	t.Cleanup(func() { nc.Close() })
	if code, _ := c.read(); code != 220 {
		t.Fatalf("greeting code %d, want 220", code)
	}
	return c
}

func (c *client) read() (int, string) {
	c.t.Helper()
	_ = c.nc.SetReadDeadline(time.Now().Add(30 * time.Second))
	code, msg, err := c.tp.ReadResponse(0)
	if err != nil {
		c.t.Fatalf("reading response: %v", err)
	}
	return code, msg
}

func (c *client) cmd(format string, args ...any) (int, string) {
	c.t.Helper()
	if err := c.tp.PrintfLine(format, args...); err != nil {
		c.t.Fatalf("writing %q: %v", fmt.Sprintf(format, args...), err)
	}
	return c.read()
}

func (c *client) mustCmd(want int, format string, args ...any) string {
	c.t.Helper()
	code, msg := c.cmd(format, args...)
	if code != want {
		c.t.Fatalf("%q -> %d %q, want %d", fmt.Sprintf(format, args...), code, msg, want)
	}
	return msg
}

// hello performs EHLO and returns the greeting plus capability lines.
func (c *client) hello() []string {
	c.t.Helper()
	return strings.Split(c.mustCmd(250, "EHLO client.example.test"), "\n")
}

// envelope walks EHLO/MAIL and stops before RCPT.
func (c *client) envelope(from string) {
	c.t.Helper()
	c.hello()
	c.mustCmd(250, "MAIL FROM:<%s>", from)
}

// send runs a whole transaction and returns the final response.
func (c *client) send(from, to string, body []byte) (int, string) {
	c.t.Helper()
	c.envelope(from)
	if code, msg := c.cmd("RCPT TO:<%s>", to); code != 250 {
		return code, msg
	}
	return c.data(body)
}

func (c *client) data(body []byte) (int, string) {
	c.t.Helper()
	if code, msg := c.cmd("DATA"); code != 354 {
		c.t.Fatalf("DATA -> %d %q, want 354", code, msg)
	}
	_ = c.nc.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := c.nc.Write(body); err != nil {
		c.t.Fatalf("writing body: %v", err)
	}
	if _, err := c.nc.Write([]byte(".\r\n")); err != nil {
		c.t.Fatalf("writing terminator: %v", err)
	}
	return c.read()
}

// bdat sends one BDAT chunk and returns the response. The body is written
// verbatim: BDAT counts bytes, so there is no dot-stuffing and no terminator.
func (c *client) bdat(body []byte, last bool) (int, string) {
	c.t.Helper()
	arg := fmt.Sprintf("BDAT %d", len(body))
	if last {
		arg += " LAST"
	}
	if err := c.tp.PrintfLine("%s", arg); err != nil {
		c.t.Fatalf("writing %q: %v", arg, err)
	}
	_ = c.nc.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if len(body) > 0 {
		if _, err := c.nc.Write(body); err != nil {
			c.t.Fatalf("writing chunk: %v", err)
		}
	}
	return c.read()
}

// mailOf builds a message body of EXACTLY n bytes as the server will see it.
//
// Three properties, each of which a first draft got wrong and each of which
// silently changes what is being tested:
//   - It ends with a clean CRLF that is NOT preceded by a bare '\r'. SMTP's
//     end-of-data machine only recognizes CRLF, so a body ending "\r\r\n"
//     leaves it mid-line, the CRLF.CRLF terminator is never seen, and the
//     server sits waiting for the rest of a message the client already finished
//     — which reads exactly like a server-side hang and is not one.
//   - No line reaches MaxLineLength, which applies to body lines too.
//   - No line starts with '.', so dot-stuffing never changes the byte count and
//     "exactly at the cap" means exactly at the cap.
func mailOf(n int) []byte {
	if n < 2 {
		panic("mailOf: too small to terminate")
	}
	b := make([]byte, 0, n)
	for {
		rem := n - len(b)
		if rem <= 66 {
			for i := 0; i < rem-2; i++ {
				b = append(b, 'a')
			}
			return append(b, '\r', '\n')
		}
		for i := 0; i < 62; i++ {
			b = append(b, 'a')
		}
		b = append(b, '\r', '\n')
	}
}

// unknownRcpt returns a well-formed but never-issued recipient. The token
// alphabet is base32 (a-z, 2-7), so these are shaped exactly like real ones.
func unknownRcpt(i int) string {
	return "u-zzzzzzzzzzzzzzzzzzzzzzzzz" + string(rune('2'+i%6)) + testSuffix
}

func countDiagRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM parse_diagnostics`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type diagRow struct {
	userID       uuid.NullUUID
	event        string
	outcome      string
	rejectReason *string
	senderDomain string
}

func diagRows(t *testing.T, pool *pgxpool.Pool) []diagRow {
	t.Helper()
	rows, err := pool.Query(bg, `SELECT user_id, event, outcome, reject_reason, sender_domain
	  FROM parse_diagnostics ORDER BY received_at, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []diagRow
	for rows.Next() {
		var r diagRow
		if err := rows.Scan(&r.userID, &r.event, &r.outcome, &r.rejectReason, &r.senderDomain); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// flushed forces the buffered rejection counts out before they are read back.
// The aggregate is batched in memory on purpose (see Server.countRejection), so
// a test that queries the table without this is asking a question about timing.
func flushed(t *testing.T, srv *Server) {
	t.Helper()
	if err := srv.flushRejections(bg); err != nil {
		t.Fatalf("flushing rejection counts: %v", err)
	}
}

func rejectionCount(t *testing.T, pool *pgxpool.Pool, reason string) int64 {
	t.Helper()
	var n int64
	err := pool.QueryRow(bg,
		`SELECT coalesce(sum(count),0) FROM smtp_rejections WHERE reason = $1`, reason).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// Attack 1: recipient enumeration
// ---------------------------------------------------------------------------

// The rejection is an enumeration oracle unless every kind of "no" is the same
// "no" on the wire. addresses.Resolve returns ONE sentinel for all four of its
// rejection reasons; that property is worth nothing if this layer re-splits it.
func TestUnknownRecipientIsRejectedWithAnIndistinguishableMessage(t *testing.T) {
	cfg := testMailConfig()
	cfg.InvalidRcptBurst = 1000 // isolate the response from the tarpit
	f := newFixture(t, cfg)

	for _, rcpt := range []string{
		"u-zzzzzzzzzzzzzzzzzzzzzzzzzz" + testSuffix,                  // well-formed, never issued
		"not-a-token" + testSuffix,                                   // malformed local part
		"u-abcdefghijklmnopqrstuvwxyz@elsewhere.test",                // right token, wrong domain
		"postmaster" + testSuffix,                                    // a name a prober always tries
		strings.ToUpper("u-zzzzzzzzzzzzzzzzzzzzzzzzzz") + testSuffix, // case-folded miss
		"u-abcdefghijklmnopqrstuvwxy" + testSuffix,                   // one character short of a real one
		"u-abcdefghijklmnopqrstuvwxyz+tag" + testSuffix,              // plus-tagging is not a second key
	} {
		c := dial(t, f.addr)
		c.envelope("probe@attacker.test")
		code, msg := c.cmd("RCPT TO:<%s>", rcpt)
		if code != 550 || msg != rejectText {
			t.Fatalf("rcpt %q leaked information: %d %q", rcpt, code, msg)
		}
	}
	if f.h.count() != 0 {
		t.Fatal("no delivery may result from a rejected recipient")
	}
	if n := countDiagRows(t, f.pool); n != 0 {
		t.Fatalf("%d user-scoped rows from unknown recipients; there is no user to scope them to", n)
	}
}

// This server has exactly one job and relaying is not it.
func TestServerNeverRelays(t *testing.T) {
	f := newFixture(t, testMailConfig())
	c := dial(t, f.addr)
	c.envelope("spammer@attacker.test")
	code, msg := c.cmd("RCPT TO:<victim@somewhere-else.test>")
	if code != 550 || msg != rejectText {
		t.Fatalf("relay attempt -> %d %q, want 550 %q", code, msg, rejectText)
	}
	// With no accepted recipient, DATA is refused outright.
	if code, _ := c.cmd("DATA"); code/100 != 5 {
		t.Fatalf("DATA after a rejected recipient -> %d, want a 5xx", code)
	}
	if f.h.count() != 0 {
		t.Fatal("a relay attempt must never reach the handler")
	}
}

// No AUTH is offered, so there is no credential surface and no chance of an
// authenticated relay path appearing by accident.
func TestEHLOOffersNoAuthAndAdvertisesTheLimits(t *testing.T) {
	f := newFixture(t, testMailConfig())
	c := dial(t, f.addr)
	caps := c.hello()
	joined := strings.ToUpper(strings.Join(caps, "\n"))
	if strings.Contains(joined, "AUTH") {
		t.Fatalf("EHLO advertises AUTH: %q", joined)
	}
	if strings.Contains(joined, "STARTTLS") {
		t.Fatalf("EHLO advertises STARTTLS but no TLS config is wired: %q", joined)
	}
	// SIZE is advertised WITHOUT a value, which under RFC 1870 means "the SIZE
	// parameter is understood, no fixed maximum is declared". A SIZE with a
	// number would mean go-smtp's own MaxMessageBytes is set again — and that
	// setting is what made two oversize refusals bypass this package entirely.
	// See New. The cap is still enforced, by session.Mail and session.Data.
	if regexp.MustCompile(`SIZE [0-9]`).MatchString(joined) {
		t.Fatalf("EHLO declares a SIZE limit, so the library's unaccounted size checks are back on: %q", joined)
	}
	// CHUNKING is advertised unconditionally by go-smtp and cannot be turned
	// off, so BDAT is a reachable second body path whether we want it or not.
	// It is pinned here so the tests below are visibly about a real surface.
	if !strings.Contains(joined, "CHUNKING") {
		t.Fatal("go-smtp no longer advertises CHUNKING; the BDAT tests below may be testing nothing")
	}
	if !strings.Contains(joined, "RCPTMAX=1") {
		t.Fatalf("EHLO must advertise the single-recipient limit: %q", joined)
	}
	// AUTH is not merely unadvertised, it is unimplemented.
	if code, _ := c.cmd("AUTH PLAIN"); code/100 != 5 {
		t.Fatalf("AUTH PLAIN -> %d, want a 5xx", code)
	}
}

// An unknown recipient has no user to scope a row to, and one row per attempt
// would let anyone flood the diagnostics table from the open port. It is
// aggregated instead.
func TestUnknownRcptIncrementsTheAggregateCounterOnly(t *testing.T) {
	cfg := testMailConfig()
	cfg.InvalidRcptBurst = 1000
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	c.envelope("probe@attacker.test")
	for i := 0; i < 5; i++ {
		c.mustCmd(550, "RCPT TO:<%s>", unknownRcpt(i))
	}
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectUnknownRcpt); n != 5 {
		t.Fatalf("smtp_rejections[unknown_rcpt] = %d, want 5", n)
	}
	if n := countDiagRows(t, f.pool); n != 0 {
		t.Fatalf("parse_diagnostics has %d rows; an unknown recipient has no user to scope one to", n)
	}
}

// ---------------------------------------------------------------------------
// Attack 2: the tarpit, and trying to get around it
// ---------------------------------------------------------------------------

func TestSustainedInvalidRcptDropsTheConnection(t *testing.T) {
	f := newFixture(t, testMailConfig(), withLimiter(LimiterConfig{
		Burst: 1, Base: time.Millisecond, Max: 2 * time.Millisecond,
		Window: time.Hour, Disconnect: 4,
	}))
	c := dial(t, f.addr)
	c.envelope("probe@attacker.test")
	for i := 0; i < 3; i++ {
		c.mustCmd(550, "RCPT TO:<%s>", unknownRcpt(i))
	}
	code, _ := c.cmd("RCPT TO:<%s>", unknownRcpt(4))
	if code != 421 {
		t.Fatalf("the disconnecting reply was %d, want 421", code)
	}
	// 421 means "closing transmission channel". It has to actually close, or
	// the abuser simply keeps going on the same connection.
	_ = c.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.nc.Read(make([]byte, 1)); err == nil {
		t.Fatal("the connection is still open after a 421 disconnect")
	}
}

// An IP already past the disconnect threshold must cost NO database work: the
// per-caller check runs BEFORE the recipient lookup. A limiter consulted after
// the expensive step does not limit the expensive step.
func TestABlockedIPIsRefusedWithoutARecipientLookup(t *testing.T) {
	f := newFixture(t, testMailConfig(), withLimiter(LimiterConfig{
		Burst: 1, Base: time.Millisecond, Max: time.Millisecond,
		Window: time.Hour, Disconnect: 3,
	}))
	c := dial(t, f.addr)
	c.envelope("probe@attacker.test")
	c.mustCmd(550, "RCPT TO:<%s>", unknownRcpt(0))
	c.mustCmd(550, "RCPT TO:<%s>", unknownRcpt(1))
	c.mustCmd(421, "RCPT TO:<%s>", unknownRcpt(2)) // the threshold call: dropped
	before := f.res.resolveCalls()

	c2 := dial(t, f.addr)
	c2.envelope("probe@attacker.test")
	// Even a VALID recipient is refused now: the block is on the source.
	if code, _ := c2.cmd("RCPT TO:<%s>", knownRcpt); code != 421 {
		t.Fatalf("a blocked source must be dropped, got %d", code)
	}
	if after := f.res.resolveCalls(); after != before {
		t.Fatalf("the blocked source still cost %d recipient lookups", after-before)
	}
}

// Pipelining is the obvious way to try to make a tarpit free: send every RCPT
// in one write and let the delays overlap. They do not overlap — they are
// serialized on the connection's own goroutine.
func TestPipeliningDoesNotBypassTheTarpit(t *testing.T) {
	f := newFixture(t, testMailConfig(), withLimiter(LimiterConfig{
		Burst: 1, Base: 50 * time.Millisecond, Max: time.Second,
		Window: time.Hour, Disconnect: 1000,
	}))
	c := dial(t, f.addr)
	c.envelope("probe@attacker.test")

	var b strings.Builder
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "RCPT TO:<%s>\r\n", unknownRcpt(i))
	}
	started := time.Now()
	if _, err := c.nc.Write([]byte(b.String())); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if code, msg := c.read(); code != 550 || msg != rejectText {
			t.Fatalf("pipelined rcpt %d -> %d %q", i, code, msg)
		}
	}
	// Delays are 0 + 2x + 4x + 8x base = 700ms. Materially under that means
	// they ran concurrently.
	if elapsed := time.Since(started); elapsed < 600*time.Millisecond {
		t.Fatalf("four pipelined invalid recipients took %v; the tarpit was bypassed", elapsed)
	}
}

// ---------------------------------------------------------------------------
// Attack 3: oversized DATA
// ---------------------------------------------------------------------------

func TestDataOverTheCapIsRejected(t *testing.T) {
	cfg := testMailConfig()
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(cfg.MaxMessageBytes+1))
	if code != 552 {
		t.Fatalf("one byte over the cap -> %d, want 552", code)
	}
	if f.h.count() != 0 {
		t.Fatal("an oversized message must never reach the handler")
	}
	rows := diagRows(t, f.pool)
	if len(rows) != 1 {
		t.Fatalf("want exactly one diagnostics row, got %d", len(rows))
	}
	r := rows[0]
	if !r.userID.Valid || r.userID.UUID != f.user {
		t.Fatalf("the recipient resolved, so the row must be scoped to that user: %+v", r)
	}
	if r.event != diag.EventArrival || r.outcome != diag.OutcomeRejected {
		t.Fatalf("row = %s/%s, want arrival/rejected", r.event, r.outcome)
	}
	if r.rejectReason == nil || *r.rejectReason != diag.RejectTooLarge {
		t.Fatalf("reject_reason = %v, want %q", r.rejectReason, diag.RejectTooLarge)
	}
	if r.senderDomain != diag.UnverifiedPrefix+"dib.ae" {
		t.Fatalf("sender_domain = %q; an envelope domain is an assertion, and must be marked unverified", r.senderDomain)
	}
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectTooLarge); n != 1 {
		t.Fatalf("smtp_rejections[too_large] = %d, want 1", n)
	}
}

// The boundary in the other direction. config.validate clamps
// max_message_bytes to blob.MaxColdMail precisely so a message that still fits
// a size bucket is accepted; an off-by-one here reproduces the "seals fine,
// permanently unopenable" failure from the other side. go-smtp's own DATA
// reader rejects a message of exactly its MaxMessageBytes, which is why the
// receiver sets that backstop one byte above the real cap and enforces the cap
// itself.
func TestDataExactlyAtTheCapIsAccepted(t *testing.T) {
	cfg := testMailConfig()
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	body := mailOf(cfg.MaxMessageBytes)
	if code, msg := c.send("bank@dib.ae", knownRcpt, body); code != 250 {
		t.Fatalf("a message exactly at the cap -> %d %q, want 250", code, msg)
	}
	got := f.h.deliveries()
	if len(got) != 1 {
		t.Fatalf("want one delivery, got %d", len(got))
	}
	if len(got[0].Raw) != cfg.MaxMessageBytes {
		t.Fatalf("delivered %d bytes, want exactly %d", len(got[0].Raw), cfg.MaxMessageBytes)
	}
	if n := countDiagRows(t, f.pool); n != 0 {
		t.Fatalf("an accepted message writes no rejection row here (Task 29 owns the arrival row); got %d", n)
	}
}

// A declared SIZE over the cap is refused at MAIL FROM, before a byte of body
// is transferred — AND the refusal is recorded.
//
// This was a silent drop. go-smtp answers the declared-size case itself at
// conn.go:360, before the Mail callback, so the refusal reached neither
// parse_diagnostics nor smtp_rejections while the identical message sent
// WITHOUT the ESMTP SIZE parameter produced a user-scoped row. Gmail and
// Postfix both send SIZE, which made the unaccounted path the likely one.
func TestAnOversizedDeclaredSizeIsRefusedAndAccounted(t *testing.T) {
	cfg := testMailConfig()
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	c.hello()
	code, _ := c.cmd("MAIL FROM:<bank@dib.ae> SIZE=%d", cfg.MaxMessageBytes*100)
	if code != 552 {
		t.Fatalf("a declared SIZE far over the cap -> %d, want 552", code)
	}
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectTooLarge); n != 1 {
		t.Fatalf("smtp_rejections[too_large] = %d, want 1: a refusal with no trace is a silent drop", n)
	}
	// NOT user-scoped, and that is deliberate rather than an omission: no
	// recipient has been named yet, and deferring this refusal to RCPT so it
	// could be scoped would answer 552 for an address that exists and 550 for
	// one that does not — a free enumeration oracle.
	if n := countDiagRows(t, f.pool); n != 0 {
		t.Fatalf("%d user-scoped rows for a refusal made before any recipient was named", n)
	}
	// A declared size at exactly the cap is not oversized.
	c2 := dial(t, f.addr)
	c2.hello()
	if code, _ := c2.cmd("MAIL FROM:<bank@dib.ae> SIZE=%d", cfg.MaxMessageBytes); code != 250 {
		t.Fatalf("a declared SIZE exactly at the cap -> %d, want 250", code)
	}
}

// ---------------------------------------------------------------------------
// Attack 3b: BDAT, the second body path
// ---------------------------------------------------------------------------

// CHUNKING is advertised unconditionally by go-smtp and BDAT is dispatched
// unconditionally, so this is a real, reachable way to hand the process a body.
// It had no test at all, which is how the ceiling it disables went unnoticed.
func TestBdatDeliversAMessage(t *testing.T) {
	f := newFixture(t, testMailConfig())
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	body := mailOf(512)
	if code, msg := c.bdat(body[:256], false); code != 250 {
		t.Fatalf("first chunk -> %d %q", code, msg)
	}
	if code, msg := c.bdat(body[256:], true); code != 250 {
		t.Fatalf("last chunk -> %d %q", code, msg)
	}
	got := f.h.deliveries()
	if len(got) != 1 {
		t.Fatalf("want one delivery, got %d", len(got))
	}
	if string(got[0].Raw) != string(body) {
		t.Fatalf("delivered %d bytes, sent %d", len(got[0].Raw), len(body))
	}
}

// THE REMOTE OOM. go-smtp sets its line limit to 0 — which means UNLIMITED —
// for the duration of a BDAT chunk and restores it only on the error path and
// on LAST, so after one successful non-last chunk the connection has no line
// limit for the rest of its life. Measured before the guard existed: a single
// 32 MiB line was buffered in full and answered 250, growing TotalAlloc by
// 256 MiB. The precondition is one accepted recipient, i.e. one leaked address.
//
// The control half of this test is the point: the same probe on a connection
// that has NOT used BDAT is refused by go-smtp's own limit, so a green result
// here cannot come from the library still doing its job.
func TestBdatCannotDisableTheLineCeiling(t *testing.T) {
	f := newFixture(t, testMailConfig())
	// Sized to isolate the LINE ceiling: over it, but comfortably under the
	// per-transaction byte budget. A first draft used a probe larger than both,
	// so the budget tripped first and the test passed with the line enforcement
	// deleted — it was asserting the wrong guard. This precondition keeps it
	// honest if either constant moves.
	// TERMINATED with a CRLF, so the server has to answer rather than sit
	// waiting for the rest of the line. An unterminated probe made this test
	// pass against a deleted line ceiling, because the client's own read
	// deadline expiring looks exactly like the server refusing.
	probe := append(bytes.Repeat([]byte("a"), 2*guardMaxLine), '\r', '\n')
	if int64(len(probe)) >= f.srv.transactionBudget() {
		t.Fatalf("probe of %d bytes is not under the transaction budget of %d; "+
			"this test would pass on the byte budget alone", len(probe), f.srv.transactionBudget())
	}

	// Control: no BDAT. go-smtp's own MaxLineLength refuses it.
	ctl := dial(t, f.addr)
	ctl.hello()
	if _, err := ctl.nc.Write(probe); err != nil {
		t.Fatal(err)
	}
	_ = ctl.nc.SetReadDeadline(time.Now().Add(10 * time.Second))
	if code, _, err := ctl.tp.ReadResponse(0); err == nil && code/100 == 2 {
		t.Fatalf("control: an unterminated %d-byte line was accepted: %d", len(probe), code)
	}

	// The real thing: one successful non-last chunk, then the same probe.
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	if code, msg := c.bdat([]byte("x"), false); code != 250 {
		t.Fatalf("non-last chunk -> %d %q, want 250", code, msg)
	}
	if _, err := c.nc.Write(probe); err != nil {
		t.Fatal(err)
	}
	_ = c.nc.SetReadDeadline(time.Now().Add(10 * time.Second))
	code, msg, err := c.tp.ReadResponse(0)
	if err != nil {
		return // the server dropped us, which is the outcome asked for
	}
	// 421 is the guard: a read error inside go-smtp's command loop. A 5xx means
	// the whole line WAS buffered and then parsed as a command — exactly the
	// pre-fix behaviour, just with a tidy-looking reply on the end of it.
	if code != 421 {
		t.Fatalf("after a BDAT chunk a %d-byte line got %d %q; the line ceiling is "+
			"not being enforced under the library", len(probe), code, msg)
	}
	if f.h.count() != 0 {
		t.Fatal("nothing may have been delivered")
	}
}

// The library's own BDAT size check reads its MaxMessageBytes, which is now
// zero, so the cap on this path has to be — and is — the same one DATA uses,
// with the same user-scoped accounting. Before this change the library answered
// 552 at conn.go:1025 and wrote nothing anywhere.
func TestBdatOverTheCapIsRejectedAndAccounted(t *testing.T) {
	cfg := testMailConfig()
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	code, msg := c.bdat(mailOf(cfg.MaxMessageBytes+1), true)
	if code != 552 {
		t.Fatalf("an over-cap BDAT body -> %d %q, want 552", code, msg)
	}
	if f.h.count() != 0 {
		t.Fatal("an oversized message must never reach the handler")
	}
	rows := diagRows(t, f.pool)
	if len(rows) != 1 || rows[0].outcome != diag.OutcomeRejected {
		t.Fatalf("want one rejected row scoped to the user, got %+v", rows)
	}
	if rows[0].rejectReason == nil || *rows[0].rejectReason != diag.RejectTooLarge {
		t.Fatalf("reject_reason = %v", rows[0].rejectReason)
	}
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectTooLarge); n != 1 {
		t.Fatalf("smtp_rejections[too_large] = %d, want 1", n)
	}
}

// A BDAT body exactly at the cap is accepted, same as DATA.
func TestBdatExactlyAtTheCapIsAccepted(t *testing.T) {
	cfg := testMailConfig()
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	if code, msg := c.bdat(mailOf(cfg.MaxMessageBytes), true); code != 250 {
		t.Fatalf("a BDAT body exactly at the cap -> %d %q, want 250", code, msg)
	}
	if got := f.h.deliveries(); len(got) != 1 || len(got[0].Raw) != cfg.MaxMessageBytes {
		t.Fatalf("want one delivery of exactly %d bytes, got %+v", cfg.MaxMessageBytes, got)
	}
}

// The byte budget bounds everything else one transaction can make the process
// read, including the drain go-smtp performs after a refusal — which it runs
// with its own limit explicitly disabled.
func TestATransactionCannotExceedItsByteBudget(t *testing.T) {
	cfg := testMailConfig()
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	if code, _ := c.cmd("DATA"); code != 354 {
		t.Fatal("expected 354")
	}
	// Well-formed lines, so the line ceiling is not what stops this: far more
	// bytes than one transaction is allowed to cost.
	huge := mailOf(int(f.srv.transactionBudget()) + 64<<10)
	_ = c.nc.SetWriteDeadline(time.Now().Add(20 * time.Second))
	_, _ = c.nc.Write(huge)
	_, _ = c.nc.Write([]byte("\r\n.\r\n"))

	_ = c.nc.SetReadDeadline(time.Now().Add(15 * time.Second))
	code, _, err := c.tp.ReadResponse(0)
	if err == nil && code/100 == 2 {
		t.Fatalf("a transaction %d bytes over its budget was accepted: %d", 64<<10, code)
	}
	if f.h.count() != 0 {
		t.Fatal("nothing may be delivered")
	}
}

// ---------------------------------------------------------------------------
// Attack 3c: holding the process open
// ---------------------------------------------------------------------------

// go-smtp has no concurrency limit of any kind. Each connection holds a
// goroutine, a read timeout, and potentially a whole buffered message.
func TestTheTotalConnectionCapRefusesWith421(t *testing.T) {
	f := newFixture(t, testMailConfig(), withConnCaps(3, 3))
	var held []*client
	for i := 0; i < 3; i++ {
		held = append(held, dial(t, f.addr)) // each greets with 220 and stays open
	}
	nc, err := net.DialTimeout("tcp", f.addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	_ = nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	code, _, err := textproto.NewConn(nc).ReadResponse(0)
	if err != nil {
		t.Fatalf("an over-cap connection should be told 421, not closed in silence: %v", err)
	}
	if code != 421 {
		t.Fatalf("connection over the cap -> %d, want 421", code)
	}
	nc.Close()
	// The listener is still serving — refusing must not take the server down,
	// which returning an error from Accept would have done — and a slot freed by
	// a closing connection is reusable.
	held[0].nc.Close()
	deadline := time.Now().Add(5 * time.Second)
	for f.srv.liveConns() >= 3 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	dial(t, f.addr)
}

func TestThePerSourceConnectionCapRefusesWith421(t *testing.T) {
	f := newFixture(t, testMailConfig(), withConnCaps(100, 2))
	dial(t, f.addr)
	dial(t, f.addr)
	nc, err := net.DialTimeout("tcp", f.addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	_ = nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	code, _, err := textproto.NewConn(nc).ReadResponse(0)
	if err != nil || code != 421 {
		t.Fatalf("a third connection from one source -> %d (%v), want 421", code, err)
	}
}

// A closed connection returns its slot, or the caps are a one-way ratchet that
// bricks the receiver after MaxConns lifetime connections.
func TestClosingAConnectionReturnsItsSlot(t *testing.T) {
	f := newFixture(t, testMailConfig(), withConnCaps(2, 2))
	for i := 0; i < 6; i++ {
		nc, err := net.DialTimeout("tcp", f.addr, 5*time.Second)
		if err != nil {
			t.Fatalf("connection %d: %v", i, err)
		}
		_ = nc.SetReadDeadline(time.Now().Add(5 * time.Second))
		code, _, err := textproto.NewConn(nc).ReadResponse(0)
		if err != nil || code != 220 {
			t.Fatalf("connection %d after %d closes -> %d (%v), want a 220 greeting", i, i, code, err)
		}
		nc.Close()
		// The decrement happens as the server's connection goroutine unwinds.
		deadline := time.Now().Add(5 * time.Second)
		for f.srv.liveConns() > 0 && time.Now().Before(deadline) {
			time.Sleep(2 * time.Millisecond)
		}
	}
}

// ---------------------------------------------------------------------------
// Attack 4: the per-address quota, and trying to get around it
// ---------------------------------------------------------------------------

func TestPerAddressDailyQuota(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 5
	f := newFixture(t, cfg)
	body := mailOf(256)
	for i := 0; i < 5; i++ {
		c := dial(t, f.addr)
		if code, msg := c.send("bank@dib.ae", knownRcpt, body); code != 250 {
			t.Fatalf("message %d -> %d %q, want 250", i+1, code, msg)
		}
	}
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	code, msg := c.cmd("RCPT TO:<%s>", knownRcpt)
	if code != 452 {
		t.Fatalf("over quota -> %d %q, want 452 (TEMPORARY, so a legitimate burst retries)", code, msg)
	}
	if msg != "4.2.2 mailbox full" {
		t.Fatalf("over-quota text = %q", msg)
	}
	if f.h.count() != 5 {
		t.Fatalf("%d deliveries, want 5", f.h.count())
	}
	rows := diagRows(t, f.pool)
	if len(rows) != 1 {
		t.Fatalf("want one over-quota diagnostics row, got %d", len(rows))
	}
	if rows[0].outcome != diag.OutcomeOverQuota {
		t.Fatalf("outcome = %q, want %q", rows[0].outcome, diag.OutcomeOverQuota)
	}
	if !rows[0].userID.Valid || rows[0].userID.UUID != f.user {
		t.Fatal("the recipient resolved, so the over-quota notice is user-scoped")
	}
	if rows[0].rejectReason == nil || *rows[0].rejectReason != diag.RejectOverQuota {
		t.Fatalf("reject_reason = %v", rows[0].rejectReason)
	}
}

// The quota is keyed on the RESOLVED USER, never on the recipient string.
// addresses.Resolve folds case and strips brackets and does not hand back the
// normalized local part, so a receiver keying on the raw RCPT would give one
// mailbox 2^26 distinct quota buckets. This runs against the REAL addresses
// package, not the double.
func TestQuotaSurvivesRecipientCaseAndBracketVariation(t *testing.T) {
	pool := pgtest.New(t)
	uid := insertUser(t, pool)
	addrs := &addresses.Addresses{Pool: pool, Suffix: testSuffix}
	local, err := addrs.Issue(bg, uid)
	if err != nil {
		t.Fatal(err)
	}

	cfg := testMailConfig()
	cfg.PerAddressDaily = 3
	h := &recorder{}
	_, srvAddr := start(t, cfg, addrs, h, &diag.Diag{Pool: pool}, withConnCaps(512, 512))

	// Every one of these is the same mailbox after normalization.
	variants := []string{
		local + testSuffix,
		strings.ToUpper(local) + testSuffix,
		local[:3] + strings.ToUpper(local[3:]) + strings.ToUpper(testSuffix),
		local + strings.ToUpper(testSuffix[:4]) + testSuffix[4:],
	}
	body := mailOf(256)
	accepted, refused := 0, 0
	for _, v := range variants {
		c := dial(t, srvAddr)
		code, msg := c.send("bank@dib.ae", v, body)
		switch code {
		case 250:
			accepted++
		case 452:
			refused++
		default:
			t.Fatalf("variant %q -> %d %q", v, code, msg)
		}
	}
	if accepted != 3 || refused != 1 {
		t.Fatalf("case variation bought %d accepted / %d refused; the allowance is 3 for the single "+
			"mailbox all four spellings name", accepted, refused)
	}
	if h.count() != 3 {
		t.Fatalf("%d deliveries, want 3", h.count())
	}
}

// A user inside the 7-day rotation grace window has TWO local parts that
// resolve to them. Keying the quota on the user means the pair shares one
// allowance rather than doubling it.
func TestGraceAddressSharesTheUsersAllowance(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 2
	pool := pgtest.New(t)
	uid := insertUser(t, pool)
	res := resolverWith()
	const old = "u-oldoldoldoldoldoldoldoldo"
	res.users[knownLocal] = uid
	res.users[old] = uid
	res.grace[old] = true
	h := &recorder{}
	_, srvAddr := start(t, cfg, res, h, &diag.Diag{Pool: pool}, withConnCaps(512, 512))

	body := mailOf(256)
	dial(t, srvAddr).send("bank@dib.ae", knownRcpt, body)
	dial(t, srvAddr).send("bank@dib.ae", old+testSuffix, body)
	c := dial(t, srvAddr)
	c.envelope("bank@dib.ae")
	if code, _ := c.cmd("RCPT TO:<%s>", knownRcpt); code != 452 {
		t.Fatalf("the active and grace addresses must share one allowance, got %d", code)
	}
	got := h.deliveries()
	if len(got) != 2 {
		t.Fatalf("want 2 deliveries, got %d", len(got))
	}
	if got[0].IsGrace {
		t.Fatal("delivery via the active address must not be flagged as grace")
	}
	if !got[1].IsGrace {
		t.Fatal("delivery via the retired address must carry IsGrace for Task 25's trust lane")
	}
}

// One notice says what a hundred identical ones do. Every refusal is still
// COUNTED — that is what keeps the "zero drops" arithmetic complete — but the
// user-scoped rows are bounded, so an attacker holding a valid address cannot
// grow the diagnostics table without limit. This is the same hole the
// aggregated smtp_rejections counter exists to close for unknown recipients.
func TestOverQuotaNoticesAreBoundedButEveryRefusalIsCounted(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 1
	f := newFixture(t, cfg, withHighRefusalThreshold())
	c := dial(t, f.addr)
	if code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatal("the first message is inside the allowance")
	}
	const attempts = 40
	for i := 0; i < attempts; i++ {
		c := dial(t, f.addr)
		c.envelope("bank@dib.ae")
		c.mustCmd(452, "RCPT TO:<%s>", knownRcpt)
	}
	rows := diagRows(t, f.pool)
	if len(rows) == 0 {
		t.Fatal("at least one notice must be recorded: a refusal with no trace is a silent drop")
	}
	if len(rows) > DefaultNoticesPerWindow {
		t.Fatalf("%d user-scoped rows from %d refusals; notices must be bounded", len(rows), attempts)
	}
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectOverQuota); n != attempts {
		t.Fatalf("smtp_rejections[over_quota] = %d, want %d — every refusal is accounted for", n, attempts)
	}
}

// The allowance is a limit on DELIVERED mail, not on attempts. Charging for an
// abandoned transaction makes it a remote off switch: 50 MAIL/RCPT/RSET cycles
// take a few milliseconds, send nothing, and leave the user's next real message
// bouncing off a 452.
func TestAbandonedTransactionsDoNotBurnTheAllowance(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 3
	f := newFixture(t, cfg, withHighRefusalThreshold())
	c := dial(t, f.addr)
	c.hello()
	for i := 0; i < 30; i++ { // ten times the day's allowance, in one connection
		c.mustCmd(250, "MAIL FROM:<attacker@elsewhere.test>")
		c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
		c.mustCmd(250, "RSET")
	}
	// The user's mail still arrives.
	real := dial(t, f.addr)
	if code, msg := real.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatalf("after 30 abandoned transactions the user's real message -> %d %q, want 250", code, msg)
	}
	if f.h.count() != 1 {
		t.Fatalf("%d deliveries, want 1", f.h.count())
	}
}

// The same hold, taken and never released: a connection that stops after RCPT.
// Dropping it must return the unit rather than parking it until the read
// timeout.
func TestAHangUpAfterRcptReturnsTheUnit(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 1
	f := newFixture(t, cfg, withHighRefusalThreshold())
	c := dial(t, f.addr)
	c.envelope("attacker@elsewhere.test")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	c.nc.Close()

	deadline := time.Now().Add(5 * time.Second)
	for f.srv.liveConns() > 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	real := dial(t, f.addr)
	if code, _ := real.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatalf("a hung-up transaction parked the user's only unit, got %d", code)
	}
}

// A message the server could not deliver has not been delivered, so it must not
// cost the user a unit — otherwise every retry of a deferred message eats the
// allowance, and runServe currently defers EVERY message until Task 29 lands.
func TestADeferredMessageDoesNotBurnTheAllowance(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 2
	f := newFixture(t, cfg, withHighRefusalThreshold())
	f.h.fail(errors.New("ingest not implemented yet"))
	for i := 0; i < 5; i++ {
		c := dial(t, f.addr)
		if code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(256)); code/100 != 4 {
			t.Fatalf("attempt %d -> %d, want a 4xx", i, code)
		}
	}
	f.h.fail(nil)
	c := dial(t, f.addr)
	if code, msg := c.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatalf("once the handler recovered the retry -> %d %q, want 250", code, msg)
	}
}

// An oversized message is a refusal, metered on the source, not a charge
// against the recipient's mailbox.
func TestAnOversizedMessageDoesNotBurnTheAllowance(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 2
	f := newFixture(t, cfg, withHighRefusalThreshold())
	for i := 0; i < 4; i++ {
		c := dial(t, f.addr)
		if code, _ := c.send("attacker@elsewhere.test", knownRcpt, mailOf(cfg.MaxMessageBytes+1)); code != 552 {
			t.Fatalf("attempt %d -> %d, want 552", i, code)
		}
	}
	c := dial(t, f.addr)
	if code, msg := c.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatalf("four oversized uploads emptied the user's allowance: %d %q", code, msg)
	}
}

// The over-quota branch is metered exactly like an unknown recipient. It used
// to have no tarpit and no disconnect debt, and a database write per attempt:
// 5,396 refusals per second down one socket, with the connection still open.
func TestOverQuotaRefusalsAreMeteredAndEventuallyDropTheConnection(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 1
	f := newFixture(t, cfg, withLimiter(LimiterConfig{
		Burst: 1, Base: time.Millisecond, Max: 2 * time.Millisecond,
		Window: time.Hour, Disconnect: 4, Daily: cfg.PerAddressDaily,
	}))
	c := dial(t, f.addr)
	if code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatal("the first message is inside the allowance")
	}
	// Every one of these is now a refusal on the per-source counter.
	for i := 0; i < 3; i++ {
		c.mustCmd(250, "MAIL FROM:<bank@dib.ae>")
		c.mustCmd(452, "RCPT TO:<%s>", knownRcpt)
	}
	c.mustCmd(250, "MAIL FROM:<bank@dib.ae>")
	if code, _ := c.cmd("RCPT TO:<%s>", knownRcpt); code != 421 {
		t.Fatalf("a fourth over-quota refusal -> %d, want 421: the branch is unmetered", code)
	}
	_ = c.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.nc.Read(make([]byte, 1)); err == nil {
		t.Fatal("the connection survived the disconnect threshold")
	}
}

// ---------------------------------------------------------------------------
// Attack 5: holding resources open
// ---------------------------------------------------------------------------

// Slowloris, DATA-phase variant: open a transaction, take the 354, then
// trickle. The read deadline set before the body is read bounds the whole
// transfer, so the connection cannot be held indefinitely.
func TestASlowDataTransferIsCutOffByTheReadTimeout(t *testing.T) {
	f := newFixture(t, testMailConfig(), func(s *Server) {
		s.inner.ReadTimeout = 200 * time.Millisecond
	})
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	if code, _ := c.cmd("DATA"); code != 354 {
		t.Fatal("expected 354")
	}
	go func() {
		for i := 0; i < 50; i++ {
			if _, err := c.nc.Write([]byte("a")); err != nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()
	_ = c.nc.SetReadDeadline(time.Now().Add(10 * time.Second))
	code, _, err := c.tp.ReadResponse(0)
	if err == nil && code/100 != 4 {
		t.Fatalf("a stalled transfer -> %d, want a 4xx so the sender retries", code)
	}
	if f.h.count() != 0 {
		t.Fatal("a truncated transfer must not be delivered")
	}
}

// A line longer than the limit is refused rather than buffered. go-smtp handles
// this one entirely internally, so it is pinned here to document the behaviour
// — including that it is the one refusal the receiver cannot account for. See
// the package doc.
func TestAnOverlongLineIsRefusedWithoutBufferingIt(t *testing.T) {
	f := newFixture(t, testMailConfig())
	c := dial(t, f.addr)
	c.hello()
	long := "MAIL FROM:<" + strings.Repeat("a", MaxLineLength+1000) + "@x.test>\r\n"
	if _, err := c.nc.Write([]byte(long)); err != nil {
		t.Fatal(err)
	}
	_ = c.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	code, _, err := c.tp.ReadResponse(0)
	if err == nil && code/100 == 2 {
		t.Fatalf("an overlong line was accepted: %d", code)
	}
}

// ---------------------------------------------------------------------------
// The drop policy: a refusal that leaves no trace is a silent drop
// ---------------------------------------------------------------------------

// A handler failure is the ingest path being unavailable, not the message being
// unwanted. A 5xx bounces mail the user was entitled to; a 4xx makes the
// sending MTA retry for the ~1-3 days §3.2 relies on.
func TestHandlerFailureIsATemporaryFailureSoMailIsRetried(t *testing.T) {
	f := newFixture(t, testMailConfig())
	f.h.fail(errors.New("database is down"))
	c := dial(t, f.addr)
	code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(256))
	if code/100 != 4 {
		t.Fatalf("a handler failure -> %d, want a 4xx so the sender retries instead of bouncing", code)
	}
}

// A resolver failure is an INFRASTRUCTURE failure, not a rejection. Answering
// 550 during a database outage would tell every sender that every user's
// address had ceased to exist — and Gmail disables a forwarding rule after
// sustained permanent failures.
func TestResolverInfrastructureFailureIsTemporaryAndDoesNotFeedTheTarpit(t *testing.T) {
	f := newFixture(t, testMailConfig())
	f.res.fail(errors.New("connection refused"))
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	code, _ := c.cmd("RCPT TO:<%s>", knownRcpt)
	if code/100 != 4 {
		t.Fatalf("a resolver outage -> %d, want a 4xx", code)
	}
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectUnknownRcpt); n != 0 {
		t.Fatalf("an outage counted %d unknown recipients; it is not the sender's fault", n)
	}
	if f.srv.limiter.Blocked(netip.MustParseAddr("127.0.0.1")) {
		t.Fatal("an outage must not accumulate tarpit debt against innocent senders")
	}
}

// If a refusal cannot be recorded anywhere, it is downgraded to a temporary
// failure: the sender retries and we get another chance to notice it. A
// permanent 552 with no trace anywhere is exactly the silent drop §2 forbids.
func TestARefusalThatCannotBeRecordedIsDeferredRatherThanDropped(t *testing.T) {
	cfg := testMailConfig()
	// A diagnostics writer with no pool: every write fails.
	f := newFixture(t, cfg, func(s *Server) { s.diag = &diag.Diag{} })
	c := dial(t, f.addr)
	code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(cfg.MaxMessageBytes+1))
	if code/100 != 4 {
		t.Fatalf("an unrecordable refusal -> %d, want a 4xx so it is not dropped without notice", code)
	}
	if f.h.count() != 0 {
		t.Fatal("an oversized message is still not delivered")
	}
}

// ---------------------------------------------------------------------------
// What the handler is handed
// ---------------------------------------------------------------------------

func TestDeliveryCarriesTheEnvelopeAndTheResolvedUser(t *testing.T) {
	f := newFixture(t, testMailConfig())
	before := time.Now().Add(-time.Second)
	body := mailOf(512)
	c := dial(t, f.addr)
	if code, msg := c.send("alerts@dib.ae", knownRcpt, body); code != 250 {
		t.Fatalf("%d %q", code, msg)
	}
	got := f.h.deliveries()
	if len(got) != 1 {
		t.Fatalf("want one delivery, got %d", len(got))
	}
	d := got[0]
	if d.UserID != f.user {
		t.Fatalf("UserID = %v, want %v", d.UserID, f.user)
	}
	if d.EnvelopeFrom != "alerts@dib.ae" {
		t.Fatalf("EnvelopeFrom = %q", d.EnvelopeFrom)
	}
	if d.Rcpt != knownRcpt {
		t.Fatalf("Rcpt = %q, want %q", d.Rcpt, knownRcpt)
	}
	if !d.RemoteIP.IsLoopback() {
		t.Fatalf("RemoteIP = %v, want the loopback address the test dialled from", d.RemoteIP)
	}
	if d.ReceivedAt.Before(before) || d.ReceivedAt.After(time.Now().Add(time.Second)) {
		t.Fatalf("ReceivedAt = %v is not the arrival instant", d.ReceivedAt)
	}
	if string(d.Raw) != string(body) {
		t.Fatalf("delivered body differs from what was sent (%d vs %d bytes)", len(d.Raw), len(body))
	}
	if d.IsGrace {
		t.Fatal("an active address is not a grace address")
	}
}

// A second recipient is refused, and the message is still delivered to the
// first: this receiver is not a mailing list and never fans one message out.
func TestOnlyOneRecipientPerMessage(t *testing.T) {
	f := newFixture(t, testMailConfig())
	other := uuid.New()
	f.res.users["u-secondsecondsecondseconds"] = other
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	if code, _ := c.cmd("RCPT TO:<u-secondsecondsecondseconds%s>", testSuffix); code == 250 {
		t.Fatal("a second recipient must not be accepted")
	}
	if code, _ := c.data(mailOf(256)); code != 250 {
		t.Fatal("the first recipient's message is still delivered")
	}
	got := f.h.deliveries()
	if len(got) != 1 || got[0].UserID != f.user {
		t.Fatalf("want exactly one delivery to the first recipient, got %+v", got)
	}
}

// RSET must clear the resolved recipient, or a second transaction on the same
// connection would inherit the first one's user and file mail into the wrong
// ledger.
func TestResetClearsTheResolvedRecipient(t *testing.T) {
	f := newFixture(t, testMailConfig())
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	c.mustCmd(250, "RSET")
	c.mustCmd(250, "MAIL FROM:<other@dib.ae>")
	if code, _ := c.cmd("DATA"); code/100 != 5 {
		t.Fatalf("DATA after RSET -> %d, want a 5xx: there is no recipient any more", code)
	}
	if f.h.count() != 0 {
		t.Fatal("nothing may be delivered after a reset")
	}
}

// A second message on one connection is a normal thing for an MTA to do, and
// each one is quota-checked on its own.
func TestASecondMessageOnOneConnectionIsCheckedAgain(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 1
	f := newFixture(t, cfg)
	c := dial(t, f.addr)
	if code, _ := c.send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatal("the first message is inside the allowance")
	}
	c.mustCmd(250, "MAIL FROM:<bank@dib.ae>")
	if code, _ := c.cmd("RCPT TO:<%s>", knownRcpt); code != 452 {
		t.Fatalf("the second message on the same connection -> %d, want 452", code)
	}
}

// Many simultaneous connections, one address: the allowance is a limit, not a
// suggestion, and a check-then-act split across connection goroutines would
// silently exceed it. The pool is warmed with one transaction first so the
// assertion is about the limiter, not about connection setup.
func TestConcurrentConnectionsCannotExceedTheAllowance(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 10
	f := newFixture(t, cfg, withHighRefusalThreshold())
	body := mailOf(256)
	if code, _ := dial(t, f.addr).send("bank@dib.ae", knownRcpt, body); code != 250 {
		t.Fatal("warm-up message rejected")
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := dial(t, f.addr)
			code, _ := c.send("bank@dib.ae", knownRcpt, body)
			if code == 250 {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if accepted != 9 {
		t.Fatalf("%d of 24 concurrent messages accepted; 9 of the allowance of 10 were left", accepted)
	}
	if f.h.count() != 10 {
		t.Fatalf("%d deliveries, want 10", f.h.count())
	}
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

func TestShutdownStopsAcceptingAndReleasesThePort(t *testing.T) {
	f := newFixture(t, testMailConfig())
	ctx, cancel := context.WithTimeout(bg, 10*time.Second)
	defer cancel()
	if err := f.srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if c, err := net.DialTimeout("tcp", f.addr, time.Second); err == nil {
		c.Close()
		t.Fatal("the listener is still accepting after shutdown")
	}
	// Idempotent: the fixture cleanup calls it again.
	if err := f.srv.Shutdown(ctx); err != nil {
		t.Fatalf("second shutdown: %v", err)
	}
}

// A tarpit delay must not hold shutdown hostage for its full duration: 30
// seconds per parked connection is longer than most deploy scripts wait before
// resorting to SIGKILL.
func TestShutdownInterruptsAnInFlightTarpitDelay(t *testing.T) {
	f := newFixture(t, testMailConfig(), withLimiter(LimiterConfig{
		Burst: 1, Base: 30 * time.Second, Max: 30 * time.Second,
		Window: time.Hour, Disconnect: 1000,
	}))
	c := dial(t, f.addr)
	c.envelope("probe@attacker.test")
	c.mustCmd(550, "RCPT TO:<%s>", unknownRcpt(0)) // free, inside the burst

	// This one stalls for 30 seconds unless shutdown wakes it. Driven from a
	// goroutine with raw reads: the client helpers call t.Fatalf, which is not
	// valid off the test's own goroutine.
	replied := make(chan time.Duration, 1)
	go func() {
		started := time.Now()
		_ = c.tp.PrintfLine("RCPT TO:<%s>", unknownRcpt(1))
		_ = c.nc.SetReadDeadline(time.Now().Add(25 * time.Second))
		_, _, _ = c.tp.ReadResponse(0)
		replied <- time.Since(started)
		c.nc.Close()
	}()
	time.Sleep(300 * time.Millisecond)

	ctx, cancel := context.WithTimeout(bg, 20*time.Second)
	defer cancel()
	started := time.Now()
	if err := f.srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("shutdown took %v; the tarpit sleep is not interruptible", elapsed)
	}
	select {
	case d := <-replied:
		if d > 5*time.Second {
			t.Fatalf("the stalled recipient was answered after %v; the sleep ran its full course", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stalled connection was never answered at all")
	}
}

// An idle peer must not be able to hold shutdown open. This is ordinary MTA
// behaviour rather than an attack — a connection between commands is idle by
// definition — so a shutdown that waits for it waits on a stranger's schedule.
func TestShutdownForceClosesAnIdlePeer(t *testing.T) {
	f := newFixture(t, testMailConfig())
	c := dial(t, f.addr)
	c.envelope("bank@dib.ae") // a live session, now sitting idle
	ctx, cancel := context.WithTimeout(bg, 500*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := f.srv.Shutdown(ctx)
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("shutdown took %v waiting for an idle peer", elapsed)
	}
	// Reported, not swallowed. Returning nil whether or not connections had to
	// be cut makes a forced shutdown indistinguishable from a clean one in the
	// operator's log, and made the caller's error branch unreachable.
	if err == nil {
		t.Fatal("a shutdown that had to force connections closed must say so")
	}
	_ = c.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.nc.Read(make([]byte, 1)); err == nil {
		t.Fatal("the idle connection survived shutdown")
	}
}

func TestListenAndServeBindsTheConfiguredAddress(t *testing.T) {
	pool := pgtest.New(t)
	cfg := testMailConfig()
	srv := New(cfg, resolverWith(), &recorder{}, &diag.Diag{Pool: pool}, time.Now)
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	deadline := time.Now().Add(10 * time.Second)
	for srv.Addr() == "" && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.HasPrefix(srv.Addr(), "127.0.0.1:") {
		t.Fatalf("bound %q, want a loopback address", srv.Addr())
	}
	c := dial(t, srv.Addr())
	c.hello()
	c.nc.Close()
	ctx, cancel := context.WithTimeout(bg, 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-errc; err != nil {
		t.Fatalf("ListenAndServe returned %v", err)
	}
}
