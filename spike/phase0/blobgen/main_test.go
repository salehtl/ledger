package main

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	recipPriv, recipPub, err := genKeypair()
	if err != nil {
		t.Fatal(err)
	}
	op := []byte(`{"iid":"abc","amount":12345,"direction":"debit"}`)
	blob, err := seal(op, recipPub)
	if err != nil {
		t.Fatal(err)
	}
	if len(blob) != 1016 {
		t.Fatalf("blob size = %d, want 1016", len(blob))
	}
	got, err := open(blob, recipPriv)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, op) {
		t.Fatalf("round trip mismatch: %q", got)
	}
}

func TestSealRejectsOversize(t *testing.T) {
	_, recipPub, err := genKeypair()
	if err != nil {
		t.Fatal(err)
	}
	// Random bytes are incompressible, so gzip cannot shrink 5000B below
	// padSize (968B) and seal must reject it.
	big := make([]byte, 5000)
	if _, err := rand.Read(big); err != nil {
		t.Fatal(err)
	}
	if _, err := seal(big, recipPub); err == nil {
		t.Fatal("seal succeeded on oversize payload, want error")
	}
}
