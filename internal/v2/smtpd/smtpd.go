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
//  2. EVERY REFUSED RECIPIENT IS METERED, PER SOURCE. A refusal that costs the
//     prober nothing is a free search over the address space — and that is true
//     of an over-quota refusal exactly as much as of an unknown one, so both go
//     through the same counter. The delay doubles from TarpitBase after a small
//     free burst, caps at 30s, and past 20 in a rolling hour the source is
//     dropped with a 421 and refused thereafter without so much as a database
//     lookup. Read [Limiter]'s doc for what the tarpit does and does NOT buy:
//     parallel connections divide the delay, so it is the disconnect threshold
//     and the per-source connection cap that actually bound a sweep.
//
//  3. THE SIZE CAP IS OURS, ON EVERY PATH INTO THE PROCESS. cfg.MaxMessageBytes
//     is clamped by config.validate to blob.MaxColdMail — the largest message
//     that still fits a padding bucket once base64'd inside a JSON record — and
//     a hardcoded cap here would reproduce the "seals fine, permanently
//     unopenable" failure from the other side. go-smtp's own size handling is
//     switched OFF (see New) because it refuses without telling us, and its
//     line limit is switched off BY THE LIBRARY mid-connection (see
//     [guardConn]), so both ceilings are enforced under it, on the socket.
//     There are two body paths, not one: DATA and BDAT.
//
//  4. A REFUSAL LEAVES A TRACE. Spec §2's drop policy is "nothing is dropped
//     without a user-visible notice", and the Phase 1 exit test is "every
//     inbound email accounted for". Refusals with a resolved recipient write a
//     user-scoped diagnostics row; refusals without one (an unknown recipient,
//     or an oversize declared before any recipient was named) increment the
//     aggregated counter instead, because there is no user to scope a row to
//     and one row per attempt would let anyone flood the table from the open
//     port. A refusal this receiver cannot record is downgraded to a TEMPORARY
//     failure, so the sender retries and we get another chance, rather than
//     being permanently refused with no trace.
//
//  5. WHAT ONE PEER CAN MAKE US HOLD IS BOUNDED. Connections are capped in
//     total and per source, each connection has a per-transaction byte budget,
//     and each has a line ceiling. Without these the process is a remote OOM:
//     go-smtp has no concurrency limit at all, and its per-connection line
//     limit is disabled permanently by one successful non-last BDAT chunk.
//
// # The allowance counts DELIVERED messages
//
// The per-user unit is TAKEN at RCPT — an over-quota sender must not get to
// transfer a megabyte first — and GIVEN BACK by every path that ends a
// transaction without delivering: RSET, a new MAIL, logout, an oversized body,
// a handler failure. Charging for an abandoned transaction turns the allowance
// into a remote off switch for someone else's mail: `MAIL / RCPT / RSET` in a
// loop burns a stranger's whole day in a few milliseconds without sending
// anything, and their next real message bounces off a 452.
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
// # The refusals this package cannot account for
//
// go-smtp answers a syntactically invalid path (501), an over-long line (500)
// and a second recipient (452) inside its own command loop, without consulting
// the backend. Those never reach a session method, so they are counted nowhere.
// They are protocol errors rather than messages — no body was ever offered —
// and all three are answered before DATA, so no mail is silently discarded by
// them. TestAnOverlongLineIsRefusedWithoutBufferingIt pins the behaviour so a
// change in the library is visible.
//
// This list was longer, and the two that left it were real silent drops: an
// oversize declared with the ESMTP SIZE parameter, and an oversize BDAT chunk,
// were both refused 552 by the library with nothing written anywhere. Both are
// now this package's own refusals. The lesson worth keeping is that the list is
// a claim about a DEPENDENCY's behaviour, so it has to be re-derived from the
// library's source rather than assumed stable — every entry above names the
// exact reply so a change is visible in a test rather than in production.
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

	// guardMaxLine is the BACKSTOP line ceiling enforced by [guardConn], above
	// go-smtp's own MaxLineLength so that in normal operation the library's
	// tidier "500 Too long line" fires first and this never does.
	//
	// It is not belt-and-braces. go-smtp sets its own line limit to ZERO — which
	// means UNLIMITED — for the duration of a BDAT chunk (conn.go:1074) and
	// restores it only on the error path and on the LAST chunk, so after ONE
	// successful non-last chunk the connection has no line limit at all for the
	// rest of its life. CHUNKING is advertised unconditionally and BDAT is
	// dispatched unconditionally, so that path is reachable by anyone holding a
	// valid recipient. Measured before this guard existed: `BDAT 1` plus one
	// byte, then a single 32 MiB line, was buffered in full and answered 250,
	// growing the process's TotalAlloc by 256 MiB for that one line. There is no
	// switch in the library for it and v0.24.0 is the latest release, so the
	// ceiling has to live under the library, on the socket.
	guardMaxLine = 2 * MaxLineLength

	// transactionOverhead is the slack added to the per-transaction byte budget
	// for command lines and dot-stuffing. Dot-stuffing expands a body by at most
	// one byte per line, so the budget below is 2x the cap plus this.
	transactionOverhead = 64 << 10

	// MaxConns and MaxConnsPerSource bound concurrency. Neither go-smtp nor an
	// unconfigured listener has any limit at all: 400 idle connections were
	// accepted in a probe, each holding a 60s read timeout and each able to hold
	// a whole message in one buffer. Sixty-four connections is orders of
	// magnitude beyond a closed beta whose users receive single-digit messages a
	// day, and it bounds worst-case buffered mail to roughly 64 MB.
	//
	// The per-source cap does double duty: it is also what stops a sweeper from
	// dividing the tarpit away by running probes on parallel connections. See
	// the Limiter doc for the measurement.
	MaxConns          = 64
	MaxConnsPerSource = 4

	// rejectionFlushInterval is how often the in-memory rejection counts are
	// written out. See [Server.countRejection].
	rejectionFlushInterval = 2 * time.Second
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

// tooManyConns is written in place of a greeting to a connection refused by the
// concurrency caps. RFC 5321 §3.1 allows a 421 instead of the 220, and a
// connection told "later" is retried; one closed in silence looks like a broken
// server.
var tooManyConns = []byte("421 4.7.0 too many connections, try again later\r\n")

// The two limits [guardConn] enforces on the socket itself. They are plain
// errors rather than SMTPErrors because they surface as READ failures inside
// go-smtp's command loop, not as a session return value: the library answers
// "421 Connection error" and closes, which is the right end for a connection
// that has just tried to hand us an unbounded line.
var (
	errLineTooLong         = errors.New("smtpd: line over the guard ceiling")
	errTransactionTooLarge = errors.New("smtpd: transaction over the byte budget")
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

	// maxConns and maxConnsPerSource are fields rather than the constants
	// directly so an in-package test can lower them before Serve starts.
	maxConns          int
	maxConnsPerSource int

	mu   sync.Mutex
	addr string
	// ln is the listener Serve was handed, so Shutdown can close it itself.
	ln net.Listener
	// conns is every live connection, so Shutdown can force-close what is left
	// when its window expires, and so the caps have something to count. go-smtp
	// tracks connections too, but its Close — the only thing that would reach
	// them — returns immediately once Shutdown has run, so after a graceful
	// attempt the library offers no way to finish the job.
	conns map[*guardConn]struct{}
	// srcConns is the live connection count per source key. Entries are removed
	// at zero, so it is bounded by the number of live connections.
	srcConns map[netip.Addr]int

	// rejections are the aggregate refusal counts waiting to be written. See
	// countRejection.
	rejections struct {
		mu      sync.Mutex
		pending map[string]int64
	}
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
		conns:    map[*guardConn]struct{}{},
		srcConns: map[netip.Addr]int{},

		maxConns:          MaxConns,
		maxConnsPerSource: MaxConnsPerSource,
		limiter: NewLimiter(LimiterConfig{
			Burst:  cfg.InvalidRcptBurst,
			Base:   cfg.TarpitBase,
			Daily:  cfg.PerAddressDaily,
			Now:    now,
			MaxIPs: DefaultMaxTrackedIPs,
		}),
	}
	s.rejections.pending = map[string]int64{}
	inner := smtp.NewServer(smtp.BackendFunc(s.newSession))
	inner.Domain = "in." + cfg.Domain
	inner.MaxRecipients = MaxRecipients
	inner.MaxLineLength = MaxLineLength
	inner.ReadTimeout = ReadTimeout
	inner.WriteTimeout = WriteTimeout
	// ZERO — the library's size logic is switched OFF and this package owns
	// every size refusal. That is not a simplification, it is the fix for two
	// silent drops and an off-by-one:
	//
	//   - A declared SIZE over the limit is answered 552 by go-smtp at
	//     conn.go:360 BEFORE the Mail callback, and an over-cap BDAT chunk at
	//     conn.go:1025, both without consulting the backend. Measured with the
	//     library doing the check: an oversized message WITH the ESMTP SIZE
	//     parameter left parse_diagnostics and smtp_rejections completely empty,
	//     while the identical message without it produced a user-scoped row.
	//     Gmail and Postfix both send SIZE, so the unaccounted path was the
	//     likely one — a silent drop, against §2 and against this package's own
	//     rule 4.
	//   - Its DATA reader also refuses a message of EXACTLY MaxMessageBytes: it
	//     hands out the last byte, then answers the next Read with
	//     ErrDataTooLarge because its budget has reached zero. The cap is the
	//     largest message config.validate deliberately keeps storable, so that
	//     one is an off-by-one against the spec.
	//
	// The cost is the EHLO SIZE advertisement, which go-smtp only emits when
	// this is non-zero. It is close to free: the saving an advertisement buys is
	// a sender declining to transfer a doomed message, and a sender that would
	// check it also sends SIZE= on MAIL FROM, which [session.Mail] refuses at
	// exactly the same point in the conversation — with a record of it.
	inner.MaxMessageBytes = 0
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
	go s.flushLoop()
	if err := s.inner.Serve(trackingListener{Listener: ln, srv: s}); err != nil && !errors.Is(err, net.ErrClosed) {
		return err
	}
	return nil
}

// trackingListener applies the concurrency caps and wraps each accepted
// connection in a [guardConn]. Wrapping the listener is the only seam
// available: go-smtp has no concurrency limit of any kind, and its own
// connection set is unexported and unreachable after a graceful shutdown.
type trackingListener struct {
	net.Listener
	srv *Server
}

// Accept refuses over-cap connections in a LOOP rather than by returning an
// error. That is load bearing: go-smtp's Serve treats a non-temporary Accept
// error as fatal and stops the whole server, so returning one would let anyone
// shut the receiver down by opening one connection too many.
func (l trackingListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		gc, ok := l.srv.track(c)
		if ok {
			return gc, nil
		}
		_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_, _ = c.Write(tooManyConns)
		_ = c.Close()
	}
}

// track admits a connection if it is inside both caps.
//
// Per-source first, then the global count — the same order every check in this
// package uses, and for the same reason: spending the shared budget before the
// per-caller check is what lets one host drain it and lock everyone else out.
func (s *Server) track(c net.Conn) (*guardConn, bool) {
	src := sourceKey(addrOf(c.RemoteAddr()))
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srcConns[src] >= s.maxConnsPerSource || len(s.conns) >= s.maxConns {
		return nil, false
	}
	gc := &guardConn{
		Conn:      c,
		srv:       s,
		src:       src,
		remaining: s.transactionBudget(),
	}
	s.conns[gc] = struct{}{}
	s.srcConns[src]++
	return gc, true
}

// liveConns is the number of connections currently held. It exists so the caps
// and the slot bookkeeping are assertions rather than claims.
func (s *Server) liveConns() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.conns)
}

func (s *Server) transactionBudget() int64 {
	return 2*int64(s.cfg.MaxMessageBytes) + transactionOverhead
}

// guardConn is the receiver's own limit on what one connection may hand it,
// enforced UNDER go-smtp on the socket, where nothing in the library can switch
// it off.
//
// Two ceilings, one per failure it closes:
//
//   - A LINE ceiling, because go-smtp disables its own for the rest of the
//     connection after a successful non-last BDAT chunk. See guardMaxLine for
//     the measurement; without this a remote peer holding one valid recipient
//     can make the process buffer an arbitrarily large single line.
//   - A per-TRANSACTION byte budget, which bounds everything else a connection
//     can make us read: the body itself, the drain go-smtp performs after a
//     refusal (which it runs with its own limit explicitly disabled), a BDAT
//     stream of any number of chunks, and a NOOP loop. It is reset by
//     [session.Reset] at the start of each transaction, so a connection
//     delivering several messages is not penalized for the earlier ones.
//
// A tripped guard is STICKY. The transaction reset deliberately does not clear
// it: a peer that has already handed us something unbounded does not get to
// clear the record by starting a new transaction.
type guardConn struct {
	net.Conn
	srv *Server
	src netip.Addr

	mu        sync.Mutex
	tripped   error
	lineLen   int
	remaining int64

	closeOnce sync.Once
}

func (c *guardConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	tripped := c.tripped
	c.mu.Unlock()
	if tripped != nil {
		return 0, tripped
	}
	n, err := c.Conn.Read(p)
	if n > 0 {
		if terr := c.account(p[:n]); terr != nil {
			// The bytes just read are discarded along with the connection. Each
			// Read is bounded by the caller's buffer (4 KB from textproto's
			// bufio), so the ceiling is overshot by at most one buffer — which
			// is the point: the check has to be on the byte stream, not on the
			// assembled line, or the assembly is the thing that runs us out of
			// memory.
			return 0, terr
		}
	}
	return n, err
}

func (c *guardConn) account(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remaining -= int64(len(b))
	if c.remaining < 0 {
		c.tripped = errTransactionTooLarge
		return c.tripped
	}
	for _, ch := range b {
		if ch == '\n' {
			c.lineLen = 0
			continue
		}
		c.lineLen++
		if c.lineLen > guardMaxLine {
			c.tripped = errLineTooLong
			return c.tripped
		}
	}
	return nil
}

// newTransaction restores the byte budget for a fresh MAIL FROM.
func (c *guardConn) newTransaction() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remaining = c.srv.transactionBudget()
	c.lineLen = 0
}

func (c *guardConn) Close() error {
	c.closeOnce.Do(func() {
		c.srv.mu.Lock()
		delete(c.srv.conns, c)
		if n := c.srv.srcConns[c.src]; n <= 1 {
			delete(c.srv.srcConns, c.src)
		} else {
			c.srv.srcConns[c.src] = n - 1
		}
		c.srv.mu.Unlock()
	})
	return c.Conn.Close()
}

// forceCloseConns drops every live connection and returns how many there were.
// It closes the UNDERLYING conn rather than the wrapper, so it does not re-enter
// the lock it is already holding.
func (s *Server) forceCloseConns() int {
	s.mu.Lock()
	live := make([]*guardConn, 0, len(s.conns))
	for c := range s.conns {
		live = append(live, c)
	}
	s.conns = map[*guardConn]struct{}{}
	s.srcConns = map[netip.Addr]int{}
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
	var forced error
	// net.ErrClosed here is OUR OWN listener close above, reported back by the
	// library closing the same socket a second time. It is not a failure and
	// must not be reported as one, or every clean shutdown looks forced.
	if err := s.inner.Shutdown(ctx); err != nil &&
		!errors.Is(err, smtp.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		if n := s.forceCloseConns(); n > 0 {
			log.Printf("smtpd: shutdown window expired with %d connection(s) still open; closed them", n)
		}
		// Reported, not swallowed. Returning nil unconditionally made the
		// caller's "smtp shutdown failed" branch unreachable, which is a way of
		// saying a forced shutdown looks exactly like a clean one in the log.
		forced = err
	}
	// The counts still buffered belong to refusals that already happened. This
	// is detached from ctx — which has usually just expired if we got here — so
	// that a shutdown never turns an accounted refusal into an unaccounted one.
	fctx, fcancel := context.WithTimeout(context.WithoutCancel(ctx), diagTimeout)
	if err := s.flushRejections(fctx); err != nil {
		log.Printf("smtpd: final rejection flush: %v", err)
	}
	fcancel()
	return forced
}

// countRejection records one aggregate refusal IN MEMORY, to be written by
// flushRejections.
//
// smtp_rejections has exactly one row per (day, reason), so a write per refusal
// makes that row the hottest object in the database under precisely the traffic
// it exists to measure — an unauthenticated flood on the open port. One
// unmetered refusal branch was measured at 5,396 upserts per second from a
// single socket. Batching turns that into one statement every couple of
// seconds.
//
// The cost is honest and bounded: a crash loses up to rejectionFlushInterval of
// counts. That is acceptable for THIS number and no other, because it is an
// aggregate nuisance metric with no user attached. The thing §2's drop policy
// actually turns on — whether a refusal left a user-visible notice — is the
// synchronous diagnostics row, and accountRefusal decides its answer from that,
// never from this counter.
func (s *Server) countRejection(reason string) {
	s.rejections.mu.Lock()
	defer s.rejections.mu.Unlock()
	s.rejections.pending[reason]++
}

// flushRejections writes the buffered counts. Counts that fail to write are put
// BACK, so a transient database failure defers them rather than dropping them.
func (s *Server) flushRejections(ctx context.Context) error {
	s.rejections.mu.Lock()
	pending := s.rejections.pending
	s.rejections.pending = map[string]int64{}
	s.rejections.mu.Unlock()

	var firstErr error
	for reason, n := range pending {
		if err := s.diag.CountRejections(ctx, reason, n); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			s.rejections.mu.Lock()
			s.rejections.pending[reason] += n
			s.rejections.mu.Unlock()
		}
	}
	return firstErr
}

func (s *Server) flushLoop() {
	t := time.NewTicker(rejectionFlushInterval)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), diagTimeout)
			if err := s.flushRejections(ctx); err != nil {
				log.Printf("smtpd: flushing rejection counts: %v", err)
			}
			cancel()
		}
	}
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
	srv   *Server
	conn  *smtp.Conn
	guard *guardConn
	ip    netip.Addr

	// Per-message state, cleared by Reset.
	from       string
	fromDomain string
	rcpt       string
	userID     uuid.UUID
	isGrace    bool
	haveRcpt   bool
	// reserved reports that a unit of userID's allowance is held for a message
	// that has not been delivered yet. See [Limiter.ReleaseMessage].
	reserved bool
}

func (s *Server) newSession(c *smtp.Conn) (smtp.Session, error) {
	gc, _ := c.Conn().(*guardConn)
	return &session{srv: s, conn: c, guard: gc, ip: remoteIP(c)}, nil
}

func remoteIP(c *smtp.Conn) netip.Addr {
	nc := c.Conn()
	if nc == nil {
		return netip.Addr{}
	}
	return addrOf(nc.RemoteAddr())
}

// addrOf extracts the IP from a net.Addr.
//
// It is the PEER's address, which is the right thing today and would be the
// wrong thing the moment anything is put in front of this listener: a proxy, a
// load balancer, or a tunnel makes every connection look like it comes from one
// source, and every per-source control in this package — the tarpit, the
// disconnect threshold, the connection caps — silently collapses to a single
// key shared by the whole internet. There is no PROXY-protocol support here and
// none should be added speculatively; if a proxy is ever introduced, parsing
// its header MUST land in the same change, because the failure mode is a
// receiver that reports every limit as working while enforcing none of them.
func addrOf(a net.Addr) netip.Addr {
	if a == nil {
		return netip.Addr{}
	}
	if ap, err := netip.ParseAddrPort(a.String()); err == nil {
		return ap.Addr()
	}
	// A non-TCP listener (a unix socket in a test harness) has no IP. An
	// invalid Addr is a single shared limiter key, which is the conservative
	// direction: those callers share one budget rather than escaping the limit.
	return netip.Addr{}
}

// Reset ends the current transaction: it gives back an allowance unit held for
// a message that was never delivered, and hands the connection a fresh byte
// budget.
//
// go-smtp calls this on RSET, on a new MAIL, and after every DATA, so it is the
// one place that reliably observes "that transaction is over".
func (s *session) Reset() {
	s.releaseReservation()
	s.from, s.fromDomain, s.rcpt = "", "", ""
	s.userID, s.isGrace, s.haveRcpt = uuid.Nil, false, false
	if s.guard != nil {
		s.guard.newTransaction()
	}
}

// releaseReservation returns an unused allowance unit. It must run before
// userID is cleared, which is why Reset calls it first.
func (s *session) releaseReservation() {
	if !s.reserved {
		return
	}
	s.srv.limiter.ReleaseMessage(s.userID)
	s.reserved = false
}

func (s *session) Logout() error {
	// A connection that just goes away mid-transaction still gives the unit
	// back. Without this, holding a socket open after RCPT would park a unit of
	// a stranger's daily allowance for as long as the read timeout allows.
	s.releaseReservation()
	return nil
}

func (s *session) Mail(from string, opts *smtp.MailOptions) error {
	s.Reset()
	s.from = from
	s.fromDomain = envelopeDomain(from)

	// The declared-size refusal, which go-smtp used to answer for us without
	// telling anyone. It is answered HERE, at MAIL FROM, and NOT deferred to
	// RCPT where a user-scoped diagnostics row would be possible — because a
	// refusal that lands after the recipient is known is a free enumeration
	// oracle: send SIZE=huge, then probe addresses, and 552 means "this one
	// exists" while 550 means "it does not". The aggregate counter is the
	// honest record for a refusal whose recipient we deliberately never learned,
	// exactly as it is for an unknown recipient.
	if opts != nil && opts.Size > int64(s.srv.cfg.MaxMessageBytes) {
		s.srv.countRejection(diag.RejectTooLarge)
		return errTooLarge
	}
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
		// METERED, exactly like an unknown recipient. An over-quota refusal is
		// cheap to provoke and used to cost the prober nothing: the branch had
		// no tarpit, no disconnect debt and a database write per attempt, and
		// was measured at 5,396 refusals per second down one socket with the
		// connection still open at the end.
		return s.refuse(userID, diag.OutcomeOverQuota, diag.RejectOverQuota, errOverQuota, nil)
	}

	s.rcpt, s.userID, s.isGrace, s.haveRcpt = to, userID, isGrace, true
	// The unit is held, not yet spent. It is released by Reset or Logout if this
	// transaction never delivers anything — see [Limiter.ReleaseMessage] for why
	// charging for an abandoned transaction is a remote off switch.
	s.reserved = true
	return nil
}

// refuse meters, accounts for and answers a refusal that HAS a resolved
// recipient. It is the shared path for over-quota and over-size, so neither can
// drift into being the unmetered one.
func (s *session) refuse(userID uuid.UUID, outcome, reason string, resp *smtp.SMTPError, ingestID []byte) error {
	delay, disconnect := s.srv.limiter.InvalidRcpt(s.ip)
	accounted := s.srv.accountRefusal(userID, s.fromDomain, outcome, reason, ingestID)
	if disconnect {
		return s.drop()
	}
	s.srv.stall(delay)
	if !accounted {
		// Nothing recorded it, so nothing would ever surface it. A temporary
		// failure makes the sender retry and gives the notice another chance,
		// rather than refusing permanently with no trace anywhere.
		return errTemporary
	}
	return resp
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
		//
		// The allowance unit is NOT spent: this message was not delivered, and
		// go-smtp's post-DATA reset gives it back. Oversize senders are metered
		// by refuse, on the per-source counter, where a nuisance control belongs
		// — charging the recipient's mailbox for a stranger's oversized upload
		// would let anyone empty a user's daily allowance from outside.
		id := sha256.Sum256(raw)
		return s.refuse(s.userID, diag.OutcomeRejected, diag.RejectTooLarge, errTooLarge, id[:])
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
		// The reservation stays held and is released by the post-DATA reset, so
		// the retry this 4xx asks for does not cost the user a second unit. That
		// matters right now: runServe mounts a handler that defers EVERY message
		// until Task 29 lands, and without the release a day of retries would
		// pin a real user at 452.
		return errTemporary
	}
	// Delivered: the held unit is now spent, so the post-DATA reset must not
	// give it back.
	s.reserved = false
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
// The return value is what keeps §2's drop policy honest, and it is decided by
// the NOTICE alone — never by the aggregate counter, which is buffered in
// memory and therefore always "succeeds" at the moment it is asked. There are
// exactly three cases:
//
//   - The diagnostics row was written. Accounted.
//   - Notice refused a permit, which means a row for this user, reason and
//     window ALREADY landed. Accounted: the user has been told, and repeating
//     an identical notice tells them nothing.
//   - The row was attempted and failed. NOT accounted, and the caller answers a
//     temporary failure so the sender retries and the notice gets another
//     chance. The permit is handed back on this path, or a database outage
//     would burn all eight on rows that do not exist and the case above would
//     then claim a user was told something they were never told.
func (s *Server) accountRefusal(userID uuid.UUID, senderDomain, outcome, reason string, ingestID []byte) bool {
	s.countRejection(reason)

	if !s.limiter.Notice(userID, reason) {
		return true
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
	ctx, cancel := opCtx(diagTimeout)
	defer cancel()
	if err := s.diag.Record(ctx, rec); err != nil {
		log.Printf("smtpd: recording a %s refusal notice: %v", reason, err)
		s.limiter.ReleaseNotice(userID, reason)
		return false
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
