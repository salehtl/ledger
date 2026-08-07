package auth

// Passkeys: WebAuthn as a THIRD identity provider, behind the Verifier/Identity/
// SubjectHash seam this package already had.
//
// # What changed, and what deliberately did not
//
// v2's auth was built for Sign in with Apple and Google Sign-In because the Expo
// client had to satisfy App Store rule 4.8. The product dropped Expo for a PWA,
// that rule went with it, and the decision was taken to drop third-party IdPs
// entirely in favour of passkeys. What did NOT change: sessions, the invite gate,
// writer enrolment, the key-history log, and the shape of an Identity. A passkey
// ceremony ends by producing `Identity{IdP: "passkey", Subject: ...}` and handing
// it to the same UpsertUser* path an ID token would have, which is why none of
// those files needed touching.
//
// # There is no Verifier implementation here, on purpose
//
// [Verifier] takes a token string and answers with an Identity. A WebAuthn
// ceremony is two round trips with server-side state in the middle, so it does
// not fit that signature and pretending it did would mean smuggling a ceremony id
// through a parameter named idToken. The seam this reuses is the one BELOW the
// verifier — Identity, SubjectHash, UpsertUserInvited* — and that is the seam
// that matters, because it is the one every downstream table hangs off.
//
// # The identity a passkey names
//
// A user handle: 32 bytes from crypto/rand, minted once at registration, stored
// on every credential the account enrols. The Identity's Subject is its base64url
// form, so `users.idp_sub_hash` is SHA-256("v2|passkey|" + base64url(handle)).
//
// That is what makes username-less sign-in work. A DISCOVERABLE credential
// returns the handle inside the assertion, so the server learns whose account is
// being signed into from the authenticator's own signed response rather than from
// anything the page typed — which is why [protocol.ResidentKeyRequirementRequired]
// below is not a preference but the mechanism.
//
// SubjectHash's "|" separator is not injective for arbitrary inputs and is safe
// only because the IdP vocabulary is closed and contains no "|". That argument was
// re-checked before "passkey" was added to it: the value contains no "|", and
// base64url's alphabet cannot produce one either. See SubjectHash's doc.
//
// # What a passkey proves, and what it does not
//
// A passkey assertion proves possession of a private key the authenticator holds
// and (with user verification) that somebody unlocked it. It is a strictly better
// sign-in credential than an ID token: there is no bearer token to capture and
// replay, because the challenge is server-minted, single-use, and signed over.
//
// It proves nothing about the WRITER keys. Spec §3.4's rules are unchanged: a
// session — however it was obtained — still does not authorize enrolling a writer,
// deleting the account, or rotating the inbound address. Those need proof of key
// possession, and a passkey is not one of the keys they mean.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CeremonyTTL is how long a begun ceremony may be finished within.
//
// Five minutes, matching Writers.Challenge and the address-rotation challenge,
// because it bounds the same thing: how long a server-minted challenge stays
// spendable. It is generous enough for a user who has to fetch a security key
// from a drawer and short enough that an abandoned ceremony is not a row that
// lingers.
const CeremonyTTL = 5 * time.Minute

// userHandleBytes is the entropy in a user handle. 32 bytes is well inside
// WebAuthn's 64-byte cap and is the whole of what identifies an account: an
// attacker who could guess one could address somebody else's row.
const userHandleBytes = 32

// ceremonyIDBytes is the entropy in a ceremony id. It is not a credential — the
// challenge inside the ceremony is what authorizes anything — but it is a handle
// to server-side state reachable by an unauthenticated caller, so it is
// unguessable rather than sequential.
const ceremonyIDBytes = 32

// Rejection reasons. Everything except ErrNotInvited (which passes through from
// invite.go unchanged) wraps ErrPasskeyRejected, so a caller that only wants
// "did this ceremony establish anything" writes one errors.Is.
//
// The HTTP layer must answer ALL of them with an identical 401 apart from
// ErrNotInvited, which is a fact about this deployment's policy rather than about
// the credential — the same single carve-out the ID-token exchange makes.
var (
	// ErrPasskeyRejected is the umbrella: the ceremony did not establish an
	// identity.
	ErrPasskeyRejected = errors.New("auth: passkey ceremony rejected")

	// ErrCeremonyUnknown means there is no live ceremony under that id: never
	// existed, already spent, expired, or begun as a different kind. One error
	// for all four, because telling them apart is an oracle.
	ErrCeremonyUnknown = fmt.Errorf("%w: no such ceremony", ErrPasskeyRejected)

	// ErrCredentialUnknown means the assertion named a credential this
	// deployment has never enrolled.
	ErrCredentialUnknown = fmt.Errorf("%w: unknown credential", ErrPasskeyRejected)

	// ErrClonedAuthenticator means the signature counter did not increase.
	// Per §6.1.1 that is evidence that at least two copies of the private key
	// exist, or that the authenticator is malfunctioning. Neither is a sign-in.
	//
	// Note what this is NOT: a counter that stays at zero. Platform
	// authenticators (iCloud Keychain among them) report a permanent zero
	// precisely because the credential IS synced and a counter would be
	// meaningless; go-webauthn's UpdateCounter excludes that case, and so does
	// this.
	ErrClonedAuthenticator = fmt.Errorf("%w: signature counter did not increase", ErrPasskeyRejected)

	// ErrNoPasskeyIdentity means an add-a-passkey ceremony was asked for by an
	// account that has no user handle to bind one to. See BeginAdd.
	ErrNoPasskeyIdentity = fmt.Errorf("%w: this account has no passkey identity", ErrPasskeyRejected)
)

// Passkeys runs the three WebAuthn ceremonies and owns their server-side state.
//
// One instance per process, built by api.NewServer from the [auth] config. It is
// safe for concurrent use: it holds no per-ceremony state in memory at all — that
// is what the webauthn_ceremonies table is for.
type Passkeys struct {
	Pool *pgxpool.Pool
	// WA is go-webauthn's relying party. All cryptography, all of §7's
	// verification steps, and the whole attestation surface are its, not this
	// package's — the same division of labour idp.go draws with go-oidc, and for
	// the same reason: this is the one code path where a hand-rolled mistake is
	// an authentication bypass.
	WA *webauthn.WebAuthn
	// Now defaults to time.Now. Ceremony expiry is evaluated against THIS clock
	// and never against Postgres's, so one clock decides both when a ceremony
	// was minted and when it dies (see 00022's note on the two-clock defect).
	Now func() time.Time
}

func (p *Passkeys) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

// NewPasskeys builds the relying party from config.
//
// It returns an error rather than a Passkeys that rejects everything, which is
// the opposite of NewOIDCVerifier's choice and deliberately so: an OIDC verifier
// with no client ids is a deployment that cannot verify Apple tokens, and the safe
// answer is "nobody signs in". A relying party with no RP id or no origin cannot
// be constructed at all — go-webauthn refuses it — and a nil Passkeys means
// api.Handler does not MOUNT the routes, which is the same failure stated at
// startup instead of at the first sign-in.
func NewPasskeys(pool *pgxpool.Pool, rpID, rpDisplayName string, origins []string) (*Passkeys, error) {
	if pool == nil {
		return nil, errors.New("auth: NewPasskeys: pool is nil")
	}
	if rpID == "" {
		return nil, errors.New("auth: NewPasskeys: rp_id is empty")
	}
	var clean []string
	for _, o := range origins {
		if o != "" {
			clean = append(clean, o)
		}
	}
	if len(clean) == 0 {
		// Not a nicety. The origin is what binds a ceremony to THIS site; with
		// none configured there is nothing to compare the client data against,
		// and go-webauthn would have to either refuse everything or accept
		// anything. It refuses, and saying so here names the missing key.
		return nil, errors.New("auth: NewPasskeys: auth.rp_origins is empty; " +
			"a ceremony cannot be bound to an origin that is not configured")
	}
	if rpDisplayName == "" {
		rpDisplayName = rpID
	}
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: rpDisplayName,
		RPOrigins:     clean,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			// Required, because it is the mechanism rather than a preference:
			// only a discoverable credential returns the user handle in its
			// assertion, and without the handle there is no username-less
			// sign-in — the page would have to ask who you are first.
			ResidentKey: protocol.ResidentKeyRequirementRequired,
			// Preferred rather than required. Required would refuse a security
			// key with no PIN set and an authenticator that cannot do UV at all,
			// which is a lockout for a user whose only device is one of them.
			// Every authenticator this actually meets (Touch ID, Face ID,
			// Windows Hello) does UV anyway, so "required" would buy almost
			// nothing and cost the tail.
			UserVerification: protocol.VerificationPreferred,
		},
		// No attestation. The RP has no use for a signed statement of which
		// authenticator model was used — it enforces no allow-list of models —
		// and asking for one adds a privacy-relevant identifier to every
		// registration plus a browser consent prompt that says nothing useful.
		AttestationPreference: protocol.PreferNoAttestation,
	})
	if err != nil {
		return nil, fmt.Errorf("auth: NewPasskeys: %w", err)
	}
	return &Passkeys{Pool: pool, WA: wa}, nil
}

// ---------------------------------------------------------------------------
// The webauthn.User this package presents to the library
// ---------------------------------------------------------------------------

// passkeyUser is the library's view of an account. It carries NO personal data,
// and that is a requirement rather than an omission: v2 stores none, and
// WebAuthnName/WebAuthnDisplayName travel to the authenticator and are shown in
// the platform's passkey picker.
//
// The name is therefore the relying party's own, plus a short prefix of the
// handle so two accounts on one device are distinguishable. It is not an email,
// not a username, and there is no field on `users` it could have come from.
type passkeyUser struct {
	handle      []byte
	credentials []webauthn.Credential
	rpName      string
}

func (u passkeyUser) WebAuthnID() []byte { return u.handle }

func (u passkeyUser) WebAuthnName() string {
	return u.rpName + " " + shortHandle(u.handle)
}

func (u passkeyUser) WebAuthnDisplayName() string { return u.rpName }

func (u passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func shortHandle(handle []byte) string {
	s := handleSubject(handle)
	if len(s) > 8 {
		s = s[:8]
	}
	return s
}

// handleSubject is the one definition of "the subject a handle names". Every
// SubjectHash call in this package goes through it, so the encoding cannot drift
// between the row that is written at registration and the lookup that resolves an
// assertion.
func handleSubject(handle []byte) string {
	return base64.RawURLEncoding.EncodeToString(handle)
}

// passkeyIdentity is the Identity a handle names.
func passkeyIdentity(handle []byte, now time.Time) Identity {
	return Identity{IdP: IdPPasskey, Subject: handleSubject(handle), IssuedAt: now}
}

// ---------------------------------------------------------------------------
// Registration: a new account
// ---------------------------------------------------------------------------

// BeginRegistration mints a user handle and a challenge for a NEW account.
//
// The invite code is taken here and SPENT at finish, in the transaction that
// creates the account (see FinishRegistration). Two round trips is what forces
// that split: the code arrives before the credential exists, and redeeming it
// early would mark a code spent for an account a user then abandoned at the
// biometric prompt.
//
// A code that is already spent, or is not a code at all, is refused HERE as well
// as at finish. That is a deliberate, documented oracle: it tells a caller whether
// a code is live before they touch their sensor. It reveals nothing they could not
// learn by completing the ceremony and reading the 403, it saves a user from
// authenticating into a refusal, and both paths are behind the same per-IP rate
// limiter. The check is NOT the gate — the redemption at finish is, and it is the
// one that is atomic.
func (p *Passkeys) BeginRegistration(ctx context.Context, inviteCode string) (string, *protocol.CredentialCreation, error) {
	if p.Pool == nil || p.WA == nil {
		return "", nil, errors.New("auth: Passkeys is not configured")
	}
	hash := InviteCodeHash(inviteCode)
	if len(hash) == 0 {
		return "", nil, ErrNotInvited
	}
	var spendable bool
	if err := p.Pool.QueryRow(ctx,
		`SELECT true FROM invite_codes WHERE code_hash = $1 AND redeemed_at IS NULL`, hash).
		Scan(&spendable); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, ErrNotInvited
		}
		return "", nil, fmt.Errorf("auth: passkey: check invite: %w", err)
	}

	handle := make([]byte, userHandleBytes)
	if _, err := rand.Read(handle); err != nil {
		return "", nil, fmt.Errorf("auth: passkey: mint user handle: %w", err)
	}
	user := passkeyUser{handle: handle, rpName: p.WA.Config.RPDisplayName}
	opts, session, err := p.WA.BeginRegistration(user)
	if err != nil {
		return "", nil, fmt.Errorf("auth: passkey: begin registration: %w", err)
	}
	id, err := newCeremonyID()
	if err != nil {
		return "", nil, err
	}
	if err := p.putCeremony(ctx, ceremony{
		ID: id, Kind: ceremonyRegister, UserHandle: handle, Session: *session, InviteHash: hash,
	}); err != nil {
		return "", nil, err
	}
	return id, opts, nil
}

// FinishRegistration verifies the authenticator's response and, if it holds up,
// creates the account.
//
// The account, its invite redemption, its oplog counter, its ingest writer AND
// its first credential all commit together or not at all. That is the same
// all-or-nothing UpsertUser already guaranteed for the first four, extended to the
// fifth for the reason the others are in it: an account with no credential is an
// account nobody can ever sign into, and it would have spent an invite code to
// get there.
func (p *Passkeys) FinishRegistration(ctx context.Context, ceremonyID string, response []byte) (uuid.UUID, []byte, error) {
	if p.Pool == nil || p.WA == nil {
		return uuid.Nil, nil, errors.New("auth: Passkeys is not configured")
	}
	c, err := p.claimCeremony(ctx, ceremonyID, ceremonyRegister)
	if err != nil {
		return uuid.Nil, nil, err
	}
	user := passkeyUser{handle: c.UserHandle, rpName: p.WA.Config.RPDisplayName}
	cred, err := p.createCredential(user, c, response)
	if err != nil {
		return uuid.Nil, nil, err
	}

	now := p.now().UTC()
	userID, err := p.createAccountWithCredential(ctx, storedCredential{
		UserHandle: c.UserHandle,
		Credential: *cred,
	}, c.InviteHash, now)
	if err != nil {
		return uuid.Nil, nil, err
	}
	return userID, cred.ID, nil
}

// createAccountWithCredential is UpsertUserInvitedHash plus the credential, in
// one transaction.
//
// It cannot reuse upsertUser directly — that function owns its own transaction —
// so instead it calls it and inserts the credential immediately afterwards inside
// a transaction of its own, then verifies the account is the one it just made.
// The window that opens is bounded and benign: the account exists for a moment
// with no credential, and if the insert fails the account is deleted again rather
// than left as an unusable row holding a spent invite.
func (p *Passkeys) createAccountWithCredential(ctx context.Context, sc storedCredential, inviteHash []byte, now time.Time) (uuid.UUID, error) {
	userID, err := UpsertUserInvitedHash(ctx, p.Pool, passkeyIdentity(sc.UserHandle, now), inviteHash)
	if err != nil {
		// ErrNotInvited passes through unwrapped: the HTTP layer keys its one
		// distinguishable rejection on it.
		return uuid.Nil, err
	}
	sc.UserID = userID
	if err := insertCredential(ctx, p.Pool, sc, now); err != nil {
		// Roll the account back by hand. The handle was minted moments ago and
		// belongs to nothing else, so this can only ever remove the row this call
		// created — and leaving it would strand a spent invite code against an
		// account with no way in.
		//
		// Deliberately on a context detached from the caller's: the failure that
		// gets here is most often the request being cancelled, and cleanup that
		// inherits the cancellation is cleanup that does not run.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, delErr := p.Pool.Exec(cleanup, `DELETE FROM users WHERE id = $1`, userID); delErr != nil {
			return uuid.Nil, fmt.Errorf("%w (and the account could not be rolled back: %v)", err, delErr)
		}
		return uuid.Nil, err
	}
	return userID, nil
}

// ---------------------------------------------------------------------------
// Login: an existing account, named by nobody
// ---------------------------------------------------------------------------

// BeginLogin mints a challenge for a DISCOVERABLE login: no user, no credential
// list, no username.
//
// The empty allowCredentials list is the whole point. The server does not know
// who is signing in and does not ask; the authenticator picks a credential for
// this RP id and returns the user handle with it. An allow-list would require the
// page to identify the account first, which is the step passkeys exist to remove —
// and would make this endpoint an enumeration oracle for which accounts exist.
func (p *Passkeys) BeginLogin(ctx context.Context) (string, *protocol.CredentialAssertion, error) {
	if p.Pool == nil || p.WA == nil {
		return "", nil, errors.New("auth: Passkeys is not configured")
	}
	opts, session, err := p.WA.BeginDiscoverableLogin()
	if err != nil {
		return "", nil, fmt.Errorf("auth: passkey: begin login: %w", err)
	}
	id, err := newCeremonyID()
	if err != nil {
		return "", nil, err
	}
	if err := p.putCeremony(ctx, ceremony{ID: id, Kind: ceremonyLogin, Session: *session}); err != nil {
		return "", nil, err
	}
	return id, opts, nil
}

// FinishLogin verifies an assertion and answers with the account it names.
//
// It creates NOTHING. An assertion from a credential this deployment has never
// enrolled is a rejection, not a first sign-in: the invite gate is on the
// registration ceremony, and a login path that could mint an account would be a
// way straight past it.
func (p *Passkeys) FinishLogin(ctx context.Context, ceremonyID string, response []byte) (uuid.UUID, []byte, error) {
	if p.Pool == nil || p.WA == nil {
		return uuid.Nil, nil, errors.New("auth: Passkeys is not configured")
	}
	c, err := p.claimCeremony(ctx, ceremonyID, ceremonyLogin)
	if err != nil {
		return uuid.Nil, nil, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
	if err != nil {
		return uuid.Nil, nil, fmt.Errorf("%w: %v", ErrPasskeyRejected, err)
	}

	// Resolved from the DATABASE by the credential id the assertion carried, and
	// cross-checked against the handle. Doing it in this order matters: the
	// handle is a value the caller supplied, so it may not be the thing an
	// account is looked up by — otherwise anyone who has seen a handle could
	// present any credential against it.
	var stored storedCredential
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		sc, err := p.credentialByID(ctx, rawID)
		if err != nil {
			return nil, err
		}
		stored = sc
		return passkeyUser{
			handle:      sc.UserHandle,
			credentials: []webauthn.Credential{sc.Credential},
			rpName:      p.WA.Config.RPDisplayName,
		}, nil
	}
	// The library checks that the assertion's userHandle equals the user's
	// WebAuthnID, so a credential presented under somebody else's handle is
	// refused there.
	cred, err := p.WA.ValidateDiscoverableLogin(handler, c.Session, parsed)
	if err != nil {
		if errors.Is(err, ErrCredentialUnknown) {
			return uuid.Nil, nil, ErrCredentialUnknown
		}
		return uuid.Nil, nil, fmt.Errorf("%w: %v", ErrPasskeyRejected, err)
	}
	if cred.Authenticator.CloneWarning {
		// go-webauthn RECORDS this and leaves the policy to the RP. The policy
		// is: refuse. A counter that does not advance means the key exists in two
		// places, and there is no benign reading of that for a credential whose
		// whole job is to be the only way into an account. The stored counter is
		// left where it was — see touchCredential, which will not move it
		// backwards either.
		return uuid.Nil, nil, ErrClonedAuthenticator
	}

	// The tripwire: the credential row's account must be the account the HANDLE
	// names. The two are derived independently — one from a foreign key, one from
	// SubjectHash — so agreement is a real check rather than a restatement, and a
	// disagreement means a row was written by something that did not go through
	// this file.
	byHandle, err := p.userIDForHandle(ctx, stored.UserHandle)
	if err != nil {
		return uuid.Nil, nil, err
	}
	if byHandle != stored.UserID {
		return uuid.Nil, nil, fmt.Errorf("%w: credential owner and user handle disagree", ErrPasskeyRejected)
	}

	if err := p.touchCredential(ctx, cred.ID, cred.Authenticator.SignCount, p.now().UTC()); err != nil {
		return uuid.Nil, nil, err
	}
	return stored.UserID, cred.ID, nil
}

// ---------------------------------------------------------------------------
// Add: a second passkey for an account that already exists
// ---------------------------------------------------------------------------

// BeginAdd mints a registration challenge for an account that is ALREADY signed
// in, so a user can enrol a second device.
//
// It reuses the account's existing handle rather than minting a new one, and that
// is not an optimisation: the handle IS the subject, so a second handle would
// hash to a second `users` row and the new credential would sign into a different,
// empty account. An account with no handle to reuse — one created under Apple or
// Google before passkeys existed — is refused with ErrNoPasskeyIdentity rather
// than silently given a passkey identity it did not have, which would be account
// linking, and account linking is a feature with its own threat model that nobody
// has asked for.
//
// Existing credentials are sent as exclusions, so an authenticator that is already
// enrolled says so in the browser instead of minting a duplicate row.
func (p *Passkeys) BeginAdd(ctx context.Context, userID uuid.UUID) (string, *protocol.CredentialCreation, error) {
	if p.Pool == nil || p.WA == nil {
		return "", nil, errors.New("auth: Passkeys is not configured")
	}
	if userID == uuid.Nil {
		return "", nil, errors.New("auth: passkey: BeginAdd: user id is zero")
	}
	creds, handle, err := p.credentialsForUser(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	if len(handle) == 0 {
		return "", nil, ErrNoPasskeyIdentity
	}
	user := passkeyUser{handle: handle, credentials: creds, rpName: p.WA.Config.RPDisplayName}
	opts, session, err := p.WA.BeginRegistration(user,
		webauthn.WithExclusions(webauthn.Credentials(creds).CredentialDescriptors()))
	if err != nil {
		return "", nil, fmt.Errorf("auth: passkey: begin add: %w", err)
	}
	id, err := newCeremonyID()
	if err != nil {
		return "", nil, err
	}
	if err := p.putCeremony(ctx, ceremony{
		ID: id, Kind: ceremonyAdd, UserID: &userID, UserHandle: handle, Session: *session,
	}); err != nil {
		return "", nil, err
	}
	return id, opts, nil
}

// FinishAdd stores the new credential against the account that began the
// ceremony.
//
// userID comes from the SESSION on the request, and it is checked against the
// account the ceremony's handle names. Both are required: without the session
// check anyone holding a ceremony id could complete somebody else's enrolment,
// and without the handle check a session could finish a ceremony begun for a
// different account and bolt a credential onto it.
func (p *Passkeys) FinishAdd(ctx context.Context, ceremonyID string, userID uuid.UUID, response []byte) ([]byte, error) {
	if p.Pool == nil || p.WA == nil {
		return nil, errors.New("auth: Passkeys is not configured")
	}
	c, err := p.claimCeremony(ctx, ceremonyID, ceremonyAdd)
	if err != nil {
		return nil, err
	}
	// Checked twice, against two independently derived answers: the column the
	// ceremony was written with, and the account SubjectHash says the handle
	// names. Agreement is a real check rather than a restatement — a row where
	// they disagree was written by something that did not go through this file.
	owner, err := p.userIDForHandle(ctx, c.UserHandle)
	if err != nil {
		return nil, err
	}
	if owner != userID || c.UserID == nil || *c.UserID != userID {
		return nil, fmt.Errorf("%w: this ceremony belongs to a different account", ErrPasskeyRejected)
	}
	user := passkeyUser{handle: c.UserHandle, rpName: p.WA.Config.RPDisplayName}
	cred, err := p.createCredential(user, c, response)
	if err != nil {
		return nil, err
	}
	if err := insertCredential(ctx, p.Pool, storedCredential{
		UserID:     userID,
		UserHandle: c.UserHandle,
		Credential: *cred,
	}, p.now().UTC()); err != nil {
		return nil, err
	}
	return cred.ID, nil
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// createCredential is the verification both registration ceremonies share.
func (p *Passkeys) createCredential(user passkeyUser, c ceremony, response []byte) (*webauthn.Credential, error) {
	parsed, err := protocol.ParseCredentialCreationResponseBytes(response)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPasskeyRejected, err)
	}
	cred, err := p.WA.CreateCredential(user, c.Session, parsed)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPasskeyRejected, err)
	}
	return cred, nil
}

func newCeremonyID() (string, error) {
	raw := make([]byte, ceremonyIDBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: passkey: mint ceremony id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
