package relay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/smtpd"
)

var bg = context.Background()

const testSuffix = "@in.example.test"

// ---------------------------------------------------------------------------
// A stand-in primary
// ---------------------------------------------------------------------------

// primary is a scriptable stand-in for the real server. Its whole job is to let
// a test decide what the relay is answered with, and to record byte-for-byte
// what it was asked — which is what makes the idempotency assertion below about
// the relay's behaviour rather than about a fake's bookkeeping.
type primary struct {
	t *testing.T

	mu sync.Mutex
	// status is the answer to POST /deliver; 0 means 202.
	status int
	body   string
	// verdict is the value of relay.VerdictHeader on the answer to /deliver.
	// Empty means the header is absent, which is what EVERY answer that is not
	// an explicit per-message rejection looks like.
	verdict string
	// delivered is every raw message body the relay has posted, in order.
	delivered []string
	// addrs is what GET /addresses answers with.
	addrs  []map[string]any
	asOf   time.Time
	getErr int
	// spoolHeaders records the relay's self-reported spool state.
	spoolHeaders []string
	token        string
}

func newPrimary(t *testing.T) (*primary, *httptest.Server) {
	p := &primary{t: t, token: "relay-token", asOf: time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)}
	srv := httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(srv.Close)
	return p, srv
}

func (p *primary) serve(w http.ResponseWriter, r *http.Request) {
	if got, want := r.Header.Get("Authorization"), "Bearer "+p.token; got != want {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
		return
	}
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/relay/addresses"):
		p.mu.Lock()
		if h := r.Header.Get(SpoolHeader); h != "" {
			p.spoolHeaders = append(p.spoolHeaders, h)
		}
		status, addrs, asOf := p.getErr, p.addrs, p.asOf
		p.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		if addrs == nil {
			addrs = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"addresses": addrs, "as_of": asOf})
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/relay/deliver"):
		var req struct {
			LocalPart string `json:"local_part"`
			Raw       string `json:"raw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		raw, err := base64.StdEncoding.DecodeString(req.Raw)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		p.mu.Lock()
		status, body, verdict := p.status, p.body, p.verdict
		// Recorded whatever the scripted answer is: a 5xx here models the
		// primary having ACCEPTED the message and its answer being lost, which
		// is the case that produces a redelivery.
		p.delivered = append(p.delivered, string(raw))
		p.mu.Unlock()
		if status == 0 {
			status = http.StatusAccepted
		}
		if verdict != "" {
			w.Header().Set(VerdictHeader, verdict)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (p *primary) answer(status int, body string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status, p.body, p.verdict = status, body, ""
}

// rejectWith is the primary saying, explicitly, "this MESSAGE is undeliverable"
// — the only answer the drain is allowed to act on by setting a message aside.
// See internal/v2/api's relayReject, which is what sets this in production.
func (p *primary) rejectWith(status int, body string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status, p.body, p.verdict = status, body, VerdictReject
}

func (p *primary) got() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.delivered...)
}

func (p *primary) publish(local string, expires *time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e := map[string]any{"local_part": local, "user_pubkey": "", "expires_at": nil}
	if expires != nil {
		e["expires_at"] = expires.UTC().Format(time.RFC3339Nano)
	}
	p.addrs = append(p.addrs, e)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type fixture struct {
	t    *testing.T
	r    *Relay
	p    *primary
	url  string
	dir  string
	now  time.Time
	logs []string
	mu   sync.Mutex
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	p, srv := newPrimary(t)
	f := &fixture{t: t, p: p, url: srv.URL, dir: t.TempDir(), now: time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)}
	f.r = &Relay{
		SpoolDir:   f.dir,
		PrimaryURL: srv.URL,
		Token:      "relay-token",
		Suffix:     testSuffix,
		HTTP:       srv.Client(),
		Now:        func() time.Time { return f.now },
		Logf:       f.logf,
	}
	if err := f.r.Init(); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) logf(format string, args ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, fmt.Sprintf(format, args...))
}

func (f *fixture) logged(substr string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, l := range f.logs {
		if strings.Contains(l, substr) {
			return true
		}
	}
	return false
}

// address publishes an address on the primary and syncs it into the replica.
func (f *fixture) address(local string) string {
	f.t.Helper()
	f.p.publish(local, nil)
	if _, err := f.r.SyncAddresses(bg); err != nil {
		f.t.Fatal(err)
	}
	return local + testSuffix
}

func (f *fixture) deliver(rcpt string, body string) error {
	f.t.Helper()
	userID, isGrace, err := f.r.Resolve(bg, rcpt)
	if err != nil {
		return err
	}
	return f.r.Deliver(bg, smtpd.Delivery{
		UserID:       userID,
		Rcpt:         rcpt,
		EnvelopeFrom: "alerts@bank.test",
		RemoteIP:     netip.MustParseAddr("198.51.100.7"),
		Raw:          []byte(body),
		ReceivedAt:   f.now,
		IsGrace:      isGrace,
	})
}

func (f *fixture) names(sub string) []string {
	f.t.Helper()
	ents, err := os.ReadDir(filepath.Join(f.dir, sub))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		f.t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		if !e.IsDir() {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

func (f *fixture) spooled() []string {
	var out []string
	for _, n := range f.names(".") {
		if strings.HasSuffix(n, metaSuffix) && n != replicaFile {
			out = append(out, n)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// 1. Durability
// ---------------------------------------------------------------------------

// A 250 on the wire is a promise that the message survives a power cut. Deliver
// must therefore return only once both halves of the pair are on disk and the
// DIRECTORY entry naming them has been synced too — without that last step the
// file's contents are safe and its NAME is not, which is indistinguishable from
// having lost the message.
func TestSpoolIsDurableBeforeAccepting(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

	if err := f.deliver(rcpt, "Subject: one\r\n\r\nbody one\r\n"); err != nil {
		t.Fatalf("Deliver: %v", err)
	}

	// Both halves exist the instant Deliver returns.
	metas := f.spooled()
	if len(metas) != 1 {
		t.Fatalf("spooled metadata files = %v, want 1", metas)
	}
	id := strings.TrimSuffix(metas[0], metaSuffix)
	raw, err := os.ReadFile(filepath.Join(f.dir, id+emlSuffix))
	if err != nil {
		t.Fatalf("read spooled message: %v", err)
	}
	if string(raw) != "Subject: one\r\n\r\nbody one\r\n" {
		t.Fatalf("spooled body = %q", raw)
	}

	// A restart — a brand new Relay over the same directory, holding none of
	// the first one's memory — still finds it.
	restarted := &Relay{
		SpoolDir: f.dir, PrimaryURL: f.r.PrimaryURL, Token: f.r.Token,
		Suffix: testSuffix, HTTP: f.r.HTTP, Now: f.r.Now, Logf: f.logf,
	}
	if err := restarted.Init(); err != nil {
		t.Fatal(err)
	}
	st, err := restarted.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if st.Spooled != 1 {
		t.Fatalf("after restart Stats().Spooled = %d, want 1", st.Spooled)
	}
	sent, failed, err := restarted.Drain(bg)
	if err != nil || sent != 1 || failed != 0 {
		t.Fatalf("Drain after restart = (%d,%d,%v), want (1,0,nil)", sent, failed, err)
	}
	if got := f.p.got(); len(got) != 1 || got[0] != "Subject: one\r\n\r\nbody one\r\n" {
		t.Fatalf("primary received %q", got)
	}
}

// The converse: a spool that cannot be made durable must FAIL, so smtpd answers
// a temporary error and the sending MTA keeps the message. A handler that
// swallowed the error would be accepting mail into a directory that does not
// exist.
func TestDeliverFailsWhenTheSpoolCannotBeWritten(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	// Replace the spool directory with a plain file: every create below fails.
	if err := os.RemoveAll(f.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.deliver(rcpt, "Subject: x\r\n\r\nx\r\n"); err == nil {
		t.Fatal("Deliver returned nil with an unusable spool directory: an SMTP 250 would be a lie")
	}
}

// The spool holds other people's bank mail in the clear (Phase 1). Nothing else
// on the box may read it.
func TestSpoolIsNotReadableByAnyoneElse(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "Subject: x\r\n\r\nx\r\n"); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("spool dir mode %v is reachable by group or other", fi.Mode().Perm())
	}
	for _, n := range f.names(".") {
		fi, err := os.Stat(filepath.Join(f.dir, n))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm()&0o077 != 0 {
			t.Fatalf("%s mode %v is readable by group or other", n, fi.Mode().Perm())
		}
	}
}

// ---------------------------------------------------------------------------
// 2. Drain
// ---------------------------------------------------------------------------

func TestDrainDeletesOnlyOnSuccess(t *testing.T) {
	t.Run("a 500 leaves the message spooled", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "m1"); err != nil {
			t.Fatal(err)
		}
		f.p.answer(http.StatusInternalServerError, "boom")
		sent, failed, err := f.r.Drain(bg)
		if err == nil {
			t.Fatal("Drain reported success against a primary answering 500")
		}
		if sent != 0 || failed != 0 {
			t.Fatalf("Drain = (%d,%d), want (0,0): a 5xx is retryable, not a rejection", sent, failed)
		}
		if got := len(f.spooled()); got != 1 {
			t.Fatalf("%d spooled after a 500, want the message kept", got)
		}
		if got := f.names(rejectedDir); len(got) != 0 {
			t.Fatalf("a 500 moved %v to rejected/", got)
		}
	})

	t.Run("a 2xx removes it", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "m2"); err != nil {
			t.Fatal(err)
		}
		sent, failed, err := f.r.Drain(bg)
		if err != nil || sent != 1 || failed != 0 {
			t.Fatalf("Drain = (%d,%d,%v), want (1,0,nil)", sent, failed, err)
		}
		if got := f.spooled(); len(got) != 0 {
			t.Fatalf("still spooled after a 202: %v", got)
		}
		if got := f.names("."); len(got) != 1 || got[0] != replicaFile {
			t.Fatalf("spool directory holds %v, want only the replica", got)
		}
	})

	t.Run("an explicit rejection moves it to rejected with the response body", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "m3"); err != nil {
			t.Fatal(err)
		}
		// The VERDICT is what authorises this, not the 404: see
		// TestOnlyAnExplicitVerdictFromThePrimaryRejectsAMessage.
		f.p.rejectWith(http.StatusNotFound, `{"error":"not_found","detail":"no such recipient"}`)
		sent, failed, err := f.r.Drain(bg)
		if err != nil {
			t.Fatalf("Drain = %v, want nil: a per-message rejection is not a drain failure", err)
		}
		if sent != 0 || failed != 1 {
			t.Fatalf("Drain = (%d,%d), want (0,1)", sent, failed)
		}
		if got := f.spooled(); len(got) != 0 {
			t.Fatalf("a rejected message is still in the live spool: %v", got)
		}
		names := f.names(rejectedDir)
		var haveEml, haveMeta, haveWhy bool
		for _, n := range names {
			switch {
			case strings.HasSuffix(n, emlSuffix):
				haveEml = true
			case strings.HasSuffix(n, rejectSuffix):
				haveWhy = true
			case strings.HasSuffix(n, metaSuffix):
				haveMeta = true
			}
		}
		if !haveEml || !haveMeta || !haveWhy {
			t.Fatalf("rejected/ holds %v, want the message, its metadata and the reason", names)
		}
		// The BODY is preserved, not just the status: an operator has to be able
		// to see the message that was refused.
		var body []byte
		for _, n := range names {
			if strings.HasSuffix(n, emlSuffix) {
				b, err := os.ReadFile(filepath.Join(f.dir, rejectedDir, n))
				if err != nil {
					t.Fatal(err)
				}
				body = b
			}
		}
		if string(body) != "m3" {
			t.Fatalf("rejected message body = %q, want it kept verbatim", body)
		}
		var why []byte
		for _, n := range names {
			if strings.HasSuffix(n, rejectSuffix) {
				b, err := os.ReadFile(filepath.Join(f.dir, rejectedDir, n))
				if err != nil {
					t.Fatal(err)
				}
				why = b
			}
		}
		if !strings.Contains(string(why), "404") || !strings.Contains(string(why), "no such recipient") {
			t.Fatalf("rejection record = %q, want the status and the primary's body", why)
		}
	})
}

// 401, 403 and 429 are 4xx and are NOT the message's fault: a misconfigured
// token or a throttled drain would otherwise sweep an entire spool into
// rejected/ in one tick, which is a silent bulk drop dressed as a rejection.
func TestOurOwnFailuresNeverRejectAMessage(t *testing.T) {
	for _, status := range []int{
		http.StatusUnauthorized, http.StatusForbidden,
		http.StatusRequestTimeout, http.StatusTooManyRequests,
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			f := newFixture(t)
			rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
			for _, m := range []string{"keep me", "and me", "me too"} {
				if err := f.deliver(rcpt, m); err != nil {
					t.Fatal(err)
				}
			}
			f.p.answer(status, "")
			sent, failed, err := f.r.Drain(bg)
			if err == nil {
				t.Fatalf("Drain against a %d reported success", status)
			}
			if sent != 0 || failed != 0 {
				t.Fatalf("Drain = (%d,%d), want (0,0)", sent, failed)
			}
			if got := len(f.spooled()); got != 3 {
				t.Fatalf("%d spooled after a %d, want all three messages kept", got, status)
			}
			if got := f.names(rejectedDir); len(got) != 0 {
				t.Fatalf("a %d moved %v to rejected/", status, got)
			}
			// And the pass STOPS. All four of these describe the whole primary,
			// so replaying the same failure once per spooled message is load
			// with no possible outcome — on a recovery drain of a week's backlog
			// against a throttling primary, it is also how a 429 becomes worse.
			if got := len(f.p.got()); got != 1 {
				t.Fatalf("the drain made %d delivery attempts against a %d, want it to stop at "+
					"the first: this answer is about the primary, not about a message", got, status)
			}
			if status == http.StatusUnauthorized || status == http.StatusForbidden {
				if !f.logged("REFUSED OUR TOKEN") {
					t.Fatalf("a %d did not tell the operator to check LEDGER_RELAY_TOKEN; logs: %v",
						status, f.logs)
				}
			}
		})
	}
}

// The outage this whole mode exists for: the primary is unreachable when the
// mail arrives, and comes back later.
func TestMailSpooledWhileThePrimaryIsDownIsDeliveredOnRecovery(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

	// Down: point the relay at a port nothing is listening on.
	up := f.r.PrimaryURL
	f.r.PrimaryURL = "http://127.0.0.1:1"

	for _, body := range []string{"first", "second", "third"} {
		if err := f.deliver(rcpt, body); err != nil {
			t.Fatalf("Deliver during the outage: %v (a 250 must still mean spooled)", err)
		}
	}
	if _, _, err := f.r.Drain(bg); err == nil {
		t.Fatal("Drain against an unreachable primary reported success")
	}
	if got := len(f.spooled()); got != 3 {
		t.Fatalf("%d spooled during the outage, want 3", got)
	}

	// Recovery.
	f.r.PrimaryURL = up
	sent, failed, err := f.r.Drain(bg)
	if err != nil || sent != 3 || failed != 0 {
		t.Fatalf("Drain on recovery = (%d,%d,%v), want (3,0,nil)", sent, failed, err)
	}
	if got := f.p.got(); len(got) != 3 {
		t.Fatalf("primary received %v", got)
	}
	// In arrival order: the spool id is time-ordered so a backlog reaches the
	// primary in the order it was received rather than in readdir order.
	if got := f.p.got(); got[0] != "first" || got[1] != "second" || got[2] != "third" {
		t.Fatalf("primary received %v, want arrival order", got)
	}
	if got := len(f.spooled()); got != 0 {
		t.Fatalf("%d still spooled after a clean drain", got)
	}
}

// The relay's contribution to idempotency is that it forwards the SAME BYTES
// every time, so the primary's ingest-id dedup can recognise a redelivery. A
// relay that re-framed or re-encoded on retry would defeat it.
// TestRelayedMailIsIdempotentAgainstTheRealPipeline in internal/v2/api proves
// the other half against the real primary.
func TestDrainIsIdempotentAgainstThePrimary(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	msg := "Subject: dup\r\n\r\nthe same bytes\r\n"
	if err := f.deliver(rcpt, msg); err != nil {
		t.Fatal(err)
	}

	// The first drain succeeds at the primary but the ANSWER is lost, so the
	// relay keeps the file: exactly the case that produces a redelivery.
	f.p.answer(http.StatusServiceUnavailable, "")
	if _, _, err := f.r.Drain(bg); err == nil {
		t.Fatal("expected the lost-answer drain to fail")
	}
	f.p.answer(0, "")
	if sent, _, err := f.r.Drain(bg); err != nil || sent != 1 {
		t.Fatalf("second drain = (%d,%v)", sent, err)
	}

	got := f.p.got()
	if len(got) != 2 {
		t.Fatalf("primary saw %d deliveries, want 2 (the redelivery is the point)", len(got))
	}
	if got[0] != got[1] || got[0] != msg {
		t.Fatalf("the redelivery differs from the original:\n %q\n %q", got[0], got[1])
	}
	// Same bytes means the same ingest id, which is the primary's dedup key.
	if sha256.Sum256([]byte(got[0])) != sha256.Sum256([]byte(got[1])) {
		t.Fatal("redelivered bytes hash differently from the original")
	}
}

// ---------------------------------------------------------------------------
// 3. A spool that outlives its retry budget
// ---------------------------------------------------------------------------

// Sender MTAs give up after ~1-3 days. A message this relay accepted with a 250
// has no sender left to retry it, so it may NEVER be deleted to make a metric
// look better — but a spool nothing ever looks at is a silent drop, so its age
// has to be surfaced.
func TestASpoolPastItsRetryBudgetIsSurfacedAndNeverDeleted(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "stranded"); err != nil {
		t.Fatal(err)
	}

	f.r.PrimaryURL = "http://127.0.0.1:1"
	for i := 0; i < 4; i++ {
		f.now = f.now.Add(24 * time.Hour)
		if _, _, err := f.r.Drain(bg); err == nil {
			t.Fatal("Drain against an unreachable primary reported success")
		}
	}

	st, err := f.r.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if st.Spooled != 1 {
		t.Fatalf("Stats().Spooled = %d: a message past its retry budget was deleted", st.Spooled)
	}
	if got := st.OldestAge(f.now); got < 96*time.Hour {
		t.Fatalf("Stats().OldestAge = %v, want the true age of the spooled message", got)
	}
	if !st.Stale(f.now, DefaultStaleAfter) {
		t.Fatal("a four-day-old spooled message is not reported as stale")
	}
	if !f.logged("SPOOL ALARM") {
		t.Fatalf("nothing surfaced the stranded message; logs: %v", f.logs)
	}
	// And it is still deliverable once the primary is back: the alarm is a
	// notice, not a disposal.
	f.r.PrimaryURL = f.url
	if sent, _, err := f.r.Drain(bg); err != nil || sent != 1 {
		t.Fatalf("Drain after the alarm = (%d,%v), want the message still deliverable", sent, err)
	}
	if got := f.p.got(); len(got) != 1 || got[0] != "stranded" {
		t.Fatalf("primary received %v", got)
	}
}

// ---------------------------------------------------------------------------
// 4. The replica holds nothing but addresses
// ---------------------------------------------------------------------------

func TestRelayHoldsNoOpLogData(t *testing.T) {
	f := newFixture(t)
	expires := f.now.Add(48 * time.Hour)
	f.p.publish("u-aaaaaaaaaaaaaaaaaaaaaaaaaa", nil)
	f.p.publish("u-bbbbbbbbbbbbbbbbbbbbbbbbbb", &expires)
	n, err := f.r.SyncAddresses(bg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("SyncAddresses = %d, want 2", n)
	}

	raw, err := os.ReadFile(filepath.Join(f.dir, replicaFile))
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]json.RawMessage
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	wantTop := map[string]bool{"as_of": true, "addresses": true}
	for k := range file {
		if !wantTop[k] {
			t.Fatalf("replica file carries an unexpected top-level key %q", k)
		}
	}
	for k := range wantTop {
		if _, ok := file[k]; !ok {
			t.Fatalf("replica file is missing %q", k)
		}
	}
	var addrs []map[string]json.RawMessage
	if err := json.Unmarshal(file["addresses"], &addrs); err != nil {
		t.Fatal(err)
	}
	if len(addrs) != 2 {
		t.Fatalf("%d addresses in the replica, want 2", len(addrs))
	}
	want := map[string]bool{"local_part": true, "user_pubkey": true, "expires_at": true}
	for _, a := range addrs {
		if len(a) != len(want) {
			t.Fatalf("replica address has keys %v, want exactly %v", keysOf(a), keysOf2(want))
		}
		for k := range a {
			if !want[k] {
				t.Fatalf("replica address carries %q: the relay holds only the address map", k)
			}
		}
	}
	// Nothing that looks like op-log data, a user id or a seq, anywhere in the
	// file — including inside a value.
	for _, bad := range []string{"user_id", "op_log", "writer", "seq", "blob", "ingest_id", "payload"} {
		if strings.Contains(string(raw), bad) {
			t.Fatalf("replica file mentions %q", bad)
		}
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func keysOf2(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// The spool metadata is the other place the relay could accumulate something it
// has no business holding.
func TestSpoolMetadataCarriesOnlyWhatThePrimaryNeeds(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "body"); err != nil {
		t.Fatal(err)
	}
	name := f.spooled()[0]
	raw, err := os.ReadFile(filepath.Join(f.dir, name))
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"v": true, "id": true, "local_part": true, "envelope_from": true,
		"remote_ip": true, "received_at": true, "bytes": true, "sha256": true, "sealed": true,
	}
	for k := range meta {
		if !want[k] {
			t.Fatalf("spool metadata carries an unexpected key %q", k)
		}
	}
	if string(meta["sealed"]) != "false" {
		t.Fatalf(`spool metadata sealed = %s, want false: Phase 1 spools PLAINTEXT and the `+
			`on-disk record must say so`, meta["sealed"])
	}
	// The pseudonymous quota key the relay hands smtpd must never be written
	// down as though it were an account identifier.
	if strings.Contains(string(raw), "user_id") {
		t.Fatalf("spool metadata mentions a user id: %s", raw)
	}
}

// ---------------------------------------------------------------------------
// 5. A stale replica
// ---------------------------------------------------------------------------

// The relay's replica goes stale exactly when the primary is unreachable, which
// is precisely when the relay matters. Answering a PERMANENT 550 from data we
// know may be out of date is how a real address gets refused forever — and
// Gmail disables a forwarding rule after sustained permanent failures.
func TestAStaleReplicaNeverPermanentlyRefusesARecipient(t *testing.T) {
	f := newFixture(t)
	known := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	unknown := "u-cccccccccccccccccccccccccc" + testSuffix

	// Fresh replica: an unknown recipient is refused permanently, exactly as the
	// primary would.
	if _, _, err := f.r.Resolve(bg, unknown); !errors.Is(err, addresses.ErrUnknownRecipient) {
		t.Fatalf("fresh replica, unknown recipient: err = %v, want ErrUnknownRecipient", err)
	}

	// The primary has been unreachable for two days.
	f.now = f.now.Add(48 * time.Hour)
	_, _, err := f.r.Resolve(bg, unknown)
	if err == nil {
		t.Fatal("a stale replica accepted an unknown recipient")
	}
	if errors.Is(err, addresses.ErrUnknownRecipient) {
		t.Fatal("a stale replica answered a PERMANENT refusal: an address issued " +
			"since the last sync would be rejected forever")
	}
	// The addresses it does know still work: a stale replica is not a dead one.
	if _, _, err := f.r.Resolve(bg, known); err != nil {
		t.Fatalf("stale replica refused a KNOWN address: %v", err)
	}
}

// A relay that has never managed a sync — booted during the outage — knows
// nothing, and must say so temporarily rather than refusing the world.
func TestARelayWithNoReplicaDefersEveryRecipient(t *testing.T) {
	f := newFixture(t)
	_, _, err := f.r.Resolve(bg, "u-aaaaaaaaaaaaaaaaaaaaaaaaaa"+testSuffix)
	if err == nil {
		t.Fatal("a relay with no replica accepted a recipient it cannot know about")
	}
	if errors.Is(err, addresses.ErrUnknownRecipient) {
		t.Fatal("a relay with no replica refused permanently")
	}
}

// A recipient that is not even shaped like one of ours is refused permanently
// whatever the replica's age: no amount of syncing would ever make
// postmaster@example.com an address this system issued.
func TestAnOffDomainRecipientIsAlwaysRefusedPermanently(t *testing.T) {
	f := newFixture(t)
	f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	f.now = f.now.Add(30 * 24 * time.Hour)
	for _, rcpt := range []string{
		"postmaster@example.com",
		"root@in.example.test",
		"u-short@in.example.test",
		"u-AAAAAAAAAAAAAAAAAAAAAAAA11@in.example.test",
	} {
		if _, _, err := f.r.Resolve(bg, rcpt); !errors.Is(err, addresses.ErrUnknownRecipient) {
			t.Fatalf("Resolve(%q) = %v, want a permanent ErrUnknownRecipient", rcpt, err)
		}
	}
}

// The grace window is the primary's, and the relay must apply the same
// predicate to the same data rather than a second copy of the rule.
func TestTheReplicaHonoursTheGraceWindow(t *testing.T) {
	f := newFixture(t)
	expires := f.now.Add(time.Hour)
	f.p.publish("u-bbbbbbbbbbbbbbbbbbbbbbbbbb", &expires)
	if _, err := f.r.SyncAddresses(bg); err != nil {
		t.Fatal(err)
	}
	rcpt := "u-bbbbbbbbbbbbbbbbbbbbbbbbbb" + testSuffix

	userID, isGrace, err := f.r.Resolve(bg, rcpt)
	if err != nil {
		t.Fatalf("inside the grace window: %v", err)
	}
	if !isGrace {
		t.Fatal("a retired address inside its window did not report isGrace")
	}
	if userID == uuid.Nil {
		t.Fatal("Resolve returned the nil uuid, which smtpd would key a quota on")
	}

	// Exactly at the deadline the window is over (exclusive), and with a fresh
	// replica that is a permanent refusal.
	f.now = expires
	if _, _, err := f.r.Resolve(bg, rcpt); !errors.Is(err, addresses.ErrUnknownRecipient) {
		t.Fatalf("at the grace deadline: err = %v, want ErrUnknownRecipient", err)
	}
}

// The quota key the relay hands smtpd must be derived from the address alone.
// It is NOT a user id — the relay never learns one — but it must be stable, or
// the per-address daily allowance would reset on every message.
func TestTheQuotaKeyIsStableAndCarriesNoAccountIdentity(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	a, _, err := f.r.Resolve(bg, rcpt)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := f.r.Resolve(bg, strings.ToUpper(rcpt))
	if err != nil {
		t.Fatalf("an upper-cased spelling of the same mailbox: %v", err)
	}
	if a != b {
		t.Fatalf("two spellings of one mailbox produced different quota keys %s and %s", a, b)
	}
	other := f.address("u-bbbbbbbbbbbbbbbbbbbbbbbbbb")
	c, _, err := f.r.Resolve(bg, other)
	if err != nil {
		t.Fatal(err)
	}
	if c == a {
		t.Fatal("two different addresses share a quota key")
	}
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// A failed sync must leave the previous replica intact: the relay's ability to
// accept mail is exactly what the outage takes away otherwise.
func TestAFailedSyncKeepsTheLastGoodReplica(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

	f.p.mu.Lock()
	f.p.getErr = http.StatusInternalServerError
	f.p.mu.Unlock()
	if _, err := f.r.SyncAddresses(bg); err == nil {
		t.Fatal("SyncAddresses reported success against a 500")
	}
	if _, _, err := f.r.Resolve(bg, rcpt); err != nil {
		t.Fatalf("a failed sync destroyed the working replica: %v", err)
	}

	// And the file on disk is still the good one.
	raw, err := os.ReadFile(filepath.Join(f.dir, replicaFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "u-aaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatalf("replica file after a failed sync = %s", raw)
	}
}

// The replica is a full snapshot, so an address the primary no longer serves —
// a rotation past its grace, or a purged account — disappears from the relay on
// the next sync. An incremental protocol could not express that.
func TestSyncReplacesTheReplicaRatherThanMergingIntoIt(t *testing.T) {
	f := newFixture(t)
	gone := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

	f.p.mu.Lock()
	f.p.addrs = nil
	f.p.mu.Unlock()
	f.p.publish("u-bbbbbbbbbbbbbbbbbbbbbbbbbb", nil)
	if _, err := f.r.SyncAddresses(bg); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.r.Resolve(bg, gone); !errors.Is(err, addresses.ErrUnknownRecipient) {
		t.Fatalf("an address the primary dropped is still accepted: %v", err)
	}
}

// A primary that answers with a malformed local part must not be able to plant
// one in the replica: the local part is used to name nothing on disk, but it IS
// what the primary is asked to resolve on drain, and a replica that accepts
// arbitrary strings is a replica an attacker who reaches the endpoint can steer.
func TestSyncRefusesMalformedAddresses(t *testing.T) {
	f := newFixture(t)
	f.p.publish("u-aaaaaaaaaaaaaaaaaaaaaaaaaa", nil)
	f.p.publish("../../etc/passwd", nil)
	f.p.publish("u-NOTVALID", nil)
	n, err := f.r.SyncAddresses(bg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("SyncAddresses kept %d addresses, want only the well-formed one", n)
	}
	if !f.logged("malformed") {
		t.Fatalf("a malformed address was dropped silently; logs: %v", f.logs)
	}
}

// The relay reports its backlog on the one call it already makes to the
// primary, so a spool nobody is watching shows up on the box the operator IS
// watching.
func TestSyncReportsTheSpoolBacklogToThePrimary(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "stuck"); err != nil {
		t.Fatal(err)
	}
	f.r.PrimaryURL = "http://127.0.0.1:1"
	_, _, _ = f.r.Drain(bg)
	f.r.PrimaryURL = f.url
	if _, err := f.r.SyncAddresses(bg); err != nil {
		t.Fatal(err)
	}
	f.p.mu.Lock()
	hdrs := append([]string(nil), f.p.spoolHeaders...)
	f.p.mu.Unlock()
	if len(hdrs) == 0 {
		t.Fatal("the relay reported no spool state at all")
	}
	last := hdrs[len(hdrs)-1]
	if !strings.Contains(last, "spooled=1") {
		t.Fatalf("spool header = %q, want spooled=1", last)
	}
}

// ---------------------------------------------------------------------------
// Recovery from a partial write
// ---------------------------------------------------------------------------

// The metadata file is written LAST and is the commit record. A message body
// with no metadata beside it was never acknowledged to the sender, so it must
// not be forwarded (there is nothing saying who it was for) and must not be
// deleted either — it is reported instead.
func TestAnUncommittedSpoolFileIsNeitherDrainedNorDeleted(t *testing.T) {
	f := newFixture(t)
	orphan := filepath.Join(f.dir, "01912345-0000-7000-8000-000000000001"+emlSuffix)
	if err := os.WriteFile(orphan, []byte("half written"), 0o600); err != nil {
		t.Fatal(err)
	}
	sent, failed, err := f.r.Drain(bg)
	if err != nil || sent != 0 || failed != 0 {
		t.Fatalf("Drain = (%d,%d,%v), want (0,0,nil)", sent, failed, err)
	}
	if got := f.p.got(); len(got) != 0 {
		t.Fatalf("an uncommitted spool file was forwarded: %v", got)
	}
	if _, err := os.Stat(orphan); err != nil {
		t.Fatalf("an uncommitted spool file was deleted: %v", err)
	}
	st, err := f.r.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if st.Uncommitted != 1 {
		t.Fatalf("Stats().Uncommitted = %d, want 1", st.Uncommitted)
	}
}

// A corrupt body — truncated by a power cut after the metadata landed — must
// not be forwarded as though it were the message: its hash is in the metadata
// precisely so this is detectable.
func TestACorruptSpooledBodyIsNotForwarded(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "the real message"); err != nil {
		t.Fatal(err)
	}
	id := strings.TrimSuffix(f.spooled()[0], metaSuffix)
	if err := os.WriteFile(filepath.Join(f.dir, id+emlSuffix), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	sent, failed, err := f.r.Drain(bg)
	if err != nil {
		t.Fatalf("Drain = %v", err)
	}
	if sent != 0 {
		t.Fatal("a corrupt body was forwarded to the primary")
	}
	if failed != 1 {
		t.Fatalf("Drain = (%d,%d), want the corrupt message counted as failed", sent, failed)
	}
	if got := f.p.got(); len(got) != 0 {
		t.Fatalf("primary received %v", got)
	}
	if got := f.names(rejectedDir); len(got) == 0 {
		t.Fatal("a corrupt message was neither forwarded nor set aside")
	}
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

func TestInitRefusesAnIncompleteRelay(t *testing.T) {
	for name, r := range map[string]*Relay{
		"no spool dir":   {PrimaryURL: "https://p.test", Token: "t", Suffix: testSuffix},
		"no primary url": {SpoolDir: t.TempDir(), Token: "t", Suffix: testSuffix},
		"no token":       {SpoolDir: t.TempDir(), PrimaryURL: "https://p.test", Suffix: testSuffix},
		"no suffix":      {SpoolDir: t.TempDir(), PrimaryURL: "https://p.test", Token: "t"},
		"cleartext":      {SpoolDir: t.TempDir(), PrimaryURL: "http://primary.example.test", Token: "t", Suffix: testSuffix},
		"not a url":      {SpoolDir: t.TempDir(), PrimaryURL: "primary.example.test", Token: "t", Suffix: testSuffix},
	} {
		t.Run(name, func(t *testing.T) {
			if err := r.Init(); err == nil {
				t.Fatal("Init accepted an unusable relay")
			}
		})
	}
}

// Cleartext to a loopback or tailnet primary is fine: those are the development
// and the over-Tailscale deployments, and neither puts a bearer token and other
// people's bank mail on the public internet.
func TestInitAcceptsCleartextOnlyToALoopbackOrTailnetPrimary(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:8443", "http://localhost:8443", "http://100.64.1.2:8443"} {
		r := &Relay{SpoolDir: t.TempDir(), PrimaryURL: u, Token: "t", Suffix: testSuffix}
		if err := r.Init(); err != nil {
			t.Fatalf("Init(%q) = %v", u, err)
		}
	}
}

var _ smtpd.Handler = (*Relay)(nil)
var _ smtpd.Resolver = (*Relay)(nil)

func TestSpoolIDsSortInArrivalOrder(t *testing.T) {
	var prev string
	for i := 0; i < 200; i++ {
		id, err := newSpoolID()
		if err != nil {
			t.Fatal(err)
		}
		if id <= prev {
			t.Fatalf("spool id %q does not sort after %q", id, prev)
		}
		prev = id
	}
	if _, err := hex.DecodeString(strings.ReplaceAll(prev, "-", "")); err != nil {
		t.Fatalf("spool id %q is not hex: %v", prev, err)
	}
}
