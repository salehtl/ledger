package push_test

import (
	"testing"

	"ledger/internal/push"
)

func TestGenerateKeys_ProducesNonEmptyPair(t *testing.T) {
	priv, pub, err := push.GenerateKeys()
	if err != nil {
		t.Fatalf("GenerateKeys: %v", err)
	}
	if priv == "" || pub == "" {
		t.Error("expected non-empty VAPID key pair")
	}
	if priv == pub {
		t.Error("private and public keys must differ")
	}
}

func TestNew_EmptyKeys_ReturnsError(t *testing.T) {
	_, err := push.New("", "", "")
	if err == nil {
		t.Error("expected error for empty VAPID keys")
	}
}

func TestNew_ValidKeys_PublicKeyRoundTrip(t *testing.T) {
	priv, pub, err := push.GenerateKeys()
	if err != nil {
		t.Fatalf("GenerateKeys: %v", err)
	}
	s, err := push.New(priv, pub, "mailto:test@example.com")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if s.PublicKey() != pub {
		t.Errorf("PublicKey() = %q, want %q", s.PublicKey(), pub)
	}
}
