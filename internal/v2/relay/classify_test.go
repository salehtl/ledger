package relay

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/smtpd"
)

// Everything in this file is about ONE distinction: "this primary is not in a
// state to take mail" (a deployment condition — retry, alarm, never discard)
// versus "this message is undeliverable" (a verdict about the message — set it
// aside). Getting that wrong destroys mail that was already accepted with a
// 250, which no sender will ever retry.

// ---------------------------------------------------------------------------
// C1 — a primary that does not MOUNT the relay routes answers 404
// ---------------------------------------------------------------------------

// unmountedPrimary is a healthy server whose /api/* catch-all answers 404 —
// exactly what internal/v2/api does when LEDGER_RELAY_TOKEN is unset, or Mail
// or Addresses is nil (api.relayRoutesMountable). Every one of those is a
// DEPLOYMENT state on the other box, and none of them says anything about the
// message being offered.
func unmountedPrimary(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"not_found","message":""}}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// Before this test the drain's default arm treated a 404 as a per-message
// rejection, so a single tick against a primary whose relay routes are not
// mounted moved the ENTIRE spool to rejected/ — permanently, since this package
// never retries that lane — for mail whose senders were already told 250. A
// configuration mistake on the primary must never destroy accepted mail.
func TestAPrimaryThatDoesNotServeTheRelayRoutesNeverRejectsAnything(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	for _, m := range []string{"one", "two", "three"} {
		if err := f.deliver(rcpt, m); err != nil {
			t.Fatal(err)
		}
	}
	srv := unmountedPrimary(t)
	f.r.PrimaryURL, f.r.HTTP = srv.URL, srv.Client()

	sent, failed, err := f.r.Drain(bg)
	if err == nil {
		t.Fatal("Drain reported success against a primary that does not serve the relay routes")
	}
	if sent != 0 || failed != 0 {
		t.Fatalf("Drain = (%d,%d), want (0,0): a 404 from an unmounted route is a condition of "+
			"the PRIMARY, not a verdict on three messages", sent, failed)
	}
	if got := len(f.spooled()); got != 3 {
		t.Fatalf("%d of 3 messages still spooled — the rest were discarded because of a "+
			"configuration mistake on the other box", got)
	}
	if got := f.names(rejectedDir); len(got) != 0 {
		t.Fatalf("rejected/ holds %v after a 404 sweep", got)
	}
	if !f.logged("DOES NOT SERVE THE RELAY ENDPOINTS") {
		t.Fatalf("nothing told the operator the primary is not serving the relay routes; logs: %v",
			f.logs)
	}
}

// The same answer must not be reclassified by repetition: every tick keeps
// every message, for ever, until somebody fixes the primary.
func TestRepeatedTicksAgainstAnUnmountedPrimaryKeepEveryMessage(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "keep me across ticks"); err != nil {
		t.Fatal(err)
	}
	srv := unmountedPrimary(t)
	f.r.PrimaryURL, f.r.HTTP = srv.URL, srv.Client()
	for i := 0; i < 5; i++ {
		if _, failed, _ := f.r.Drain(bg); failed != 0 {
			t.Fatalf("tick %d rejected a message", i)
		}
	}
	if got := len(f.spooled()); got != 1 {
		t.Fatalf("%d spooled after five ticks, want the message kept", got)
	}
	if got := f.names(rejectedDir); len(got) != 0 {
		t.Fatalf("rejected/ holds %v", got)
	}
}

// A rejection is a thing the primary SAYS, not a thing the relay infers from a
// status code. Only an answer carrying the verdict header may move a message
// out of the live spool — so "I do not know what you are talking about", from
// an unmounted route, a stale reverse proxy or a captive portal, can never mean
// "this message is undeliverable".
func TestOnlyAnExplicitVerdictFromThePrimaryRejectsAMessage(t *testing.T) {
	t.Run("a 404 without a verdict keeps the message", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "unmarked"); err != nil {
			t.Fatal(err)
		}
		f.p.answer(http.StatusNotFound, `{"error":{"code":"not_found"}}`)
		sent, failed, _ := f.r.Drain(bg)
		if sent != 0 || failed != 0 {
			t.Fatalf("Drain = (%d,%d), want (0,0)", sent, failed)
		}
		if got := len(f.spooled()); got != 1 {
			t.Fatalf("%d spooled, want the message kept", got)
		}
	})

	t.Run("a 404 WITH a verdict is a rejection", func(t *testing.T) {
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "unknown recipient"); err != nil {
			t.Fatal(err)
		}
		f.p.rejectWith(http.StatusNotFound, `{"error":{"code":"not_found"}}`)
		sent, failed, err := f.r.Drain(bg)
		if err != nil || sent != 0 || failed != 1 {
			t.Fatalf("Drain = (%d,%d,%v), want (0,1,nil)", sent, failed, err)
		}
		if got := len(f.spooled()); got != 0 {
			t.Fatalf("%d still in the live spool after an explicit rejection", got)
		}
	})

	t.Run("a verdict on a retryable status is still retryable", func(t *testing.T) {
		// The two rules must not be able to fight: a 503 says the primary is
		// having trouble, and a header cannot upgrade that into a verdict about
		// one message.
		f := newFixture(t)
		rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
		if err := f.deliver(rcpt, "confused primary"); err != nil {
			t.Fatal(err)
		}
		f.p.rejectWith(http.StatusServiceUnavailable, "")
		sent, failed, err := f.r.Drain(bg)
		if err == nil || sent != 0 || failed != 0 {
			t.Fatalf("Drain = (%d,%d,%v), want (0,0,err)", sent, failed, err)
		}
		if got := len(f.spooled()); got != 1 {
			t.Fatalf("%d spooled, want the message kept", got)
		}
	})
}

// ---------------------------------------------------------------------------
// IR2 / IR3 — one bad file must not stop, or destroy, the rest
// ---------------------------------------------------------------------------

// loopingSymlink replaces a spool file with a symlink to itself: reading it
// fails with ELOOP, which is a LOCAL, non-ENOENT error — the class the drain
// used to treat as a whole-primary condition (for the commit record) or as a
// permanent rejection (for the body).
func loopingSymlink(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Base(path), path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(path); err == nil {
		t.Fatalf("%s is readable; the fixture did not create a loop", path)
	}
}

// A single unreadable commit record used to return outcomeRetry, which Drain
// treats as a whole-primary condition and stops the entire pass on. It is not a
// whole-primary condition — it is one file — and the messages behind it were
// never even offered.
func TestOneUnreadableSpoolEntryDoesNotBlockTheMessagesBehindIt(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	for _, m := range []string{"first", "second", "third"} {
		if err := f.deliver(rcpt, m); err != nil {
			t.Fatal(err)
		}
	}
	metas := f.spooled()
	if len(metas) != 3 {
		t.Fatalf("spooled = %v", metas)
	}
	// The OLDEST, which is the one every pass reaches first.
	loopingSymlink(t, filepath.Join(f.dir, metas[0]))

	sent, failed, err := f.r.Drain(bg)
	if sent != 2 {
		t.Fatalf("Drain delivered %d of the 2 good messages behind an unreadable entry "+
			"(failed=%d, err=%v)", sent, failed, err)
	}
	if err == nil {
		t.Fatal("Drain hid the unreadable entry entirely; it must be reported")
	}
	if got := f.names(rejectedDir); len(got) != 0 {
		t.Fatalf("an unreadable commit record was discarded into %v — the bytes may be perfectly "+
			"fine and nothing has proved otherwise", got)
	}
	if !f.logged("could not be read") {
		t.Fatalf("the stuck entry was not reported to the operator; logs: %v", f.logs)
	}
}

// A body that cannot be read for a TRANSIENT reason is not a message that is
// undeliverable. The commit record beside it is retried on the same class of
// error, and the two halves of one pair being handled asymmetrically is how a
// full disk or an EIO becomes a permanent drop.
func TestATransientlyUnreadableBodyIsKeptRatherThanRejected(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	for _, m := range []string{"unreadable", "fine"} {
		if err := f.deliver(rcpt, m); err != nil {
			t.Fatal(err)
		}
	}
	metas := f.spooled()
	if len(metas) != 2 {
		t.Fatalf("spooled = %v", metas)
	}
	id := strings.TrimSuffix(metas[0], metaSuffix)
	loopingSymlink(t, filepath.Join(f.dir, id+emlSuffix))

	sent, failed, _ := f.r.Drain(bg)
	if sent != 1 {
		t.Fatalf("Drain delivered %d, want the one good message behind the unreadable body", sent)
	}
	if failed != 0 {
		t.Fatal("an unreadable body was counted as a rejection")
	}
	if got := f.names(rejectedDir); len(got) != 0 {
		t.Fatalf("a body that could not be READ was filed as undeliverable: %v", got)
	}
	if got := f.spooled(); len(got) != 1 {
		t.Fatalf("spooled = %v, want the unreadable pair kept for the next pass", got)
	}
}

// A spooled message with no recipient is one the primary can never place, so
// Deliver refuses a recipient that is not ours rather than defaulting to
// something. Unreachable through smtpd — Resolve accepted the recipient moments
// earlier — which is exactly why it needs an assertion of its own.
func TestDeliverRefusesARecipientThatIsNotOurs(t *testing.T) {
	f := newFixture(t)
	f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	err := f.r.Deliver(bg, smtpd.Delivery{
		Rcpt:       "postmaster@example.com",
		Raw:        []byte("Subject: not ours\r\n\r\nx\r\n"),
		ReceivedAt: f.now,
	})
	if err == nil {
		t.Fatal("Deliver accepted a recipient outside our suffix")
	}
	if got := f.spooled(); len(got) != 0 {
		t.Fatalf("a foreign recipient was spooled: %v", got)
	}
}

// ---------------------------------------------------------------------------
// IR1 — an empty replica is not an authoritative "no such address"
// ---------------------------------------------------------------------------

// A primary whose inbound_addresses query legitimately returns nothing — an
// empty table, a half-applied migration, a restored-from-backup database, a bad
// expires_at comparison — used to install a FRESH, EMPTY replica. Resolve then
// found nothing in a replica it considered authoritative and answered
// addresses.ErrUnknownRecipient, which smtpd turns into a permanent 550 for
// every live address. A sustained permanent failure is precisely what makes
// Gmail disable a forwarding rule, which is the outage this whole mode exists
// to prevent.
func TestAnEmptyAnswerNeverReplacesAWorkingReplica(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if _, _, err := f.r.Resolve(bg, rcpt); err != nil {
		t.Fatalf("Resolve before the empty sync: %v", err)
	}

	f.p.mu.Lock()
	f.p.addrs = []map[string]any{}
	f.p.asOf = f.now.Add(time.Minute)
	f.p.mu.Unlock()

	if n, err := f.r.SyncAddresses(bg); err == nil {
		t.Fatalf("SyncAddresses accepted an empty address map (%d addresses) over a working "+
			"replica; every live address would now be refused PERMANENTLY", n)
	}
	if _, _, err := f.r.Resolve(bg, rcpt); err != nil {
		t.Fatalf("Resolve after the empty sync = %v, want the previous replica still answering", err)
	}
	// And on disk, so a restart does not adopt it either.
	raw, err := os.ReadFile(filepath.Join(f.dir, replicaFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "u-aaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatalf("the on-disk replica was emptied: %s", raw)
	}
	if !f.logged("EMPTY address map") {
		t.Fatalf("an empty address map was not reported to the operator; logs: %v", f.logs)
	}
}

// A relay whose FIRST sync is empty is a different case: there is nothing to
// lose and nothing to refuse, so it installs and the relay answers for nobody
// (which is the truth).
func TestAnEmptyFirstSyncIsAccepted(t *testing.T) {
	f := newFixture(t)
	n, err := f.r.SyncAddresses(bg)
	if err != nil || n != 0 {
		t.Fatalf("SyncAddresses on a fresh relay = (%d,%v), want (0,nil)", n, err)
	}
}

// The status check itself: a primary answering an error with a well-formed body
// must not install anything. TestAFailedSyncKeepsTheLastGoodReplica covers a
// 500 with an EMPTY body, which the JSON decoder rejects anyway — so removing
// the status check entirely left the suite green.
func TestASyncIgnoresAWellFormedBodyBehindAnErrorStatus(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")

	f.p.mu.Lock()
	f.p.getErr = http.StatusForbidden
	f.p.addrs = []map[string]any{
		{"local_part": "u-bbbbbbbbbbbbbbbbbbbbbbbbbb", "user_pubkey": "", "expires_at": nil},
	}
	f.p.mu.Unlock()

	if _, err := f.r.SyncAddresses(bg); err == nil {
		t.Fatal("SyncAddresses accepted a 403")
	} else if !strings.Contains(err.Error(), "403") {
		t.Fatalf("SyncAddresses error = %v, want it to name the status", err)
	}
	if _, _, err := f.r.Resolve(bg, rcpt); err != nil {
		t.Fatalf("Resolve after a refused sync = %v, want the last good replica", err)
	}
}

// ---------------------------------------------------------------------------
// The replica write, and the bound on what a sync will read
// ---------------------------------------------------------------------------

// The replica is written to a temp file and RENAMED over the live one. A direct
// write would leave a half-written replica after a crash, which loads as "no
// addresses at all" — a relay that defers every message. Making the temp path
// unwritable proves the temp path is on the path at all.
func TestTheReplicaIsWrittenThroughATempFileAndRenamed(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := os.Mkdir(filepath.Join(f.dir, replicaTmp), 0o700); err != nil {
		t.Fatal(err)
	}
	f.p.publish("u-bbbbbbbbbbbbbbbbbbbbbbbbbb", nil)
	if _, err := f.r.SyncAddresses(bg); err == nil {
		t.Fatal("SyncAddresses succeeded with an unusable temp path: the replica was written " +
			"directly over the live file")
	}
	if _, _, err := f.r.Resolve(bg, rcpt); err != nil {
		t.Fatalf("Resolve after a failed replica write = %v, want the last good replica", err)
	}
}

// The primary is authenticated, but a wedged or compromised one must not be
// able to make the relay allocate without limit.
func TestASyncWillNotReadAnUnboundedReplica(t *testing.T) {
	f := newFixture(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"as_of":"2026-08-01T12:00:00Z","addresses":[`)
		row := `{"local_part":"u-aaaaaaaaaaaaaaaaaaaaaaaaaa","user_pubkey":"`
		pad := strings.Repeat("A", 1024)
		for written := 0; written < maxReplicaBytes+(1<<20); written += len(row) + len(pad) + 24 {
			if written > 0 {
				_, _ = io.WriteString(w, ",")
			}
			_, _ = io.WriteString(w, row+pad+`","expires_at":null}`)
		}
		_, _ = io.WriteString(w, `]}`)
	}))
	defer srv.Close()
	f.r.PrimaryURL, f.r.HTTP = srv.URL, srv.Client()

	if n, err := f.r.SyncAddresses(bg); err == nil {
		t.Fatalf("SyncAddresses read an unbounded replica to completion (%d addresses)", n)
	}
}

// ---------------------------------------------------------------------------
// IR4 — the client the RELAY actually runs with
// ---------------------------------------------------------------------------

// Every other test injects httptest's client, which has no redirect policy at
// all. The refusal lives on defaultClient, so it was exercised by nothing —
// while a redirect the relay followed would hand the bearer token to whoever
// the primary's answer named.
func TestTheDefaultClientRefusesToFollowARedirectWithTheBearerToken(t *testing.T) {
	var elsewhere *httptest.Server
	elsewhere = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the relay followed a redirect and sent %q to another host",
			r.Header.Get("Authorization"))
		_ = elsewhere
		w.WriteHeader(http.StatusOK)
	}))
	defer elsewhere.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+AddressesPath, http.StatusFound)
	}))
	defer srv.Close()

	f := newFixture(t)
	f.r.PrimaryURL = srv.URL
	f.r.HTTP = nil // the production client, which is the point of this test

	_, err := f.r.SyncAddresses(bg)
	if err == nil {
		t.Fatal("SyncAddresses followed a redirect")
	}
	if !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("SyncAddresses error = %v, want the redirect refusal", err)
	}
}

// ---------------------------------------------------------------------------
// The wire contract with the primary
// ---------------------------------------------------------------------------

// A guard on the shape of the two constants the primary mirrors. api's
// TestTheRelayRoutesAreTheOnesTheRelayCalls asserts the values agree; this
// asserts the verdict marker is a real, non-empty header name, since an empty
// one would make every answer a rejection.
func TestTheVerdictMarkerIsAHeader(t *testing.T) {
	if !strings.HasPrefix(VerdictHeader, "X-") || VerdictReject == "" {
		t.Fatalf("VerdictHeader=%q VerdictReject=%q", VerdictHeader, VerdictReject)
	}
	// And it is not something a stray proxy would set by accident.
	if !strings.Contains(strings.ToLower(VerdictHeader), "relay") {
		t.Fatalf("VerdictHeader=%q should name this protocol", VerdictHeader)
	}
}

// A spool header is only sent when there is something to report; this pins the
// shape the primary logs, since the two are parsed by human eyes.
func TestSpoolHeaderShape(t *testing.T) {
	f := newFixture(t)
	rcpt := f.address("u-aaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err := f.deliver(rcpt, "x"); err != nil {
		t.Fatal(err)
	}
	h := f.r.spoolHeader()
	for _, want := range []string{"spooled=1", "rejected=0", "uncommitted=0", "oldest="} {
		if !strings.Contains(h, want) {
			t.Fatalf("spool header %q is missing %q", h, want)
		}
	}
	var meta spoolMeta
	raw, err := os.ReadFile(filepath.Join(f.dir, f.spooled()[0]))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h, meta.ReceivedAt.UTC().Format(time.RFC3339)) {
		t.Fatalf("spool header %q does not carry the oldest arrival %s", h, meta.ReceivedAt)
	}
	_ = fmt.Sprint(h)
}
