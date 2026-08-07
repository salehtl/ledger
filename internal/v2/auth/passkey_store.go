package auth

// Storage for passkey.go: the two tables 00025_passkeys.sql adds, and nothing
// else. It is a separate file for the same reason the SQL is a separate
// migration — the WebAuthn ceremony logic is intricate enough without the
// queries inlined through it, and every statement that touches a credential or a
// ceremony being in one place is what makes "is this single use?" answerable by
// reading rather than by grepping.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ceremonyKind is the closed vocabulary the CHECK constraint on
// webauthn_ceremonies.kind enforces. A ceremony is bound to its kind at mint
// time and claimed by kind at finish, so a registration ceremony can never be
// spent as a login: the two carry different authority (one creates an account)
// and a shared handle would be the way to launder that difference.
type ceremonyKind string

const (
	ceremonyRegister ceremonyKind = "register"
	ceremonyLogin    ceremonyKind = "login"
	ceremonyAdd      ceremonyKind = "add"
)

// ceremony is one row of webauthn_ceremonies, as read back by claimCeremony.
type ceremony struct {
	ID          string
	Kind        ceremonyKind
	UserID      *uuid.UUID
	UserHandle  []byte
	Session     webauthn.SessionData
	InviteHash  []byte
	ExpiresAt   time.Time
	sessionJSON []byte
}

// putCeremony records a ceremony that has just begun.
func (p *Passkeys) putCeremony(ctx context.Context, c ceremony) error {
	raw, err := json.Marshal(c.Session)
	if err != nil {
		return fmt.Errorf("auth: passkey: marshal session data: %w", err)
	}
	now := p.now()
	var handle, invite any
	if len(c.UserHandle) > 0 {
		handle = c.UserHandle
	}
	if len(c.InviteHash) > 0 {
		invite = c.InviteHash
	}
	if _, err := p.Pool.Exec(ctx,
		`INSERT INTO webauthn_ceremonies (id, kind, user_id, user_handle, session_data, invite_code_hash, created_at, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		c.ID, string(c.Kind), c.UserID, handle, raw, invite, now, now.Add(CeremonyTTL)); err != nil {
		return fmt.Errorf("auth: passkey: record ceremony: %w", err)
	}
	return nil
}

// claimCeremony consumes a ceremony: it is read and DELETED in one statement, so
// a replay of the same id finds nothing.
//
// The delete is the claim, not a cleanup that follows one. A read-then-delete
// would leave a window in which two concurrent finishes both see the row, and
// the whole point of the challenge inside it is that it is spendable once.
//
// Expiry is evaluated in Go against p.now() rather than in the WHERE clause
// against Postgres's now(), because expires_at was written from p.now() too —
// two clocks deciding one fact is the defect 00022 exists to record. A row that
// is claimed and found expired stays deleted: it was single-use and it has now
// been used, which is the right outcome for a caller who took too long.
func (p *Passkeys) claimCeremony(ctx context.Context, id string, kind ceremonyKind) (ceremony, error) {
	if id == "" {
		return ceremony{}, ErrCeremonyUnknown
	}
	var c ceremony
	err := p.Pool.QueryRow(ctx,
		`DELETE FROM webauthn_ceremonies WHERE id = $1 AND kind = $2
		 RETURNING id, kind, user_id, user_handle, session_data, invite_code_hash, expires_at`,
		id, string(kind)).Scan(&c.ID, &c.Kind, &c.UserID, &c.UserHandle, &c.sessionJSON, &c.InviteHash, &c.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Unknown, already spent, or begun as a different kind. All one answer:
		// which of the three it was is an oracle in a response and is in the
		// operator log instead.
		return ceremony{}, ErrCeremonyUnknown
	}
	if err != nil {
		return ceremony{}, fmt.Errorf("auth: passkey: claim ceremony: %w", err)
	}
	if !c.ExpiresAt.After(p.now()) {
		return ceremony{}, fmt.Errorf("%w: ceremony expired at %s", ErrCeremonyUnknown, c.ExpiresAt.UTC())
	}
	if err := json.Unmarshal(c.sessionJSON, &c.Session); err != nil {
		return ceremony{}, fmt.Errorf("auth: passkey: decode session data: %w", err)
	}
	return c, nil
}

// ReapExpiredCeremonies deletes ceremonies past their expiry and reports how
// many it removed.
//
// It is called from cmd/ledgerd's sweep loop and NOT from the finish path, on
// the same reasoning as Sessions.ReapDeletedAccountTombstones: a sweep on a path
// an unauthenticated caller can reach is a way to make this server write. The
// bound is p.now(), the clock claimCeremony compares against.
func (p *Passkeys) ReapExpiredCeremonies(ctx context.Context) (int64, error) {
	if p.Pool == nil {
		return 0, errors.New("auth: Passkeys.Pool is nil")
	}
	tag, err := p.Pool.Exec(ctx, `DELETE FROM webauthn_ceremonies WHERE expires_at < $1`, p.now())
	if err != nil {
		return 0, fmt.Errorf("auth: passkey: reap ceremonies: %w", err)
	}
	return tag.RowsAffected(), nil
}

// storedCredential is one row of webauthn_credentials, in the shape the
// library's verification needs plus the two facts it does not carry (which
// account owns it, and under which handle).
type storedCredential struct {
	UserID     uuid.UUID
	UserHandle []byte
	Credential webauthn.Credential
}

// credentialByID looks a credential up by the rawId an assertion carried. It is
// the login path's entire "who is this": everything else — the handle, the
// account — hangs off this row.
func (p *Passkeys) credentialByID(ctx context.Context, credentialID []byte) (storedCredential, error) {
	var (
		sc         storedCredential
		signCount  int64
		aaguid     []byte
		transports *string
		be, bs     bool
	)
	err := p.Pool.QueryRow(ctx,
		`SELECT user_id, user_handle, public_key, sign_count, aaguid, transports, backup_eligible, backup_state
		   FROM webauthn_credentials WHERE credential_id = $1`, credentialID).
		Scan(&sc.UserID, &sc.UserHandle, &sc.Credential.PublicKey, &signCount, &aaguid, &transports, &be, &bs)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedCredential{}, ErrCredentialUnknown
	}
	if err != nil {
		return storedCredential{}, fmt.Errorf("auth: passkey: load credential: %w", err)
	}
	sc.Credential.ID = credentialID
	sc.Credential.Authenticator = webauthn.Authenticator{
		AAGUID: aaguid,
		// The column is bigint because Postgres has no unsigned types; the wire
		// value is a uint32 and is stored as-is, so the narrowing is exact.
		SignCount: uint32(signCount),
	}
	sc.Credential.Flags = webauthn.CredentialFlags{BackupEligible: be, BackupState: bs}
	if transports != nil {
		for _, t := range strings.Split(*transports, ",") {
			if t = strings.TrimSpace(t); t != "" {
				sc.Credential.Transport = append(sc.Credential.Transport, protocol.AuthenticatorTransport(t))
			}
		}
	}
	return sc, nil
}

// credentialsForUser is what the add ceremony excludes, so an authenticator that
// is already enrolled says so in the browser rather than minting a duplicate.
func (p *Passkeys) credentialsForUser(ctx context.Context, userID uuid.UUID) ([]webauthn.Credential, []byte, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT credential_id, user_handle FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at, credential_id`,
		userID)
	if err != nil {
		return nil, nil, fmt.Errorf("auth: passkey: list credentials: %w", err)
	}
	defer rows.Close()
	var (
		creds  []webauthn.Credential
		handle []byte
	)
	for rows.Next() {
		var (
			id []byte
			h  []byte
		)
		if err := rows.Scan(&id, &h); err != nil {
			return nil, nil, fmt.Errorf("auth: passkey: list credentials: %w", err)
		}
		creds = append(creds, webauthn.Credential{ID: id})
		if handle == nil {
			handle = h
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("auth: passkey: list credentials: %w", err)
	}
	return creds, handle, nil
}

// execer is satisfied by both *pgxpool.Pool and pgx.Tx, which is what lets the
// registration path (a statement inside the account's own transaction) and the
// add path (one statement on its own) share a single insert.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// insertCredential stores a freshly created credential. On the registration path
// it runs inside the transaction that also creates the account and spends the
// invite, so an account is never committed without the credential that is the
// only way to sign into it.
func insertCredential(ctx context.Context, q execer, sc storedCredential, now time.Time) error {
	var transports any
	if ts := transportsString(sc.Credential.Transport); ts != "" {
		transports = ts
	}
	var aaguid any
	if len(sc.Credential.Authenticator.AAGUID) > 0 {
		aaguid = sc.Credential.Authenticator.AAGUID
	}
	_, err := q.Exec(ctx,
		`INSERT INTO webauthn_credentials
		   (credential_id, user_id, user_handle, public_key, sign_count, aaguid, transports,
		    backup_eligible, backup_state, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		sc.Credential.ID, sc.UserID, sc.UserHandle, sc.Credential.PublicKey,
		int64(sc.Credential.Authenticator.SignCount), aaguid, transports,
		sc.Credential.Flags.BackupEligible, sc.Credential.Flags.BackupState, now)
	if err != nil {
		return fmt.Errorf("auth: passkey: store credential: %w", err)
	}
	return nil
}

func transportsString(ts []protocol.AuthenticatorTransport) string {
	if len(ts) == 0 {
		return ""
	}
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		if s := strings.TrimSpace(string(t)); s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, ",")
}

// touchCredential records a successful assertion: the new signature counter and
// when it was last used.
//
// The counter is guarded in SQL as well as in Go (`sign_count < $2`). The Go
// check is the one that REFUSES a clone; this one is belt, and it is what keeps
// two concurrent sign-ins from committing the lower of two counters.
func (p *Passkeys) touchCredential(ctx context.Context, credentialID []byte, signCount uint32, now time.Time) error {
	if _, err := p.Pool.Exec(ctx,
		`UPDATE webauthn_credentials SET sign_count = $2, last_used_at = $3
		  WHERE credential_id = $1 AND sign_count < $2`,
		credentialID, int64(signCount), now); err != nil {
		return fmt.Errorf("auth: passkey: update credential: %w", err)
	}
	return nil
}

// userIDForHandle resolves a user handle to the account it names, WITHOUT
// creating anything.
//
// It goes through SubjectHash rather than through a column of its own, which is
// the property that makes the two representations impossible to disagree: the
// account IS the subject hash of the handle, so a handle that resolves to a row
// resolves to the row that handle created.
func (p *Passkeys) userIDForHandle(ctx context.Context, handle []byte) (uuid.UUID, error) {
	var id uuid.UUID
	err := p.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE idp = $1 AND idp_sub_hash = $2`,
		IdPPasskey, SubjectHash(IdPPasskey, handleSubject(handle))).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrCredentialUnknown
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: passkey: resolve user handle: %w", err)
	}
	return id, nil
}
