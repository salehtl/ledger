// Package smtpd is the hardened inbound SMTP receiver (spec §3.2).
//
// # What this port is
//
// It is the most exposed surface in the system: port 25, public,
// unauthenticated, and it writes into a financial ledger. There is no shared
// secret with the bank and no allowlist the user configures up front — the
// per-user address token (internal/v2/addresses) is the only thing standing
// between an attacker and injecting bank-shaped mail into a stranger's budget.
// Entropy stops an offline search; this package closes the online one.
//
// # The four rules, and why each is not merely configuration
//
//  1. AN UNKNOWN RECIPIENT IS REFUSED AT RCPT TIME, WITH ONE REPLY. Every
//     rejection — never issued, malformed, wrong domain, lapsed grace — is the
//     byte-identical "550 5.1.1 <no such recipient>". addresses.Resolve went to
//     the trouble of returning a single sentinel with a single text precisely
//     so this layer could not re-split them; a receiver that answered "no such
//     user" differently from "not our domain" would rebuild the enumeration
//     oracle one layer up.
//
//  2. INVALID RECIPIENTS ARE TARPITTED, PER SOURCE. A refusal that costs the
//     prober nothing is a free search over the address space. The delay
//     doubles from TarpitBase after a small free burst, caps at 30s, and past
//     20 in a rolling hour the connection is dropped with a 421. See [Limiter].
//
//  3. DATA IS CAPPED, AND THE CAP COMES FROM CONFIG. cfg.MaxMessageBytes is
//     clamped by config.validate to blob.MaxColdMail — the largest message that
//     still fits a padding bucket once base64'd inside a JSON record. A
//     hardcoded cap here would reproduce the "seals fine, permanently
//     unopenable" failure from the other side: mail accepted over SMTP that the
//     ingest path can then never store.
//
//  4. A REFUSAL LEAVES A TRACE. Spec §2's drop policy is "nothing is dropped
//     without a user-visible notice", and the Phase 1 exit test is "every
//     inbound email accounted for". Refusals with a resolved recipient write a
//     user-scoped diagnostics row; refusals without one (an unknown recipient
//     has no user to scope to, and one row per attempt would let anyone flood
//     the table from the open port) increment the aggregated counter instead.
//     A refusal this receiver cannot record anywhere is downgraded to a
//     TEMPORARY failure, so the sender retries and we get another chance,
//     rather than being permanently refused with no trace.
//
// # What this package deliberately does NOT do
//
//   - NO DKIM OR ARC VERIFICATION, and no trust-lane decision. That is Tasks
//     25/26. Nothing here inspects a header, and the seam is [Handler]: the
//     receiver hands over the untouched raw message plus the envelope facts,
//     and everything about origin trust happens on the other side of it. The
//     one place this package touches the envelope sender is the diagnostics
//     sender_domain of a REFUSED message, which is written with
//     diag.UnverifiedPrefix — an envelope domain is an attacker's assertion,
//     and a column that rendered it like a verified one would launder it.
//   - NO RECEIVED HEADER IS PREPENDED. Task 25 verifies signatures over the
//     message as it arrived; if the ARC chain work needs a trace header, it
//     must be added there, deliberately, and not silently here.
//   - NO SPOOLING OR RETRY. [Handler.Deliver] failing is answered with a 4xx so
//     the sending MTA retries — spec §3.2 counts on the ~1-3 days of retry that
//     buys. Task 35's relay implements the spooling Handler.
//
// # One refusal this package cannot account for
//
// go-smtp answers a syntactically invalid path (501), an over-long line (500)
// and a second recipient (452) inside its own command loop, without consulting
// the backend. Those never reach a session method, so they are counted nowhere.
// They are protocol errors rather than messages — no body was ever offered —
// and all three are answered before DATA, so no mail is silently discarded by
// them. TestAnOverlongLineIsRefusedWithoutBufferingIt pins the behaviour so a
// change in the library is visible.
package smtpd

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-smtp"
	"github.com/google/uuid"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/config"
	"ledger/internal/v2/diag"
)

const (
	// MaxRecipients is one. This is not a mail server: every message is for
	// exactly one user's ledger, and fanning one body out to several would
	// multiply an attacker's single upload across several accounts.
	MaxRecipients = 1
	// MaxLineLength is 8192, eight times RFC 5321's 1000-octet line limit.
	// go-smtp applies it to the DATA stream as well as to commands, so it is
	// also the longest body line this receiver will accept.
	MaxLineLength = 8192
	// ReadTimeout bounds a stalled client. It is set before each command line
	// AND covers the whole DATA transfer, which is what makes the slowloris
	// variant that trickles a body finite.
	ReadTimeout = 60 * time.Second
	// WriteTimeout bounds a client that stops reading our replies.
	WriteTimeout = 60 * time.Second

	// deliverTimeout bounds one handler call; resolveTimeout and diagTimeout
	// bound one database round trip each. Every one of them runs on a
	// connection an attacker controls the pace of, so none may be unbounded.
	deliverTimeout = 60 * time.Second
	resolveTimeout = 10 * time.Second
	diagTimeout    = 10 * time.Second
)

// The wire responses. Each is a package-level value rather than a literal at
// the point of use, because the property that matters is that several distinct
// code paths produce the IDENTICAL bytes.
var (
	// errUnknownRecipient is the single reply for every RCPT-time rejection.
	// Its text must not encode which check failed. See rule 1 in the package doc.
	errUnknownRecipient = &smtp.SMTPError{
		Code:         550,
		EnhancedCode: smtp.EnhancedCode{5, 1, 1},
		Message:      "<no such recipient>",
	}
	// errOverQuota is TEMPORARY on purpose: a legitimate burst retries instead
	// of bouncing, and Gmail disables a forwarding rule after sustained
	// permanent failures.
	errOverQuota = &smtp.SMTPError{
		Code:         452,
		EnhancedCode: smtp.EnhancedCode{4, 2, 2},
		Message:      "mailbox full",
	}
	errTooLarge = &smtp.SMTPError{
		Code:         552,
		EnhancedCode: smtp.EnhancedCode{5, 3, 4},
		Message:      "message too large",
	}
	// errTemporary covers every failure that is OURS rather than the sender's:
	// the database is unreachable, the ingest path is down, the transfer broke.
	// Answering 5xx to any of those would bounce mail the user was entitled to.
	errTemporary = &smtp.SMTPError{
		Code:         451,
		EnhancedCode: smtp.EnhancedCode{4, 3, 0},
		Message:      "temporary failure, please retry",
	}
	// errDisconnect is written by go-smtp's Conn.Reject before it closes the
	// connection; this value is what the session returns afterwards, into a
	// socket that is already gone.
	errDisconnect = &smtp.SMTPError{
		Code:         421,
		EnhancedCode: smtp.EnhancedCode{4, 4, 5},
		Message:      "too busy, try again later",
	}
)

// Delivery is one accepted message, handed to a [Handler] exactly as it
// arrived.
type Delivery struct {
	// UserID is the resolved recipient. This — not Rcpt — is the identity
	// everything downstream keys on.
	UserID uuid.UUID
	// Rcpt is the RAW recipient string the client sent, before any
	// normalization. It is here for provenance and logging only: it is
	// attacker-chosen, and case-folding means many spellings name one mailbox,
	// so nothing may be keyed on it. Use UserID.
	Rcpt string
	// EnvelopeFrom is the SMTP return path, "" for a null sender. It is an
	// assertion, not evidence: Task 25's DKIM/ARC verification decides what is
	// actually trusted.
	EnvelopeFrom string
	RemoteIP     netip.Addr
	// Raw is the message bytes as received: no header added, nothing rewritten.
	Raw        []byte
	ReceivedAt time.Time
	// IsGrace reports that the recipient was the user's RETIRED address inside
	// its 7-day rotation grace window. Spec §3.2 gives grace-window mail
	// different trust treatment, so the flag has to survive to Task 25.
	IsGrace bool
}

// Handler consumes accepted messages. Task 29 implements the ingest path;
// Task 35 implements the relay's spooling version.
//
// An error is answered with a TEMPORARY failure, so the sending MTA retries.
// A Handler must therefore return an error rather than swallow one: a swallowed
// failure is a message that was accepted, is not stored anywhere, and that
// nothing will ever retry — the silent drop §2 forbids.
type Handler interface {
	Deliver(ctx context.Context, d Delivery) error
}

// Resolver maps an SMTP recipient to the account that owns it. It is
// *addresses.Addresses in production.
//
// Its contract, which this package depends on: ONE sentinel
// (addresses.ErrUnknownRecipient) for every rejection, and any OTHER error
// means infrastructure — not a rejection.
type Resolver interface {
	Resolve(ctx context.Context, rcpt string) (userID uuid.UUID, isGrace bool, err error)
}

// Server is the receiver.
type Server struct {
	cfg      config.MailConfig
	resolver Resolver
	handler  Handler
	// diag and limiter are fields rather than constructor-captured values so
	// that a test in this package can substitute them BEFORE Serve starts. They
	// are never mutated afterwards.
	diag    *diag.Diag
	limiter *Limiter
	now     func() time.Time
	inner   *smtp.Server

	// done is closed by Shutdown so an in-flight tarpit delay wakes rather than
	// holding shutdown for its full 30 seconds.
	done     chan struct{}
	stopOnce sync.Once

	mu   sync.Mutex
	addr string
	// ln is the listener Serve was handed, so Shutdown can close it itself.
	ln net.Listener
	// conns is every live connection, so Shutdown can force-close what is left
	// when its window expires. go-smtp tracks connections too, but its Close —
	// the only thing that would reach them — returns immediately once Shutdown
	// has run, so after a graceful attempt the library offers no way to finish
	// the job.
	conns map[*trackedConn]struct{}
}

// New builds a receiver. cfg supplies the DATA cap, the daily allowance and the
// tarpit shape; the remaining limiter knobs are policy constants (see
// LimiterConfig). now defaults to time.Now.
func New(cfg config.MailConfig, res Resolver, h Handler, d *diag.Diag, now func() time.Time) *Server {
	if now == nil {
		now = time.Now
	}
	s := &Server{
		cfg:      cfg,
		resolver: res,
		handler:  h,
		diag:     d,
		now:      now,
		done:     make(chan struct{}),
		conns:    map[*trackedConn]struct{}{},
		limiter: NewLimiter(LimiterConfig{
			Burst:  cfg.InvalidRcptBurst,
			Base:   cfg.TarpitBase,
			Daily:  cfg.PerAddressDaily,
			Now:    now,
			MaxIPs: DefaultMaxTrackedIPs,
		}),
	}
	inner := smtp.NewServer(smtp.BackendFunc(s.newSession))
	inner.Domain = "in." + cfg.Domain
	inner.MaxRecipients = MaxRecipients
	inner.MaxLineLength = MaxLineLength
	inner.ReadTimeout = ReadTimeout
	inner.WriteTimeout = WriteTimeout
	// One byte ABOVE the real cap, on purpose, and not the cap itself.
	//
	// go-smtp's DATA reader refuses a message of exactly MaxMessageBytes: it
	// hands out its last byte, then answers the next Read with ErrDataTooLarge
	// because its budget has reached zero. Setting the library's limit to the
	// real cap would therefore reject a message that is exactly at it — the
	// value config.validate goes out of its way to keep acceptable. So the
	// library's limit is the backstop at cap+1 and [session.Data] enforces the
	// cap itself, which also lets the refusal carry a diagnostics row.
	//
	// The visible consequence is that the advertised SIZE is one byte high.
	// That costs a client nothing: declaring exactly cap+1 gets past MAIL FROM
	// and is refused at DATA instead.
	inner.MaxMessageBytes = int64(cfg.MaxMessageBytes) + 1
	// NO AUTH: the session type deliberately does not implement
	// smtp.AuthSession, so no mechanism is advertised and none is accepted.
	// AllowInsecureAuth stays false for the same reason.
	inner.AllowInsecureAuth = false
	// go-smtp logs a line per connection error to stderr by default, including
	// the remote address. Keep it, but prefixed so it is attributable.
	inner.ErrorLog = log.New(log.Writer(), "smtpd: ", log.LstdFlags)
	s.inner = inner
	return s
}

// ListenAndServe binds cfg.SMTPListen and serves until Shutdown.
func (s *Server) ListenAndServe() error {
	ln, err := net.Listen("tcp", s.cfg.SMTPListen)
	if err != nil {
		return fmt.Errorf("smtpd: listen %s: %w", s.cfg.SMTPListen, err)
	}
	return s.Serve(ln)
}

// Serve accepts on ln. It exists separately from ListenAndServe so that a
// caller — a test, or a supervisor handing over a socket — can bind first and
// know the address before anything is accepted on it.
//
// The listener is recorded here and closed by Shutdown. That is not redundant
// with the library, and the difference is a real leak rather than a tidiness
// point: go-smtp registers a listener at the top of ITS Serve and its Shutdown
// sweeps only what is registered, so a Shutdown that lands in the window
// between "the caller started this goroutine" and "the library registered the
// socket" closes nothing, returns success, and leaves a process accepting mail
// on port 25 forever with no way left to stop it. TestShutdownStopsAccepting
// AndReleasesThePort hit exactly that.
func (s *Server) Serve(ln net.Listener) error {
	s.mu.Lock()
	s.addr = ln.Addr().String()
	s.ln = ln
	s.mu.Unlock()
	select {
	case <-s.done:
		// Shutdown already ran, and it may have swept before this listener was
		// visible to anyone. Close it here rather than start accepting. A double
		// close is the expected case, not an error worth reporting.
		_ = ln.Close()
		return nil
	default:
	}
	if err := s.inner.Serve(trackingListener{Listener: ln, srv: s}); err != nil && !errors.Is(err, net.ErrClosed) {
		return err
	}
	return nil
}

// trackingListener records each accepted connection with the Server. Wrapping
// the listener is the only seam available: go-smtp's own connection set is
// unexported and unreachable after a graceful shutdown has run.
type trackingListener struct {
	net.Listener
	srv *Server
}

func (l trackingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tc := &trackedConn{Conn: c, srv: l.srv}
	l.srv.mu.Lock()
	l.srv.conns[tc] = struct{}{}
	l.srv.mu.Unlock()
	return tc, nil
}

type trackedConn struct {
	net.Conn
	srv *Server
}

func (c *trackedConn) Close() error {
	c.srv.mu.Lock()
	delete(c.srv.conns, c)
	c.srv.mu.Unlock()
	return c.Conn.Close()
}

// forceCloseConns drops every live connection and returns how many there were.
// It closes the UNDERLYING conn rather than the wrapper, so it does not re-enter
// the lock it is already done holding.
func (s *Server) forceCloseConns() int {
	s.mu.Lock()
	live := make([]*trackedConn, 0, len(s.conns))
	for c := range s.conns {
		live = append(live, c)
	}
	s.conns = map[*trackedConn]struct{}{}
	s.mu.Unlock()
	for _, c := range live {
		_ = c.Conn.Close()
	}
	return len(live)
}

// Addr is the bound address, or "" before Serve. It is not cfg.SMTPListen: a
// ":0" or bare-port listen resolves to something else, and the startup log
// should say what was actually bound.
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addr
}

// Shutdown stops accepting, wakes any connection parked in a tarpit, waits for
// live connections until ctx expires, and then FORCE-CLOSES whatever is left.
//
// The force-close is the part that matters. An SMTP peer is entitled to hold a
// connection open and idle between commands — that is ordinary, well-behaved
// MTA behaviour, not an attack — so a purely graceful shutdown of this listener
// waits for as long as a stranger feels like waiting, which in practice means
// "until the deploy gives up and something sends SIGKILL". Closing an idle
// connection costs the peer nothing: SMTP has no partial state worth
// preserving, and a transaction cut mid-flight is simply retried.
//
// It is idempotent: a second call after a completed shutdown is a no-op rather
// than an error, so a deferred cleanup can always call it.
func (s *Server) Shutdown(ctx context.Context) error {
	first := false
	s.stopOnce.Do(func() {
		first = true
		// Before the library's shutdown, so a connection parked in a tarpit
		// delay wakes up and finishes instead of holding this for 30 seconds.
		close(s.done)
	})
	if !first {
		return nil
	}
	// Ours, before the library's — see Serve for the window this closes.
	s.mu.Lock()
	ln := s.ln
	s.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	if err := s.inner.Shutdown(ctx); err != nil && !errors.Is(err, smtp.ErrServerClosed) {
		if n := s.forceCloseConns(); n > 0 {
			log.Printf("smtpd: shutdown window expired with %d connection(s) still open; closed them", n)
		}
	}
	return nil
}

// stall waits d, or returns early when the server is shutting down.
func (s *Server) stall(d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-s.done:
	}
}

// opCtx bounds one database or handler call. It is deliberately NOT derived
// from a server-lifetime context that Shutdown cancels: a diagnostics row for a
// message already refused, or a delivery already accepted, must be written even
// if it lands during shutdown — cancelling it is how an accepted message
// becomes a silent drop.
func opCtx(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type session struct {
	srv  *Server
	conn *smtp.Conn
	ip   netip.Addr

	// Per-message state, cleared by Reset.
	from       string
	fromDomain string
	rcpt       string
	userID     uuid.UUID
	isGrace    bool
	haveRcpt   bool
}

func (s *Server) newSession(c *smtp.Conn) (smtp.Session, error) {
	return &session{srv: s, conn: c, ip: remoteIP(c)}, nil
}

func remoteIP(c *smtp.Conn) netip.Addr {
	nc := c.Conn()
	if nc == nil {
		return netip.Addr{}
	}
	if ap, err := netip.ParseAddrPort(nc.RemoteAddr().String()); err == nil {
		return ap.Addr()
	}
	// A non-TCP listener (a unix socket in a test harness) has no IP. An
	// invalid Addr is a single shared limiter key, which is the conservative
	// direction: those callers share one budget rather than escaping the limit.
	return netip.Addr{}
}

func (s *session) Reset() {
	s.from, s.fromDomain, s.rcpt = "", "", ""
	s.userID, s.isGrace, s.haveRcpt = uuid.Nil, false, false
}

func (s *session) Logout() error { return nil }

func (s *session) Mail(from string, opts *smtp.MailOptions) error {
	s.Reset()
	s.from = from
	s.fromDomain = envelopeDomain(from)
	return nil
}

// Rcpt is where this server is a mail server for exactly one set of addresses
// and nothing else.
//
// The order of the three checks is the point:
//
//  1. The per-source block, which records nothing and touches no database. A
//     source already past the disconnect threshold costs us one comparison. A
//     limiter consulted after the lookup does not limit the lookup, and a
//     shared resource spent before a per-caller check is drainable by one host.
//  2. The recipient lookup, whose single rejection sentinel becomes the single
//     wire response.
//  3. The per-user allowance, checked HERE rather than at DATA so that an
//     over-quota sender never gets to transfer a megabyte.
func (s *session) Rcpt(to string, opts *smtp.RcptOptions) error {
	if s.srv.limiter.Blocked(s.ip) {
		return s.drop()
	}

	ctx, cancel := opCtx(resolveTimeout)
	userID, isGrace, err := s.srv.resolver.Resolve(ctx, to)
	cancel()

	switch {
	case errors.Is(err, addresses.ErrUnknownRecipient):
		return s.refuseRecipient()
	case err != nil:
		// NOT a rejection. Answering 550 during a database outage would tell
		// every sender that every user's address had ceased to exist, and it
		// would bounce mail rather than deferring it. It is also not the
		// sender's fault, so it must not feed the tarpit.
		log.Printf("smtpd: resolve recipient from %v: %v", s.ip, err)
		return errTemporary
	}

	if !s.srv.limiter.AllowMessage(userID) {
		if !s.srv.accountRefusal(userID, s.fromDomain, diag.OutcomeOverQuota, diag.RejectOverQuota, nil) {
			// Nothing recorded the refusal, so nothing would ever surface it.
			// 451 makes the sender retry rather than leaving a silent drop.
			return errTemporary
		}
		return errOverQuota
	}

	s.rcpt, s.userID, s.isGrace, s.haveRcpt = to, userID, isGrace, true
	return nil
}

// refuseRecipient tarpits and then answers the one rejection this server has.
func (s *session) refuseRecipient() error {
	delay, disconnect := s.srv.limiter.InvalidRcpt(s.ip)
	// Counted BEFORE the stall, so an attacker who hangs up mid-tarpit is still
	// counted. Aggregated, never one row per attempt: there is no user to scope
	// a row to, and one row per attempt is a storage-amplification bug reachable
	// by anyone with a socket.
	ctx, cancel := opCtx(diagTimeout)
	if err := s.srv.diag.CountRejection(ctx, diag.RejectUnknownRcpt); err != nil {
		// Logged, not escalated. This rejection intentionally does not vary
		// with our own database health: the reply an unknown recipient gets is
		// the one property that must never depend on anything.
		log.Printf("smtpd: counting an unknown-recipient rejection: %v", err)
	}
	cancel()
	if disconnect {
		return s.drop()
	}
	s.srv.stall(delay)
	return errUnknownRecipient
}

// drop writes a 421 and closes the connection. go-smtp has no way for a backend
// to both reply and disconnect — an error returned from a session method is
// written to a connection that stays open — so Conn.Reject does both here, and
// the error returned afterwards is written into a socket that has already gone
// away. Reject's own text ("too busy") is deliberately uninformative, which is
// what we want at the end of a sweep.
func (s *session) drop() error {
	s.conn.Reject()
	return errDisconnect
}

// Data reads the message under the configured cap.
func (s *session) Data(r io.Reader) error {
	if !s.haveRcpt {
		// go-smtp refuses DATA with no accepted recipient before reaching here.
		// Belt and braces: a message with no resolved user has nowhere to go.
		return errTemporary
	}
	limit := int64(s.srv.cfg.MaxMessageBytes)
	raw, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		// A broken or stalled transfer. Nothing arrived, so there is nothing to
		// record and nothing to drop; the sender retries.
		log.Printf("smtpd: reading message body from %v: %v", s.ip, err)
		return errTemporary
	}
	if int64(len(raw)) > limit {
		// The recipient resolved at RCPT time, so this refusal has a user to
		// scope a notice to. ingestID hashes what we DID read: it is not the
		// hash of the whole message (we deliberately never held it), and the
		// comment on the field says so.
		id := sha256.Sum256(raw)
		if !s.srv.accountRefusal(s.userID, s.fromDomain, diag.OutcomeRejected, diag.RejectTooLarge, id[:]) {
			return errTemporary
		}
		return errTooLarge
	}

	ctx, cancel := opCtx(deliverTimeout)
	defer cancel()
	if err := s.srv.handler.Deliver(ctx, Delivery{
		UserID:       s.userID,
		Rcpt:         s.rcpt,
		EnvelopeFrom: s.from,
		RemoteIP:     s.ip,
		Raw:          raw,
		ReceivedAt:   s.srv.now(),
		IsGrace:      s.isGrace,
	}); err != nil {
		log.Printf("smtpd: delivering a message for %v: %v", s.userID, err)
		return errTemporary
	}
	return nil
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

// accountRefusal records a refusal that HAS a resolved recipient, and reports
// whether it was recorded anywhere at all.
//
// Two records, for two different questions. The aggregated counter answers "did
// everything that arrived get accounted for" and is incremented every time. The
// user-scoped diagnostics row is the NOTICE the user's client surfaces, and it
// is bounded per user per reason per window: a hundred identical rows say
// nothing a handful do not, and unbounded they are the same storage
// amplification the aggregate exists to avoid — reachable by anyone who knows
// one valid address.
//
// The return value is what keeps §2's drop policy honest. If neither record
// landed, the caller must answer a TEMPORARY failure: a permanent refusal that
// left no trace anywhere is precisely the silent drop the policy forbids, and a
// retry gives the notice another chance.
func (s *Server) accountRefusal(userID uuid.UUID, senderDomain, outcome, reason string, ingestID []byte) bool {
	accounted := false

	ctx, cancel := opCtx(diagTimeout)
	if err := s.diag.CountRejection(ctx, reason); err != nil {
		log.Printf("smtpd: counting a %s rejection: %v", reason, err)
	} else {
		accounted = true
	}
	cancel()

	if !s.limiter.Notice(userID, reason) {
		return accounted
	}
	if ingestID == nil {
		ingestID = attemptID(userID, s.now())
	}
	rec := diag.Record{
		UserID:     uuid.NullUUID{UUID: userID, Valid: true},
		Event:      diag.EventArrival,
		IngestID:   ingestID,
		ReceivedAt: s.now(),
		// An ENVELOPE domain, marked as the assertion it is. Task 25 is what
		// turns a sender domain into evidence; until then the prefix is the
		// difference between "dib.ae signed this" and "someone typed dib.ae".
		SenderDomain: unverifiedDomain(senderDomain),
		// No verification has run at this point in the pipeline, and none has
		// been attempted. "none" is the honest value; Task 25 fills it in.
		DKIMResult: diag.ResultNone,
		ARCResult:  diag.ResultNone,
		// Nothing was parsed: the message was refused before any template ran.
		Tier:    diag.TierNone,
		Matched: false,
		// 0 means "no bucket applies": an oversized message is past the largest
		// rung, and an over-quota one was never measured. An exact size would
		// track the merchant name's length and the amount's digit count, which
		// is the content this table promises not to hold.
		BodySizeBucket: 0,
		Outcome:        outcome,
		RejectReason:   reason,
	}
	ctx, cancel = opCtx(diagTimeout)
	defer cancel()
	if err := s.diag.Record(ctx, rec); err != nil {
		log.Printf("smtpd: recording a %s refusal notice: %v", reason, err)
		return accounted
	}
	return true
}

// attemptID is the ingest id for a refusal that never read a body.
//
// parse_diagnostics.ingest_id is the SHA-256 of the raw body and is NOT NULL,
// because for every other row it is the join key to the op or quarantine row.
// An over-quota refusal happens at RCPT time — before the 354, before a single
// byte of body, which is the whole point of refusing there rather than after a
// megabyte of transfer — so there is no body to hash and no op it could join
// to. This is a digest over the attempt instead: a domain-separated hash of the
// user and the instant, which is content-free, unique per attempt, and the
// right width. It identifies the refusal in the operator's log; it does not
// claim to identify a message, because there was not one.
func attemptID(userID uuid.UUID, t time.Time) []byte {
	h := sha256.New()
	h.Write([]byte("ledger-v2-smtp-refused-attempt\x00"))
	b, _ := userID.MarshalBinary()
	h.Write(b)
	h.Write([]byte(t.UTC().Format(time.RFC3339Nano)))
	return h.Sum(nil)
}

// reEnvelopeDomain is the hostname grammar diag enforces. The envelope sender
// is attacker-chosen text, so the domain is checked HERE before it is offered
// to diag — a value that fails diag's validation would cost the whole
// diagnostics row, and losing the notice over a malformed MAIL FROM would turn
// a refusal into an unrecorded one.
var reEnvelopeDomain = regexp.MustCompile(
	`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// envelopeDomain extracts the domain of a MAIL FROM path, or "" if there is no
// usable one. A null sender ("") is normal for a bounce and is not an error.
func envelopeDomain(from string) string {
	i := strings.LastIndexByte(from, '@')
	if i < 0 || i == len(from)-1 {
		return ""
	}
	d := strings.ToLower(strings.TrimSpace(from[i+1:]))
	if len(d) > 253 || !reEnvelopeDomain.MatchString(d) {
		return ""
	}
	return d
}

func unverifiedDomain(d string) string {
	if d == "" {
		return ""
	}
	return diag.UnverifiedPrefix + d
}
