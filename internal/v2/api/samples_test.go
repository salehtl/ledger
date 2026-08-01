package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/samples"
)

type sampleHarness struct {
	*harness
	d   *diag.Diag
	now time.Time
}

func newSampleHarness(t *testing.T) *sampleHarness {
	t.Helper()
	h := newHarness(t)
	// Milliseconds: a cold record's received_at round-trips through
	// oplog.EncodeRawBody, which canonicalises to that resolution.
	now := time.Now().UTC().Truncate(time.Millisecond)
	h.srv.Samples = &samples.Samples{Pool: h.pool, Now: func() time.Time { return now }}
	h.h = h.srv.Handler()
	return &sampleHarness{harness: h, d: &diag.Diag{Pool: h.pool}, now: now}
}

func sampleMail(body string) []byte {
	return []byte("From: alerts@testbank.test\r\n" +
		"Subject: Transaction Alert\r\n" +
		"Date: Thu, 01 Jan 2026 10:00:00 +0400\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" + body + "\r\n")
}

// receive reproduces what an arrival leaves behind: the cold blob with the body
// and the diagnostics row with the verified origin.
func (h *sampleHarness) receive(u uuid.UUID, raw []byte, domain string) string {
	h.t.Helper()
	sum := sha256.Sum256(raw)
	cold, err := oplog.EncodeRawBody(oplog.RawBody{
		IngestID:   hex.EncodeToString(sum[:]),
		ReceivedAt: h.now,
		RawBase64:  base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.srv.Appender.AppendIngest(bg, u, []oplog.IngestBlob{
		{Stream: blob.StreamCold, Plaintext: cold, CreatedAt: h.now},
	}); err != nil {
		h.t.Fatal(err)
	}
	if err := h.d.Record(bg, diag.Record{
		UserID:            uuid.NullUUID{UUID: u, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          sum[:],
		ReceivedAt:        h.now,
		SenderDomain:      domain,
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultNone,
		NormalizerVersion: 1,
		Tier:              diag.TierNone,
		BodySizeBucket:    1 << 10,
		StructureSig:      sampleSig(h.t, raw, h.now),
		Outcome:           diag.OutcomeAppended,
	}); err != nil {
		h.t.Fatal(err)
	}
	return hex.EncodeToString(sum[:])
}

// sampleSig is the layout fingerprint the server records at arrival, which is
// what the report path now stores — the client no longer computes one.
func sampleSig(t *testing.T, raw []byte, at time.Time) string {
	t.Helper()
	res, err := norm.Normalize(norm.CurrentVersion, raw, at)
	if err != nil {
		return ""
	}
	return diag.StructureSig(res.Text)
}

func (h *sampleHarness) rows() int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM donated_samples`).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

func TestSampleIntakeRequiresASession(t *testing.T) {
	h := newSampleHarness(t)
	for _, path := range []string{"/api/v1/samples/report", "/api/v1/samples/donate"} {
		rec := h.req(http.MethodPost, path, "", map[string]any{})
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("unauthenticated POST %s = %d, want 401", path, rec.Code)
		}
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d rows stored by unauthenticated calls", n)
	}
}

// ---------------------------------------------------------------------------
// The default, content-free path
// ---------------------------------------------------------------------------

func TestReportStoresTheFingerprintAndNothingElse(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	raw := sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	id := h.receive(u, raw, "testbank.test")

	rec := h.req(http.MethodPost, "/api/v1/samples/report", h.session(u), map[string]any{
		"ingest_id": id,
	})
	wantStatus(t, rec, http.StatusNoContent)

	var (
		stored   []byte
		consent  *string
		ingestID []byte
		domain   string
		sig      string
	)
	if err := h.pool.QueryRow(bg,
		`SELECT raw, consent, ingest_id, sender_domain, structure_sig FROM donated_samples`).
		Scan(&stored, &consent, &ingestID, &domain, &sig); err != nil {
		t.Fatal(err)
	}
	if stored != nil || consent != nil {
		t.Fatalf("the default path stored a body (%d bytes) or a consent record (%v)", len(stored), consent)
	}
	// The ingest id is a LOOKUP KEY on this route and is not part of the row: a
	// report carries no provenance because it carries no content.
	if ingestID != nil {
		t.Fatalf("the default path stored the ingest id it was looked up by: %x", ingestID)
	}
	if domain != "testbank.test" || sig != sampleSig(t, raw, h.now) {
		t.Fatalf("stored (%q,%q), want the domain and fingerprint THIS SERVER recorded", domain, sig)
	}
}

// The request the old client sent — a bank name and a fingerprint it computed
// itself — is REFUSED, not quietly reinterpreted. A client that believes it is
// choosing the domain has to find out.
func TestReportRefusesTheOldCallerSuppliedShape(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	id := h.receive(u, sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	for name, body := range map[string]map[string]any{
		"a domain and a signature": {"sender_domain": "dib.ae", "structure_sig": strings.Repeat("ab", 16)},
		"an id and a domain":       {"ingest_id": id, "sender_domain": "dib.ae"},
	} {
		rec := h.req(http.MethodPost, "/api/v1/samples/report", h.session(u), body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("report with %s = %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d rows stored from a caller-supplied origin", n)
	}
}

// The report path answers the same way the donation path does about a message
// this account did not receive, and for the same reason.
func TestReportCannotReachAnotherAccountsMail(t *testing.T) {
	h := newSampleHarness(t)
	alice := h.user("alice")
	bob := h.user("bob")
	bobsID := h.receive(bob, sampleMail("You spent AED 9,912.45 at DR ALIA FERTILITY CLINIC on 12/03/2026"), "testbank.test")

	for _, id := range []string{bobsID, hex.EncodeToString(make([]byte, 32))} {
		rec := h.req(http.MethodPost, "/api/v1/samples/report", h.session(alice), map[string]any{
			"ingest_id": id,
		})
		if rec.Code != http.StatusNotFound {
			t.Errorf("reporting %s = %d, want 404: %s", id[:8], rec.Code, rec.Body.String())
		}
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d cross-account reports were stored", n)
	}
}

func TestReportRefusesMailWhoseOriginWasNeverVerified(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	id := h.receive(u, sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"),
		diag.UnverifiedPrefix+"testbank.test")
	rec := h.req(http.MethodPost, "/api/v1/samples/report", h.session(u), map[string]any{"ingest_id": id})
	if rec.Code != http.StatusConflict {
		t.Fatalf("reporting unverified mail = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d rows stored", n)
	}
}

// The request type is the guarantee: there is no field on /report capable of
// carrying content, so a client that tried to send one is refused rather than
// silently having it dropped.
func TestReportHasNoFieldThatCanCarryContent(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	id := h.receive(u, sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	rec := h.req(http.MethodPost, "/api/v1/samples/report", h.session(u), []byte(
		`{"ingest_id":"`+id+`","raw":"WW91IHNwZW50IEFFRCAyNTAuMDAgYXQgU1RBUkJVQ0tT"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a report carrying a body = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d rows stored", n)
	}
}

func TestReportRefusesAMalformedIngestID(t *testing.T) {
	h := newSampleHarness(t)
	session := h.session(h.user("alice"))
	for _, id := range []string{"", "not-hex", strings.Repeat("ab", 16), strings.Repeat("AB", 32)} {
		rec := h.req(http.MethodPost, "/api/v1/samples/report", session, map[string]any{"ingest_id": id})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("report with ingest_id %q = %d, want 400: %s", id, rec.Code, rec.Body.String())
		}
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d malformed reports were stored", n)
	}
}

// A message no normalizer could read has no layout to cluster, so the default
// path has nothing to file — and the answer says which path does work.
func TestReportOfAMessageWithNoRecordedLayoutIsAConflict(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	sum := sha256.Sum256([]byte("a message with no text part"))
	if err := h.d.Record(bg, diag.Record{
		UserID:            uuid.NullUUID{UUID: u, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          sum[:],
		ReceivedAt:        h.now,
		SenderDomain:      "testbank.test",
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultNone,
		NormalizerVersion: 1,
		Tier:              diag.TierNone,
		BodySizeBucket:    1 << 10,
		Outcome:           diag.OutcomeRejected,
		RejectReason:      diag.RejectNoTextPart,
	}); err != nil {
		t.Fatal(err)
	}
	rec := h.req(http.MethodPost, "/api/v1/samples/report", h.session(u), map[string]any{
		"ingest_id": hex.EncodeToString(sum[:]),
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("reporting an unnormalizable message = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "donating") {
		t.Fatalf("the refusal does not name the path that does work: %s", rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// The opt-in path
// ---------------------------------------------------------------------------

func TestDonateStoresTheUsersOwnMessage(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	raw := sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	id := h.receive(u, raw, "testbank.test")

	rec := h.req(http.MethodPost, "/api/v1/samples/donate", h.session(u), map[string]any{
		"ingest_id": id, "consent": "donate-sample-v1",
	})
	wantStatus(t, rec, http.StatusNoContent)

	got, err := h.srv.Samples.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || string(got[0].Raw) != string(raw) {
		t.Fatalf("the donated corpus does not hold the message the user received (%d rows)", len(got))
	}
	if got[0].Consent != "donate-sample-v1" {
		t.Fatalf("consent = %q", got[0].Consent)
	}
}

func TestDonateRequiresConsent(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	id := h.receive(u, sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	for _, consent := range []string{"", "I said yes on the phone", "donate-sample-v2"} {
		rec := h.req(http.MethodPost, "/api/v1/samples/donate", h.session(u), map[string]any{
			"ingest_id": id, "consent": consent,
		})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("donate with consent %q = %d, want 400: %s", consent, rec.Code, rec.Body.String())
		}
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d consentless donations were stored", n)
	}
}

// The endpoint takes an id, not a body, so the only thing a caller can donate
// is mail this server already delivered to them. Another account's id is a 404,
// and so is an id nobody ever received — the same answer, because a response
// that distinguished them would confirm another account's message exists.
func TestDonateCannotReachAnotherAccountsMail(t *testing.T) {
	h := newSampleHarness(t)
	alice := h.user("alice")
	bob := h.user("bob")
	bobsID := h.receive(bob, sampleMail("You spent AED 9,912.45 at DR ALIA FERTILITY CLINIC on 12/03/2026"), "testbank.test")
	invented := hex.EncodeToString(make([]byte, 32))

	for _, id := range []string{bobsID, invented} {
		rec := h.req(http.MethodPost, "/api/v1/samples/donate", h.session(alice), map[string]any{
			"ingest_id": id, "consent": "donate-sample-v1",
		})
		if rec.Code != http.StatusNotFound {
			t.Errorf("donating %s = %d, want 404: %s", id[:8], rec.Code, rec.Body.String())
		}
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d cross-account donations were stored", n)
	}
}

func TestDonateRefusesAMalformedIngestID(t *testing.T) {
	h := newSampleHarness(t)
	session := h.session(h.user("alice"))
	for _, id := range []string{"", "not-hex", strings.Repeat("ab", 16)} {
		rec := h.req(http.MethodPost, "/api/v1/samples/donate", session, map[string]any{
			"ingest_id": id, "consent": "donate-sample-v1",
		})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("ingest_id %q = %d, want 400", id, rec.Code)
		}
	}
}

func TestDonateRefusesMailWhoseOriginWasNeverVerified(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	id := h.receive(u, sampleMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"),
		diag.UnverifiedPrefix+"testbank.test")

	rec := h.req(http.MethodPost, "/api/v1/samples/donate", h.session(u), map[string]any{
		"ingest_id": id, "consent": "donate-sample-v1",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("donating unverified mail = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if n := h.rows(); n != 0 {
		t.Fatalf("%d rows stored", n)
	}
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// One budget across both routes: a caller who can spend an unlimited number of
// the cheap calls is not meaningfully limited on the expensive one, and the
// expensive one scans the whole cold stream.
func TestSampleIntakeSharesOneBudgetAcrossBothRoutes(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	session := h.session(u)
	// Rate 0 means burst-only: the budget is exactly two calls and never
	// refills, so the test does not depend on the wall clock.
	h.srv.SamplesPerUser = NewLimiter(0, 2, 16, func() time.Time { return h.now })

	for i := 0; i < 2; i++ {
		id := h.receive(u, sampleMail(fmt.Sprintf("You spent AED %d.00 at STARBUCKS on 01/01/2026", i+1)),
			fmt.Sprintf("bank%d.test", i))
		rec := h.req(http.MethodPost, "/api/v1/samples/report", session, map[string]any{"ingest_id": id})
		wantStatus(t, rec, http.StatusNoContent)
	}
	rec := h.req(http.MethodPost, "/api/v1/samples/donate", session, map[string]any{
		"ingest_id": hex.EncodeToString(make([]byte, 32)), "consent": "donate-sample-v1",
	})
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("the donation route = %d after the report route spent the budget, want 429", rec.Code)
	}
	// A different user is unaffected: the budget is per caller, not global.
	bob := h.user("bob")
	other := h.session(bob)
	bobsID := h.receive(bob, sampleMail("You spent AED 7.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	if rec := h.req(http.MethodPost, "/api/v1/samples/report", other, map[string]any{
		"ingest_id": bobsID,
	}); rec.Code != http.StatusNoContent {
		t.Fatalf("a second user = %d; one user drained a shared budget", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// The read side does not exist
// ---------------------------------------------------------------------------

// The public API can CONTRIBUTE to the corpus and can never read it back — not
// its own user's donations, not anybody's. This is the mirror image of the
// dictionary, where only the read side is public, and it is asserted against
// the router rather than trusted to the reviewer's memory.
func TestNoPublicRouteReadsTheDonatedCorpus(t *testing.T) {
	h := newSampleHarness(t)
	u := h.user("alice")
	session := h.session(u)
	raw := sampleMail("You spent AED 250.00 at STARBUCKS DIFC on 01/01/2026")
	id := h.receive(u, raw, "testbank.test")
	wantStatus(t, h.req(http.MethodPost, "/api/v1/samples/donate", session, map[string]any{
		"ingest_id": id, "consent": "donate-sample-v1",
	}), http.StatusNoContent)

	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/samples"},
		{http.MethodGet, "/api/v1/samples/"},
		{http.MethodGet, "/api/v1/samples/report"},
		{http.MethodGet, "/api/v1/samples/donate"},
		{http.MethodGet, "/api/v1/samples/clusters"},
		{http.MethodGet, "/api/v1/samples/" + id},
	} {
		rec := h.req(probe.method, probe.path, session, nil)
		if rec.Code == http.StatusOK {
			t.Errorf("%s %s answered 200; the public API has a read side it must not have",
				probe.method, probe.path)
		}
		if strings.Contains(rec.Body.String(), "STARBUCKS") {
			t.Errorf("%s %s returned donated content: %s", probe.method, probe.path, rec.Body.String())
		}
	}
}
