// Package samples is the donated-sample queue (spec §3.5): the corpus a
// template is authored from, and the corpus every publish is regression-tested
// against.
//
// # Consent at setup converts; consent at the moment of failure does not
//
// §3.5:113 puts the invitation to donate in ONBOARDING — "we need one example
// to learn your bank" — with a client-side redaction preview showing exactly
// what will be sent, rather than in a modal that appears when a parse fails.
// This package holds the server half of that: [Samples.Donate] refuses a sample
// with no recorded consent, and what it records is the IDENTIFIER of the text
// the user was shown, so "what did they actually agree to" is answerable a year
// later from the row alone.
//
// # The default path stores nothing
//
// [Samples.Report] is the path the client takes by default: a sender domain and
// a content-free layout fingerprint ([diag.StructureSig]), no body, no consent
// record, one row per user per format. It answers the operator's real question
// — "which untemplated format do the most people hit" ([Samples.Clusters]) —
// without anybody reading a message. A full sample is a separate, explicit act.
//
// # A donation cannot introduce content the user did not receive
//
// [Samples.Donate] takes an INGEST ID, never a body, and REFUSES a caller that
// supplies one ([ErrBodySupplied]). It reads the bytes out of that user's own
// cold stream and the sender domain out of this server's own arrival record.
// So the worst a hostile client can do is donate its own mail; it cannot upload
// a fabricated "bank email", and it cannot file a sample under a bank it does
// not use — which matters more than it looks, because a sample filed under a
// bank blocks that bank's template publishes until somebody retires it.
//
// ⚠ PHASE 1 ONLY, for the cold-stream read. Cold blobs are HPKE-sealed to the
// user's key from Phase 3 onward and the server holds no private key, so
// [Samples.Donate]'s body read is not "hard" after the cutover — it is
// structurally impossible. It is item 3 in
// docs/superpowers/specs/v2-phase1-only-inventory.md. From Phase 3 the client
// uploads the decrypted sample itself, after showing the redaction preview,
// and the "cannot introduce content the user did not receive" property has to
// be re-established some other way (the client signs what it uploads, or the
// server checks the ingest id it claims). Everything else here — the report
// path, the clusters, the retention sweep, the table — survives the cutover.
//
// # Retention, and who can read a sample
//
// Every row carries an expiry from the moment it is written
// ([DefaultRetention], 180 days) and [Samples.ExpireDue] deletes past it.
// Account deletion cascades. No HTTP route in v2 returns a donated body: the
// console replays templates over the corpus and returns match results, and the
// queue view returns counts. The operator with a shell can read the table, and
// spec §2 says so in those words rather than leaving it to be inferred from the
// absence of a route.
package samples

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
)

// DefaultRetention is how long a donated sample lives.
//
// It is set against the gate's job rather than against a round number: a
// template rewritten a quarter after it was published must still regress
// against real mail, so a corpus that empties faster than templates are
// rewritten is a gate that has silently stopped being one. Six months is long
// enough for that and short enough to be a promise worth publishing — and it is
// published, in spec §2, which the tests check.
const DefaultRetention = 180 * 24 * time.Hour

// coldPageRows / coldPageBytes bound the cold-stream scan the donation path
// runs. Same shape as ingest's: a cold blob can be a full megabyte, so a page
// is bounded by BYTES as well as by rows.
const (
	coldPageRows  = 32
	coldPageBytes = 4 << 20
)

// Errors.
//
// ErrNotIngested deliberately covers both "that message belongs to somebody
// else" and "that message has no body in your log". From here they are the same
// fact — this user's cold stream does not contain it — and a response that told
// them apart would confirm the existence of another account's message.
var (
	// ErrNoConsent means the donation carried no usable consent record. A
	// sample without one is not storable, however real the mail is.
	ErrNoConsent = errors.New("samples: a donation needs the identifier of the consent the user gave")

	// ErrBodySupplied means a caller tried to hand this store a body. See the
	// package doc: the body comes out of the user's own log, never off the wire.
	ErrBodySupplied = errors.New("samples: a donation may not carry a caller-supplied body")

	// ErrOriginNotCallerSupplied means a caller tried to name the sender domain
	// or the layout signature of a donation. Both are the server's own records.
	ErrOriginNotCallerSupplied = errors.New("samples: a donation's origin is read from this server's records, not from the request")

	// ErrNotIngested means the user has no such message.
	ErrNotIngested = errors.New("samples: this account received no message with that ingest id")

	// ErrUnverifiedOrigin means the message's sending domain was never proven,
	// so it cannot gate a template that matches verified domains.
	ErrUnverifiedOrigin = errors.New("samples: this message's origin was never cryptographically verified")

	// ErrInvalidSample describes the CALLER's own submission and is safe to
	// report back in detail.
	ErrInvalidSample = errors.New("samples: invalid")
)

// The two grammars this package enforces in Go, mirroring migration 00013's
// CHECK constraints exactly. Both halves exist for the reason
// parse_diagnostics' do: Go is what callers go through, and SQL is what a
// repair script, a psql session or a future caller goes through.
var (
	// reHostname does NOT admit diag.UnverifiedPrefix. A domain that was only
	// ever an envelope claim is not evidence about which bank sent a message.
	reHostname = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
	reDigest   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	reConsent  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

// Sample is one row of the queue: either a content-free structural REPORT or a
// consented DONATION of a real message. Its fields are exactly the disclosed
// column list and no others — see the package doc and
// TestSampleStructHasExactlyTheDisclosedFields.
//
// Which fields a caller may set depends on the direction:
//
//   - [Samples.Report] reads UserID, SenderDomain and StructureSig.
//   - [Samples.Donate] reads UserID, IngestID and Consent, and REFUSES a
//     Raw, SenderDomain or StructureSig supplied by the caller. Everything
//     else it fills in from this server's own records.
//   - [Samples.ForSender] populates everything except Consent-free rows it
//     never returns.
type Sample struct {
	// ID is generated by the database.
	ID     uuid.UUID
	UserID uuid.UUID

	// SenderDomain is the VERIFIED signing domain — the attested inner origin
	// for forwarded mail. Never an envelope claim, never caller-supplied on the
	// donation path.
	SenderDomain string
	// StructureSig is diag.StructureSig of the normalized body: content-free,
	// and the key clusters are formed on. "" only on a donated body that does
	// not normalize.
	StructureSig string

	// IngestID is the SHA-256 of the raw body. Nil on a report.
	IngestID []byte
	// Raw is the message as received. Nil on a report; PLAINTEXT in Phase 1.
	Raw []byte
	// ReceivedAt is the arrival instant from the cold record, which is what the
	// replay must normalize against. Zero on a report.
	ReceivedAt time.Time

	// Consent identifies the text the donor was shown, e.g. "donate-sample-v1".
	// Empty on a report, which has nothing to consent to.
	Consent string
	// ConsentedAt is the server's clock when the donation arrived. It is
	// read-only to callers of Donate: a client-supplied instant would be a
	// claim about consent made by the party consent protects us from.
	ConsentedAt time.Time

	CreatedAt time.Time
	// ExpiresAt is when this row is deleted. See DefaultRetention.
	ExpiresAt time.Time
}

// Cluster is one (sender domain, layout) group: §3.5's "14 users hitting an
// untemplated FAB credit-card format" view, built entirely out of counts.
type Cluster struct {
	SenderDomain string
	StructureSig string
	// UserCount is DISTINCT users, which is the number the operator's question
	// is actually about. SampleCount is rows.
	UserCount   int
	SampleCount int
	// DonatedCount is how many rows carry a body a template can be written
	// from and replayed over. A cluster of 14 users and zero bodies is demand
	// with nothing to work from, which is a different situation and worth
	// seeing at a glance.
	DonatedCount int
	FirstSeen    time.Time
}

// Samples is the store.
type Samples struct {
	Pool *pgxpool.Pool
	// Retention defaults to DefaultRetention.
	Retention time.Duration
	// Sealer opens cold blobs; nil means blob.PlaintextSealer, which is what
	// Phase 1 runs and what nothing in this tree currently overrides.
	//
	// It is a field rather than a hard-coded PlaintextSealer for one reason: the
	// day something DOES set oplog.Appender.Sealer, a store that silently
	// assumed plaintext would fail to open a blob it was handed, and the field
	// makes the two settable from one place. It is not a Phase 3 migration path
	// — coldBody is deleted at the cutover, not reconfigured.
	Sealer blob.Sealer
	// Now defaults to time.Now.
	Now func() time.Time
}

func (s *Samples) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Samples) retention() time.Duration {
	if s.Retention > 0 {
		return s.Retention
	}
	return DefaultRetention
}

func (s *Samples) check() error {
	if s == nil || s.Pool == nil {
		return errors.New("samples: no database pool")
	}
	return nil
}

// ---------------------------------------------------------------------------
// The default path: a content-free structural report
// ---------------------------------------------------------------------------

const reportSQL = `
INSERT INTO donated_samples (user_id, sender_domain, structure_sig, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, sender_domain, structure_sig) WHERE raw IS NULL
DO UPDATE SET expires_at = EXCLUDED.expires_at`

// Report records that this user is hitting a layout, and nothing else.
//
// Repeating it is idempotent apart from refreshing the expiry: a format
// somebody is still hitting is still live demand, and one row per user per
// format is the difference between a demand signal and a per-user
// transaction-timing ledger.
func (s *Samples) Report(ctx context.Context, sample Sample) error {
	if err := s.check(); err != nil {
		return err
	}
	if sample.UserID == uuid.Nil {
		return fmt.Errorf("%w: a report must be scoped to a user", ErrInvalidSample)
	}
	if !reHostname.MatchString(sample.SenderDomain) {
		// The detail names the caller's own submission, so it is safe to
		// return. It deliberately does not echo the value.
		return fmt.Errorf("%w: sender_domain must be a verified hostname", ErrInvalidSample)
	}
	if !reDigest.MatchString(sample.StructureSig) {
		return fmt.Errorf("%w: structure_sig must be 32 lower-case hex characters", ErrInvalidSample)
	}
	if len(sample.Raw) > 0 || len(sample.IngestID) > 0 || sample.Consent != "" {
		// A report is the CONTENT-FREE path. If a caller has a body, the
		// consented path is the one that stores it, and quietly dropping the
		// extra fields would let a call site believe it had donated.
		return fmt.Errorf("%w: a structural report carries no body, no ingest id and no consent", ErrInvalidSample)
	}

	now := s.now()
	_, err := s.Pool.Exec(ctx, reportSQL,
		sample.UserID, sample.SenderDomain, sample.StructureSig, now, now.Add(s.retention()))
	if err != nil {
		return sanitize("record a structural report", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// The opt-in path: a consented donation of real mail
// ---------------------------------------------------------------------------

// arrivalOriginSQL reads the VERIFIED origin this server recorded when the
// message arrived. It is the same read ingest.Pipeline.recordedOrigin does and
// for the same reason: parse_diagnostics is the only record of which domain's
// signature actually validated, and the alternative — the body's own From line
// — is content an attacker wrote.
//
// COALESCE picks the attested inner origin when there is one, matching what
// origin.Decide hands the template selector for a forwarded message: a DIB
// alert forwarded through Gmail must be filed under dib.ae, or it would gate
// nothing. parse_diagnostics refuses inner_origin_domain unless a signature
// passed, so a stored value IS an attestation.
const arrivalOriginSQL = `
SELECT COALESCE(NULLIF(inner_origin_domain, ''), sender_domain)
  FROM parse_diagnostics
 WHERE user_id = $1 AND ingest_id = $2 AND event = $3
 ORDER BY received_at
 LIMIT 1`

const donateSQL = `
INSERT INTO donated_samples (user_id, sender_domain, structure_sig, ingest_id, raw,
                             received_at, consent, consented_at, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (user_id, ingest_id) WHERE ingest_id IS NOT NULL
DO NOTHING`

// Donate stores one message the user has explicitly agreed to share.
//
// The caller supplies a user, an ingest id and a consent identifier. It may not
// supply the body, the sender domain or the layout signature — see the package
// doc for why each of those is a refusal rather than an override.
//
// ⚠ PHASE 1 ONLY: the body is read from the user's cold stream, which is
// plaintext only until the Phase 3 cutover. Item 3 in
// docs/superpowers/specs/v2-phase1-only-inventory.md.
func (s *Samples) Donate(ctx context.Context, sample Sample) error {
	if err := s.check(); err != nil {
		return err
	}
	if sample.UserID == uuid.Nil {
		return fmt.Errorf("%w: a donation must be scoped to a user", ErrInvalidSample)
	}
	if len(sample.Raw) > 0 {
		return ErrBodySupplied
	}
	if sample.SenderDomain != "" || sample.StructureSig != "" {
		return ErrOriginNotCallerSupplied
	}
	if !reConsent.MatchString(sample.Consent) {
		// One error for "absent" and for "not an identifier". Both mean the
		// same thing to a caller: there is no consent record to store, so there
		// is no donation.
		return fmt.Errorf("%w: got %d bytes that are not a consent identifier",
			ErrNoConsent, len(sample.Consent))
	}
	if len(sample.IngestID) != 32 {
		return fmt.Errorf("%w: ingest_id must be a 32-byte sha-256", ErrInvalidSample)
	}

	domain, err := s.verifiedOrigin(ctx, sample.UserID, sample.IngestID)
	if err != nil {
		return err
	}
	raw, receivedAt, err := s.coldBody(ctx, sample.UserID, sample.IngestID)
	if err != nil {
		return err
	}

	// The signature is computed here, from the donated body, so a donation
	// lands in the SAME cluster the user's earlier content-free reports of that
	// format did. A body that does not normalize has no layout to fingerprint
	// and stores "" — it is still worth keeping, because a message no
	// normalizer can read is exactly the kind of mail an operator needs to see.
	sig := ""
	if res, nerr := norm.Normalize(norm.CurrentVersion, raw, receivedAt); nerr == nil {
		sig = diag.StructureSig(res.Text)
	}

	now := s.now()
	if _, err := s.Pool.Exec(ctx, donateSQL,
		sample.UserID, domain, sig, sample.IngestID, raw, receivedAt,
		sample.Consent, now, now, now.Add(s.retention()),
	); err != nil {
		return sanitize("store a donated sample", err)
	}
	return nil
}

// verifiedOrigin returns the domain this server proved the message came from.
func (s *Samples) verifiedOrigin(ctx context.Context, userID uuid.UUID, ingestID []byte) (string, error) {
	var domain string
	err := s.Pool.QueryRow(ctx, arrivalOriginSQL, userID, ingestID, diag.EventArrival).Scan(&domain)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return "", ErrNotIngested
	case err != nil:
		return "", sanitize("read the recorded origin", err)
	}
	if !reHostname.MatchString(domain) {
		// Either the envelope-claim prefix or the empty string (a null sender).
		// Neither can gate a template.
		return "", ErrUnverifiedOrigin
	}
	return domain, nil
}

// coldBody pulls one message out of the user's own cold stream.
//
// ⚠ PHASE 1 ONLY. This is the exact line the cutover deletes: sealer.Open is
// blob.PlaintextSealer today and an HPKE sealer in Phase 3, whose Open needs a
// key this server does not have and must never have.
//
// The scan is linear in the user's cold stream because there is deliberately no
// plaintext ingest_id column beside the blobs to index — the join key lives
// INSIDE the sealed record, which is what keeps the server from holding a
// per-user index of which messages a user received. ingest.Pipeline's reprocess
// pays the same cost for the same reason. At beta scale a donation is a rare,
// user-initiated act, so a full scan is the right trade.
func (s *Samples) coldBody(ctx context.Context, userID uuid.UUID, ingestID []byte) ([]byte, time.Time, error) {
	want := hex.EncodeToString(ingestID)
	sealer := blob.Sealer(blob.PlaintextSealer{})
	if s.Sealer != nil {
		sealer = s.Sealer
	}
	after := int64(0)
	for {
		rows, err := oplog.Read(ctx, s.Pool, userID, blob.StreamCold, after, coldPageRows, coldPageBytes)
		if err != nil {
			return nil, time.Time{}, sanitize("read the cold stream", err)
		}
		if len(rows) == 0 {
			return nil, time.Time{}, ErrNotIngested
		}
		for _, row := range rows {
			after = row.Seq
			pt, err := sealer.Open(blob.Envelope{
				UserID: userID, Stream: row.Stream,
				WriterID: row.WriterID, WriterCounter: row.WriterCounter,
			}, blob.Sealed{Bytes: row.Blob, SizeBucket: row.SizeBucket})
			if err != nil {
				return nil, time.Time{}, fmt.Errorf("samples: open the cold blob at seq %d: %w", row.Seq, err)
			}
			rb, err := oplog.DecodeRawBody(pt)
			if err != nil {
				return nil, time.Time{}, fmt.Errorf("samples: cold blob at seq %d: %w", row.Seq, err)
			}
			if rb.IngestID != want {
				continue
			}
			// DecodeRawBody already validated the payload as standard base64.
			raw, err := base64.StdEncoding.DecodeString(rb.RawBase64)
			if err != nil {
				return nil, time.Time{}, fmt.Errorf("samples: cold blob at seq %d: %w", row.Seq, err)
			}
			if len(raw) == 0 || len(raw) > blob.MaxColdMail {
				return nil, time.Time{}, fmt.Errorf("samples: the stored body for that message is %d bytes", len(raw))
			}
			return raw, rb.ReceivedAt, nil
		}
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const clustersSQL = `
SELECT sender_domain,
       structure_sig,
       count(DISTINCT user_id)                    AS user_count,
       count(*)                                   AS sample_count,
       count(*) FILTER (WHERE raw IS NOT NULL)    AS donated_count,
       min(created_at)                            AS first_seen
  FROM donated_samples
 GROUP BY sender_domain, structure_sig
 ORDER BY user_count DESC, sample_count DESC, sender_domain, structure_sig`

// Clusters is the operator's demand view, ordered by how many PEOPLE are
// hitting each format. It reads no bodies and returns no content.
func (s *Samples) Clusters(ctx context.Context) ([]Cluster, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, clustersSQL)
	if err != nil {
		return nil, sanitize("cluster donated samples", err)
	}
	defer rows.Close()
	out := []Cluster{}
	for rows.Next() {
		var c Cluster
		if err := rows.Scan(&c.SenderDomain, &c.StructureSig,
			&c.UserCount, &c.SampleCount, &c.DonatedCount, &c.FirstSeen); err != nil {
			return nil, sanitize("cluster donated samples", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, sanitize("cluster donated samples", err)
	}
	return out, nil
}

// forSenderSQL matches the domain and its SUBDOMAINS, which is
// tmpl.MatchesSenderDomain's rule spelled in SQL: dib.ae covers alerts.dib.ae
// and does not cover evildib.ae. The LIKE pattern is safe because the parameter
// has already been checked against reHostname, whose grammar contains neither
// '%' nor '_'.
const forSenderSQL = `
SELECT id, user_id, sender_domain, structure_sig, ingest_id, raw, received_at,
       consent, consented_at, created_at, expires_at
  FROM donated_samples
 WHERE raw IS NOT NULL
   AND (sender_domain = $1 OR sender_domain LIKE '%.' || $1)
 ORDER BY created_at, id`

// ForSender returns the replayable corpus for one sender domain: the samples a
// candidate template is validated against and the ones a publish must not
// regress.
//
// Content-free reports are NOT included. There is nothing to replay over a
// fingerprint, and counting one as a sample would make a publish report claim
// it validated against mail it never saw.
func (s *Samples) ForSender(ctx context.Context, domain string) ([]Sample, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	if !reHostname.MatchString(domain) {
		return nil, fmt.Errorf("%w: %q is not a hostname", ErrInvalidSample, domain)
	}
	rows, err := s.Pool.Query(ctx, forSenderSQL, domain)
	if err != nil {
		return nil, sanitize("read the donated corpus", err)
	}
	defer rows.Close()
	out := []Sample{}
	for rows.Next() {
		var (
			sample     Sample
			consent    *string
			consented  *time.Time
			receivedAt *time.Time
		)
		if err := rows.Scan(&sample.ID, &sample.UserID, &sample.SenderDomain, &sample.StructureSig,
			&sample.IngestID, &sample.Raw, &receivedAt,
			&consent, &consented, &sample.CreatedAt, &sample.ExpiresAt); err != nil {
			return nil, sanitize("read the donated corpus", err)
		}
		if receivedAt != nil {
			sample.ReceivedAt = *receivedAt
		}
		if consent != nil {
			sample.Consent = *consent
		}
		if consented != nil {
			sample.ConsentedAt = *consented
		}
		out = append(out, sample)
	}
	if err := rows.Err(); err != nil {
		return nil, sanitize("read the donated corpus", err)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// Retire deletes one sample and reports whether there was one to delete.
//
// It is the escape hatch the publish gate's absolute refusal depends on. The
// gate has no force flag on purpose — a flag to skip a regression check becomes
// the habit — so an operator who genuinely means to stop parsing a format has
// to say which mail they are dropping, one message at a time.
func (s *Samples) Retire(ctx context.Context, id uuid.UUID) (bool, error) {
	if err := s.check(); err != nil {
		return false, err
	}
	tag, err := s.Pool.Exec(ctx, `DELETE FROM donated_samples WHERE id = $1`, id)
	if err != nil {
		return false, sanitize("retire a donated sample", err)
	}
	return tag.RowsAffected() > 0, nil
}

// ExpireDue deletes every sample past its expiry and returns how many went.
//
// There is no warning and no grace period, unlike quarantine's sweep, and the
// difference is whose copy this is: quarantine holds the ONLY copy of a message
// the user has not seen yet, while a donated sample is a duplicate of mail that
// is already in the donor's own log. Deleting it takes nothing away from them.
func (s *Samples) ExpireDue(ctx context.Context) (int, error) {
	if err := s.check(); err != nil {
		return 0, err
	}
	tag, err := s.Pool.Exec(ctx, `DELETE FROM donated_samples WHERE expires_at <= $1`, s.now())
	if err != nil {
		return 0, sanitize("expire donated samples", err)
	}
	return int(tag.RowsAffected()), nil
}

// sanitize wraps a database error with what was being attempted and nothing
// about the row. A pgx error can carry the offending VALUE in its detail, and
// the values in this package are real mail.
func sanitize(op string, err error) error {
	return fmt.Errorf("samples: %s: %w", op, err)
}
