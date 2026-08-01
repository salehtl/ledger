package admin

// The template regression gate, driven end to end over the REAL donated-sample
// store (spec §3.5:115).
//
// admin_test.go tests this console against a scriptable fake, which is the
// right tool for "what happens when the corpus is unreachable" and the wrong
// tool for the claim that actually matters here: that a candidate template
// which stops parsing mail somebody really received cannot be published. That
// claim is about two packages agreeing — this console's replay and
// internal/v2/samples' corpus — over messages that went through consent,
// through the cold stream and through the normalizer. A fake asserts nothing
// about it.
//
// So this file donates real mail through samples.Samples, wires the console to
// it through the same adapter shape cmd/ledgerd uses, and drives the HTTP
// endpoints.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pgtest"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/samples"
	"ledger/internal/v2/tmpl"
)

// realSamples is the adapter between the two packages. It is the same
// conversion cmd/ledgerd makes in production, and cmd/ledgerd's
// TestTheSampleAdapterCarriesEveryField pins that one field for field — this
// package cannot import a main package to reuse it.
type realSamples struct{ s *samples.Samples }

func (r realSamples) ForSender(ctx context.Context, domain string) ([]Sample, error) {
	got, err := r.s.ForSender(ctx, domain)
	if err != nil {
		return nil, err
	}
	out := make([]Sample, 0, len(got))
	for _, s := range got {
		out = append(out, Sample{
			ID: s.ID, UserID: s.UserID, SenderDomain: s.SenderDomain,
			StructureSig: s.StructureSig, Raw: s.Raw, ReceivedAt: s.ReceivedAt,
		})
	}
	return out, nil
}

func (r realSamples) Clusters(ctx context.Context) ([]Cluster, error) {
	got, err := r.s.Clusters(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Cluster, 0, len(got))
	for _, c := range got {
		out = append(out, Cluster{
			SenderDomain: c.SenderDomain, StructureSig: c.StructureSig,
			UserCount: c.UserCount, SampleCount: c.SampleCount,
			DonatedCount: c.DonatedCount, FirstSeen: c.FirstSeen,
		})
	}
	return out, nil
}

func (r realSamples) Retire(ctx context.Context, id uuid.UUID) (bool, error) {
	return r.s.Retire(ctx, id)
}

type gate struct {
	*console
	store *samples.Samples
	app   *oplog.Appender
}

func newGate(t *testing.T) *gate {
	t.Helper()
	pool := pgtest.New(t)
	// Milliseconds: a cold record's received_at round-trips through
	// oplog.EncodeRawBody, which canonicalises to that resolution.
	now := time.Now().UTC().Truncate(time.Millisecond)
	store := &samples.Samples{Pool: pool, Now: func() time.Time { return now }}
	c := &console{
		t:         t,
		pool:      pool,
		templates: &tmpl.Store{Pool: pool, Now: func() time.Time { return now }},
		diag:      &diag.Diag{Pool: pool, Now: func() time.Time { return now }},
		waitlist:  &Waitlist{Pool: pool, Now: func() time.Time { return now }},
		now:       now,
	}
	h := &Handler{
		Templates:  c.templates,
		Diag:       c.diag,
		Quarantine: &quarantine.Store{Pool: pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore},
		Waitlist:   c.waitlist,
		Samples:    realSamples{s: store},
		Token:      testToken,
		Logf:       func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	c.h = mux
	return &gate{console: c, store: store, app: &oplog.Appender{Pool: pool}}
}

func (g *gate) user(sub string) uuid.UUID {
	g.t.Helper()
	u, err := auth.UpsertUser(bg, g.pool, auth.Identity{IdP: auth.IdPApple, Subject: sub})
	if err != nil {
		g.t.Fatal(err)
	}
	return u
}

// donateReal puts a message through the whole real path: it is appended to the
// user's cold stream, an arrival diagnostic records the verified origin, and
// the user donates it by ingest id under a recorded consent. Nothing here
// plants a row.
func (g *gate) donateReal(u uuid.UUID, raw []byte, domain string) {
	g.t.Helper()
	sum := sha256.Sum256(raw)
	cold, err := oplog.EncodeRawBody(oplog.RawBody{
		IngestID:   hex.EncodeToString(sum[:]),
		ReceivedAt: g.now,
		RawBase64:  base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		g.t.Fatal(err)
	}
	if _, err := g.app.AppendIngest(bg, u, []oplog.IngestBlob{
		{Stream: blob.StreamCold, Plaintext: cold, CreatedAt: g.now},
	}); err != nil {
		g.t.Fatal(err)
	}
	if err := g.diag.Record(bg, diag.Record{
		UserID:            uuid.NullUUID{UUID: u, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          sum[:],
		ReceivedAt:        g.now,
		SenderDomain:      domain,
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultNone,
		NormalizerVersion: 1,
		Tier:              diag.TierNone,
		BodySizeBucket:    1 << 10,
		Outcome:           diag.OutcomeAppended,
	}); err != nil {
		g.t.Fatal(err)
	}
	if err := g.store.Donate(bg, samples.Sample{
		UserID: u, IngestID: sum[:], Consent: "donate-sample-v1",
	}); err != nil {
		g.t.Fatal(err)
	}
}

// reportReal is donateReal's content-free twin: the message reaches the cold
// stream and leaves an arrival diagnostic, and the user files a STRUCTURAL
// REPORT of it by ingest id. Nothing here plants a row either — since
// 2026-08-01 samples.Report derives the bank and the layout fingerprint from
// this server's own arrival record and refuses a caller that names them, so a
// report can only exist for mail the account really received.
func (g *gate) reportReal(u uuid.UUID, raw []byte, domain string) {
	g.t.Helper()
	sum := sha256.Sum256(raw)
	cold, err := oplog.EncodeRawBody(oplog.RawBody{
		IngestID:   hex.EncodeToString(sum[:]),
		ReceivedAt: g.now,
		RawBase64:  base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		g.t.Fatal(err)
	}
	if _, err := g.app.AppendIngest(bg, u, []oplog.IngestBlob{
		{Stream: blob.StreamCold, Plaintext: cold, CreatedAt: g.now},
	}); err != nil {
		g.t.Fatal(err)
	}
	sig := ""
	if res, nerr := norm.Normalize(norm.CurrentVersion, raw, g.now); nerr == nil {
		sig = diag.StructureSig(res.Text)
	}
	if err := g.diag.Record(bg, diag.Record{
		UserID:            uuid.NullUUID{UUID: u, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          sum[:],
		ReceivedAt:        g.now,
		SenderDomain:      domain,
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultNone,
		NormalizerVersion: 1,
		Tier:              diag.TierNone,
		BodySizeBucket:    1 << 10,
		StructureSig:      sig,
		Outcome:           diag.OutcomeAppended,
	}); err != nil {
		g.t.Fatal(err)
	}
	if err := g.store.Report(bg, samples.Sample{UserID: u, IngestID: sum[:]}); err != nil {
		g.t.Fatal(err)
	}
}

func (g *gate) author(version int, pattern string) {
	g.t.Helper()
	g.authorDef(templateJSON(version, pattern))
}

func (g *gate) authorDef(raw []byte) {
	g.t.Helper()
	g.ok("POST", "/admin/templates", map[string]any{"definition": json.RawMessage(raw)})
}

// conflict posts and requires a 409, returning the decoded refusal.
func (g *gate) conflict(path string, body any) map[string]any {
	g.t.Helper()
	rec := g.do("POST", path, testToken, body)
	if rec.Code != http.StatusConflict {
		g.t.Fatalf("POST %s = %d, want 409: %s", path, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		g.t.Fatal(err)
	}
	return out
}

// fieldsIn flattens a [changes] / [gains] array into "sample -> fields".
func fieldsIn(t *testing.T, body map[string]any, key string) []string {
	t.Helper()
	entries, _ := body[key].([]any)
	var out []string
	for _, e := range entries {
		m, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("%s entry is not an object: %v", key, e)
		}
		if _, err := uuid.Parse(fmt.Sprint(m["sample_id"])); err != nil {
			t.Fatalf("%s entry does not identify a sample: %v", key, m)
		}
		fs, _ := m["fields"].([]any)
		for _, f := range fs {
			out = append(out, fmt.Sprint(f))
		}
	}
	slices.Sort(out)
	return out
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// The claim, in one test: a version that stops parsing real donated mail is
// refused, and nothing about the live set moves.
func TestTheGateRefusesATemplateThatBreaksRealDonatedMail(t *testing.T) {
	g := newGate(t)
	alice := g.user("alice")
	bob := g.user("bob")
	g.donateReal(alice, sampleSpent, "testbank.test")
	g.donateReal(bob, samplePurchase, "alerts.testbank.test") // a subdomain, which must still gate

	g.author(1, broadAmount)
	got := g.ok("POST", "/admin/templates/testbank.card/1/validate", nil)
	if got["samples"] != float64(2) || got["matched"] != float64(2) {
		t.Fatalf("validate over the real corpus = %v, want 2 samples / 2 matched", got)
	}
	if got = g.ok("POST", "/admin/templates/testbank.card/1/publish", nil); got["status"] != tmpl.StatusPublished {
		t.Fatalf("publish = %v", got)
	}

	// v2 narrows the amount pattern so the "Purchase of" message no longer
	// extracts. That is a regression against one real donated message.
	g.author(2, narrowAmount)
	rec := g.do("POST", "/admin/templates/testbank.card/2/publish", testToken, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("publishing a breaking template = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	regs, _ := body["regressions"].([]any)
	if len(regs) != 1 {
		t.Fatalf("regressions = %v, want exactly the one donated message that broke", body)
	}
	// The refusal names WHICH sample, by id, so the operator can look at the
	// donation rather than guess.
	reg := regs[0].(map[string]any)
	if _, err := uuid.Parse(reg["sample_id"].(string)); err != nil {
		t.Fatalf("the regression does not identify a sample: %v", reg)
	}
	if reg["matched"] != false {
		t.Fatalf("a regression is reported as matching: %v", reg)
	}

	// Nothing moved: v1 is still live, v2 is still a draft.
	live, err := g.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Version != 1 {
		t.Fatalf("the live set changed after a refused publish: %+v", live)
	}
	r2, err := g.templates.Get(bg, "testbank.card", 2)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Status != tmpl.StatusDraft {
		t.Fatalf("the refused candidate is now %q", r2.Status)
	}
}

// The other half, and the half that decides whether the gate is usable: a
// version that FIXES a message the live one could not parse, while still
// parsing everything the live one did, must go through. A gate that demanded
// 100% would refuse this and be switched off within a week.
func TestTheGatePassesATemplateThatFixesASampleWithoutBreakingOthers(t *testing.T) {
	g := newGate(t)
	alice := g.user("alice")
	bob := g.user("bob")
	g.donateReal(alice, sampleSpent, "testbank.test")
	g.donateReal(bob, samplePurchase, "testbank.test")

	// v1 parses only the "spent" message; the "Purchase of" one is broken mail
	// as far as the live parser is concerned.
	g.author(1, narrowAmount)
	got := g.ok("POST", "/admin/templates/testbank.card/1/publish", nil)
	if got["matched"] != float64(1) {
		t.Fatalf("v1 matched %v of the donated corpus, want 1", got["matched"])
	}

	g.author(2, broadAmount)
	got = g.ok("POST", "/admin/templates/testbank.card/2/validate", nil)
	if got["matched"] != float64(2) {
		t.Fatalf("the fix matched %v samples, want both", got["matched"])
	}
	got = g.ok("POST", "/admin/templates/testbank.card/2/publish", nil)
	if got["status"] != tmpl.StatusPublished {
		t.Fatalf("a strictly better template was refused: %v", got)
	}
	if regs, _ := got["regressions"].([]any); len(regs) != 0 {
		t.Fatalf("regressions on a strictly better template: %v", got)
	}
	live, err := g.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Version != 2 {
		t.Fatalf("live set = %+v", live)
	}
}

// ---------------------------------------------------------------------------
// The value-level half of the gate
// ---------------------------------------------------------------------------

// The gate's whole reason to exist, in the form it could not see: a candidate
// that MATCHES every donated sample and extracts DIFFERENT MONEY out of it.
//
// Both cases below published clean — 200, `"regressions": []` — against a
// comparison of match booleans, because both templates match perfectly. A
// published template is auto-trusted (pipeline.parse returns needsReview=false
// for an attested message) and ships to every device in the beta, and
// /reprocess then supersedes already-correct ops with the new values. "Did it
// still match" cannot see that; only "what did it extract" can.
func TestTheGateRefusesATemplateThatExtractsDifferentValues(t *testing.T) {
	for _, tc := range []struct {
		name  string
		v2    []byte
		field string
	}{
		{
			// One character of a const entry. Every amount in every user's
			// ledger flips sign.
			name:  "the direction flips debit to credit",
			v2:    templateJSONWith(2, broadAmount, "credit", false),
			field: tmpl.FieldDirection,
		},
		{
			// The single most likely way to break a parser: a capture group
			// that still matches, one line lower down.
			name:  "the amount pattern reads the available balance",
			v2:    templateJSONWith(2, balanceAmount, "debit", false),
			field: tmpl.FieldAmount,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGate(t)
			g.donateReal(g.user("alice"), sampleWithBalance, "testbank.test")

			g.author(1, broadAmount)
			if got := g.ok("POST", "/admin/templates/testbank.card/1/publish", nil); got["status"] != tmpl.StatusPublished {
				t.Fatalf("the correct template did not publish: %v", got)
			}

			g.authorDef(tc.v2)
			body := g.conflict("/admin/templates/testbank.card/2/publish", nil)
			if body["error"] != "value_change" {
				t.Fatalf("refusal = %v, want a value_change", body)
			}
			if got := fieldsIn(t, body, "changes"); !slices.Equal(got, []string{tc.field}) {
				t.Fatalf("changed fields = %v, want exactly [%s]: %v", got, tc.field, body)
			}
			// It still MATCHED — which is precisely why the boolean comparison
			// reported nothing.
			if body["matched"] != float64(1) || len(body["regressions"].([]any)) != 0 {
				t.Fatalf("the corrupt template did not match every sample, so this "+
					"test is not exercising the value comparison: %v", body)
			}

			// Nothing moved: v1 is still live, v2 is still a draft.
			live, err := g.templates.Published(bg)
			if err != nil {
				t.Fatal(err)
			}
			if len(live) != 1 || live[0].Version != 1 {
				t.Fatalf("the live set changed after a refused publish: %+v", live)
			}
			r2, err := g.templates.Get(bg, "testbank.card", 2)
			if err != nil {
				t.Fatal(err)
			}
			if r2.Status != tmpl.StatusDraft {
				t.Fatalf("the refused candidate is now %q", r2.Status)
			}
		})
	}
}

// The other side of the same coin, and the one that decides whether the value
// comparison is usable: a template that extracts MORE is an improvement, not a
// regression, and must publish with no ceremony at all.
//
// v2 here adds a last4 entry. The live version read no card number from this
// message; the candidate reads one. Nothing the live version extracted changes.
func TestATemplateThatExtractsAFieldTheLiveOneCouldNotIsNotARegression(t *testing.T) {
	g := newGate(t)
	g.donateReal(g.user("alice"), sampleWithBalance, "testbank.test")
	g.author(1, broadAmount)
	g.ok("POST", "/admin/templates/testbank.card/1/publish", nil)

	g.authorDef(templateJSONWith(2, broadAmount, "debit", true))
	got := g.ok("POST", "/admin/templates/testbank.card/2/publish", nil)
	if got["status"] != tmpl.StatusPublished {
		t.Fatalf("a strictly better template was refused: %v", got)
	}
	if ch := fieldsIn(t, got, "changes"); len(ch) != 0 {
		t.Fatalf("extracting a NEW field was reported as a changed one: %v", got)
	}
	// Reported, though — the operator asked for this and gets told it happened.
	if gains := fieldsIn(t, got, "gains"); !slices.Equal(gains, []string{tmpl.FieldLast4}) {
		t.Fatalf("gains = %v, want [last4]: %v", gains, got)
	}
	live, err := g.templates.Published(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Version != 2 {
		t.Fatalf("live set = %+v", live)
	}
}

// The escape hatch for a value change, which is NOT the escape hatch for a
// regression. A value difference is the one class this gate genuinely cannot
// adjudicate — a widened merchant capture and a rewired amount pattern look
// identical from here — so it is refused until an operator who has been shown
// the sample and the field says yes. Retiring donated mail is not the remedy
// for it, and there is still no way past a match regression at all.
func TestAValueChangePublishesOnlyWhenItIsAcknowledged(t *testing.T) {
	g := newGate(t)
	g.donateReal(g.user("alice"), sampleWithBalance, "testbank.test")
	g.author(1, broadAmount)
	g.ok("POST", "/admin/templates/testbank.card/1/publish", nil)
	g.authorDef(templateJSONWith(2, broadAmount, "credit", false))

	g.conflict("/admin/templates/testbank.card/2/publish", nil)
	got := g.ok("POST", "/admin/templates/testbank.card/2/publish",
		map[string]any{"accept_changes": true})
	if got["status"] != tmpl.StatusPublished {
		t.Fatalf("an acknowledged value change did not publish: %v", got)
	}
	// The acknowledgement is on the record in the response too: it says what
	// was accepted, not merely that something was.
	if fs := fieldsIn(t, got, "changes"); !slices.Equal(fs, []string{tmpl.FieldDirection}) {
		t.Fatalf("the accepted change was not reported back: %v", got)
	}

	// And it is NOT a force flag: the same acknowledgement does nothing for a
	// candidate that stops parsing real mail.
	g.donateReal(g.user("bob"), samplePurchase, "testbank.test")
	g.authorDef(templateJSONWith(3, narrowAmount, "credit", false))
	body := g.conflict("/admin/templates/testbank.card/3/publish",
		map[string]any{"accept_changes": true})
	if body["error"] != "regression" {
		t.Fatalf("accept_changes was accepted as a force flag over a regression: %v", body)
	}
}

// The escape hatch, end to end. Retiring the donated message that a candidate
// legitimately drops is what makes the publish refusal survivable without a
// force flag — and it is the ONLY thing that does.
func TestRetiringTheDroppedSampleIsWhatUnblocksAPublish(t *testing.T) {
	g := newGate(t)
	alice := g.user("alice")
	bob := g.user("bob")
	g.donateReal(alice, sampleSpent, "testbank.test")
	g.donateReal(bob, samplePurchase, "testbank.test")
	g.author(1, broadAmount)
	g.ok("POST", "/admin/templates/testbank.card/1/publish", nil)
	g.author(2, narrowAmount)

	rec := g.do("POST", "/admin/templates/testbank.card/2/publish", testToken, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("publish = %d, want 409", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	id := body["regressions"].([]any)[0].(map[string]any)["sample_id"].(string)

	// Retiring a DIFFERENT sample does not help — the gate is about the specific
	// mail that broke, not about shrinking the corpus until it passes.
	other := ""
	all, err := g.store.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range all {
		if s.ID.String() != id {
			other = s.ID.String()
		}
	}
	if rec := g.do("DELETE", "/admin/samples/"+other, testToken, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("retire = %d: %s", rec.Code, rec.Body.String())
	}
	if rec := g.do("POST", "/admin/templates/testbank.card/2/publish", testToken, nil); rec.Code != http.StatusConflict {
		t.Fatalf("publish after retiring the WRONG sample = %d, want 409 still", rec.Code)
	}

	// Retiring the one that actually broke does.
	if rec := g.do("DELETE", "/admin/samples/"+id, testToken, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("retire = %d: %s", rec.Code, rec.Body.String())
	}
	got := g.ok("POST", "/admin/templates/testbank.card/2/publish", nil)
	if got["status"] != tmpl.StatusPublished {
		t.Fatalf("publish after retiring the dropped sample = %v", got)
	}
	// And the retired mail is GONE, not merely ignored.
	var n int
	if err := g.pool.QueryRow(bg, `SELECT count(*) FROM donated_samples`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d donated rows survived retirement", n)
	}
}

func TestRetiringASampleThatIsNotThereIs404(t *testing.T) {
	g := newGate(t)
	if rec := g.do("DELETE", "/admin/samples/"+uuid.New().String(), testToken, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("retiring an unknown sample = %d, want 404", rec.Code)
	}
	if rec := g.do("DELETE", "/admin/samples/not-a-uuid", testToken, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("retiring a malformed id = %d, want 400", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

// §3.5's demand view, over the real store: how many PEOPLE hit each format,
// ordered by that, with no content anywhere in the answer.
func TestTheQueueClustersDemandByPeople(t *testing.T) {
	g := newGate(t)
	// Three users on one untemplated format, one user on another.
	for _, sub := range []string{"alice", "bob", "carol"} {
		g.reportReal(g.user(sub), rawMail("Amount: AED 250.00\nMerchant: STARBUCKS\nDate: 01/01/2026"), "fab.ae")
	}
	g.reportReal(g.user("dave"), rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	got := g.ok("GET", "/admin/samples", nil)
	clusters, _ := got["clusters"].([]any)
	if len(clusters) != 2 {
		t.Fatalf("%d clusters, want 2: %v", len(clusters), got)
	}
	first := clusters[0].(map[string]any)
	if first["sender_domain"] != "fab.ae" || first["user_count"] != float64(3) {
		t.Fatalf("the queue is not ordered by how many people hit a format: %v", clusters)
	}
	if first["donated_count"] != float64(0) {
		t.Fatalf("a cluster of content-free reports claims %v replayable bodies", first["donated_count"])
	}
}

// ---------------------------------------------------------------------------
// What the console can never return
// ---------------------------------------------------------------------------

// The access half of the retention promise: no route on this console returns a
// donated body. Validate and publish see the bytes — they have to, the replay
// runs over them — and turn them into match results before they reach a
// response. The queue sees counts. The check is against the RESPONSES, over a
// corpus whose contents are deliberately distinctive.
func TestNoConsoleRouteReturnsADonatedBody(t *testing.T) {
	g := newGate(t)
	alice := g.user("alice")
	g.donateReal(alice, rawMail("You spent AED 9,912.45 at DR ALIA FERTILITY CLINIC on 12/03/2026"), "testbank.test")
	g.donateReal(g.user("bob"), sampleSpent, "testbank.test")
	g.donateReal(g.user("carol"), sampleWithBalance, "testbank.test")
	g.author(1, broadAmount)
	// A live version and a candidate that extracts different money out of the
	// corpus, so the probes below include the response that REPORTS a value
	// difference — the one route in this console that is computed from
	// extracted content and could most easily hand it back.
	g.ok("POST", "/admin/templates/testbank.card/1/publish", nil)
	g.authorDef(templateJSONWith(2, balanceAmount, "credit", true))

	all, err := g.store.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("%d samples in the corpus", len(all))
	}

	probes := []struct {
		method, path string
		body         any
	}{
		{"POST", "/admin/templates/testbank.card/1/validate", nil},
		{"POST", "/admin/templates/testbank.card/1/publish", nil},
		{"POST", "/admin/templates/testbank.card/2/validate", nil},
		// The value-difference refusal, and the acknowledged publish that
		// follows it: both are computed from extracted content.
		{"POST", "/admin/templates/testbank.card/2/publish", nil},
		{"POST", "/admin/templates/testbank.card/2/publish", map[string]any{"accept_changes": true}},
		{"GET", "/admin/samples", nil},
		{"GET", "/admin/templates", nil},
		{"GET", "/admin/diagnostics", nil},
		{"GET", "/admin/accounting", nil},
	}
	forbidden := []string{
		"ALIA", "FERTILITY", "CLINIC", "STARBUCKS", "9,912.45", "250.00",
		"Transaction Alert", "alerts@testbank.test",
		// The values the value-level comparison reads and must not report: the
		// balance it now mistakes for a transaction, and the card fragment it
		// newly captures. (A const direction is the operator's own text in
		// their own definition, which GET /admin/templates returns by design.)
		"9999.99", "4321",
	}
	for _, p := range probes {
		rec := g.do(p.method, p.path, testToken, p.body)
		got := rec.Body.String()
		for _, f := range forbidden {
			if strings.Contains(got, f) {
				t.Errorf("%s %s returned donated content %q: %s", p.method, p.path, f, got)
			}
		}
		// Base64 too: a body smuggled through a []byte field would marshal that
		// way rather than as readable text, which is exactly the mistake a
		// substring check on the plaintext would miss.
		for _, s := range all {
			if b64 := base64.StdEncoding.EncodeToString(s.Raw); strings.Contains(got, b64) {
				t.Errorf("%s %s returned a base64-encoded donated body", p.method, p.path)
			}
		}
	}
}

// The corpus the gate consulted must be the corpus that exists — a domain read
// that quietly returned nothing would report every publish as clean.
func TestTheGateReadsTheCorpusThroughTheSameSubdomainRuleTemplatesMatchOn(t *testing.T) {
	g := newGate(t)
	g.donateReal(g.user("alice"), sampleSpent, "alerts.testbank.test")
	g.donateReal(g.user("bob"), samplePurchase, "eviltestbank.test")

	g.author(1, broadAmount)
	got := g.ok("POST", "/admin/templates/testbank.card/1/validate", nil)
	if got["samples"] != float64(1) {
		t.Fatalf("validate saw %v samples; testbank.test must cover alerts.testbank.test "+
			"and must not cover eviltestbank.test", got["samples"])
	}
}
