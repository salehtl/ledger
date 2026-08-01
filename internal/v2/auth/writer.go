package auth

// Writers, the key-history log, and challenge-based registration.
//
// # What this file is defending
//
// Spec §3.4's capability rule: "registering a new writer requires proof of key
// possession (a challenge sealed to an enrolled key) and is recorded in the
// key-history log — a stolen session token cannot inject a writer whose ops
// other devices would replay." A writer is an identity that appears in every
// op_log row and in every blob's AAD; a writer the attacker controls is ops the
// victim's own devices will fold into their state. A session token is
// deliberately weaker than that (see the package doc), so this package's job is
// to make the session token NOT the thing that authorizes an enrollment.
//
// The authorization is a signature by an ALREADY-ENROLLED, non-revoked device
// key over a server-issued single-use challenge — and, crucially, over the
// enrollment being requested. See RegistrationMessage.
//
// # Residual trust, stated plainly
//
// The very first writer of an account has nothing to sign under: there is no
// enrolled key yet. That registration is a self-signature — trust on first use.
// Spec §3.4 accepts this ("a fresh device's first bootstrap trusts the server
// unless a prior device verifies it") and bounds it three ways:
//
//   - It is available exactly ONCE per account, keyed on whether a device
//     writer has EVER existed, not on whether one is currently live. Revoking
//     the last device does not reopen it (TestBootstrapIsAvailableOnlyOnce).
//     Otherwise a stolen session would only need to provoke a revocation.
//   - It is recorded in key_history like every other enrollment, so a second
//     device comparing key-history heads (§3.4's cross-device comparison code)
//     sees a bootstrap it did not perform.
//   - Nothing here bootstraps silently: an account whose bootstrap was spent by
//     an attacker cannot enroll the real device at all, which is a loud failure
//     rather than a shared account.
//
// The consequence to be honest about: a user who loses every enrolled device
// cannot enroll a new one through this API. There is no self-service
// re-bootstrap, because a re-bootstrap is indistinguishable from the attack
// this whole mechanism exists to stop. Recovery of the DATA is the client-side
// recovery phrase (§3.4); recovery of WRITE capability after total device loss
// needs an out-of-band operator action, which must itself land in key_history
// where peers can see it. That path is not built here.
//
// The same wall stands one tap closer than device loss: a user who revokes
// their LAST live device — a legitimate thing to want before selling a phone —
// permanently loses write capability WHILE STILL HOLDING THE KEY. Re-enrolling
// that device returns ErrWriterExists (the id is taken) and enrolling it under
// a new id returns ErrKeyAlreadyEnrolled (the key is taken), and neither is a
// bug: a revoked key must not be able to reinstate itself, or revocation would
// mean nothing. A client must therefore refuse to revoke the last live device
// without enrolling a replacement first. Nothing on the server enforces that
// today; see the task report's concerns.
//
// key_history is also server-attested, not self-authenticating: it records what
// happened, not a proof of it. A compromised server can append a fabricated
// entry, which §3.4 already concedes ("cannot make key substitution impossible,
// only detectable"). Storing the authorizing signature alongside each entry
// would upgrade peer audit from "compare heads" to "verify locally"; it is not
// in the Phase 1 schema and is recorded as a follow-up.
//
// # What the append-only guard on key_history actually binds
//
// The trigger in 00003_writers.sql refuses UPDATE, TRUNCATE, and DELETE-while-
// the-user-exists for EVERY role, superusers included — triggers cannot be
// skipped. What it cannot stop is the table's OWNER, who needs no more than
// `ALTER TABLE ... DISABLE TRIGGER` to switch it off first and then rewrite the
// log freely.
//
// That matters right now, because cmd/ledgerd opens ONE pool from
// cfg.Server.DSN and runs pg.Migrate on it: the role that serves requests is
// the role that created these tables, so today it owns them and the guard does
// not bind it. The fix belongs to deployment, not to this package — migrate as
// a separate owner role and grant the runtime role only DML — and
// TestKeyHistoryGuardBindsANonOwnerRuntimeRole pins both halves of that
// requirement so it is executable rather than a sentence in a report.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"filippo.io/edwards25519"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Writer kinds and the one reserved writer id. These strings are also the CHECK
// constraint on writers.kind, so they are a closed vocabulary.
const (
	// KindDevice is a client writer holding an Ed25519 identity key.
	KindDevice = "device"
	// KindIngest is the server's own writer. It has no key: its chain proves
	// storage integrity, never operator honesty (spec §3.3(b)).
	KindIngest = "ingest"
	// IngestWriterID is the fixed writer id of every user's ingest writer. It
	// is reserved: a client registering under it would be laundering its own
	// ops into the provenance the UI labels "server-ingested".
	IngestWriterID = "ingest"
)

// key_history event vocabulary, matching that table's CHECK constraint.
const (
	EventRegistered = "registered"
	EventRevoked    = "revoked"
)

const (
	// ChallengeNonceBytes is 32 (256 bits) from crypto/rand. The requirement is
	// "not guessable and not replayable"; 128 bits is the floor and this is
	// double it, at a cost of 16 bytes per registration attempt.
	ChallengeNonceBytes = 32
	// ChallengeTTL bounds how long a captured challenge is worth anything. It
	// is short because the legitimate flow — a device signs the challenge it
	// just asked for — takes milliseconds, and every second beyond that is only
	// useful to someone who intercepted it.
	ChallengeTTL = 5 * time.Minute
	// maxWriterIDLen matches the CHECK constraint on writers.writer_id.
	maxWriterIDLen = 64
	// challengeRetention is how long a spent or expired challenge is kept
	// before the opportunistic sweep in Challenge removes it. Well beyond the
	// TTL on purpose: while the row exists, a replay is refused as "already
	// used", which is a far more useful log line than "unknown nonce".
	challengeRetention = 24 * time.Hour
)

// Domain separation prefixes. A device identity key signs more than one kind of
// statement, and without distinct prefixes a signature collected in one context
// is a valid signature in the other — a "retire this device" signature would
// double as an enrollment. Both end in a NUL that cannot appear in the ASCII
// domain label itself, so the prefix can never be confused with the start of
// the payload.
const (
	registrationDomain = "ledger-v2-writer-registration\x00"
	revocationDomain   = "ledger-v2-writer-revocation\x00"
)

// Registration rejection reasons. All of them wrap ErrRegistrationRejected, so
// a caller can ask the single question it cares about, and the HTTP layer must
// return the SAME status for all of them: which one it was tells an attacker
// whether a nonce exists, whether a writer id is taken, and whether a key is
// enrolled — none of which it is entitled to learn.
var (
	ErrRegistrationRejected = errors.New("auth: writer registration rejected")
	ErrChallengeUnknown     = fmt.Errorf("%w: no such challenge for this user", ErrRegistrationRejected)
	ErrChallengeUsed        = fmt.Errorf("%w: challenge already used", ErrRegistrationRejected)
	ErrChallengeExpired     = fmt.Errorf("%w: challenge expired", ErrRegistrationRejected)
	// ErrNotAuthorized is the one that carries the whole capability rule: the
	// signature did not verify under a key that is allowed to authorize this.
	ErrNotAuthorized      = fmt.Errorf("%w: no enrolled key authorized this", ErrRegistrationRejected)
	ErrWriterIDReserved   = fmt.Errorf("%w: writer id is reserved for the server", ErrRegistrationRejected)
	ErrWriterIDInvalid    = fmt.Errorf("%w: writer id is not well formed", ErrRegistrationRejected)
	ErrWriterExists       = fmt.Errorf("%w: writer id is already registered", ErrRegistrationRejected)
	ErrKeyAlreadyEnrolled = fmt.Errorf("%w: public key is already enrolled as another writer", ErrRegistrationRejected)
	ErrNoSuchWriter       = fmt.Errorf("%w: no such writer", ErrRegistrationRejected)
	// ErrKeyUnusable is a public key that is not a usable Ed25519 identity —
	// see checkPublicKey, which explains why length alone is not enough.
	ErrKeyUnusable = fmt.Errorf("%w: public key is not a usable Ed25519 identity", ErrRegistrationRejected)
)

// checkPublicKey rejects a public key that cannot carry the property this
// package depends on: that a valid signature under it proves possession of a
// private key.
//
// A 32-byte length check is NOT enough. The Ed25519 identity point (0x01
// followed by 31 zero bytes) is a valid encoding of a valid curve point, and
// crypto/ed25519 — like most implementations — accepts the signature
// `identity || 32 zero bytes` under it for EVERY message. Nobody needs a
// private key to write those 64 bytes down. A writer enrolled with such a key
// is therefore a writer that ANY holder of a session for that account can sign
// for, forever: the forgery is message-independent, so it satisfies every later
// registration and revocation too. That is a total collapse of the capability
// rule this package exists to enforce, so the check runs before any signature
// is verified and again for every key read back out of the roster.
//
// The test is the standard one: decode the point, multiply by the cofactor (8),
// and reject if the result is the identity — which is true for exactly the
// points of small order, in any encoding. edwards25519.Point.SetBytes accepts
// non-canonical encodings, matching what crypto/ed25519 itself will accept, so
// there is no encoding a caller can pick that slips past here and is still
// honoured by Verify.
func checkPublicKey(pub ed25519.PublicKey) error {
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("%w: %d bytes, want %d", ErrKeyUnusable, len(pub), ed25519.PublicKeySize)
	}
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil {
		return fmt.Errorf("%w: not a curve point", ErrKeyUnusable)
	}
	if new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return fmt.Errorf("%w: small-order point (signatures under it are forgeable by anyone)", ErrKeyUnusable)
	}
	return nil
}

// Writer is one row of a user's writer roster.
type Writer struct {
	UserID   uuid.UUID
	WriterID string
	Kind     string
	// PubKey is nil for the ingest writer, which has no key by design.
	PubKey       ed25519.PublicKey
	RegisteredAt time.Time
	// RevokedAt is the zero time while the writer is live.
	RevokedAt time.Time
}

// Live reports whether this writer may still authorize anything.
func (w Writer) Live() bool { return w.RevokedAt.IsZero() }

// Writers owns writer registration, revocation and the key-history log.
//
// It holds no state beyond its dependencies — no cache, no per-process
// singleton, nothing that must be shared — so constructing one per request is
// correct and free. (Contrast NewOIDCVerifier, whose JWKS cache means one
// verifier per process.)
type Writers struct {
	Pool *pgxpool.Pool
	// Now defaults to time.Now. Challenge expiry is evaluated against THIS
	// clock and never against Postgres's now(), so one clock decides both when
	// a challenge was minted and when it dies — and a test can advance it.
	Now func() time.Time
}

func (w *Writers) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

// RegistrationMessage returns the exact bytes a device signs to enroll itself
// or another writer. The client (Task 14) reimplements this; it is exported so
// the two cannot drift silently, and TestRegistrationMessageEncodingIsPinned...
// pins the bytes.
//
//	"ledger-v2-writer-registration\x00" || nonce || 0x00 || writerID || 0x00 || pubkey
//
// # Why the message is not just the nonce
//
// The first draft of this mechanism verified ed25519.Verify(enrolledKey, nonce,
// sig). That proves possession of an enrolled key, but it authorizes "some
// enrollment" rather than THIS enrollment: anyone who observes such a signature
// can present it again with a different writer id and a different public key,
// and enroll a writer of their choosing. Binding all three fields means a
// captured signature authorizes exactly the enrollment it was produced for, and
// nothing else.
//
// # Why this encoding is unambiguous
//
// Naive concatenation with a separator is ambiguous whenever a field can
// contain the separator. Here it cannot matter: nonce is always exactly
// ChallengeNonceBytes and pubkey always ed25519.PublicKeySize — Register
// enforces both before it verifies anything — so writerID is the only
// variable-length field, pinned between two fixed-length ones. Its extent is
// determined by the total length regardless of its contents, so no two distinct
// (nonce, writerID, pubkey) triples encode to the same bytes. (writerID is
// additionally constrained to [A-Za-z0-9._-]{1,64} at both this layer and the
// database, so in practice it contains no separator either.)
func RegistrationMessage(nonce []byte, writerID string, pub ed25519.PublicKey) []byte {
	return signingMessage(registrationDomain, nonce, writerID, pub)
}

// RevocationMessage returns the bytes a device signs to retire a writer. The
// target writer id is the last field and the only variable-length one, so the
// same unambiguity argument as RegistrationMessage applies.
func RevocationMessage(nonce []byte, writerID string) []byte {
	return signingMessage(revocationDomain, nonce, writerID, nil)
}

func signingMessage(domain string, nonce []byte, writerID string, pub ed25519.PublicKey) []byte {
	msg := make([]byte, 0, len(domain)+len(nonce)+1+len(writerID)+1+len(pub))
	msg = append(msg, domain...)
	msg = append(msg, nonce...)
	msg = append(msg, 0x00)
	msg = append(msg, writerID...)
	if pub != nil {
		msg = append(msg, 0x00)
		msg = append(msg, pub...)
	}
	return msg
}

// validWriterID mirrors the writers_writer_id_charset CHECK constraint. It runs
// in Go as well as in the database because a writer id ends up inside signed
// messages and blob AAD, where an encoding surprise is a security question and
// not a data-quality one.
func validWriterID(id string) bool {
	if id == "" || len(id) > maxWriterIDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// Challenge mints a single-use registration challenge for userID.
//
// Obtaining a challenge is exactly what a session token authorizes, and nothing
// more: the challenge is worthless without a signature from an enrolled key.
func (w *Writers) Challenge(ctx context.Context, userID uuid.UUID) ([]byte, error) {
	if w.Pool == nil {
		return nil, errors.New("auth: Writers.Pool is nil")
	}
	if userID == uuid.Nil {
		return nil, errors.New("auth: writer challenge: user id is zero")
	}
	nonce := make([]byte, ChallengeNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		// Unreachable on Go 1.25 (crypto/rand panics rather than failing), but
		// a short or zero nonce would be a replayable challenge, so this is
		// checked rather than assumed.
		return nil, fmt.Errorf("auth: writer challenge: read random: %w", err)
	}
	now := w.now()
	_, err := w.Pool.Exec(ctx,
		`INSERT INTO writer_challenges (nonce, user_id, issued_at, expires_at) VALUES ($1,$2,$3,$4)`,
		nonce, userID, now, now.Add(ChallengeTTL))
	if err != nil {
		return nil, fmt.Errorf("auth: writer challenge for user %s: %w", userID, err)
	}
	// Opportunistic sweep. Anyone holding a session can mint challenges, so
	// without this the table grows without bound. The cutoff is a full
	// retention period PAST expiry, so this can only ever remove a row that is
	// already worthless — a live, unspent challenge is never in range — and a
	// failed sweep is a housekeeping miss rather than a security event, because
	// the property that refuses a replay is used_at on the row, not the row's
	// absence.
	_, _ = w.Pool.Exec(ctx,
		`DELETE FROM writer_challenges WHERE expires_at < $1`, now.Add(-challengeRetention))
	return nonce, nil
}

// consumeChallenge spends a challenge, atomically and exactly once.
//
// The single UPDATE below is the whole concurrency argument. It is a
// test-and-set on one row identified by primary key: two concurrent attempts on
// the same nonce serialize on that row's lock, and under READ COMMITTED the
// loser re-evaluates `used_at IS NULL` against the version the winner committed
// (EvalPlanQual), finds it no longer matches, and returns zero rows. There is
// no window between the read and the write for a second caller to slip into,
// because there is no separate read.
//
// It runs OUTSIDE the registration transaction on purpose: a challenge is spent
// by the attempt, not by the success. If it were rolled back along with a
// failed registration, one challenge would buy unlimited attempts.
//
// Expiry is checked in Go afterwards rather than in the WHERE clause, so an
// expired challenge is still consumed (and so that one injectable clock decides
// both minting and expiry, as in Sessions).
func (w *Writers) consumeChallenge(ctx context.Context, userID uuid.UUID, nonce []byte) error {
	var expires time.Time
	err := w.Pool.QueryRow(ctx,
		`UPDATE writer_challenges SET used_at = $3
		  WHERE nonce = $1 AND user_id = $2 AND used_at IS NULL
		 RETURNING expires_at`,
		nonce, userID, w.now()).Scan(&expires)
	if errors.Is(err, pgx.ErrNoRows) {
		// Separate "already spent" from "never existed, or belongs to another
		// user" for the operator's log. Both are the same rejection to the
		// caller, and the second query is scoped to userID so it cannot be used
		// to probe another account's challenges.
		var used *time.Time
		if e := w.Pool.QueryRow(ctx,
			`SELECT used_at FROM writer_challenges WHERE nonce = $1 AND user_id = $2`,
			nonce, userID).Scan(&used); e == nil && used != nil {
			return ErrChallengeUsed
		}
		return ErrChallengeUnknown
	}
	if err != nil {
		return fmt.Errorf("auth: consume writer challenge: %w", err)
	}
	if !expires.After(w.now()) {
		return ErrChallengeExpired
	}
	return nil
}

// Register enrolls a writer for userID.
//
// sig must be an Ed25519 signature over RegistrationMessage(nonce, writerID,
// pub), produced by:
//
//   - pub itself, if and only if this user has never had a device writer (the
//     TOFU bootstrap — see the residual-trust note at the top of this file); or
//   - any already-enrolled, non-revoked device key of this user.
//
// A live session token is a precondition for obtaining the nonce and is not an
// input here: by construction, holding one cannot enroll anything.
//
// writerID must match [A-Za-z0-9._-]{1,64} and may not be IngestWriterID.
func (w *Writers) Register(ctx context.Context, userID uuid.UUID, writerID string, pub ed25519.PublicKey, nonce, sig []byte) error {
	if err := w.checkArgs(userID, writerID, nonce, sig); err != nil {
		return err
	}
	// Screened here, before a challenge is spent: a small-order key is a
	// malformed request, not a failed authorization.
	if err := checkPublicKey(pub); err != nil {
		return err
	}

	// Spent before anything else can fail, so one challenge buys one attempt.
	if err := w.consumeChallenge(ctx, userID, nonce); err != nil {
		return err
	}
	msg := RegistrationMessage(nonce, writerID, pub)

	tx, err := w.begin(ctx)
	if err != nil {
		return err
	}
	defer w.rollback(ctx, tx)

	// Lock the user row for the duration. Registration is rare and this is the
	// cheapest way to make the bootstrap decision safe: without it, two
	// concurrent first registrations both observe an empty roster and both
	// self-sign their way in, which is the one thing "TOFU happens once" must
	// not permit.
	roster, err := w.lockAndLoad(ctx, tx, userID)
	if err != nil {
		return err
	}

	// hadDevice tracks whether this user has EVER enrolled a device, revoked
	// ones included; enrolled holds only the keys that may authorize today.
	// Nothing returns from this loop: the duplicate findings are recorded and
	// reported only AFTER authorization, so a caller that cannot prove key
	// possession learns nothing about which writer ids and keys exist.
	var enrolled []ed25519.PublicKey
	var hadDevice, idTaken, keyTaken bool
	for _, r := range roster {
		if r.WriterID == writerID {
			idTaken = true
		}
		if r.Kind != KindDevice {
			continue
		}
		hadDevice = true
		if r.PubKey.Equal(pub) {
			keyTaken = true
		}
		if r.Live() {
			enrolled = append(enrolled, r.PubKey)
		}
	}

	// The authorization decision, in full.
	//
	// hadDevice, not len(enrolled) == 0: the bootstrap window closes the first
	// time a device is enrolled and never reopens, so revoking the last device
	// cannot hand a stolen session a self-signed enrollment.
	if !hadDevice {
		if !verifiedBy(pub, msg, sig) {
			return fmt.Errorf("%w (first writer: the key being enrolled must sign for itself)", ErrNotAuthorized)
		}
	} else if !verifiedByAny(enrolled, msg, sig) {
		return ErrNotAuthorized
	}
	if idTaken {
		return ErrWriterExists
	}
	if keyTaken {
		return ErrKeyAlreadyEnrolled
	}

	now := w.now()
	if _, err := tx.Exec(ctx,
		`INSERT INTO writers (user_id, writer_id, kind, pubkey, registered_at)
		 VALUES ($1,$2,$3,$4,$5)`,
		userID, writerID, KindDevice, []byte(pub), now); err != nil {
		return fmt.Errorf("auth: register writer %s for user %s: %w", writerID, userID, err)
	}
	if err := appendKeyHistory(ctx, tx, userID, writerID, pub, EventRegistered, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: register writer: commit: %w", err)
	}
	return nil
}

// Revoke retires a writer. sig must be an Ed25519 signature over
// RevocationMessage(nonce, writerID) by an already-enrolled, non-revoked device
// key of this user — including the target's own key, which is the ordinary
// "retire this device" flow.
//
// There is deliberately no bootstrap path here. If an unenrolled key could
// revoke, a stolen session could retire every device the user owns; that is
// both a denial of service and, under any scheme where an empty roster reopens
// TOFU, a complete bypass.
//
// It is idempotent: revoking an already-revoked writer succeeds without
// appending a second key_history entry.
func (w *Writers) Revoke(ctx context.Context, userID uuid.UUID, writerID string, nonce, sig []byte) error {
	if err := w.checkArgs(userID, writerID, nonce, sig); err != nil {
		return err
	}
	if err := w.consumeChallenge(ctx, userID, nonce); err != nil {
		return err
	}
	msg := RevocationMessage(nonce, writerID)

	tx, err := w.begin(ctx)
	if err != nil {
		return err
	}
	defer w.rollback(ctx, tx)

	roster, err := w.lockAndLoad(ctx, tx, userID)
	if err != nil {
		return err
	}
	var (
		enrolled []ed25519.PublicKey
		target   *Writer
	)
	for i, r := range roster {
		if r.WriterID == writerID {
			target = &roster[i]
		}
		if r.Kind == KindDevice && r.Live() {
			enrolled = append(enrolled, r.PubKey)
		}
	}
	// Authorization first, existence second: otherwise the error text tells a
	// caller that cannot prove key possession which writer ids exist.
	if !verifiedByAny(enrolled, msg, sig) {
		return ErrNotAuthorized
	}
	if target == nil {
		return ErrNoSuchWriter
	}
	if !target.Live() {
		return nil // already revoked; do not append a second entry
	}

	now := w.now()
	tag, err := tx.Exec(ctx,
		`UPDATE writers SET revoked_at = $3
		  WHERE user_id = $1 AND writer_id = $2 AND revoked_at IS NULL`,
		userID, writerID, now)
	if err != nil {
		return fmt.Errorf("auth: revoke writer %s for user %s: %w", writerID, userID, err)
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if err := appendKeyHistory(ctx, tx, userID, writerID, target.PubKey, EventRevoked, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: revoke writer: commit: %w", err)
	}
	return nil
}

// EnsureIngestWriter creates this user's server-side writer if it does not
// exist and returns its id. It is idempotent and appends to key_history only on
// the call that actually creates the row.
//
// No challenge and no signature: this writer is the server's own, it holds no
// key, and its chain is explicitly not evidence about the operator (§3.3(b)).
// It is created by the ingest path, never by a client request.
func (w *Writers) EnsureIngestWriter(ctx context.Context, userID uuid.UUID) (string, error) {
	if w.Pool == nil {
		return "", errors.New("auth: Writers.Pool is nil")
	}
	if userID == uuid.Nil {
		return "", errors.New("auth: ensure ingest writer: user id is zero")
	}
	tx, err := w.begin(ctx)
	if err != nil {
		return "", err
	}
	defer w.rollback(ctx, tx)

	now := w.now()
	var created bool
	err = tx.QueryRow(ctx,
		`INSERT INTO writers (user_id, writer_id, kind, pubkey, registered_at)
		 VALUES ($1,$2,$3,NULL,$4)
		 ON CONFLICT (user_id, writer_id) DO NOTHING
		 RETURNING true`,
		userID, IngestWriterID, KindIngest, now).Scan(&created)
	if errors.Is(err, pgx.ErrNoRows) {
		// Already present. Nothing was written, so the deferred rollback is the
		// whole cleanup.
		return IngestWriterID, nil
	}
	if err != nil {
		return "", fmt.Errorf("auth: ensure ingest writer for user %s: %w", userID, err)
	}
	if err := appendKeyHistory(ctx, tx, userID, IngestWriterID, nil, EventRegistered, now); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("auth: ensure ingest writer: commit: %w", err)
	}
	return IngestWriterID, nil
}

// Roster returns every writer of a user, revoked ones included. A peer device
// needs the revoked entries: "this writer was retired" and "this writer was
// never here" are different facts when auditing a chain.
func (w *Writers) Roster(ctx context.Context, userID uuid.UUID) ([]Writer, error) {
	if w.Pool == nil {
		return nil, errors.New("auth: Writers.Pool is nil")
	}
	rows, err := w.Pool.Query(ctx,
		`SELECT user_id, writer_id, kind, pubkey, registered_at, revoked_at
		   FROM writers WHERE user_id = $1 ORDER BY registered_at, writer_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: roster for user %s: %w", userID, err)
	}
	defer rows.Close()
	return scanWriters(rows)
}

// lockAndLoad takes the user's row lock and reads the whole roster inside the
// caller's transaction. Every authorization decision in this file is made
// against what it returns, so it must be read under the lock and not before it.
func (w *Writers) lockAndLoad(ctx context.Context, tx pgx.Tx, userID uuid.UUID) ([]Writer, error) {
	var locked uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: no such user", ErrRegistrationRejected)
	}
	if err != nil {
		return nil, fmt.Errorf("auth: lock user %s: %w", userID, err)
	}
	rows, err := tx.Query(ctx,
		`SELECT user_id, writer_id, kind, pubkey, registered_at, revoked_at
		   FROM writers WHERE user_id = $1 ORDER BY registered_at, writer_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: read roster for user %s: %w", userID, err)
	}
	defer rows.Close()
	return scanWriters(rows)
}

func scanWriters(rows pgx.Rows) ([]Writer, error) {
	var out []Writer
	for rows.Next() {
		var (
			wr      Writer
			pub     []byte
			revoked *time.Time
		)
		if err := rows.Scan(&wr.UserID, &wr.WriterID, &wr.Kind, &pub, &wr.RegisteredAt, &revoked); err != nil {
			return nil, fmt.Errorf("auth: scan writer: %w", err)
		}
		if pub != nil {
			wr.PubKey = ed25519.PublicKey(pub)
		}
		if revoked != nil {
			wr.RevokedAt = *revoked
		}
		out = append(out, wr)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: read writers: %w", err)
	}
	return out, nil
}

// appendKeyHistory is the ONLY write to key_history in this package, and it is
// an INSERT. There is deliberately no UPDATE or DELETE path anywhere in the
// codebase; the table additionally refuses both at the database (see the
// key_history_no_rewrite trigger in 00003_writers.sql), because "no code does
// it" stops being true the moment someone writes a repair script.
func appendKeyHistory(ctx context.Context, tx pgx.Tx, userID uuid.UUID, writerID string, pub ed25519.PublicKey, event string, at time.Time) error {
	var key []byte
	if pub != nil {
		key = []byte(pub)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO key_history (user_id, writer_id, pubkey, event, at) VALUES ($1,$2,$3,$4,$5)`,
		userID, writerID, key, event, at); err != nil {
		return fmt.Errorf("auth: append key history (%s %s): %w", event, writerID, err)
	}
	return nil
}

// verifiedBy is the ONLY place a signature is ever checked. Every path goes
// through the small-order screen first, including keys read back from the
// roster: a row planted by a repair script, or enrolled before checkPublicKey
// existed, must not be able to authorize anything either.
func verifiedBy(key ed25519.PublicKey, msg, sig []byte) bool {
	if checkPublicKey(key) != nil {
		return false
	}
	return ed25519.Verify(key, msg, sig)
}

// verifiedByAny reports whether the signature verifies under any of the keys.
// ed25519.Verify is constant time in the key material; the loop leaks only how
// many keys a user has enrolled, which the roster endpoint returns anyway.
func verifiedByAny(keys []ed25519.PublicKey, msg, sig []byte) bool {
	for _, k := range keys {
		if verifiedBy(k, msg, sig) {
			return true
		}
	}
	return false
}

// checkArgs rejects everything that cannot possibly be a valid request, BEFORE
// a challenge is spent. A malformed call must not burn the user's challenge —
// that would turn a client bug into a registration that can never complete.
func (w *Writers) checkArgs(userID uuid.UUID, writerID string, nonce, sig []byte) error {
	switch {
	case w.Pool == nil:
		return errors.New("auth: Writers.Pool is nil")
	case userID == uuid.Nil:
		return fmt.Errorf("%w: user id is zero", ErrRegistrationRejected)
	case writerID == IngestWriterID:
		return ErrWriterIDReserved
	case !validWriterID(writerID):
		return ErrWriterIDInvalid
	case len(nonce) != ChallengeNonceBytes:
		// Also what makes RegistrationMessage's encoding unambiguous: the
		// nonce's length is fixed here, before any message is built.
		return fmt.Errorf("%w: nonce is %d bytes, want %d", ErrRegistrationRejected, len(nonce), ChallengeNonceBytes)
	case len(sig) != ed25519.SignatureSize:
		return fmt.Errorf("%w: signature is %d bytes, want %d", ErrRegistrationRejected, len(sig), ed25519.SignatureSize)
	}
	return nil
}

// begin pins READ COMMITTED rather than inheriting it, for the same reason
// oplog.Append and UpsertUser do: default_transaction_isolation is settable per
// database, per role and by a pooler. Under REPEATABLE READ the `SELECT ... FOR
// UPDATE` that serializes concurrent registrations would raise a serialization
// failure instead of blocking, turning a routine concurrent enrollment into an
// error whose text says nothing about what actually happened.
func (w *Writers) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := w.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("auth: writers: begin: %w", err)
	}
	return tx, nil
}

// rollback runs on a context detached from the caller's, so a cancelled request
// still releases the user row lock cleanly instead of leaving pgx to destroy
// the connection.
func (w *Writers) rollback(ctx context.Context, tx pgx.Tx) {
	rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(rbCtx)
}
