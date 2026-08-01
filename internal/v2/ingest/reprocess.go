// ⚠ PHASE 1 ONLY — THIS FILE IS DELETED AT THE PHASE 3 CUTOVER.
//
// Everything below reads a user's mail on the server: the raw body out of their
// cold stream, and the current parse out of their hot stream. From Phase 3 both
// are HPKE-sealed to the user's public key and the server holds no private key,
// so this is not "hard later" — it is structurally impossible, and there is no
// migration of it. Spec §3.5:109 puts reprocessing on the CLIENT, over its own
// decrypted, chain-verified cold bodies.
//
// docs/superpowers/specs/v2-phase1-only-inventory.md enumerates this and the
// three other server-side plaintext read paths, says what replaces each, and is
// the list the alpha consent document is written from. Add to it before adding
// another one.
//
// # What reprocessing is for
//
// A bank changes its alert format, a template stops matching, transactions stop
// appearing. §2's promise is that this is never permanent loss: fix the
// template, re-run the cascade over mail already stored, and the corrected
// transactions appear. The same path promotes quarantined mail once its sender
// is confirmed (§3.2), which is the only way held mail ever enters the
// integrity chains.
//
// # The two rules that make it safe
//
//  1. SUPERSEDE, NEVER DUPLICATE. A re-parse appends a txn_superseded keyed by
//     the SAME ingest id (§3.3:67). Replay keys live transactions by ingest id,
//     so each supersede retires its predecessor and at most one transaction is
//     live however many times a template is fixed.
//
//  2. IDENTICAL RESULTS APPEND NOTHING. A supersede is a new entity, so the
//     category, splits and edits attached to the old one do not travel with it —
//     replay raises edit_of_superseded and the user loses work. Only the eight
//     fields that describe the TRANSACTION are compared; a republish that
//     changes only the template version is provenance, not a new transaction.
package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/smtpd"
)

const (
	// maxReprocessBatch bounds one call. The caller that will drive this is an
	// admin republish (Task 34) over "every message this template touched",
	// which is unbounded; it chunks, and this refuses rather than trusting it
	// to. The bound exists because the hot scan holds one payload per requested
	// id in memory and the held path holds raw bodies.
	maxReprocessBatch = 500

	// heldChunk bounds how many quarantined raw bodies are in memory at once.
	// A held blob can be a full blob.MaxBucket.
	heldChunk = 16

	// The paging of the two op_log scans. maxBytes is applied in the database
	// (see oplog.Read), so a page of 1 MiB cold blobs is never buffered whole.
	coldPageRows  = 32
	coldPageBytes = 4 << 20
	hotPageRows   = 256
	hotPageBytes  = 4 << 20

	// promoteTimeout bounds the quarantine promote that follows a successful
	// append. It runs on a context detached from the caller's, so it needs a
	// deadline of its own or a hung database would pin the request forever.
	promoteTimeout = 10 * time.Second
)

// promotionClaims serializes the promotion of one held message.
//
// PACKAGE level rather than a Pipeline field, deliberately: the thing being
// made exclusive is a (user, message) pair in one PROCESS, and two Pipelines
// built over one pool would otherwise race each other exactly as two goroutines
// on one Pipeline do. See [Pipeline.promoteHeld] for what this closes, what it
// does not, and why it is not a database lock.
var promotionClaims keyedMutex

// keyedMutex is a mutex per key, with the entry dropped once nothing holds or
// waits for it. The refcount is not tidiness: without it the map grows by one
// entry per distinct message ever promoted and never shrinks, which for a
// process that runs for months is a leak with a user-supplied key.
type keyedMutex struct {
	mu   sync.Mutex
	held map[string]*keyedEntry
}

type keyedEntry struct {
	mu   sync.Mutex
	refs int
}

// claim blocks until the key is free and returns the release.
func (k *keyedMutex) claim(key string) func() {
	k.mu.Lock()
	if k.held == nil {
		k.held = make(map[string]*keyedEntry)
	}
	e, ok := k.held[key]
	if !ok {
		e = &keyedEntry{}
		k.held[key] = e
	}
	e.refs++
	k.mu.Unlock()

	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		k.mu.Lock()
		defer k.mu.Unlock()
		e.refs--
		if e.refs == 0 {
			delete(k.held, key)
		}
	}
}

// Report is what one Reprocess did, in outcomes that sum to Examined.
//
// The sum is the point: this is the same accounting the diagnostics ledger
// keeps (§2's "nothing is dropped" arithmetic), and a report whose parts did not
// add up would let a message be neither re-appended nor recorded as a failure.
// TestReprocessAccountsForEveryRequestedID asserts it.
//
// Appended is not in the plan's four-field struct. It has to be: the quarantine
// promotion path appends a message that was never in the log, which is neither
// a supersede nor an unchanged, and without it three of every three promoted
// messages would be unaccounted for.
type Report struct {
	// Examined is the number of DISTINCT ingest ids the call was asked about.
	Examined int
	// Appended counts messages that entered the log for the first time: held
	// mail, promoted after its sender was confirmed.
	Appended int
	// Superseded counts messages already in the log whose re-parse differs.
	Superseded int
	// Unchanged counts messages whose re-parse is identical. Nothing appended.
	Unchanged int
	// Failed counts ids this call could not act on: not found, no longer
	// trusted, or no longer normalizable. NOTHING IS LOST BY A FAILURE — the
	// message keeps whatever place it already had, in the log or in quarantine.
	Failed int
}

// Reprocess re-runs the parse cascade over mail this user already has.
//
// Each id is resolved in one of two lanes, and never both:
//
//   - HELD in quarantine. The raw body comes from the quarantine row, the trust
//     decision is re-made against the CURRENT allowlist, and a trusted result is
//     appended as an ordinary hot+cold pair — which is the moment the message
//     enters the integrity chains — then the quarantine row is promoted away.
//   - ALREADY IN THE LOG. The raw body comes from the COLD stream, the current
//     parse from the HOT stream, and a differing re-parse appends a
//     txn_superseded on the hot stream only. The cold body is already stored
//     under this ingest id; a second copy would double the cold stream on every
//     republish and buy nothing.
//
// It never pushes. A notification is for mail that ARRIVED; a template
// republish that buzzed every alpha's phone once per corrected transaction
// would be indistinguishable from the mail itself.
//
// # Errors versus failures
//
// A returned error means the infrastructure failed — the log was unreadable,
// the allowlist could not be read, an append was refused — and the Report is
// partial. A per-message problem is counted in Report.Failed and the call
// continues: one message whose sender is no longer trusted must not stop the
// other four hundred.
func (p *Pipeline) Reprocess(ctx context.Context, userID uuid.UUID, ingestIDs [][]byte) (Report, error) {
	var rep Report
	if err := p.check(); err != nil {
		return rep, err
	}
	if userID == uuid.Nil {
		return rep, errors.New("ingest: reprocess: no user")
	}
	pending, err := distinctIngestIDs(ingestIDs)
	if err != nil {
		return rep, err
	}
	rep.Examined = len(pending)
	if rep.Examined == 0 {
		return rep, nil
	}

	if err := p.reprocessHeld(ctx, userID, pending, &rep); err != nil {
		return rep, err
	}
	if len(pending) > 0 {
		if err := p.reprocessStored(ctx, userID, pending, &rep); err != nil {
			return rep, err
		}
	}
	// Whatever is left was in neither lane: an id from a message that expired
	// out of quarantine, or one that was never this user's. Counted, and named
	// in the log, because a reprocess that silently examined fewer messages than
	// it was asked about is how "my transactions never came back" happens.
	for id := range pending {
		p.logf("ingest: reprocess: user %s has no message with ingest id %s…", userID, id[:12])
		rep.Failed++
	}
	return rep, nil
}

// ---------------------------------------------------------------------------
// Lane 1: quarantined mail, after its sender is confirmed
// ---------------------------------------------------------------------------

// reprocessHeld promotes every requested id that is still held.
func (p *Pipeline) reprocessHeld(ctx context.Context, userID uuid.UUID,
	pending map[string][]byte, rep *Report) error {
	ids := sortedIDs(pending)
	for start := 0; start < len(ids); start += heldChunk {
		end := min(start+heldChunk, len(ids))
		held, err := p.Quarantine.Held(ctx, userID, ids[start:end])
		if err != nil {
			return fmt.Errorf("ingest: reprocess: read quarantine: %w", err)
		}
		for _, it := range held {
			key := hex.EncodeToString(it.IngestID)
			if _, ok := pending[key]; !ok {
				continue
			}
			delete(pending, key)
			if err := p.promoteHeld(ctx, userID, it, rep); err != nil {
				return err
			}
		}
	}
	return nil
}

// promoteHeld re-runs pipeline steps 4-7 over one held message and, if it is
// now trusted, appends it and clears the quarantine row.
//
// # Exactly one append per held message
//
// Confirming a sender is a tap on a button, POST /api/v1/quarantine/confirm has
// no rate limit deliberately (Task 27), and every confirmation re-ingests
// everything still held from that origin. Two simultaneous confirmations
// therefore read the same held ids and race each other here: without a claim
// both append, which is two txn_ingested ops for one ingest id — replay's
// `duplicate_ingest` anomaly — plus a second copy of a body that can be a
// megabyte, while one of the two Promotes loses the FOR UPDATE race and removes
// nothing. TestConcurrentConfirmationsAppendTheMessageOnce reproduced it 5 runs
// out of 5 before [promotionClaims] existed.
//
// The claim is held from before the "was this already appended" check to after
// the append, so the loser's check runs against a log the winner has already
// written to. What it does NOT do is span processes: it is a Go lock, not a
// database one. That is a deliberate trade and the alternative was measured,
// not assumed — a row lock or an advisory lock spanning the append holds a pool
// connection while [Pipeline.appendOps] acquires a second one, so pool-max
// concurrent confirmations would each hold one and wait for one, on a route
// with no rate limit. Turning a duplicate op into a self-inflicted deadlock is
// not an improvement. Two ledgerd processes serving one database would still
// race, and the residue is what [Pipeline.alreadyHandled] already documents for
// the arrival path: a bounded, visible mess in the log that replay folds to one
// live transaction, never wrong money.
func (p *Pipeline) promoteHeld(ctx context.Context, userID uuid.UUID,
	it quarantine.Item, rep *Report) error {
	short := hex.EncodeToString(it.IngestID)[:12]

	release := promotionClaims.claim(userID.String() + "/" + hex.EncodeToString(it.IngestID))
	defer release()

	// A Promote that failed AFTER its append leaves the quarantine row behind,
	// and the natural response to that error is to run the reprocess again.
	// Without this the retry appends a second copy of a message already in the
	// log — recoverable (replay refuses it with a duplicate_ingest anomaly) but
	// entirely avoidable, since the diagnostics row already records the append.
	//
	// That last clause is only true because the diagnostics row is written
	// BEFORE the promote below rather than after it. Written after, this guard
	// reads a row that the very failure it guards against prevents from
	// existing, and it is inert.
	appended, err := p.appendedBefore(ctx, userID, it.IngestID)
	if err != nil {
		return err
	}
	if appended {
		p.logf("ingest: reprocess: %s… is already in the log; clearing the quarantine row it left behind", short)
		if _, err := p.Quarantine.Promote(ctx, userID, [][]byte{it.IngestID}); err != nil {
			return fmt.Errorf("ingest: reprocess: promote %s…: %w", short, err)
		}
		rep.Unchanged++
		return nil
	}

	o, dec, err := p.trustHeld(ctx, userID, it)
	if err != nil {
		return err
	}
	if !dec.Trusted {
		// Naming an ingest id is not a way past the trusted lane. The message
		// stays exactly where it was, visible in the user's quarantine.
		p.logf("ingest: reprocess: %s… stays in quarantine: %s", short, dec.Reason)
		rep.Failed++
		return nil
	}

	res, err := norm.Normalize(norm.CurrentVersion, it.Blob, it.ReceivedAt)
	if err != nil {
		p.logf("ingest: reprocess: %s… still does not normalize, and stays in quarantine: %v", short, err)
		rep.Failed++
		return nil
	}
	tr, err := p.parse(ctx, dec.Domain, res, o.Attested)
	if err != nil {
		return err
	}

	// ReceivedAt is the ARRIVAL instant, not now: the op's authored_at should
	// describe the message, and the cold record's received_at is the only
	// timestamp a client has for when the mail actually came.
	d := smtpd.Delivery{
		UserID:       userID,
		EnvelopeFrom: it.EnvelopeFrom,
		Raw:          it.Blob,
		ReceivedAt:   it.ReceivedAt,
	}
	if err := p.appendOps(ctx, d, it.IngestID, it.ReceivedAt, res, tr); err != nil {
		return err
	}
	// The message is in the log from here on, so it is counted here rather than
	// after the promote below: a Report returned alongside an error is partial
	// by contract, and a partial report that omitted an append that HAPPENED
	// would be the one kind of wrong this accounting exists to prevent.
	rep.Appended++

	// BEFORE the promote, not after it. This row is the evidence appendedBefore
	// reads, and the state it has to survive is precisely "the append committed
	// and the promote did not" — so writing it after the promote makes it
	// unwritable in exactly the case it is for. recordAfterStore runs on a
	// context detached from the caller's, so a client that hung up mid-request
	// still leaves the evidence behind.
	p.recordAfterStore(ctx, p.reprocessRecord(userID, it.IngestID, o, res, tr, diag.OutcomeAppended))

	// Detached for the same reason, and it is the difference between a
	// cancelled request costing nothing and a cancelled request leaving mail
	// showing as quarantined in the user's lane when it is already in their
	// ledger. The message is durable either way; only the stale row is at stake.
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), promoteTimeout)
	defer cancel()
	n, err := p.Quarantine.Promote(pctx, userID, [][]byte{it.IngestID})
	if err != nil {
		return fmt.Errorf("ingest: reprocess: promote %s… after appending it: %w", short, err)
	}
	if n == 0 {
		// Nothing to promote means the row went between this append and this
		// call. Nothing is lost — the message is in the log and the removal is
		// recorded by whoever took it — but it is the visible symptom of two
		// promotions of one message, so it is not swallowed silently.
		p.logf("ingest: reprocess: %s… was appended but no quarantine row was left to promote", short)
	}
	return nil
}

// trustHeld decides whether a held message may now take the trusted lane.
//
// It re-resolves the origin from the stored bytes and the stored SMTP envelope
// — quarantine.Item.EnvelopeFrom exists for exactly this, because the envelope
// is nowhere in the message and without it a forwarded bank alert would come
// back LESS trusted than it arrived — and falls back to the verification this
// server RECORDED at arrival when the fresh one does not carry it.
//
// The fallback is not a weakening. Both origins are outputs of the same
// verification over the same bytes; the stored one ran when the key was still
// published. A hold lasts 30 days and DKIM selectors rotate inside that window,
// so requiring a fresh signature would strand precisely the aged mail the expiry
// warning exists to rescue — and it would strand it silently, as "nothing
// happened when I confirmed my bank".
func (p *Pipeline) trustHeld(ctx context.Context, userID uuid.UUID,
	it quarantine.Item) (origin.Origin, origin.Decision, error) {
	fresh := p.Origin.Resolve(ctx, it.Blob, it.EnvelopeFrom)
	dec, err := origin.Decide(ctx, p.Trust, userID, fresh)
	if err != nil {
		return origin.Origin{}, origin.Decision{}, err
	}
	if dec.Trusted {
		return fresh, dec, nil
	}
	stored := storedOrigin(it)
	sdec, serr := origin.Decide(ctx, p.Trust, userID, stored)
	if serr != nil {
		return origin.Origin{}, origin.Decision{}, serr
	}
	if sdec.Trusted {
		p.logf("ingest: reprocess: re-verifying %s… did not reproduce its arrival result (%s); "+
			"using the verification recorded when it arrived",
			hex.EncodeToString(it.IngestID)[:12], dec.Reason)
		return stored, sdec, nil
	}
	return fresh, dec, nil
}

// storedOrigin rebuilds the origin from the facts the quarantine row holds.
// Every one of them was written by this pipeline from a verification that
// PASSED; none of them is content, and none is an envelope claim.
func storedOrigin(it quarantine.Item) origin.Origin {
	o := origin.Origin{
		Outer:      it.OuterDomain,
		Attested:   it.Attested,
		AttestedBy: it.AttestedBy,
		DKIM:       origin.SigResult(it.DKIM),
		ARC:        origin.SigResult(it.ARC),
	}
	if it.Attested {
		o.Inner = it.InnerDomain
	}
	return o
}

// ---------------------------------------------------------------------------
// Lane 2: mail already in the log
// ---------------------------------------------------------------------------

// reprocessStored re-parses every requested id whose body is in the cold stream.
func (p *Pipeline) reprocessStored(ctx context.Context, userID uuid.UUID,
	pending map[string][]byte, rep *Report) error {
	current, err := p.currentPayloads(ctx, userID, pending)
	if err != nil {
		return err
	}
	after := int64(0)
	for len(pending) > 0 {
		rows, err := oplog.Read(ctx, p.Pool, userID, blob.StreamCold, after, coldPageRows, coldPageBytes)
		if err != nil {
			return fmt.Errorf("ingest: reprocess: read the cold stream: %w", err)
		}
		if len(rows) == 0 {
			return nil
		}
		for _, row := range rows {
			after = row.Seq
			pt, err := p.openBlob(userID, row)
			if err != nil {
				return err
			}
			rb, err := oplog.DecodeRawBody(pt)
			if err != nil {
				return fmt.Errorf("ingest: reprocess: cold blob at seq %d: %w", row.Seq, err)
			}
			id, ok := pending[rb.IngestID]
			if !ok {
				continue
			}
			delete(pending, rb.IngestID)
			// DecodeRawBody already validated the payload as standard base64,
			// so this cannot fail on a blob that decoded.
			raw, err := base64.StdEncoding.DecodeString(rb.RawBase64)
			if err != nil {
				return fmt.Errorf("ingest: reprocess: cold blob at seq %d: %w", row.Seq, err)
			}
			if err := p.reprocessOne(ctx, userID, id, raw, rb.ReceivedAt, current[rb.IngestID], rep); err != nil {
				return err
			}
		}
	}
	return nil
}

// reprocessOne re-runs steps 4-7 over one stored message and supersedes it when
// the result differs.
func (p *Pipeline) reprocessOne(ctx context.Context, userID uuid.UUID, ingestID, raw []byte,
	receivedAt time.Time, prev *txnPayload, rep *Report) error {
	short := hex.EncodeToString(ingestID)[:12]
	if prev == nil {
		// A cold body with no create op on the hot stream. Nothing to compare
		// against, so a supersede here would be a create with no predecessor —
		// replay's supersede_without_origin — and the honest answer is that this
		// message needs a look rather than a guess.
		p.logf("ingest: reprocess: %s… has a stored body but no transaction op; not superseding", short)
		rep.Failed++
		return nil
	}
	o, err := p.recordedOrigin(ctx, userID, ingestID)
	if err != nil {
		return err
	}
	if o == nil {
		// The arrival diagnostics row is the only record of which domain's
		// signature was verified for this message, and the cold stream holds no
		// SMTP envelope, so a re-resolve here could only fall back to the
		// Return-Path header — which the sender wrote. Refusing is the only
		// answer that does not let body text choose a template.
		p.logf("ingest: reprocess: %s… has no recorded arrival, so its verified origin is unknown", short)
		rep.Failed++
		return nil
	}
	dec, err := origin.Decide(ctx, p.Trust, userID, *o)
	if err != nil {
		return err
	}
	if !dec.Trusted {
		p.logf("ingest: reprocess: %s… is no longer from a trusted sender: %s", short, dec.Reason)
		rep.Failed++
		return nil
	}
	res, err := norm.Normalize(norm.CurrentVersion, raw, receivedAt)
	if err != nil {
		p.logf("ingest: reprocess: %s… no longer normalizes: %v", short, err)
		rep.Failed++
		return nil
	}
	tr, err := p.parse(ctx, dec.Domain, res, o.Attested)
	if err != nil {
		return err
	}
	next, err := txnPayloadOf(res, tr, receivedAt)
	if err != nil {
		return fmt.Errorf("ingest: reprocess: %s…: %w", short, err)
	}

	rec := p.reprocessRecord(userID, ingestID, *o, res, tr, diag.OutcomeUnchanged)
	changed := changedFields(*prev, next)
	if len(changed) == 0 {
		rep.Unchanged++
		p.recordAfterStore(ctx, rec)
		return nil
	}
	if err := p.appendSupersede(ctx, userID, ingestID, next); err != nil {
		return err
	}
	rep.Superseded++
	p.logf("ingest: reprocess: superseded %s… (%v)", short, changed)
	rec.Outcome = diag.OutcomeSuperseded
	p.recordAfterStore(ctx, rec)
	return nil
}

// comparedFields is the field list [changedFields] walks, in payload order. It
// is here as data so the count in the doc cannot drift from the code.
var comparedFields = []string{
	"amount_minor", "currency", "direction", "posted_at",
	"merchant_raw", "last4", "is_transfer", "needs_review",
}

// changedFields reports which of the EIGHT compared fields differ.
//
// The eight are the transaction as the user sees it. The five payload fields
// deliberately NOT compared — tier, unparsed, template_id, template_version,
// normalizer_version — are provenance: they say which code produced the number,
// not what the number is. Superseding on them would retire and recreate every
// affected transaction on every template republish, and a supersede is a new
// entity, so the user's category, splits and edits do not come with it (replay
// raises edit_of_superseded and keeps the old row for inspection). That is a
// real loss to trade for a version number.
//
// unparsed is the near-miss and is covered anyway: a message that stops or
// starts being parseable changes its amount and currency, which are compared.
func changedFields(prev, next txnPayload) []string {
	differs := []bool{
		prev.AmountMinor != next.AmountMinor,
		prev.Currency != next.Currency,
		prev.Direction != next.Direction,
		prev.PostedAt != next.PostedAt,
		prev.MerchantRaw != next.MerchantRaw,
		prev.Last4 != next.Last4,
		prev.IsTransfer != next.IsTransfer,
		prev.NeedsReview != next.NeedsReview,
	}
	var out []string
	for i, d := range differs {
		if d {
			out = append(out, comparedFields[i])
		}
	}
	return out
}

// appendSupersede writes the txn_superseded op.
//
// HOT ONLY. The raw body is already in the cold stream under this same ingest
// id — that is what this reprocess just read — and appending a second copy
// would grow the cold stream by one full message per republish while adding no
// information. Nothing pairs the streams: chains are per (writer, stream), and
// invariant I16 only requires that a cold blob carry a raw body, never that
// every hot op have one.
//
// The op is a CREATE: no parent_version, and a NEW entity id. That is what
// replay's CREATES set expects of a txn_superseded, and it is why the FX
// snapshot is recomputed rather than inherited (§3.7:129) — the payload has no
// amount_home_minor field for a predecessor's value to ride in on, and the new
// row is frozen against the rate head live at THIS log position, which is the
// case that matters when the fix corrected the detected currency.
func (p *Pipeline) appendSupersede(ctx context.Context, userID uuid.UUID,
	ingestID []byte, tp txnPayload) error {
	at := p.now()
	body, err := json.Marshal(tp)
	if err != nil {
		return fmt.Errorf("ingest: reprocess: encode payload: %w", err)
	}
	op := oplog.Op{
		V:    oplog.SchemaVersion,
		Type: oplog.OpTxnSuperseded,
		OpID: newULID(at),
		// The instant the CORRECTION was made, not the mail's arrival:
		// authored_at is the fork tiebreak, and a supersede backdated to the
		// arrival would tie with the op it replaces.
		AuthoredAt: at,
		Entity:     &oplog.EntityRef{Kind: EntityKindTxn, ID: newULID(at)},
		IngestID:   hex.EncodeToString(ingestID),
		Payload:    body,
	}
	hot, err := oplog.EncodeBlob([]oplog.Op{op})
	if err != nil {
		return fmt.Errorf("ingest: reprocess: encode op: %w", err)
	}
	if _, err := p.Appender.AppendIngest(ctx, userID, []oplog.IngestBlob{
		{Stream: blob.StreamHot, Plaintext: hot, CreatedAt: at},
	}); err != nil {
		return fmt.Errorf("ingest: reprocess: append supersede: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Reading what is already stored
// ---------------------------------------------------------------------------

// currentPayloads returns the payload of the LAST create op for each requested
// ingest id: the txn_ingested, or the txn_superseded that most recently
// replaced it. That is what "identical" is measured against, so reprocessing
// twice is idempotent rather than a chain of supersedes.
//
// ⚠ PHASE 1 ONLY, and it is the read with the least obvious replacement. The
// server cannot ask "what does this transaction currently say" without reading
// a payload, and from Phase 3 payloads are ciphertext. There is deliberately no
// plaintext column beside them to read instead: the ingest id is already the
// join key the ingest path avoids putting in a column, and a materialized
// "current parse" table would be the server-side plaintext view the plan
// refused to build for the PWA. In Phase 3 the client holds this comparison,
// because the client is the only party that can.
//
// Only the two CREATE op types are decoded. The user's edits and
// categorizations are skipped without being parsed: they cannot change any of
// the eight compared fields (replay refuses an edit to amount, currency or
// direction with unsupported_edit_field), and reading them would be the server
// folding a user's private history for no answer it needs.
func (p *Pipeline) currentPayloads(ctx context.Context, userID uuid.UUID,
	want map[string][]byte) (map[string]*txnPayload, error) {
	out := make(map[string]*txnPayload, len(want))
	after := int64(0)
	for {
		rows, err := oplog.Read(ctx, p.Pool, userID, blob.StreamHot, after, hotPageRows, hotPageBytes)
		if err != nil {
			return nil, fmt.Errorf("ingest: reprocess: read the hot stream: %w", err)
		}
		if len(rows) == 0 {
			return out, nil
		}
		for _, row := range rows {
			after = row.Seq
			pt, err := p.openBlob(userID, row)
			if err != nil {
				return nil, err
			}
			ops, err := oplog.DecodeBlob(pt)
			if err != nil {
				// Not skipped. A hot blob this build cannot read might hold the
				// supersede that already corrected one of these messages, and
				// comparing against a stale payload would append a duplicate
				// correction. Reprocessing is an operator action; failing it
				// loudly is cheaper than a log full of redundant supersedes.
				return nil, fmt.Errorf("ingest: reprocess: hot blob at seq %d: %w", row.Seq, err)
			}
			for _, o := range ops {
				if o.Type != oplog.OpTxnIngested && o.Type != oplog.OpTxnSuperseded {
					continue
				}
				if _, ok := want[o.IngestID]; !ok {
					continue
				}
				var tp txnPayload
				if err := json.Unmarshal(o.Payload, &tp); err != nil {
					return nil, fmt.Errorf("ingest: reprocess: payload of op %s: %w", o.OpID, err)
				}
				out[o.IngestID] = &tp
			}
		}
	}
}

// openBlob unseals one stored row.
//
// ⚠ PHASE 1 ONLY, and this is the exact line. p.Appender.Sealer is nil in
// Phase 1, which means blob.PlaintextSealer — framing and padding, no
// encryption. In Phase 3 that field holds an HPKE sealer whose Open needs the
// user's private key, which the server does not have and must never have. There
// is no version of this function that works then.
func (p *Pipeline) openBlob(userID uuid.UUID, row oplog.Row) ([]byte, error) {
	sealer := blob.Sealer(blob.PlaintextSealer{})
	if p.Appender.Sealer != nil {
		sealer = p.Appender.Sealer
	}
	pt, err := sealer.Open(blob.Envelope{
		UserID: userID, Stream: row.Stream, WriterID: row.WriterID, WriterCounter: row.WriterCounter,
	}, blob.Sealed{Bytes: row.Blob, SizeBucket: row.SizeBucket})
	if err != nil {
		return nil, fmt.Errorf("ingest: reprocess: open the %s blob at seq %d: %w", row.Stream, row.Seq, err)
	}
	return pt, nil
}

const arrivalOriginSQL = `SELECT sender_domain, inner_origin_domain, dkim_result, arc_result
  FROM parse_diagnostics
 WHERE user_id = $1 AND ingest_id = $2 AND event = $3
 ORDER BY received_at, id LIMIT 1`

// recordedOrigin returns the origin this server VERIFIED when the message
// arrived, or nil when no arrival was recorded.
//
// This is not a Phase-1-only read: parse_diagnostics is content-free by
// construction (hostnames, closed enums, a size rung and a structure digest)
// and survives the cutover intact. It is also the only honest source here. The
// cold stream stores the message and not the SMTP envelope, so a fresh
// verification would have to take the envelope from Return-Path — a header the
// SENDER wrote on the inbound path — and the domain it produced would then
// choose which bank's template runs. Replaying the recorded verification cannot
// be steered by anything in the body.
//
// The FIRST arrival row is taken: a later one is a redelivery, which records no
// origin at all (the pipeline does not re-verify a duplicate).
func (p *Pipeline) recordedOrigin(ctx context.Context, userID uuid.UUID, ingestID []byte) (*origin.Origin, error) {
	var (
		outer string
		inner *string
		dkim  string
		arc   string
	)
	err := p.Pool.QueryRow(ctx, arrivalOriginSQL, userID, ingestID, diag.EventArrival).
		Scan(&outer, &inner, &dkim, &arc)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("ingest: reprocess: read the recorded origin: %w", err)
	}
	o := origin.Origin{
		Outer: outer,
		DKIM:  origin.SigResult(dkim),
		ARC:   origin.SigResult(arc),
	}
	if inner != nil && *inner != "" {
		// diag refuses inner_origin_domain unless a signature passed, so a
		// stored value IS an attestation. Nothing else can put one there.
		o.Inner, o.Attested = *inner, true
	}
	return &o, nil
}

// appendedBefore reports whether a diagnostics row already says these bytes
// reached the log for this user. It reads parse_diagnostics and never op_log,
// for the same reason [Pipeline.alreadyHandled] does: op_log's blobs are
// ciphertext from Phase 3 on, and an ingest_id column beside them would put the
// join key permanently outside the envelope.
func (p *Pipeline) appendedBefore(ctx context.Context, userID uuid.UUID, ingestID []byte) (bool, error) {
	var one int
	err := p.Pool.QueryRow(ctx, `SELECT 1 FROM parse_diagnostics
	  WHERE user_id = $1 AND ingest_id = $2 AND outcome = ANY($3) LIMIT 1`,
		userID, ingestID, []string{diag.OutcomeAppended, diag.OutcomeSuperseded}).Scan(&one)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("ingest: reprocess: check for an earlier append: %w", err)
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// reprocessRecord builds the event='reprocess' row.
//
// ReceivedAt is the instant of the RE-RUN, not of the arrival. For this event
// the column is when the thing being reported happened, which is what makes
// Accounting's window mean anything: a reprocess stamped with a six-week-old
// arrival would be invisible to every report an operator actually runs, and it
// would tie with the arrival row in every ordering.
//
// A FAILED reprocess writes no row at all, because parse_diagnostics has no
// failure outcome for this event (reject_reason pairs only with a refusal, and
// refusals are arrival outcomes). Nothing is unaccounted for by that: a failure
// changes nothing, so the message's own arrival row still describes where it is.
func (p *Pipeline) reprocessRecord(userID uuid.UUID, ingestID []byte, o origin.Origin,
	res norm.Result, tr tierResult, outcome string) diag.Record {
	rec := diag.Record{
		UserID:            uuid.NullUUID{UUID: userID, Valid: true},
		Event:             diag.EventReprocess,
		IngestID:          ingestID,
		ReceivedAt:        p.now(),
		SenderDomain:      o.Outer,
		DKIMResult:        resultOr(string(o.DKIM)),
		ARCResult:         resultOr(string(o.ARC)),
		NormalizerVersion: norm.CurrentVersion,
		StructureSig:      diag.StructureSig(res.Text),
		BodySizeBucket:    sizeBucket(len(res.Text)),
		Outcome:           outcome,
	}
	if o.Attested {
		rec.InnerOriginDomain = o.Inner
	}
	tr.apply(&rec)
	return rec
}

// resultOr maps an absent verdict onto the enum's "none". A quarantine row
// written before a column existed, or an origin with no ARC chain at all,
// carries "" — which is not a value parse_diagnostics accepts.
func resultOr(s string) string {
	if s == "" {
		return diag.ResultNone
	}
	return s
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// distinctIngestIDs validates and deduplicates the requested ids, keyed by
// their hex form — which is the form the ops and cold records carry.
func distinctIngestIDs(ids [][]byte) (map[string][]byte, error) {
	if len(ids) > maxReprocessBatch {
		return nil, fmt.Errorf("ingest: reprocess: %d ids in one call, cap is %d", len(ids), maxReprocessBatch)
	}
	out := make(map[string][]byte, len(ids))
	for _, id := range ids {
		if len(id) != sha256.Size {
			// Refused rather than skipped. A malformed id that quietly resolved
			// to nothing would report "0 examined", which reads as "there was
			// nothing to do" — the one answer that is never true here.
			return nil, fmt.Errorf("ingest: reprocess: ingest id is %d bytes, want %d", len(id), sha256.Size)
		}
		out[hex.EncodeToString(id)] = id
	}
	return out, nil
}

// sortedIDs returns the ids in a stable order, so chunked reads are repeatable.
func sortedIDs(m map[string][]byte) [][]byte {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	out := make([][]byte, 0, len(keys))
	for _, k := range keys {
		out = append(out, m[k])
	}
	return out
}
