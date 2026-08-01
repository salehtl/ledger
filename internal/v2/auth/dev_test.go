package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDevVerifierAcceptsOnlyTheDevPrefix(t *testing.T) {
	v := NewDevVerifier(IdPApple)
	id, err := v.Verify(context.Background(), "dev:alice", VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify(dev:alice) = %v, want nil", err)
	}
	if id.IdP != IdPApple || id.Subject != "alice" {
		t.Fatalf("Verify(dev:alice) = %+v, want {apple alice}", id)
	}
}

// A dev verifier that also accepted real tokens would be the worst of both:
// the deployment that turned it on for a test would keep working with real
// sign-ins, so nobody would notice it was left on.
func TestDevVerifierRejectsEverythingElse(t *testing.T) {
	v := NewDevVerifier(IdPGoogle)
	for _, tok := range []string{
		"",
		"dev:",
		"alice",
		"DEV:alice",
		"dev alice",
		"eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbGljZSJ9.sig",
	} {
		if _, err := v.Verify(context.Background(), tok, VerifyOpts{}); !errors.Is(err, ErrTokenRejected) {
			t.Fatalf("Verify(%q) = %v, want ErrTokenRejected", tok, err)
		}
	}
}

// The subject is what SubjectHash keys the account on, so two dev subjects must
// be two accounts and the same one must be the same account.
func TestDevVerifierSubjectsAreDistinct(t *testing.T) {
	v := NewDevVerifier(IdPApple)
	a, err := v.Verify(context.Background(), "dev:alice", VerifyOpts{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := v.Verify(context.Background(), "dev:bob", VerifyOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if string(SubjectHash(a.IdP, a.Subject)) == string(SubjectHash(b.IdP, b.Subject)) {
		t.Fatal("two dev subjects hash to the same account")
	}
	again, err := v.Verify(context.Background(), "dev:alice", VerifyOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if string(SubjectHash(a.IdP, a.Subject)) != string(SubjectHash(again.IdP, again.Subject)) {
		t.Fatal("the same dev subject hashed to two different accounts")
	}
}

// A subject containing the SubjectHash separator would let one dev token name
// the account another one names ("a|b" against idp "x" versus "b" against idp
// "x|a"); the closed IdP vocabulary is what makes that unreachable today, and
// the dev path must not be the thing that widens it.
func TestDevVerifierRejectsASubjectWithTheHashSeparator(t *testing.T) {
	v := NewDevVerifier(IdPApple)
	if _, err := v.Verify(context.Background(), "dev:a|b", VerifyOpts{}); !errors.Is(err, ErrTokenRejected) {
		t.Fatalf("Verify(dev:a|b) = %v, want ErrTokenRejected", err)
	}
}

func TestDevVerifierRefusesAnUnknownIdP(t *testing.T) {
	v := NewDevVerifier("myspace")
	_, err := v.Verify(context.Background(), "dev:alice", VerifyOpts{})
	if err == nil || !strings.Contains(err.Error(), "myspace") {
		t.Fatalf("Verify with an unknown idp = %v, want an error naming it", err)
	}
}
