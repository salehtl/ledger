package tmpl

import (
	"slices"
	"testing"
)

// The literal dib.card.v1 gates on, used verbatim so these tests are about the
// bytes production actually depends on.
const arabicGate = "إشعار مشتريات"

// The property the whole guardrail rests on: an ASCII-only literal is not
// evidence of a decode, because every charset a mail decoder accepts agrees
// with US-ASCII on the low 128 and so leaves it unchanged.
func TestAnASCIIOnlyGateLiteralIsNotAWitness(t *testing.T) {
	for _, s := range []string{
		"Purchase alert",
		"Transaction Alert",
		"AED",
		"", // a template may not declare this, but the predicate must not crash on it
		"~!@#$%^&*()_+-=[]{}|;':\",./<>?",
	} {
		d := Definition{Match: Match{BodyContains: []string{s}}}
		if got := d.DecodeWitnesses(); len(got) != 0 {
			t.Errorf("DecodeWitnesses() = %q for the ASCII literal %q, want none", got, s)
		}
	}
}

func TestANonASCIIGateLiteralIsAWitness(t *testing.T) {
	for _, s := range []string{
		arabicGate,
		"إشعار إيداع",
		"é",             // one rune is enough: C3 A9 reads as "Ã©" under iso-8859-1
		"Amount\u00a0x", // a non-breaking space is non-ASCII too
	} {
		d := Definition{Match: Match{BodyContains: []string{s}}}
		if got := d.DecodeWitnesses(); !slices.Equal(got, []string{s}) {
			t.Errorf("DecodeWitnesses() = %q for %q, want [%q]", got, s, s)
		}
	}
}

// Mixed lists keep only the literals that carry evidence. A fixture with one
// entry cannot tell "filtered" from "returned everything", so this has three.
func TestDecodeWitnessesFiltersRatherThanAllOrNothing(t *testing.T) {
	d := Definition{Match: Match{BodyContains: []string{
		"Purchase alert", arabicGate, "Card", "إشعار إيداع",
	}}}
	want := []string{arabicGate, "إشعار إيداع"}
	if got := d.DecodeWitnesses(); !slices.Equal(got, want) {
		t.Errorf("DecodeWitnesses() = %q, want %q", got, want)
	}
}

// Only body_contains is eligible. A subject gate is checked against a DIFFERENT
// string from the one an extraction reads, and an exclusion is an absence —
// which is what a mis-decode manufactures.
func TestOnlyBodyContainsCanWitness(t *testing.T) {
	subject := Definition{Match: Match{SubjectContains: []string{arabicGate}}}
	if got := subject.DecodeWitnesses(); len(got) != 0 {
		t.Errorf("a subject_contains literal witnessed the body decode: %q", got)
	}
	exclusion := Definition{Match: Match{BodyNotContains: []string{arabicGate}}}
	if got := exclusion.DecodeWitnesses(); len(got) != 0 {
		t.Errorf("a body_not_contains literal witnessed the decode: %q", got)
	}
	both := Definition{Match: Match{
		SubjectContains: []string{arabicGate},
		BodyNotContains: []string{"إشعار إيداع"},
		BodyContains:    []string{"Purchase alert"},
	}}
	if got := both.DecodeWitnesses(); len(got) != 0 {
		t.Errorf("DecodeWitnesses() = %q; the only body_contains entry is ASCII", got)
	}
}

// The witnesses are the definition's own strings, byte for byte, so a caller
// can check them against the decoded text with strings.Contains and be checking
// the same thing the gate checked.
func TestDecodeWitnessesReturnsTheLiteralsVerbatim(t *testing.T) {
	d := Definition{Match: Match{BodyContains: []string{arabicGate}}}
	got := d.DecodeWitnesses()
	if len(got) != 1 || got[0] != d.Match.BodyContains[0] {
		t.Fatalf("DecodeWitnesses() = %q, want the definition's own literal", got)
	}
}
