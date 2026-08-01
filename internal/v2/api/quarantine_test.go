package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/quarantine"
)

// qHarness extends the shared harness with a quarantine store on a frozen
// clock. It builds its own handler because the routes are only mounted once
// Server.Quarantine is set.
type qHarness struct {
	*harness
	q   *quarantine.Store
	now time.Time
}

func newQHarness(t *testing.T) *qHarness {
	t.Helper()
	h := newHarness(t)
	qh := &qHarness{harness: h, now: time.Now().UTC().Truncate(time.Microsecond)}
	qh.q = &quarantine.Store{
		Pool:       h.pool,
		TTL:        quarantine.DefaultTTL,
		WarnBefore: quarantine.DefaultWarnBefore,
		Now:        func() time.Time { return qh.now },
	}
	h.srv.Quarantine = qh.q
	h.h = h.srv.Handler()
	return qh
}

func (h *qHarness) hold(t *testing.T, u uuid.UUID, seed string, mut func(*quarantine.Item)) quarantine.Item {
	t.Helper()
	sum := sha256.Sum256([]byte(seed))
	it := quarantine.Item{
		UserID:     u,
		IngestID:   sum[:],
		ReceivedAt: h.now,
		// A distinctive envelope sender on every fixture: it is stored (Task
		// 30 needs it to re-resolve the origin) and must never be rendered,
		// because it is text the sender wrote.
		EnvelopeFrom: "<bounce+ENVELOPEMARKER@relay.test>",
		OuterDomain:  "dib.ae",
		DKIM:         quarantine.ResultPass,
		ARC:          quarantine.ResultNone,
		Blob:         []byte("From: alerts@dib.ae\r\nSubject: AED 250.00 at CARREFOUR\r\n\r\nbody " + seed),
	}
	if mut != nil {
		mut(&it)
	}
	if err := h.q.Hold(bg, it); err != nil {
		t.Fatalf("hold: %v", err)
	}
	return it
}

func (h *qHarness) list(t *testing.T, session, query string) QuarantineResponse {
	t.Helper()
	rec := h.req(http.MethodGet, "/api/v1/quarantine"+query, session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/quarantine%s: %d %s", query, rec.Code, rec.Body.String())
	}
	return decodeJSON[QuarantineResponse](t, rec)
}

// ---------------------------------------------------------------------------

// TestQuarantineListSurfacesAttestationStateRatherThanContent is §3.2:55: the
// "trust this sender" sheet must decide from a verified signing domain or a
// prominent unauthenticated state, never from what the message says about
// itself. The held fixture's own subject carries an amount and a merchant, so a
// response that leaked any part of the message would be visible here.
func TestQuarantineListSurfacesAttestationStateRatherThanContent(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)

	rec := h.req(http.MethodGet, "/api/v1/quarantine", session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, leaked := range []string{"CARREFOUR", "250.00", "Subject", "subject", "body", "From:",
		"ENVELOPEMARKER", "envelope_from"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("the default listing carries message content (%q): %s", leaked, body)
		}
	}

	var raw struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Items) != 1 {
		t.Fatalf("%d items", len(raw.Items))
	}
	for _, k := range []string{"attested", "attested_by", "dkim", "arc", "outer_domain", "inner_domain"} {
		if _, ok := raw.Items[0][k]; !ok {
			t.Fatalf("the sheet cannot render an origin without %q: %v", k, raw.Items[0])
		}
	}
	if _, ok := raw.Items[0]["blob"]; ok {
		t.Fatal("the default listing must not carry the raw message")
	}
}

func TestQuarantineListReportsAnUnauthenticatedOriginAsSuch(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", func(it *quarantine.Item) {
		it.OuterDomain = quarantine.UnverifiedPrefix + "example.test"
		it.DKIM = quarantine.ResultNone
	})

	got := h.list(t, session, "")
	if len(got.Items) != 1 {
		t.Fatalf("%d items", len(got.Items))
	}
	switch {
	case got.Items[0].Attested:
		t.Fatal("an unsigned message must never read as attested")
	case !strings.HasPrefix(got.Items[0].OuterDomain, quarantine.UnverifiedPrefix):
		t.Fatalf("the unverified marker was dropped: %q", got.Items[0].OuterDomain)
	case got.Items[0].DKIM != quarantine.ResultNone:
		t.Fatalf("dkim %q", got.Items[0].DKIM)
	}
}

// TestQuarantineIncludeBlobReturnsTheRawMessage covers the one Phase 1 flow
// that needs the body: Gmail's forward-verification mail quarantines like
// anything else, and onboarding reads the confirmation link out of it
// (§3.2:47).
func TestQuarantineIncludeBlobReturnsTheRawMessage(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	it := h.hold(t, u, "a", nil)

	got := h.list(t, session, "?include_blob=1")
	if len(got.Items) != 1 || got.Items[0].Blob == "" {
		t.Fatalf("include_blob=1 returned no message: %+v", got.Items)
	}
	raw, err := base64.StdEncoding.DecodeString(got.Items[0].Blob)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(it.Blob) {
		t.Fatal("the returned message is not the one that was held")
	}
	if got.Items[0].IngestID != hex.EncodeToString(it.IngestID) {
		t.Fatalf("ingest_id %q", got.Items[0].IngestID)
	}
}

func TestQuarantineIsScopedToTheSession(t *testing.T) {
	h := newQHarness(t)
	a, b := h.user("alice"), h.user("bob")
	h.hold(t, a, "a", nil)
	h.hold(t, b, "b", nil)

	if got := h.list(t, h.session(a), ""); len(got.Items) != 1 {
		t.Fatalf("alice sees %d items", len(got.Items))
	}
	if got := h.list(t, h.session(b), "?include_blob=1"); len(got.Items) != 1 {
		t.Fatalf("bob sees %d items", len(got.Items))
	}
}

func TestQuarantineRoutesRequireASession(t *testing.T) {
	h := newQHarness(t)
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/v1/quarantine", nil},
		{http.MethodPost, "/api/v1/quarantine/confirm", ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"}},
		{http.MethodGet, "/api/v1/quarantine/allowlist", nil},
		{http.MethodDelete, "/api/v1/quarantine/allowlist", RevokeSenderRequest{Domain: "dib.ae", Scope: "outer"}},
	} {
		if rec := h.req(c.method, c.path, "", c.body); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a session: %d", c.method, c.path, rec.Code)
		}
	}
}

// TestTheExpiryWarningIsVisibleToTheClient is the client-facing half of spec
// §2's drop policy. The warning is worth nothing if the only thing that can see
// it is the database.
func TestTheExpiryWarningIsVisibleToTheClient(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)

	// Before the window opens: action needed, but no deadline yet.
	got := h.list(t, session, "")
	switch {
	case got.ActionNeeded != 1:
		t.Fatalf("action_needed = %d, want 1: a quarantined arrival is a decision the user has not made", got.ActionNeeded)
	case got.ExpiringSoon != 0:
		t.Fatalf("expiring_soon = %d before the warning window", got.ExpiringSoon)
	case got.Items[0].WarnedAt != nil || got.Items[0].DeleteAfter != nil:
		t.Fatalf("warned before the window opened: %+v", got.Items[0])
	}

	h.now = h.now.Add(23 * 24 * time.Hour)
	if _, _, err := h.q.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}

	got = h.list(t, session, "")
	switch {
	case got.ExpiringSoon != 1:
		t.Fatalf("expiring_soon = %d after the warning", got.ExpiringSoon)
	case got.Items[0].WarnedAt == nil:
		t.Fatal("the client cannot see that the item was warned")
	case got.Items[0].DeleteAfter == nil:
		t.Fatal("the client is warned but not told when the deletion happens")
	case !got.Items[0].DeleteAfter.Equal(got.Items[0].ExpiresAt):
		t.Fatalf("delete_after %s does not match the stated expiry %s",
			got.Items[0].DeleteAfter, got.Items[0].ExpiresAt)
	}
}

// TestExpiredMailIsAccountedForAfterItIsGone: the message is deleted, and the
// user can still find out that it existed and what happened to it.
func TestExpiredMailIsAccountedForAfterItIsGone(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	it := h.hold(t, u, "a", nil)

	h.now = h.now.Add(23 * 24 * time.Hour)
	if _, _, err := h.q.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(8 * 24 * time.Hour)
	if _, deleted, err := h.q.ExpireDue(bg); err != nil || deleted != 1 {
		t.Fatalf("deleted=%d err=%v", deleted, err)
	}

	got := h.list(t, session, "")
	if len(got.Items) != 0 {
		t.Fatalf("%d items still held", len(got.Items))
	}
	if len(got.Removed) != 1 {
		t.Fatalf("%d removal records: an expiry the client cannot see is a silent drop", len(got.Removed))
	}
	rem := got.Removed[0]
	switch {
	case rem.IngestID != hex.EncodeToString(it.IngestID):
		t.Fatalf("the record names %q, not the message that expired", rem.IngestID)
	case rem.Reason != quarantine.ReasonExpired:
		t.Fatalf("reason %q", rem.Reason)
	case rem.WarnedAt == nil:
		t.Fatal("the record cannot show the user was warned first")
	case rem.OuterDomain != "dib.ae":
		t.Fatalf("outer domain %q", rem.OuterDomain)
	}
	if got.ActionNeeded != 0 {
		t.Fatalf("action_needed = %d with nothing held", got.ActionNeeded)
	}
}

func TestQuarantineCursorRoundTripsWithoutDroppingItems(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	const n = 5
	for i := 0; i < n; i++ {
		h.hold(t, u, string(rune('a'+i)), nil)
	}

	seen := map[string]bool{}
	query := "?limit=2"
	for page := 0; page < 10; page++ {
		got := h.list(t, session, query)
		for _, it := range got.Items {
			seen[it.IngestID] = true
		}
		if got.Complete {
			break
		}
		query = "?limit=2&after=" + got.Next + "&after_id=" + got.NextID
	}
	if len(seen) != n {
		t.Fatalf("paging saw %d of %d items", len(seen), n)
	}
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

func TestConfirmSenderReturnsTheHeldIngestIDs(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	a := h.hold(t, u, "a", nil)
	b := h.hold(t, u, "b", nil)

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ConfirmSenderResponse](t, rec)
	want := map[string]bool{hex.EncodeToString(a.IngestID): true, hex.EncodeToString(b.IngestID): true}
	if len(out.IngestIDs) != 2 {
		t.Fatalf("%d ingest ids, want 2", len(out.IngestIDs))
	}
	for _, id := range out.IngestIDs {
		if !want[id] {
			t.Fatalf("unexpected ingest id %q", id)
		}
	}
	ok, err := h.q.Allowlisted(bg, u, "dib.ae", quarantine.ScopeOuter)
	if err != nil || !ok {
		t.Fatalf("the origin was not allowlisted: %v %v", ok, err)
	}
}

// TestConfirmSenderRefusesAForwarderAsOuter: §3.2:51. The answer must also tell
// the user what to do instead, or the flow dead-ends on the exact screen where
// they are trying to trust their bank.
func TestConfirmSenderRefusesAForwarderAsOuter(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", func(it *quarantine.Item) {
		it.OuterDomain = "gmail.com"
		it.InnerDomain = "dib.ae"
		it.Attested = true
		it.AttestedBy = quarantine.AttestedByDirectDKIM
	})

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "gmail.com", Scope: "outer"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("allowlisting a forwarder as an outer origin answered %d: %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[errorBody](t, rec)
	if out.Error != "forwarder_domain" {
		t.Fatalf("error code %q", out.Error)
	}
	if !strings.Contains(out.Detail, "inner") {
		t.Fatalf("the refusal must point at the inner origin instead: %q", out.Detail)
	}

	// And the route it points at works.
	rec = h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "inner"})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirming the attested inner origin: %d %s", rec.Code, rec.Body.String())
	}
}

func TestConfirmSenderRefusesAnOriginNothingHeldProves(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", func(it *quarantine.Item) {
		it.OuterDomain = quarantine.UnverifiedPrefix + "dib.ae"
		it.DKIM = quarantine.ResultNone
	})

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("§3.2:54 requires a verified signature; answered %d: %s", rec.Code, rec.Body.String())
	}
	if out := decodeJSON[errorBody](t, rec); out.Error != "origin_unproven" {
		t.Fatalf("error code %q", out.Error)
	}
}

func TestConfirmSenderRejectsMalformedInput(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)

	for _, c := range []ConfirmSenderRequest{
		{Domain: "dib.ae", Scope: "either"},
		{Domain: "not a hostname", Scope: "outer"},
		{Domain: quarantine.UnverifiedPrefix + "dib.ae", Scope: "outer"},
		{Domain: "", Scope: "outer"},
	} {
		rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session, c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%+v answered %d: %s", c, rec.Code, rec.Body.String())
		}
	}
}

func TestConfirmSenderCannotReachAnotherAccount(t *testing.T) {
	h := newQHarness(t)
	a, b := h.user("alice"), h.user("bob")
	h.hold(t, b, "b", nil)

	// Alice holds nothing from dib.ae; bob does. Alice's confirmation must not
	// see bob's message, and must not allowlist anything for either of them.
	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", h.session(a),
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if ok, _ := h.q.Allowlisted(bg, a, "dib.ae", quarantine.ScopeOuter); ok {
		t.Fatal("alice allowlisted an origin she has never been shown")
	}
	if ok, _ := h.q.Allowlisted(bg, b, "dib.ae", quarantine.ScopeOuter); ok {
		t.Fatal("alice's request wrote into bob's allowlist")
	}
}

// TestQuarantineBlobPageIsBoundedByBytesNotRows: a held message can be a
// megabyte, so the row limit alone is not a bound on the response. The page
// must end short — and, critically, resume from where it stopped rather than
// from where the row limit would have stopped, or the truncation itself drops
// mail.
func TestQuarantineBlobPageIsBoundedByBytesNotRows(t *testing.T) {
	h := newQHarness(t)
	h.srv.QuarantineByteBudget = 512 // bytes: two of the fixtures below, not three
	h.h = h.srv.Handler()
	u := h.user("alice")
	session := h.session(u)
	const n = 3
	for i := 0; i < n; i++ {
		h.hold(t, u, string(rune('a'+i)), func(it *quarantine.Item) {
			it.Blob = []byte(strings.Repeat("x", 300))
		})
	}

	seen := map[string]bool{}
	query := "?include_blob=1&limit=10"
	for page := 0; page < 10; page++ {
		got := h.list(t, session, query)
		if len(got.Items) == 0 {
			t.Fatal("a byte-truncated page must still carry at least one item, or the client cannot advance")
		}
		if page == 0 && got.Complete {
			t.Fatalf("the first page reported complete while carrying %d of %d items", len(got.Items), n)
		}
		for _, it := range got.Items {
			seen[it.IngestID] = true
		}
		if got.Complete {
			break
		}
		query = "?include_blob=1&limit=10&after=" + got.Next + "&after_id=" + got.NextID
	}
	if len(seen) != n {
		t.Fatalf("byte-bounded paging saw %d of %d items", len(seen), n)
	}
}

// ---------------------------------------------------------------------------
// Confirmation re-ingests what it releases
// ---------------------------------------------------------------------------

// fakeReprocessor records what it was asked to re-ingest.
type fakeReprocessor struct {
	calls [][][]byte
	rep   Report
	err   error
}

func (f *fakeReprocessor) Reprocess(_ context.Context, _ uuid.UUID, ids [][]byte) (Report, error) {
	f.calls = append(f.calls, ids)
	rep := f.rep
	rep.Examined = len(ids)
	return rep, f.err
}

// TestConfirmSenderReIngestsTheMailItReleases is the seam spec §3.2:58 needs
// and the one Task 38 step 7 found missing.
//
// Confirming a sender is the ONLY way held mail ever enters the integrity
// chains. A confirmation that merely allowlisted the domain and reported the
// eligible ids left the mail the user had just vouched for sitting in
// quarantine until it EXPIRED — a drop, announced but a drop — for every client
// that did not know to make a second call nothing in the API described.
func TestConfirmSenderReIngestsTheMailItReleases(t *testing.T) {
	h := newQHarness(t)
	fake := &fakeReprocessor{rep: Report{Appended: 2}}
	h.srv.Reprocessor = fake
	h.h = h.srv.Handler()
	u := h.user("alice")
	session := h.session(u)
	a := h.hold(t, u, "a", nil)
	b := h.hold(t, u, "b", nil)

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ConfirmSenderResponse](t, rec)
	if out.Reingest == nil {
		t.Fatal("confirming a sender must report what it re-ingested")
	}
	if out.Reingest.Appended != 2 || out.Reingest.Examined != 2 {
		t.Fatalf("reingest report = %+v", out.Reingest)
	}
	if out.Reingest.Remaining != 0 {
		t.Fatalf("nothing was left over, but remaining = %d", out.Reingest.Remaining)
	}
	if len(fake.calls) != 1 {
		t.Fatalf("%d reprocess calls, want 1", len(fake.calls))
	}
	got := map[string]bool{}
	for _, id := range fake.calls[0] {
		got[hex.EncodeToString(id)] = true
	}
	for _, want := range []quarantine.Item{a, b} {
		if !got[hex.EncodeToString(want.IngestID)] {
			t.Fatalf("the re-ingest was not asked about %x", want.IngestID)
		}
	}
}

// A deployment with no reprocessor configured must still confirm. The field is
// nil in every unit test in this package and in any build where server-side
// reprocessing is off; a 500 there would make the sender-trust flow depend on a
// Phase-1-only component.
func TestConfirmSenderWithoutAReprocessorStillAllowlists(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if out := decodeJSON[ConfirmSenderResponse](t, rec); out.Reingest != nil {
		t.Fatalf("no reprocessor is configured, so nothing was re-ingested: %+v", out.Reingest)
	}
	ok, err := h.q.Allowlisted(bg, u, "dib.ae", quarantine.ScopeOuter)
	if err != nil || !ok {
		t.Fatalf("the origin was not allowlisted: %v %v", ok, err)
	}
}

// A re-ingest that fails is not a failed confirmation. The allowlist row is
// committed and the mail is still held, so the honest answer is 200 with the
// partial counts and `incomplete` set — never a 500 that tells the user their
// bank was not trusted when it was.
func TestConfirmSenderReportsAPartialReIngestRatherThanFailing(t *testing.T) {
	h := newQHarness(t)
	h.srv.Reprocessor = &fakeReprocessor{rep: Report{Appended: 1}, err: errors.New("cold stream unreadable")}
	h.h = h.srv.Handler()
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("a failed re-ingest must not undo a successful confirmation: %d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ConfirmSenderResponse](t, rec)
	if out.Reingest == nil || !out.Reingest.Incomplete {
		t.Fatalf("the failure must be visible in the response: %+v", out.Reingest)
	}
	if out.Reingest.Appended != 1 {
		t.Fatalf("the partial counts must survive: %+v", out.Reingest)
	}
}

// The batch is bounded, and what did not fit is REPORTED. ingest.Reprocess
// refuses more than 500 ids outright, so an unbounded call would fail entirely
// on an account with a big backlog; silently truncating instead would strand
// the remainder with nothing anywhere saying so.
func TestConfirmSenderBoundsOneReIngestAndReportsTheRemainder(t *testing.T) {
	h := newQHarness(t)
	fake := &fakeReprocessor{}
	h.srv.Reprocessor = fake
	h.srv.MaxReingestPerConfirm = 2
	h.h = h.srv.Handler()
	u := h.user("alice")
	session := h.session(u)
	for i := 0; i < 5; i++ {
		h.hold(t, u, string(rune('a'+i)), nil)
	}

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ConfirmSenderResponse](t, rec)
	if len(fake.calls) != 1 || len(fake.calls[0]) != 2 {
		t.Fatalf("one bounded batch expected, got %v", fake.calls)
	}
	if out.Reingest == nil || out.Reingest.Remaining != 3 {
		t.Fatalf("the remainder must be reported so the caller knows to confirm again: %+v", out.Reingest)
	}
}

// ---------------------------------------------------------------------------
// Confirming again, after the mail it released is already in the log
// ---------------------------------------------------------------------------

// TestConfirmingATrustedOriginAgainIsNotAConflict. Confirming re-ingests what
// it releases, and a promoted message is no longer held — so the SECOND
// confirmation of the same origin finds nothing held and used to be answered
// `409 origin_unproven`: "no message held for this account carries a verified
// signature from that origin… Mail that cannot be verified stays quarantined."
// About an origin that is on the account's allowlist. On the one step spec
// §3.2 calls out as onboarding, reachable by a double-tap, a retry after a lost
// response, or one more pass of the `remaining > 0` loop this API documents.
func TestConfirmingATrustedOriginAgainIsNotAConflict(t *testing.T) {
	h := newQHarness(t)
	fake := &fakeReprocessor{rep: Report{Appended: 1}}
	h.srv.Reprocessor = fake
	h.h = h.srv.Handler()
	u := h.user("alice")
	session := h.session(u)
	it := h.hold(t, u, "a", nil)

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("first confirmation: %d %s", rec.Code, rec.Body.String())
	}
	// What Task 30's re-ingest does with the ids it was handed.
	if _, err := h.q.Promote(bg, u, [][]byte{it.IngestID}); err != nil {
		t.Fatal(err)
	}

	rec = h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("re-confirming a trusted origin: %d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[ConfirmSenderResponse](t, rec)
	if len(out.IngestIDs) != 0 {
		t.Fatalf("nothing is held, so nothing is released: %v", out.IngestIDs)
	}
	if out.Reingest == nil || out.Reingest.Report != (Report{}) {
		t.Fatalf("an empty release re-ingests nothing: %+v", out.Reingest)
	}
	if len(fake.calls) != 1 {
		t.Fatalf("the second confirmation re-ingested %d batches, want 0 after the first", len(fake.calls)-1)
	}
	// An origin this account has never proven is still refused.
	rec = h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "never-seen.example", Scope: "outer"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("an unproven origin must still be refused: %d %s", rec.Code, rec.Body.String())
	}
}

// TestConfirmSenderEchoesTheDomainItStored. The row is lower-cased; echoing the
// caller's own spelling invites a client to build its next request — and its
// local list of trusted senders — from a string this server would not match.
func TestConfirmSenderEchoesTheDomainItStored(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)

	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "  DIB.AE  ", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if out := decodeJSON[ConfirmSenderResponse](t, rec); out.Domain != "dib.ae" {
		t.Fatalf("the response echoes %q while the row says %q", out.Domain, "dib.ae")
	}
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

// TestTrustCanBeWithdrawn. Confirming is one tap and the hostname grammar
// admits lookalikes — dib-alerts.ae, or a punycode A-label that renders as the
// bank's own name. Until this route existed nothing in the tree deleted a
// sender_allowlist row except deleting the account.
func TestTrustCanBeWithdrawn(t *testing.T) {
	h := newQHarness(t)
	u := h.user("alice")
	session := h.session(u)
	h.hold(t, u, "a", nil)
	rec := h.req(http.MethodPost, "/api/v1/quarantine/confirm", session,
		ConfirmSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", rec.Code, rec.Body.String())
	}

	// It is listed, which is what makes it revocable: the delete needs a pair
	// the user has no other way to recover.
	rec = h.req(http.MethodGet, "/api/v1/quarantine/allowlist", session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	listed := decodeJSON[AllowlistResponse](t, rec)
	if len(listed.Entries) != 1 || listed.Entries[0].Domain != "dib.ae" || listed.Entries[0].Scope != "outer" {
		t.Fatalf("the allowlist listing does not describe what was confirmed: %+v", listed)
	}

	rec = h.req(http.MethodDelete, "/api/v1/quarantine/allowlist", session,
		RevokeSenderRequest{Domain: "DIB.AE", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	out := decodeJSON[RevokeSenderResponse](t, rec)
	if !out.Revoked || out.Domain != "dib.ae" {
		t.Fatalf("revoke reported %+v", out)
	}
	if ok, err := h.q.Allowlisted(bg, u, "dib.ae", quarantine.ScopeOuter); err != nil || ok {
		t.Fatalf("the origin is still trusted (ok=%v err=%v)", ok, err)
	}

	// Idempotent: revoking again is a fact, not an error.
	rec = h.req(http.MethodDelete, "/api/v1/quarantine/allowlist", session,
		RevokeSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("second revoke: %d %s", rec.Code, rec.Body.String())
	}
	if decodeJSON[RevokeSenderResponse](t, rec).Revoked {
		t.Fatal("the second revocation claimed to remove a row that was already gone")
	}

	rec = h.req(http.MethodGet, "/api/v1/quarantine/allowlist", session, nil)
	if got := decodeJSON[AllowlistResponse](t, rec); len(got.Entries) != 0 {
		t.Fatalf("the revoked entry is still listed: %+v", got)
	}
}

// TestRevocationCannotReachAnotherAccount. Same rule as every other route here:
// the user id comes from the session and never from the request.
func TestRevocationCannotReachAnotherAccount(t *testing.T) {
	h := newQHarness(t)
	a, b := h.user("alice"), h.user("bob")
	h.hold(t, b, "b", nil)
	if _, err := h.q.Confirm(bg, b, "dib.ae", quarantine.ScopeOuter); err != nil {
		t.Fatal(err)
	}

	rec := h.req(http.MethodDelete, "/api/v1/quarantine/allowlist", h.session(a),
		RevokeSenderRequest{Domain: "dib.ae", Scope: "outer"})
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if decodeJSON[RevokeSenderResponse](t, rec).Revoked {
		t.Fatal("one account's revocation removed another account's entry")
	}
	if ok, _ := h.q.Allowlisted(bg, b, "dib.ae", quarantine.ScopeOuter); !ok {
		t.Fatal("the other account's origin was untrusted by a stranger")
	}
	// And the listing shows the caller's own account, not the one with entries.
	rec = h.req(http.MethodGet, "/api/v1/quarantine/allowlist", h.session(a), nil)
	if got := decodeJSON[AllowlistResponse](t, rec); len(got.Entries) != 0 {
		t.Fatalf("one account's listing carries another's entries: %+v", got)
	}
}

func TestRevokeRejectsMalformedInput(t *testing.T) {
	h := newQHarness(t)
	session := h.session(h.user("alice"))
	for _, c := range []RevokeSenderRequest{
		{Domain: "dib.ae", Scope: "either"},
		{Domain: "not a hostname", Scope: "outer"},
		{Domain: "", Scope: "outer"},
	} {
		rec := h.req(http.MethodDelete, "/api/v1/quarantine/allowlist", session, c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%+v answered %d %s", c, rec.Code, rec.Body.String())
		}
	}
}
