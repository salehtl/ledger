package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
