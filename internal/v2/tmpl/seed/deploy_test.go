package seed

// deploy_test.go is the verification that matters for the seed path, and it is
// deliberately not a test of Apply.
//
// Apply can be correct — rows in the right table, right status, right version —
// while a deployment still parses nothing, because "parses" is a claim about
// five things agreeing: the migrations, what Apply writes, what
// tmpl.Store.ForSenderDomain reads back, what norm produces from a real bank's
// real MIME, and what the compiled template extracts from that. Phase 1's
// corpus parity gate proved the last two over 5,719 messages while the first
// three were never connected at all.
//
// So this starts from a genuinely fresh database — pgtest.New runs every
// migration from zero — runs the same Apply that `ledgerd seed-templates` and
// `ledgerd serve` run, and hands the real ingest.Pipeline two REAL, byte-exact
// bank emails out of the operator's mailbox (internal/v2/origin/testdata,
// extracted by internal/v2/corpus/cmd/extract-fixtures). The assertion is on
// the money in the op log.
//
// # What is stubbed, and why it is not the subject here
//
// The origin resolver. These two fixtures carry live DKIM signatures and
// internal/v2/origin verifies them against a recorded DNS snapshot in its own
// tests; repeating that here would make this test fail on the day DIB's key
// rotates, for a reason that has nothing to do with whether a deployment holds
// templates. Everything downstream of the trust decision — normalization,
// template selection by verified sender domain, execution, the append — is the
// real production code path.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/ingest"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/pgtest"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/smtpd"
	"ledger/internal/v2/tmpl"

	"github.com/jackc/pgx/v5/pgxpool"
)

// corpusFixtureDir holds real messages, committed under
// internal/v2/origin/testdata with a manifest recording where each came from.
// They are read by path rather than copied here so there is exactly one copy of
// each message in the repo.
const corpusFixtureDir = "../../origin/testdata"

// trustedFor stands in for the user having confirmed this sender. The
// sender-allowlist round trip is quarantine's own test; what this file needs is
// a trusted lane, so that the message reaches the parse cascade at all.
type trustedFor string

func (d trustedFor) Allowlisted(_ context.Context, _ uuid.UUID, domain, scope string) (bool, error) {
	return domain == string(d) && scope == origin.ScopeOuter, nil
}

// TestAFreshDeploymentParsesRealBankMail is finding 2's acceptance test.
//
// Before the seed is applied the same two messages must NOT reach the template
// tier — that half is what makes the second half mean something, and it is
// exactly the state every ledgerd deployment was in.
func TestAFreshDeploymentParsesRealBankMail(t *testing.T) {
	cases := []struct {
		fixture      string
		envelopeFrom string
		domain       string
		templateID   string
		amountMinor  string
		currency     string
		direction    string
		merchant     string
		last4        string
		postedAt     string
	}{
		{
			fixture:      "dib-dkim-unexpired.eml",
			envelopeFrom: "DIB.notification@dib.ae",
			domain:       "dib.ae",
			templateID:   "dib.card.v1",
			amountMinor:  "6295",
			currency:     "AED",
			direction:    "debit",
			merchant:     "Noon Minutes",
			last4:        "2112",
			postedAt:     "2026-06-21T00:00:00Z",
		},
		{
			fixture:      "enbd-proofpoint-p.eml",
			envelopeFrom: "notifications@emiratesnbd.com",
			domain:       "emiratesnbd.com",
			templateID:   "enbd.transfer.v1",
			amountMinor:  "410000",
			currency:     "AED",
			direction:    "debit",
			merchant:     "Siddiq sabir sabir hussain",
			postedAt:     "2026-06-05T16:25:00Z",
		},
	}

	for _, tc := range cases {
		t.Run(tc.templateID, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(corpusFixtureDir, tc.fixture))
			if err != nil {
				t.Fatalf("read the corpus fixture: %v", err)
			}

			pool := pgtest.New(t) // every migration, from zero
			store := &tmpl.Store{Pool: pool}
			rig := newDeployRig(t, pool, store, tc.domain)

			// --- The state a deployed ledgerd was actually in ---------------
			rig.deliver(t, raw, tc.envelopeFrom)
			if p := rig.onlyPayload(t); p.Tier == diag.TierTemplate {
				t.Fatalf("an unseeded database reached the template tier: %+v", p)
			} else if p.TemplateID != "" {
				t.Fatalf("an unseeded database claimed template provenance %q", p.TemplateID)
			}

			// --- The seed path, exactly as the binary runs it ---------------
			if _, err := Apply(ctx, store); err != nil {
				t.Fatalf("apply the seed: %v", err)
			}

			// A second database, so the assertion below is about a fresh
			// install that was seeded — not about reprocessing.
			pool2 := pgtest.New(t)
			store2 := &tmpl.Store{Pool: pool2}
			if _, err := Apply(ctx, store2); err != nil {
				t.Fatalf("apply the seed: %v", err)
			}
			rig2 := newDeployRig(t, pool2, store2, tc.domain)
			rig2.deliver(t, raw, tc.envelopeFrom)

			p := rig2.onlyPayload(t)
			switch {
			case p.Tier != diag.TierTemplate:
				t.Fatalf("tier = %q, want %q — the seeded template did not win", p.Tier, diag.TierTemplate)
			case p.TemplateID != tc.templateID || p.TemplateVersion != 1:
				t.Fatalf("provenance = %s v%d, want %s v1", p.TemplateID, p.TemplateVersion, tc.templateID)
			case p.AmountMinor != tc.amountMinor || p.Currency != tc.currency || p.Direction != tc.direction:
				t.Fatalf("money = %s %s %s, want %s %s %s",
					p.AmountMinor, p.Currency, p.Direction, tc.amountMinor, tc.currency, tc.direction)
			case p.MerchantRaw != tc.merchant || p.Last4 != tc.last4:
				t.Fatalf("merchant/last4 = %q/%q, want %q/%q", p.MerchantRaw, p.Last4, tc.merchant, tc.last4)
			case p.PostedAt != tc.postedAt:
				t.Fatalf("posted_at = %q, want %q", p.PostedAt, tc.postedAt)
			case p.NeedsReview || p.Unparsed:
				t.Fatalf("a template hit on genuine bank mail was flagged: %+v", p)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

type deployRig struct {
	pool *pgxpool.Pool
	p    *ingest.Pipeline
	user uuid.UUID
}

func newDeployRig(t *testing.T, pool *pgxpool.Pool, store *tmpl.Store, domain string) *deployRig {
	t.Helper()
	user, err := auth.UpsertUser(ctx, pool, auth.Identity{IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	q := &quarantine.Store{Pool: pool, TTL: quarantine.DefaultTTL, WarnBefore: quarantine.DefaultWarnBefore}
	return &deployRig{
		pool: pool,
		user: user,
		p: &ingest.Pipeline{
			Pool:      pool,
			Templates: store,
			Origin: ingest.ResolverFunc(func(context.Context, []byte, string) origin.Origin {
				return origin.Origin{Outer: domain, DKIM: origin.SigPass, ARC: origin.SigNone}
			}),
			Trust:      trustedFor(domain),
			Appender:   &oplog.Appender{Pool: pool},
			Diag:       &diag.Diag{Pool: pool},
			Quarantine: q,
			Logf:       func(string, ...any) {},
		},
	}
}

func (r *deployRig) deliver(t *testing.T, raw []byte, envelopeFrom string) {
	t.Helper()
	err := r.p.Deliver(ctx, smtpd.Delivery{
		UserID:       r.user,
		Rcpt:         "u-abc@in.example.test",
		EnvelopeFrom: envelopeFrom,
		Raw:          raw,
		ReceivedAt:   time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
}

// payload mirrors the txn_ingested wire payload. It is redeclared here rather
// than imported because ingest's copy is unexported: the wire format is the
// contract, and a test that reached into the producer's own struct would not be
// checking it.
type txnPayload struct {
	AmountMinor       string `json:"amount_minor"`
	Currency          string `json:"currency"`
	Direction         string `json:"direction"`
	PostedAt          string `json:"posted_at"`
	MerchantRaw       string `json:"merchant_raw"`
	Last4             string `json:"last4"`
	Tier              string `json:"tier"`
	NeedsReview       bool   `json:"needs_review"`
	Unparsed          bool   `json:"unparsed"`
	TemplateID        string `json:"template_id"`
	TemplateVersion   int    `json:"template_version"`
	NormalizerVersion int    `json:"normalizer_version"`
}

func (r *deployRig) onlyPayload(t *testing.T) txnPayload {
	t.Helper()
	rows, err := r.pool.Query(ctx,
		`SELECT stream, writer_id, writer_counter, blob FROM op_log WHERE user_id = $1 ORDER BY seq`, r.user)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var ops []oplog.Op
	for rows.Next() {
		var (
			stream, writerID string
			counter          int64
			sealed           []byte
		)
		if err := rows.Scan(&stream, &writerID, &counter, &sealed); err != nil {
			t.Fatal(err)
		}
		if stream != blob.StreamHot {
			continue
		}
		pt, err := blob.PlaintextSealer{}.Open(blob.Envelope{
			UserID: r.user, Stream: stream, WriterID: writerID, WriterCounter: counter,
		}, blob.Sealed{Bytes: sealed, SizeBucket: len(sealed)})
		if err != nil {
			t.Fatalf("open hot blob at counter %d: %v", counter, err)
		}
		decoded, err := oplog.DecodeBlob(pt)
		if err != nil {
			t.Fatalf("decode hot blob at counter %d: %v", counter, err)
		}
		ops = append(ops, decoded...)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ops) != 1 {
		t.Fatalf("want exactly one hot op, got %d", len(ops))
	}
	var p txnPayload
	if err := json.Unmarshal(ops[0].Payload, &p); err != nil {
		t.Fatal(err)
	}
	return p
}
