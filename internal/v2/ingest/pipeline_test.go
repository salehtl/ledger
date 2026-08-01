package ingest

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-msgauth/dkim"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/pgtest"
	"ledger/internal/v2/pushv2"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/smtpd"
	"ledger/internal/v2/tmpl"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// keyring signs test messages with a real RSA key and serves the matching
// public key over a static TXT lookup, so the trust tests below run the REAL
// origin resolver rather than asserting against a stub of the thing under test.
type keyring struct {
	t    *testing.T
	key  *rsa.PrivateKey
	recs map[string][]string
}

func newKeyring(t *testing.T) *keyring {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return &keyring{t: t, key: key, recs: map[string][]string{}}
}

func (k *keyring) lookup() origin.LookupTXT {
	return func(_ context.Context, name string) ([]string, error) {
		v, ok := k.recs[name]
		if !ok {
			return nil, fmt.Errorf("no TXT record for %s", name)
		}
		return v, nil
	}
}

// sign prepends a real DKIM-Signature for domain and publishes the key.
func (k *keyring) sign(domain, selector string, raw []byte) []byte {
	k.t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&k.key.PublicKey)
	if err != nil {
		k.t.Fatal(err)
	}
	k.recs[selector+"._domainkey."+domain] = []string{
		"v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString(der)}

	var out bytes.Buffer
	err = dkim.Sign(&out, bytes.NewReader(raw), &dkim.SignOptions{
		Domain:                 domain,
		Selector:               selector,
		Signer:                 k.key,
		Hash:                   crypto.SHA256,
		HeaderCanonicalization: dkim.CanonicalizationRelaxed,
		BodyCanonicalization:   dkim.CanonicalizationRelaxed,
		HeaderKeys:             []string{"From", "To", "Subject", "Date"},
	})
	if err != nil {
		k.t.Fatal(err)
	}
	return out.Bytes()
}

type fakePusher struct {
	mu    sync.Mutex
	calls []uuid.UUID
	err   error
}

func (f *fakePusher) Notify(_ context.Context, userID uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, userID)
	return f.err
}

func (f *fakePusher) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// stubOrigin answers with a fixed Origin. It is used ONLY by the tests whose
// subject is the parse cascade rather than the trust decision; every trust
// assertion below runs the real resolver over a really-signed message.
type stubOrigin origin.Origin

func (s stubOrigin) Resolve(context.Context, []byte, string) origin.Origin {
	return origin.Origin(s)
}

type rig struct {
	t    *testing.T
	pool *pgxpool.Pool
	p    *Pipeline
	q    *quarantine.Store
	keys *keyring
	push *fakePusher
	user uuid.UUID
	now  time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	pool := pgtest.New(t)
	now := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	keys := newKeyring(t)
	q := &quarantine.Store{Pool: pool, TTL: quarantine.DefaultTTL,
		WarnBefore: quarantine.DefaultWarnBefore, Now: func() time.Time { return now }}
	push := &fakePusher{}
	r := &rig{t: t, pool: pool, q: q, keys: keys, push: push, now: now}
	// The stores read the rig's clock rather than a captured instant, because
	// deliver() advances it: two diagnostics rows written at the same
	// microsecond have no stable order, and parse_diagnostics has no column that
	// would give them one.
	q.Now = func() time.Time { return r.now }
	r.user = r.newUser("sub-" + uuid.NewString())
	r.p = &Pipeline{
		Pool:       pool,
		Templates:  &tmpl.Store{Pool: pool},
		Origin:     NewResolver(keys.lookup()),
		Trust:      q,
		Appender:   &oplog.Appender{Pool: pool},
		Diag:       &diag.Diag{Pool: pool},
		Quarantine: q,
		Push:       push,
		Now:        func() time.Time { return r.now },
		Logf:       func(string, ...any) {},
	}
	return r
}

func (r *rig) newUser(sub string) uuid.UUID {
	r.t.Helper()
	u, err := auth.UpsertUser(bg, r.pool, auth.Identity{IdP: auth.IdPApple, Subject: sub})
	if err != nil {
		r.t.Fatal(err)
	}
	return u
}

// allow writes a sender_allowlist row the only way the system ever writes one:
// by confirming a held message. A row planted by hand would not prove the
// pipeline reads the same table the client's "trust this sender" sheet writes.
func (r *rig) allow(domain, scope string) {
	r.t.Helper()
	it := quarantine.Item{
		UserID:      r.user,
		IngestID:    idOf([]byte("seed-for-" + domain + "-" + scope)),
		ReceivedAt:  r.now,
		OuterDomain: domain,
		DKIM:        quarantine.ResultPass,
		ARC:         quarantine.ResultNone,
		Blob:        []byte("From: x@" + domain + "\r\n\r\nseed"),
	}
	if scope == origin.ScopeInner {
		it.OuterDomain = "google.com"
		it.InnerDomain = domain
		it.Attested = true
		it.AttestedBy = quarantine.AttestedByARC
		it.ARC = quarantine.ResultPass
	}
	if err := r.q.Hold(bg, it); err != nil {
		r.t.Fatal(err)
	}
	ids, err := r.q.Confirm(bg, r.user, domain, scope)
	if err != nil {
		r.t.Fatalf("confirm %s/%s: %v", domain, scope, err)
	}
	// Confirming does not empty the lane — Task 30 promotes what it released —
	// so the seed message is promoted here too, leaving the counts below about
	// the messages the test actually delivered. A bare DELETE is refused by the
	// drop-policy trigger, which is the schema doing its job.
	if _, err := r.q.Promote(bg, r.user, ids); err != nil {
		r.t.Fatalf("promote the seed message: %v", err)
	}
}

func (r *rig) publish(def tmpl.Definition) {
	r.t.Helper()
	if err := (&tmpl.Store{Pool: r.pool}).Publish(bg, def); err != nil {
		r.t.Fatalf("publish %s: %v", def.ID, err)
	}
}

// deliver hands one message to the pipeline and advances the clock, so a
// redelivery arrives after the delivery it repeats — which is what a real SMTP
// retry does, and what makes the diagnostics rows orderable.
func (r *rig) deliver(raw []byte, envelopeFrom string) error {
	r.t.Helper()
	at := r.now
	r.now = r.now.Add(time.Second)
	return r.p.Deliver(bg, smtpd.Delivery{
		UserID:       r.user,
		Rcpt:         "u-abc@in.example.test",
		EnvelopeFrom: envelopeFrom,
		Raw:          raw,
		ReceivedAt:   at,
	})
}

func (r *rig) mustDeliver(raw []byte, envelopeFrom string) {
	r.t.Helper()
	if err := r.deliver(raw, envelopeFrom); err != nil {
		r.t.Fatalf("deliver: %v", err)
	}
}

type storedRow struct {
	Seq           int64
	Stream        string
	WriterID      string
	WriterCounter int64
	TypeFlag      string
	Blob          []byte
}

func (r *rig) rows() []storedRow {
	r.t.Helper()
	rows, err := r.pool.Query(bg, `SELECT seq, stream, writer_id, writer_counter, type_flag, blob
	  FROM op_log WHERE user_id = $1 ORDER BY seq`, r.user)
	if err != nil {
		r.t.Fatal(err)
	}
	defer rows.Close()
	var out []storedRow
	for rows.Next() {
		var s storedRow
		if err := rows.Scan(&s.Seq, &s.Stream, &s.WriterID, &s.WriterCounter, &s.TypeFlag, &s.Blob); err != nil {
			r.t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		r.t.Fatal(err)
	}
	return out
}

// open unseals a stored row at the exact position it occupies. A blob sealed
// for any other position does not open here, which is what makes these
// assertions about the pipeline's own framing rather than about JSON.
func (r *rig) open(row storedRow) []byte {
	r.t.Helper()
	pt, err := blob.PlaintextSealer{}.Open(blob.Envelope{
		UserID: r.user, Stream: row.Stream, WriterID: row.WriterID, WriterCounter: row.WriterCounter,
	}, blob.Sealed{Bytes: row.Blob, SizeBucket: len(row.Blob)})
	if err != nil {
		r.t.Fatalf("open %s blob at counter %d: %v", row.Stream, row.WriterCounter, err)
	}
	return pt
}

// hotOps returns every op on the hot stream, in log order.
func (r *rig) hotOps() []oplog.Op {
	r.t.Helper()
	var out []oplog.Op
	for _, row := range r.rows() {
		if row.Stream != blob.StreamHot {
			continue
		}
		ops, err := oplog.DecodeBlob(r.open(row))
		if err != nil {
			r.t.Fatalf("decode hot blob at counter %d: %v", row.WriterCounter, err)
		}
		out = append(out, ops...)
	}
	return out
}

// payload is the decoded txn payload of a single hot op.
type payload struct {
	AmountMinor       string `json:"amount_minor"`
	Currency          string `json:"currency"`
	Direction         string `json:"direction"`
	PostedAt          string `json:"posted_at"`
	MerchantRaw       string `json:"merchant_raw"`
	Last4             string `json:"last4"`
	IsTransfer        bool   `json:"is_transfer"`
	Tier              string `json:"tier"`
	NeedsReview       bool   `json:"needs_review"`
	Unparsed          bool   `json:"unparsed"`
	TemplateID        string `json:"template_id"`
	TemplateVersion   int    `json:"template_version"`
	NormalizerVersion int    `json:"normalizer_version"`
}

func (r *rig) onlyPayload() payload {
	r.t.Helper()
	ops := r.hotOps()
	if len(ops) != 1 {
		r.t.Fatalf("want exactly one hot op, got %d", len(ops))
	}
	var p payload
	if err := json.Unmarshal(ops[0].Payload, &p); err != nil {
		r.t.Fatal(err)
	}
	return p
}

type diagRow struct {
	Event             string
	Outcome           string
	Tier              string
	Matched           bool
	TemplateID        *string
	TemplateVersion   *int
	SenderDomain      string
	InnerOrigin       *string
	NormalizerVersion int
	EmptyGroups       []string
	RejectReason      *string
	StructureSig      string
	BodySizeBucket    int
}

func (r *rig) diags() []diagRow {
	r.t.Helper()
	rows, err := r.pool.Query(bg, `SELECT event, outcome, tier, matched, template_id, template_version,
	  sender_domain, inner_origin_domain, normalizer_version, empty_groups, reject_reason,
	  structure_sig, body_size_bucket
	  FROM parse_diagnostics WHERE user_id = $1 ORDER BY received_at, id`, r.user)
	if err != nil {
		r.t.Fatal(err)
	}
	defer rows.Close()
	var out []diagRow
	for rows.Next() {
		var d diagRow
		if err := rows.Scan(&d.Event, &d.Outcome, &d.Tier, &d.Matched, &d.TemplateID, &d.TemplateVersion,
			&d.SenderDomain, &d.InnerOrigin, &d.NormalizerVersion, &d.EmptyGroups, &d.RejectReason,
			&d.StructureSig, &d.BodySizeBucket); err != nil {
			r.t.Fatal(err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		r.t.Fatal(err)
	}
	return out
}

func (r *rig) heldCount() int {
	r.t.Helper()
	held, _, err := r.q.Counts(bg, r.user)
	if err != nil {
		r.t.Fatal(err)
	}
	return held
}

func idOf(raw []byte) []byte {
	sum := sha256.Sum256(raw)
	return sum[:]
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// bankTemplate is a minimal, real published template. It is deliberately not
// one of the Arabic seeds: the assertions below are about the pipeline, and a
// test whose fixture is unreadable to its reader hides its own mistakes.
func bankTemplate() tmpl.Definition {
	d, err := tmpl.ParseDefinition([]byte(`{
	  "id": "bank.card.v1",
	  "version": 1,
	  "bank": "bank",
	  "normalizer_version": 1,
	  "match": {"sender_domain": ["bank.example"], "body_contains": ["Purchase alert"]},
	  "default_currency": "AED",
	  "date_from": "body",
	  "extract": [
	    {"field":"amount","type":"amount","source":"body",
	     "patterns":["Amount (?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\\.[0-9]{2})"]},
	    {"field":"date","type":"date","source":"body","layouts":["DD-MM-YYYY"],
	     "patterns":["Date (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})"]},
	    {"field":"merchant","type":"text","source":"body","patterns":["Merchant:(?P<v>[^\\n]*)"]},
	    {"field":"last4","type":"last4","source":"body","patterns":["Card (?P<v>[0-9]{4})"]},
	    {"field":"direction","type":"const","source":"body","value":"debit"}
	  ],
	  "required": ["amount","direction","date"]
	}`))
	if err != nil {
		panic(err)
	}
	return d
}

// message builds an RFC822 text/plain message with the given headers and body.
func message(from, subject, body string) []byte {
	return []byte("From: " + from + "\r\n" +
		"To: <u-abc@in.example.test>\r\n" +
		"Subject: " + subject + "\r\n" +
		"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" + strings.ReplaceAll(body, "\n", "\r\n"))
}

const templateBody = "Purchase alert\n" +
	"Amount AED 250.00\n" +
	"Date 05-06-2026\n" +
	"Merchant:CARREFOUR HYPERMARKET\n" +
	"Card 3701\n"

// trusted is a real bank alert: signed by bank.example, aligned with the
// envelope, and the domain is on the user's allowlist.
func (r *rig) trusted(body string) []byte {
	r.t.Helper()
	return r.keys.sign("bank.example", "sel",
		message("<alerts@bank.example>", "Transaction Alert", body))
}

// ---------------------------------------------------------------------------
// The trusted lane
// ---------------------------------------------------------------------------

func TestUntrustedSenderIsQuarantinedNotAppended(t *testing.T) {
	r := newRig(t)
	r.publish(bankTemplate())
	// Nothing is allowlisted, so even a perfectly signed bank alert is untrusted.
	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")

	if got := r.rows(); len(got) != 0 {
		t.Fatalf("op_log has %d rows; an untrusted message must never reach it", len(got))
	}
	if got := r.heldCount(); got != 1 {
		t.Fatalf("quarantine holds %d items, want 1", got)
	}
	d := r.diags()
	if len(d) != 1 || d[0].Outcome != diag.OutcomeQuarantined {
		t.Fatalf("diagnostics = %+v, want one quarantined arrival", d)
	}
	if d[0].SenderDomain != "bank.example" {
		t.Fatalf("sender_domain = %q, want the verified domain", d[0].SenderDomain)
	}
}

func TestQuarantinedMailNeverPushes(t *testing.T) {
	r := newRig(t)
	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")
	if n := r.push.count(); n != 0 {
		t.Fatalf("quarantined mail fired %d pushes, want 0", n)
	}
}

// TestATrustDecisionNeverReadsTheUnwrappedFrom is the bypass §3.2 exists to
// close: the body's own "Begin forwarded message" From line is content, and
// content is not evidence. The allowlist names bank.example at BOTH scopes, so
// the only thing standing between this message and the op log is the refusal to
// read a From line out of a body.
func TestATrustDecisionNeverReadsTheUnwrappedFrom(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.allow("bank.example", origin.ScopeInner)
	r.publish(bankTemplate())

	forged := message("<attacker@evil.example>", "Fwd: Transaction Alert",
		"Begin forwarded message:\n"+
			"From: alerts@bank.example\n"+
			"Subject: Transaction Alert\n"+
			"Date: 5 June 2026 at 10:00:00 GST\n"+
			"\n"+templateBody)
	r.mustDeliver(forged, "attacker@evil.example")

	if got := r.rows(); len(got) != 0 {
		t.Fatalf("op_log has %d rows; a forged From line bought trust", len(got))
	}
	if got := r.heldCount(); got != 1 {
		t.Fatalf("quarantine holds %d items, want 1", got)
	}
	d := r.diags()
	if len(d) != 1 || d[0].Outcome != diag.OutcomeQuarantined {
		t.Fatalf("diagnostics = %+v, want one quarantined arrival", d)
	}
	if d[0].SenderDomain != diag.UnverifiedPrefix+"evil.example" {
		t.Fatalf("sender_domain = %q, want the envelope claim marked unverified", d[0].SenderDomain)
	}
	if d[0].InnerOrigin != nil {
		t.Fatalf("inner_origin_domain = %q; nothing attested one", *d[0].InnerOrigin)
	}
}

// ---------------------------------------------------------------------------
// The append
// ---------------------------------------------------------------------------

func TestTrustedSenderAppendsHotAndColdOnIndependentChains(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())

	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")
	rows := r.rows()
	if len(rows) != 2 {
		t.Fatalf("want 2 rows (one hot, one cold), got %d", len(rows))
	}
	byStream := map[string]storedRow{}
	for _, row := range rows {
		if row.WriterID != oplog.IngestWriterID {
			t.Fatalf("writer_id = %q, want %q", row.WriterID, oplog.IngestWriterID)
		}
		if row.TypeFlag != oplog.TypeFlagIngest {
			t.Fatalf("type_flag = %q, want %q", row.TypeFlag, oplog.TypeFlagIngest)
		}
		byStream[row.Stream] = row
	}
	// Chains are per (writer_id, stream), so the FIRST message occupies counter 1
	// on both streams — not 1 and 2 in one sequence (Decision 13).
	if byStream[blob.StreamHot].WriterCounter != 1 || byStream[blob.StreamCold].WriterCounter != 1 {
		t.Fatalf("first message counters: hot=%d cold=%d, want 1 and 1",
			byStream[blob.StreamHot].WriterCounter, byStream[blob.StreamCold].WriterCounter)
	}

	r.mustDeliver(r.trusted(strings.Replace(templateBody, "250.00", "125.50", 1)), "alerts@bank.example")
	rows = r.rows()
	if len(rows) != 4 {
		t.Fatalf("want 4 rows after two messages, got %d", len(rows))
	}
	var hot, cold []int64
	for _, row := range rows {
		if row.Stream == blob.StreamHot {
			hot = append(hot, row.WriterCounter)
		} else {
			cold = append(cold, row.WriterCounter)
		}
	}
	if len(hot) != 2 || hot[0] != 1 || hot[1] != 2 {
		t.Fatalf("hot counters = %v, want [1 2]", hot)
	}
	if len(cold) != 2 || cold[0] != 1 || cold[1] != 2 {
		t.Fatalf("cold counters = %v, want [1 2]", cold)
	}
}

// TestColdBlobDecodesAsARawBodyNeverAsOps is invariant I16 at its source: the
// cold stream carries raw email and nothing that mutates state, which is what
// makes a hot-only sync a complete materialization.
func TestColdBlobDecodesAsARawBodyNeverAsOps(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	raw := r.trusted(templateBody)
	r.mustDeliver(raw, "alerts@bank.example")

	var cold storedRow
	for _, row := range r.rows() {
		if row.Stream == blob.StreamCold {
			cold = row
		}
	}
	pt := r.open(cold)
	if kind, err := oplog.KindOf(pt); err != nil || kind != oplog.KindRawBody {
		t.Fatalf("KindOf = %q, %v; want %q", kind, err, oplog.KindRawBody)
	}
	if _, err := oplog.DecodeBlob(pt); err == nil {
		t.Fatal("a cold blob decoded as ops; invariant I16 is broken at the source")
	}
	rb, err := oplog.DecodeRawBody(pt)
	if err != nil {
		t.Fatal(err)
	}
	if rb.IngestID != hex.EncodeToString(idOf(raw)) {
		t.Fatalf("cold ingest_id = %q, want the sha256 of the raw body", rb.IngestID)
	}
	got, err := base64.StdEncoding.DecodeString(rb.RawBase64)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, raw) {
		t.Fatal("the cold record does not carry the message as it arrived")
	}
	// The join between the two streams, which is the whole point of the id.
	if r.hotOps()[0].IngestID != rb.IngestID {
		t.Fatal("the hot op and the cold body do not share an ingest id")
	}
}

func TestTemplateHitIsTrustedAndCarriesItsProvenance(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")

	p := r.onlyPayload()
	if p.Tier != diag.TierTemplate || p.NeedsReview || p.Unparsed {
		t.Fatalf("payload = %+v, want a trusted template hit", p)
	}
	if p.AmountMinor != "25000" || p.Currency != "AED" || p.Direction != "debit" {
		t.Fatalf("money = %s %s %s, want 25000 AED debit", p.AmountMinor, p.Currency, p.Direction)
	}
	if p.MerchantRaw != "CARREFOUR HYPERMARKET" || p.Last4 != "3701" {
		t.Fatalf("merchant/last4 = %q/%q", p.MerchantRaw, p.Last4)
	}
	if p.PostedAt != "2026-06-05T00:00:00Z" {
		t.Fatalf("posted_at = %q, want the body date", p.PostedAt)
	}
	if p.TemplateID != "bank.card.v1" || p.TemplateVersion != 1 || p.NormalizerVersion != norm.CurrentVersion {
		t.Fatalf("provenance = %s v%d, normalizer %d", p.TemplateID, p.TemplateVersion, p.NormalizerVersion)
	}

	d := r.diags()
	if len(d) != 1 {
		t.Fatalf("want one diagnostics row, got %d", len(d))
	}
	if d[0].Outcome != diag.OutcomeAppended || d[0].Tier != diag.TierTemplate || !d[0].Matched {
		t.Fatalf("diagnostics = %+v", d[0])
	}
	if d[0].TemplateID == nil || *d[0].TemplateID != "bank.card.v1" {
		t.Fatalf("diagnostics template_id = %v", d[0].TemplateID)
	}
	if d[0].StructureSig == "" || d[0].BodySizeBucket == 0 {
		t.Fatalf("diagnostics carries no structure signature or size bucket: %+v", d[0])
	}
	if n := r.push.count(); n != 1 {
		t.Fatalf("pushes = %d, want exactly one for a hot append", n)
	}
}

// TestHeuristicResultsAreAlwaysNeedsReview is spec §3.2: the heuristic tier is
// UAE/AED-shaped and must never enter a transaction the user has not seen.
func TestHeuristicResultsAreAlwaysNeedsReview(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	// No template is published for this domain, so the cascade falls through.
	r.mustDeliver(r.trusted("Your card was charged AED 250.00 at CARREFOUR on 05-06-2026\n"),
		"alerts@bank.example")

	p := r.onlyPayload()
	if p.Tier != diag.TierHeuristic {
		t.Fatalf("tier = %q, want %q", p.Tier, diag.TierHeuristic)
	}
	if !p.NeedsReview {
		t.Fatal("a heuristic result was auto-trusted")
	}
	if p.Unparsed {
		t.Fatal("a heuristic hit is not unparsed")
	}
	if p.AmountMinor != "25000" || p.Currency != "AED" {
		t.Fatalf("money = %s %s", p.AmountMinor, p.Currency)
	}
	if p.TemplateID != "" || p.TemplateVersion != 0 {
		t.Fatalf("a heuristic result claimed template provenance: %+v", p)
	}
	d := r.diags()
	if len(d) != 1 || d[0].Tier != diag.TierHeuristic || d[0].Outcome != diag.OutcomeAppended {
		t.Fatalf("diagnostics = %+v", d)
	}
}

// TestUnparseableMailIsStillAppendedAsUnparsed is §2's drop policy: no tier
// resolved this message, and it is still in the log with a flag saying so.
func TestUnparseableMailIsStillAppendedAsUnparsed(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	r.mustDeliver(r.trusted("Dear customer, our branches will be closed on Eid.\n"),
		"alerts@bank.example")

	rows := r.rows()
	if len(rows) != 2 {
		t.Fatalf("want 2 rows (hot + cold) even for unparseable mail, got %d", len(rows))
	}
	p := r.onlyPayload()
	if !p.Unparsed || !p.NeedsReview || p.Tier != diag.TierNone {
		t.Fatalf("payload = %+v, want an unparsed, review-flagged, tier-none op", p)
	}
	if p.AmountMinor != "0" || p.Currency != "" {
		t.Fatalf("unparsed op invented money: %s %s", p.AmountMinor, p.Currency)
	}
	d := r.diags()
	if len(d) != 1 || d[0].Outcome != diag.OutcomeAppended || d[0].Tier != diag.TierNone {
		t.Fatalf("diagnostics = %+v", d)
	}
	if d[0].Matched {
		t.Fatal("matched is set for a message no template matched")
	}
}

// TestAMissingFieldIsReportedWithTheTemplateGroupNames is the drift signal. The
// names in empty_groups come from the template DEFINITION — field plus capture
// group — and never from what the message said.
func TestAMissingFieldIsReportedWithTheTemplateGroupNames(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	// The gate passes and the merchant group matches but captures nothing.
	body := strings.Replace(templateBody, "Merchant:CARREFOUR HYPERMARKET", "Merchant:", 1)
	r.mustDeliver(r.trusted(body), "alerts@bank.example")

	d := r.diags()
	if len(d) != 1 {
		t.Fatalf("want one diagnostics row, got %d", len(d))
	}
	if len(d[0].EmptyGroups) != 1 || d[0].EmptyGroups[0] != "merchant_v" {
		t.Fatalf("empty_groups = %v, want [merchant_v]", d[0].EmptyGroups)
	}
	for _, g := range d[0].EmptyGroups {
		if strings.Contains(g, "CARREFOUR") || strings.Contains(g, "250") {
			t.Fatalf("empty_groups carries captured text: %q", g)
		}
	}
	p := r.onlyPayload()
	if p.MerchantRaw != "" {
		t.Fatalf("merchant_raw = %q, want empty", p.MerchantRaw)
	}
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

func TestRedeliveryOfTheSameMessageIsIdempotent(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	raw := r.trusted(templateBody)

	r.mustDeliver(raw, "alerts@bank.example")
	r.mustDeliver(raw, "alerts@bank.example")

	if rows := r.rows(); len(rows) != 2 {
		t.Fatalf("op_log has %d rows after a redelivery, want 2", len(rows))
	}
	d := r.diags()
	if len(d) != 2 {
		t.Fatalf("want two diagnostics rows, got %d", len(d))
	}
	if d[0].Outcome != diag.OutcomeAppended || d[1].Outcome != diag.OutcomeDuplicate {
		t.Fatalf("outcomes = %s, %s; want appended then duplicate", d[0].Outcome, d[1].Outcome)
	}
	if n := r.push.count(); n != 1 {
		t.Fatalf("pushes = %d; a redelivery must not push again", n)
	}
}

// TestARedeliveredQuarantinedMessageIsNotHeldTwice: the quarantine lane is part
// of "we have already taken responsibility for these bytes".
func TestARedeliveredQuarantinedMessageIsNotHeldTwice(t *testing.T) {
	r := newRig(t)
	raw := r.trusted(templateBody)
	r.mustDeliver(raw, "alerts@bank.example")
	r.mustDeliver(raw, "alerts@bank.example")

	if got := r.heldCount(); got != 1 {
		t.Fatalf("quarantine holds %d copies, want 1", got)
	}
	d := r.diags()
	if len(d) != 2 || d[1].Outcome != diag.OutcomeDuplicate {
		t.Fatalf("diagnostics = %+v, want the second arrival recorded as a duplicate", d)
	}
}

// TestDedupIsByIngestIdentityNotParseOutput is spec §3.3: two DIFFERENT emails
// that parse to the same transaction are two transactions. The fingerprint is a
// secondary heuristic, and a collision is a REVIEW ITEM the client raises, never
// a silent drop here.
func TestDedupIsByIngestIdentityNotParseOutput(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())

	// Same parse output; different bytes, so different ingest identities. The
	// difference is a header the template never reads.
	first := r.keys.sign("bank.example", "sel",
		message("<alerts@bank.example>", "Transaction Alert", templateBody))
	second := r.keys.sign("bank.example", "sel",
		message("<alerts@bank.example>", "Transaction Alert ", templateBody))
	if bytes.Equal(first, second) {
		t.Fatal("the fixture produced identical bytes")
	}
	r.mustDeliver(first, "alerts@bank.example")
	r.mustDeliver(second, "alerts@bank.example")

	if rows := r.rows(); len(rows) != 4 {
		t.Fatalf("op_log has %d rows, want 4: neither message may be dropped", len(rows))
	}
	ops := r.hotOps()
	if len(ops) != 2 {
		t.Fatalf("want two txn_ingested ops, got %d", len(ops))
	}
	if ops[0].IngestID == ops[1].IngestID {
		t.Fatal("two different messages share an ingest id")
	}
	if ops[0].Entity == nil || ops[1].Entity == nil || ops[0].Entity.ID == ops[1].Entity.ID {
		t.Fatal("the two ops must create two distinct transactions")
	}
	// They collide on the client's duplicate heuristic, which is the point: the
	// pipeline appends both and lets replay raise the notice.
	var a, b payload
	if err := json.Unmarshal(ops[0].Payload, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(ops[1].Payload, &b); err != nil {
		t.Fatal(err)
	}
	fp := func(p payload) string {
		return strings.Join([]string{p.Last4, p.AmountMinor, p.Direction, p.MerchantRaw, p.PostedAt[:10]}, "|")
	}
	if fp(a) != fp(b) {
		t.Fatalf("the fixture no longer produces a fingerprint collision: %q vs %q", fp(a), fp(b))
	}
	for _, d := range r.diags() {
		if d.Outcome != diag.OutcomeAppended {
			t.Fatalf("a fingerprint collision was recorded as %q rather than appended", d.Outcome)
		}
	}
}

// ---------------------------------------------------------------------------
// The forwarded case (Decision 14)
// ---------------------------------------------------------------------------

// subjectTemplate reads last4 out of the SUBJECT and takes its date from the
// email rather than the body — the shape of the real enbd.alert.v1 seed, which
// is what makes the forwarded case below meaningful.
func subjectTemplate() tmpl.Definition {
	d, err := tmpl.ParseDefinition([]byte(`{
	  "id": "bank.alert.v1",
	  "version": 1,
	  "bank": "bank",
	  "normalizer_version": 1,
	  "match": {"sender_domain": ["bank.example"]},
	  "default_currency": "AED",
	  "date_from": "email",
	  "extract": [
	    {"field":"amount","type":"amount","source":"body","flags":["i"],
	     "patterns":["(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\\.[0-9]{2})[ \\n]has been[ \\n]debited"],
	     "on_match": {"direction": "debit"}},
	    {"field":"last4","type":"last4","source":"subject","flags":["i"],
	     "patterns":["account ending with (?P<v>[0-9]{4})"]}
	  ],
	  "required": ["amount","direction"]
	}`))
	if err != nil {
		panic(err)
	}
	return d
}

// TestForwardedMailUsesTheInnerSubjectForLast4 pins Decision 14: the subject a
// template sees is the EFFECTIVE one, which for an inline forward is the inner
// message's. The template reads last4 out of the subject, so with the outer
// "Fwd:" line that field would be silently empty and a real card number would
// simply never appear.
//
// The origin is stubbed here — proving an attested inner origin from real
// signatures is Task 26's subject and is asserted there. What this test is
// about is which of two subjects reaches the executor, and which domain's
// templates a message forwarded through Gmail is matched against.
func TestForwardedMailUsesTheInnerSubjectForLast4(t *testing.T) {
	r := newRig(t)
	r.p.Origin = stubOrigin(origin.Origin{
		Outer: "google.com", Inner: "bank.example", Attested: true,
		AttestedBy: origin.AttestedByARC, DKIM: origin.SigNone, ARC: origin.SigPass,
	})
	r.allow("bank.example", origin.ScopeInner)
	r.publish(subjectTemplate())

	fwd := message("<user@gmail.com>", "Fwd: Your account alert",
		"Begin forwarded message:\n"+
			"From: TheBank <alerts@bank.example>\n"+
			"Subject: Transaction on account ending with 3701\n"+
			"Date: 5 June 2026 at 10:00:00 GST\n"+
			"\n"+
			"AED 250.00 has been debited from your account\n")
	r.mustDeliver(fwd, "user@gmail.com")

	p := r.onlyPayload()
	if p.TemplateID != "bank.alert.v1" {
		t.Fatalf("template = %q, want bank.alert.v1", p.TemplateID)
	}
	if p.Last4 != "3701" {
		t.Fatalf("last4 = %q, want 3701 from the INNER subject", p.Last4)
	}
	if p.AmountMinor != "25000" || p.Direction != "debit" {
		t.Fatalf("money = %s %s", p.AmountMinor, p.Direction)
	}
	// date_from is "email", and for a forward the effective email date is the
	// INNER Date line.
	if p.PostedAt[:10] != "2026-06-05" {
		t.Fatalf("posted_at = %q, want the inner forwarded date", p.PostedAt)
	}
	d := r.diags()
	if len(d) != 1 || d[0].InnerOrigin == nil || *d[0].InnerOrigin != "bank.example" {
		t.Fatalf("diagnostics did not record the attested inner origin: %+v", d)
	}
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

// TestUnnormalizableMailIsHeldRatherThanDropped: a message no normalizer version
// can read still lands somewhere the user can see it, with a reason an operator
// can act on.
func TestUnnormalizableMailIsHeldRatherThanDropped(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	// A message with headers and no text part at all.
	raw := r.keys.sign("bank.example", "sel", []byte(
		"From: <alerts@bank.example>\r\n"+
			"To: <u-abc@in.example.test>\r\n"+
			"Subject: Statement\r\n"+
			"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n"+
			"Content-Type: application/pdf\r\n"+
			"Content-Transfer-Encoding: base64\r\n"+
			"\r\nJVBERi0xLjQK\r\n"))
	r.mustDeliver(raw, "alerts@bank.example")

	if rows := r.rows(); len(rows) != 0 {
		t.Fatalf("op_log has %d rows for a message nothing could read", len(rows))
	}
	if got := r.heldCount(); got != 1 {
		t.Fatalf("quarantine holds %d items, want 1: nothing may be dropped", got)
	}
	d := r.diags()
	if len(d) != 1 {
		t.Fatalf("want one diagnostics row, got %d", len(d))
	}
	if d[0].RejectReason == nil || *d[0].RejectReason != diag.RejectNoTextPart {
		t.Fatalf("reject_reason = %v, want %q", d[0].RejectReason, diag.RejectNoTextPart)
	}
	if n := r.push.count(); n != 0 {
		t.Fatalf("pushes = %d, want 0", n)
	}
}

// TestPushFailureDoesNotFailTheDelivery: the message is in the log; a push that
// did not go out is not a reason to make the sender send it again.
func TestPushFailureDoesNotFailTheDelivery(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	r.push.err = fmt.Errorf("expo is down")
	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")
	if rows := r.rows(); len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
}

// TestAStoreFailureIsATemporaryFailure: Deliver's error becomes a 4xx, so the
// sending MTA retries. Swallowing it would be the silent drop §2 forbids.
func TestAStoreFailureIsATemporaryFailure(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.p.Trust = failingAllowlist{}
	if err := r.deliver(r.trusted(templateBody), "alerts@bank.example"); err == nil {
		t.Fatal("Deliver returned nil for a message it could not classify")
	}
	if rows := r.rows(); len(rows) != 0 {
		t.Fatalf("op_log has %d rows", len(rows))
	}
	if got := r.heldCount(); got != 0 {
		t.Fatalf("quarantine holds %d items", got)
	}
}

type failingAllowlist struct{}

func (failingAllowlist) Allowlisted(context.Context, uuid.UUID, string, string) (bool, error) {
	return false, fmt.Errorf("the database is unreachable")
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

func TestIngestIDIsTheSHA256OfTheRawBody(t *testing.T) {
	raw := []byte("From: a@b\r\n\r\nhello")
	want := sha256.Sum256(raw)
	if !bytes.Equal(IngestID(raw), want[:]) {
		t.Fatal("IngestID is not sha256 of the raw body")
	}
}

// TestTheShippedPushersSatisfyThePipeline keeps the interface this package
// defines and the implementations pushv2 ships from drifting apart.
func TestTheShippedPushersSatisfyThePipeline(t *testing.T) {
	var _ Pusher = pushv2.Disabled{}
	var _ Pusher = (*pushv2.Expo)(nil)
}

// TestDeliverIsAnSMTPHandler pins the seam cmd/ledgerd mounts.
func TestDeliverIsAnSMTPHandler(t *testing.T) {
	var _ smtpd.Handler = (*Pipeline)(nil)
}
