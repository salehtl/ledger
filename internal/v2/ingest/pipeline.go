// Package ingest is the seam where a message the SMTP receiver accepted becomes
// entries in a user's op log — or, when nothing about it can be trusted,
// entries in their quarantine lane. Everything before it feeds this; everything
// after reads what it wrote.
//
// # The order, and why it is this order
//
//  1. ingest identity     the sha256 of the raw body, and the dedup key
//  2. origin              DKIM/ARC over the bytes, with the SMTP envelope
//  3. the trusted lane    an allowlist row, or quarantine
//  4. normalize           one text, one effective subject, one email date
//  5. template tier       published templates for the VERIFIED domain
//  6. heuristic tier      always needs_review, never auto-trusted
//  7. nothing matched     still appended, flagged unparsed
//  8. append              one hot op and one cold raw body, one call
//  9. diagnostics         what happened, in non-content facts
//  10. push               content-free, hot-stream appends only
//
// Trust is decided BEFORE the body is read (step 3 before step 4) and not
// afterwards. The parse tiers read attacker-writable text, and a pipeline that
// parsed first would be choosing which template to run — and therefore which
// bank a transaction is attributed to — from content, one step before deciding
// whether to believe any of it.
//
// # What this package promises
//
//   - Nothing is dropped. Every accepted message ends as an op, a quarantine
//     hold, or a returned error that makes the sending MTA try again. There is
//     no path that returns nil having stored nothing.
//   - Dedup is by INGEST IDENTITY, never by parse output (spec §3.3). Two
//     different emails that parse to the same transaction are two transactions;
//     the client's fingerprint index raises that as a review item, and this
//     package appends both.
//   - Heuristic results are never auto-trusted (spec §3.2).
//   - Quarantined mail never pushes.
package ingest

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/heuristic"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/smtpd"
	"ledger/internal/v2/tmpl"
)

// EntityKindTxn is the entity kind a txn_ingested op names. The replay engine
// refuses an op of this type that names anything else.
const EntityKindTxn = "txn"

// diagTimeout bounds the diagnostics write that happens AFTER a message is
// durably stored. It runs on a context detached from the caller's, because at
// that point the message is already in the log and a cancelled SMTP session
// must not cost us the record of it.
const diagTimeout = 5 * time.Second

// maxCompiledTemplates bounds the compiled-pattern cache. Every entry is a
// published (id, version), so the bound is only ever reached by a long-running
// process that has seen many republishes; when it is, the cache is dropped
// wholesale rather than evicted cleverly. Recompiling is cheap and the
// alternative is an LRU nobody will ever tune.
const maxCompiledTemplates = 256

// Pusher is the content-free notification sink. It is defined HERE, with its
// one caller, rather than in the package that implements it: the interface
// exists to keep this package from knowing anything about Expo, and pushv2
// ships [pushv2.Disabled] and [pushv2.Expo] which both satisfy it structurally.
//
// Notify is told a user and nothing else. That is not an accident of the
// signature — there is deliberately no parameter through which an amount, a
// merchant or even a count could be passed.
type Pusher interface {
	Notify(ctx context.Context, userID uuid.UUID) error
}

// OriginResolver answers "who signed this, and what does that prove". It is an
// interface so that the pipeline can be tested without DNS, and so that the
// envelope sender is a PARAMETER rather than something the resolver digs out of
// a header.
type OriginResolver interface {
	// Resolve is handed the raw message and the SMTP MAIL FROM path.
	Resolve(ctx context.Context, raw []byte, envelopeFrom string) origin.Origin
}

// ResolverFunc adapts a function to [OriginResolver].
type ResolverFunc func(ctx context.Context, raw []byte, envelopeFrom string) origin.Origin

// Resolve implements OriginResolver.
func (f ResolverFunc) Resolve(ctx context.Context, raw []byte, envelopeFrom string) origin.Origin {
	return f(ctx, raw, envelopeFrom)
}

// NewResolver is the production resolver: real DKIM and ARC verification, with
// the SMTP envelope passed through.
//
// It calls [origin.ResolveWithEnvelope] and not [origin.Resolve]. The
// difference is not cosmetic: Resolve falls back to the Return-Path HEADER,
// which on the inbound path is written by whoever sent the message, so a
// message could choose its own envelope domain and with it which signature
// counts as "aligned".
func NewResolver(lookup origin.LookupTXT) OriginResolver {
	return ResolverFunc(func(ctx context.Context, raw []byte, envelopeFrom string) origin.Origin {
		return origin.ResolveWithEnvelope(ctx, raw, envelopeFrom, lookup)
	})
}

// IngestID is the dedup key: SHA-256 of the raw message exactly as it arrived.
//
// It is a function of the BYTES, never of what was parsed out of them. Spec
// §3.3: reprocessing the same email emits a supersede keyed by this same id, so
// replay keeps at most one live transaction per ingest id however many times a
// template is fixed and re-run.
func IngestID(raw []byte) []byte {
	sum := sha256.Sum256(raw)
	return sum[:]
}

// Pipeline implements [smtpd.Handler].
type Pipeline struct {
	// Pool serves the dedup lookup. Required.
	Pool *pgxpool.Pool
	// Templates is the published-template store. A nil store means no template
	// tier at all — every message falls through to the heuristic — which is a
	// legitimate configuration for a deployment that has published none.
	Templates *tmpl.Store
	// Origin verifies signatures. Required.
	Origin OriginResolver
	// Trust reads the user's sender allowlist. *quarantine.Store satisfies it,
	// which is deliberate: the table the client writes when it confirms a sender
	// is the table this reads.
	Trust origin.Allowlist
	// Appender writes the op log. Required.
	Appender *oplog.Appender
	// Diag writes the bounded diagnostics ledger. Required.
	Diag *diag.Diag
	// Quarantine holds untrusted and unreadable mail. Required.
	Quarantine *quarantine.Store
	// Push is content-free notification. nil means no notifications, which is
	// the Phase 1 default (cfg.Push.Enabled is false).
	Push Pusher
	// Now defaults to time.Now and is used only when a delivery carries no
	// received time.
	Now func() time.Time
	// Logf receives operator-facing detail. Defaults to log.Printf.
	Logf func(format string, args ...any)

	mu       sync.Mutex
	compiled map[string]*tmpl.Compiled
}

var _ smtpd.Handler = (*Pipeline)(nil)

func (p *Pipeline) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Pipeline) logf(format string, args ...any) {
	if p.Logf != nil {
		p.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (p *Pipeline) check() error {
	switch {
	case p == nil:
		return errors.New("ingest: nil pipeline")
	case p.Pool == nil:
		return errors.New("ingest: no pool")
	case p.Origin == nil:
		return errors.New("ingest: no origin resolver")
	case p.Trust == nil:
		// Refused rather than defaulted. origin.Decide answers "not trusted" for
		// a nil allowlist, which is safe and completely silent: every message
		// every user ever receives would be quarantined and nobody would know
		// why. A 451 on the first message is the loud version of the same
		// misconfiguration, and it keeps the mail.
		return errors.New("ingest: no sender allowlist")
	case p.Appender == nil:
		return errors.New("ingest: no appender")
	case p.Diag == nil:
		return errors.New("ingest: no diagnostics")
	case p.Quarantine == nil:
		return errors.New("ingest: no quarantine store")
	}
	return nil
}

// Deliver turns one accepted message into log entries.
//
// # What an error here means
//
// [smtpd.Handler] answers an error with a TEMPORARY failure, so the sending MTA
// retries. Every error below is therefore a claim that retrying might work:
// a database that was unreachable, an allowlist that could not be read. A
// message this function could not classify is never answered with nil, because
// nil is "I have taken responsibility for this", and the sender would never
// send it again.
//
// The converse rule is what makes the retry safe: once the message is durably
// stored — appended or held — this function returns nil even if something after
// that point failed. A second append of the same bytes would be a second
// transaction until the client's replay noticed, and every retry is another
// chance at it.
func (p *Pipeline) Deliver(ctx context.Context, d smtpd.Delivery) error {
	if err := p.check(); err != nil {
		return err
	}
	if d.UserID == uuid.Nil {
		return errors.New("ingest: delivery has no recipient")
	}
	if len(d.Raw) == 0 {
		return errors.New("ingest: delivery has no message")
	}
	receivedAt := d.ReceivedAt
	if receivedAt.IsZero() {
		receivedAt = p.now()
	}
	ingestID := IngestID(d.Raw)

	// --- 1. Have we already taken responsibility for these bytes? -----------
	//
	// SMTP retries are normal, and so is the same message arriving twice from a
	// forwarder. Neither may become two transactions.
	handled, err := p.alreadyHandled(ctx, d.UserID, ingestID)
	if err != nil {
		return err
	}
	if handled {
		// No signature verification on this path, deliberately: a redelivery
		// that re-resolved the origin would turn "retry the message" into "make
		// the server perform DNS lookups", which is an amplifier anyone holding
		// one valid address could point at a resolver. The row records the
		// identity and the outcome, which is what the accounting needs.
		return p.record(ctx, diag.Record{
			UserID:     uuid.NullUUID{UUID: d.UserID, Valid: true},
			Event:      diag.EventArrival,
			IngestID:   ingestID,
			ReceivedAt: receivedAt,
			DKIMResult: diag.ResultNone,
			ARCResult:  diag.ResultNone,
			Tier:       diag.TierNone,
			Outcome:    diag.OutcomeDuplicate,
		})
	}

	// --- 2. Origin ----------------------------------------------------------
	o := p.Origin.Resolve(ctx, d.Raw, d.EnvelopeFrom)
	rec := diag.Record{
		UserID:       uuid.NullUUID{UUID: d.UserID, Valid: true},
		Event:        diag.EventArrival,
		IngestID:     ingestID,
		ReceivedAt:   receivedAt,
		SenderDomain: o.Outer,
		DKIMResult:   string(o.DKIM),
		ARCResult:    string(o.ARC),
		Tier:         diag.TierNone,
	}
	if o.Attested {
		// Written only when an attestation passed. diag refuses it otherwise,
		// because without one the sole available source is body text.
		rec.InnerOriginDomain = o.Inner
	}

	// --- 3. The trusted lane ------------------------------------------------
	dec, err := origin.Decide(ctx, p.Trust, d.UserID, o)
	if err != nil {
		// An allowlist that cannot be read is an outage, not a refusal.
		// Answering "not trusted" would quarantine a bank the user confirmed
		// months ago, and would do it invisibly.
		return err
	}
	if !dec.Trusted {
		p.logf("ingest: quarantining a message for user %s: %s", d.UserID, dec.Reason)
		return p.hold(ctx, d, ingestID, receivedAt, o, rec, diag.OutcomeQuarantined, "")
	}

	// --- 4. Normalize -------------------------------------------------------
	res, err := norm.Normalize(norm.CurrentVersion, d.Raw, receivedAt)
	if err != nil {
		// Held rather than appended: there is no text, so there is no
		// transaction to write, and the raw body has to survive somewhere the
		// user can see it and a fixed normalizer can re-read it (Task 30's
		// promote path). The outcome is 'rejected' rather than 'quarantined'
		// ONLY because parse_diagnostics pairs reject_reason with a refusal
		// outcome and forbids it on any other — and losing the reason would
		// make this indistinguishable from an untrusted sender, which is a
		// completely different problem with a completely different fix.
		reason := diag.RejectNormalizeError
		if errors.Is(err, norm.ErrNoTextPart) {
			reason = diag.RejectNoTextPart
		}
		p.logf("ingest: normalizing a message for user %s: %v", d.UserID, err)
		return p.hold(ctx, d, ingestID, receivedAt, o, rec, diag.OutcomeRejected, reason)
	}
	rec.NormalizerVersion = norm.CurrentVersion
	rec.StructureSig = diag.StructureSig(res.Text)
	rec.BodySizeBucket = sizeBucket(len(res.Text))

	// --- 5-7. The cascade ---------------------------------------------------
	tr, err := p.parse(ctx, dec.Domain, res)
	if err != nil {
		return err
	}
	tr.apply(&rec)

	// --- 8. Append ----------------------------------------------------------
	if err := p.appendOps(ctx, d, ingestID, receivedAt, res, tr); err != nil {
		return err
	}

	// --- 9-10. Record, then notify. Neither may undo the append. ------------
	rec.Outcome = diag.OutcomeAppended
	p.recordAfterStore(ctx, rec)
	p.notify(ctx, d.UserID)
	return nil
}

// ---------------------------------------------------------------------------
// 1. Dedup, by ingest identity
// ---------------------------------------------------------------------------

// handledOutcomes are the outcomes that mean these bytes are already stored
// somewhere durable for this user: an op exists, or a quarantine row does.
//
// 'rejected' is deliberately absent even though this package writes it beside a
// quarantine hold — the hold itself is what the second half of the check below
// finds, and a protocol-layer rejection written by smtpd (too_large) stored
// nothing at all and must not make a later, smaller retry look like a duplicate.
var handledOutcomes = []string{diag.OutcomeAppended, diag.OutcomeQuarantined, diag.OutcomeSuperseded}

// alreadyHandled reports whether this (user, ingest id) has already been stored.
//
// Two sources, because there are two places a message can end up and each can
// exist without the other for a window: the quarantine row is written before its
// diagnostics row, and an append whose diagnostics row failed is still an
// append. Reading op_log itself is not an option and will not become one — its
// blobs are ciphertext from Phase 3 on, and an ingest_id column beside them
// would put the join key permanently outside the envelope.
//
// # The race this does not close, stated rather than implied
//
// This is a lookup followed, some milliseconds later, by an append, with no lock
// between them. Two SIMULTANEOUS deliveries of the same bytes for the same user
// — a forwarder delivering the same message down two connections at once — can
// both read "not handled" and both append.
//
// It is left open deliberately. The consequence is bounded and visible: replay
// keys transactions by ingest id, so the second op is refused with a
// `duplicate_ingest` anomaly and no second transaction is materialized (see
// oplog's AppendIngest doc and spec §3.3:67). Closing it would mean either a
// lock held across the whole append — the counter row is already the per-user
// serialization point, and this would add a second one for a case that does not
// happen in ordinary SMTP — or a new unencrypted (user_id, ingest_id) table,
// which is a new metadata surface for a problem the replay engine already
// resolves. Sequential redelivery, which is what MTA retries actually are, is
// closed completely.
func (p *Pipeline) alreadyHandled(ctx context.Context, userID uuid.UUID, ingestID []byte) (bool, error) {
	held, err := p.Quarantine.Held(ctx, userID, [][]byte{ingestID})
	if err != nil {
		return false, fmt.Errorf("ingest: check quarantine for a redelivery: %w", err)
	}
	if len(held) > 0 {
		return true, nil
	}
	var one int
	err = p.Pool.QueryRow(ctx, `SELECT 1 FROM parse_diagnostics
	  WHERE user_id = $1 AND ingest_id = $2 AND outcome = ANY($3) LIMIT 1`,
		userID, ingestID, handledOutcomes).Scan(&one)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("ingest: check diagnostics for a redelivery: %w", err)
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// 3-4. Quarantine
// ---------------------------------------------------------------------------

// hold stores a message in the quarantine lane and records the arrival.
//
// It never pushes. A notification for held mail would tell a stranger who
// guessed an inbound address that they can make a user's phone buzz, and it
// would tell the user that something arrived that they cannot see until they
// confirm a sender.
func (p *Pipeline) hold(ctx context.Context, d smtpd.Delivery, ingestID []byte, receivedAt time.Time,
	o origin.Origin, rec diag.Record, outcome, reason string) error {
	it := quarantine.Item{
		UserID:     d.UserID,
		IngestID:   ingestID,
		ReceivedAt: receivedAt,
		// Stored so Task 30 can re-resolve this message's origin when the
		// sender is confirmed. It is nowhere in Blob, so a row without it has
		// destroyed it — and a re-resolve that saw an empty envelope could stop
		// attesting an inner origin the first resolve attested.
		EnvelopeFrom: d.EnvelopeFrom,
		OuterDomain:  o.Outer,
		Attested:     o.Attested,
		AttestedBy:   o.AttestedBy,
		DKIM:         string(o.DKIM),
		ARC:          string(o.ARC),
		Blob:         d.Raw,
	}
	if o.Attested {
		it.InnerDomain = o.Inner
	}
	if err := p.Quarantine.Hold(ctx, it); err != nil {
		return fmt.Errorf("ingest: hold: %w", err)
	}
	rec.Outcome = outcome
	rec.RejectReason = reason
	p.recordAfterStore(ctx, rec)
	return nil
}

// ---------------------------------------------------------------------------
// 5-7. The cascade
// ---------------------------------------------------------------------------

// tierResult is what the cascade decided, in the form both the op payload and
// the diagnostics row need.
type tierResult struct {
	tier        string
	ext         tmpl.Extraction
	needsReview bool
	unparsed    bool

	// matched, templateID and templateVersion describe the template that
	// PRODUCED the result — or, when none did, the one that got furthest, which
	// is the drift signal an operator acts on.
	matched         bool
	templateID      string
	templateVersion int
	emptyGroups     []string
}

func (t tierResult) apply(rec *diag.Record) {
	rec.Tier = t.tier
	rec.Matched = t.matched
	rec.TemplateID = t.templateID
	rec.TemplateVersion = t.templateVersion
	rec.EmptyGroups = t.emptyGroups
}

// parse runs the template tier, then the heuristic tier, then gives up in a way
// that still produces an op.
//
// domain is the CRYPTOGRAPHICALLY VERIFIED domain the trust decision matched:
// the outer signing domain, or the attested inner origin for forwarded mail. It
// is never an envelope claim, a From header, or norm.Result.From.
func (p *Pipeline) parse(ctx context.Context, domain string, res norm.Result) (tierResult, error) {
	out := tierResult{tier: diag.TierNone, needsReview: true, unparsed: true}

	defs, err := p.templatesFor(ctx, domain)
	if err != nil {
		return out, err
	}
	// The first template whose Match block admits the message AND whose required
	// fields all extract wins. A template that admitted the message and then
	// could not fill it in is the DRIFT signal — the bank changed its format —
	// and it is what the diagnostics row reports when nothing wins.
	for i := range defs {
		def := defs[i]
		c, cerr := p.compile(def)
		if cerr != nil {
			// A published template the executor cannot compile. Logged, and the
			// cascade continues: one broken template must not make every other
			// bank's mail unparsed.
			p.logf("ingest: template %s v%d does not compile: %v", def.ID, def.Version, cerr)
			continue
		}
		ext, xerr := c.Execute(res.Subject, res.Text)
		if xerr == nil {
			if def.DateFrom == tmpl.DateFromEmail {
				// The template says the transaction's date is the message's,
				// and for a forward that is the INNER message's date.
				ext.PostedAt = res.EmailDate
			}
			return tierResult{
				tier: diag.TierTemplate, ext: ext, needsReview: false, unparsed: false,
				matched: true, templateID: def.ID, templateVersion: def.Version,
				emptyGroups: ext.EmptyGroups,
			}, nil
		}
		if errors.Is(xerr, tmpl.ErrMissingField) && out.templateID == "" {
			out.templateID = def.ID
			out.templateVersion = def.Version
			out.emptyGroups = ext.EmptyGroups
		}
	}

	// The heuristic tier. Its result is ALWAYS needs_review — the tier is
	// UAE/AED-shaped and would otherwise silently enter foreign and promotional
	// mail into a ledger (spec §3.2). NeedsReview is a method on the result
	// precisely so no caller can construct a trusted one.
	h, herr := heuristic.Parse(res.Text)
	if herr == nil {
		ext := h.Extraction
		if ext.PostedAt.IsZero() {
			ext.PostedAt = res.EmailDate
		}
		// A heuristic result claims no template provenance, so the drift
		// candidate above is kept for the diagnostics row and nothing else.
		return tierResult{
			tier: diag.TierHeuristic, ext: ext, needsReview: true, unparsed: false,
			templateID: out.templateID, templateVersion: out.templateVersion,
			emptyGroups: out.emptyGroups,
		}, nil
	}

	// Nothing resolved it. The op is still appended: §2's drop policy is what
	// makes "my transactions stopped appearing" answerable, and a message that
	// exists nowhere answers nothing.
	out.ext.PostedAt = res.EmailDate
	return out, nil
}

// templatesFor returns the published templates that accept mail signed by
// domain, or nothing when no template store is configured.
func (p *Pipeline) templatesFor(ctx context.Context, domain string) ([]tmpl.Definition, error) {
	if p.Templates == nil {
		return nil, nil
	}
	defs, err := p.Templates.ForSenderDomain(ctx, domain)
	if err != nil {
		// Not swallowed into "no templates matched": that would make a database
		// blip look like a bank that changed its format, and it would write the
		// transaction at the heuristic tier, unparsed-adjacent and wrong.
		return nil, fmt.Errorf("ingest: read published templates: %w", err)
	}
	return defs, nil
}

// compile returns the compiled form of a definition, compiling once per
// (id, version). Pattern compilation is the expensive half of a template and
// the definitions do not change between publishes.
func (p *Pipeline) compile(d tmpl.Definition) (*tmpl.Compiled, error) {
	key := d.ID + "/" + strconv.Itoa(d.Version)
	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok := p.compiled[key]; ok {
		return c, nil
	}
	c, err := tmpl.Compile(d)
	if err != nil {
		return nil, err
	}
	if p.compiled == nil || len(p.compiled) >= maxCompiledTemplates {
		p.compiled = make(map[string]*tmpl.Compiled, 8)
	}
	p.compiled[key] = c
	return c, nil
}

// ---------------------------------------------------------------------------
// 8. The append
// ---------------------------------------------------------------------------

// txnPayload is the txn_ingested wire payload.
//
// Money is a decimal STRING, not a JSON number: the second executor is
// JavaScript, where JSON.parse of a number is a float64, and an amount past
// 2^53 would round silently on one side of the contract and not the other.
type txnPayload struct {
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
	TemplateID        string `json:"template_id,omitempty"`
	TemplateVersion   int    `json:"template_version,omitempty"`
	NormalizerVersion int    `json:"normalizer_version"`
}

// appendOps writes the two blobs this message produces.
//
// ONE call, two blobs, and they land on independent chains: chains are per
// (writer_id, stream) (Decision 13), so the hot row takes the next HOT ingest
// counter and the cold row the next COLD one. They are two numbers, usually not
// consecutive, and a reader that expected N and N+1 is reading the log wrong.
//
// The cold blob carries a raw body and never an op (invariant I16). That is
// what lets a client that syncs only the hot stream materialize completely,
// which is the whole reason the split exists.
func (p *Pipeline) appendOps(ctx context.Context, d smtpd.Delivery, ingestID []byte,
	receivedAt time.Time, res norm.Result, tr tierResult) error {
	idHex := hex.EncodeToString(ingestID)

	posted := tr.ext.PostedAt
	if posted.IsZero() {
		posted = res.EmailDate
	}
	if posted.IsZero() {
		posted = receivedAt
	}
	if tr.ext.AmountMinor < 0 {
		// Unreachable through either tier — both refuse a negative amount — and
		// checked anyway, because "amounts are always positive and direction
		// carries the sign" is an invariant of the money model rather than a
		// property of today's extractors.
		return fmt.Errorf("ingest: extracted a negative amount for user %s", d.UserID)
	}
	payload, err := json.Marshal(txnPayload{
		AmountMinor:       strconv.FormatInt(tr.ext.AmountMinor, 10),
		Currency:          tr.ext.Currency,
		Direction:         tr.ext.Direction,
		PostedAt:          wireTime(posted),
		MerchantRaw:       tr.ext.Merchant,
		Last4:             tr.ext.Last4,
		IsTransfer:        tr.ext.IsTransfer,
		Tier:              tr.tier,
		NeedsReview:       tr.needsReview,
		Unparsed:          tr.unparsed,
		TemplateID:        templateProvenance(tr),
		TemplateVersion:   templateProvenanceVersion(tr),
		NormalizerVersion: norm.CurrentVersion,
	})
	if err != nil {
		return fmt.Errorf("ingest: encode payload: %w", err)
	}

	op := oplog.Op{
		V:    oplog.SchemaVersion,
		Type: oplog.OpTxnIngested,
		OpID: newULID(receivedAt),
		// The arrival instant, not now(): authored_at is the fork tiebreak, and
		// it should describe the message rather than the moment a retry
		// happened to succeed.
		AuthoredAt: receivedAt,
		Entity:     &oplog.EntityRef{Kind: EntityKindTxn, ID: newULID(receivedAt)},
		IngestID:   idHex,
		Payload:    payload,
	}
	hot, err := oplog.EncodeBlob([]oplog.Op{op})
	if err != nil {
		return fmt.Errorf("ingest: encode op: %w", err)
	}
	cold, err := oplog.EncodeRawBody(oplog.RawBody{
		IngestID:   idHex,
		ReceivedAt: receivedAt,
		RawBase64:  base64.StdEncoding.EncodeToString(d.Raw),
	})
	if err != nil {
		return fmt.Errorf("ingest: encode raw body: %w", err)
	}

	// Ingest cannot batch: it seals each email at arrival, so these are
	// singleton blobs and the counter lock is taken once per message.
	if _, err := p.Appender.AppendIngest(ctx, d.UserID, []oplog.IngestBlob{
		{Stream: blob.StreamHot, Plaintext: hot, CreatedAt: receivedAt},
		{Stream: blob.StreamCold, Plaintext: cold, CreatedAt: receivedAt},
	}); err != nil {
		return fmt.Errorf("ingest: append: %w", err)
	}
	return nil
}

// templateProvenance reports the template that PRODUCED the transaction, which
// is only ever the one that matched. The drift candidate a failed cascade
// carries belongs in the diagnostics ledger and not in a user's op: it names a
// template that did not produce this row.
func templateProvenance(tr tierResult) string {
	if tr.tier == diag.TierTemplate {
		return tr.templateID
	}
	return ""
}

func templateProvenanceVersion(tr tierResult) int {
	if tr.tier == diag.TierTemplate {
		return tr.templateVersion
	}
	return 0
}

// wireTime renders an instant in the one form both executors read identically:
// UTC, millisecond precision, RFC3339 with a literal Z.
func wireTime(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)
}

// ---------------------------------------------------------------------------
// 9-10. Diagnostics and push
// ---------------------------------------------------------------------------

func (p *Pipeline) record(ctx context.Context, rec diag.Record) error {
	if err := p.Diag.Record(ctx, rec); err != nil {
		return fmt.Errorf("ingest: record diagnostics: %w", err)
	}
	return nil
}

// recordAfterStore writes the diagnostics row for a message that is ALREADY
// durably stored, and never escalates a failure to the caller.
//
// The trade, stated rather than hidden: a failure here loses one row of the
// instrument that proves nothing was dropped, and the message itself is
// unaffected. The alternative — returning the error — asks the sender to
// deliver the message a second time, and the dedup check would not see the
// first one, so the price of a lost diagnostics row would be a DUPLICATE
// TRANSACTION. One is a hole in a report; the other is wrong money.
//
// The context is detached from the caller's so a cancelled SMTP session does
// not take the record with it.
func (p *Pipeline) recordAfterStore(ctx context.Context, rec diag.Record) {
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), diagTimeout)
	defer cancel()
	if err := p.Diag.Record(dctx, rec); err != nil {
		p.logf("ingest: RECORDING A DIAGNOSTICS ROW FAILED for user %s (%s/%s); the message itself is stored: %v",
			rec.UserID.UUID, rec.Event, rec.Outcome, err)
	}
}

// notify fires the one push this system sends. Hot-stream appends only: there
// is no other caller, and every path that does not append reaches its return
// without passing through here.
func (p *Pipeline) notify(ctx context.Context, userID uuid.UUID) {
	if p.Push == nil {
		return
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), diagTimeout)
	defer cancel()
	if err := p.Push.Notify(pctx, userID); err != nil {
		// Never escalated. The transaction is in the log and the client will
		// see it on its next sync whether or not a notification arrived; asking
		// the sender to redeliver over a failed push would be strictly worse.
		p.logf("ingest: notifying user %s: %v", userID, err)
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// sizeBucket reports the padding rung a body falls in, or 0 when none applies.
// diag stores the RUNG and never an exact size: a byte count tracks the
// merchant name's length and the amount's digit count.
func sizeBucket(n int) int {
	b, err := blob.BucketFor(n)
	if err != nil {
		return 0
	}
	return b
}

// crockford is Crockford's base32 alphabet: no I, L, O or U.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newULID mints a ULID: 48 bits of millisecond timestamp then 80 bits of
// randomness, rendered as 26 Crockford base32 characters.
//
// It is implemented here rather than pulled in as a dependency because it is
// twenty lines and the only property anything downstream relies on is that op
// ids are unique strings — replay orders by seq and breaks ties on authored_at
// and writer_id, never on an op id's embedded time.
//
// The randomness is crypto/rand and a read failure PANICS. That is the correct
// failure: a ULID built on a partially-filled buffer would collide with every
// other one built the same millisecond, and two ops sharing an id is a
// corruption of an append-only log that nothing downstream can repair.
func newULID(t time.Time) string {
	var b [16]byte
	ms := uint64(t.UTC().UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	if _, err := rand.Read(b[6:]); err != nil {
		panic("ingest: crypto/rand: " + err.Error())
	}
	// 26 characters at 5 bits each is 130 bits, so the value is left-padded
	// with two zero bits — the standard ULID layout.
	out := make([]byte, 26)
	bit := func(i int) byte {
		if i < 2 {
			return 0
		}
		j := i - 2
		return (b[j/8] >> (7 - uint(j%8))) & 1
	}
	for c := 0; c < 26; c++ {
		var v byte
		for k := 0; k < 5; k++ {
			v = v<<1 | bit(c*5+k)
		}
		out[c] = crockford[v]
	}
	return string(out)
}
