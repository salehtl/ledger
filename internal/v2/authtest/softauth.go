// Package authtest is a scriptable software WebAuthn authenticator for tests.
//
// It exists for the reason internal/v2/pgtest does: two packages need the same
// non-trivial test apparatus, and the alternative is copying a hundred lines of
// COSE and CBOR encoding into each of them where the two copies would drift.
// auth/passkey_test.go drives the ceremony logic with it; api/passkey_test.go
// drives the same ceremonies over HTTP.
//
// go-webauthn ships spec vectors, not a scriptable authenticator, and every
// property worth testing here is a property of a SEQUENCE of ceremonies — a
// replayed ceremony id, an expired one, a signature counter that goes backwards —
// rather than of one captured response.
//
// It is deliberately obedient: nothing here is trying to test go-webauthn's own
// verification, which is the library's job and has the spec vectors for it. What
// it makes testable is the state the SERVER keeps between begin and finish.
//
// It is test-only and is imported by no production code.
package authtest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
)

// The relying party every test in this tree uses. They are here rather than in
// each test package so an origin and an RP id can never disagree between the
// server under test and the authenticator answering it — a mismatch that
// presents as "verification fails for no reason".
const (
	RPID          = "ledger.example"
	RPOrigin      = "https://ledger.example"
	RPDisplayName = "Ledger"
)

// Authenticator data flags, §6.1.
const (
	flagUserPresent    = 0x01
	flagUserVerified   = 0x04
	flagBackupEligible = 0x08
	flagBackupState    = 0x10
	flagAttestedData   = 0x40
)

// Authenticator is one software authenticator: an ES256 key, a credential id,
// and the user handle it adopted from the registration it answered.
type Authenticator struct {
	// Origin is the origin it claims to have been called from. Tests override it
	// to check that a ceremony run from somewhere else is refused.
	Origin string

	Key    *ecdsa.PrivateKey
	CredID []byte
	// Handle is filled in by Create from the registration options, which is
	// exactly what a real authenticator does: the RP names the user handle and
	// the authenticator stores it beside the credential, to hand back inside
	// every later assertion.
	Handle []byte
	AAGUID []byte
	// Counter is the signature counter the registration was made at. Assert
	// takes the counter as a parameter rather than incrementing this, so a test
	// can replay an old one.
	Counter uint32
}

// New returns an authenticator with a fresh key and credential id.
func New(t *testing.T) *Authenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &Authenticator{
		Origin:  RPOrigin,
		Key:     key,
		CredID:  RandBytes(t, 20),
		AAGUID:  RandBytes(t, 16),
		Counter: 1,
	}
}

// RandBytes is crypto/rand with the error handling a test wants.
func RandBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// coseKey is the credential public key as the authenticator publishes it.
func (a *Authenticator) coseKey(t *testing.T) []byte {
	t.Helper()
	pk := webauthncose.EC2PublicKeyData{
		PublicKeyData: webauthncose.PublicKeyData{
			KeyType:   2, // EC2
			Algorithm: int64(webauthncose.AlgES256),
		},
		Curve:  1, // P-256
		XCoord: a.Key.PublicKey.X.FillBytes(make([]byte, 32)),
		YCoord: a.Key.PublicKey.Y.FillBytes(make([]byte, 32)),
	}
	raw, err := webauthncbor.Marshal(pk)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// authData builds §6.1 authenticator data. attested is set only for a
// registration, which is the ceremony that carries the new credential.
func (a *Authenticator) authData(t *testing.T, rpID string, counter uint32, attested bool) []byte {
	t.Helper()
	h := sha256.Sum256([]byte(rpID))
	out := append([]byte{}, h[:]...)
	flags := byte(flagUserPresent | flagUserVerified | flagBackupEligible | flagBackupState)
	if attested {
		flags |= flagAttestedData
	}
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, counter)
	if attested {
		out = append(out, a.AAGUID...)
		out = binary.BigEndian.AppendUint16(out, uint16(len(a.CredID)))
		out = append(out, a.CredID...)
		out = append(out, a.coseKey(t)...)
	}
	return out
}

func (a *Authenticator) clientData(t *testing.T, typ string, challenge protocol.URLEncodedBase64) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"type":        typ,
		"challenge":   challenge.String(),
		"origin":      a.Origin,
		"crossOrigin": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// Create answers a registration challenge and returns the response JSON the
// browser would POST. It adopts the user handle the server put in the options,
// which is the value that later comes back inside an assertion and is what makes
// username-less login possible.
func (a *Authenticator) Create(t *testing.T, opts *protocol.CredentialCreation) []byte {
	t.Helper()
	switch id := opts.Response.User.ID.(type) {
	case protocol.URLEncodedBase64:
		a.Handle = []byte(id)
	case []byte:
		a.Handle = id
	case string:
		// The options came back through JSON, so the handle is base64url text.
		raw, err := base64.RawURLEncoding.DecodeString(id)
		if err != nil {
			t.Fatalf("user id %q is not base64url: %v", id, err)
		}
		a.Handle = raw
	default:
		t.Fatalf("registration options carry a user id of type %T, want raw bytes", opts.Response.User.ID)
	}
	cd := a.clientData(t, "webauthn.create", opts.Response.Challenge)
	att := struct {
		AuthData []byte         `cbor:"authData"`
		Fmt      string         `cbor:"fmt"`
		AttStmt  map[string]any `cbor:"attStmt"`
	}{
		AuthData: a.authData(t, opts.Response.RelyingParty.ID, a.Counter, true),
		Fmt:      "none",
		AttStmt:  map[string]any{},
	}
	obj, err := webauthncbor.Marshal(att)
	if err != nil {
		t.Fatal(err)
	}
	resp := protocol.CredentialCreationResponse{
		PublicKeyCredential: a.publicKeyCredential(),
		AttestationResponse: protocol.AuthenticatorAttestationResponse{
			AuthenticatorResponse: protocol.AuthenticatorResponse{ClientDataJSON: cd},
			AttestationObject:     obj,
			Transports:            []string{"internal", "hybrid"},
			PublicKeyAlgorithm:    int64(webauthncose.AlgES256),
		},
	}
	return mustJSON(t, resp)
}

// Assert answers a login challenge at the given signature counter. The counter
// is a parameter rather than an increment so a test can replay an old one, which
// is the cloned-authenticator signal.
func (a *Authenticator) Assert(t *testing.T, opts *protocol.CredentialAssertion, counter uint32) []byte {
	t.Helper()
	cd := a.clientData(t, "webauthn.get", opts.Response.Challenge)
	ad := a.authData(t, opts.Response.RelyingPartyID, counter, false)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.Key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	resp := protocol.CredentialAssertionResponse{
		PublicKeyCredential: a.publicKeyCredential(),
		AssertionResponse: protocol.AuthenticatorAssertionResponse{
			AuthenticatorResponse: protocol.AuthenticatorResponse{ClientDataJSON: cd},
			AuthenticatorData:     ad,
			Signature:             sig,
			UserHandle:            a.Handle,
		},
	}
	return mustJSON(t, resp)
}

func (a *Authenticator) publicKeyCredential() protocol.PublicKeyCredential {
	return protocol.PublicKeyCredential{
		Credential: protocol.Credential{
			ID:   base64.RawURLEncoding.EncodeToString(a.CredID),
			Type: "public-key",
		},
		RawID:                   a.CredID,
		AuthenticatorAttachment: "platform",
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
